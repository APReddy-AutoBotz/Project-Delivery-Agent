import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { MilestoneStateDisagreementError } from "../packages/domain/dist/index.js";
import { compileContract } from "../scripts/validate-openapi.mjs";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = id(1), projectId = id(2), milestoneId = id(3);
const actor = { customerId, subject: "synthetic-leader", roles: ["leadership"] };
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20),
  provenance: "HUMAN_CONFIRMED" as const, effectiveAt: "2026-10-20T00:00:00.000Z", observedAt: "2026-10-20T00:00:00.000Z",
  versionValidUntil: "2026-10-23T00:00:00.000Z", assessedValidUntil: "2026-10-22T00:00:00.000Z" });
const result = { projectId, milestoneId, bindingId: id(4), factId: id(5),
  factType: "canonical.state.10000000000040008000000000000003", asOf: "2026-10-21T11:00:00.000Z", policyRevisionId: id(6),
  positions: [{ state: "COMPLETE", supports: [support(30)] }, { state: "OPEN", supports: [support(31)] }] };
const repository = { readLeadership: vi.fn(async () => result) };
const identity = { authenticate: vi.fn(async (token: string) => { if (token !== "valid") throw new Error("private"); return actor; }) };
const config = loadConfig({ NODE_ENV: "test", DATA_MODE: "synthetic", AUTH_MODE: "development", CUSTOMER_ID: customerId,
  APP_ORIGIN: "http://localhost:5173", PDAA_DATABASE_URL: "postgresql://pdaa:synthetic@127.0.0.1:55432/pdaa_test_9",
  SESSION_SECRET: "s".repeat(64), ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SHADOW_MODE: "true" });
let app: Awaited<ReturnType<typeof createApp>>["app"], base: string, contract: ReturnType<typeof compileContract>;
beforeAll(async () => {
  const created = await createApp(config, {} as never, identity as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, repository as never);
  app = created.app; contract = compileContract(created.spec); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });
const path = `/api/projects/${projectId}/milestones/${milestoneId}/leadership-state-disagreement`;
it("authenticates, scopes and validates the complete disagreement response", async () => {
  const headers = { Authorization: "Bearer valid" }, response = await fetch(base + path, { headers });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(result); expect(repository.readLeadership).toHaveBeenCalledWith(actor, projectId, milestoneId);
  const calls = repository.readLeadership.mock.calls.length;
  expect((await fetch(base + path + "?audience=project_manager", { headers })).status).toBe(400);
  expect((await fetch(base + path.replace(milestoneId, "invalid"), { headers })).status).toBe(404);
  expect((await fetch(base + path)).status).toBe(401);
  expect((await fetch(base + path, { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
  expect(repository.readLeadership).toHaveBeenCalledTimes(calls);
});
it("publishes the typed response contract and rejects malformed identities", () => {
  const route = "/api/projects/{id}/milestones/{milestoneId}/leadership-state-disagreement";
  expect(contract.response("GET", route, 200, "application/json", JSON.stringify(result))).toEqual(result);
  for (const invalid of [{ ...result, projectId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF" },
    { ...result, asOf: "2026-10-21T11:00:00Z" }, { ...result, asOf: "2026-10-21T11:00:00.000+00:00" }])
    expect(() => contract.response("GET", route, 200, "application/json", JSON.stringify(invalid))).toThrow();
});
it("keeps denial, invalid outputs and infrastructure failures private", async () => {
  repository.readLeadership.mockRejectedValueOnce(new MilestoneStateDisagreementError("DENIED"));
  repository.readLeadership.mockRejectedValueOnce(new MilestoneStateDisagreementError("UNAVAILABLE"));
  repository.readLeadership.mockResolvedValueOnce({ ...result, privateMarker: "synthetic-private-marker" } as never);
  repository.readLeadership.mockResolvedValueOnce({ ...result, milestoneId: customerId } as never);
  repository.readLeadership.mockResolvedValueOnce({ ...result, projectId: customerId } as never);
  repository.readLeadership.mockRejectedValueOnce(new Error("synthetic-private-error"));
  for (const status of [404, 503, 503, 503, 503, 503]) {
    const response = await fetch(base + path, { headers: { Authorization: "Bearer valid" } });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text(); expect(body).not.toContain("synthetic-private-marker"); expect(body).not.toContain("synthetic-private-error");
  }
});
it("fails closed when the repository is not configured", async () => {
  const created = await createApp(config, {} as never, identity as never);
  try {
    await created.app.listen(0, "127.0.0.1");
    const response = await fetch((await created.app.getUrl()) + path, { headers: { Authorization: "Bearer valid" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { await created.app.close(); }
});
