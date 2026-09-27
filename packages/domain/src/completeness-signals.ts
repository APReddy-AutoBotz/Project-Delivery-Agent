import { z } from "zod";
import { canonicalKeySchema } from "./canonical-project.js";

// FR-HLT-002 / AC-HLT-002: deterministic, read-only completeness calculation.
// Callers must supply the complete required-fact rule set and one result per
// required type from an authorized canonical/source-authority read. Proposal
// records are not canonical versions and must not be counted here.
const instant = z
  .string()
  .length(24)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number(value.slice(0, 4)) >= 1 &&
      Number.isFinite(time) &&
      new Date(time).toISOString() === value
    );
  });
const factType = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/);
const safeText = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) =>
      value.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(value),
  );
const revision = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const requiredFactSchema = z.strictObject({
  factType,
  label: safeText,
});
const authorityStatusSchema = z.enum([
  "RESOLVED",
  "UNKNOWN",
  "CONFLICTING",
  "AMBIGUOUS",
  "INCOMPLETE",
  "REVALIDATION_REQUIRED",
  "NO_POLICY",
  "POLICY_NOT_APPLICABLE",
]);
const factAssessmentInputSchema = z.strictObject({
  factType,
  canonicalVersionCount: z.number().int().min(0).max(1000),
  sourceAuthorityStatus: authorityStatusSchema,
  conflict: z.enum(["NONE", "CONFLICTING"]),
});
const requestSchema = z.strictObject({
  assessedAt: instant,
  projectId: z
    .string()
    .uuid()
    .refine((value) => value === value.toLowerCase()),
  ruleKey: canonicalKeySchema,
  ruleRevision: revision,
  requiredFactsComplete: z.literal(true),
  requiredFacts: z.array(requiredFactSchema).min(1).max(100),
  factAssessments: z.array(factAssessmentInputSchema).max(100),
});
export type CompletenessAssessmentInput = z.input<typeof requestSchema>;
export type CompletenessFactAssessment = z.infer<
  typeof factAssessmentInputSchema
>;
export type CompletenessReasonCode =
  | "NO_CANONICAL_VALUE"
  | "AUTHORITY_INPUT_INCOMPLETE"
  | "SOURCE_REVALIDATION_REQUIRED"
  | "CONFLICTING_AUTHORITY"
  | "AMBIGUOUS_AUTHORITY"
  | "NO_APPLICABLE_AUTHORITY_POLICY"
  | "NO_CURRENT_AUTHORIZED_VALUE";
type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function invalid(): never {
  throw new Error("Invalid completeness assessment input");
}
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function unconfirmedReasons(
  assessment: CompletenessFactAssessment,
): CompletenessReasonCode[] {
  const reasons = new Set<CompletenessReasonCode>();
  if (assessment.sourceAuthorityStatus === "INCOMPLETE")
    reasons.add("AUTHORITY_INPUT_INCOMPLETE");
  if (assessment.sourceAuthorityStatus === "REVALIDATION_REQUIRED")
    reasons.add("SOURCE_REVALIDATION_REQUIRED");
  if (
    assessment.sourceAuthorityStatus === "CONFLICTING" ||
    assessment.conflict === "CONFLICTING"
  )
    reasons.add("CONFLICTING_AUTHORITY");
  if (assessment.sourceAuthorityStatus === "AMBIGUOUS")
    reasons.add("AMBIGUOUS_AUTHORITY");
  if (
    assessment.sourceAuthorityStatus === "NO_POLICY" ||
    assessment.sourceAuthorityStatus === "POLICY_NOT_APPLICABLE"
  )
    reasons.add("NO_APPLICABLE_AUTHORITY_POLICY");
  if (assessment.sourceAuthorityStatus === "UNKNOWN")
    reasons.add("NO_CURRENT_AUTHORIZED_VALUE");
  return [...reasons].sort(compare);
}

/**
 * List the exact required project facts that are missing or unconfirmed.
 * A canonical fact counts as confirmed only when source authority is RESOLVED,
 * conflict-free, and backed by at least one canonical version. An incomplete
 * or revalidation-required snapshot is never reported as a missing fact.
 */
export function assessProjectCompleteness(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const request = parsed.data;
  const requiredByType = new Map<string, (typeof request.requiredFacts)[number]>();
  for (const required of request.requiredFacts) {
    if (requiredByType.has(required.factType)) return invalid();
    requiredByType.set(required.factType, required);
  }
  const assessmentByType = new Map<
    string,
    (typeof request.factAssessments)[number]
  >();
  for (const assessment of request.factAssessments) {
    if (
      !requiredByType.has(assessment.factType) ||
      assessmentByType.has(assessment.factType)
    )
      return invalid();
    if (
      (assessment.sourceAuthorityStatus === "RESOLVED" &&
        (assessment.canonicalVersionCount === 0 ||
          assessment.conflict !== "NONE")) ||
      (assessment.sourceAuthorityStatus === "AMBIGUOUS" &&
        (assessment.canonicalVersionCount === 0 ||
          assessment.conflict !== "NONE")) ||
      (assessment.sourceAuthorityStatus === "CONFLICTING" &&
        (assessment.canonicalVersionCount === 0 ||
          assessment.conflict !== "CONFLICTING"))
    )
      return invalid();
    assessmentByType.set(assessment.factType, assessment);
  }
  if (assessmentByType.size !== requiredByType.size) return invalid();

  const factAssessments = [...request.requiredFacts]
    .sort((left, right) => compare(left.factType, right.factType))
    .map((required) => {
      const source = assessmentByType.get(required.factType)!;
      if (
        source.sourceAuthorityStatus === "RESOLVED" &&
        source.conflict === "NONE" &&
        source.canonicalVersionCount > 0
      )
        return {
          ...required,
          state: "CONFIRMED" as const,
          canonicalVersionCount: source.canonicalVersionCount,
          sourceAuthorityStatus: source.sourceAuthorityStatus,
          conflict: source.conflict,
          reasonCodes: [] as CompletenessReasonCode[],
        };
      if (
        source.canonicalVersionCount === 0 &&
        source.sourceAuthorityStatus !== "INCOMPLETE" &&
        source.sourceAuthorityStatus !== "REVALIDATION_REQUIRED" &&
        source.conflict === "NONE"
      )
        return {
          ...required,
          state: "MISSING" as const,
          canonicalVersionCount: 0,
          sourceAuthorityStatus: source.sourceAuthorityStatus,
          conflict: source.conflict,
          reasonCodes: ["NO_CANONICAL_VALUE"] as CompletenessReasonCode[],
        };
      const reasonCodes = unconfirmedReasons(source);
      if (reasonCodes.length === 0) return invalid();
      return {
        ...required,
        state: "UNCONFIRMED" as const,
        canonicalVersionCount: source.canonicalVersionCount,
        sourceAuthorityStatus: source.sourceAuthorityStatus,
        conflict: source.conflict,
        reasonCodes,
      };
    });
  const missing = factAssessments.filter((fact) => fact.state === "MISSING");
  const unconfirmed = factAssessments.filter(
    (fact) => fact.state === "UNCONFIRMED",
  );
  const confirmedFactTypes = factAssessments
    .filter((fact) => fact.state === "CONFIRMED")
    .map((fact) => fact.factType);
  const complete = missing.length === 0 && unconfirmed.length === 0;
  return freeze({
    projectId: request.projectId,
    assessedAt: request.assessedAt,
    ruleKey: request.ruleKey,
    ruleRevision: request.ruleRevision,
    state: complete ? ("COMPLETE" as const) : ("INCOMPLETE" as const),
    complete,
    requiredCount: factAssessments.length,
    confirmedCount: confirmedFactTypes.length,
    confirmedFactTypes,
    missing,
    unconfirmed,
    factAssessments,
  });
}
