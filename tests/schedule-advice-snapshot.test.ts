import { describe, expect, it } from "vitest";
import {
  buildDeliveryAdviceQueue,
  buildScheduleAdviceSnapshot,
  scheduleAdviceSnapshotSchema,
} from "../packages/domain/src/delivery-advice.js";
import { buildScheduleHealthAssessment } from "../packages/domain/src/health-assessment.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const asOf = "2026-10-21T11:00:00.000Z";
const recipient = { subject: "synthetic-pm", audience: "project_manager" as const };
const snapshot = () => ({
  projectId,
  projectRevision: 2,
  reportedStatus: "GREEN" as const,
  assessedAt: asOf,
  scheduleHealthPolicy: {
    revision: 1,
    timeZone: "UTC",
    defaultMinimumOverdueDays: 1,
    targetOverrides: [],
  },
  milestones: [{
    id: "20000000-0000-4000-8000-000000000001",
    key: "MILESTONE-1",
    state: "OPEN" as const,
    forecastEnd: "2026-10-18",
    plannedEnd: "2026-10-17",
  }],
  workItems: [],
});

describe("EXEC-022 schedule advice as-of snapshot", () => {
  it("preserves queue wording, evidence and ranking without inventing an expiry", () => {
    const source = snapshot();
    const result = buildScheduleAdviceSnapshot({ asOf, recipient, snapshot: source });
    const bounded = buildDeliveryAdviceQueue({
      asOf,
      recipient,
      readableProjectIds: [projectId],
      assignedProjectIds: [projectId],
      projects: [{
        projectId,
        validUntil: "2026-10-22T11:00:00.000Z",
        healthAssessmentInput: buildScheduleHealthAssessment(source).input,
        pendingApprovals: [],
      }],
    });
    const withoutExpiry = bounded.items.map(({ validUntil: _expiry, recipient: _recipient, ...item }) => item);
    expect(result.items).toEqual(withoutExpiry);
    expect(result).toMatchObject({
      asOf,
      coverage: "SCHEDULE_ONLY",
      sourceAuthority: "NOT_ASSESSED",
      approvalItems: "UNAVAILABLE",
    });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => !("validUntil" in item))).toBe(true);
    expect(Object.isFrozen(result.items[0]!.trigger)).toBe(true);
    expect(source.milestones[0]!.forecastEnd).toBe("2026-10-18");
  });

  it("rejects a mismatched clock and extra generic signal or approval input", () => {
    expect(() => buildScheduleAdviceSnapshot({
      asOf: "2026-10-21T11:00:01.000Z", recipient, snapshot: snapshot(),
    })).toThrow("Invalid delivery advice input");
    expect(() => buildScheduleAdviceSnapshot({
      asOf, recipient, snapshot: { ...snapshot(), signals: [] },
    })).toThrow("Invalid delivery advice input");
    expect(() => buildScheduleAdviceSnapshot({
      asOf, recipient, snapshot: snapshot(), pendingApprovals: [],
    })).toThrow("Invalid delivery advice input");
  });

  it("returns a coverage warning when no schedule targets exist", () => {
    const result = buildScheduleAdviceSnapshot({
      asOf, recipient, snapshot: { ...snapshot(), milestones: [] },
    });
    expect(result.items.some((item) =>
      item.trigger.kind === "DELIVERY_SIGNAL" &&
      item.trigger.signal.kind === "SCHEDULE_COVERAGE" &&
      item.category === "EVIDENCE_REVIEW",
    )).toBe(true);
  });

  it("detaches and freezes evidence without freezing caller-owned input", () => {
    const source = snapshot();
    const result = buildScheduleAdviceSnapshot({ asOf, recipient, snapshot: source });
    const before = JSON.stringify(result);
    expect(Object.isFrozen(source.milestones[0])).toBe(false);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0]!.trigger)).toBe(true);
    source.milestones[0]!.forecastEnd = "2026-10-20";
    expect(JSON.stringify(result)).toBe(before);
  });

  it("keeps deterministic order under source permutation for leadership", () => {
    const source = snapshot();
    source.milestones.push({
      id: "20000000-0000-4000-8000-000000000002",
      key: "MILESTONE-2",
      state: "OPEN",
      forecastEnd: "2026-10-19",
      plannedEnd: "2026-10-18",
    });
    const leader = { subject: "synthetic-leader", audience: "leadership" as const };
    const first = buildScheduleAdviceSnapshot({ asOf, recipient: leader, snapshot: source });
    source.milestones.reverse();
    const second = buildScheduleAdviceSnapshot({ asOf, recipient: leader, snapshot: source });
    expect(second).toEqual(first);
  });

  it("rejects response items with a different project, clock or category", () => {
    const result = buildScheduleAdviceSnapshot({ asOf, recipient, snapshot: snapshot() });
    const changedProject = structuredClone(result) as { projectId: string };
    changedProject.projectId = "10000000-0000-4000-8000-000000000002";
    expect(scheduleAdviceSnapshotSchema.safeParse(changedProject).success).toBe(false);
    const changedClock = structuredClone(result) as { asOf: string };
    changedClock.asOf = "2026-10-21T11:00:01.000Z";
    expect(scheduleAdviceSnapshotSchema.safeParse(changedClock).success).toBe(false);
    const changedCategory = structuredClone(result) as { items: { category: string }[] };
    changedCategory.items[0]!.category = "INTERVENTION";
    expect(scheduleAdviceSnapshotSchema.safeParse(changedCategory).success).toBe(false);
  });
});
