import { z } from "zod";
import type { AuthorityAssessment } from "./authority-persistence.js";
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

const currentLeadershipFacts = projectLeadershipFactsSchema.extend({
  updateFreshness: projectLeadershipFactsSchema.shape.updateFreshness.unwrap().extend({
    obligationId: z.uuid().optional(),
  }).refine(({ openObligation, obligationId }) => openObligation === (obligationId !== undefined)).nullable(),
});

export const projectLeadershipAnswerSchema = z.union([
  z.strictObject({ state: z.literal("CLARIFY") }),
  currentLeadershipFacts.extend({
    state: z.literal("ANSWERED"),
    cause: z.literal("UNKNOWN"),
    pendingDelayClarification: projectDelayClarificationSchema.optional(),
  }),
  currentLeadershipFacts.extend({
    state: z.literal("ANSWERED"),
    cause: z.literal("HUMAN_CONFIRMED"),
    delayCause: confirmedProjectDelayCauseSchema,
  }).refine(({ projectId, asOf, delayCause }) => delayCause.claim.projectId === projectId && delayCause.claim.assessedAt === asOf),
  projectLeadershipFactsSchema.extend({
    state: z.literal("COMPARISON"),
    priorSnapshot: projectLeadershipFactsSchema.omit({ projectId: true }).extend({ id: z.uuid() }),
  }),
]);
export type ProjectLeadershipAnswer = z.infer<typeof projectLeadershipAnswerSchema>;

export function isCurrentProjectScheduleQuestion(question: string) {
  return /^(?:why is (?:this|the) project delayed|what is (?:this|the) project(?:'s)? schedule status|what is the schedule status of this project)\??$/u
    .test(question.trim().toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'"));
}

export function isProjectSnapshotComparisonQuestion(question: string) {
  return /^what changed since (?:this|the) (?:saved )?snapshot\??$/u.test(question.trim().toLowerCase().replace(/\s+/gu, " "));
}
