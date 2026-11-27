import { z } from "zod";
import { projectLeadershipFactsSchema } from "./project-leadership-answer.js";

const projectLabel = z.string().min(1).max(160)
  .refine((value) => value.trim().length > 0 && !/[\p{Cc}\p{Surrogate}]/u.test(value));

export const projectManagementDraftSchema = projectLeadershipFactsSchema.extend({
  project: z.strictObject({ code: projectLabel, name: projectLabel }),
  approvalState: z.literal("DRAFT"),
  reportingPeriod: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
});
export type ProjectManagementDraft = z.infer<typeof projectManagementDraftSchema>;

export const projectReportApprovalRequestSchema = z.strictObject({ snapshotId: z.uuid() });
export const projectReportVersionSchema = projectReportApprovalRequestSchema.extend({ requestId: z.uuid() });
export type ProjectReportVersion = z.infer<typeof projectReportVersionSchema>;
export const projectReportDeliverySchema = projectReportVersionSchema.extend({ id: z.uuid(), deliveredAt: z.iso.datetime() });
export type ProjectReportDelivery = z.infer<typeof projectReportDeliverySchema>;
export const projectReportDecisionSchema = projectReportVersionSchema.extend({ decision: z.enum(["APPROVED", "REJECTED"]) });
export type ProjectReportDecision = z.infer<typeof projectReportDecisionSchema>;

const reportApproval = z.strictObject({ requestId: z.uuid(), requestedAt: z.iso.datetime() });
export const projectReportApprovalSchema = z.discriminatedUnion("state", [
  reportApproval.extend({ state: z.literal("PENDING"), decidedAt: z.null() }),
  reportApproval.extend({ state: z.enum(["APPROVED", "REJECTED"]), decidedAt: z.iso.datetime() }),
]);
export type ProjectReportApproval = z.infer<typeof projectReportApprovalSchema>;

export const projectManagementSnapshotSchema = z.strictObject({
  snapshotId: z.uuid(),
  draft: projectManagementDraftSchema,
  approval: projectReportApprovalSchema.optional(),
  delivery: projectReportDeliverySchema.optional(),
});
export type ProjectManagementSnapshot = z.infer<typeof projectManagementSnapshotSchema>;
export const projectManagementSnapshotSelectorSchema = z.union([z.uuid(), z.literal("latest"), z.literal("delivered")]);

export const projectManagementDraftOutputSchema = z.strictObject({
  draft: projectManagementDraftSchema,
  snapshotId: z.uuid().optional(),
  approval: projectReportApprovalSchema.optional(),
  delivery: projectReportDeliverySchema.optional(),
  highlights: z.array(z.string().min(1).max(400)).min(1).max(4),
  livePath: z.string().min(1).max(64),
  powerpointBase64: z.string().max(160_000).regex(/^UEsDB[A-Za-z0-9+/]+={0,2}$/u)
    .refine((value) => value.length % 4 === 0),
});
export type ProjectManagementDraftOutput = z.infer<typeof projectManagementDraftOutputSchema>;
