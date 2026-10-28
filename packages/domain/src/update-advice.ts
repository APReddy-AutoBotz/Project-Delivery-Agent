import { z } from "zod";
import { projectUpdateAssessmentViewSchema, projectUpdateFactReferenceSchema } from "./project-updates.js";
import { assessProjectCompleteness } from "./completeness-signals.js";

const instant = z.iso.datetime({ precision: 3 });
const audience = z.enum(["project_manager", "leadership"]);
const observation = z.strictObject({
  asOf: instant,
  projectId: z.uuid(),
  audience,
  policyRevision: z.number().int().min(1),
  completeness: projectUpdateAssessmentViewSchema.shape.completeness,
  freshness: projectUpdateAssessmentViewSchema.shape.freshness,
  evidence: z.array(projectUpdateFactReferenceSchema).max(1000),
});
const suggestion = z.strictObject({
  category: z.literal("UPDATE_FOLLOW_UP"),
  priority: z.literal("MEDIUM"),
  ruleRevision: z.literal("update-information-v1"),
  triggeringFactTypes: z.array(z.string()).max(100),
  suggestedAction: z.string(),
  expectedOutcome: z.string(),
});
const response = z.discriminatedUnion("availability", [
  z.strictObject({
    availability: z.literal("UNCONFIGURED"), asOf: instant, projectId: z.uuid(), audience,
    approvalItems: z.literal("UNAVAILABLE"),
  }),
  observation.extend({
    availability: z.literal("AVAILABLE"), approvalItems: z.literal("UNAVAILABLE"),
    thresholdAt: instant,
    suggestion: suggestion.nullable(),
  }),
]);
type Observation = z.infer<typeof observation>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function validateObservation(input: Observation): string {
  const { completeness, freshness, asOf, projectId, policyRevision } = input;
  if (completeness.projectId !== projectId || completeness.assessedAt !== asOf ||
      freshness.assessedAt !== asOf || completeness.ruleRevision !== String(policyRevision) ||
      freshness.ruleRevision !== String(policyRevision) ||
      completeness.ruleKey !== "project-update" || freshness.policyKey !== "project-update" ||
      completeness.factAssessments.some((fact) =>
        fact.sourceAuthorityStatus === "INCOMPLETE" || fact.sourceAuthorityStatus === "REVALIDATION_REQUIRED"))
    throw new Error("Invalid update advice observation");
  const reconstructed = assessProjectCompleteness({
    assessedAt: asOf, projectId, ruleKey: completeness.ruleKey, ruleRevision: completeness.ruleRevision,
    requiredFactsComplete: true,
    requiredFacts: completeness.factAssessments.map(({ factType, label }) => ({ factType, label })),
    factAssessments: completeness.factAssessments.map(({ factType, canonicalVersionCount, sourceAuthorityStatus, conflict }) =>
      ({ factType, canonicalVersionCount, sourceAuthorityStatus, conflict })),
  });
  if (!same(completeness, reconstructed) || input.evidence.some((item) =>
    !completeness.confirmedFactTypes.includes(item.factType)))
    throw new Error("Invalid update advice completeness");
  const source = Date.parse(freshness.sourceDate), assessed = Date.parse(asOf);
  if (freshness.sourceDateField === "project.latestValidUpdateAt") {
    const referenceTimes = input.evidence.map((item) => {
      if (item.timestampBasis === "UNCONFIRMED") return Number.NaN;
      return Date.parse(item.timestampBasis === "CONNECTOR_EFFECTIVE_AT" ? item.effectiveAt : item.observedAt);
    });
    if (completeness.state !== "COMPLETE" || !input.evidence.length ||
        completeness.confirmedFactTypes.some((factType) => !input.evidence.some((item) => item.factType === factType)) ||
        referenceTimes.some((time) => !Number.isFinite(time) || time > assessed) ||
        Math.min(...referenceTimes) !== source)
      throw new Error("Invalid update advice provenance");
  }
  const age = assessed - source, window = freshness.freshnessWindowSeconds * 1000;
  const threshold = new Date(source + window);
  if (!Number.isFinite(threshold.getTime()) || age < 0 || freshness.ageMilliseconds !== age ||
      freshness.exceededByMilliseconds !== Math.max(0, age - window) ||
      freshness.state !== (age > window ? "STALE" : "CURRENT"))
    throw new Error("Invalid update advice freshness");
  return threshold.toISOString();
}
function expectedSuggestion(input: Observation) {
  const triggeringFactTypes = input.completeness.factAssessments
    .filter((fact) => fact.state !== "CONFIRMED").map((fact) => fact.factType).sort();
  if (input.freshness.state !== "STALE" && input.completeness.state !== "INCOMPLETE") return null;
  return {
    category: "UPDATE_FOLLOW_UP" as const, priority: "MEDIUM" as const, ruleRevision: "update-information-v1" as const,
    triggeringFactTypes,
    suggestedAction: input.audience === "project_manager"
      ? "Review the information gap and prepare a follow-up."
      : "Review the information gap and decide whether intervention is needed.",
    expectedOutcome: "A current, complete project update can be reviewed using authorized evidence.",
  };
}
export const updateAdviceSnapshotSchema = response.superRefine((value, context) => {
  if (value.availability !== "AVAILABLE") return;
  try {
    const input = { asOf: value.asOf, projectId: value.projectId, audience: value.audience,
      policyRevision: value.policyRevision, completeness: value.completeness, freshness: value.freshness, evidence: value.evidence };
    if (validateObservation(input) !== value.thresholdAt || !same(value.suggestion, expectedSuggestion(input)))
      throw new Error("Inconsistent update advice");
  } catch {
    context.addIssue({ code: "custom", message: "Inconsistent update advice observation" });
  }
});
export type UpdateAdviceSnapshot = z.infer<typeof updateAdviceSnapshotSchema>;

// The caller supplies an authorized, complete transaction-owned observation.
// This builder does not resolve authority or accept arbitrary advice signals.
export function buildUpdateAdviceSnapshot(input: unknown): UpdateAdviceSnapshot {
  const parsed = observation.parse(input);
  return updateAdviceSnapshotSchema.parse({
    ...parsed, availability: "AVAILABLE", approvalItems: "UNAVAILABLE",
    thresholdAt: validateObservation(parsed), suggestion: expectedSuggestion(parsed),
  });
}
