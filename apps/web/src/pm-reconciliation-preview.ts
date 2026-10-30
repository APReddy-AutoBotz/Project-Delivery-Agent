// EXEC-037: first-page recipient metadata only. A browser lease does not prove
// that a server transaction has stopped after a request is aborted.
export type PreviewProject = { projectId: string; name: string };
export type PreviewKind = "milestone" | "scalar";
export type PreviewItem = { id: string; createdAt: string };
export type PreviewPart = { phase: "loading" } | { phase: "unavailable" } |
  { phase: "ready"; items: PreviewItem[]; more: boolean };
export type PreviewRow = { project: PreviewProject; milestone: PreviewPart; scalar: PreviewPart };
type PreviewRequest = (path: string, init: RequestInit, onUnavailable: (denied?: boolean) => void) => Promise<unknown>;
const fail = (): never => { throw new Error("Reconciliation preview unavailable"); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : fail();
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail();
};
const id = (value: unknown): string => typeof value === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
  value === "00000000-0000-0000-0000-000000000000" || value === "ffffffff-ffff-ffff-ffff-ffffffffffff") ? value : fail();
const instant = (value: unknown): string => {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail();
  return value;
};

export function decodeReconciliationPreview(value: unknown, projectId: string, subject: string, kind: PreviewKind): PreviewPart {
  const page = object(value); exact(page, ["requests", "next", "live"]);
  if (page.live !== true || !Array.isArray(page.requests) || page.requests.length > 20 || !subject) return fail();
  const seen = new Set<string>(), items: PreviewItem[] = [];
  for (const raw of page.requests) {
    const row = object(raw);
    exact(row, kind === "scalar" ? ["id", "projectId", "factId", "factType", "createdAt", "state", "assignment"]
      : ["id", "projectId", "milestoneId", "createdAt", "state", "assignment"]);
    const itemId = id(row.id), createdAt = instant(row.createdAt), assignment = object(row.assignment);
    exact(assignment, ["id", "revision", "occurredAt", "reason", "recipientSubject"]);
    id(assignment.id); instant(assignment.occurredAt);
    if (!Number.isInteger(assignment.revision) || (assignment.revision as number) < 1 || (assignment.revision as number) > 2147483647 ||
      assignment.reason !== "ASSIGNED" || assignment.recipientSubject !== subject || id(row.projectId) !== projectId || row.state !== "OPEN" || seen.has(itemId)) return fail();
    if (kind === "scalar") {
      id(row.factId);
      if (typeof row.factType !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(row.factType)) return fail();
    } else id(row.milestoneId);
    const previous = items.at(-1);
    if (previous && (createdAt < previous.createdAt || (createdAt === previous.createdAt && itemId <= previous.id))) return fail();
    seen.add(itemId); items.push({ id: itemId, createdAt });
  }
  if (page.next !== null) {
    const cursor = object(page.next); exact(cursor, ["id", "createdAt"]);
    const last = items.at(-1);
    if (items.length !== 20 || !last || id(cursor.id) !== last.id || instant(cursor.createdAt) !== last.createdAt) return fail();
  }
  return { phase: "ready", items, more: page.next !== null };
}

let batchActive = false;
// A lease spans all requests, even after abort, until their promises settle.
// Callers receive no previous-generation data when a lease cannot be acquired.
export async function loadReconciliationPreview(projects: PreviewProject[], subject: string, request: PreviewRequest,
  signal: AbortSignal, publish: (rows: PreviewRow[]) => void): Promise<PreviewRow[]> {
  if (batchActive || signal.aborted || !Array.isArray(projects) || projects.length > 5 || !subject ||
    new Set(projects.map((p) => id(p.projectId))).size !== projects.length) return fail();
  batchActive = true;
  const rows: PreviewRow[] = projects.map((project) => ({ project, milestone: { phase: "loading" }, scalar: { phase: "loading" } }));
  let next = 0;
  const update = () => { if (!signal.aborted) publish(rows.map((row) => ({ ...row }))); };
  try {
    update();
    const worker = async () => {
      while (!signal.aborted) {
        const index = next++; if (index >= rows.length) return;
        const row = rows[index]!;
        let projectDenied = false;
        for (const kind of ["milestone", "scalar"] as const) {
          if (signal.aborted) return;
          const endpoint = kind === "milestone" ? "reconciliation-requests" : "scalar-reconciliation-requests";
          let unavailableLatched = false;
          const unavailable = (denied = false) => {
            unavailableLatched = true; projectDenied ||= denied;
            if (!signal.aborted) {
              if (projectDenied) { row.milestone = { phase: "unavailable" }; row.scalar = { phase: "unavailable" }; }
              else row[kind] = { phase: "unavailable" };
              update();
            }
          };
          try {
            const page = await request(`/projects/${row.project.projectId}/${endpoint}`, { signal }, unavailable);
            if (signal.aborted) return;
            row[kind] = unavailableLatched ? { phase: "unavailable" } : decodeReconciliationPreview(page, row.project.projectId, subject, kind);
          } catch { if (signal.aborted) return; row[kind] = { phase: "unavailable" }; }
          update();
          if (projectDenied) break;
        }
      }
    };
    const finished = await Promise.allSettled([worker(), worker()]);
    if (signal.aborted || finished.some((entry) => entry.status === "rejected")) return fail();
    return rows.map((row) => ({ ...row }));
  } finally { batchActive = false; }
}
