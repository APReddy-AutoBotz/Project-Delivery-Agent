import { describe, expect, it } from "vitest";
import {
  buildScheduleHealthAssessment,
  healthAssessmentRetentionPolicySchema,
  type ScheduleHealthSnapshot,
} from "../packages/domain/src/health-assessment.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const snapshot = (
  overrides: Partial<ScheduleHealthSnapshot> = {},
): ScheduleHealthSnapshot => ({
  projectId,
  projectRevision: 1,
  reportedStatus: "GREEN",
  assessedAt: "2026-09-27T00:00:00.000Z",
  milestones: [],
  workItems: [],
  ...overrides,
});
const item = (
  id: string,
  key: string,
  state: "OPEN" | "IN_PROGRESS" | "COMPLETE" | "CANCELLED",
  forecastEnd: string | null,
  plannedEnd: string | null,
) => ({ id, key, state, forecastEnd, plannedEnd });

describe("schedule-health@2", () => {
  it("uses forecastEnd before plannedEnd and marks one UTC day overdue as high/red", () => {
    const assessed = buildScheduleHealthAssessment(
      snapshot({
        milestones: [
          item(
            "20000000-0000-4000-8000-000000000001",
            "MS-1",
            "OPEN",
            "2026-09-26",
            "2026-09-28",
          ),
        ],
        workItems: [
          item(
            "30000000-0000-4000-8000-000000000001",
            "WI-1",
            "IN_PROGRESS",
            null,
            "2026-09-27",
          ),
        ],
      }),
    );
    expect(assessed.coverage).toBe("SCHEDULE_ONLY");
    expect(assessed.result.reported.status).toBe("GREEN");
    expect(assessed.result.calculated.status).toBe("RED");
    expect(assessed.result.calculated.rule.revision).toBe("2");
    expect(assessed.result.objectiveSignals.map((signal) => signal.state)).toEqual([
      "ACTIVE",
      "CLEAR",
    ]);
    expect(assessed.result.objectiveSignals[0]?.sourceFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "forecastEnd", value: "2026-09-26" }),
        expect.objectContaining({ field: "plannedEnd", value: "2026-09-28" }),
        expect.objectContaining({ field: "selectedDueDate", value: "2026-09-26" }),
      ]),
    );
    expect(assessed.result.contradiction?.calculatedStatus).toBe("RED");
  });

  it("clears completed and cancelled items even when their dates are absent", () => {
    const assessed = buildScheduleHealthAssessment(
      snapshot({
        milestones: [
          item(
            "20000000-0000-4000-8000-000000000001",
            "MS-DONE",
            "COMPLETE",
            null,
            null,
          ),
          item(
            "20000000-0000-4000-8000-000000000002",
            "MS-CANCELLED",
            "CANCELLED",
            null,
            null,
          ),
        ],
      }),
    );
    expect(assessed.result.calculated.status).toBe("GREEN");
    expect(assessed.result.objectiveSignals.map((signal) => signal.state)).toEqual([
      "CLEAR",
      "CLEAR",
    ]);
  });

  it("marks open records without a due date unassessable and never reports false green", () => {
    const assessed = buildScheduleHealthAssessment(
      snapshot({
        workItems: [
          item(
            "30000000-0000-4000-8000-000000000001",
            "WI-MISSING",
            "OPEN",
            null,
            null,
          ),
        ],
      }),
    );
    expect(assessed.result.calculated.status).toBe("UNKNOWN");
    expect(assessed.result.objectiveSignals[0]?.state).toBe("UNASSESSABLE");
  });

  it("adds an unassessable coverage signal when the project has no schedule targets", () => {
    const assessed = buildScheduleHealthAssessment(snapshot());
    expect(assessed.result.calculated.status).toBe("UNKNOWN");
    expect(assessed.result.objectiveSignals).toHaveLength(1);
    expect(assessed.result.objectiveSignals[0]).toMatchObject({
      kind: "SCHEDULE_COVERAGE",
      state: "UNASSESSABLE",
    });
  });

  it("preserves known red evidence beside missing schedule dates", () => {
    const assessed = buildScheduleHealthAssessment(
      snapshot({
        milestones: [
          item(
            "20000000-0000-4000-8000-000000000001",
            "MS-LATE",
            "OPEN",
            "2026-09-26",
            null,
          ),
        ],
        workItems: [
          item(
            "30000000-0000-4000-8000-000000000001",
            "WI-MISSING",
            "OPEN",
            null,
            null,
          ),
        ],
      }),
    );
    expect(assessed.result.calculated.status).toBe("RED");
    expect(assessed.result.objectiveSignals.map((signal) => signal.state)).toContain(
      "UNASSESSABLE",
    );
  });


  it("applies the saved timezone and threshold revision at the local midnight boundary", () => {
    const policy = {
      revision: 7,
      timeZone: "America/Los_Angeles",
      defaultMinimumOverdueDays: 1,
      targetOverrides: [
        {
          targetType: "MILESTONE" as const,
          targetKey: "MS-BOUNDARY",
          minimumOverdueDays: 3,
        },
      ],
    };
    const records = {
      milestones: [
        item(
          "20000000-0000-4000-8000-000000000007",
          "MS-BOUNDARY",
          "OPEN",
          "2026-09-26",
          "2026-09-20",
        ),
      ],
      workItems: [
        item(
          "30000000-0000-4000-8000-000000000007",
          "WI-DEFAULT",
          "IN_PROGRESS",
          "2026-09-26",
          null,
        ),
      ],
    };
    const beforeMidnight = buildScheduleHealthAssessment(
      snapshot({
        assessedAt: "2026-09-29T06:59:59.999Z",
        scheduleHealthPolicy: policy,
        ...records,
      }),
    );
    const atMidnight = buildScheduleHealthAssessment(
      snapshot({
        assessedAt: "2026-09-29T07:00:00.000Z",
        scheduleHealthPolicy: policy,
        ...records,
      }),
    );
    const findSignal = (assessment: typeof atMidnight, key: string) =>
      assessment.result.objectiveSignals.find((signal) => signal.targetKey === key)!;
    expect(findSignal(beforeMidnight, "MS-BOUNDARY").state).toBe("CLEAR");
    expect(findSignal(atMidnight, "MS-BOUNDARY").state).toBe("ACTIVE");
    expect(findSignal(beforeMidnight, "MS-BOUNDARY").rule.parameters).toContainEqual({
      name: "daysOverdue",
      value: 2,
    });
    expect(findSignal(atMidnight, "MS-BOUNDARY").rule.parameters).toContainEqual({
      name: "daysOverdue",
      value: 3,
    });
    expect(findSignal(atMidnight, "MS-BOUNDARY").rule.parameters).toEqual(
      expect.arrayContaining([
        { name: "assessedLocalDate", value: "2026-09-29" },
        { name: "minimumOverdueDays", value: 3 },
        { name: "scheduleHealthPolicyRevision", value: 7 },
        { name: "timeZone", value: "America/Los_Angeles" },
      ]),
    );
    expect(findSignal(atMidnight, "MS-BOUNDARY").sourceFacts).toEqual(
      expect.arrayContaining([
        { factType: "milestone.selected_due_date", field: "selectedDueDate", value: "2026-09-26", source: expect.any(Object) },
        { factType: "milestone.selected_due_date_field", field: "selectedDateField", value: "forecastEnd", source: expect.any(Object) },
      ]),
    );
    expect(findSignal(beforeMidnight, "WI-DEFAULT").state).toBe("ACTIVE");
    expect(atMidnight.scheduleHealthPolicy).toEqual(policy);
  });

  it("rejects retention settings that violate the ordered windows", () => {
    expect(
      healthAssessmentRetentionPolicySchema.safeParse({
        contentRetentionHours: 48,
        auditRetentionHours: 24,
        idempotencyRetentionHours: 168,
      }).success,
    ).toBe(false);
    expect(
      healthAssessmentRetentionPolicySchema.parse({
        contentRetentionHours: 24,
        auditRetentionHours: 168,
        idempotencyRetentionHours: 720,
      }),
    ).toEqual({
      contentRetentionHours: 24,
      auditRetentionHours: 168,
      idempotencyRetentionHours: 720,
    });
  });
});
