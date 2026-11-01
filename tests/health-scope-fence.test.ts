import { expect, it } from "vitest";
import { HealthScopeFence } from "../apps/web/src/health-scope-fence.js";

const current = () => true;
function ready(fence: HealthScopeFence) {
  fence.transition(true);
  const identity = fence.begin("identity"); fence.finish(identity, true);
  const project = fence.begin("project"); fence.finish(project, true);
  const read = fence.capture(current); expect(read).not.toBeNull(); return read!;
}

it("requires independent fresh identity and project checks", () => {
  const fence = new HealthScopeFence(); fence.transition(true);
  const identity = fence.begin("identity");
  expect(fence.begin("project")).toBeNull(); expect(fence.capture(current)).toBeNull();
  fence.finish(identity, true); const project = fence.begin("project");
  fence.finish(project, true); expect(fence.capture(current)).not.toBeNull();
  expect(fence.capture(() => false)).toBeNull();
});

it("rejects stale check completions and aborted prior reads across A-B-A", () => {
  const fence = new HealthScopeFence(), old = ready(fence);
  const read = fence.trackRead(old, current)!;
  const oldIdentity = fence.begin("identity");
  expect(read.signal.aborted).toBe(true); expect(fence.valid(old, current)).toBe(false);
  fence.transition(true); const firstB = fence.begin("identity");
  fence.transition(true); const currentIdentity = fence.begin("identity");
  fence.finish(oldIdentity, true); fence.finish(firstB, true);
  expect(fence.capture(current)).toBeNull();
  fence.finish(currentIdentity, true); const project = fence.begin("project"); fence.finish(project, true);
  expect(fence.capture(current)).not.toBeNull();
  read.release();
});

it("keeps one write lease across visibility and identity transitions", () => {
  const fence = new HealthScopeFence(), old = ready(fence), read = fence.trackRead(old, current)!;
  expect(fence.beginWrite(old, current, "owner")).toBeNull();
  read.release();
  const lease = fence.beginWrite(old, current, "owner")!;
  expect(fence.validWrite(lease, current)).toBe(true); expect(fence.capture(current)).toBeNull();
  fence.transition(false); fence.transition(true);
  expect(fence.validWrite(lease, current)).toBe(false);
  fence.markWriteUncertain(lease);
  expect(fence.uncertain("owner")).toBe(true);
  expect(fence.uncertain("other owner")).toBe(false);
  const identity = fence.begin("identity"); fence.finish(identity, true);
  const project = fence.begin("project"); fence.finish(project, true);
  expect(fence.capture(current)).toBeNull();
  fence.finishWrite({ id: Symbol("other"), context: lease.context, owner: "owner" });
  expect(fence.capture(current)).toBeNull();
  fence.finishWrite(lease);
  const next = fence.capture(current); expect(next).not.toBeNull();
  expect(fence.valid(old, current)).toBe(false);
  fence.finishWrite(lease); expect(fence.valid(next!, current)).toBe(true);
});

it("does not let an older completion make a newer failed check ready", () => {
  const fence = new HealthScopeFence(); fence.transition(true);
  const first = fence.begin("identity"), second = fence.begin("identity");
  fence.finish(second, false); fence.finish(first, true); fence.finish(second, true);
  expect(fence.capture(current)).toBeNull();
  const retry = fence.begin("identity"); fence.finish(retry, true);
  const project = fence.begin("project"); fence.finish(project, true);
  expect(fence.capture(current)).not.toBeNull();
});

it("invalidates a prior project proof when identity is rechecked", () => {
  const fence = new HealthScopeFence(), old = ready(fence);
  const identity = fence.begin("identity"); fence.finish(identity, true);
  expect(fence.valid(old, current)).toBe(false); expect(fence.capture(current)).toBeNull();
  const project = fence.begin("project"); fence.finish(project, false); fence.finish(project, true);
  expect(fence.capture(current)).toBeNull();
  const retry = fence.begin("project"); fence.finish(retry, true); expect(fence.capture(current)).not.toBeNull();
});

it("invalidates old reads when a coordinated refresh starts", () => {
  const fence = new HealthScopeFence(), old = ready(fence), read = fence.trackRead(old, current)!;
  fence.refreshReads(); expect(read.signal.aborted).toBe(true); expect(fence.valid(old, current)).toBe(false);
  expect(fence.capture(current)).not.toBeNull();
});

it("retains one assessment command across panels and same-principal scope changes", () => {
  const fence = new HealthScopeFence(), first = ready(fence), owner = JSON.stringify(["customer", "subject"]);
  const key = fence.assessmentCommand(first, current, owner, "project-a", () => "original-key");
  expect(key).toBe("original-key");
  const lease = fence.beginWrite(first, current, owner)!; fence.markWriteUncertain(lease);
  fence.transition(false); fence.transition(true); fence.finishWrite(lease);
  const identity = fence.begin("identity"); fence.finish(identity, true);
  const project = fence.begin("project"); fence.finish(project, true);
  const retry = fence.capture(current)!;
  expect(fence.uncertain(owner)).toBe(true);
  expect(fence.uncertain(JSON.stringify(["customer", "other"]))).toBe(false);
  expect(fence.assessmentCommand(retry, current, owner, "project-a", () => "different-key")).toBe("original-key");
  expect(fence.assessmentCommand(retry, current, owner, "project-b", () => "project-b-key")).toBe("project-b-key");
  const nextLease = fence.beginWrite(retry, current, owner)!;
  fence.completeAssessment(nextLease, current, "project-a", "different-key");
  expect(fence.hasAssessmentCommand(owner, "project-a")).toBe(true);
  fence.completeAssessment(nextLease, current, "project-a", "original-key");
  fence.finishWrite(nextLease);
  expect(fence.hasAssessmentCommand(owner, "project-a")).toBe(false);
});

it("reports a bounded uncertainty-capacity stop instead of silently forgetting outcomes", () => {
  const fence = new HealthScopeFence(); ready(fence);
  for (let index = 0; index < 64; index++) {
    const ticket = fence.capture(current)!;
    const lease = fence.beginWrite(ticket, current, "owner-" + index)!;
    fence.markWriteUncertain(lease); fence.finishWrite(lease);
  }
  expect(fence.atCapacity("new-owner")).toBe(true);
  expect(fence.beginWrite(fence.capture(current)!, current, "new-owner")).toBeNull();
  expect(fence.atCapacity("owner-0")).toBe(false);
});

it("notifies subscribers without publishing synchronously during a query start", async () => {
  const fence = new HealthScopeFence(); let notices = 0;
  const unsubscribe = fence.subscribe(() => { notices++; });
  fence.transition(true); fence.begin("identity"); fence.begin("project");
  expect(notices).toBe(0); await Promise.resolve(); expect(notices).toBe(1);
  unsubscribe(); fence.transition(false); await Promise.resolve(); expect(notices).toBe(1);
});
