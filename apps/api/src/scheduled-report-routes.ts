import type { NestExpressApplication } from "@nestjs/platform-express";
import { z } from "zod";
import {
  ProjectUpdateError, projectReportJobSchema, projectReportRenderReceiptSchema, scheduledProjectReportPaths,
  type ScheduledProjectReportRepository,
} from "@pdaa/domain";
import { verifyConnectorTaskRequest, type Config } from "@pdaa/platform";

type Request = {
  method: string;
  path: string;
  url: string;
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  get(name: string): string | undefined;
};
type Response = {
  status(code: number): Response;
  json(body: unknown): void;
};
const emptyCommand = z.strictObject({});
type TaskNonceStore = {
  acceptTaskNonce(input: {
    nonce: string; keyId: string; timestampSeconds: string; body: Uint8Array; scheduledReport: true;
  }): Promise<boolean>;
};

export function installScheduledReportRoutes(app: NestExpressApplication, config: Config,
  nonceStore: TaskNonceStore, repository: ScheduledProjectReportRepository) {
  const schedule = config.projectReportSchedule;
  const keyRing = config.projectReportTaskKeys;
  if (!schedule || !keyRing) return;
  const paths = scheduledProjectReportPaths;
  app.use(async (req: Request, res: Response, next: () => void) => {
    const { method, path, rawBody, headers } = req;
    if (method !== "POST" || (path !== paths.plan && path !== paths.prepare && path !== paths.complete)) {
      next();
      return;
    }
    if (req.url !== path || !rawBody || rawBody.byteLength > 512 ||
        !/^application\/json(?:\s*;|$)/i.test(req.get("content-type") ?? "")) {
      res.status(400).json({ statusCode: 400, message: "Invalid request" });
      return;
    }
    if (!verifyConnectorTaskRequest({ method, path, body: rawBody, headers, keyRing })) {
      res.status(401).json({ statusCode: 401, message: "Access denied" });
      return;
    }
    let command: unknown;
    try { command = JSON.parse(rawBody.toString("utf8")); }
    catch {
      res.status(400).json({ statusCode: 400, message: "Invalid request" });
      return;
    }
    const nonce = req.get("x-pdaa-task-nonce") ?? "";
    try {
      if (!await nonceStore.acceptTaskNonce({
        nonce, keyId: req.get("x-pdaa-task-key") ?? "",
        timestampSeconds: req.get("x-pdaa-task-time") ?? "", body: rawBody, scheduledReport: true,
      })) {
        res.status(409).json({ statusCode: 409, message: "Task request already used" });
        return;
      }
      if (path === paths.plan) {
        emptyCommand.parse(command);
        res.status(200).json(await repository.planScheduledProjectReports(schedule));
      } else if (path === paths.prepare) {
        const job = projectReportJobSchema.parse(command);
        res.status(200).json(await repository.prepareScheduledProjectReport(schedule, job, nonce));
      } else {
        const result = projectReportRenderReceiptSchema.parse(command);
        await repository.recordScheduledProjectReport(schedule, result, nonce);
        res.status(200).json({ recorded: true });
      }
    } catch (error) {
      if (error instanceof z.ZodError) res.status(400).json({ statusCode: 400, message: "Invalid request" });
      else if (error instanceof ProjectUpdateError && error.code === "DENIED")
        res.status(404).json({ statusCode: 404, message: "Resource unavailable" });
      else if (error instanceof ProjectUpdateError && error.code === "CONFLICT")
        res.status(409).json({ statusCode: 409, message: "Report render receipt conflicts" });
      else res.status(503).json({ statusCode: 503, message: "Service unavailable" });
    }
  });
}
