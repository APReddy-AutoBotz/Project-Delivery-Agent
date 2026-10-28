import { describe, expect, it } from "vitest";
import { assessProjectCompleteness } from "../packages/domain/src/completeness-signals.js";
import { assessUpdateFreshness } from "../packages/domain/src/freshness-signals.js";
import { buildUpdateAdviceSnapshot, updateAdviceSnapshotSchema } from "../packages/domain/src/update-advice.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const asOf = "2026-10-21T11:00:00.000Z";
function observation(options: { age: number; missing?: boolean; conflict?: boolean; audience?: "project_manager" | "leadership" }) {
  const requiredFacts = [{ factType: "delivery.status", label: "Delivery status" }];
  const sourceDate = new Date(Date.parse(asOf) - options.age * 1000).toISOString();
  const completeness = assessProjectCompleteness({
    assessedAt: asOf, projectId, ruleKey: "project-update", ruleRevision: "2", requiredFactsComplete: true, requiredFacts,
    factAssessments: [{ factType: "delivery.status", canonicalVersionCount: options.missing ? 0 : 1,
      sourceAuthorityStatus: options.missing ? "UNKNOWN" : options.conflict ? "CONFLICTING" : "RESOLVED",
      conflict: options.conflict ? "CONFLICTING" : "NONE" }],
  });
  const freshness = assessUpdateFreshness({
    asOf, timeZone: "UTC", timeZoneSource: "PROJECT",
    project: { id: projectId, code: "P-1", name: "Synthetic", createdAt: sourceDate,
      latestValidUpdateAt: options.missing || options.conflict ? null : sourceDate },
    policy: { key: "project-update", revision: "2", freshnessWindowSeconds: 60,
      responsibleSubject: "synthetic-manager", obligationDueAt: asOf, requiredFacts },
  }).freshness;
  const evidence = options.missing || options.conflict ? [] : [{
    factId: "20000000-0000-4000-8000-000000000001", factType: "delivery.status",
    versionId: "30000000-0000-4000-8000-000000000001", evidenceId: "40000000-0000-4000-8000-000000000001",
    sourceId: "50000000-0000-4000-8000-000000000001", sourceAccessRevision: 1, authorityRevision: 1,
    observedAt: sourceDate, effectiveAt: sourceDate, timestampBasis: "HUMAN_OBSERVED_AT" as const,
  }];
  return { asOf, projectId, audience: options.audience ?? "project_manager", policyRevision: 2,
    completeness, freshness, evidence };
}

describe("EXEC-023 update advice", () => {
  it("emits no suggestion for complete data exactly at the freshness boundary", () => {
    const result = buildUpdateAdviceSnapshot(observation({ age: 60 }));
    expect(result.availability).toBe("AVAILABLE");
    if (result.availability !== "AVAILABLE") throw new Error("unexpected availability");
    expect(result.freshness.state).toBe("CURRENT");
    expect(result.thresholdAt).toBe(asOf);
    expect(result.suggestion).toBeNull();
  });
  it("suggests review after the stale boundary and uses audience-specific wording", () => {
    const result = buildUpdateAdviceSnapshot(observation({ age: 61, audience: "leadership" }));
    if (result.availability !== "AVAILABLE") throw new Error("unexpected availability");
    expect(result.suggestion).toMatchObject({ priority: "MEDIUM", ruleRevision: "update-information-v1" });
    expect(result.suggestion?.suggestedAction).toContain("intervention");
  });
  it("preserves missing and conflicting outcomes and created-at fallback", () => {
    const missing = buildUpdateAdviceSnapshot(observation({ age: 1, missing: true }));
    const conflict = buildUpdateAdviceSnapshot(observation({ age: 1, conflict: true }));
    if (missing.availability !== "AVAILABLE" || conflict.availability !== "AVAILABLE") throw new Error("unexpected availability");
    expect(missing.freshness.sourceDateField).toBe("project.createdAt");
    expect(missing.completeness.factAssessments[0]?.state).toBe("MISSING");
    expect(missing.suggestion?.triggeringFactTypes).toEqual(["delivery.status"]);
    expect(conflict.completeness.factAssessments[0]).toMatchObject({ state: "UNCONFIRMED", conflict: "CONFLICTING" });
  });
  it("rejects arbitrary inputs and mismatched clocks or projects", () => {
    const input = observation({ age: 1 });
    expect(() => buildUpdateAdviceSnapshot({ ...input, signals: [] })).toThrow();
    expect(() => buildUpdateAdviceSnapshot({ ...input, asOf: "2026-10-21T11:00:01.000Z" })).toThrow();
    expect(() => buildUpdateAdviceSnapshot({ ...input, projectId: "10000000-0000-4000-8000-000000000002" })).toThrow();
    expect(updateAdviceSnapshotSchema.safeParse({ availability: "UNCONFIGURED", asOf, projectId,
      audience: "project_manager", approvalItems: "UNAVAILABLE", suggestion: null }).success).toBe(false);
  });
  it("rejects contradictory completeness, freshness and response advice", () => {
    const input = observation({ age: 61, missing: true });
    expect(() => buildUpdateAdviceSnapshot({ ...input, completeness: { ...input.completeness, state: "COMPLETE" } })).toThrow();
    expect(() => buildUpdateAdviceSnapshot({ ...input, freshness: { ...input.freshness, ageMilliseconds: 1 } })).toThrow();
    const result = buildUpdateAdviceSnapshot(input);
    expect(updateAdviceSnapshotSchema.safeParse({ ...result, suggestion: null }).success).toBe(false);
    expect(updateAdviceSnapshotSchema.safeParse({ ...result, thresholdAt: asOf }).success).toBe(false);
    expect(updateAdviceSnapshotSchema.safeParse({ ...result, projectId: "10000000-0000-4000-8000-000000000002" }).success).toBe(false);
  });
  it("requires trusted references for a latest-valid-update source date", () => {
    const input = observation({ age: 20 });
    expect(() => buildUpdateAdviceSnapshot({ ...input, evidence: [] })).toThrow();
    expect(() => buildUpdateAdviceSnapshot({ ...input, evidence: [{ ...input.evidence[0], timestampBasis: "UNCONFIRMED" }] })).toThrow();
    expect(() => buildUpdateAdviceSnapshot({ ...input, evidence: [{ ...input.evidence[0], observedAt: asOf }] })).toThrow();
  });
});
