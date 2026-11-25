import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";

export const atlasApprovalProjectCode = "ATLAS-APPROVAL-DEMO";
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
});
export type AtlasApprovalView = z.infer<typeof atlasApprovalViewSchema>;

export const atlasLeadershipAnswerSchema = z.strictObject({
  projectId: z.uuid(),
  asOf: z.iso.datetime(),
  schedule: z.strictObject({
    revision: z.number().int().min(1),
    baseline: z.iso.date().nullable(),
    forecast: z.iso.date().nullable(),
    movementDays: z.number().int().nullable(),
  }).nullable(),
  ownerReply: z.strictObject({
    responseId: z.uuid(),
    receivedAt: z.iso.datetime(),
    availableUntil: z.iso.datetime(),
    accessStatus: atlasAccessStatusSchema,
  }).nullable(),
  receipt: atlasCommentReceiptSchema.nullable(),
});
export type AtlasLeadershipAnswer = z.infer<typeof atlasLeadershipAnswerSchema>;

export const atlasManagementFactsSchema = atlasLeadershipAnswerSchema.extend({
  schedule: atlasLeadershipAnswerSchema.shape.schedule.unwrap(),
  ownerReply: atlasLeadershipAnswerSchema.shape.ownerReply.unwrap(),
  receipt: atlasCommentReceiptSchema,
});
export const atlasManagementSnapshotSchema = atlasManagementFactsSchema.extend({
  id: z.uuid(),
  reportingPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  approvalState: z.literal("DRAFT"),
  classification: z.literal("SYNTHETIC_INTERNAL"),
});
export type AtlasManagementSnapshot = z.infer<typeof atlasManagementSnapshotSchema>;
export const atlasManagementOutputSchema = z.strictObject({
  snapshot: atlasManagementSnapshotSchema,
  highlights: z.array(z.string().min(1).max(240)).length(4),
  livePath: z.string().regex(/^\/\?project=[0-9a-f-]{36}$/u),
  powerpointBase64: z.string().max(196608).regex(/^UEsDB[A-Za-z0-9+/]+={0,2}$/u),
});
export type AtlasManagementOutput = z.infer<typeof atlasManagementOutputSchema>;

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
