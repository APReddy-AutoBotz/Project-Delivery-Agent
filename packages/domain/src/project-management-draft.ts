import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";
import { projectLeadershipFactsSchema, projectLeadershipScheduleSchema } from "./project-leadership-answer.js";

const reportLabel = (max: number) => z.string().min(1).max(max)
  .refine((value) => value.trim().length > 0 && !/[\p{Cc}\p{Surrogate}]/u.test(value));

export const projectReportDigestSchema = z.strictObject({
  previousReport: z.strictObject({
    snapshotId: z.uuid(), asOf: z.iso.datetime(), schedule: projectLeadershipScheduleSchema.nullable(),
    freshnessState: projectLeadershipFactsSchema.shape.updateFreshness.unwrap().shape.state.nullable(),
  }).nullable(),
  decisions: z.array(z.strictObject({ key: reportLabel(48), title: reportLabel(160) })).max(3),
  moreDecisions: z.boolean(),
});

export const projectManagementDraftSchema = projectLeadershipFactsSchema.extend({
  project: z.strictObject({ code: reportLabel(160), name: reportLabel(160) }),
  approvalState: z.literal("DRAFT"),
  reportingPeriod: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  digest: projectReportDigestSchema.optional(),
});
export type ProjectManagementDraft = z.infer<typeof projectManagementDraftSchema>;

export const projectReportApprovalRequestSchema = z.strictObject({ snapshotId: z.uuid() });
export const projectReportVersionSchema = projectReportApprovalRequestSchema.extend({ requestId: z.uuid() });
export type ProjectReportVersion = z.infer<typeof projectReportVersionSchema>;
export const projectReportDeliverySchema = projectReportVersionSchema.extend({ id: z.uuid(), deliveredAt: z.iso.datetime() });
export type ProjectReportDelivery = z.infer<typeof projectReportDeliverySchema>;
export const projectReportDecisionSchema = projectReportVersionSchema.extend({ decision: z.enum(["APPROVED", "REJECTED"]) });
export type ProjectReportDecision = z.infer<typeof projectReportDecisionSchema>;

export const projectReportEvents = {
  draftSaved: "project_report.draft.saved",
  approvalRequested: "project_report.approval.requested",
  decisionRecorded: "project_report.approval.decided",
  delivered: "project_report.delivered",
} as const;
const reportAuditEvent = z.enum(projectReportEvents);
export const projectReportAuditSearchSchema = z.strictObject({
  actor: canonicalSubjectSchema.optional(), event: reportAuditEvent.optional(), after: z.uuid().optional(),
  from: z.iso.datetime({ precision: 3 }).optional(), until: z.iso.datetime({ precision: 3 }).optional(),
}).refine(({ from, until }) =>
  !from?.startsWith("0000") && !until?.startsWith("0000") && (!from || !until || from < until));
export type ProjectReportAuditSearch = z.infer<typeof projectReportAuditSearchSchema>;
export const projectReportAuditPageSize = 30;
export const projectReportAuditPageSchema = z.strictObject({
  projectId: z.uuid(), next: z.uuid().nullable(),
  entries: z.array(z.strictObject({
    id: z.uuid(), snapshotId: z.uuid(), actor: canonicalSubjectSchema, event: reportAuditEvent,
    occurredAt: z.iso.datetime({ precision: 3 }), correlationId: z.uuid(),
    decision: z.union([projectReportDecisionSchema.shape.decision, z.null()]),
  })).max(projectReportAuditPageSize),
});
export type ProjectReportAuditPage = z.infer<typeof projectReportAuditPageSchema>;

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
  digestHighlights: z.array(reportLabel(400)).min(2).max(8).optional(),
  livePath: z.string().min(1).max(64),
  powerpointBase64: z.string().max(160_000).regex(/^UEsDB[A-Za-z0-9+/]+={0,2}$/u)
    .refine((value) => value.length % 4 === 0),
});
export type ProjectManagementDraftOutput = z.infer<typeof projectManagementDraftOutputSchema>;
