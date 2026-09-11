import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import {
  loadConfig,
  IdentityService,
} from "../packages/platform/dist/index.js";
import { ProjectFactError } from "../packages/domain/dist/index.js";
import {
  evidenceContractFixture,
  evidenceProject,
  evidenceId,
  factType,
  statement,
} from "./fixtures/evidence-contract.js";
import type { ProjectRepository } from "../packages/domain/src/index.js";
const config = loadConfig({
  NODE_ENV: "test",
  DATA_MODE: "synthetic",
  AUTH_MODE: "development",
  CUSTOMER_ID: "10000000-0000-4000-8000-000000000001",
  APP_ORIGIN: "http://localhost:5173",
  PDAA_DATABASE_URL:
    "postgresql://pdaa:" +
    randomBytes(32).toString("hex") +
    "@127.0.0.1:55432/pdaa",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SHADOW_MODE: "true",
});
const evidence = evidenceContractFixture();
const foundation: ProjectRepository = {
  listProjects: async () => [],
  getProject: async () => null,
  setGrant: async () => {},
  revokeGrant: async () => {},
  listAudit: async () => [],
  ready: async () => true,
  heartbeat: async () => null,
};
let app: Awaited<ReturnType<typeof createApp>>["app"],
  base: string,
  token: string;
beforeAll(async () => {
  ({ app } = await createApp(
    config,
    foundation,
    undefined,
    undefined,
    evidence.facts,
    evidence.authority,
  ));
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  token = await new IdentityService(config).developmentToken("pm-atlas");
});
afterAll(async () => {
  await app?.close();
});
async function api(path: string, body?: unknown) {
  const response = await fetch(
    base + "/api/projects/" + evidenceProject + path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, body: await response.json() };
}
it("TR-API-001: HTTP authorized empty history succeeds and restricted envelopes cannot leak copied fields", async () => {
  evidence.facts.getHistory.mockResolvedValueOnce({
    factId: null,
    factType,
    throughRevision: 0,
    entries: [],
    next: null,
    historical: true,
  } as never);
  expect(await api(`/facts/${factType}/history`)).toMatchObject({
    status: 200,
    body: { factId: null, throughRevision: 0 },
  });
  evidence.facts.getHistory.mockResolvedValueOnce({
    factId: evidenceId,
    factType,
    throughRevision: 1,
    entries: [
      {
        ...evidence.entry,
        visibility: "restricted",
        revalidationRequired: true,
      },
    ],
    next: null,
    historical: true,
  } as never);
  expect(await api(`/facts/${factType}/history`)).toEqual({
    status: 500,
    body: { statusCode: 500, message: "Internal server error" },
  });
  evidence.authority.getAssessment.mockResolvedValueOnce({
    ...evidence.delivery,
    visibility: "restricted",
    revalidationRequired: true,
  } as never);
  expect((await api(`/assessments/${evidenceId}`)).status).toBe(500);
});
it.each([
  ["INVALID_REQUEST", 400],
  ["DENIED", 404],
  ["SOURCE_RESTRICTED", 404],
  ["REVISION_CONFLICT", 409],
  ["IDEMPOTENCY_CONFLICT", 409],
] as const)(
  "TR-API-001: %s maps to a fixed response without reflecting input",
  async (code, status) => {
    evidence.facts.appendHumanStatement.mockRejectedValueOnce(
      new ProjectFactError(code),
    );
    const response = await api("/fact-statements", statement);
    expect(response.status).toBe(status);
    expect(JSON.stringify(response.body)).not.toContain(
      statement.originalStatement,
    );
  },
);
it("NFR-SEC-004: unavailable repositories emit fixed 503 without SQL or source content in responses or logs", async () => {
  const privateValue = "private synthetic SQL and credential location",
    logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    evidence.facts.listFacts.mockRejectedValueOnce(new Error(privateValue));
    expect(await api("/facts")).toEqual({
      status: 503,
      body: { statusCode: 503, message: "Service unavailable" },
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(privateValue);
  } finally {
    logs.mockRestore();
  }
});
