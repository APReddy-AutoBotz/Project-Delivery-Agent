import type { NestExpressApplication } from "@nestjs/platform-express";
import { z } from "zod";
import type { Config } from "@pdaa/platform";
import { verifyConnectorTaskRequest } from "@pdaa/platform";
import type { JiraRuntimeService } from "./jira-runtime.js";
import type { ProjectUpdateRepository } from "@pdaa/domain";

const eventIdSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
type ConnectorRequest = {
  method: string;
  path: string;
  url: string;
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  get(name: string): string | undefined;
};
type ConnectorResponse = {
  status(code: number): ConnectorResponse;
  json(body: unknown): void;
};
type Next = () => void;
type ConnectorHttpRuntimePort = {
  acceptTaskNonce(input: {
    nonce: string;
    keyId: string;
    timestampSeconds: string;
    body: Uint8Array;
  }): Promise<boolean>;
  acceptWebhook(input: {
    sourceId: string;
    eventId: string;
    signature: string;
    rawBody: Uint8Array;
  }): Promise<{ replayed: boolean }>;
};

function hasCode(error: unknown, code: string) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function fixedError(response: ConnectorResponse, status: number, message: string) {
  response.status(status).json({ statusCode: status, message });
}

export function installConnectorRoutes(
  app: NestExpressApplication,
  config: Config,
  runtime: ConnectorHttpRuntimePort,
  jira: JiraRuntimeService,
  projectUpdates?: ProjectUpdateRepository,
) {
  app.use(async (request: ConnectorRequest, response: ConnectorResponse, next: Next) => {
    const req = request;
    const pathname = req.path;
    const rawBody = req.rawBody;
    if (req.method !== "POST" || (!pathname.startsWith("/internal/connectors/") && !pathname.startsWith("/internal/project-updates/") && !pathname.startsWith("/webhooks/jira/"))) {
      next();
      return;
    }
    if (pathname !== "/internal/connectors/run" && pathname !== "/internal/project-updates/scan" && pathname !== "/internal/project-updates/process" && !/^\/webhooks\/jira\/[0-9a-f-]{36}$/i.test(pathname)) {
      fixedError(response, 404, "Resource unavailable");
      return;
    }
    if (req.url !== pathname || !rawBody || rawBody.byteLength > 1_048_576 || !/^application\/json(?:\s*;|$)/i.test(req.get("content-type") ?? "")) {
      fixedError(response, 400, "Invalid request");
      return;
    }
    if (pathname === "/internal/connectors/run") {
      const headers = req.headers as Record<string, string | string[] | undefined>;
      if (!verifyConnectorTaskRequest({
        method: req.method,
        path: pathname,
        body: rawBody,
        headers,
        keyRing: config.connectorTaskKeys,
      })) {
        fixedError(response, 401, "Access denied");
        return;
      }
      if (rawBody.byteLength > 64) {
        fixedError(response, 400, "Invalid request");
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8")) as unknown;
      } catch {
        fixedError(response, 400, "Invalid request");
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
        fixedError(response, 400, "Invalid request");
        return;
      }
      try {
        const nonce = req.get("x-pdaa-task-nonce") ?? "";
        const keyId = req.get("x-pdaa-task-key") ?? "";
        const timestampSeconds = req.get("x-pdaa-task-time") ?? "";
        if (!(await runtime.acceptTaskNonce({ nonce, keyId, timestampSeconds, body: rawBody }))) {
          fixedError(response, 409, "Task request already used");
          return;
        }
        response.status(200).json(await jira.runOne());
      } catch {
        fixedError(response, 503, "Service unavailable");
      }
      return;
    }
    if (pathname === "/internal/project-updates/scan" || pathname === "/internal/project-updates/process" || pathname === "/internal/project-updates/purge") {
      const headers = req.headers as Record<string, string | string[] | undefined>;
      if (!config.projectUpdateTaskKeys || !projectUpdates || !verifyConnectorTaskRequest({
        method: req.method,
        path: pathname,
        body: rawBody,
        headers,
        keyRing: config.projectUpdateTaskKeys,
      })) {
        fixedError(response, 401, "Access denied");
        return;
      }
      if (rawBody.byteLength > 64) {
        fixedError(response, 400, "Invalid request");
        return;
      }
      let body: unknown;
      try { body = JSON.parse(rawBody.toString("utf8")) as unknown; }
      catch { fixedError(response, 400, "Invalid request"); return; }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
        fixedError(response, 400, "Invalid request");
        return;
      }
      try {
        const nonce = req.get("x-pdaa-task-nonce") ?? "";
        const keyId = req.get("x-pdaa-task-key") ?? "";
        const timestampSeconds = req.get("x-pdaa-task-time") ?? "";
        if (!(await runtime.acceptTaskNonce({ nonce, keyId, timestampSeconds, body: rawBody }))) {
          fixedError(response, 409, "Task request already used");
          return;
        }
        response.status(200).json({ processed: pathname === "/internal/project-updates/process"
          ? await projectUpdates.processEngagements(1)
          : pathname === "/internal/project-updates/purge"
            ? await projectUpdates.purgeCaptureContent()
            : await projectUpdates.scanScheduledProjects(1) });
      } catch {
        fixedError(response, 503, "Service unavailable");
      }
      return;
    }
    const match = /^\/webhooks\/jira\/([0-9a-f-]{36})$/i.exec(pathname);
    if (!match) {
      fixedError(response, 404, "Resource unavailable");
      return;
    }
    const eventId = eventIdSchema.safeParse(req.get("x-atlassian-webhook-identifier"));
    const signature = req.get("x-hub-signature");
    if (!eventId.success || !signature) {
      fixedError(response, 401, "Access denied");
      return;
    }
    try {
      const result = await runtime.acceptWebhook({
        sourceId: match[1]!,
        eventId: eventId.data,
        signature,
        rawBody,
      });
      response.status(202).json({ accepted: true, replayed: result.replayed });
    } catch (error) {
      if (hasCode(error, "CONFLICT")) {
        fixedError(response, 409, "Webhook conflicts with a stored receipt");
        return;
      }
      if (hasCode(error, "NOT_FOUND")) {
        fixedError(response, 404, "Resource unavailable");
        return;
      }
      if (hasCode(error, "INVALID_WEBHOOK")) {
        fixedError(response, 401, "Access denied");
        return;
      }
      fixedError(response, 503, "Service unavailable");
    }
  });
}
