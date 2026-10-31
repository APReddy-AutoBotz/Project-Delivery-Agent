import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { MilestoneConflictObservationError } from "../packages/domain/dist/index.js";
import { compileContract } from "../scripts/validate-openapi.mjs";

const customerId = "10000000-0000-4000-8000-000000000001", projectId = "20000000-0000-4000-8000-000000000001";
const milestoneId = "30000000-0000-4000-8000-000000000001";
const actor = { customerId, subject: "synthetic-dual", roles: ["leadership", "pmo_admin"] };
const observation = { projectId, milestoneId, asOf: "2026-10-21T11:00:00.000Z", ruleRevision: "milestone-required-state/v1" as const, outcome: "NOT_DETECTED" as const };
const result = { observation, requestStatus: null };
const repository = { readForLeaderManager: vi.fn(async () => result) };
const identity = { authenticate: vi.fn(async (token: string) => { if (token !== "valid") throw new Error("private-identity-error"); return actor; }) };
const config = loadConfig({ NODE_ENV: "test", DATA_MODE: "synthetic", AUTH_MODE: "development", CUSTOMER_ID: customerId,
  APP_ORIGIN: "http://localhost:5173", PDAA_DATABASE_URL: "postgresql://pdaa:synthetic@127.0.0.1:55432/pdaa_test_9",
  SESSION_SECRET: "s".repeat(64), ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"), SHADOW_MODE: "true" });
let app: Awaited<ReturnType<typeof createApp>>["app"], base: string, contract: ReturnType<typeof compileContract>;
beforeAll(async () => {
  const created = await createApp(config, {} as never, identity as never, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, repository as never);
  app = created.app; contract = compileContract(created.spec); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });
const path = `/api/projects/${projectId}/milestones/${milestoneId}/leadership-manager-request-observation`;
const route = "/api/projects/{id}/milestones/{milestoneId}/leadership-manager-request-observation";
const headers = { Authorization: "Bearer valid" };

it("authenticates a scoped read and validates the serialized no-conflict contract", async () => {
  const response = await fetch(base + path, { headers });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text(); expect(contract.response("GET", route, 200, "application/json", body)).toEqual(result);
  expect(repository.readForLeaderManager).toHaveBeenCalledWith(actor, projectId, milestoneId);
  const calls = repository.readForLeaderManager.mock.calls.length;
  expect((await fetch(base + path + "?audience=leadership", { headers })).status).toBe(400);
  expect((await fetch(base + path.replace(milestoneId, "invalid"), { headers })).status).toBe(404);
  expect((await fetch(base + path)).status).toBe(401);
  expect((await fetch(base + path, { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
  expect(repository.readForLeaderManager).toHaveBeenCalledTimes(calls);
});

it("serializes each bounded conflict status together with its own observation", async () => {
  const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20),
    provenance: "HUMAN_CONFIRMED", freshness: "CURRENT", validity: "FINITE", effectiveAt: "2026-10-20T00:00:00.000Z",
    observedAt: "2026-10-20T00:00:00.000Z", versionValidUntil: "2026-10-23T00:00:00.000Z", assessedValidUntil: "2026-10-22T00:00:00.000Z" });
  const conflict = { ...observation, outcome: "CONFLICTING", positions: [
    { targetKind: "MILESTONE", targetId: milestoneId, bindingId: id(1), factId: id(2), factType: "canonical.state.00000000000000000000000000000001", policyRevisionId: id(3), state: "COMPLETE", supports: [support(100)] },
    { targetKind: "WORK_ITEM", targetId: id(4), bindingId: id(5), factId: id(6), factType: "canonical.state.00000000000000000000000000000002", policyRevisionId: id(7), state: "OPEN", supports: [support(200)] },
  ] };
  for (const requestStatus of ["MATCHING_REQUEST_RECORDED", "NO_MATCHING_REQUEST_RECORDED"]) {
    const expected = { observation: conflict, requestStatus };
    repository.readForLeaderManager.mockResolvedValueOnce(expected as never);
    const response = await fetch(base + path, { headers });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(contract.response("GET", route, 200, "application/json", await response.text())).toEqual(expected);
  }
});

it("suppresses denial, malformed output and infrastructure details", async () => {
  repository.readForLeaderManager.mockRejectedValueOnce(new MilestoneConflictObservationError("DENIED"));
  repository.readForLeaderManager.mockRejectedValueOnce(new MilestoneConflictObservationError("UNAVAILABLE"));
  repository.readForLeaderManager.mockResolvedValueOnce({ ...result, requestStatus: "MATCHING_REQUEST_RECORDED" } as never);
  repository.readForLeaderManager.mockResolvedValueOnce({ ...result, observation: { ...observation, projectId: customerId } } as never);
  repository.readForLeaderManager.mockResolvedValueOnce({ ...result, privateMarker: "synthetic-private-marker" } as never);
  repository.readForLeaderManager.mockRejectedValueOnce(new Error("synthetic-private-error"));
  for (const status of [404, 503, 503, 503, 503, 503]) {
    const response = await fetch(base + path, { headers });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text(); expect(body).not.toContain("synthetic-private-marker"); expect(body).not.toContain("synthetic-private-error");
  }
});
