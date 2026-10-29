import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { buildPmActionQueue, PmActionQueueError } from "../packages/domain/dist/index.js";
import { compileContract } from "../scripts/validate-openapi.mjs";

const customerId = "10000000-0000-4000-8000-000000000001";
const actor = { customerId, subject: "synthetic-pm", roles: ["project_manager"] };
const queue = { read: vi.fn(async () => buildPmActionQueue([])) };
const identity = { authenticate: vi.fn(async (token: string) => { if (token !== "valid") throw new Error("invalid"); return actor; }) };
const config = loadConfig({ NODE_ENV: "test", DATA_MODE: "synthetic", AUTH_MODE: "development", CUSTOMER_ID: customerId,
  // Config validation only: createApp receives fakes and never creates a database client.
  APP_ORIGIN: "http://localhost:5173", PDAA_DATABASE_URL: "postgresql://pdaa:synthetic@127.0.0.1:55432/pdaa_test_9",
  SESSION_SECRET: "s".repeat(64), ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SHADOW_MODE: "true" });
let app: Awaited<ReturnType<typeof createApp>>["app"], base: string, contract: ReturnType<typeof compileContract>;
beforeAll(async () => {
  const created = await createApp(config, {} as never, identity as never, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, queue as never);
  app = created.app; contract = compileContract(created.spec); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });

it("serves a validated no-store queue without accepting caller scope", async () => {
  const response = await fetch(base + "/api/pm/action-queue", { headers: { Authorization: "Bearer valid" } });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(contract.response("GET", "/api/pm/action-queue", 200, response.headers.get("content-type"), text)).toEqual(buildPmActionQueue([]));
  expect(queue.read).toHaveBeenCalledWith(actor);
  const calls = queue.read.mock.calls.length;
  const invalid = await fetch(base + "/api/pm/action-queue?projectId=other", { headers: { Authorization: "Bearer valid" } });
  expect(invalid.status).toBe(400); expect(invalid.headers.get("cache-control")).toBe("no-store");
  expect(queue.read).toHaveBeenCalledTimes(calls);
});
it("returns private authentication, denial and unavailable responses", async () => {
  const before = queue.read.mock.calls.length;
  for (const headers of [{}, { Authorization: "Bearer invalid" }]) {
    const unauthorized = await fetch(base + "/api/pm/action-queue", { headers });
    expect(unauthorized.status).toBe(401); expect(unauthorized.headers.get("cache-control")).toBe("no-store");
  }
  expect(queue.read).toHaveBeenCalledTimes(before);
  queue.read.mockRejectedValueOnce(new PmActionQueueError("DENIED"));
  const denied = await fetch(base + "/api/pm/action-queue", { headers: { Authorization: "Bearer valid" } });
  expect(denied.status).toBe(404); expect(denied.headers.get("cache-control")).toBe("no-store"); expect(await denied.text()).not.toContain(customerId);
  queue.read.mockRejectedValueOnce(new PmActionQueueError("UNAVAILABLE"));
  const unavailable = await fetch(base + "/api/pm/action-queue", { headers: { Authorization: "Bearer valid" } });
  expect(unavailable.status).toBe(503); expect(unavailable.headers.get("cache-control")).toBe("no-store"); expect(await unavailable.text()).not.toContain(customerId);
});
it("does not expose invalid results or unexpected private errors", async () => {
  queue.read.mockResolvedValueOnce({ privateMarker: "synthetic-private-marker" } as never);
  const malformed = await fetch(base + "/api/pm/action-queue", { headers: { Authorization: "Bearer valid" } });
  expect(malformed.status).toBe(500); expect(malformed.headers.get("cache-control")).toBe("no-store");
  expect(await malformed.text()).not.toContain("synthetic-private-marker");
  queue.read.mockRejectedValueOnce(new Error("synthetic-private-error"));
  const failure = await fetch(base + "/api/pm/action-queue", { headers: { Authorization: "Bearer valid" } });
  expect(failure.status).toBe(500); expect(failure.headers.get("cache-control")).toBe("no-store");
  expect(await failure.text()).not.toContain("synthetic-private-error");
});
