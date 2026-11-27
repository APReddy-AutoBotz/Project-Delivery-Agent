import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";
import { projectUpdateAssessmentViewSchema } from "./project-updates.js";
import { projectDelayClarificationCommandSchema, projectDelayClarificationSchema, projectLeadershipScheduleSchema,
  settledLeadershipClaimSchema } from "./project-leadership-answer.js";
import { projectReportApprovalRequestSchema, projectReportDecisionSchema, projectReportVersionSchema } from "./project-management-draft.js";

export const atlasApprovalProjectCode = "ATLAS-APPROVAL-DEMO";
export const atlasIntegrationMilestoneKey = "INTEGRATION-TESTING";
export const atlasJiraBlockerKey = "ATLAS-248";
export const atlasJiraBlockerClaimText = "The synthetic Jira blocker ATLAS-248 is open.";
export const atlasSpreadsheetOrigin = "https://atlas-spreadsheet.example.test";
export const atlasSpreadsheetRow = "ATLAS-DELIVERY";
export const atlasCommentTemplate = "atlas-comment@1";
export const atlasAccessStatusSchema = z.enum(["ACCESS_PENDING", "ACCESS_RESTORED"]);
export const atlasSuggestionStatusSchema = z.enum(["ACCESS_PENDING", "ACCESS_RESTORED", "NEEDS_CLARIFICATION"]);
export type AtlasAccessStatus = z.infer<typeof atlasAccessStatusSchema>;

export const atlasReplyConfirmationSchema = z.strictObject({
  responseId: z.uuid(),
  accessStatus: atlasAccessStatusSchema,
});
export const atlasCommentLimit = 500;
const atlasProposedCommentSchema = z.string().min(1).max(atlasCommentLimit)
  .regex(/^[^\p{Cc}\p{Surrogate}]+$/u)
  .refine((text) => text.trim().length > 0 && new TextEncoder().encode(text).length <= atlasCommentLimit);
export const atlasApprovalDecisionSchema = z.strictObject({
  approvalId: z.uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  proposedComment: atlasProposedCommentSchema.optional(),
}).refine((value) => value.decision === "APPROVED" || value.proposedComment === undefined, {
  path: ["proposedComment"], message: "Comment text is only accepted for approval.",
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
export const atlasScheduleSchema = projectLeadershipScheduleSchema;
export type AtlasSchedule = z.infer<typeof atlasScheduleSchema>;
export const atlasDelayClarificationCommandSchema = projectDelayClarificationCommandSchema;
export const atlasDelayClarificationSchema = projectDelayClarificationSchema;
export type AtlasDelayClarification = z.infer<typeof atlasDelayClarificationSchema>;
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
  currentComment: atlasProposedCommentSchema.nullable(),
  proposedComment: atlasProposedCommentSchema,
  sourceRevision: z.number().int().nonnegative(),
  replacesApprovalId: z.uuid().optional(),
  expiresAt: z.iso.datetime(),
  decision: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  receipt: atlasCommentReceiptSchema.nullable(),
  executionPending: z.literal(true).optional(),
  delayReview: z.strictObject({
    schedule: atlasScheduleSchema,
    assessment: atlasDelayAssessmentSchema.nullable(),
  }).nullable().optional(),
});
export type AtlasApprovalView = z.infer<typeof atlasApprovalViewSchema>;

export const atlasScheduleCitationSchema = z.strictObject({
  sourceId: z.uuid(),
  receiptId: z.uuid(),
  reviewedAt: z.iso.datetime(),
  availableUntil: z.iso.datetime(),
});
export const atlasLeadershipFactsSchema = z.strictObject({
  projectId: z.uuid(),
  asOf: z.iso.datetime(),
  schedule: atlasScheduleSchema.nullable(),
  scheduleCitation: atlasScheduleCitationSchema.optional(),
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
  delayClarificationState: z.enum(["AVAILABLE", "REQUESTED", "RESOLVED"]).optional(),
  updateFreshness: projectUpdateAssessmentViewSchema.shape.freshness.pick({
    state: true, assessedAt: true, sourceDate: true, sourceDateField: true,
  }).extend({
    openObligation: z.boolean(),
    activeClarification: z.strictObject({
      clarificationId: z.uuid(), factType: z.enum(["project.status", "project.forecast"]),
      requestedAt: z.iso.datetime(), availableUntil: z.iso.datetime(),
    }).optional(),
  }).nullable().optional(),
  integrationStart: z.strictObject({
    milestoneId: z.uuid(),
    planned: z.iso.date(),
    actual: z.iso.date(),
  }).nullable(),
  jiraBlocker: z.strictObject({
    mappingId: z.uuid(),
    issueKey: z.literal(atlasJiraBlockerKey),
    claim: settledLeadershipClaimSchema.safeExtend({ claimText: z.literal(atlasJiraBlockerClaimText),
      provenance: z.literal("SYSTEM_VERIFIED"), classification: z.literal("SYSTEM_VERIFIED") }),
  }).nullable(),
  forecastInference: z.strictObject({
    classification: z.literal("AGENT_INFERENCE"),
    scheduleRevision: atlasScheduleSchema.shape.revision,
    milestoneId: z.uuid(),
    blockerMappingId: z.uuid(),
  }).optional(),
  pmEscalation: z.strictObject({
    requestId: z.uuid(),
    capturedAt: z.iso.datetime(),
    availableUntil: z.iso.datetime(),
  }).nullable(),
  priorSnapshot: z.strictObject({
    id: z.uuid(),
    facts: atlasLeadershipFactsSchema,
  }).optional(),
}).refine(({ jiraBlocker, projectId, asOf }) => !jiraBlocker ||
  (jiraBlocker.claim.projectId === projectId && jiraBlocker.claim.assessedAt === asOf));
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
export const atlasReportApprovalRequestSchema = projectReportApprovalRequestSchema;
export const atlasReportVersionSchema = projectReportVersionSchema;
export const atlasReportDecisionSchema = projectReportDecisionSchema;
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
