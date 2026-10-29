import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { BlockerAgeAdviceError, buildBlockerAgeAdvice } from "../packages/domain/dist/index.js";
import { compileContract } from "../scripts/validate-openapi.mjs";

const customerId = "10000000-0000-4000-8000-000000000001", projectId = "20000000-0000-4000-8000-000000000001";
const actor = { customerId, subject: "synthetic-leader", roles: ["leadership"] };
const result = buildBlockerAgeAdvice({ projectId, audience: "leadership", asOf: "2026-10-21T11:00:00.000Z",
  coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, candidates: [] });
const repository = { readLeadership: vi.fn(async () => result) };
const identity = { authenticate: vi.fn(async (token: string) => { if (token !== "valid") throw new Error("private"); return actor; }) };
const config = loadConfig({ NODE_ENV: "test", DATA_MODE: "synthetic", AUTH_MODE: "development", CUSTOMER_ID: customerId,
  APP_ORIGIN: "http://localhost:5173", PDAA_DATABASE_URL: "postgresql://pdaa:synthetic@127.0.0.1:55432/pdaa_test_9",
  SESSION_SECRET: "s".repeat(64), ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SHADOW_MODE: "true" });
let app: Awaited<ReturnType<typeof createApp>>["app"], base: string, contract: ReturnType<typeof compileContract>;
beforeAll(async () => {
  const created = await createApp(config, {} as never, identity as never, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, repository as never);
  app = created.app; contract = compileContract(created.spec); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });
const path = `/api/projects/${projectId}/leadership-blocker-age-suggestions`;
it("authenticates and validates the project and query without accepting an audience", async () => {
  const headers = { Authorization: "Bearer valid" };
  const response = await fetch(base + path, { headers });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(contract.response("GET", "/api/projects/{id}/leadership-blocker-age-suggestions", 200,
    response.headers.get("content-type"), await response.text())).toEqual(result);
  for (const invalid of [{ ...result, audience: "project_manager" }, { ...result, privateMarker: "synthetic-private-marker" }])
    expect(() => contract.response("GET", "/api/projects/{id}/leadership-blocker-age-suggestions", 200,
      "application/json", JSON.stringify(invalid))).toThrow();
  expect(repository.readLeadership).toHaveBeenCalledWith(actor, projectId);
  const calls = repository.readLeadership.mock.calls.length;
  expect((await fetch(base + path + "?audience=project_manager", { headers })).status).toBe(400);
  expect((await fetch(base + "/api/projects/not-a-uuid/leadership-blocker-age-suggestions", { headers })).status).toBe(404);
  expect((await fetch(base + path)).status).toBe(401);
  expect((await fetch(base + path, { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
  expect(repository.readLeadership).toHaveBeenCalledTimes(calls);
});
it("keeps denial, infrastructure failures and invalid output private", async () => {
  const headers = { Authorization: "Bearer valid" };
  repository.readLeadership.mockRejectedValueOnce(new BlockerAgeAdviceError("DENIED"));
  repository.readLeadership.mockRejectedValueOnce(new BlockerAgeAdviceError("UNAVAILABLE"));
  repository.readLeadership.mockResolvedValueOnce({ privateMarker: "synthetic-private-marker" } as never);
  repository.readLeadership.mockResolvedValueOnce({ ...result, audience: "project_manager" } as never);
  repository.readLeadership.mockResolvedValueOnce({ ...result, projectId: customerId } as never);
  repository.readLeadership.mockRejectedValueOnce(new Error("synthetic-private-error"));
  for (const status of [404, 503, 500, 500, 500, 500]) {
    const response = await fetch(base + path, { headers });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text(); expect(body).not.toContain("synthetic-private-marker"); expect(body).not.toContain("synthetic-private-error");
  }
});
