import { describe, expect, it } from "vitest";
import {
  assessUpdateFreshness,
  selectProjectUpdateTimestamp,
  type FreshnessAssessmentInput,
} from "../packages/domain/src/index.js";

const request = (
  overrides: Partial<FreshnessAssessmentInput> = {},
): FreshnessAssessmentInput => ({
  asOf: "2026-06-02T00:00:00.000Z",
  timeZone: "Asia/Kolkata",
  timeZoneSource: "PROJECT",
  project: {
    id: "10000000-0000-4000-8000-000000000001",
    code: "ENG-1",
    name: "Example project",
    createdAt: "2026-05-01T00:00:00.000Z",
    latestValidUpdateAt: "2026-06-01T00:00:00.000Z",
  },
  policy: {
    key: "weekly-status",
    revision: "freshness-v1",
    freshnessWindowSeconds: 86400,
    responsibleSubject: "owner@example.invalid",
    obligationDueAt: "2026-06-03T00:00:00.000Z",
    requiredFacts: [
      { factType: "project.forecast_end", label: "Forecast finish" },
      { factType: "project.status", label: "Current status" },
    ],
  },
  ...overrides,
});

describe("UNIT-HLT-001: update freshness and obligation descriptors", () => {
  it("stays current at the exact freshness boundary and becomes stale after it", () => {
    const boundary = assessUpdateFreshness(request());
    expect(boundary.freshness).toMatchObject({
      state: "CURRENT",
      sourceDateField: "project.latestValidUpdateAt",
      sourceDate: "2026-06-01T00:00:00.000Z",
      ageMilliseconds: 86400000,
      freshnessWindowSeconds: 86400,
      exceededByMilliseconds: 0,
      policyKey: "weekly-status",
      ruleRevision: "freshness-v1",
      timeZone: "Asia/Kolkata",
      timeZoneSource: "PROJECT",
    });
    expect(boundary.obligation).toBeNull();

    const stale = assessUpdateFreshness(
      request({ asOf: "2026-06-02T00:00:00.001Z" }),
    );
    expect(stale.freshness).toMatchObject({
      state: "STALE",
      ageMilliseconds: 86400001,
      exceededByMilliseconds: 1,
    });
    expect(stale.obligation).toMatchObject({
      kind: "PROJECT_UPDATE",
      reason: "UPDATE_OUTSIDE_FRESHNESS_WINDOW",
      responsibleSubject: "owner@example.invalid",
      dueAt: "2026-06-03T00:00:00.000Z",
      timeZone: "Asia/Kolkata",
      timeZoneSource: "PROJECT",
      requiredFacts: [
        { factType: "project.forecast_end", label: "Forecast finish" },
        { factType: "project.status", label: "Current status" },
      ],
    });
  });

  it("accepts a trusted source update earlier than canonical row creation", () => {
    const result = assessUpdateFreshness(
      request({
        asOf: "2026-06-02T00:00:00.000Z",
        project: {
          ...request().project,
          createdAt: "2026-06-01T00:00:00.000Z",
          latestValidUpdateAt: "2026-05-30T00:00:00.000Z",
        },
      }),
    );
    expect(result.freshness).toMatchObject({
      state: "STALE",
      sourceDateField: "project.latestValidUpdateAt",
      sourceDate: "2026-05-30T00:00:00.000Z",
      ageMilliseconds: 259200000,
    });
    expect(result.obligation).toMatchObject({
      reason: "UPDATE_OUTSIDE_FRESHNESS_WINDOW",
      freshness: { sourceDate: "2026-05-30T00:00:00.000Z" },
    });
  });

  it("keeps a delayed connector update stale when policy selects its validated effective time", () => {
    const asOf = new Date("2026-06-10T00:00:00.000Z");
    const selected = selectProjectUpdateTimestamp({
      sourceType: "jira_connector",
      selectedBasis: "effectiveAt",
      observedAt: new Date("2026-06-10T00:00:00.000Z"),
      effectiveAt: new Date("2026-06-01T00:00:00.000Z"),
      effectiveAtValidated: true,
      asOf,
    });
    expect(selected).toEqual({
      timestampBasis: "CONNECTOR_EFFECTIVE_AT",
      timestamp: new Date("2026-06-01T00:00:00.000Z"),
    });

    const result = assessUpdateFreshness(request({
      asOf: asOf.toISOString(),
      project: {
        ...request().project,
        createdAt: "2026-06-05T00:00:00.000Z",
        latestValidUpdateAt: selected.timestamp!.toISOString(),
      },
      policy: {
        ...request().policy,
        freshnessWindowSeconds: 86400,
        obligationDueAt: "2026-06-02T00:00:00.000Z",
      },
    }));
    expect(result.freshness).toMatchObject({
      state: "STALE",
      sourceDateField: "project.latestValidUpdateAt",
      sourceDate: "2026-06-01T00:00:00.000Z",
    });
    expect(result.obligation?.dueAt).toBe("2026-06-02T00:00:00.000Z");
  });

  it("does not fall back to observation time for an unvalidated or future effective time", () => {
    const base = {
      sourceType: "jira_connector",
      selectedBasis: "effectiveAt",
      observedAt: new Date("2026-06-10T00:00:00.000Z"),
      effectiveAt: new Date("2026-06-01T00:00:00.000Z"),
      effectiveAtValidated: false,
      asOf: new Date("2026-06-10T00:00:00.000Z"),
    };
    expect(selectProjectUpdateTimestamp(base)).toEqual({
      timestampBasis: "UNCONFIRMED",
      timestamp: null,
    });
    expect(selectProjectUpdateTimestamp({
      ...base,
      effectiveAtValidated: true,
      effectiveAt: new Date("2026-06-11T00:00:00.000Z"),
    })).toEqual({
      timestampBasis: "UNCONFIRMED",
      timestamp: null,
    });
  });

  it("always uses server observation time for human statements", () => {
    const selected = selectProjectUpdateTimestamp({
      sourceType: "human_statement",
      selectedBasis: "effectiveAt",
      observedAt: new Date("2026-06-09T00:00:00.000Z"),
      effectiveAt: new Date("2026-05-01T00:00:00.000Z"),
      effectiveAtValidated: true,
      asOf: new Date("2026-06-10T00:00:00.000Z"),
    });
    expect(selected).toEqual({
      timestampBasis: "HUMAN_OBSERVED_AT",
      timestamp: new Date("2026-06-09T00:00:00.000Z"),
    });
  });

  it("uses project creation as the source date when no valid update exists", () => {
    const result = assessUpdateFreshness(
      request({
        asOf: "2026-06-02T00:00:00.001Z",
        project: {
          ...request().project,
          createdAt: "2026-06-01T00:00:00.000Z",
          latestValidUpdateAt: null,
        },
      }),
    );
    expect(result.freshness).toMatchObject({
      state: "STALE",
      sourceDateField: "project.createdAt",
      sourceDate: "2026-06-01T00:00:00.000Z",
      ageMilliseconds: 86400001,
    });
    expect(result.obligation).toMatchObject({
      reason: "NO_VALID_UPDATE",
      freshness: {
        sourceDateField: "project.createdAt",
        sourceDate: "2026-06-01T00:00:00.000Z",
      },
    });
  });

  it("keeps the obligation deduplication key stable across repeated stale assessments", () => {
    const first = assessUpdateFreshness(
      request({ asOf: "2026-06-03T00:00:00.000Z" }),
    );
    const later = assessUpdateFreshness(
      request({ asOf: "2026-06-04T12:00:00.000Z" }),
    );
    expect(first.obligation?.deduplicationKey).toBe(
      later.obligation?.deduplicationKey,
    );
    expect(first).toEqual(
      assessUpdateFreshness(request({ asOf: "2026-06-03T00:00:00.000Z" })),
    );
  });

  it("sorts requirements, freezes the result, and detaches it from caller input", () => {
    const input = request({
      asOf: "2026-06-03T00:00:00.000Z",
      policy: {
        ...request().policy,
        requiredFacts: [
          { factType: "project.status", label: "Current status" },
          { factType: "project.forecast_end", label: "Forecast finish" },
        ],
      },
    });
    const result = assessUpdateFreshness(input);
    expect(result.obligation?.requiredFacts.map((fact) => fact.factType)).toEqual([
      "project.forecast_end",
      "project.status",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.obligation)).toBe(true);
    expect(Object.isFrozen(result.obligation?.requiredFacts)).toBe(true);
    input.policy.requiredFacts[0]!.label = "Changed";
    expect(result.obligation?.requiredFacts[1]?.label).toBe("Current status");
  });

  it("rejects invalid zones, future source dates, duplicate facts, bad windows, and malformed instants", () => {
    const invalidInputs: unknown[] = [
      request({ timeZone: "Mars/Phobos" }),
      request({
        project: {
          ...request().project,
          latestValidUpdateAt: "2026-06-03T00:00:00.000Z",
        },
      }),
      request({
        policy: {
          ...request().policy,
          freshnessWindowSeconds: 0,
        },
      }),
      request({
        policy: {
          ...request().policy,
          requiredFacts: [
            { factType: "project.status", label: "Status" },
            { factType: "project.status", label: "Current status" },
          ],
        },
      }),
      request({ asOf: "0000-06-02T00:00:00.000Z" }),
      request({ asOf: "2026-06-02T00:00:00Z" }),
    ];
    for (const input of invalidInputs)
      expect(() => assessUpdateFreshness(input)).toThrow(
        "Invalid freshness assessment input",
      );
  });
});
