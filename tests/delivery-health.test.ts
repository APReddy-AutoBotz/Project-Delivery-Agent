import { describe, expect, it } from "vitest";
import {
  assessDeliveryHealth,
  type DeliveryHealthAssessmentInput,
  type DeliveryHealthSignalInput,
} from "../packages/domain/src/delivery-health.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const milestoneId = "20000000-0000-4000-8000-000000000001";
const milestone2Id = "20000000-0000-4000-8000-000000000002";
const blockerId = "30000000-0000-4000-8000-000000000001";
const blocker2Id = "30000000-0000-4000-8000-000000000002";
const calculationRule: DeliveryHealthAssessmentInput["calculationRule"] = {
  key: "DELIVERY-HEALTH-RAG",
  revision: "rag-v1",
  severityBands: {
    red: ["CRITICAL"],
    amber: ["HIGH", "MEDIUM"],
    green: ["LOW"],
  },
};
const contradictionRule = {
  key: "REPORTED-VS-CALCULATED",
  revision: "contradiction-v1",
} as const;
const projectSource = {
  kind: "canonical_record",
  recordType: "PROJECT",
  recordId: projectId,
  revision: 1,
} as const;
const reportedFact = (status: "GREEN" | "AMBER" | "RED" | "UNKNOWN") => ({
  factType: "project.reported_status",
  field: "reportedStatus",
  value: status,
  source: projectSource,
});
const canonicalFact = (
  factType: string,
  field: string,
  value: string | number | boolean | null,
  recordType: "PROJECT" | "MILESTONE" | "WORK_ITEM" | "RAID_ITEM",
  recordId: string,
  revision = 1,
) => ({
  factType,
  field,
  value,
  source: {
    kind: "canonical_record" as const,
    recordType,
    recordId,
    revision,
  },
});
const signal = (
  overrides: Partial<DeliveryHealthSignalInput> = {},
): DeliveryHealthSignalInput =>
  ({
    signalId: "OVERDUE-MILESTONE-1",
    kind: "OVERDUE_MILESTONE",
    targetType: "MILESTONE",
    targetKey: "MS-1",
    targetSource: {
      kind: "canonical_record",
      recordType: "MILESTONE",
      recordId: milestoneId,
      revision: 1,
    },
    state: "ACTIVE",
    severity: "CRITICAL",
    rule: {
      key: "MILESTONE-OVERDUE",
      revision: "milestone-v2",
      parameters: [{ name: "minimumOverdueDays", value: 1 }],
    },
    sourceFacts: [
      canonicalFact(
        "milestone.state",
        "state",
        "OPEN",
        "MILESTONE",
        milestoneId,
      ),
      canonicalFact(
        "milestone.forecast_end",
        "forecastEnd",
        "2026-08-01",
        "MILESTONE",
        milestoneId,
      ),
    ],
    ...overrides,
  }) as DeliveryHealthSignalInput;
const request = (
  overrides: Partial<DeliveryHealthAssessmentInput> = {},
): DeliveryHealthAssessmentInput => {
  const reportedStatus = overrides.reportedStatus ?? "GREEN";
  return {
    projectId: overrides.projectId ?? projectId,
    assessedAt: overrides.assessedAt ?? "2026-09-27T12:00:00.000Z",
    timeZone: overrides.timeZone ?? "Asia/Kolkata",
    sourceSnapshotComplete: overrides.sourceSnapshotComplete ?? true,
    reportedStatus,
    reportedStatusFact:
      overrides.reportedStatusFact ?? reportedFact(reportedStatus),
    calculationRule: overrides.calculationRule ?? calculationRule,
    contradictionRule: overrides.contradictionRule ?? contradictionRule,
    signals: overrides.signals ?? [],
  };
};
describe("UNIT-HLT-004: reported and calculated health separation", () => {
  it("reproduces GOLDEN-002 without replacing reported GREEN", () => {
    const overdueMilestone = signal();
    const criticalBlocker = signal({
      signalId: "CRITICAL-BLOCKER-1",
      kind: "BLOCKER_AGE",
      targetType: "RAID_ITEM",
      targetKey: "RAID-1",
      targetSource: {
        kind: "canonical_record",
        recordType: "RAID_ITEM",
        recordId: blockerId,
        revision: 3,
      },
      rule: {
        key: "BLOCKER-AGE",
        revision: "blocker-v4",
        parameters: [{ name: "minimumBlockerAgeDays", value: 7 }],
      },
      sourceFacts: [
        canonicalFact(
          "blocker.status",
          "state",
          "OPEN",
          "RAID_ITEM",
          blockerId,
          3,
        ),
        canonicalFact(
          "blocker.created_at",
          "createdAt",
          "2026-09-10",
          "RAID_ITEM",
          blockerId,
          3,
        ),
        canonicalFact(
          "blocker.severity",
          "severity",
          "CRITICAL",
          "RAID_ITEM",
          blockerId,
          3,
        ),
      ],
    });
    const staleUpdate = signal({
      signalId: "STALE-UPDATE",
      kind: "UPDATE_FRESHNESS",
      targetType: "PROJECT",
      targetKey: "PROJECT-1",
      targetSource: projectSource,
      severity: "HIGH",
      rule: {
        key: "UPDATE-FRESHNESS",
        revision: "freshness-v3",
        parameters: [{ name: "freshnessWindowSeconds", value: 604800 }],
      },
      sourceFacts: [
        canonicalFact(
          "project.latest_update_at",
          "latestUpdateAt",
          "2026-08-01T12:00:00.000Z",
          "PROJECT",
          projectId,
        ),
      ],
    });
    const result = assessDeliveryHealth(
      request({
        signals: [overdueMilestone, criticalBlocker, staleUpdate],
      }),
    );

    expect(result.reported.status).toBe("GREEN");
    expect(result.reported.sourceFact.value).toBe("GREEN");
    expect(result.calculated.status).toBe("RED");
    expect(result.calculated.rule.revision).toBe("rag-v1");
    expect(result.calculated.rationale.code).toBe("ACTIVE_RED_SIGNALS");
    expect(result.calculated.rationale.signalIds).toEqual([
      "CRITICAL-BLOCKER-1",
      "OVERDUE-MILESTONE-1",
    ]);
    expect(result.calculated.rationale.text).toContain(
      "OVERDUE-MILESTONE-1",
    );
    expect(result.objectiveSignals).toHaveLength(3);
    expect(result.objectiveSignals[0]?.rule.revision).toBe("blocker-v4");
    expect(result.objectiveSignals[0]?.sourceFacts).toContainEqual(
      expect.objectContaining({ value: "2026-09-10" }),
    );
    expect(result.contradiction).toMatchObject({
      kind: "REPORTED_CALCULATED_MISMATCH",
      severity: "CRITICAL",
      rule: contradictionRule,
      reportedStatus: "GREEN",
      calculatedStatus: "RED",
      signalIds: ["CRITICAL-BLOCKER-1", "OVERDUE-MILESTONE-1"],
    });
    expect(result.contradiction?.rationale).toContain(
      "REPORTED-VS-CALCULATED@contradiction-v1",
    );
  });

  it("returns AMBER only for active amber-band signals and keeps matching report separate", () => {
    const result = assessDeliveryHealth(
      request({
        reportedStatus: "AMBER",
        signals: [
          signal({
            signalId: "WARNING-1",
            state: "ACTIVE",
            severity: "MEDIUM",
          }),
        ],
      }),
    );

    expect(result.reported.status).toBe("AMBER");
    expect(result.calculated.status).toBe("AMBER");
    expect(result.contradiction).toBeNull();
  });

  it("calculates GREEN from a complete snapshot with no elevated active signals", () => {
    const result = assessDeliveryHealth(
      request({
        signals: [
          signal({
            signalId: "CLEARED-MILESTONE",
            state: "CLEAR",
            severity: "CRITICAL",
          }),
          signal({
            signalId: "LOW-DELIVERY-NOTE",
            targetKey: "MS-2",
            targetSource: {
              kind: "canonical_record",
              recordType: "MILESTONE",
              recordId: milestone2Id,
              revision: 1,
            },
            state: "ACTIVE",
            severity: "LOW",
            sourceFacts: [
              canonicalFact(
                "milestone.state",
                "state",
                "OPEN",
                "MILESTONE",
                milestone2Id,
              ),
            ],
          }),
        ],
      }),
    );

    expect(result.reported.status).toBe("GREEN");
    expect(result.calculated.status).toBe("GREEN");
    expect(result.calculated.rationale.code).toBe(
      "NO_ELEVATED_ACTIVE_SIGNALS",
    );
    expect(result.contradiction).toBeNull();
  });

  it("returns UNKNOWN instead of green when any required signal is unassessable", () => {
    const result = assessDeliveryHealth(
      request({
        signals: [
          signal({
            signalId: "MISSING-BLOCKER-DATE",
            kind: "BLOCKER_AGE",
            targetType: "RAID_ITEM",
            targetKey: "RAID-2",
            targetSource: {
              kind: "canonical_record",
              recordType: "RAID_ITEM",
              recordId: blockerId,
              revision: 1,
            },
            state: "UNASSESSABLE",
            sourceFacts: [
              canonicalFact(
                "blocker.opened_at",
                "openedAt",
                null,
                "RAID_ITEM",
                blockerId,
              ),
            ],
          }),
        ],
      }),
    );

    expect(result.calculated.status).toBe("UNKNOWN");
    expect(result.calculated.rationale.code).toBe("UNASSESSABLE_SIGNALS");
    expect(result.contradiction).toBeNull();
  });

  it("retains a known RED result when a separate objective input is unassessable", () => {
    const result = assessDeliveryHealth(
      request({
        signals: [
          signal(),
          signal({
            signalId: "MISSING-BLOCKER-DATE",
            kind: "BLOCKER_AGE",
            targetType: "RAID_ITEM",
            targetKey: "RAID-2",
            targetSource: {
              kind: "canonical_record",
              recordType: "RAID_ITEM",
              recordId: blocker2Id,
              revision: 1,
            },
            state: "UNASSESSABLE",
            sourceFacts: [
              canonicalFact(
                "blocker.opened_at",
                "openedAt",
                null,
                "RAID_ITEM",
                blocker2Id,
              ),
            ],
          }),
        ],
      }),
    );

    expect(result.calculated.status).toBe("RED");
    expect(result.calculated.rationale.signalIds).toEqual([
      "OVERDUE-MILESTONE-1",
    ]);
    expect(result.contradiction?.calculatedStatus).toBe("RED");
  });

  it("sorts signal output deterministically and freezes a detached assessment", () => {
    const inputs = [
      signal({ signalId: "SIGNAL-B", severity: "LOW", state: "CLEAR" }),
      signal({
        signalId: "SIGNAL-A",
        targetKey: "MS-2",
        targetSource: {
          kind: "canonical_record",
          recordType: "MILESTONE",
          recordId: milestone2Id,
          revision: 1,
        },
        severity: "LOW",
        state: "CLEAR",
        sourceFacts: [
          canonicalFact(
            "milestone.state",
            "state",
            "COMPLETE",
            "MILESTONE",
            milestone2Id,
          ),
        ],
      }),
    ];
    const result = assessDeliveryHealth(request({ signals: inputs }));
    expect(result.objectiveSignals.map((item) => item.signalId)).toEqual([
      "SIGNAL-A",
      "SIGNAL-B",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.objectiveSignals)).toBe(true);
    expect(Object.isFrozen(result.objectiveSignals[0]?.sourceFacts)).toBe(true);
    inputs[0]!.sourceFacts[0]!.value = "MUTATED";
    expect(result.objectiveSignals[1]?.sourceFacts).toContainEqual(
      expect.objectContaining({ value: "OPEN" }),
    );
  });

  it("rejects incomplete, contradictory, duplicate, and malformed inputs", () => {
    const valid = request({ signals: [signal()] });
    const wrongReportedFact = request({
      reportedStatusFact: reportedFact("RED"),
    });
    const duplicateSignal = request({
      signals: [signal(), signal({ signalId: "OVERDUE-MILESTONE-2" })],
    });
    const incomplete = request({
      sourceSnapshotComplete: false as unknown as true,
    });
    const wrongTarget = request({
      signals: [
        signal({
          kind: "OVERDUE_MILESTONE",
          targetType: "WORK_ITEM",
        }),
      ],
    });
    const overlappingBands = request({
      calculationRule: {
        ...calculationRule,
        severityBands: {
          red: ["CRITICAL", "HIGH"],
          amber: ["HIGH", "MEDIUM"],
          green: ["LOW"],
        },
      },
    });

    for (const value of [
      wrongReportedFact,
      duplicateSignal,
      incomplete,
      wrongTarget,
      overlappingBands,
      { ...valid, timeZone: "Mars/Phobos" },
      { ...valid, assessedAt: "2026-09-27T12:00:00Z" },
    ]) {
      expect(() => assessDeliveryHealth(value)).toThrow(
        "Invalid delivery health assessment input",
      );
    }
  });
});
