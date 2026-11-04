import { expect, it } from "vitest";
import { policyRevisionMatches } from "../apps/web/src/health-policy-admission.js";
import { HealthScopeFence } from "../apps/web/src/health-scope-fence.js";

const ready = (data: unknown) => ({ status: "success", fetchStatus: "idle", data });
const threshold = { revision: 2, minimumBlockerAgeDays: 3, auditRetentionHours: 24, changedBy: "subject", changedAt: "2026-10-21T00:00:00.000Z" };
const schedule = { revision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], changedBy: null, changedAt: null };

it("accepts only the exact current decoded policy revision", () => {
  expect(policyRevisionMatches({ kind: "threshold", revision: 2 }, ready(threshold))).toBe(true);
  expect(policyRevisionMatches({ kind: "threshold", revision: 1 }, ready(threshold))).toBe(false);
  expect(policyRevisionMatches({ kind: "threshold", revision: 0 }, ready(null))).toBe(true);
  expect(policyRevisionMatches({ kind: "threshold", revision: 0 }, ready(undefined))).toBe(false);
  expect(policyRevisionMatches({ kind: "schedule", revision: 0 }, ready(schedule))).toBe(true);
  expect(policyRevisionMatches({ kind: "schedule", revision: 1 }, ready(schedule))).toBe(false);
  expect(policyRevisionMatches({ kind: "schedule", revision: 0 }, ready(null))).toBe(false);
});

it("fails closed for missing, in-flight, malformed, stale or invalid inputs", () => {
  const policy = { kind: "threshold" as const, revision: 2 };
  expect(policyRevisionMatches(policy, undefined)).toBe(false);
  expect(policyRevisionMatches(policy, { status: "error", fetchStatus: "idle", data: threshold })).toBe(false);
  expect(policyRevisionMatches(policy, { status: "success", fetchStatus: "fetching", data: threshold })).toBe(false);
  expect(policyRevisionMatches(policy, { status: "success", fetchStatus: "paused", data: threshold })).toBe(false);
  expect(policyRevisionMatches(policy, ready({ revision: 2 }))).toBe(false);
  expect(policyRevisionMatches({ kind: "invalid", revision: 2 } as never, ready(threshold))).toBe(false);
  expect(policyRevisionMatches({ kind: "threshold", revision: Number.NaN }, ready(threshold))).toBe(false);
  const hostile = new Proxy({}, { get() { throw new Error("synthetic-private"); } });
  expect(policyRevisionMatches(policy, ready(hostile))).toBe(false);
});

it("does not allocate a lease from a stale or missing current-scope revision", () => {
  for (const kind of ["threshold", "schedule"] as const) {
    const fence = new HealthScopeFence(), current = () => true;
    fence.transition(true); fence.finish(fence.begin("identity"), true); fence.finish(fence.begin("project"), true);
    const ticket = fence.capture(current)!, initial = kind === "threshold" ? { ...threshold, revision: 1 } : { ...schedule, revision: 1 };
    const latest = { ...initial, revision: 2 };
    const states = new Map([["project-A", ready(initial)], ["project-B", ready(latest)]]);
    const submit = (scope: string, revision: number) => fence.beginWrite(ticket, current, "owner", () =>
      policyRevisionMatches({ kind, revision }, states.get(scope)));
    states.set("project-A", ready(latest));
    expect(submit("project-A", 1)).toBeNull(); expect(fence.writing()).toBe(false);
    states.delete("project-A"); expect(submit("project-A", 2)).toBeNull();
    states.set("project-A", ready(latest)); const lease = submit("project-A", 2);
    expect(lease).not.toBeNull(); fence.finishWrite(lease!);
  }
});
