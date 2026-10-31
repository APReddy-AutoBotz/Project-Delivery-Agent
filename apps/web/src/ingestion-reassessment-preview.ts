type BoundedRequest = (path: string, init: RequestInit, onUnavailable: (denied?: boolean) => void) => Promise<unknown>;
export type ReassessmentRow = { state: string; reason: string; attemptCount: number; totalAttempts: number;
  createdAt: string; availableAt: string; completedAt: string | null };
export type ReassessmentPreview = { rows: ReassessmentRow[]; more: boolean; next?: string; advanced?: true };
const fail = (): never => { throw new Error("Reassessment status unavailable"); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : fail();
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail();
};
const uuid = (value: unknown): string => typeof value === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ||
  value === "00000000-0000-0000-0000-000000000000" || value === "ffffffff-ffff-ffff-ffff-ffffffffffff") ? value : fail();
const number = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
const instant = (value: unknown): string => {
  if (typeof value !== "string") return fail();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return fail();
  const [, y, m, d, h, min, sec] = match, year = Number(y), month = Number(m), day = Number(d);
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(h) > 23 || Number(min) > 59 || Number(sec) > 59) return fail();
  return value;
};
const optionalId = (value: unknown) => value === null ? null : uuid(value);
const states = new Set(["READY", "COMPLETED", "BLOCKED"]);
const reasons = new Set(["QUEUED", "CLAIMED", "FAILED", "LOCK_CONTENDED", "POLICY_DISABLED", "SOURCE_SCOPE_CHANGED", "RETRY_EXHAUSTED", "RETRY_REQUESTED", "COMPLETED"]);

export function decodeReassessmentPreview(value: unknown, projectId: string, after?: string): ReassessmentPreview {
  uuid(projectId);
  if (after !== undefined) uuid(after);
  const page = object(value); exact(page, ["items", "nextCursor"]);
  if (!Array.isArray(page.items) || page.items.length > 25) return fail();
  const rows: ReassessmentRow[] = []; let previous: string | undefined = after;
  for (const raw of page.items) {
    const item = object(raw); exact(item, ["id", "sourceId", "receiptId", "projectId", "configRevision", "mappingRevision",
      "state", "reason", "attemptCount", "totalAttempts", "recoveryRevision", "createdAt", "availableAt", "completedAt",
      "assessmentId", "obligationId", "previewId"]);
    const id = uuid(item.id); uuid(item.sourceId); uuid(item.receiptId);
    if (uuid(item.projectId) !== projectId || (previous && previous >= id)) return fail();
    number(item.configRevision, 1); number(item.mappingRevision, 1); number(item.recoveryRevision, 0, 2147483647);
    const attemptCount = number(item.attemptCount, 0, 5), totalAttempts = number(item.totalAttempts, 0);
    if (typeof item.state !== "string" || !states.has(item.state) || typeof item.reason !== "string" || !reasons.has(item.reason)) return fail();
    const createdAt = instant(item.createdAt), availableAt = instant(item.availableAt);
    const completedAt = item.completedAt === null ? null : instant(item.completedAt);
    optionalId(item.assessmentId); optionalId(item.obligationId); optionalId(item.previewId);
    rows.push({ state: item.state, reason: item.reason, attemptCount, totalAttempts, createdAt, availableAt, completedAt }); previous = id;
  }
  if (page.nextCursor !== null && (page.items.length !== 25 || uuid(page.nextCursor) !== previous)) return fail();
  return { rows, more: page.nextCursor !== null,
    ...(page.nextCursor !== null ? { next: uuid(page.nextCursor) } : {}), ...(after ? { advanced: true as const } : {}) };
}

let active = false;
// The browser lease survives abort and unmount until the original read settles.
export async function loadReassessmentPreview(projectId: string, request: BoundedRequest,
  signal: AbortSignal, unavailable: () => void, after?: string): Promise<ReassessmentPreview> {
  if (active || signal.aborted) return fail();
  uuid(projectId);
  if (after !== undefined) uuid(after);
  active = true; let rejected = false;
  try {
    const endpoint = after ? "ingestion-reassessment-pages" : "ingestion-reassessments";
    const init: RequestInit = after ? { signal, method: "POST", body: JSON.stringify({ cursor: after }) } : { signal };
    const value = await request(`/projects/${projectId}/${endpoint}`, init, () => {
      rejected = true; if (!signal.aborted) unavailable();
    });
    if (signal.aborted || rejected) return fail();
    return decodeReassessmentPreview(value, projectId, after);
  } catch { return fail(); }
  finally { active = false; }
}
