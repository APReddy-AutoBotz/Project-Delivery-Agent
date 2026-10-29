import { describe, expect, it } from "vitest";
import { buildPmActionQueue, pmActionQueueSchema } from "../packages/domain/src/pm-action-queue.js";
import { buildScheduleAdviceSnapshot } from "../packages/domain/src/delivery-advice.js";
import { buildUpdateAdviceSnapshot } from "../packages/domain/src/update-advice.js";
import { assessProjectCompleteness } from "../packages/domain/src/completeness-signals.js";
import { assessUpdateFreshness } from "../packages/domain/src/freshness-signals.js";
import { decodeBlockerAge, decodePmQueue } from "../apps/web/src/pm-queue-decoder.js";
import { buildBlockerAgeAdvice } from "../packages/domain/src/blocker-age-advice.js";

const asOf = "2026-10-21T11:00:00.000Z";
const id = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
function aged(projectId: string) {
  const raid = id(9000);
  const proof = (factType: string, n: number, validity: "FINITE" | "UNTIL_SUPERSEDED") => ({ factId: id(n), factType, factRevision: 1,
    policyId: id(n + 100), policyRevisionId: id(n + 200), policyRevision: 1, status: "RESOLVED", provenance: "HUMAN_CONFIRMED",
    sourceType: "human_statement", freshness: "CURRENT", conflict: "NONE", validity,
    supports: [{ versionId: id(n + 300), evidenceId: id(n + 400), sourceId: id(n + 500), accessRevision: 1 }] });
  return buildBlockerAgeAdvice({ projectId, audience: "project_manager", asOf, coverage: "COMPLETE",
    threshold: { minimumBlockerAgeDays: 5, revision: 1 }, noOpenBlockers: false,
    inventory: proof("project.open_blocker_inventory_complete", 10, "FINITE"),
    candidates: [{ raidItemId: raid, key: "ISSUE-1", state: "OPEN", openedAt: "2026-10-16",
      classification: proof(`raid_item.${raid}.blocks_delivery`, 11, "FINITE"),
      openedAtProof: proof(`raid_item.${raid}.opened_at`, 12, "UNTIL_SUPERSEDED") }] });
}
function observation(number: number, options: { update?: boolean; targets?: number } = {}) {
  const projectId = id(number), count = options.targets ?? 1;
  const schedule = buildScheduleAdviceSnapshot({ asOf, recipient: { subject: "synthetic-pm", audience: "project_manager" },
    snapshot: { projectId, projectRevision: 1, reportedStatus: "UNKNOWN", assessedAt: asOf,
      scheduleHealthPolicy: { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] },
      milestones: Array.from({ length: count }, (_, i) => ({ id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        key: `M-${i}`, state: "OPEN", forecastEnd: null, plannedEnd: null })), workItems: [] } });
  const requiredFacts = [{ factType: "delivery.status", label: "Delivery status" }];
  const completeness = assessProjectCompleteness({ assessedAt: asOf, projectId, ruleKey: "project-update", ruleRevision: "2", requiredFactsComplete: true,
    requiredFacts, factAssessments: [{ factType: "delivery.status", canonicalVersionCount: 0, sourceAuthorityStatus: "UNKNOWN", conflict: "NONE" }] });
  const freshness = assessUpdateFreshness({ asOf, timeZone: "UTC", timeZoneSource: "PROJECT",
    project: { id: projectId, code: "P-1", name: "Synthetic", createdAt: "2026-10-21T10:59:00.000Z", latestValidUpdateAt: null },
    policy: { key: "project-update", revision: "2", freshnessWindowSeconds: 60, responsibleSubject: "synthetic-pm", obligationDueAt: asOf, requiredFacts } }).freshness;
  const update = options.update ? buildUpdateAdviceSnapshot({ asOf, projectId, audience: "project_manager", policyRevision: 2, completeness, freshness, evidence: [] }) :
    { availability: "UNCONFIGURED" as const, asOf, projectId, audience: "project_manager" as const, approvalItems: "UNAVAILABLE" as const };
  const blockerAge = buildBlockerAgeAdvice({ projectId, audience: "project_manager", asOf, coverage: "UNASSESSABLE",
    threshold: null, inventory: null, noOpenBlockers: null, candidates: [] });
  return { projectId, name: `Project ${number}`, schedule, update, blockerAge };
}

describe("EXEC-026 PM queue composition", () => {
  it("orders distinct authorized observations deterministically and preserves facet evidence", () => {
    const first = observation(1, { update: true }), second = observation(2);
    const queue = buildPmActionQueue([second, first]);
    expect(queue).toEqual(buildPmActionQueue([first, second]));
    expect(queue.projects.map((project) => project.projectId)).toEqual([id(1), id(2)]);
    expect(queue.items[0]).toMatchObject({ facet: "UPDATE", priority: "MEDIUM", projectId: id(1) });
    expect(queue.coverage).toMatchObject({ approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE" });
    expect(queue.projects[0]!.schedule).toEqual(first.schedule);
    expect(queue.projects[1]!.update.availability).toBe("UNCONFIGURED");
    expect(pmActionQueueSchema.safeParse(queue).success).toBe(true);
  });
  it("rejects duplicate projects, wrong scopes and leadership facets", () => {
    const first = observation(1), second = observation(2);
    expect(() => buildPmActionQueue([first, first])).toThrow("Action queue unavailable");
    expect(() => buildPmActionQueue([{ ...first, update: second.update }])).toThrow("Action queue unavailable");
    expect(() => buildPmActionQueue([{ ...first, schedule: { ...first.schedule, audience: "leadership" } }])).toThrow("Action queue unavailable");
  });
  it("does not accept fabricated pointers or ranking", () => {
    const result = buildPmActionQueue([observation(1, { update: true })]);
    expect(pmActionQueueSchema.safeParse({ ...result, items: result.items.toReversed() }).success).toBe(false);
    expect(pmActionQueueSchema.safeParse({ ...result, items: result.items.slice(1) }).success).toBe(false);
  });
  it("accepts server output and rejects malformed or incomplete presentation data", () => {
    const result = buildPmActionQueue([observation(1, { update: true }), observation(2)]);
    expect(decodePmQueue(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(() => decodePmQueue({ ...result, items: result.items.slice(1) })).toThrow("Invalid action queue presentation");
    expect(() => decodePmQueue({ ...result, items: result.items.toReversed() })).toThrow("Invalid action queue presentation");
    expect(() => decodePmQueue({ ...result, coverage: { ...result.coverage, approvals: "AVAILABLE" } })).toThrow("Invalid action queue presentation");
    const malformed = structuredClone(result), item = malformed.projects[0]!.schedule.items[0]!;
    if (item.trigger.kind !== "DELIVERY_SIGNAL") throw new Error("Expected signal fixture");
    item.trigger.signal.sourceFacts[0] = null as never;
    expect(() => decodePmQueue(malformed)).toThrow("Invalid action queue presentation");
    const absentIndex = structuredClone(result);
    const update = absentIndex.items.find((pointer) => pointer.facet === "UPDATE")!;
    delete (update as { index?: null }).index;
    expect(() => decodePmQueue(absentIndex)).toThrow("Invalid action queue presentation");
  });
  it("rejects corrupt rendered source fields, revisions, and signal labels", () => {
    const queue = buildPmActionQueue([observation(1, { update: true })]);
    const invalidSource = structuredClone(queue), update = invalidSource.projects[0]!.update;
    if (update.availability !== "AVAILABLE") throw new Error("Expected configured update fixture");
    (update.freshness as { sourceDateField: string }).sourceDateField = "unexpected";
    expect(() => decodePmQueue(invalidSource)).toThrow("Invalid action queue presentation");
    const invalidRevision = structuredClone(queue), changedUpdate = invalidRevision.projects[0]!.update;
    if (changedUpdate.availability !== "AVAILABLE") throw new Error("Expected configured update fixture");
    changedUpdate.policyRevision = -1;
    expect(() => decodePmQueue(invalidRevision)).toThrow("Invalid action queue presentation");
    const invalidClock = structuredClone(queue), wrongClock = invalidClock.projects[0]!.update;
    if (wrongClock.availability !== "AVAILABLE") throw new Error("Expected configured update fixture");
    wrongClock.completeness.assessedAt = "2026-10-21T11:00:01.000Z";
    expect(() => decodePmQueue(invalidClock)).toThrow("Invalid action queue presentation");
    const invalidRule = structuredClone(queue), wrongRule = invalidRule.projects[0]!.update;
    if (wrongRule.availability !== "AVAILABLE" || !wrongRule.suggestion) throw new Error("Expected update suggestion fixture");
    (wrongRule.suggestion as { ruleRevision: string }).ruleRevision = "unexpected";
    expect(() => decodePmQueue(invalidRule)).toThrow("Invalid action queue presentation");
    const noEvidence = structuredClone(queue), item = noEvidence.projects[0]!.schedule.items[0]!;
    if (item.trigger.kind !== "DELIVERY_SIGNAL") throw new Error("Expected signal fixture");
    item.trigger.signal.sourceFacts = [];
    expect(() => decodePmQueue(noEvidence)).toThrow("Invalid action queue presentation");
    const invalidLabel = structuredClone(buildPmActionQueue([observation(1)]));
    invalidLabel.projects[0]!.schedule.items[0]!.category = "SCHEDULE_REVIEW";
    invalidLabel.items[0]!.category = "SCHEDULE_REVIEW";
    expect(() => decodePmQueue(invalidLabel)).toThrow("Invalid action queue presentation");
  });
  it("keeps a configured clear update distinct from an unconfigured update", () => {
    const first = observation(1), second = observation(2), projectId = first.projectId;
    const sourceDate = "2026-10-21T10:59:00.000Z";
    const requiredFacts = [{ factType: "delivery.status", label: "Delivery status" }];
    const completeness = assessProjectCompleteness({ assessedAt: asOf, projectId, ruleKey: "project-update", ruleRevision: "2",
      requiredFactsComplete: true, requiredFacts, factAssessments: [{ factType: "delivery.status", canonicalVersionCount: 1,
        sourceAuthorityStatus: "RESOLVED", conflict: "NONE" }] });
    const freshness = assessUpdateFreshness({ asOf, timeZone: "UTC", timeZoneSource: "PROJECT",
      project: { id: projectId, code: "P-1", name: "Synthetic", createdAt: sourceDate, latestValidUpdateAt: sourceDate },
      policy: { key: "project-update", revision: "2", freshnessWindowSeconds: 60,
        responsibleSubject: "synthetic-pm", obligationDueAt: asOf, requiredFacts } }).freshness;
    const update = buildUpdateAdviceSnapshot({ asOf, projectId, audience: "project_manager", policyRevision: 2, completeness, freshness,
      evidence: [{ factId: "20000000-0000-4000-8000-000000000001", factType: "delivery.status",
        versionId: "30000000-0000-4000-8000-000000000001", evidenceId: "40000000-0000-4000-8000-000000000001",
        sourceId: "50000000-0000-4000-8000-000000000001", sourceAccessRevision: 1, authorityRevision: 1,
        observedAt: sourceDate, effectiveAt: sourceDate, timestampBasis: "HUMAN_OBSERVED_AT" }] });
    const queue = buildPmActionQueue([{ ...first, update }, second]);
    expect(queue.projects[0]!.update).toMatchObject({ availability: "AVAILABLE", suggestion: null });
    expect(queue.projects[1]!.update).toMatchObject({ availability: "UNCONFIGURED" });
    expect(queue.items.some((item) => item.facet === "UPDATE")).toBe(false);
    expect(decodePmQueue(JSON.parse(JSON.stringify(queue)))).toEqual(queue);
  });
  it("accepts 25 unique observations and rejects the 26th", () => {
    expect(buildPmActionQueue(Array.from({ length: 25 }, (_, i) => observation(i + 1))).projects).toHaveLength(25);
    expect(() => buildPmActionQueue(Array.from({ length: 26 }, (_, i) => observation(i + 1)))).toThrow("Action queue unavailable");
  });
  it("fails rather than truncating a queue beyond 500 items", () => {
    const projects = Array.from({ length: 10 }, (_, i) => observation(i + 1, { targets: 50 }));
    expect(projects.every((project) => project.schedule.items.length === 50)).toBe(true);
    expect(buildPmActionQueue(projects).items).toHaveLength(500);
    projects[0] = observation(1, { targets: 50, update: true });
    expect(() => buildPmActionQueue(projects)).toThrow("Action queue unavailable");
  });
  it("counts blocker review alongside ranked items and preserves its separate order", () => {
    const projects = Array.from({ length: 10 }, (_, i) => observation(i + 1, { targets: i === 0 ? 49 : 50 }));
    projects[0] = { ...projects[0]!, blockerAge: aged(id(1)) };
    const queue = buildPmActionQueue(projects);
    expect(queue.items).toHaveLength(499);
    expect(queue.projects[0]!.blockerAge.items).toHaveLength(1);
    expect(decodePmQueue(JSON.parse(JSON.stringify(queue)))).toEqual(queue);
    projects[0] = { ...observation(1, { targets: 50 }), blockerAge: aged(id(1)) };
    expect(() => buildPmActionQueue(projects)).toThrow("Action queue unavailable");
    const wrong = structuredClone(queue); wrong.projects[0]!.blockerAge.projectId = id(2);
    expect(() => decodePmQueue(wrong)).toThrow("Invalid action queue presentation");
  });
  it("rejects malformed blocker proof, dates and coverage before rendering", () => {
    const first = observation(1), facet = aged(id(1));
    const complete = buildPmActionQueue([{ ...first, blockerAge: facet }]);
    expect(decodePmQueue(JSON.parse(JSON.stringify(complete)))).toEqual(complete);
    const partial = structuredClone(complete);
    partial.projects[0]!.blockerAge = { ...facet, coverage: "PARTIAL", noOpenBlockers: null } as typeof facet;
    expect(decodePmQueue(JSON.parse(JSON.stringify(partial)))).toEqual(partial);
    for (const corrupt of [
      (v: any) => { v.projects[0].blockerAge.inventory.factType = {}; },
      (v: any) => { v.projects[0].blockerAge.inventory.supports = []; },
      (v: any) => { v.projects[0].blockerAge.items[0].classification.provenance = "SYSTEM_VERIFIED"; },
      (v: any) => { v.projects[0].blockerAge.items[0].openedAtProof.factType = "unrelated"; },
      (v: any) => { v.projects[0].blockerAge.items[0].openedAt = "2026-02-30"; },
      (v: any) => { v.projects[0].blockerAge.items[0].ageDays = 99; },
      (v: any) => { v.projects[0].blockerAge.items[0].suggestedAction = "Delete the project"; },
      (v: any) => { v.projects[0].blockerAge.asOf = "2026-02-30T00:00:00.000Z"; },
      (v: any) => { v.projects[0].blockerAge.noOpenBlockers = true; },
    ]) {
      const bad = structuredClone(complete); corrupt(bad);
      expect(() => decodePmQueue(bad)).toThrow("Invalid action queue presentation");
    }
  });
  it("binds a leadership view to its explicit project and audience", () => {
    const pm = aged(id(1));
    const leader = { ...pm, audience: "leadership", items: pm.items.map((item) => ({ ...item,
      suggestedAction: "Review the aged blocker and decide whether an intervention is needed." })) };
    expect(decodeBlockerAge(leader, id(1), "leadership")).toEqual(leader);
    expect(() => decodeBlockerAge(leader, id(2), "leadership")).toThrow("Invalid action queue presentation");
    expect(() => decodeBlockerAge(pm, id(1), "leadership")).toThrow("Invalid action queue presentation");
    expect(() => decodeBlockerAge({ ...leader, items: pm.items }, id(1), "leadership")).toThrow("Invalid action queue presentation");
  });
  it("orders distinct priorities and preserves the 101st schedule index", () => {
    const first = observation(1, { update: true }), second = observation(2);
    const schedule = buildScheduleAdviceSnapshot({ asOf, recipient: { subject: "synthetic-pm", audience: "project_manager" },
      snapshot: { projectId: first.projectId, projectRevision: 1, reportedStatus: "GREEN", assessedAt: asOf,
        scheduleHealthPolicy: { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] },
        milestones: Array.from({ length: 50 }, (_, i) => ({ id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          key: `M-${i}`, state: "OPEN", forecastEnd: null, plannedEnd: "2026-01-01" })),
        workItems: Array.from({ length: 50 }, (_, i) => ({ id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          key: `W-${i}`, state: "OPEN", forecastEnd: null, plannedEnd: "2026-01-01" })) } });
    const queue = buildPmActionQueue([{ ...first, schedule }, second]);
    expect(schedule.items).toHaveLength(101);
    expect(queue.items[0]).toMatchObject({ category: "RECONCILIATION", priority: "CRITICAL" });
    expect(queue.items.slice(1, 101).every((item) => item.category === "SCHEDULE_REVIEW" && item.priority === "HIGH")).toBe(true);
    expect(queue.items[101]).toMatchObject({ category: "UPDATE_FOLLOW_UP", priority: "MEDIUM" });
    expect(queue.items[102]).toMatchObject({ category: "EVIDENCE_REVIEW", priority: "LOW" });
    expect(queue.items.some((item) => item.facet === "SCHEDULE" && item.projectId === first.projectId && item.index === 100)).toBe(true);
    expect(decodePmQueue(JSON.parse(JSON.stringify(queue)))).toEqual(queue);
  });
  it("enforces the exact UTF-8 response byte limit without truncation", () => {
    // A synthetic padded, schema-valid observation exercises the byte boundary;
    // production facet readers produce their own fixed rule wording.
    const first = structuredClone(observation(1)) as { schedule: { items: { suggestedAction: string }[] } };
    const baseline = buildPmActionQueue([first]);
    const bytes = new TextEncoder().encode(JSON.stringify(baseline)).byteLength;
    const limit = 2 * 1024 * 1024;
    first.schedule.items[0]!.suggestedAction += "a".repeat(limit - bytes);
    const exact = buildPmActionQueue([first]);
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(limit);
    first.schedule.items[0]!.suggestedAction += "a";
    expect(() => buildPmActionQueue([first])).toThrow("Action queue unavailable");
  });
});
