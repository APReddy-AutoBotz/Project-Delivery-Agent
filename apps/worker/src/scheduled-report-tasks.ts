import {
  preparedProjectReportSchema, projectReportJobPlanSchema, projectReportJobSchema, scheduledProjectReportPaths,
  type PreparedProjectReport, type ProjectReportJob, type ProjectReportRenderReceipt,
} from "@pdaa/domain";

type TaskHelpers = {
  addJob(name: "render_scheduled_project_report", job: ProjectReportJob, options: {
    queueName: string; jobKey: string; jobKeyMode: "unsafe_dedupe"; maxAttempts: number;
  }): Promise<unknown>;
};

export function createScheduledReportTasks(ports: {
  post(path: string, command: unknown): Promise<Response>;
  render(prepared: PreparedProjectReport): Promise<Pick<ProjectReportRenderReceipt, "sha256" | "byteLength">>;
  onFailure(event: "worker.scheduled_report_plan_failed" | "worker.scheduled_report_render_failed"): void;
}) {
  const paths = scheduledProjectReportPaths;

  return {
    schedule_project_reports: async (_payload: unknown, helpers: TaskHelpers) => {
      try {
        const jobs = projectReportJobPlanSchema.parse(await (await ports.post(paths.plan, {})).json());
        for (const job of jobs) await helpers.addJob("render_scheduled_project_report", job, {
          queueName: "project-reports", jobKey: `project-report:${job.projectId}:${job.reportingPeriod}`,
          jobKeyMode: "unsafe_dedupe", maxAttempts: 3,
        });
      } catch {
        ports.onFailure("worker.scheduled_report_plan_failed");
        throw new Error("scheduled_report_plan_failed");
      }
    },
    render_scheduled_project_report: async (payload: unknown) => {
      try {
        const job = projectReportJobSchema.parse(payload);
        const prepared = preparedProjectReportSchema.nullable().parse(await (await ports.post(paths.prepare, job)).json());
        if (!prepared) return;
        const { snapshotId, draft } = prepared;
        if (draft.projectId !== job.projectId || draft.reportingPeriod !== job.reportingPeriod)
          throw new Error("scheduled_report_scope_changed");
        const artifact = await ports.render(prepared);
        const receipt = await ports.post(paths.complete, { ...job, snapshotId, ...artifact });
        await receipt.body?.cancel();
      } catch {
        ports.onFailure("worker.scheduled_report_render_failed");
        throw new Error("scheduled_report_render_failed");
      }
    },
  };
}
