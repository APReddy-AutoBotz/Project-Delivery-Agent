import { describe, expect, it, vi } from "vitest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Config } from "@pdaa/platform";
import { signConnectorTaskRequest } from "../packages/platform/src/connector-task-auth.js";
import { installConnectorRoutes } from "../apps/api/src/connector-routes.js";

describe("connector webhook route authentication order", () => {
  it("passes an accepted signed dispatch nonce to the configured customer's Jira runtime once", async () => {
    const handlers: unknown[] = [];
    const app = { use: (handler: unknown) => handlers.push(handler) } as unknown as NestExpressApplication;
    const runOne = vi.fn().mockResolvedValue({ status: "page_committed" });
    const runtime = {
      acceptTaskNonce: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      acceptWebhook: vi.fn(),
    };
    const customerId = "13f95d34-1588-4d31-8f2e-40a213d37c91";
    const keyRing = {
      currentKeyId: "connector-test",
      keys: { "connector-test": Buffer.alloc(32, 9).toString("base64url") },
    };
    installConnectorRoutes(
      app, { CUSTOMER_ID: customerId, connectorTaskKeys: keyRing } as Config,
      runtime, { runOne } as never,
    );
    const path = "/internal/connectors/run";
    const rawBody = Buffer.from("{}");
    const signed = signConnectorTaskRequest({ method: "POST", path, body: rawBody, keyRing });
    const headers: Record<string, string> = { "content-type": "application/json", ...signed };
    const req = { method: "POST", path, url: path, rawBody, headers, get: (name: string) => headers[name] };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const handler = handlers[0] as (request: typeof req, response: typeof res, next: () => void) => Promise<void>;
    await handler(req, res, vi.fn());
    expect(runtime.acceptTaskNonce).toHaveBeenCalledWith({
      nonce: signed["x-pdaa-task-nonce"],
      keyId: signed["x-pdaa-task-key"],
      timestampSeconds: signed["x-pdaa-task-time"],
      body: rawBody,
      dispatchCustomerId: customerId,
    });
    expect(runOne).toHaveBeenCalledWith(signed["x-pdaa-task-nonce"]);
    expect(res.status).toHaveBeenLastCalledWith(200);
    await handler(req, res, vi.fn());
    expect(res.status).toHaveBeenLastCalledWith(409);
    expect(runOne).toHaveBeenCalledTimes(1);
  });

  it("dispatches the signed scheduled content purge once", async () => {
    const handlers: unknown[] = [];
    const app = { use: (handler: unknown) => handlers.push(handler) } as unknown as NestExpressApplication;
    const runtime = {
      acceptTaskNonce: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      acceptWebhook: vi.fn(),
    };
    const keyRing = {
      currentKeyId: "retention-test",
      keys: { "retention-test": Buffer.alloc(32, 17).toString("base64url") },
    };
    const purgeCaptureContent = vi.fn().mockResolvedValue(2);
    installConnectorRoutes(app, { projectUpdateTaskKeys: keyRing } as Config, runtime,
      {} as never, { purgeCaptureContent } as never);
    const path = "/internal/project-updates/purge";
    const rawBody = Buffer.from("{}");
    const headers: Record<string, string> = { "content-type": "application/json" };
    const req = { method: "POST", path, url: path, rawBody, headers, get: (name: string) => headers[name] };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const handler = handlers[0] as (request: typeof req, response: typeof res, next: () => void) => Promise<void>;
    const next = vi.fn();

    await handler(req, res, next);
    expect(res.status).toHaveBeenLastCalledWith(401);
    expect(runtime.acceptTaskNonce).not.toHaveBeenCalled();
    expect(purgeCaptureContent).not.toHaveBeenCalled();

    Object.assign(headers, signConnectorTaskRequest({ method: "POST", path, body: rawBody, keyRing }));
    await handler(req, res, next);
    expect(res.status).toHaveBeenLastCalledWith(200);
    expect(res.json).toHaveBeenLastCalledWith({ processed: 2 });
    await handler(req, res, next);
    expect(res.status).toHaveBeenLastCalledWith(409);
    expect(purgeCaptureContent).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes bounded raw bytes to signature verification before parsing JSON", async () => {
    const middleware: unknown[] = [];
    const app = {
      use(handler: unknown) {
        middleware.push(handler);
      },
    } as unknown as NestExpressApplication;
    const runtime = {
      acceptTaskNonce: vi.fn(),
      acceptWebhook: vi.fn().mockRejectedValue({ code: "INVALID_WEBHOOK" }),
    };
    const config = {} as unknown as Config;
    installConnectorRoutes(app, config, runtime, {} as never);

    const rawBody = Buffer.from('{"webhookEvent":"jira:issue_updated"}', "utf8");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-atlassian-webhook-identifier": "event-123",
      "x-hub-signature": `sha256=${"0".repeat(64)}`,
    };
    let responseCode = 0;
    const response = {
      status(code: number) {
        responseCode = code;
        return this;
      },
      json: vi.fn(),
    };
    const next = vi.fn();
    const request = {
      method: "POST",
      path: "/webhooks/jira/13f95d34-1588-4d31-8f2e-40a213d37c91",
      url: "/webhooks/jira/13f95d34-1588-4d31-8f2e-40a213d37c91",
      rawBody,
      body: "this field remains text and is deliberately not parsed",
      headers,
      get: (name: string) => headers[name.toLowerCase()],
    };
    const handler = middleware[0] as (
      request: {
        method: string;
        path: string;
        url: string;
        rawBody: Buffer;
        body: string;
        headers: Record<string, string>;
        get(name: string): string | undefined;
      },
      response: { status(code: number): unknown; json(body: unknown): void },
      next: () => void,
    ) => Promise<void>;

    await handler(request, response, next);

    expect(responseCode).toBe(401);
    expect(runtime.acceptWebhook).toHaveBeenCalledWith({
      sourceId: "13f95d34-1588-4d31-8f2e-40a213d37c91",
      eventId: "event-123",
      signature: headers["x-hub-signature"],
      rawBody,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
