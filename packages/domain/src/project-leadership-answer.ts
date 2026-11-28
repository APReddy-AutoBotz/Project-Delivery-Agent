import { z } from "zod";
import type { AuthorityAssessment } from "./authority-persistence.js";
import { calendarDayDifference } from "./overdue-signals.js";
import { projectUpdateAssessmentViewSchema } from "./project-updates.js";

const settledProvenance = z.enum(["SYSTEM_VERIFIED", "HUMAN_CONFIRMED"]);
const claimText = z.string().min(1).max(540).refine((value) => value.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(value));
export const settledLeadershipClaimSchema = z.strictObject({
  claimText,
  projectId: z.uuid(), factId: z.uuid(), versionId: z.uuid(), evidenceIds: z.array(z.uuid()).min(1).max(64),
  policyRevisionId: z.uuid(), assessedAt: z.iso.datetime(), validUntil: z.iso.datetime().nullable(),
  provenance: settledProvenance, freshness: z.literal("CURRENT"), conflict: z.literal("NONE"),
  classification: settledProvenance,
}).refine((claim) => claim.classification === claim.provenance && new Set(claim.evidenceIds).size === claim.evidenceIds.length &&
  (claim.validUntil === null || Date.parse(claim.validUntil) > Date.parse(claim.assessedAt)));
export type SettledLeadershipClaim = z.infer<typeof settledLeadershipClaimSchema>;

// The caller retrieves the authority assessment under the viewer's current project and source permissions.
export function composeSettledLeadershipClaim(result: AuthorityAssessment, provenance: SettledLeadershipClaim["provenance"],
  render: (value: NonNullable<AuthorityAssessment["resolvedValue"]>) => string | null) {
  if (!result.complete || result.status !== "RESOLVED" || result.revalidationRequired || result.conflict !== "NONE" ||
      !result.policy || !result.resolvedValue || result.supportingVersionIds.length !== 1) return null;
  const support = result.versions.find((version) => version.id === result.supportingVersionIds[0]);
  if (support?.visibility !== "available" || support.provenance !== provenance || support.assessment.provenance !== provenance ||
      support.assessment.classification !== provenance || support.assessment.freshness !== "CURRENT" ||
      support.assessment.conflict !== "NONE" || support.assessment.assessedAt !== result.asOf ||
      support.evidenceIds.length !== result.supportingEvidenceIds.length ||
      !support.evidenceIds.every((id) => result.supportingEvidenceIds.includes(id))) return null;
  const parsed = settledLeadershipClaimSchema.safeParse({ claimText: render(result.resolvedValue),
    projectId: result.scope.projectId, factId: result.scope.factId, versionId: support.id, evidenceIds: result.supportingEvidenceIds,
    policyRevisionId: result.policy.revisionId, validUntil: support.assessedValidUntil, ...support.assessment });
  return parsed.success ? { claim: parsed.data, support } : null;
}

export const projectLeadershipScheduleSchema = z.strictObject({
  revision: z.number().int().min(1),
  baseline: z.iso.date().nullable(),
  forecast: z.iso.date().nullable(),
  movementDays: z.number().int().nullable(),
});
export type ProjectLeadershipSchedule = z.infer<typeof projectLeadershipScheduleSchema>;

export const projectDelayClarificationCommandSchema = z.strictObject({
  scheduleRevision: projectLeadershipScheduleSchema.shape.revision,
});
export const projectDelayClarificationSchema = z.strictObject({
  id: z.uuid(), requestedAt: z.iso.datetime(), schedule: projectLeadershipScheduleSchema,
});
export type ProjectDelayClarification = z.infer<typeof projectDelayClarificationSchema>;

export const projectDelayCauseFactType = "project.delay_cause";
export const projectDelayCauseEvidenceSchema = z.strictObject({
  factId: z.uuid(), versionId: z.uuid(), evidenceId: z.uuid(), observedAt: z.iso.datetime(),
  value: z.string().min(1).max(500).refine((value) => value.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(value)),
});
export type ProjectDelayCauseEvidence = z.infer<typeof projectDelayCauseEvidenceSchema>;
export const projectDelayCauseCommandSchema = z.strictObject({ clarificationId: z.uuid(), versionId: z.uuid() });
export const projectDelayCauseConfirmationSchema = projectDelayCauseCommandSchema.extend({ id: z.uuid(), confirmedAt: z.iso.datetime() });
export const confirmedProjectDelayCauseSchema = z.strictObject({
  evidence: projectDelayCauseEvidenceSchema, confirmation: projectDelayCauseConfirmationSchema,
  claim: settledLeadershipClaimSchema.safeExtend({ provenance: z.literal("HUMAN_CONFIRMED"),
    classification: z.literal("HUMAN_CONFIRMED"), evidenceIds: settledLeadershipClaimSchema.shape.evidenceIds.length(1) }),
}).refine(({ evidence, confirmation, claim }) => claim.claimText === `PM-confirmed delay cause · ${evidence.value}` && claim.factId === evidence.factId &&
  claim.versionId === evidence.versionId && claim.versionId === confirmation.versionId &&
  claim.evidenceIds[0] === evidence.evidenceId);
export const projectDelayClarificationReviewSchema = projectDelayClarificationSchema.extend({
  causeEvidence: projectDelayCauseEvidenceSchema.nullable(), confirmation: projectDelayCauseConfirmationSchema.nullable(),
});
export type ProjectDelayClarificationReview = z.infer<typeof projectDelayClarificationReviewSchema>;
export type ProjectDelayCauseConfirmation = z.infer<typeof projectDelayCauseConfirmationSchema>;

export const projectLeadershipQuestionSchema = z.strictObject({
  question: z.string().trim().min(1).max(256),
  priorSnapshotId: z.uuid().optional(),
});

export const projectLeadershipFactsSchema = z.strictObject({
  projectId: z.uuid(),
  asOf: z.iso.datetime(),
  schedule: projectLeadershipScheduleSchema.nullable(),
  updateFreshness: projectUpdateAssessmentViewSchema.shape.freshness.pick({
    state: true, assessedAt: true, sourceDate: true, sourceDateField: true,
  }).extend({ assessmentId: z.uuid(), openObligation: z.boolean() }).nullable(),
});
export type ProjectLeadershipFacts = z.infer<typeof projectLeadershipFactsSchema>;

const readClaim = z.strictObject({
  projectId: z.uuid(), asOf: z.iso.datetime(), claimText,
  provenance: z.literal("SYSTEM_VERIFIED"), conflict: z.literal("NONE"),
});
const scheduleClaimSchema = readClaim.extend({
  scheduleRevision: projectLeadershipScheduleSchema.shape.revision,
  evidenceIds: z.tuple([z.uuid()]), freshness: z.literal("CURRENT"), classification: z.literal("SYSTEM_VERIFIED"),
});
export const leadershipUpdateClaimSchema = readClaim.extend({
  policyRevisionId: z.uuid(), assessedAt: z.iso.datetime(),
  evidenceIds: z.array(z.uuid()).min(1).max(2),
  freshness: z.enum(["CURRENT", "STALE"]), classification: z.enum(["SYSTEM_VERIFIED", "STALE"]),
});
const liveUpdateFreshness = projectLeadershipFactsSchema.shape.updateFreshness.unwrap().extend({
  obligationId: z.uuid().optional(),
});
type LiveUpdateFreshness = z.infer<typeof liveUpdateFreshness>;
type LeadershipClaimScope = Pick<ProjectLeadershipFacts, "projectId" | "asOf">;

const comparisonFields = ["Baseline date", "Forecast date", "Update freshness", "Update source", "Update obligation",
  "Owner-confirmed API access", "Simulated Jira action", "PM-confirmed cause", "PM forecast confidence"] as const;
const comparisonRowClaimSchema = readClaim.extend({
  priorSnapshotId: z.uuid(),
  field: z.enum(comparisonFields),
  before: z.string().min(1).max(84).nullable(),
  after: z.string().min(1).max(84).nullable(),
  evidenceIds: z.array(z.uuid()).min(1).max(3),
  validUntil: z.iso.datetime().nullable(),
  freshness: z.literal("CURRENT"),
  classification: z.literal("SYSTEM_VERIFIED"),
});
export const leadershipComparisonClaimsSchema = z.array(comparisonRowClaimSchema).max(comparisonFields.length);
type ComparisonClaim = z.infer<typeof comparisonRowClaimSchema>;
export type LeadershipComparisonField = readonly [ComparisonClaim["field"], string | null, string | null,
  string | undefined, string | undefined, (string | null)?];

export function composeLeadershipComparisonClaims(scope: LeadershipClaimScope & { priorSnapshotId: string },
  fields: readonly LeadershipComparisonField[]): ComparisonClaim[] {
  return fields.flatMap<ComparisonClaim>(([field, before, after, priorEvidence, currentEvidence, validUntil = null]) => {
    if (before === after || (validUntil !== null && Date.parse(validUntil) <= Date.parse(scope.asOf))) return [];
    return [{ projectId: scope.projectId, asOf: scope.asOf,
      claimText: `${field} changed from ${before ?? "Unavailable"} to ${after ?? "Unavailable"}.`,
      provenance: "SYSTEM_VERIFIED", conflict: "NONE",
      priorSnapshotId: scope.priorSnapshotId, field, before, after,
      evidenceIds: [...new Set([scope.priorSnapshotId, ...(priorEvidence ? [priorEvidence] : []),
        ...(currentEvidence ? [currentEvidence] : [])])],
      validUntil, freshness: "CURRENT", classification: "SYSTEM_VERIFIED" }];
  });
}

const projectComparisonFactsSchema = projectLeadershipFactsSchema.extend({
  state: z.literal("COMPARISON"),
  priorSnapshot: projectLeadershipFactsSchema.omit({ projectId: true }).extend({ id: z.uuid() }),
  currentScheduleReceiptId: z.uuid().optional(),
  currentObligationId: z.uuid().optional(),
});

export function composeProjectComparisonClaims(facts: z.infer<typeof projectComparisonFactsSchema>) {
  const { priorSnapshot: prior, currentScheduleReceiptId, currentObligationId, updateFreshness: currentUpdate } = facts;
  const savedUpdate = prior.updateFreshness;
  const currentSchedule = currentScheduleReceiptId ? facts.schedule : null;
  const updateSource = (update: ProjectLeadershipFacts["updateFreshness"]) => update
    ? `${update.sourceDateField === "project.createdAt" ? "Project created" : "Latest verified update"} at ${update.sourceDate}`
    : null;
  const updateObligation = (update: ProjectLeadershipFacts["updateFreshness"]) => update
    ? update.openObligation ? "Update due" : "No update due" : null;
  return composeLeadershipComparisonClaims({ projectId: facts.projectId, asOf: facts.asOf, priorSnapshotId: prior.id }, [
    ["Baseline date", prior.schedule?.baseline ?? null, currentSchedule?.baseline ?? null, undefined, currentScheduleReceiptId],
    ["Forecast date", prior.schedule?.forecast ?? null, currentSchedule?.forecast ?? null, undefined, currentScheduleReceiptId],
    ["Update freshness", savedUpdate?.state.toLowerCase() ?? null, currentUpdate?.state.toLowerCase() ?? null,
      savedUpdate?.assessmentId, currentUpdate?.assessmentId],
    ["Update source", updateSource(savedUpdate), updateSource(currentUpdate), savedUpdate?.assessmentId, currentUpdate?.assessmentId],
    ["Update obligation", updateObligation(savedUpdate), updateObligation(currentUpdate), savedUpdate?.assessmentId,
      currentObligationId ?? currentUpdate?.assessmentId],
  ]);
}

export function leadershipScheduleMovementText(days: number | null) {
  return days === null ? "Schedule movement is unavailable." : days === 0 ? "The baseline and forecast dates match."
    : `The forecast is ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days > 0 ? "later" : "earlier"} than the baseline.`;
}

export function composeProjectLeadershipClaims(
  facts: Pick<ProjectLeadershipFacts, "projectId" | "asOf" | "schedule"> & { updateFreshness: LiveUpdateFreshness | null },
  scheduleReceiptId: string | undefined, updatePolicyRevisionId: string | undefined,
) {
  const { projectId, asOf, schedule, updateFreshness } = facts;
  const scope = { projectId, asOf };
  return {
    scheduleClaim: schedule && scheduleReceiptId ? scheduleClaimSchema.parse(scheduleClaimFields(scope, schedule, scheduleReceiptId)) : null,
    updateClaim: composeLeadershipUpdateClaim(scope, updateFreshness, updatePolicyRevisionId),
  };
}

function scheduleClaimFields(scope: LeadershipClaimScope, schedule: NonNullable<ProjectLeadershipFacts["schedule"]>, receiptId: string) {
  return {
    projectId: scope.projectId, asOf: scope.asOf, claimText: leadershipScheduleMovementText(schedule.movementDays),
    provenance: "SYSTEM_VERIFIED", conflict: "NONE",
    scheduleRevision: schedule.revision, evidenceIds: [receiptId], freshness: "CURRENT", classification: "SYSTEM_VERIFIED",
  } as const;
}

export function composeLeadershipUpdateClaim(scope: LeadershipClaimScope,
  freshness: LiveUpdateFreshness | null, policyRevisionId: string | undefined) {
  return freshness && policyRevisionId
    ? leadershipUpdateClaimSchema.parse(leadershipUpdateClaimFields(scope, freshness, policyRevisionId)) : null;
}

function leadershipUpdateClaimFields(scope: LeadershipClaimScope, freshness: LiveUpdateFreshness, policyRevisionId: string) {
  const { assessmentId, obligationId, assessedAt, state, openObligation } = freshness;
  return {
    projectId: scope.projectId, asOf: scope.asOf,
    claimText: `The latest saved assessment found the project ${state.toLowerCase()} under its update policy.`
      + (openObligation ? " A project update remains due." : ""),
    provenance: "SYSTEM_VERIFIED", conflict: "NONE", policyRevisionId, assessedAt,
    evidenceIds: obligationId ? [assessmentId, obligationId] : [assessmentId],
    freshness: state, classification: state === "STALE" ? "STALE" : "SYSTEM_VERIFIED",
  } as const;
}

export function matchesLeadershipUpdateClaim(scope: LeadershipClaimScope, freshness: LiveUpdateFreshness | null,
  claim: z.infer<typeof leadershipUpdateClaimSchema> | null) {
  if (!freshness || !claim) return !freshness && !claim;
  if (freshness.openObligation !== (freshness.obligationId !== undefined) ||
      freshness.assessmentId === freshness.obligationId ||
      Date.parse(freshness.sourceDate) > Date.parse(freshness.assessedAt) ||
      Date.parse(freshness.assessedAt) > Date.parse(scope.asOf)) return false;
  return JSON.stringify(claim) === JSON.stringify(leadershipUpdateClaimFields(scope, freshness, claim.policyRevisionId));
}

const currentLeadershipFacts = projectLeadershipFactsSchema.extend({
  updateFreshness: liveUpdateFreshness.refine(({ openObligation, obligationId }) => openObligation === (obligationId !== undefined)).nullable(),
  scheduleClaim: scheduleClaimSchema.nullable(),
  updateClaim: leadershipUpdateClaimSchema.nullable(),
}).refine((facts) => {
  const { projectId, asOf, schedule, scheduleClaim, updateFreshness, updateClaim } = facts;
  const scope = { projectId, asOf };
  if (schedule && schedule.movementDays !== (schedule.baseline && schedule.forecast
    ? calendarDayDifference(schedule.forecast, schedule.baseline) : null)) return false;
  const expectedSchedule = schedule && scheduleClaim ? scheduleClaimFields(scope, schedule, scheduleClaim.evidenceIds[0]) : null;
  return matchesLeadershipUpdateClaim(scope, updateFreshness, updateClaim) &&
    JSON.stringify(scheduleClaim) === JSON.stringify(expectedSchedule);
});

export const projectLeadershipAnswerSchema = z.union([
  z.strictObject({ state: z.literal("CLARIFY") }),
  currentLeadershipFacts.safeExtend({
    state: z.literal("ANSWERED"),
    cause: z.literal("UNKNOWN"),
    pendingDelayClarification: projectDelayClarificationSchema.optional(),
  }),
  currentLeadershipFacts.safeExtend({
    state: z.literal("ANSWERED"),
    cause: z.literal("HUMAN_CONFIRMED"),
    delayCause: confirmedProjectDelayCauseSchema,
  }).refine(({ projectId, asOf, delayCause }) => delayCause.claim.projectId === projectId && delayCause.claim.assessedAt === asOf),
  projectComparisonFactsSchema.extend({ comparisonClaims: leadershipComparisonClaimsSchema })
    .refine((facts) => Date.parse(facts.priorSnapshot.asOf) <= Date.parse(facts.asOf) &&
      (!facts.currentScheduleReceiptId || Boolean(facts.schedule)) &&
      Boolean(facts.currentObligationId) === Boolean(facts.updateFreshness?.openObligation) &&
      JSON.stringify(facts.comparisonClaims) === JSON.stringify(composeProjectComparisonClaims(facts))),
]);
export type ProjectLeadershipAnswer = z.infer<typeof projectLeadershipAnswerSchema>;

export function isCurrentProjectScheduleQuestion(question: string) {
  return /^(?:why is (?:this|the) project delayed|what is (?:this|the) project(?:'s)? schedule status|what is the schedule status of this project)\??$/u
    .test(question.trim().toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'"));
}

export function isProjectSnapshotComparisonQuestion(question: string) {
  return /^what changed since (?:this|the) (?:saved )?snapshot\??$/u.test(question.trim().toLowerCase().replace(/\s+/gu, " "));
}
