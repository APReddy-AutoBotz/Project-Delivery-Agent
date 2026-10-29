import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { ScalarConflictObservationError } from "../packages/domain/dist/index.js";
import { compileContract } from "../scripts/validate-openapi.mjs";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = id(1), projectId = id(2), factId = id(3);
const actor = { customerId, subject: "synthetic-leader", roles: ["leadership"] };
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20),
  provenance: "HUMAN_CONFIRMED" as const, effectiveAt: "2026-01-01T00:00:00.000Z", observedAt: "2026-01-01T00:00:00.000Z",
  versionValidUntil: "2027-01-01T00:00:00.000Z", assessedValidUntil: "2027-01-01T00:00:00.000Z" });
const result = { projectId, factId, factType: "project.forecast", asOf: "2026-10-01T00:00:00.000Z", policyRevisionId: id(4),
  positions: [{ value: "2026-10-01", supports: [support(5)] }, { value: "2026-10-02", supports: [support(6)] }] };
const repository = { readLeadership: vi.fn(async () => result) };
const identity = { authenticate: vi.fn(async (token: string) => { if (token !== "valid") throw new Error("private"); return actor; }) };
const config = loadConfig({ NODE_ENV: "test", DATA_MODE: "synthetic", AUTH_MODE: "development", CUSTOMER_ID: customerId,
  APP_ORIGIN: "http://localhost:5173", PDAA_DATABASE_URL: "postgresql://pdaa:synthetic@127.0.0.1:55432/pdaa_test_9",
  SESSION_SECRET: "s".repeat(64), ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SHADOW_MODE: "true" });
let app: Awaited<ReturnType<typeof createApp>>["app"], base: string, contract: ReturnType<typeof compileContract>;
beforeAll(async () => {
  const created = await createApp(config, {} as never, identity as never, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, repository as never);
  app = created.app; contract = compileContract(created.spec); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });
const path = `/api/projects/${projectId}/fact-observations/${factId}/leadership-conflict`;
it("authenticates, binds IDs and forbids unrecognized parameters", async () => {
  const headers = { Authorization: "Bearer valid" }, response = await fetch(base + path, { headers });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result); expect(repository.readLeadership).toHaveBeenCalledWith(actor, projectId, factId);
  const route = "/api/projects/{id}/fact-observations/{factId}/leadership-conflict";
  expect(contract.response("GET", route, 200, "application/json", JSON.stringify(result))).toEqual(result);
  const calls = repository.readLeadership.mock.calls.length;
  expect((await fetch(base + path + "?cursor=one", { headers })).status).toBe(400);
  expect((await fetch(base + path.replace(factId, "invalid"), { headers })).status).toBe(404);
  expect((await fetch(base + path)).status).toBe(401);
  expect((await fetch(base + path, { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
  expect(repository.readLeadership).toHaveBeenCalledTimes(calls);
});
it("withholds denial, unavailable state and malformed or mismatched outputs", async () => {
  repository.readLeadership.mockRejectedValueOnce(new ScalarConflictObservationError("DENIED"));
  repository.readLeadership.mockRejectedValueOnce(new ScalarConflictObservationError("UNAVAILABLE"));
  repository.readLeadership.mockResolvedValueOnce({ ...result, privateMarker: "synthetic-private-marker" } as never);
  repository.readLeadership.mockResolvedValueOnce({ ...result, factId: customerId } as never);
  repository.readLeadership.mockRejectedValueOnce(new Error("synthetic-private-error"));
  for (const status of [404, 503, 503, 503, 503]) {
    const response = await fetch(base + path, { headers: { Authorization: "Bearer valid" } });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text(); expect(body).not.toContain("synthetic-private-marker"); expect(body).not.toContain("synthetic-private-error");
  }
});
