import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Console } from "node:console";
import { createDisclosureCheck } from "../scripts/acceptance/disclosure.mjs";
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
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import {
  emptyCanonicalDates,
  type CanonicalProjectRepository,
} from "../packages/domain/src/index.js";

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
const canonical: CanonicalProjectRepository = {
  setup: async () => ({
    truncated: false,
    portfolios: [
      {
        id: project.portfolioId,
        name: "Synthetic portfolio",
        programmes: [],
        programmesTruncated: false,
      },
    ],
  }),
  createProgramme: async () => ({
    id: project.portfolioId,
    code: "PROG",
    name: "Synthetic programme",
  }),
  createProject: async () => ({ id: project.id }),
  detail: async () => ({
    id: project.id,
    code: project.code,
    name: project.name,
    description: project.description,
    reportedStatus: project.reportedStatus,
    portfolio: { id: project.portfolioId, name: "Synthetic portfolio" },
    configured: false,
    creation: null,
    programme: null,
    dates: emptyCanonicalDates(),
    responsibilities: [],
    sprints: [],
    milestones: [],
    workItems: [],
    requiredWorkItems: [],
    raidItems: [],
    sourceMappings: [],
    sourceMappingsWithheld: true,
  }),
};
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
  PDAA_DATABASE_URL:
    "postgresql://pdaa:" +
    randomBytes(32).toString("hex") +
    "@127.0.0.1:55432/pdaa",
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SHADOW_MODE: "true",
});
let app: Awaited<ReturnType<typeof createApp>>["app"];
let spec: Awaited<ReturnType<typeof createApp>>["spec"];
let base: string, operator: string, manager: string;
let check: ReturnType<typeof compileContract>;
const covered = new Set<string>();
beforeAll(async () => {
  ({ app, spec } = await createApp(config, repository, undefined, canonical));
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
  const route = path.endsWith("/canonical")
    ? "/api/projects/{id}/canonical"
    : path.startsWith("/api/portfolios/")
      ? "/api/portfolios/{id}/programmes"
      : path.startsWith("/api/projects/")
        ? "/api/projects/{id}"
        : path;
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
  await request("/api/project-setup", 200, manager);
  await request(
    "/api/portfolios/" + project.portfolioId + "/programmes",
    201,
    manager,
    "POST",
    {
      code: "PROG",
      name: "Synthetic programme",
      idempotencyKey: "contract-key",
    },
  );
  await request(
    "/api/projects",
    201,
    manager,
    "POST",
    canonicalFixture(project.portfolioId),
  );
  await request("/api/projects/" + project.id + "/canonical", 200, manager);
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
  expect(covered.size).toBe(15);
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
it("SEC-SECRET-001: real HTTP headers, configuration and both output streams exclude generated credentials", async () => {
  const canary = randomBytes(32).toString("base64url");
  const disclosure = createDisclosureCheck([
    canary,
    config.ENCRYPTION_KEY,
    config.SESSION_SECRET!,
    config.database.password,
    operator,
    manager,
  ]);
  const stdout: string[] = [],
    stderr: string[] = [];
  const capture =
    (sink: string[]) =>
    (chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      sink.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") done();
      return true;
    };
  const out = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(capture(stdout) as never);
  const err = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(capture(stderr) as never);
  // Vitest redirects its console through worker IPC. Bind these console methods
  // to the intercepted process streams, as they are in the production process.
  const streamConsole = new Console(process.stdout, process.stderr);
  const consoleWrites = [
    vi.spyOn(console, "log").mockImplementation(streamConsole.log),
    vi.spyOn(console, "error").mockImplementation(streamConsole.error),
    vi.spyOn(console, "warn").mockImplementation(streamConsole.warn),
  ];
  try {
    async function observe(
      path: string,
      status: number,
      token?: string,
      init: RequestInit = {},
    ) {
      const response = await fetch(base + path + "?private=" + canary, {
        ...init,
        headers: {
          "X-Request-Id": canary,
          "X-Private-Input": canary,
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...init.headers,
        },
      });
      const text = await response.text();
      disclosure.add("api-body", text);
      disclosure.add("api-headers", JSON.stringify([...response.headers]));
      expect(response.status).toBe(status);
      expect(response.headers.get("x-request-id") === canary).toBe(false);
      return text;
    }
    const auth = JSON.parse(await observe("/api/auth/config", 200));
    expect(Object.keys(auth).sort()).toEqual(["dataMode", "mode", "scope"]);
    const platform = JSON.parse(await observe("/api/platform", 200, operator));
    expect(Object.keys(platform).sort()).toEqual([
      "dataMode",
      "database",
      "heartbeat",
      "identityMode",
      "shadowMode",
      "worker",
    ]);
    await observe("/api/me", 401, canary);
    await observe("/api/platform", 403, manager);
    await observe("/api/projects/" + canary, 404, manager);
    await observe("/api/access-grants", 400, operator, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...grant, token: canary }),
    });
    vi.mocked(repository.listProjects).mockRejectedValueOnce(
      Object.assign(new Error(canary), {
        cause: new Error(config.database.password),
        token: manager,
      }),
    );
    await observe("/api/projects", 500, manager);
    disclosure.add("stdout", stdout.join(""));
    disclosure.add("stderr", stderr.join(""));
    disclosure.verify(["api-body", "api-headers", "stdout"]);
    const logs = stdout
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const requests = logs.filter((line) => line.event === "http.request");
    expect(requests).toHaveLength(7);
    for (const line of requests)
      expect(Object.keys(line).sort()).toEqual([
        "correlationId",
        "durationMs",
        "event",
        "method",
        "status",
        "timestamp",
      ]);
    expect(stderr.join("") === "").toBe(true);
  } finally {
    for (const method of consoleWrites) method.mockRestore();
    out.mockRestore();
    err.mockRestore();
  }
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
