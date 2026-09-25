import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Console } from "node:console";
import { createDisclosureCheck } from "../scripts/acceptance/disclosure.mjs";
import { createApp } from "../apps/api/dist/app.js";
import { unavailableIngestionRepository } from "../apps/api/dist/ingestion-controller.js";
import {
  scalarContractFixture,
  scalarScope,
} from "./fixtures/scalar-reconciliation.js";
import { completeContract, grantSchema } from "../apps/api/dist/contract.js";
import {
  loadConfig,
  IdentityService,
} from "../packages/platform/dist/index.js";
import type {
  IngestionRepository,
  Project,
  ProjectRepository,
} from "../packages/domain/src/index.js";
import {
  compileContract,
  assertContractSnapshot,
} from "../scripts/validate-openapi.mjs";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import {
  evidenceContractFixture,
  exerciseEvidenceContracts,
} from "./fixtures/evidence-contract.js";
import {
  emptyCanonicalDates,
  type CanonicalProjectRepository,
} from "../packages/domain/src/index.js";
import {
  reconciliationContractFixture,
  exerciseReconciliationContracts,
  reconciliationPrefix,
  milestoneId,
  requestId,
  checkInput,
  bindingInput,
  refreshInput,
} from "./fixtures/reconciliation-contract.js";

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
let base: string, operator: string, manager: string, pmoPortfolio: string;
let check: ReturnType<typeof compileContract>;
const covered = new Set<string>();
const evidence = evidenceContractFixture();
const reconciliation = reconciliationContractFixture();
const scalar = scalarContractFixture();
const scalarRepository = {
  check: vi.fn(async () => scalar.checked),
  list: vi.fn(async () => ({
    requests: [scalar.request],
    next: null,
    live: true as const,
  })),
  get: vi.fn(async () => ({
    request: scalar.request,
    assessment: scalar.assessment,
  })),
  refreshAssignment: vi.fn(async () => ({
    requestId: scalar.request.id,
    assignment: scalar.request.assignment,
    replayed: false,
  })),
};
const ingestionSourceId = "30000000-0000-4000-8000-000000000101";
const ingestionPreviewId = "30000000-0000-4000-8000-000000000102";
const ingestionReviewId = "30000000-0000-4000-8000-000000000103";
const ingestionConfiguration = {
  binding: {
    customerId,
    sourceId: ingestionSourceId,
    sourceType: "csv-upload",
    origin: "https://csv-upload.invalid",
  },
  projects: [{ projectId: project.id, readers: ["pmo-portfolio"] }],
  mapping: {
    kind: "CSV" as const,
    sheet: "Projects",
    identityColumn: "Issue ID",
    projectColumn: "Project ID",
    fields: [{ column: "Forecast", factType: "project.forecast", type: "date" as const, required: true }],
  },
};
let ingestionConfigured = false;
const ingestionSource = {
  sourceId: ingestionSourceId,
  sourceType: "csv-upload",
  origin: "https://csv-upload.invalid",
  configuration: ingestionConfiguration,
  configRevision: 1,
  mappingRevision: 1,
  healthState: "UNKNOWN" as const,
  healthCode: "NONE" as const,
  healthCheckedAt: null,
};
function ingestionReadReceipt(kind: "CSV_PREVIEW" | "CSV_REVIEWED_IMPORT", id: string) {
  return {
    receipt: {
      id,
      sourceId: ingestionSourceId,
      actor: "pmo-portfolio",
      kind,
      eventId: null,
      configRevision: 1,
      mappingRevision: 1,
      cursorRevisionBefore: null,
      cursorRevisionAfter: null,
      generationBefore: null,
      generationAfter: null,
      rowCount: 1,
      createdAt: "2026-09-25T00:00:00.000Z",
      parentPreviewReceiptId: kind === "CSV_REVIEWED_IMPORT" ? ingestionPreviewId : null,
    },
    outcomes: [{
      ordinal: 1,
      parentOrdinal: kind === "CSV_REVIEWED_IMPORT" ? 1 : null,
      state: "ACCEPTED" as const,
      operation: "CREATE" as const,
      errorCodes: [],
      projectId: project.id,
      identity: ["spreadsheet:Projects", "a".repeat(64)] as [string, string],
      contentAvailable: true,
      proposals: [{ factType: "project.forecast", value: { type: "date", value: "2027-03-01" } }],
    }],
  };
}
const ingestionRepository: IngestionRepository = {
  ...unavailableIngestionRepository,
  listSources: vi.fn(async () => ingestionConfigured ? [ingestionSource] : []),
  configure: vi.fn(async () => {
    ingestionConfigured = true;
    return { sourceId: ingestionSourceId, configRevision: 1, mappingRevision: 1 };
  }),
  persistCsvPreview: vi.fn(async () => ({ receiptId: ingestionPreviewId, replayed: false, rowCount: 1 })),
  commitCsvReviewedImport: vi.fn(async () => ({
    receiptId: ingestionReviewId,
    parentPreviewReceiptId: ingestionPreviewId,
    replayed: false,
    rowCount: 1,
  })),
  readReceipt: vi.fn(async (_actor, input) => input.receiptId === ingestionPreviewId
    ? ingestionReadReceipt("CSV_PREVIEW", ingestionPreviewId)
    : ingestionReadReceipt("CSV_REVIEWED_IMPORT", ingestionReviewId)),
};
beforeAll(async () => {
  ({ app, spec } = await createApp(
    config,
    repository,
    undefined,
    canonical,
    evidence.facts,
    evidence.authority,
    reconciliation.repository,
    scalarRepository,
    undefined,
    ingestionRepository,
  ));
  check = compileContract(spec);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  const identity = new IdentityService(config);
  operator = await identity.developmentToken("operator");
  manager = await identity.developmentToken("pm-atlas");
  pmoPortfolio = await identity.developmentToken("pmo-portfolio");
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
      ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  });
  expect(response.status, await response.clone().text()).toBe(status);
  const route = Object.keys(spec.paths).find((template) =>
    new RegExp(
      "^" + template.replace(/\{[A-Za-z]+\}/g, "[^/]+") + "$",
      "u",
    ).test(path.split("?")[0]!),
  )!;
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
  await exerciseEvidenceContracts(request, manager);
  await exerciseReconciliationContracts(request, manager);
  const scalarPrefix = "/api/projects/" + scalarScope.projectId;
  await request(
    scalarPrefix + "/scalar-reconciliation-checks",
    201,
    manager,
    "POST",
    { factId: scalarScope.factId, idempotencyKey: "scalar-http" },
  );
  await request(
    scalarPrefix + "/managed-scalar-reconciliation-requests",
    200,
    manager,
  );
  await request(scalarPrefix + "/scalar-reconciliation-requests", 200, manager);
  await request(
    scalarPrefix + "/scalar-reconciliation-requests/" + scalar.request.id,
    200,
    manager,
  );
  await request(
    scalarPrefix +
      "/scalar-reconciliation-requests/" +
      scalar.request.id +
      "/assignment",
    201,
    manager,
    "POST",
    { expectedAssignmentRevision: 1, idempotencyKey: "scalar-assignment-http" },
  );
  await request("/api/ingestion/sources", 200, pmoPortfolio);
  check.request("POST", "/api/ingestion/sources/configuration", ingestionConfiguration);
  await request("/api/ingestion/sources/configuration", 201, pmoPortfolio, "POST", ingestionConfiguration);
  await request("/api/ingestion/sources", 200, pmoPortfolio);
  const previewForm = new FormData();
  previewForm.set("file", new Blob([`Issue ID,Project ID,Forecast\nD-1,${project.id},2027-03-01`], { type: "text/csv" }), "review.csv");
  previewForm.set("commandKey", "contract-csv-preview");
  previewForm.set("configRevision", "1");
  previewForm.set("mappingRevision", "1");
  check.request("POST", "/api/ingestion/sources/{sourceId}/csv-previews", {
    file: "review.csv",
    commandKey: "contract-csv-preview",
    configRevision: 1,
    mappingRevision: 1,
  }, "multipart/form-data; boundary=contract");
  await request(`/api/ingestion/sources/${ingestionSourceId}/csv-previews`, 201, pmoPortfolio, "POST", previewForm);
  const sparseIndexForm = new FormData();
  sparseIndexForm.set("file", new Blob([`Issue ID,Project ID,Forecast\\nD-1,${project.id},2027-03-01`], { type: "text/csv" }), "review.csv");
  sparseIndexForm.set("commandKey", "contract-csv-sparse-index");
  sparseIndexForm.set("configRevision[100000000]", "1");
  sparseIndexForm.set("mappingRevision", "1");
  const persistCsvPreview = vi.mocked(ingestionRepository.persistCsvPreview);
  const previewCallsBeforeSparseIndex = persistCsvPreview.mock.calls.length;
  const sparseIndexResponse = await fetch(base + `/api/ingestion/sources/${ingestionSourceId}/csv-previews`, {
    method: "POST",
    headers: { Authorization: "Bearer " + pmoPortfolio },
    body: sparseIndexForm,
  });
  expect(sparseIndexResponse.status).toBe(400);
  expect(await sparseIndexResponse.json()).toEqual({
    statusCode: 400,
    message: "Invalid request",
  });
  expect(sparseIndexResponse.headers.get("cache-control")).toBe("no-store");
  expect(sparseIndexResponse.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  expect(persistCsvPreview.mock.calls).toHaveLength(previewCallsBeforeSparseIndex);
  await request(`/api/ingestion/sources/${ingestionSourceId}/receipts/${ingestionPreviewId}`, 200, pmoPortfolio);
  const reviewedImportBody = {
    previewReceiptId: ingestionPreviewId,
    rowOrdinals: [1],
    commandKey: "contract-reviewed-import",
  };
  check.request("POST", "/api/ingestion/sources/{sourceId}/reviewed-imports", reviewedImportBody);
  await request(`/api/ingestion/sources/${ingestionSourceId}/reviewed-imports`, 201, pmoPortfolio, "POST", reviewedImportBody);
  await request(`/api/ingestion/sources/${ingestionSourceId}/receipts/${ingestionReviewId}`, 200, pmoPortfolio);
  const declared = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => ["get", "post", "delete"].includes(method))
      .map((method) => method + " " + path),
  );
  expect([...covered].sort()).toEqual(declared.sort());
  expect(covered.size).toBe(41);
  assertContractSnapshot(
    spec,
    JSON.parse(
      readFileSync("docs/03-architecture/OPENAPI_FOUNDATION.json", "utf8"),
    ),
  );
});
it("NFR-SEC-001: source ingestion administration requires the PMO administrator role", async () => {
  await request("/api/ingestion/sources", 401);
  await request("/api/ingestion/sources", 403, manager);
});
it("FR-EVD-009: scalar commands cannot override URL scope, identity or routing", async () => {
  const prefix = "/api/projects/" + scalarScope.projectId;
  await request(prefix + "/scalar-reconciliation-requests", 401);
  await request(
    prefix + "/scalar-reconciliation-requests/not-a-uuid",
    404,
    manager,
  );
  const before = scalarRepository.check.mock.calls.length;
  for (const extra of [
    { projectId: project.id },
    { recipientSubject: "other-pm" },
    { enabled: true },
    { policyId: project.id },
  ])
    await request(
      prefix + "/scalar-reconciliation-checks",
      400,
      manager,
      "POST",
      { factId: scalarScope.factId, idempotencyKey: "scalar-http", ...extra },
    );
  expect(scalarRepository.check.mock.calls.length).toBe(before);
  for (const query of [
    "?limit=21",
    "?limit=01",
    "?afterId=" + scalar.request.id,
    "?recipient=pm",
  ])
    await request(
      prefix + "/scalar-reconciliation-requests" + query,
      400,
      manager,
    );
  await request(
    prefix +
      "/scalar-reconciliation-requests/" +
      scalar.request.id +
      "/assignment",
    400,
    manager,
    "POST",
    {
      expectedAssignmentRevision: 1,
      idempotencyKey: "scalar-refresh",
      recipientSubject: "override",
    },
  );
});
it("FR-EVD-009: reconciliation routes use bearer identity, fixed queue modes and strict commands", async () => {
  const prefix = reconciliationPrefix;
  await request(prefix + "/reconciliation-requests", 401);
  await request(prefix + "/reconciliation-requests/not-a-uuid", 404, manager);
  for (const query of [
    "mode=manage",
    "actor=operator",
    "limit=21",
    "limit=01",
    "afterId=" + requestId,
    "afterCreatedAt=" + encodeURIComponent(checkInput.projectId),
  ])
    await request(prefix + "/reconciliation-requests?" + query, 400, manager);
  await request(
    prefix +
      "/reconciliation-requests/manage?limit=1&afterCreatedAt=" +
      encodeURIComponent("2026-09-11T00:00:00.000Z") +
      "&afterId=" +
      requestId,
    200,
    manager,
  );
  expect(reconciliation.repository.list).toHaveBeenLastCalledWith(
    expect.objectContaining({
      subject: "pm-atlas",
      roles: ["project_manager"],
    }),
    {
      projectId: project.id,
      limit: 1,
      after: { createdAt: "2026-09-11T00:00:00.000Z", id: requestId },
    },
    "manage",
  );
  await request(prefix + "/reconciliation-requests", 200, manager);
  expect(reconciliation.repository.list.mock.calls.at(-1)?.[2]).toBe(
    "recipient",
  );
  for (const [path, body] of [
    ["/state-bindings", { ...bindingInput, providedBy: "operator" }],
    ["/milestone-reconciliation-checks", { ...checkInput, actor: "operator" }],
    [
      "/milestone-reconciliation-checks",
      { ...checkInput, projectId: requestId },
    ],
    [
      "/milestone-reconciliation-checks",
      { ...checkInput, asOf: "2026-09-11T00:00:00.000Z" },
    ],
    [
      "/reconciliation-requests/" + requestId + "/assignment",
      { ...refreshInput, recipientSubject: "operator" },
    ],
    [
      "/reconciliation-requests/" + requestId + "/assignment",
      { ...refreshInput, requestId: milestoneId },
    ],
  ] as const)
    await request(prefix + path, 400, manager, "POST", body);
  // Import the same compiled error class used by the controller at runtime.
  const { ProjectFactError: RuntimeFactError } = await import(
    "../packages/domain/dist/index.js"
  );
  for (const [code, status] of [
    ["DENIED", 404],
    ["SOURCE_RESTRICTED", 404],
    ["REVISION_CONFLICT", 409],
    ["IDEMPOTENCY_CONFLICT", 409],
    ["INVALID_REQUEST", 400],
  ] as const) {
    reconciliation.repository.check.mockRejectedValueOnce(
      new RuntimeFactError(code),
    );
    await request(
      prefix + "/milestone-reconciliation-checks",
      status,
      manager,
      "POST",
      checkInput,
    );
  }
  reconciliation.repository.get.mockRejectedValueOnce(
    new Error("private-reconciliation-detail"),
  );
  expect(
    await request(
      prefix + "/reconciliation-requests/" + requestId,
      503,
      manager,
    ),
  ).toEqual({ statusCode: 503, message: "Service unavailable" });
});
it("FR-EVD-009: malformed reconciliation payloads fail closed before serialization", async () => {
  const malformed = [
    { ...reconciliation.checked, secret: "private-contract-value" },
    { ...reconciliation.checked, outcome: "CREATED" },
    { ...reconciliation.checked, request: reconciliation.request },
  ];
  for (const body of malformed) {
    reconciliation.repository.check.mockResolvedValueOnce(body as never);
    expect(
      await request(
        reconciliationPrefix + "/milestone-reconciliation-checks",
        500,
        manager,
        "POST",
        checkInput,
      ),
    ).toEqual({ statusCode: 500, message: "Internal server error" });
  }
  reconciliation.repository.get.mockResolvedValueOnce({
    request: reconciliation.request,
    assessment: {
      ...reconciliation.restricted,
      result: { secret: "private-proof" },
    },
  } as never);
  await request(
    reconciliationPrefix + "/reconciliation-requests/" + requestId,
    500,
    manager,
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
  const previewPath = "/api/ingestion/sources/{sourceId}/csv-previews";
  const previewBody = {
    file: "synthetic.csv",
    commandKey: "browser-preview-1",
    configRevision: 1,
    mappingRevision: 1,
  };
  expect(() => check.request("POST", previewPath, previewBody, "multipart/form-data; boundary=synthetic" )).not.toThrow();
  expect(() => check.request("POST", previewPath, { ...previewBody, mappingRevision: undefined }, "multipart/form-data" )).toThrow(/violates/);
  expect(() => check.request("POST", "/api/ingestion/sources/{sourceId}/reviewed-imports", {
    previewReceiptId: "30000000-0000-4000-8000-000000000001",
    rowOrdinals: [1, 2],
    commandKey: "review-command-1",
  })).not.toThrow();
});
