// FR-ESC-006 / NFR-SEC-001: the worker has only a signed, bounded API invocation.
import { describe, expect, it, vi } from "vitest";
import { createTasks } from "../apps/worker/src/tasks.js";
import { installConnectorRoutes } from "../apps/api/src/connector-routes.js";
import { signConnectorTaskRequest } from "../packages/platform/src/index.js";
import type { Config } from "../packages/platform/src/index.js";
const path = "/internal/project-updates/process";
const keyRing = { currentKeyId: "engagement", keys: { engagement: Buffer.alloc(32, 19).toString("base64url") } };
describe("engagement task", () => {
  it("sends only an empty signed command to the exact internal path", async () => {
    const network = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const signer = vi.fn(signConnectorTaskRequest);
    const tasks = createTasks({ recordHeartbeat: async () => undefined }, {
      INTERNAL_API_URL: "https://customer-api.invalid", projectUpdateTaskKeys: keyRing,
    }, network, signer);
    await tasks.project_update_engagement_dispatch();
    expect(signer.mock.calls[0]![0]).toMatchObject({ method: "POST", path, body: Buffer.from("{}"), keyRing });
    expect(network).toHaveBeenCalledWith(new URL(path, "https://customer-api.invalid"), expect.objectContaining({
      body: Buffer.from("{}"), method: "POST", redirect: "error",
    }));
  });
  it("stays inactive without task authentication and reports bounded failures", async () => {
    const network = vi.fn().mockRejectedValue(new Error("private request data")) as unknown as typeof fetch;
    await createTasks({ recordHeartbeat: async () => undefined }, {}, network).project_update_engagement_dispatch();
    expect(network).not.toHaveBeenCalled();
    await expect(createTasks({ recordHeartbeat: async () => undefined }, {
      INTERNAL_API_URL: "https://customer-api.invalid", projectUpdateTaskKeys: keyRing,
    }, network, signConnectorTaskRequest).project_update_engagement_dispatch()).rejects.toThrow(/^project_update_engagement_unavailable$/);
  });
});
describe("signed engagement endpoint", () => {
  function fixture() {
    let handler: (request: unknown, response: unknown, next: () => void) => Promise<void>;
    const runtime = { acceptTaskNonce: vi.fn().mockResolvedValue(true), acceptWebhook: vi.fn() };
    const updates = { processShadowEngagements: vi.fn().mockResolvedValue(1), scanScheduledProjects: vi.fn() };
    installConnectorRoutes({ use: (fn: typeof handler) => { handler = fn; } } as never,
      { projectUpdateTaskKeys: keyRing } as Config, runtime, {} as never, updates as never);
    return { runtime, updates, invoke: async (body = "{}", signaturePath = path, url = path) => {
      const rawBody = Buffer.from(body);
      const headers = { ...signConnectorTaskRequest({ method: "POST", path: signaturePath, body: rawBody, keyRing }),
        "content-type": "application/json" };
      let status = 0;
      const json = vi.fn();
      await handler!({ method: "POST", path, url, rawBody, headers,
        get: (name: string) => headers[name as keyof typeof headers] }, {
        status: (code: number) => { status = code; return { json }; }, json,
      }, vi.fn());
      return { status, json };
    } };
  }
  it("verifies the path-bound signature and replay receipt before fixed-limit processing", async () => {
    const f = fixture();
    expect((await f.invoke()).status).toBe(200);
    expect(f.runtime.acceptTaskNonce).toHaveBeenCalledTimes(1);
    expect(f.updates.processShadowEngagements).toHaveBeenCalledWith(1);
    expect(f.updates.scanScheduledProjects).not.toHaveBeenCalled();
    f.runtime.acceptTaskNonce.mockResolvedValue(false);
    expect((await f.invoke()).status).toBe(409);
    expect(f.updates.processShadowEngagements).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['{"limit":1000}', path, path, 400],
    ["{}", "/internal/project-updates/scan", path, 401],
    ["{}", path, path + "?projectId=forged", 400],
  ])("rejects caller-selected work or another endpoint signature", async (body, signedPath, url, status) => {
    const f = fixture();
    expect((await f.invoke(body as string, signedPath as string, url as string)).status).toBe(status);
    expect(f.runtime.acceptTaskNonce).not.toHaveBeenCalled();
    expect(f.updates.processShadowEngagements).not.toHaveBeenCalled();
  });
});
