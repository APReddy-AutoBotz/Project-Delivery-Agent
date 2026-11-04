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

it("latches a current denial across visibility checks but rejects an old A denial after A-B-A", () => {
  const fence = new HealthScopeFence(); fence.bindScope("A"); ready(fence);
  const old = fence.contextSnapshot();
  expect(fence.denyContext(old, current)).toBe(true);
  fence.transition(false); fence.transition(true); fence.bindScope("A");
  expect(fence.denialLatched()).toBe(true); expect(fence.begin("identity")).toBeNull();
  fence.retryScope(); expect(fence.denialLatched()).toBe(false);
  fence.bindScope("B"); fence.bindScope("A");
  expect(fence.denyContext(old, current)).toBe(false);
  expect(fence.denialLatched()).toBe(false);
});

it("admits an assessment and its command key atomically", () => {
  const fence = new HealthScopeFence(), ticket = ready(fence), owner = "owner";
  expect(fence.beginAssessment(ticket, current, owner, "p", () => "new", () => false)).toBeNull();
  expect(fence.hasAssessmentCommand(owner, "p")).toBe(false); expect(fence.writing()).toBe(false);
  expect(fence.beginAssessment(ticket, current, owner, "p", () => { throw new Error("synthetic UUID failure"); })).toBeNull();
  expect(fence.hasAssessmentCommand(owner, "p")).toBe(false); expect(fence.writing()).toBe(false);
  let allowed = true;
  expect(fence.beginAssessment(ticket, current, owner, "p", () => { allowed = false; return "not-sent"; }, () => allowed)).toBeNull();
  expect(fence.hasAssessmentCommand(owner, "p")).toBe(false); expect(fence.writing()).toBe(false);
  const first = fence.beginAssessment(ticket, current, owner, "p", () => "original")!;
  expect(fence.startAssessment(first.lease, current, "p", first.key)).toBe(true);
  fence.markWriteUncertain(first.lease); fence.finishWrite(first.lease);
  const retry = fence.capture(current)!;
  expect(fence.beginAssessment(retry, current, owner, "p", () => "replacement", () => false)).toBeNull();
  expect(fence.hasAssessmentCommand(owner, "p")).toBe(true);
  expect(fence.beginAssessment(retry, current, owner, "p", () => "replacement")).toBeNull();
  expect(fence.writing()).toBe(false);
});

it("removes only a newly allocated command when admission becomes stale before dispatch", () => {
  const fence = new HealthScopeFence(), owner = "owner";
  const first = fence.beginAssessment(ready(fence), current, owner, "new", () => "new-key")!;
  fence.transition(false);
  expect(fence.startAssessment(first.lease, current, "new", first.key)).toBe(false);
  fence.finishWrite(first.lease);
  expect(fence.hasAssessmentCommand(owner, "new")).toBe(false);

  const sent = fence.beginAssessment(ready(fence), current, owner, "old", () => "old-key")!;
  expect(fence.startAssessment(sent.lease, current, "old", sent.key)).toBe(true);
  fence.markWriteUncertain(sent.lease); fence.finishWrite(sent.lease);
  expect(fence.beginAssessment(fence.capture(current)!, current, owner, "old", () => "new-key")).toBeNull();
  fence.transition(false);
  expect(fence.hasAssessmentCommand(owner, "old")).toBe(true);
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

it("clears a denial on actual A-to-B-to-A switches even when B never binds", () => {
  const fence = new HealthScopeFence(); fence.transition(true); fence.bindScope("A");
  const oldContext = fence.contextSnapshot();
  expect(fence.denyContext(oldContext, current)).toBe(true); expect(fence.denialLatched()).toBe(true);
  fence.switchScope(true); fence.switchScope(true);
  expect(fence.denialLatched()).toBe(false);
  expect(fence.denyContext(oldContext, current)).toBe(false);
  expect(fence.bindScope("A")).toBe(true);
  const identity = fence.begin("identity"); fence.finish(identity, true);
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

it("blocks retained assessments across transitions and binds completion to the original dispatched lease", () => {
  const fence = new HealthScopeFence(), owner = JSON.stringify(["customer", "subject"]);
  const start = fence.beginAssessment(ready(fence), current, owner, "project-a", () => "original-key")!;
  fence.completeAssessment(start.lease, current, "project-a", start.key);
  expect(fence.hasAssessmentCommand(owner, "project-a")).toBe(true); // unsent is not confirmation
  expect(fence.startAssessment(start.lease, current, "project-a", start.key)).toBe(true);
  fence.completeAssessment(start.lease, current, "project-b", start.key);
  fence.completeAssessment(start.lease, current, "project-a", "wrong-key");
  expect(fence.hasAssessmentCommand(owner, "project-a")).toBe(true);
  fence.transition(false); fence.transition(true);
  fence.completeAssessment(start.lease, current, "project-a", start.key); // stale response
  fence.markWriteUncertain(start.lease); fence.finishWrite(start.lease);
  const ticket = ready(fence);
  expect(fence.uncertain(owner)).toBe(true);
  expect(fence.beginAssessment(ticket, current, owner, "project-a", () => "different-key")).toBeNull();
  const other = fence.beginAssessment(ticket, current, owner, "project-b", () => "project-b-key")!;
  expect(fence.startAssessment(other.lease, current, "project-b", other.key)).toBe(true);
  fence.completeAssessment(other.lease, current, "project-a", start.key);
  expect(fence.hasAssessmentCommand(owner, "project-a")).toBe(true);
  fence.completeAssessment(other.lease, current, "project-b", other.key); fence.finishWrite(other.lease);
  expect(fence.hasAssessmentCommand(owner, "project-b")).toBe(false);
  const next = fence.beginAssessment(fence.capture(current)!, current, owner, "project-b", () => "fresh-key")!;
  expect(next.key).toBe("fresh-key"); fence.finishWrite(next.lease);
  expect(fence.hasAssessmentCommand(owner, "project-a")).toBe(true);
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
