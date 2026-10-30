import { expect, it } from "vitest";
import { ingestionReassessmentPageSchema } from "../packages/domain/src/ingestion-reassessment.js";
import { decodeReassessmentPreview, loadReassessmentPreview } from "../apps/web/src/ingestion-reassessment-preview.js";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), time = "2026-10-21T11:00:00Z";
function row(n: number) {
  return { id: id(n), sourceId: id(700), receiptId: id(701), projectId, configRevision: 1, mappingRevision: 1,
    state: "READY", reason: "QUEUED", attemptCount: 0, totalAttempts: 0, recoveryRevision: 0,
    createdAt: time, availableAt: time, completedAt: null, assessmentId: null, obligationId: null, previewId: null };
}
const page = (items: unknown[] = [], nextCursor: string | null = null) => ({ items, nextCursor });
it("strictly validates and projects only status metadata", () => {
  const input = row(5), result = decodeReassessmentPreview(page([input]), projectId);
  expect(result).toEqual({ rows: [{ state: "READY", reason: "QUEUED", attemptCount: 0, totalAttempts: 0,
    createdAt: time, availableAt: time, completedAt: null }], more: false });
  expect(JSON.stringify(result)).not.toContain(input.id); expect(JSON.stringify(result)).not.toContain(input.sourceId);
  const all = Array.from({ length: 25 }, (_, index) => row(index + 10));
  expect(decodeReassessmentPreview(page(all, all[24]!.id), projectId)).toMatchObject({ more: true });
  for (const invalid of [page([row(5), row(5)]), page([row(6), row(5)]), page([{ ...input, projectId: id(2) }]),
    page([{ ...input, reason: "PRIVATE" }]), page([{ ...input, extra: "private" }]), page([{ ...input, totalAttempts: Number.MAX_SAFE_INTEGER + 1 }]),
    page(all.slice(0, 24), all[23]!.id), page(all, id(999)), { ...page(), extra: "private" }])
    expect(() => decodeReassessmentPreview(invalid, projectId)).toThrow("Reassessment status unavailable");
});
it("matches the domain wire contract for representative field and timestamp boundaries", () => {
  const base = row(5), variants = [base,
    ...["2026-10-21T11:00:00Z", "2026-10-21T11:00:00.1Z", "2026-10-21T11:00:00.123456Z", "2024-02-29T00:00:00Z",
      "0000-01-01T00:00:00Z", "2026-02-29T00:00:00Z", "2026-10-21T11:00Z", "2026-10-21T11:00:00+00:00"]
      .map((createdAt) => ({ ...base, createdAt })),
    ...["READY", "COMPLETED", "BLOCKED", "OTHER"].map((state) => ({ ...base, state })),
    ...["QUEUED", "CLAIMED", "FAILED", "LOCK_CONTENDED", "POLICY_DISABLED", "SOURCE_SCOPE_CHANGED", "RETRY_EXHAUSTED", "RETRY_REQUESTED", "COMPLETED", "OTHER"]
      .map((reason) => ({ ...base, reason })),
    ...[-1, 0, 1, 5, 6, 1.5, Number.MAX_SAFE_INTEGER + 1].map((attemptCount) => ({ ...base, attemptCount })),
    ...[id(6), null, "not-an-id", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"].map((assessmentId) => ({ ...base, assessmentId })),
    { ...base, completedAt: time }, { ...base, configRevision: 0 }, { ...base, mappingRevision: 1.5 },
    { ...base, recoveryRevision: 2147483648 }, { ...base, sourceId: "not-an-id" }];
  for (const variant of variants) {
    const input = page([variant]);
    const expected = ingestionReassessmentPageSchema.safeParse(input).success;
    const accepted = (() => { try { decodeReassessmentPreview(input, projectId); return true; } catch { return false; } })();
    expect(accepted, JSON.stringify(variant)).toBe(expected);
  }
});
it("keeps an aborted read lease until its actual response settles", async () => {
  const controller = new AbortController(); let release!: (value: unknown) => void, calls = 0;
  const request = () => { calls++; return new Promise<unknown>((resolve) => { release = resolve; }); };
  const old = loadReassessmentPreview(projectId, request, controller.signal, () => {}); void old.catch(() => {});
  controller.abort();
  await expect(loadReassessmentPreview(projectId, request, new AbortController().signal, () => {})).rejects.toThrow();
  expect(calls).toBe(1); release(page()); await expect(old).rejects.toThrow();
  expect(await loadReassessmentPreview(projectId, async () => page(), new AbortController().signal, () => {})).toEqual({ rows: [], more: false });
});
it("reports an early denial and never accepts a later success for that read", async () => {
  let release!: (value: unknown) => void, notices = 0;
  const request = (_path: string, _init: RequestInit, unavailable: () => void) => {
    unavailable(); return new Promise<unknown>((resolve) => { release = resolve; });
  };
  const pending = loadReassessmentPreview(projectId, request, new AbortController().signal, () => { notices++; });
  void pending.catch(() => {}); expect(notices).toBe(1); release(page([row(5)]));
  await expect(pending).rejects.toThrow("Reassessment status unavailable");
});
