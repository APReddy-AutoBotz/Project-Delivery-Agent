import { expect, it } from "vitest";
import { ProtectedSessionModel } from "../apps/web/src/protected-session-model.js";
import { createQueueResponseCoordinator } from "../apps/web/src/protected-queue-response.js";
import { assessProjectCompleteness, assessUpdateFreshness, buildBlockerAgeAdvice, buildPmActionQueue,
  buildScheduleAdviceSnapshot, buildUpdateAdviceSnapshot } from "../packages/domain/src/index.js";

const A = "30000000-0000-4000-8000-000000000001", B = "30000000-0000-4000-8000-000000000002";
const asOf = "2026-10-21T11:00:00.000Z";
function project(projectId: string, name: string) {
  return { projectId, name,
    schedule: { projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY", sourceAuthority: "NOT_ASSESSED",
      approvalItems: "UNAVAILABLE", rankPolicyRevision: "advice-core@1", asOf, items: [] },
    update: { projectId, audience: "project_manager", availability: "UNCONFIGURED", approvalItems: "UNAVAILABLE", asOf },
    blockerAge: { projectId, audience: "project_manager", ruleRevision: "blocker-age@1", orderRevision: "blocker-review-order@1",
      timeZone: "UTC", asOf, coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, items: [] },
  };
}
function response(ids: string[]) {
  return JSON.stringify({ rankPolicyRevision: "pm-review-order@1",
    coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED", approvals: "UNAVAILABLE",
      blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" },
    projects: ids.map((id, index) => project(id, `Project ${index + 1}`)), items: [] });
}
function setup() {
  const model = new ProtectedSessionModel(), session = model.establish(model.beginLogin(), "synthetic-token")!;
  model.finishIdentity(model.beginIdentity(session)!, "success", { customerId: "10000000-0000-4000-8000-000000000001", subject: "person", roles: ["project_manager"] });
  const view = model.enterQueueView(model.capability(session)!)!;
  return { model, session, view };
}

it("mints frozen membership from the same privately decoded valid response", () => {
  const { model, view } = setup(), coordinator = createQueueResponseCoordinator(model, view, model.queueIdleFor(view)!);
  expect("complete" in coordinator.callbacks).toBe(false); expect(coordinator.callbacks.start()).toBe(true);
  const result = coordinator.complete(200, response([A, B]))!;
  expect(result.projects).toEqual([{ projectId: A, name: "Project 1" }, { projectId: B, name: "Project 2" }]);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.projects)).toBe(true); expect(Object.isFrozen(result.projects[0])).toBe(true);
  expect(Object.isFrozen(result.snapshot)).toBe(true); expect(Object.isFrozen(result.snapshot.projects)).toBe(true);
  expect(Object.isFrozen(result.snapshot.projects[0]!.schedule)).toBe(true);
  expect(() => { (result.snapshot.projects[0] as unknown as { name: string }).name = "altered"; }).toThrow();
  expect(result.projects[0]!.name).toBe(result.snapshot.projects[0]!.name);
  const turn = model.beginPreview(result.queue, model.previewIdleFor(result.queue)!, [A, B])!;
  expect(model.currentPreviewRow(result.queue, turn, turn.rows[1]!)).toBe(true);
  expect(coordinator.complete(200, response([B]))).toBeNull();
});

it("keeps a valid empty queue distinct from a failed response", () => {
  const { model, view } = setup(), coordinator = createQueueResponseCoordinator(model, view, model.queueIdleFor(view)!);
  expect(coordinator.callbacks.start()).toBe(true);
  const result = coordinator.complete(200, response([]))!;
  expect(result.projects).toEqual([]); expect(result.snapshot.projects).toEqual([]);
  expect(model.currentQueue(result.queue)).toBe(true);
});

it("retains the full validated schedule, update and blocker queue from the same response", () => {
  const requiredFacts = [{ factType: "delivery.status", label: "Delivery status" }];
  const completeness = assessProjectCompleteness({ assessedAt: asOf, projectId: A, ruleKey: "project-update", ruleRevision: "2",
    requiredFactsComplete: true, requiredFacts, factAssessments: [{ factType: "delivery.status", canonicalVersionCount: 0,
      sourceAuthorityStatus: "UNKNOWN", conflict: "NONE" }] });
  const freshness = assessUpdateFreshness({ asOf, timeZone: "UTC", timeZoneSource: "PROJECT",
    project: { id: A, code: "P-1", name: "Synthetic", createdAt: "2026-10-21T10:59:00.000Z", latestValidUpdateAt: null },
    policy: { key: "project-update", revision: "2", freshnessWindowSeconds: 60, responsibleSubject: "synthetic-pm", obligationDueAt: asOf, requiredFacts } }).freshness;
  const schedule = buildScheduleAdviceSnapshot({ asOf, recipient: { subject: "synthetic-pm", audience: "project_manager" },
    snapshot: { projectId: A, projectRevision: 1, reportedStatus: "UNKNOWN", assessedAt: asOf,
      scheduleHealthPolicy: { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] },
      milestones: [{ id: B, key: "M-1", state: "OPEN", forecastEnd: null, plannedEnd: null }], workItems: [] } });
  const update = buildUpdateAdviceSnapshot({ asOf, projectId: A, audience: "project_manager", policyRevision: 2, completeness, freshness, evidence: [] });
  const blockerAge = buildBlockerAgeAdvice({ projectId: A, audience: "project_manager", asOf, coverage: "UNASSESSABLE",
    threshold: null, inventory: null, noOpenBlockers: null, candidates: [] });
  const original = buildPmActionQueue([{ projectId: A, name: "Synthetic", schedule, update, blockerAge }]);
  const { model, view } = setup(), coordinator = createQueueResponseCoordinator(model, view, model.queueIdleFor(view)!);
  coordinator.callbacks.start(); const result = coordinator.complete(200, JSON.stringify(original))!;
  expect(result.snapshot).toEqual(original); expect(result.snapshot.items.length).toBeGreaterThan(0);
  expect(result.snapshot.projects[0]!.update.availability).toBe("AVAILABLE");
  expect(result.snapshot.projects[0]!.blockerAge.coverage).toBe("UNASSESSABLE");
  expect(Object.isFrozen(result.snapshot.items[0])).toBe(true);
  expect(() => { (result.snapshot.items as unknown as unknown[]).pop(); }).toThrow();
  expect(result.projects[0]!.projectId).toBe(result.snapshot.projects[0]!.projectId);
});

it("rejects wrong status, malformed input and raw size overflow without membership", () => {
  for (const [status, text] of [[201, response([A])], [403, response([A])], [200, "{"],
    [200, JSON.stringify({ projects: [A] })], [200, " ".repeat(2 * 1024 * 1024 + 1)], [200, {}]] as const) {
    const { model, view } = setup(), coordinator = createQueueResponseCoordinator(model, view, model.queueIdleFor(view)!);
    expect(coordinator.callbacks.start()).toBe(true); expect(coordinator.complete(status, text)).toBeNull();
    expect(coordinator.callbacks.current()).toBe(false);
    expect(coordinator.complete(200, response([A]))).toBeNull();
  }
});

it("applies the raw UTF-8 cap before parsing, including whitespace and multibyte input", () => {
  const maximum = 2 * 1024 * 1024, original = response([A]);
  const exact = original + " ".repeat(maximum - new TextEncoder().encode(original).byteLength);
  const first = setup(), allowed = createQueueResponseCoordinator(first.model, first.view, first.model.queueIdleFor(first.view)!);
  allowed.callbacks.start(); expect(allowed.complete(200, exact)).not.toBeNull();
  const payload = JSON.parse(original) as Record<string, unknown>; payload.padding = "é".repeat(maximum / 2);
  const multibyte = JSON.stringify(payload);
  expect(multibyte.length).toBeLessThan(maximum);
  expect(new TextEncoder().encode(multibyte).byteLength).toBeGreaterThan(maximum);
  const second = setup(), rejected = createQueueResponseCoordinator(second.model, second.view, second.model.queueIdleFor(second.view)!);
  rejected.callbacks.start(); expect(rejected.complete(200, multibyte)).toBeNull();
});

it("cannot use a stale response or stale cleanup to alter a later queue", () => {
  const { model, view } = setup(), old = createQueueResponseCoordinator(model, view, model.queueIdleFor(view)!);
  expect(old.callbacks.start()).toBe(true); old.callbacks.dispose();
  const fresh = createQueueResponseCoordinator(model, view, model.queueIdleFor(view)!);
  expect(fresh.callbacks.start()).toBe(true); const current = fresh.complete(200, response([B]))!;
  expect(old.complete(200, response([A]))).toBeNull(); old.callbacks.dispose();
  expect(model.currentQueue(current.queue)).toBe(true); expect(current.projects.map((item) => item.projectId)).toEqual([B]);
});

it("invalidates on identity change and fails closed on case-colliding queue IDs", () => {
  const { model, session, view } = setup(), old = createQueueResponseCoordinator(model, view, model.queueIdleFor(view)!);
  old.callbacks.start(); const identity = model.beginIdentity(session)!;
  expect(old.complete(200, response([A]))).toBeNull();
  model.finishIdentity(identity, "success", { customerId: "10000000-0000-4000-8000-000000000001", subject: "person", roles: ["project_manager"] });
  const currentView = model.enterQueueView(model.capability(session)!)!;
  const current = createQueueResponseCoordinator(model, currentView, model.queueIdleFor(currentView)!);
  current.callbacks.start();
  const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", upper = lower.toUpperCase();
  expect(current.complete(200, response([upper, lower]))).toBeNull(); expect(current.callbacks.current()).toBe(false);
});
