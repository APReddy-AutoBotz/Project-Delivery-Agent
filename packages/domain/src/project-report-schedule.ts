import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";
import { projectManagementDraftSchema, projectManagementSnapshotSchema } from "./project-management-draft.js";

export const scheduledProjectReportPaths = {
  plan: "/internal/project-reports/plan",
  prepare: "/internal/project-reports/prepare",
  complete: "/internal/project-reports/complete",
} as const;

export const projectReportScheduleSchema = z.strictObject({
  customerId: z.uuid(),
  portfolioId: z.uuid(),
  serviceSubject: canonicalSubjectSchema,
  dayOfMonth: z.number().int().min(1).max(28),
  hourUtc: z.number().int().min(0).max(23),
});
export type ProjectReportSchedule = z.infer<typeof projectReportScheduleSchema>;

export const projectReportJobSchema = z.strictObject({
  projectId: z.uuid(),
  reportingPeriod: projectManagementDraftSchema.shape.reportingPeriod,
});
export type ProjectReportJob = z.infer<typeof projectReportJobSchema>;

export const projectReportJobPlanSchema = z.array(projectReportJobSchema).max(200);
export const preparedProjectReportSchema = projectManagementSnapshotSchema.pick({ snapshotId: true, draft: true });
export type PreparedProjectReport = z.infer<typeof preparedProjectReportSchema>;

export const projectReportRenderReceiptSchema = projectReportJobSchema.extend({
  snapshotId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byteLength: z.number().int().min(1).max(120_000),
});
export type ProjectReportRenderReceipt = z.infer<typeof projectReportRenderReceiptSchema>;

export interface ScheduledProjectReportRepository {
  planScheduledProjectReports(schedule: ProjectReportSchedule): Promise<ProjectReportJob[]>;
  prepareScheduledProjectReport(schedule: ProjectReportSchedule, job: ProjectReportJob, correlationId: string): Promise<PreparedProjectReport | null>;
  recordScheduledProjectReport(schedule: ProjectReportSchedule, result: ProjectReportRenderReceipt, correlationId: string): Promise<void>;
}
