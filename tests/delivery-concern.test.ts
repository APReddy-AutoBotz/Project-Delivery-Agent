import { describe, expect, it } from "vitest";
import {
  buildDeliveryConcernAssessment,
  criticalDeliveryTargetsSchema,
  type CriticalBlockerObservation,
  type DeliveryUpdateObservation,
} from "../packages/domain/src/delivery-concern.js";
import { buildScheduleHealthAssessment } from "../packages/domain/src/health-assessment.js";
import { assessDeliveryHealth } from "../packages/domain/src/delivery-health.js";
import { checkHealthAssessmentContentSize } from "../packages/data/src/health-assessment.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const criticalMilestoneId = "20000000-0000-4000-8000-000000000001";
const noncriticalMilestoneId = "20000000-0000-4000-8000-000000000002";
const blockerId = "30000000-0000-4000-8000-000000000001";
const asOf = "2026-11-23T08:00:00.000Z";
const stale: DeliveryUpdateObservation = {
  state: "STALE",
  asOf,
  sourceDate: "2026-11-15T08:00:00.000Z",
  timeZone: "Asia/Kolkata",
  policyRevision: 2,
  freshnessWindowSeconds: 7 * 86400,
  ageMilliseconds: 8 * 86400000,
};
const unavailable: DeliveryUpdateObservation = {
  state: "UNASSESSABLE", asOf, policyRevision: 2,
};
const youngBlocker: CriticalBlockerObservation = {
  id: blockerId,
  key: "RAID-7",
  state: "OPEN",
  status: "ACTIVE",
  openedAt: "2026-11-22",
  ageDays: 1,
  minimumBlockerAgeDays: 10,
  thresholdRevision: 3,
};
const schedule = buildScheduleHealthAssessment({
  projectId,
  projectRevision: 1,
  reportedStatus: "GREEN",
  assessedAt: asOf,
  scheduleHealthPolicy: {
    revision: 4,
    timeZone: "Asia/Kolkata",
    defaultMinimumOverdueDays: 2,
    targetOverrides: [],
  },
  milestones: [
    { id: criticalMilestoneId, key: "MS-7", state: "OPEN", forecastEnd: "2026-11-20", plannedEnd: "2026-11-15" },
    { id: noncriticalMilestoneId, key: "MS-8", state: "OPEN", forecastEnd: "2026-11-17", plannedEnd: null },
  ],
  workItems: [],
});
const build = (overrides: Partial<Parameters<typeof buildDeliveryConcernAssessment>[0]> = {}) =>
  buildDeliveryConcernAssessment({
    schedule: schedule.input,
    criticalTargets: { milestoneIds: [criticalMilestoneId], raidItemIds: [blockerId] },
    policyRevision: 4,
    blockers: [youngBlocker],
    update: stale,
    ...overrides,
  });

describe("STORY-015 composed delivery concern", () => {
  it("keeps the schedule and reported status separate and reproduces the composed result", () => {
    const { input, result } = build();
    expect(schedule.result.reported.status).toBe("GREEN");
    expect(schedule.result.calculated.rule.key).toBe("schedule-health");
    expect(result.reported.status).toBe("GREEN");
    expect(result.calculated).toMatchObject({
      status: "RED",
      rule: { key: "delivery-concern", revision: "1" },
    });
    expect(result.recommendation).toBe("PM_REVIEW");
    expect(result.objectiveSignals.map((signal) => [signal.kind, signal.state])).toEqual([
      ["CRITICAL_BLOCKER", "ACTIVE"],
      ["UPDATE_FRESHNESS", "ACTIVE"],
      ["OVERDUE_MILESTONE", "ACTIVE"],
    ]);
    expect(result.objectiveSignals[0]?.rule.parameters).toContainEqual({ name: "ageDays", value: 1 });
    expect(result.objectiveSignals[1]?.rule.parameters).toContainEqual(
      { name: "latestValidUpdateAt", value: stale.sourceDate },
    );
    expect(result.objectiveSignals[2]?.sourceFacts).toContainEqual(
      expect.objectContaining({ field: "selectedDueDate", value: "2026-11-20" }),
    );
    expect({ ...assessDeliveryHealth(input), recommendation: "PM_REVIEW" }).toEqual(result);
  });

  it("keeps independently known Red when update evidence is unassessable", () => {
    const { result } = build({ update: unavailable });
    expect(result.calculated.status).toBe("RED");
    expect(result.objectiveSignals.find((signal) => signal.kind === "UPDATE_FRESHNESS")?.state)
      .toBe("UNASSESSABLE");
  });

  it("uses stale update as Amber when the distinct critical targets are clear", () => {
    const { result } = build({
      criticalTargets: { milestoneIds: [], raidItemIds: [blockerId] },
      blockers: [{ id: blockerId, key: "RAID-7", state: "COMPLETE", status: "CLEAR" }],
    });
    expect(result.calculated.status).toBe("AMBER");
    expect(result.recommendation).toBe("PM_REVIEW");
  });

  it("does not present stale Amber or Green if a configured blocker is unassessable", () => {
    const { result } = build({
      criticalTargets: { milestoneIds: [], raidItemIds: [blockerId] },
      blockers: [{ id: blockerId, key: "RAID-7", state: "OPEN", status: "UNASSESSABLE" }],
    });
    expect(result.calculated.status).toBe("UNKNOWN");
    expect(result.recommendation).toBeNull();
  });

  it("won't replace an unavailable update with project creation or an absent critical target", () => {
    const criticalTargets = { milestoneIds: [], raidItemIds: [] };
    expect(build({ criticalTargets, blockers: [], update: unavailable }).result.calculated.status)
      .toBe("UNKNOWN");
    expect(() => build({ blockers: [] })).toThrow("Missing or unexpected configured critical target");
    expect(() => build({ update: { ...unavailable, asOf: "2026-11-24T08:00:00.000Z" } }))
      .toThrow("different assessment instants");
  });

  it("rejects duplicate classifications, over-limit selections and unvalidated IDs", () => {
    for (const raidItemIds of [
      [blockerId, blockerId],
      [...Array.from({ length: 51 }, (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`)],
      ["RAID-7"],
    ]) {
      expect(criticalDeliveryTargetsSchema.safeParse({ milestoneIds: [], raidItemIds }).success).toBe(false);
    }
  });

  it("only allows the legacy fallback above the exact UTF-8 envelope limit", () => {
    const exact = "é".repeat(224 * 1024);
    expect(checkHealthAssessmentContentSize(exact, exact, false)).toBe(true);
    expect(checkHealthAssessmentContentSize(exact + "a", exact, true)).toBe(false);
    expect(() => checkHealthAssessmentContentSize(exact, exact + "a", false)).toThrow("UNAVAILABLE");
  });
});
