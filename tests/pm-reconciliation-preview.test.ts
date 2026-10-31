import { expect, it, vi } from "vitest";
import { decodeReconciliationPreview, loadReconciliationPreview, loadReconciliationPreviewPage } from "../apps/web/src/pm-reconciliation-preview.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const subject = "synthetic-pm", projectId = id(1), time = "2026-10-30T00:00:00.000Z";
function summary(n: number, project = projectId) {
  return { id: id(n), projectId: project, milestoneId: id(50), createdAt: time, state: "OPEN", assignment: {
    id: id(n + 100), revision: 1, occurredAt: time, reason: "ASSIGNED", recipientSubject: subject,
  } };
}
const page = (requests: unknown[] = [], next: unknown = null) => ({ live: true, requests, next });
it("projects authorized metadata only and validates scope, recipient and ordering", () => {
  const first = summary(2), second = summary(3);
  expect(decodeReconciliationPreview(page([first, second]), projectId, subject, "milestone")).toEqual({
    phase: "ready", items: [{ id: first.id, createdAt: time }, { id: second.id, createdAt: time }], more: false,
  });
  const scalar = { ...first, factId: id(60), factType: "project.forecast" } as Record<string, unknown>; delete scalar.milestoneId;
  expect(decodeReconciliationPreview(page([scalar]), projectId, subject, "scalar")).toMatchObject({ phase: "ready" });
  for (const invalid of [page([{ ...first, projectId: id(9) }]), page([{ ...first, state: "CLOSED" }]),
    page([{ ...first, assignment: { ...first.assignment, recipientSubject: "other" } }]),
    page([{ ...first, assignment: { ...first.assignment, reason: "NO_CONFIGURED_PM", recipientSubject: null } }]),
    page([second, first]), page([first, first]), page([{ ...first, detail: "private" }]), { ...page(), live: false }])
    expect(() => decodeReconciliationPreview(invalid, projectId, subject, "milestone")).toThrow("Reconciliation preview unavailable");
});
it("marks a valid truncated first page and rejects malformed cursors", () => {
  const rows = Array.from({ length: 20 }, (_, n) => summary(n + 1));
  const last = rows.at(-1)!, next = { id: last.id, createdAt: last.createdAt };
  expect(decodeReconciliationPreview(page(rows, next), projectId, subject, "milestone")).toMatchObject({ more: true });
  expect(() => decodeReconciliationPreview(page(rows.slice(0, 19), next), projectId, subject, "milestone")).toThrow();
  expect(() => decodeReconciliationPreview(page(rows, { ...next, id: id(80) }), projectId, subject, "milestone")).toThrow();
});
it.each(["milestone", "scalar"] as const)("validates %s pages against the prior cursor, including timestamp ties", (kind) => {
  const make = (n: number) => {
    const row = summary(n);
    if (kind === "milestone") return row;
    const scalar: Record<string, unknown> = { ...row, factId: id(60), factType: "project.forecast" };
    delete scalar.milestoneId; return scalar;
  };
  const after = { id: id(20), createdAt: time }, rows = Array.from({ length: 20 }, (_, n) => make(n + 21));
  const next = { id: id(40), createdAt: time };
  expect(decodeReconciliationPreview(page(rows, next), projectId, subject, kind, after)).toMatchObject({
    phase: "ready", advanced: true, more: true, next,
  });
  expect(decodeReconciliationPreview(page(), projectId, subject, kind, after)).toEqual({ phase: "ready", advanced: true, items: [], more: false });
  for (const invalid of [page([make(20)]), page([make(19)]), page([make(22), make(21)]), page([make(21), make(21)]),
    page([{ ...make(21), projectId: id(9) }]), page([{ ...make(21), assignment: { ...summary(21).assignment, recipientSubject: "other" } }])])
    expect(() => decodeReconciliationPreview(invalid, projectId, subject, kind, after)).toThrow();
});
it("fetches one explicitly selected recipient page with encoded cursor and no implicit follow-up", async () => {
  const request = vi.fn(async () => page([summary(21)])), after = { id: id(20), createdAt: time };
  const result = await loadReconciliationPreviewPage(projectId, subject, "milestone", after, request, new AbortController().signal, () => {});
  expect(result).toMatchObject({ phase: "ready", advanced: true, items: [{ id: id(21) }], more: false });
  expect(request).toHaveBeenCalledTimes(1);
  const [path] = request.mock.calls[0] as unknown as [string];
  const url = new URL(path, "https://example.invalid");
  expect(url.pathname).toBe(`/projects/${projectId}/reconciliation-requests`);
  expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "20", afterCreatedAt: time, afterId: id(20) });
});
it("keeps the shared lease on a denied page until its body settles, then fails closed", async () => {
  let release!: (value: unknown) => void, denied = false, calls = 0;
  const request = (_path: string, _init: RequestInit, unavailable: (denied?: boolean) => void) => {
    calls++; unavailable(true); return new Promise<unknown>((resolve) => { release = resolve; });
  };
  const active = loadReconciliationPreviewPage(projectId, subject, "scalar", { id: id(20), createdAt: time },
    request, new AbortController().signal, (value) => { denied = value === true; });
  void active.catch(() => {});
  expect(denied).toBe(true);
  await expect(loadReconciliationPreview([{ projectId, name: "Synthetic" }], subject, async () => page(), new AbortController().signal, () => {})).rejects.toThrow();
  expect(calls).toBe(1); release(page()); await expect(active).rejects.toThrow();
  expect((await loadReconciliationPreviewPage(projectId, subject, "scalar", null, async () => page(), new AbortController().signal, () => {})).phase).toBe("ready");
});
it("never publishes an abort-resistant page after its generation is cancelled", async () => {
  let release!: (value: unknown) => void; const controller = new AbortController();
  const active = loadReconciliationPreviewPage(projectId, subject, "milestone", { id: id(20), createdAt: time },
    () => new Promise((resolve) => { release = resolve; }), controller.signal, () => { throw new Error("unexpected denial"); });
  void active.catch(() => {}); controller.abort();
  await expect(loadReconciliationPreviewPage(projectId, subject, "scalar", null, async () => page(), new AbortController().signal, () => {})).rejects.toThrow();
  release(page([summary(21)])); await expect(active).rejects.toThrow();
});
it("limits fan-out to two projects and never overlaps categories for one project", async () => {
  const projects = Array.from({ length: 5 }, (_, n) => ({ projectId: id(n + 1), name: `Project ${n}` }));
  let active = 0, maximum = 0; const inFlight = new Set<string>(), calls: string[] = [];
  const request = async (path: string) => {
    const project = path.split("/")[2]!; expect(inFlight.has(project)).toBe(false);
    inFlight.add(project); active++; maximum = Math.max(maximum, active); calls.push(path);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--; inFlight.delete(project); return page();
  };
  const updates: number[] = [];
  const rows = await loadReconciliationPreview(projects, subject, request, new AbortController().signal, (value) => updates.push(value.length));
  expect(maximum).toBe(2); expect(calls).toHaveLength(10); expect(rows).toHaveLength(5); expect(updates.length).toBe(11);
  expect(rows.every((row) => row.milestone.phase === "ready" && row.scalar.phase === "ready")).toBe(true);
});
it("does not start a new batch until abort-resistant earlier browser calls settle", async () => {
  const controller = new AbortController(), projects = [{ projectId, name: "Synthetic" }];
  let release!: (value: unknown) => void, calls = 0, updates = 0;
  const request = () => { calls++; return new Promise<unknown>((resolve) => { release = resolve; }); };
  const first = loadReconciliationPreview(projects, subject, request, controller.signal, () => { updates++; }); void first.catch(() => {});
  expect(calls).toBe(1); controller.abort();
  await expect(loadReconciliationPreview(projects, subject, request, new AbortController().signal, () => {})).rejects.toThrow();
  expect(calls).toBe(1); release(page()); await expect(first).rejects.toThrow(); expect(updates).toBe(1);
  expect(await loadReconciliationPreview(projects, subject, async () => page(), new AbortController().signal, () => {})).toHaveLength(1);
});
it("marks a failed category unavailable while retaining other freshly decoded categories", async () => {
  const rows = await loadReconciliationPreview([{ projectId, name: "Synthetic" }], subject,
    async (path) => { if (path.endsWith("/reconciliation-requests")) throw new Error("private"); return page(); },
    new AbortController().signal, () => {});
  expect(rows[0]?.milestone).toEqual({ phase: "unavailable" });
  expect(rows[0]?.scalar).toEqual({ phase: "ready", items: [], more: false });
});
it("keeps the lease until both abort-resistant calls finish and never publishes their late results", async () => {
  const controller = new AbortController();
  const projects = [1, 2].map((n) => ({ projectId: id(n), name: `Project ${n}` }));
  const releases: Array<(value: unknown) => void> = []; let calls = 0, updates = 0;
  const request = () => { calls++; return new Promise<unknown>((resolve) => releases.push(resolve)); };
  const first = loadReconciliationPreview(projects, subject, request, controller.signal, () => { updates++; });
  void first.catch(() => {});
  expect(calls).toBe(2); controller.abort(); releases[0]!(page());
  await Promise.resolve();
  await expect(loadReconciliationPreview(projects, subject, request, new AbortController().signal, () => {})).rejects.toThrow();
  expect(calls).toBe(2); releases[1]!(page()); await expect(first).rejects.toThrow();
  expect(updates).toBe(1);
  expect(await loadReconciliationPreview(projects, subject, async () => page(), new AbortController().signal, () => {})).toHaveLength(2);
});
it("publishes an early denial but holds the lease until its response settles", async () => {
  let release!: (value: unknown) => void; let calls = 0;
  const updates: string[] = [];
  const request = (_path: string, _init: RequestInit, unavailable: () => void) => {
    calls++;
    if (calls > 1) return Promise.resolve(page());
    unavailable();
    return new Promise<unknown>((resolve) => { release = resolve; });
  };
  const projects = [{ projectId, name: "Synthetic" }];
  const first = loadReconciliationPreview(projects, subject, request, new AbortController().signal,
    (rows) => updates.push(rows[0]!.milestone.phase));
  expect(updates).toEqual(["loading", "unavailable"]);
  await expect(loadReconciliationPreview(projects, subject, request, new AbortController().signal, () => {})).rejects.toThrow();
  expect(calls).toBe(1); release(page());
  const result = await first;
  expect(result[0]?.milestone.phase).toBe("unavailable"); expect(result[0]?.scalar.phase).toBe("ready");
});
it("withholds both project categories immediately on an access denial", async () => {
  let release!: () => void; const states: string[] = [];
  const row = summary(2);
  const request = async (path: string, _init: RequestInit, unavailable: (denied?: boolean) => void) => {
    if (path.endsWith("/reconciliation-requests")) return page([row]);
    unavailable(true); await new Promise<void>((resolve) => { release = resolve; }); throw new Error("private");
  };
  const first = loadReconciliationPreview([{ projectId, name: "Synthetic" }], subject, request, new AbortController().signal,
    (rows) => states.push(`${rows[0]!.milestone.phase}:${rows[0]!.scalar.phase}`));
  await vi.waitFor(() => expect(states).toContain("unavailable:unavailable"));
  expect(states).toContain("ready:loading"); release();
  const rows = await first; expect(rows[0]?.milestone.phase).toBe("unavailable"); expect(rows[0]?.scalar.phase).toBe("unavailable");
});
