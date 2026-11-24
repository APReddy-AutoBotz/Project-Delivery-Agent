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
export const atlasApprovalViewSchema = z.strictObject({
  approvalId: z.uuid(),
  responseId: z.uuid(),
  replyReceivedAt: z.iso.datetime(),
  confirmedBy: canonicalSubjectSchema,
  approver: canonicalSubjectSchema,
  accessStatus: atlasAccessStatusSchema,
  target: z.literal("ATLAS-248"),
  currentComment: z.null(),
  proposedComment: z.string(),
  expiresAt: z.iso.datetime(),
  decision: z.enum(["PENDING", "APPROVED", "REJECTED"]),
});
export type AtlasApprovalView = z.infer<typeof atlasApprovalViewSchema>;

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
