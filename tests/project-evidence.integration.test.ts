import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import {
  createDatabase,
  DatabaseProjectRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
} from "../packages/data/dist/index.js";
import {
  loadConfig,
  IdentityService,
} from "../packages/platform/dist/index.js";
import { createApp } from "../apps/api/dist/app.js";
import { compileContract } from "../scripts/validate-openapi.mjs";
import type { Actor, ProjectFactValue } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname))
  throw new Error("Evidence integration requires isolated synthetic database");
const db = createDatabase(url),
  config = loadConfig(process.env),
  customerId = config.CUSTOMER_ID;
const repos = [
  new DatabaseCanonicalProjectRepository(db),
  new DatabaseProjectFactRepository(db),
  new DatabaseAuthorityRepository(db),
] as const;
let app: Awaited<ReturnType<typeof createApp>>["app"],
  base: string,
  spec: Awaited<ReturnType<typeof createApp>>["spec"],
  check: ReturnType<typeof compileContract>;
beforeAll(async () => {
  ({ app, spec } = await createApp(
    config,
    new DatabaseProjectRepository(db),
    undefined,
    ...repos,
  ));
  check = compileContract(spec);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});
const token = (actor: Actor, expires = "5m") =>
  new SignJWT({ roles: actor.roles })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.subject)
    .setIssuer("pdaa:local")
    .setAudience("pdaa:api")
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(config.SESSION_SECRET));
async function api(
  actor: Actor | null,
  path: string,
  method = "GET",
  body?: unknown,
  bearer?: string,
  endpoint = base,
) {
  const credential = bearer ?? (actor ? await token(actor) : null);
  const response = await fetch(endpoint + "/api" + path, {
    method,
    headers: {
      ...(credential ? { Authorization: "Bearer " + credential } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const route = Object.keys(spec.paths).find((template) =>
    new RegExp("^" + template.replace(/\{[A-Za-z]+\}/g, "[^/]+") + "$").test(
      "/api" + path.split("?")[0],
    ),
  )!;
  const result = check.response(
    method,
    route,
    response.status,
    response.headers.get("content-type"),
    await response.text(),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  return { status: response.status, body: result };
}
async function fixture() {
  const portfolioId = randomUUID(),
    projectId = randomUUID(),
    suffix = randomUUID();
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Evidence portfolio " + suffix },
  });
  await db.project.create({
    data: {
      id: projectId,
      customerId,
      portfolioId,
      code: suffix,
      name: "Synthetic evidence project",
      description: "Immutable project description",
      reportedStatus: "UNKNOWN",
    },
  });
  const actor = (role: Actor["roles"][number], label: string): Actor => ({
    customerId,
    subject: label + "-" + suffix,
    roles: [role],
  });
  const pmo = actor("pmo_admin", "pmo"),
    manager = actor("portfolio_manager", "portfolio-manager"),
    second = actor("project_manager", "second"),
    leader = actor("leadership", "leader"),
    operator = actor("system_admin", "operator"),
    contributor = actor("contributor", "contributor");
  for (const person of [pmo, manager, second, leader, operator, contributor])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: person.subject,
        scopeType:
          person === pmo || person === manager ? "portfolio" : "project",
        scopeId: person === pmo || person === manager ? portfolioId : projectId,
        role: person.roles[0]!,
      },
    });
  const prefix = `/projects/${projectId}`,
    factType = "project.forecast",
    effectiveAt = new Date(Date.now() - 3600000).toISOString();
  const statement = (
    expectedRevision: number,
    value: ProjectFactValue = { type: "date", value: "2026-10-01" },
    key = randomUUID(),
  ) => ({
    projectId,
    factType,
    expectedRevision,
    idempotencyKey: key,
    value,
    effectiveAt,
    validUntil: null,
    originalStatement: "Synthetic human assertion " + JSON.stringify(value),
  });
  const policy = (expectedRevision: number, durationMs = 7200000) => ({
    projectId,
    factType,
    expectedRevision,
    idempotencyKey: randomUUID(),
    effectiveAt,
    definition: {
      tiers: [
        {
          selectors: [
            {
              sourceType: "human_statement",
              instanceId: null,
              requiredApproval: "NOT_REQUIRED",
              validity: { basis: "effectiveAt", durationMs },
            },
          ],
        },
      ],
      conflictBehavior: "REQUEST_RECONCILIATION",
    },
  });
  const capture = (key = randomUUID()) => ({
    projectId,
    factType,
    idempotencyKey: key,
  });
  const share = async (
    sourceId: string,
    readers = [manager.subject, second.subject, pmo.subject, leader.subject],
    state = "AVAILABLE",
  ) => {
    const before = await api(pmo, `${prefix}/fact-sources/${sourceId}/access`);
    expect(before.status).toBe(200);
    expect(Object.keys(before.body).sort()).toEqual([
      "readers",
      "revision",
      "sourceId",
      "state",
    ]);
    const request = {
      projectId,
      sourceId,
      expectedRevision: before.body.revision,
      state,
      readers,
    };
    const changed = await api(
      pmo,
      `${prefix}/fact-sources/${sourceId}/access`,
      "POST",
      request,
    );
    expect(changed.status).toBe(200);
    return { request, changed };
  };
  return {
    projectId,
    portfolioId,
    prefix,
    factType,
    effectiveAt,
    pmo,
    manager,
    second,
    leader,
    operator,
    contributor,
    statement,
    policy,
    capture,
    share,
  };
}

it("INT-EVD-001: HTTP discovery authorizes empty history, retains all five original types and freezes history paging", async () => {
  const f = await fixture();
  expect((await api(f.manager, f.prefix + "/facts")).body).toEqual({
    canAppend: true,
    canConfigure: false,
    facts: [],
    next: null,
  });
  expect(
    await api(f.manager, f.prefix + `/facts/${f.factType}/history`),
  ).toEqual({
    status: 200,
    body: {
      factId: null,
      factType: f.factType,
      throughRevision: 0,
      entries: [],
      next: null,
      historical: true,
    },
  });
  const values: ProjectFactValue[] = [
    { type: "date", value: "2026-10-01" },
    { type: "text", value: "A forecast statement" },
    { type: "number", value: 17.25 },
    { type: "boolean", value: false },
    { type: "empty", value: null },
  ];
  const receipts = [];
  for (const [revision, value] of values.entries()) {
    const request = f.statement(revision, value),
      response = await api(
        f.manager,
        f.prefix + "/fact-statements",
        "POST",
        request,
      );
    expect(response.status).toBe(201);
    receipts.push(response.body);
    expect(response.body.entry.content).toMatchObject({
      value,
      originalStatement: request.originalStatement,
      providedBy: f.manager.subject,
      provenance: "HUMAN_CONFIRMED",
      effectiveAt: request.effectiveAt,
      validUntil: null,
    });
    expect(response.body.entry.content.observedAt).toBe(
      response.body.entry.content.confirmedAt,
    );
    expect(response.body.entry.content.observedAt >= request.effectiveAt).toBe(
      true,
    );
  }
  const page = await api(
    f.manager,
    f.prefix + `/facts/${f.factType}/history?limit=2`,
  );
  expect(page.status).toBe(200);
  expect(page.body.next).toEqual({ afterRevision: 2, throughRevision: 5 });
  expect(new Set(receipts.map((receipt) => receipt.entry.sourceId)).size).toBe(
    1,
  );
  await api(f.second, f.prefix + "/fact-statements", "POST", f.statement(5));
  const rest = await api(
    f.manager,
    f.prefix + `/facts/${f.factType}/history?afterRevision=2&throughRevision=5`,
  );
  expect(
    rest.body.entries.map(
      (entry: { content: { value: unknown } }) => entry.content.value,
    ),
  ).toEqual(values.slice(2));
  expect(rest.body.throughRevision).toBe(5);
  expect(rest.body.next).toBe(null);
  const latest = await api(
    f.manager,
    f.prefix + `/facts/${f.factType}/history`,
  );
  expect(latest.body.entries[5].visibility).toBe("restricted");
  expect(latest.body.entries[5]).not.toHaveProperty("content");
  for (const factType of ["project.alpha", "project.zeta"])
    expect(
      (
        await api(f.manager, f.prefix + "/fact-statements", "POST", {
          ...f.statement(0),
          factType,
        })
      ).status,
    ).toBe(201);
  const first = await api(f.leader, f.prefix + "/facts?limit=1"),
    next = await api(
      f.leader,
      f.prefix + "/facts?limit=1&afterFactType=" + first.body.next,
    );
  expect(first.body.facts[0].factType).toBe("project.alpha");
  expect(next.body.facts[0].factType).toBe(f.factType);
  expect(Object.keys(first.body.facts[0]).sort()).toEqual([
    "factId",
    "factType",
    "revision",
  ]);
  expect(first.body).toMatchObject({ canAppend: false, canConfigure: false });
  expect(
    (await db.project.findUniqueOrThrow({ where: { id: f.projectId } }))
      .description,
  ).toBe("Immutable project description");
});

it("SEC-AUTH-002: catalogue never authorizes a later empty-history read after scope revocation", async () => {
  const f = await fixture();
  expect((await api(f.manager, f.prefix + "/facts")).status).toBe(200);
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.manager.subject },
  });
  expect(
    await api(f.manager, f.prefix + `/facts/${f.factType}/history`),
  ).toEqual({
    status: 404,
    body: { statusCode: 404, message: "Resource unavailable" },
  });
  expect((await api(f.manager, f.prefix + "/facts")).status).toBe(404);
  expect(
    (
      await api(
        f.pmo,
        f.prefix + `/facts/${f.factType}/history?throughRevision=1`,
      )
    ).status,
  ).toBe(400);
});

it("GOLDEN-013 / INT-ADM-003: real HTTP captures preserve origin, expiry and conflict independently and freeze prior snapshots", async () => {
  const f = await fixture(),
    firstRequest = f.statement(0);
  const first = await api(
    f.manager,
    f.prefix + "/fact-statements",
    "POST",
    firstRequest,
  );
  expect(first.status).toBe(201);
  await f.share(first.body.entry.sourceId);
  expect(
    (await api(f.leader, f.prefix + "/assessments", "POST", f.capture())).body
      .result.status,
  ).toBe("NO_POLICY");
  const rule = f.policy(0),
    published = await api(
      f.pmo,
      f.prefix + "/authority-policies",
      "POST",
      rule,
    );
  expect(published.status).toBe(201);
  const oldRequest = f.capture(),
    old = await api(f.leader, f.prefix + "/assessments", "POST", oldRequest);
  expect(old.status).toBe(201);
  expect(old.body.result.status).toBe("RESOLVED");
  const second = await api(
    f.second,
    f.prefix + "/fact-statements",
    "POST",
    f.statement(1, { type: "date", value: "2026-11-01" }),
  );
  expect(second.status).toBe(201);
  await f.share(second.body.entry.sourceId);
  expect(
    (await api(f.leader, f.prefix + "/assessments", "POST", f.capture())).body
      .result.status,
  ).toBe("CONFLICTING");
  expect(
    (
      await api(
        f.pmo,
        f.prefix + "/authority-policies",
        "POST",
        f.policy(1, 1000),
      )
    ).status,
  ).toBe(201);
  const stale = await api(
    f.leader,
    f.prefix + "/assessments",
    "POST",
    f.capture(),
  );
  expect(stale.status).toBe(201);
  expect(stale.body).toMatchObject({
    historical: true,
    visibility: "available",
  });
  expect(stale.body.result).toMatchObject({
    status: "CONFLICTING",
    resolvedValue: null,
    conflict: "CONFLICTING",
    reconciliationRequired: true,
  });
  for (const version of stale.body.result.versions)
    expect(version.assessment).toMatchObject({
      provenance: "HUMAN_CONFIRMED",
      freshness: "STALE",
      conflict: "CONFLICTING",
      classification: "CONFLICTING",
      assessedAt: stale.body.asOf,
    });
  const copied = await api(
    f.pmo,
    f.prefix + "/assessments/" + old.body.assessmentId,
  );
  expect(copied.body.result).toEqual(old.body.result);
  expect(copied.body.asOf).toBe(old.body.asOf);
  const replay = await api(
    f.leader,
    f.prefix + "/assessments",
    "POST",
    oldRequest,
  );
  expect(replay.body).toEqual({ ...old.body, replayed: true });
  expect(
    (await api(f.pmo, f.prefix + "/authority-policies", "POST", rule)).body,
  ).toEqual({ ...published.body, replayed: true });
  expect(
    (
      await api(f.pmo, f.prefix + "/authority-policies", "POST", {
        ...rule,
        definition: null,
      })
    ).status,
  ).toBe(409);
  const disabled = await api(f.pmo, f.prefix + "/authority-policies", "POST", {
    ...f.policy(2),
    definition: null,
  });
  expect(disabled.status).toBe(201);
  expect(
    (
      await api(f.pmo, f.prefix + "/authority-policies", "POST", {
        ...f.policy(3),
        effectiveAt: new Date(Date.now() + 86400000).toISOString(),
      })
    ).status,
  ).toBe(201);
  const active = await api(
    f.leader,
    f.prefix + `/facts/${f.factType}/authority`,
  );
  expect(active.body).toMatchObject({
    throughRevision: 4,
    event: { revision: 3, state: "DISABLED", definition: null },
  });
  const approvalRule = f.policy(4);
  approvalRule.definition.tiers[0]!.selectors[0]!.requiredApproval = "APPROVED";
  expect(
    (await api(f.pmo, f.prefix + "/authority-policies", "POST", approvalRule))
      .status,
  ).toBe(201);
  const approvedRequired = await api(
    f.leader,
    f.prefix + "/assessments",
    "POST",
    f.capture(),
  );
  expect(approvedRequired.body.result.resolvedValue).toBe(null);
  for (const version of approvedRequired.body.result.versions)
    expect(version.eligibilityReasons).toContain("APPROVAL_REQUIRED");
  expect(
    (await api(f.manager, f.prefix + `/facts/${f.factType}/history`)).body
      .entries[0].content,
  ).toEqual(first.body.entry.content);
});

it("FR-EVD-009: PMO sharing is explicit and copied assessments reauthorize all sources after revoke/delete/unverifiable", async () => {
  const f = await fixture(),
    first = await api(
      f.manager,
      f.prefix + "/fact-statements",
      "POST",
      f.statement(0),
    );
  for (const actor of [f.leader, f.pmo]) {
    const history = await api(actor, f.prefix + `/facts/${f.factType}/history`);
    expect(history.body.entries[0].visibility).toBe("restricted");
    expect(history.body.entries[0]).not.toHaveProperty("content");
  }
  const sourcePath = `${f.prefix}/fact-sources/${first.body.entry.sourceId}/access`;
  expect((await api(f.manager, sourcePath)).status).toBe(404);
  const inspection = await api(f.pmo, sourcePath);
  expect(inspection.body.readers).toEqual([f.manager.subject]);
  expect(JSON.stringify(inspection.body)).not.toContain(
    first.body.entry.content.originalStatement,
  );
  await f.share(first.body.entry.sourceId);
  await api(f.pmo, f.prefix + "/authority-policies", "POST", f.policy(0));
  const captureRequest = f.capture(),
    saved = await api(
      f.leader,
      f.prefix + "/assessments",
      "POST",
      captureRequest,
    );
  expect(saved.body.result.status).toBe("RESOLVED");
  for (const state of ["REVOKED", "DELETED", "UNVERIFIABLE"]) {
    await f.share(
      first.body.entry.sourceId,
      [f.leader.subject, f.manager.subject],
      state,
    );
    const history = await api(
        f.leader,
        f.prefix + `/facts/${f.factType}/history`,
      ),
      read = await api(
        f.leader,
        f.prefix + "/assessments/" + saved.body.assessmentId,
      ),
      replay = await api(
        f.leader,
        f.prefix + "/assessments",
        "POST",
        captureRequest,
      );
    expect(history.body.entries[0]).not.toHaveProperty("content");
    for (const response of [read, replay])
      expect(response.body).toMatchObject({
        visibility: "restricted",
        revalidationRequired: true,
        result: null,
        asOf: saved.body.asOf,
      });
    expect(
      (
        await api(
          f.manager,
          f.prefix + "/fact-statements",
          "POST",
          f.statement(1),
        )
      ).status,
    ).toBe(404);
  }
  const redacted = await api(
    f.leader,
    f.prefix + "/assessments",
    "POST",
    f.capture(),
  );
  await f.share(first.body.entry.sourceId);
  const restored = await api(
    f.leader,
    f.prefix + "/assessments/" + redacted.body.assessmentId,
  );
  expect(restored.body.result).toMatchObject({
    status: "REVALIDATION_REQUIRED",
    resolvedValue: null,
  });
  expect(restored.body.result.versions[0]).not.toHaveProperty("value");
  expect(
    (await api(f.leader, f.prefix + "/assessments/" + saved.body.assessmentId))
      .body.result,
  ).toEqual(saved.body.result);
  await f.share(first.body.entry.sourceId, [
    f.manager.subject,
    "ungranted-reader",
  ]);
  expect(
    (await api(f.leader, f.prefix + "/assessments/" + saved.body.assessmentId))
      .body.result,
  ).toBe(null);
  expect(
    (
      await api(
        { ...f.leader, subject: "ungranted-reader" },
        f.prefix + `/facts/${f.factType}/history`,
      )
    ).status,
  ).toBe(404);
});

it("SEC-AUTH-002: every evidence boundary requires a matching current business role and scoped grant", async () => {
  const f = await fixture(),
    other = await fixture(),
    first = await api(
      f.manager,
      f.prefix + "/fact-statements",
      "POST",
      f.statement(0),
    );
  const capture = await api(
    f.manager,
    f.prefix + "/assessments",
    "POST",
    f.capture(),
  );
  expect(capture.status).toBe(201);
  for (const actor of [
    f.operator,
    f.contributor,
    { ...f.manager, subject: "global-only" },
    { ...f.manager, roles: ["pmo_admin"] } as Actor,
    { ...f.leader, roles: ["portfolio_manager"] } as Actor,
  ]) {
    for (const path of [
      "/facts",
      `/facts/${f.factType}/history`,
      `/facts/${f.factType}/authority`,
      `/assessments/${capture.body.assessmentId}`,
      `/fact-sources/${first.body.entry.sourceId}/access`,
    ])
      expect((await api(actor, f.prefix + path)).status).toBe(404);
    expect(
      (await api(actor, f.prefix + "/fact-statements", "POST", f.statement(1)))
        .status,
    ).toBe(404);
    expect(
      (await api(actor, f.prefix + "/assessments", "POST", f.capture())).status,
    ).toBe(404);
    expect(
      (await api(actor, f.prefix + "/authority-policies", "POST", f.policy(0)))
        .status,
    ).toBe(404);
  }
  for (const actor of [f.manager, f.second, f.leader]) {
    expect(
      (await api(actor, f.prefix + "/authority-policies", "POST", f.policy(0)))
        .status,
    ).toBe(404);
    expect(
      (
        await api(
          actor,
          `${f.prefix}/fact-sources/${first.body.entry.sourceId}/access`,
          "POST",
          {
            projectId: f.projectId,
            sourceId: first.body.entry.sourceId,
            expectedRevision: 1,
            state: "AVAILABLE",
            readers: [actor.subject],
          },
        )
      ).status,
    ).toBe(404);
  }
  expect(
    (await api(f.leader, f.prefix + "/fact-statements", "POST", f.statement(1)))
      .status,
  ).toBe(404);
  expect(
    (
      await api(
        { ...f.leader, roles: ["leadership", "pmo_admin"] },
        f.prefix + "/authority-policies",
        "POST",
        f.policy(0),
      )
    ).status,
  ).toBe(404);
  expect((await api(f.manager, other.prefix + "/facts")).status).toBe(404);
  expect(
    (
      await api(
        f.pmo,
        `${other.prefix}/fact-sources/${first.body.entry.sourceId}/access`,
      )
    ).status,
  ).toBe(404);
  expect((await api(f.pmo, f.prefix + "/facts")).body.canConfigure).toBe(true);
});

it("INT-EVD-001: exact retries reuse receipts, concurrent stale writers lose atomically, and revoked replay is denied", async () => {
  const f = await fixture(),
    input = f.statement(0),
    saved = await api(f.manager, f.prefix + "/fact-statements", "POST", input);
  expect(
    (await api(f.manager, f.prefix + "/fact-statements", "POST", input)).body,
  ).toEqual({ ...saved.body, replayed: true });
  expect(
    (
      await api(f.manager, f.prefix + "/fact-statements", "POST", {
        ...input,
        originalStatement: "Changed body",
      })
    ).status,
  ).toBe(409);
  const writes = await Promise.all([
    api(f.manager, f.prefix + "/fact-statements", "POST", f.statement(1)),
    api(f.manager, f.prefix + "/fact-statements", "POST", f.statement(1)),
  ]);
  expect(writes.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(
    await db.projectFactVersion.count({ where: { projectId: f.projectId } }),
  ).toBe(2);
  expect(
    await db.factAppendReceipt.count({ where: { projectId: f.projectId } }),
  ).toBe(2);
  const shared = await f.share(saved.body.entry.sourceId);
  expect(
    (
      await api(
        f.pmo,
        `${f.prefix}/fact-sources/${saved.body.entry.sourceId}/access`,
        "POST",
        shared.request,
      )
    ).status,
  ).toBe(409);
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.manager.subject },
  });
  expect(
    (await api(f.manager, f.prefix + "/fact-statements", "POST", input)).status,
  ).toBe(404);
  expect(
    await db.factAppendReceipt.count({ where: { projectId: f.projectId } }),
  ).toBe(2);
});

it("TR-API-001: real HTTP rejects forged ownership, clocks, malformed cursors and unsafe source reader requests", async () => {
  const f = await fixture();
  for (const field of [
    "providedBy",
    "provenance",
    "observedAt",
    "confirmedAt",
    "sourceId",
    "approval",
    "customerId",
  ])
    expect(
      (
        await api(f.manager, f.prefix + "/fact-statements", "POST", {
          ...f.statement(0),
          [field]: "forged",
        })
      ).status,
    ).toBe(400);
  for (const field of ["asOf", "policy", "result", "complete", "approval"])
    expect(
      (
        await api(f.manager, f.prefix + "/assessments", "POST", {
          ...f.capture(),
          [field]: true,
        })
      ).status,
    ).toBe(400);
  for (const query of [
    "limit=101",
    "limit=0",
    "limit=1&limit=2",
    "limit=1.5",
    "afterRevision=1",
    "afterRevision=-1",
    "throughRevision=NaN",
    "extra=private",
  ])
    expect(
      (await api(f.manager, f.prefix + `/facts/${f.factType}/history?${query}`))
        .status,
    ).toBe(400);
  for (const query of [
    "limit=101",
    "limit[]=1",
    "limit=01",
    "afterFactType=Private+Name",
    "extra=private",
  ])
    expect((await api(f.manager, f.prefix + "/facts?" + query)).status).toBe(
      400,
    );
  const first = await api(
    f.manager,
    f.prefix + "/fact-statements",
    "POST",
    f.statement(0),
  );
  const path = `${f.prefix}/fact-sources/${first.body.entry.sourceId}/access`,
    request = {
      projectId: f.projectId,
      sourceId: first.body.entry.sourceId,
      expectedRevision: 1,
      state: "AVAILABLE",
      readers: ["duplicate", "duplicate"],
    };
  expect((await api(f.pmo, path, "POST", request)).status).toBe(400);
  expect(
    (
      await api(f.pmo, path, "POST", {
        ...request,
        readers: Array.from({ length: 101 }, (_, index) => "subject-" + index),
      })
    ).status,
  ).toBe(400);
  expect((await api(null, f.prefix + "/facts")).status).toBe(401);
  expect(
    (
      await api(
        f.manager,
        f.prefix + "/facts",
        "GET",
        undefined,
        await token(f.manager, "-1s"),
      )
    ).status,
  ).toBe(401);
});

it("TR-AUTH-002: the same OIDC token gains no fact authority after its configured portfolio-manager mapping is removed", async () => {
  const f = await fixture(),
    pair = await generateKeyPair("RS256");
  const env = {
    ...process.env,
    AUTH_MODE: "oidc",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_JWKS_URI: "https://identity.example.test/keys",
    OIDC_AUDIENCE: "pdaa",
    OIDC_CLIENT_ID: "web",
  };
  const signed = await new SignJWT({
    groups: ["portfolio-group"],
    roles: ["pmo_admin"],
  })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(f.manager.subject)
    .setIssuer(env.OIDC_ISSUER)
    .setAudience("pdaa")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  for (const mapped of [true, false, true]) {
    const settings = loadConfig({
      ...env,
      OIDC_GROUP_ROLE_MAP: JSON.stringify(
        mapped ? { "portfolio-group": ["portfolio_manager"] } : {},
      ),
    });
    const instance = await createApp(
      settings,
      new DatabaseProjectRepository(db),
      new IdentityService(settings, async () => pair.publicKey),
      ...repos,
    );
    try {
      await instance.app.listen(0, "127.0.0.1");
      const address = await instance.app.getUrl();
      expect(
        (
          await api(
            null,
            f.prefix + "/facts",
            "GET",
            undefined,
            signed,
            address,
          )
        ).status,
      ).toBe(mapped ? 200 : 404);
      expect(
        (
          await api(
            null,
            f.prefix + "/fact-statements",
            "POST",
            f.statement(
              mapped
                ? ((
                    await db.projectFact.findFirst({
                      where: { projectId: f.projectId },
                    })
                  )?.revision ?? 0)
                : 0,
            ),
            signed,
            address,
          )
        ).status,
      ).toBe(mapped ? 201 : 404);
      expect(
        (
          await api(
            null,
            f.prefix + "/authority-policies",
            "POST",
            f.policy(0),
            signed,
            address,
          )
        ).status,
      ).toBe(404);
    } finally {
      await instance.app.close();
    }
  }
});
