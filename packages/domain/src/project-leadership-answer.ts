import { z } from "zod";
import { projectUpdateAssessmentViewSchema } from "./project-updates.js";

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
});
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

export const projectLeadershipAnswerSchema = z.union([
  z.strictObject({ state: z.literal("CLARIFY") }),
  projectLeadershipFactsSchema.extend({
    state: z.literal("ANSWERED"),
    cause: z.literal("UNKNOWN"),
  }),
  projectLeadershipFactsSchema.extend({
    state: z.literal("ANSWERED"),
    cause: z.literal("HUMAN_CONFIRMED"),
    delayCause: confirmedProjectDelayCauseSchema,
  }),
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
