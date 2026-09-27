import { describe, expect, it } from "vitest";
import {
  assessProjectCompleteness,
  type CompletenessAssessmentInput,
} from "../packages/domain/src/index.js";

const requiredFacts = [
  { factType: "project.status", label: "Current project status" },
  { factType: "project.forecast_end", label: "Forecast finish" },
];
const request = (
  overrides: Partial<CompletenessAssessmentInput> = {},
): CompletenessAssessmentInput => ({
  assessedAt: "2026-09-27T00:00:00.000Z",
  projectId: "10000000-0000-4000-8000-000000000001",
  ruleKey: "delivery-completeness",
  ruleRevision: "completeness-v1",
  requiredFactsComplete: true,
  requiredFacts,
  factAssessments: [
    {
      factType: "project.status",
      canonicalVersionCount: 1,
      sourceAuthorityStatus: "RESOLVED",
      conflict: "NONE",
    },
    {
      factType: "project.forecast_end",
      canonicalVersionCount: 1,
      sourceAuthorityStatus: "RESOLVED",
      conflict: "NONE",
    },
  ],
  ...overrides,
});

describe("UNIT-HLT-002: required project fact completeness", () => {
  it("reports complete only when every configured fact has resolved authority", () => {
    const result = assessProjectCompleteness(request());
    expect(result).toMatchObject({
      state: "COMPLETE",
      complete: true,
      requiredCount: 2,
      confirmedCount: 2,
      confirmedFactTypes: ["project.forecast_end", "project.status"],
      missing: [],
      unconfirmed: [],
      ruleKey: "delivery-completeness",
      ruleRevision: "completeness-v1",
      assessedAt: "2026-09-27T00:00:00.000Z",
    });
    expect(result.factAssessments.map((fact) => fact.state)).toEqual([
      "CONFIRMED",
      "CONFIRMED",
    ]);
  });

  it("lists a field as missing only when the complete canonical read has no versions", () => {
    const result = assessProjectCompleteness(
      request({
        factAssessments: [
          {
            factType: "project.status",
            canonicalVersionCount: 1,
            sourceAuthorityStatus: "RESOLVED",
            conflict: "NONE",
          },
          {
            factType: "project.forecast_end",
            canonicalVersionCount: 0,
            sourceAuthorityStatus: "UNKNOWN",
            conflict: "NONE",
          },
        ],
      }),
    );
    expect(result.state).toBe("INCOMPLETE");
    expect(result.missing).toMatchObject([
      {
        factType: "project.forecast_end",
        label: "Forecast finish",
        state: "MISSING",
        reasonCodes: ["NO_CANONICAL_VALUE"],
      },
    ]);
    expect(result.confirmedFactTypes).toEqual(["project.status"]);
  });

  it("does not treat a proposal-only or unauthorized value as a canonical fact", () => {
    const result = assessProjectCompleteness(
      request({
        factAssessments: [
          {
            factType: "project.status",
            canonicalVersionCount: 1,
            sourceAuthorityStatus: "RESOLVED",
            conflict: "NONE",
          },
          {
            factType: "project.forecast_end",
            canonicalVersionCount: 0,
            sourceAuthorityStatus: "NO_POLICY",
            conflict: "NONE",
          },
        ],
      }),
    );
    expect(result.missing.map((fact) => fact.factType)).toEqual([
      "project.forecast_end",
    ]);
    expect(result.factAssessments[0]).not.toHaveProperty("value");
    expect(result.factAssessments[1]).not.toHaveProperty("value");
  });

  it("lists existing fields with unresolved source authority as unconfirmed", () => {
    const result = assessProjectCompleteness(
      request({
        factAssessments: [
          {
            factType: "project.status",
            canonicalVersionCount: 1,
            sourceAuthorityStatus: "RESOLVED",
            conflict: "NONE",
          },
          {
            factType: "project.forecast_end",
            canonicalVersionCount: 2,
            sourceAuthorityStatus: "UNKNOWN",
            conflict: "NONE",
          },
        ],
      }),
    );
    expect(result.missing).toEqual([]);
    expect(result.unconfirmed).toMatchObject([
      {
        factType: "project.forecast_end",
        state: "UNCONFIRMED",
        canonicalVersionCount: 2,
        sourceAuthorityStatus: "UNKNOWN",
        reasonCodes: ["NO_CURRENT_AUTHORIZED_VALUE"],
      },
    ]);
  });

  it("reports ambiguity, conflict, incomplete authority, and revalidation as unconfirmed", () => {
    const facts = [
      { factType: "project.status", label: "Current project status" },
      { factType: "project.forecast_end", label: "Forecast finish" },
      { factType: "project.owner", label: "Project owner" },
      { factType: "project.budget", label: "Approved budget" },
    ];
    const result = assessProjectCompleteness(
      request({
        requiredFacts: facts,
        factAssessments: [
          {
            factType: "project.status",
            canonicalVersionCount: 1,
            sourceAuthorityStatus: "RESOLVED",
            conflict: "NONE",
          },
          {
            factType: "project.forecast_end",
            canonicalVersionCount: 2,
            sourceAuthorityStatus: "AMBIGUOUS",
            conflict: "NONE",
          },
          {
            factType: "project.owner",
            canonicalVersionCount: 2,
            sourceAuthorityStatus: "CONFLICTING",
            conflict: "CONFLICTING",
          },
          {
            factType: "project.budget",
            canonicalVersionCount: 0,
            sourceAuthorityStatus: "REVALIDATION_REQUIRED",
            conflict: "NONE",
          },
        ],
      }),
    );
    expect(result.unconfirmed).toMatchObject([
      {
        factType: "project.budget",
        reasonCodes: ["SOURCE_REVALIDATION_REQUIRED"],
      },
      {
        factType: "project.forecast_end",
        reasonCodes: ["AMBIGUOUS_AUTHORITY"],
      },
      {
        factType: "project.owner",
        reasonCodes: ["CONFLICTING_AUTHORITY"],
      },
    ]);
    expect(result.missing).toEqual([]);
  });

  it("sorts and freezes outputs, detaches caller data, and requires exact assessment coverage", () => {
    const input = request({
      requiredFacts: [
        { factType: "project.status", label: "Current project status" },
        { factType: "project.forecast_end", label: "Forecast finish" },
      ],
      factAssessments: [
        {
          factType: "project.forecast_end",
          canonicalVersionCount: 0,
          sourceAuthorityStatus: "UNKNOWN",
          conflict: "NONE",
        },
        {
          factType: "project.status",
          canonicalVersionCount: 1,
          sourceAuthorityStatus: "RESOLVED",
          conflict: "NONE",
        },
      ],
    });
    const result = assessProjectCompleteness(input);
    expect(result.factAssessments.map((fact) => fact.factType)).toEqual([
      "project.forecast_end",
      "project.status",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.factAssessments)).toBe(true);
    expect(Object.isFrozen(result.missing)).toBe(true);
    input.requiredFacts[0]!.label = "Changed";
    expect(result.factAssessments[1]?.label).toBe("Current project status");
    expect(() =>
      assessProjectCompleteness(
        request({ factAssessments: request().factAssessments.slice(1) }),
      ),
    ).toThrow("Invalid completeness assessment input");
    expect(() =>
      assessProjectCompleteness(
        request({
          factAssessments: [
            ...request().factAssessments,
            request().factAssessments[0]!,
          ],
        }),
      ),
    ).toThrow("Invalid completeness assessment input");
  });

  it("rejects partial rules, duplicate fact types, inconsistent resolutions and malformed inputs", () => {
    const incomplete = { ...request(), requiredFactsComplete: false };
    const duplicateRequirements = request({
      requiredFacts: [
        ...requiredFacts,
        { factType: "project.status", label: "Duplicate status" },
      ],
    });
    const duplicateAssessments = request({
      factAssessments: [
        ...request().factAssessments,
        request().factAssessments[0]!,
      ],
    });
    const inconsistent = request({
      factAssessments: [
        {
          factType: "project.status",
          canonicalVersionCount: 0,
          sourceAuthorityStatus: "RESOLVED",
          conflict: "NONE",
        },
        request().factAssessments[1]!,
      ],
    });
    const malformed = request({ assessedAt: "0000-09-27T00:00:00.000Z" });
    const emptyRules = request({ requiredFacts: [] });
    for (const input of [
      incomplete,
      duplicateRequirements,
      duplicateAssessments,
      inconsistent,
      malformed,
      emptyRules,
    ]) {
      expect(() => assessProjectCompleteness(input)).toThrow(
        "Invalid completeness assessment input",
      );
    }
  });
});
