import { describe, expect, it, vi } from "vitest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Config } from "@pdaa/platform";
import { installConnectorRoutes } from "../apps/api/src/connector-routes.js";

describe("connector webhook route authentication order", () => {
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
