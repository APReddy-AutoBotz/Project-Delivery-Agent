import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";

export const atlasApprovalProjectCode = "ATLAS-APPROVAL-DEMO";
export const atlasIntegrationMilestoneKey = "INTEGRATION-TESTING";
export const atlasJiraBlockerKey = "ATLAS-248";
export const atlasCommentTemplate = "atlas-comment@1";
export const atlasAccessStatusSchema = z.enum(["ACCESS_PENDING", "ACCESS_RESTORED"]);
export const atlasSuggestionStatusSchema = z.enum(["ACCESS_PENDING", "ACCESS_RESTORED", "NEEDS_CLARIFICATION"]);
export type AtlasAccessStatus = z.infer<typeof atlasAccessStatusSchema>;

export const atlasReplyConfirmationSchema = z.strictObject({
  responseId: z.uuid(),
  accessStatus: atlasAccessStatusSchema,
});
export const atlasApprovalDecisionSchema = z.strictObject({
  approvalId: z.uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
});
export const atlasCommentCommandSchema = z.strictObject({ approvalId: z.uuid() });
export const atlasCommentReceiptSchema = z.strictObject({
  id: z.uuid(),
  approvalId: z.uuid(),
  target: z.literal("ATLAS-248"),
  fixtureRevision: z.number().int().min(1),
  recordedAt: z.iso.datetime(),
  result: z.literal("SIMULATED"),
});
export type AtlasCommentReceipt = z.infer<typeof atlasCommentReceiptSchema>;
export const atlasScheduleSchema = z.strictObject({
  revision: z.number().int().min(1),
  baseline: z.iso.date().nullable(),
  forecast: z.iso.date().nullable(),
  movementDays: z.number().int().nullable(),
});
export type AtlasSchedule = z.infer<typeof atlasScheduleSchema>;
export const atlasForecastConfidenceSchema = z.enum(["MEDIUM", "LOW", "UNKNOWN"]);
export const atlasDelayCommandSchema = z.strictObject({
  approvalId: z.uuid(),
  receiptId: z.uuid(),
  scheduleRevision: atlasScheduleSchema.shape.revision,
  cause: z.literal("API_ACCESS_DELAY"),
  confidence: atlasForecastConfidenceSchema,
});
export const atlasDelayAssessmentSchema = atlasDelayCommandSchema.extend({
  id: z.uuid(),
  confirmedBy: canonicalSubjectSchema,
  confirmedAt: z.iso.datetime(),
});
export type AtlasDelayAssessment = z.infer<typeof atlasDelayAssessmentSchema>;
export const atlasApprovalViewSchema = z.strictObject({
  approvalId: z.uuid(),
  responseId: z.uuid(),
  replyReceivedAt: z.iso.datetime(),
  confirmedBy: canonicalSubjectSchema,
  approver: canonicalSubjectSchema,
  accessStatus: atlasAccessStatusSchema,
  target: z.literal("ATLAS-248"),
  currentComment: z.string().nullable(),
  proposedComment: z.string(),
  sourceRevision: z.number().int().nonnegative(),
  expiresAt: z.iso.datetime(),
  decision: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  receipt: atlasCommentReceiptSchema.nullable(),
  delayReview: z.strictObject({
    schedule: atlasScheduleSchema,
    assessment: atlasDelayAssessmentSchema.nullable(),
  }).nullable().optional(),
});
export type AtlasApprovalView = z.infer<typeof atlasApprovalViewSchema>;

export const atlasLeadershipFactsSchema = z.strictObject({
  projectId: z.uuid(),
  asOf: z.iso.datetime(),
  schedule: atlasScheduleSchema.nullable(),
  ownerReply: z.strictObject({
    responseId: z.uuid(),
    receivedAt: z.iso.datetime(),
    availableUntil: z.iso.datetime(),
    accessStatus: atlasAccessStatusSchema,
  }).nullable(),
  receipt: atlasCommentReceiptSchema.nullable(),
  delayAssessment: atlasDelayAssessmentSchema.nullable(),
});
export type AtlasLeadershipFacts = z.infer<typeof atlasLeadershipFactsSchema>;
export const atlasLeadershipAnswerSchema = atlasLeadershipFactsSchema.extend({
  integrationStart: z.strictObject({
    milestoneId: z.uuid(),
    planned: z.iso.date(),
    actual: z.iso.date(),
  }).nullable(),
  jiraBlocker: z.strictObject({
    mappingId: z.uuid(),
    issueKey: z.literal(atlasJiraBlockerKey),
  }).nullable(),
  pmEscalation: z.strictObject({
    requestId: z.uuid(),
    capturedAt: z.iso.datetime(),
    availableUntil: z.iso.datetime(),
  }).nullable(),
});
export type AtlasLeadershipAnswer = z.infer<typeof atlasLeadershipAnswerSchema>;

export const atlasManagementFactsSchema = atlasLeadershipFactsSchema.extend({
  schedule: atlasLeadershipFactsSchema.shape.schedule.unwrap(),
  ownerReply: atlasLeadershipFactsSchema.shape.ownerReply.unwrap(),
  receipt: atlasCommentReceiptSchema,
  delayAssessment: atlasLeadershipFactsSchema.shape.delayAssessment.default(null),
});
export const atlasManagementSnapshotSchema = atlasManagementFactsSchema.extend({
  id: z.uuid(),
  reportingPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  approvalState: z.enum(["DRAFT", "PENDING", "APPROVED", "REJECTED"]),
  approval: z.strictObject({
    requestId: z.uuid(),
    approver: canonicalSubjectSchema,
    decidedAt: z.iso.datetime().nullable(),
  }).nullable(),
  classification: z.literal("SYNTHETIC_INTERNAL"),
});
export type AtlasManagementSnapshot = z.infer<typeof atlasManagementSnapshotSchema>;
export const atlasManagementPreviewSchema = z.strictObject({
  snapshot: atlasManagementSnapshotSchema,
  highlights: z.array(z.string().min(1).max(240)).length(4),
});
export type AtlasManagementPreview = z.infer<typeof atlasManagementPreviewSchema>;
export const atlasManagementOutputSchema = atlasManagementPreviewSchema.extend({
  livePath: z.string().regex(/^\/\?project=[0-9a-f-]{36}$/u),
  powerpointBase64: z.string().max(196608).regex(/^UEsDB[A-Za-z0-9+/]+={0,2}$/u),
});
export type AtlasManagementOutput = z.infer<typeof atlasManagementOutputSchema>;
export const atlasReportApprovalRequestSchema = z.strictObject({ snapshotId: z.uuid() });
export const atlasReportVersionSchema = atlasReportApprovalRequestSchema.extend({
  requestId: z.uuid(),
});
export const atlasReportDecisionSchema = atlasReportVersionSchema.extend({
  decision: atlasApprovalDecisionSchema.shape.decision,
});
export const atlasReportRecipientSubject = "leader-atlas";
export const atlasReportDistributionReceiptSchema = atlasReportVersionSchema.extend({
  id: z.uuid(),
  recipient: z.literal(atlasReportRecipientSubject),
  distributedAt: z.iso.datetime(),
});
export type AtlasReportDistributionReceipt = z.infer<typeof atlasReportDistributionReceiptSchema>;
export const atlasReportReviewSchema = atlasManagementPreviewSchema.extend({
  distribution: atlasReportDistributionReceiptSchema.nullable(),
});
export const atlasDistributedReportSchema = atlasManagementOutputSchema.extend({
  distribution: atlasReportDistributionReceiptSchema,
});

export function suggestAtlasAccessStatus(reply: string): AtlasAccessStatus | null {
  // Match the fixture's explicit answer only. Other wording needs owner review.
  switch (reply.trim()) {
    case "Access is still pending from Infrastructure. They expect to provide it on Wednesday. I need two working days after access to complete the integration task.":
      return "ACCESS_PENDING";
    case "Infrastructure restored API access.":
      return "ACCESS_RESTORED";
    default:
      return null;
  }
}

export function atlasComment(status: AtlasAccessStatus): string {
  return status === "ACCESS_PENDING"
    ? "The Atlas owner confirmed that API access is still pending."
    : "The Atlas owner confirmed that API access has been restored.";
}
