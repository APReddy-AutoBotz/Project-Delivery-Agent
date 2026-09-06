import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../apps/api/dist/app.js";
import { completeContract, grantSchema } from "../apps/api/dist/contract.js";
import {
  loadConfig,
  IdentityService,
} from "../packages/platform/dist/index.js";
import type {
  Project,
  ProjectRepository,
} from "../packages/domain/src/index.js";
import {
  compileContract,
  assertContractSnapshot,
} from "../scripts/validate-openapi.mjs";

const customerId = "10000000-0000-4000-8000-000000000001";
const project: Project = {
  id: "30000000-0000-4000-8000-000000000001",
  portfolioId: "20000000-0000-4000-8000-000000000001",
  code: "ATL",
  name: "Synthetic contract fixture",
  description: "Controlled test",
  reportedStatus: "UNKNOWN",
};
const grant = {
  subject: "contract-reader",
  scopeType: "project",
  scopeId: project.id,
  role: "contributor",
};
let ready = true;
const repository: ProjectRepository = {
  listProjects: vi.fn(async () => [project]),
  getProject: vi.fn(async (_actor, id) => (id === project.id ? project : null)),
  setGrant: vi.fn(async (_actor, value) => {
    if (value.scopeId !== project.id) throw new Error("Scope unavailable");
  }),
  revokeGrant: vi.fn(async () => {}),
  listAudit: vi.fn(async () => [
    {
      id: "50000000-0000-4000-8000-000000000001",
      event: "access.granted",
      actor: "operator",
      occurredAt: new Date("2026-09-06T00:00:00.000Z"),
    },
  ]),
  ready: async () => ready,
  heartbeat: async () => new Date(),
};
const config = loadConfig({
  NODE_ENV: "test",
  DATA_MODE: "synthetic",
  AUTH_MODE: "development",
  CUSTOMER_ID: customerId,
  APP_ORIGIN: "http://localhost:5173",
  PDAA_DATABASE_URL: "postgresql://pdaa:unused@127.0.0.1:55432/pdaa",
  SESSION_SECRET: "s".repeat(64),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  SHADOW_MODE: "true",
});
let app: Awaited<ReturnType<typeof createApp>>["app"];
let spec: Awaited<ReturnType<typeof createApp>>["spec"];
let base: string, operator: string, manager: string;
let check: ReturnType<typeof compileContract>;
const covered = new Set<string>();
beforeAll(async () => {
  ({ app, spec } = await createApp(config, repository));
  check = compileContract(spec);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  const identity = new IdentityService(config);
  operator = await identity.developmentToken("operator");
  manager = await identity.developmentToken("pm-atlas");
});
afterAll(async () => {
  await app?.close();
});
async function request(
  path: string,
  status: number,
  token?: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  expect(response.status).toBe(status);
  const route = path.startsWith("/api/projects/") ? "/api/projects/{id}" : path;
  const text = await response.text();
  const parsed = check.response(
    method,
    route,
    response.status,
    response.headers.get("content-type"),
    text,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  if (status < 300) covered.add(method.toLowerCase() + " " + route);
  return parsed;
}
it("CI-FND-001: every actual serialized success matches its published schema and status", async () => {
  for (const route of [
    "/api/health/live",
    "/api/health/ready",
    "/api/auth/config",
  ])
    await request(route, 200);
  await request("/api/auth/development", 200, undefined, "POST", {
    persona: "pm-atlas",
  });
  await request("/api/me", 200, manager);
  await request("/api/projects", 200, manager);
  await request("/api/projects/" + project.id, 200, manager);
  await request("/api/platform", 200, operator);
  await request("/api/audit", 200, operator);
  await request("/api/access-grants", 204, operator, "POST", grant);
  await request("/api/access-grants", 204, operator, "DELETE", {
    subject: grant.subject,
    scopeType: grant.scopeType,
    scopeId: grant.scopeId,
  });
  const declared = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => ["get", "post", "delete"].includes(method))
      .map((method) => method + " " + path),
  );
  expect([...covered].sort()).toEqual(declared.sort());
  expect(covered.size).toBe(11);
  assertContractSnapshot(
    spec,
    JSON.parse(
      readFileSync("docs/03-architecture/OPENAPI_FOUNDATION.json", "utf8"),
    ),
  );
});
it("CI-FND-001: published errors cover authentication, scope, strict input and readiness denials", async () => {
  await request("/api/projects", 401);
  await request("/api/platform", 403, manager);
  await request("/api/projects/not-a-uuid", 404, manager);
  await request("/api/access-grants", 401, undefined, "POST", grant);
  await request("/api/access-grants", 403, manager, "POST", grant);
  await request("/api/access-grants", 400, operator, "POST", {
    ...grant,
    secret: "rejected",
  });
  await request("/api/access-grants", 404, operator, "POST", {
    ...grant,
    scopeId: "30000000-0000-4000-8000-000000000099",
  });
  await request("/api/access-grants", 400, operator, "DELETE", grant);
  await request("/api/auth/development", 400, undefined, "POST", {
    persona: "invalid",
  });
  ready = false;
  try {
    await request("/api/health/ready", 503);
  } finally {
    ready = true;
  }
});
it("CI-FND-001: malformed repository output fails closed without disclosing fields or values", async () => {
  const secret = "private-raw-contract-fixture";
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(repository.listProjects).mockResolvedValueOnce([
    { ...project, envelope: secret } as Project,
  ]);
  try {
    const body = await request("/api/projects", 500, manager);
    expect(body).toEqual({
      message: "Internal server error",
      statusCode: 500,
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("envelope");
    vi.mocked(repository.listProjects).mockRejectedValueOnce(
      Object.assign(new Error(secret), { statusCode: 413 }),
    );
    expect((await request("/api/projects", 500, manager)).message).toBe(
      "Internal server error",
    );
    expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
  } finally {
    logs.mockRestore();
  }
});

it("CI-FND-001: actual parser errors match the contract without reflecting request secrets", async () => {
  const secret = "private-parser-contract-fixture";
  const cases = [
    {
      status: 413,
      type: "application/json",
      body: JSON.stringify({ persona: "x".repeat(120_000) }),
    },
    { status: 415, type: "application/json; charset=iso-8859-1", body: "{}" },
    {
      status: 400,
      type: "application/json",
      body: '{"token":"' + secret + '","broken":}',
    },
  ];
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const scenario of cases) {
      const response = await fetch(base + "/api/auth/development", {
        method: "POST",
        headers: { "Content-Type": scenario.type },
        body: scenario.body,
      });
      expect(response.status).toBe(scenario.status);
      const text = await response.text();
      check.response(
        "POST",
        "/api/auth/development",
        response.status,
        response.headers.get("content-type"),
        text,
      );
      expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
  } finally {
    logs.mockRestore();
  }
  const head = await fetch(base + "/api/health/live", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});
it("CI-FND-001: contract gates reject route/schema/export drift and malformed HTTP bodies", () => {
  const omitted = structuredClone(spec);
  delete omitted.paths["/api/me"];
  expect(() => completeContract(omitted)).toThrow(/routes/);
  const extra = structuredClone(spec);
  extra.paths["/api/unregistered"] = structuredClone(spec.paths["/api/me"]!);
  expect(() => completeContract(extra)).toThrow(/routes/);
  expect(() => assertContractSnapshot(spec, omitted)).toThrow(/differs/);
  const broken = structuredClone(spec) as any;
  broken.paths["/api/me"].get.responses["200"].content[
    "application/json"
  ].schema = { $ref: "#/missing" };
  expect(() => compileContract(broken)).toThrow();
  expect(() =>
    check.response(
      "GET",
      "/api/me",
      200,
      "application/json",
      JSON.stringify({ subject: "x" }),
    ),
  ).toThrow(/violates/);
  expect(() =>
    check.response("POST", "/api/access-grants", 204, null, "{}"),
  ).toThrow(/forbidden/);
  expect(() =>
    check.response("GET", "/api/me", 201, "application/json", "{}"),
  ).toThrow(/Undocumented/);
  for (const subject of [
    "a",
    "  a  ",
    "x".repeat(200),
    "  " + "x".repeat(200) + "  ",
  ])
    expect(() =>
      check.request("POST", "/api/access-grants", { ...grant, subject }),
    ).not.toThrow();
  for (const subject of ["", "   ", "x".repeat(201)]) {
    expect(() =>
      check.request("POST", "/api/access-grants", { ...grant, subject }),
    ).toThrow();
    expect(grantSchema.safeParse({ ...grant, subject }).success).toBe(false);
  }
});
