import { afterAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { SignJWT } from "jose";
import {
  PrismaClient,
  type Prisma,
} from "../packages/data/dist/generated/prisma/client.js";
import { watchCommits } from "../scripts/acceptance/reconciliation-commit-probes.mjs";
import {
  runWithCleanup,
  drainAndClose,
} from "../scripts/acceptance/fixture-cleanup.mjs";
import {
  createDatabase,
  DatabaseProjectRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
  DatabaseScalarReconciliationRepository,
  DatabaseScalarConflictObservationRepository,
  DatabaseHealthAssessmentRepository,
  DatabaseMilestoneReconciliationRepository,
  DatabasePmActionQueueRepository,
} from "../packages/data/dist/index.js";
import {
  scalarReconciliationIdentity,
  type Actor,
} from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import { verifyImmutableHistoryMutation } from "../scripts/acceptance/immutable-history.mjs";
import { possibleMutation, rawSqlText } from "./fixtures/read-only-sql.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { createApp } from "../apps/api/dist/app.js";
import { compileContract } from "../scripts/validate-openapi.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname))
  throw new Error("Scalar integration requires an isolated synthetic database");
const db = createDatabase(url),
  customerId = process.env.CUSTOMER_ID!;
const facts = new DatabaseProjectFactRepository(db),
  authority = new DatabaseAuthorityRepository(db),
  reconciliation = new DatabaseScalarReconciliationRepository(db),
  canonical = new DatabaseCanonicalProjectRepository(db);
const context = { correlationId: "scalar-reconciliation-integration" };
afterAll(async () => db.$disconnect());
async function fixture(configured = true, optedIn = true, withPolicy = true) {
  const portfolioId = randomUUID();
  const pmo: Actor = {
    customerId,
    subject: "scalar-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  const pm: Actor = {
    customerId,
    subject: "scalar-pm-" + randomUUID(),
    roles: ["project_manager"],
  };
  const leader: Actor = {
    customerId,
    subject: "scalar-leader-" + randomUUID(),
    roles: ["leadership"],
  };
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Synthetic scalar requests" },
  });
  for (const actor of [pmo, pm, leader])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: actor.roles[0]!,
      },
    });
  let projectId: string;
  if (configured) {
    const input = canonicalFixture(portfolioId);
    input.responsibilities = [
      {
        role: "PROJECT_MANAGER",
        subject: pm.subject,
        displayName: "Scalar PM",
      },
    ];
    projectId = (
      await canonical.createProject(pmo, input, context.correlationId)
    ).id;
  } else {
    projectId = randomUUID();
    await db.project.create({
      data: {
        id: projectId,
        customerId,
        portfolioId,
        code: randomUUID(),
        name: "Legacy scalar project",
        description: "Synthetic",
        reportedStatus: "UNKNOWN",
      },
    });
  }
  const factType = "project.forecast",
    effectiveAt = new Date(Date.now() - 1000).toISOString();
  const versions = [];
  for (const [index, actor] of [pmo, pm].entries()) {
    const result = await facts.appendHumanStatement(
      actor,
      {
        projectId,
        factType,
        expectedRevision: index,
        idempotencyKey: randomUUID(),
        effectiveAt,
        validUntil: new Date(Date.now() + 3600000).toISOString(),
        originalStatement: "Synthetic disputed forecast",
        value: {
          type: "date",
          value: index === 0 ? "2026-10-01" : "2026-10-02",
        },
      },
      context,
    );
    versions.push(result.entry);
    const access = await facts.getSourceAccess(pmo, {
      projectId,
      sourceId: result.entry.sourceId,
    });
    await facts.setSourceAccess(
      pmo,
      {
        projectId,
        sourceId: result.entry.sourceId,
        expectedRevision: access!.revision,
        state: "AVAILABLE",
        readers: [pmo.subject, pm.subject, leader.subject],
      },
      context,
    );
  }
  if (withPolicy) await authority.appendPolicy(
    pmo,
    {
      projectId,
      factType,
      expectedRevision: 0,
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
                validity: null,
              },
            ],
          },
        ],
        conflictBehavior: optedIn
          ? "REQUEST_RECONCILIATION"
          : "RETAIN_CONFLICT",
      },
    },
    context,
  );
  const fact = await db.projectFact.findFirstOrThrow({
    where: { customerId, projectId, factType },
  });
  const input = { projectId, factId: fact.id, idempotencyKey: randomUUID() };
  return { pmo, pm, leader, projectId, factType, input, versions };
}
it("links authorized PM discovery to read-only recipient lists on the API role", async () => {
  if (process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Preview integration requires a qualified disposable synthetic database");
  const first = await fixture(), second = await fixture();
  const created = await reconciliation.check(first.pmo, first.input, context);
  expect(created.outcome).toBe("CREATED"); expect(created.request?.assignment.recipientSubject).toBe(first.pm.subject);
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect((await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role"))[0]?.role).toBe("pdaa_api");
      return operation(tx);
    }, options as never) };
  const scalarReader = new DatabaseScalarReconciliationRepository(roleDb as never);
  const milestoneReader = new DatabaseMilestoneReconciliationRepository(roleDb as never);
  const queueReader = new DatabasePmActionQueueRepository(roleDb as never), config = loadConfig(process.env);
  const { app } = await createApp(config, new DatabaseProjectRepository(db), undefined, canonical, facts, authority,
    milestoneReader, scalarReader, undefined, undefined, undefined, undefined, queueReader);
  const tables = ["FactAssessment", "FactAssessmentVersion", "FactAssessmentConflict", "MilestoneConsistencyAssessment",
    "MilestoneReconciliationRequest", "MilestoneReconciliationCheck", "MilestoneReconciliationAssignment",
    "ScalarReconciliationRequest", "ScalarReconciliationCheck", "ScalarReconciliationAssignment"];
  const snapshot = () => Promise.all([first.projectId, second.projectId].flatMap((projectId) => [
    ...tables.map((table) => db.$queryRawUnsafe(
      `SELECT to_jsonb(t)::text AS row FROM public."${table}" t WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY to_jsonb(t)::text COLLATE "C"`, customerId, projectId)),
    db.$queryRawUnsafe(`SELECT to_jsonb(t)::text AS row FROM public."AuditEvent" t WHERE "customerId"=$1::uuid AND detail->>'projectId'=$2 ORDER BY to_jsonb(t)::text COLLATE "C"`, customerId, projectId),
  ]));
  async function get(actor: Actor, path: string) {
    const token = await new SignJWT({ roles: actor.roles }).setProtectedHeader({ alg: "HS256" }).setSubject(actor.subject)
      .setIssuer("pdaa:local").setAudience("pdaa:api").setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode(config.SESSION_SECRET));
    const response = await fetch(`${await app.getUrl()}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return { status: response.status, text: await response.text() };
  }
  try {
    await app.listen(0, "127.0.0.1");
    const before = await snapshot();
    for (const f of [first, second]) {
      const discovered = await get(f.pm, "/pm/action-queue"); expect(discovered.status).toBe(200);
      expect(JSON.parse(discovered.text).projects.map((p: { projectId: string }) => p.projectId)).toContain(f.projectId);
      const milestone = await get(f.pm, `/projects/${f.projectId}/reconciliation-requests`);
      const scalar = await get(f.pm, `/projects/${f.projectId}/scalar-reconciliation-requests`);
      expect(milestone.status).toBe(200); expect(JSON.parse(milestone.text).requests).toEqual([]);
      expect(scalar.status).toBe(200);
      expect(JSON.parse(scalar.text).requests.map((r: { id: string }) => r.id)).toEqual(f === first ? [created.request!.id] : []);
    }
    for (const path of [`/projects/${first.projectId}/reconciliation-requests`, `/projects/${first.projectId}/scalar-reconciliation-requests`,
      `/projects/${second.projectId}/scalar-reconciliation-requests/${created.request!.id}`]) {
      const denied = await get(second.pm, path); expect(denied.status).toBe(404); expect(denied.text).not.toContain(created.request!.id);
    }
    expect((await get({ ...first.pm, roles: ["leadership"] }, `/projects/${first.projectId}/scalar-reconciliation-requests`)).status).toBe(404);
    expect(await scalarReader.list({ ...first.pm, customerId: randomUUID() }, { projectId: first.projectId }, "recipient")).toBeNull();
    await db.accessGrant.deleteMany({ where: { customerId, subject: first.pm.subject, role: "project_manager" } });
    for (const suffix of ["reconciliation-requests", "scalar-reconciliation-requests"]) {
      const denied = await get(first.pm, `/projects/${first.projectId}/${suffix}`); expect(denied.status).toBe(404);
      expect(denied.text).not.toContain(created.request!.id);
    }
    expect(await snapshot()).toEqual(before);
  } finally { await app.close(); }
}, 120000);
it("pages real scalar recipient requests and rechecks current scope on the API role", async () => {
  if (process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" || new URL(url).hostname !== "127.0.0.1")
    throw new Error("Preview integration requires a qualified disposable synthetic database");
  const f = await fixture(), created: string[] = [];
  for (let index = 0; index < 21; index++) {
    if (index > 0) await facts.appendHumanStatement(f.pm, { projectId: f.projectId, factType: f.factType,
      expectedRevision: index + 1, idempotencyKey: randomUUID(), effectiveAt: new Date(Date.now() - 500).toISOString(),
      validUntil: new Date(Date.now() + 3_600_000).toISOString(), originalStatement: "Synthetic paging report",
      value: { type: "date", value: `2026-11-${String(index + 1).padStart(2, "0")}` } }, context);
    const result = await reconciliation.check(f.pmo, { ...f.input, idempotencyKey: randomUUID() }, context);
    expect(result.outcome).toBe("CREATED");
    expect(result.request?.assignment.recipientSubject).toBe(f.pm.subject);
    created.push(result.request!.id);
  }
  expect(new Set(created).size).toBe(21);
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect((await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role"))[0]?.role).toBe("pdaa_api");
      return operation(tx);
    }, options as never) };
  const reader = new DatabaseScalarReconciliationRepository(roleDb as never), config = loadConfig(process.env);
  const { app } = await createApp(config, new DatabaseProjectRepository(db), undefined, canonical, facts, authority,
    undefined, reader);
  const snapshot = async () => Promise.all(["ScalarReconciliationRequest", "ScalarReconciliationCheck", "ScalarReconciliationAssignment",
    "FactAssessment", "ProjectFactVersion"].map((table) => db.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM public."${table}" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid`, customerId, f.projectId)));
  async function get(actor: Actor, query = "") {
    const token = await new SignJWT({ roles: actor.roles }).setProtectedHeader({ alg: "HS256" }).setSubject(actor.subject)
      .setIssuer("pdaa:local").setAudience("pdaa:api").setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode(config.SESSION_SECRET));
    const response = await fetch(`${await app.getUrl()}/api/projects/${f.projectId}/scalar-reconciliation-requests${query}`,
      { headers: { Authorization: `Bearer ${token}` } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return { status: response.status, text: await response.text() };
  }
  try {
    await app.listen(0, "127.0.0.1");
    const outsider: Actor = { customerId, subject: "other-pm-" + randomUUID(), roles: ["project_manager"] };
    await db.accessGrant.create({ data: { customerId, subject: outsider.subject, role: "project_manager", scopeType: "project", scopeId: f.projectId } });
    expect(await db.accessGrant.count({ where: { customerId, subject: outsider.subject, role: "project_manager", scopeId: f.projectId } })).toBe(1);
    const before = await snapshot();
    const first = await get(f.pm); expect(first.status).toBe(200);
    const page1 = JSON.parse(first.text); expect(page1.requests).toHaveLength(20); expect(page1.live).toBe(true);
    expect(page1.next).toEqual({ id: page1.requests[19].id, createdAt: page1.requests[19].createdAt });
    const params = new URLSearchParams({ limit: "20", afterId: page1.next.id, afterCreatedAt: page1.next.createdAt });
    const second = await get(f.pm, `?${params}`); expect(second.status).toBe(200);
    const page2 = JSON.parse(second.text); expect(page2.requests).toHaveLength(1); expect(page2.next).toBeNull();
    const observed = [...page1.requests, ...page2.requests];
    expect(observed.map((row: { id: string }) => row.id).sort()).toEqual([...created].sort());
    for (const [index, row] of observed.entries()) {
      expect(row).toMatchObject({ projectId: f.projectId, state: "OPEN", assignment: { recipientSubject: f.pm.subject } });
      if (index > 0) {
        const prior = observed[index - 1];
        expect(row.createdAt > prior.createdAt || (row.createdAt === prior.createdAt && row.id > prior.id)).toBe(true);
      }
    }
    const denied = await get(outsider, `?${params}`); expect(denied.status).toBe(404);
    for (const requestId of created) expect(denied.text).not.toContain(requestId);
    expect(await snapshot()).toEqual(before);
    await db.accessGrant.deleteMany({ where: { customerId, subject: f.pm.subject, role: "project_manager" } });
    const afterRevocation = await snapshot();
    const revoked = await get(f.pm, `?${params}`); expect(revoked.status).toBe(404);
    for (const requestId of created) expect(revoked.text).not.toContain(requestId);
    expect(await snapshot()).toEqual(afterRevocation);
  } finally { await app.close(); }
}, 120000);
it("reads the same authorized current disagreement before and after separate reconciliation capture", async () => {
  const f = await fixture();
  const attemptedWrites: string[] = [];
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect((await tx.$queryRawUnsafe<{ current_user: string }[]>("SELECT current_user"))[0]!.current_user).toBe("pdaa_api");
      const acl = await tx.$queryRawUnsafe<{ allowed: boolean }[]>(`SELECT has_table_privilege(current_user, 'public."AuditEvent"', 'SELECT') AS allowed`);
      expect(acl[0]?.allowed).toBe(true);
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if ((key === "$queryRaw" || key === "$queryRawUnsafe" || key === "$executeRaw" || key === "$executeRawUnsafe") && typeof value === "function") return (...args: unknown[]) => {
          const sql = rawSqlText(args[0]);
          if ((String(key).startsWith("$execute") && !/^SET LOCAL (?:statement_timeout|lock_timeout)\s*=/.test(sql)) || possibleMutation(sql)) {
            attemptedWrites.push(sql); throw new Error("Unexpected SQL mutation");
          }
          return Reflect.apply(value, target, args);
        };
        if (value && typeof value === "object" && typeof key === "string" && !key.startsWith("$")) return new Proxy(value, { get(model, method) {
          const fn = Reflect.get(model, method);
          if (typeof fn === "function" && /^(?:create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(String(method)))
            return () => { attemptedWrites.push(`${key}.${String(method)}`); throw new Error("Unexpected ORM mutation"); };
          return typeof fn === "function" ? fn.bind(model) : fn;
        } });
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const reader = new DatabaseScalarConflictObservationRepository(roleDb as never);
  const scopedTables = ["ProjectFact", "ProjectFactVersion", "FactEvidence", "FactSource", "FactSourceAccess", "FactSourceReader",
    "AuthorityPolicy", "AuthorityPolicyRevision", "AuthorityPolicyReceipt", "FactAuthorityConflict", "FactAssessment", "FactAssessmentVersion",
    "FactAssessmentConflict", "ScalarReconciliationRequest", "ScalarReconciliationCheck", "ScalarReconciliationAssignment"];
  const snapshot = () => Promise.all([...scopedTables.map((table) => db.$queryRawUnsafe(
    `SELECT to_jsonb(t)::text AS row FROM public."${table}" t WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY to_jsonb(t)::text COLLATE "C"`, customerId, f.projectId)),
    db.$queryRawUnsafe(`SELECT to_jsonb(t)::text AS row FROM public."AuditEvent" t WHERE "customerId"=$1::uuid AND detail->>'projectId'=$2 ORDER BY to_jsonb(t)::text COLLATE "C"`, customerId, f.projectId)]);
  const before = await snapshot();
  const observed = await reader.readLeadership(f.leader, f.projectId, f.input.factId);
  expect(await snapshot()).toEqual(before);
  expect(attemptedWrites).toEqual([]);
  expect(observed.positions.map((item) => item.value)).toEqual(["2026-10-01", "2026-10-02"]);
  for (const [index, position] of observed.positions.entries()) {
    expect(position.supports).toMatchObject([{ versionId: f.versions[index]!.id,
      evidenceId: f.versions[index]!.evidenceId, sourceId: f.versions[index]!.sourceId, provenance: "HUMAN_CONFIRMED" }]);
  }
  await reconciliation.check(f.pmo, f.input, context);
  const captured = await snapshot();
  const after = await reader.readLeadership(f.leader, f.projectId, f.input.factId);
  expect(await snapshot()).toEqual(captured);
  expect(attemptedWrites).toEqual([]);
  expect({ ...after, asOf: observed.asOf }).toEqual(observed);
  await expect(reader.readLeadership(f.pm, f.projectId, f.input.factId)).rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readLeadership({ ...f.leader, customerId: randomUUID() }, f.projectId, f.input.factId)).rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readLeadership(f.leader, randomUUID(), f.input.factId)).rejects.toMatchObject({ code: "DENIED" });
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: f.versions[0]!.sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: f.versions[0]!.sourceId,
    expectedRevision: access!.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
  await expect(reader.readLeadership(f.leader, f.projectId, f.input.factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("serves only authorized role-switched scalar observations over the authenticated HTTP boundary", async () => {
  const f = await fixture(false), config = loadConfig(process.env);
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
  const { app, spec } = await createApp(config, new DatabaseProjectRepository(db), undefined, canonical, facts, authority,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    new DatabaseScalarConflictObservationRepository(roleDb as never));
  const validate = compileContract(spec), template = "/api/projects/{id}/fact-observations/{factId}/leadership-conflict";
  await app.listen(0, "127.0.0.1");
  async function request(actor: Actor, suffix = "") {
    const token = await new SignJWT({ roles: actor.roles }).setProtectedHeader({ alg: "HS256" }).setSubject(actor.subject)
      .setIssuer("pdaa:local").setAudience("pdaa:api").setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode(config.SESSION_SECRET));
    const response = await fetch(`${await app.getUrl()}/api/projects/${f.projectId}/fact-observations/${f.input.factId}/leadership-conflict${suffix}`,
      { headers: { Authorization: `Bearer ${token}` } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text(); validate.response("GET", template, response.status, "application/json", body);
    return { status: response.status, body };
  }
  try {
    const allowed = await request(f.leader); expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body).positions.map((position: { value: string }) => position.value)).toEqual(["2026-10-01", "2026-10-02"]);
    expect((await request(f.pm)).status).toBe(404);
    expect((await request({ ...f.leader, subject: "outsider-" + randomUUID() })).status).toBe(404);
    expect((await request(f.leader, "?cursor=private")).status).toBe(400);
    const sourceId = f.versions[0]!.sourceId, access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
    await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: access!.revision,
      state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
    const unavailable = await request(f.leader); expect(unavailable.status).toBe(503); expect(unavailable.body).not.toContain(sourceId);
  } finally { await app.close(); }
}, 60000);
it("rechecks selected fact membership on the authorized catalogue page", async () => {
  const f = await fixture(false);
  const reader = new DatabaseScalarConflictObservationRepository({ $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) } as never);
  expect((await reader.readLeadership(f.leader, f.projectId, f.input.factId)).positions).toHaveLength(2);
  const appendFact = async (index: number) => {
    await facts.appendHumanStatement(f.pmo, { projectId: f.projectId, factType: `a.fact${String(index).padStart(2, "0")}`,
      expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 3600000).toISOString(), originalStatement: "Synthetic catalogue entry",
      value: { type: "date", value: "2026-10-01" } }, context);
  };
  for (let index = 0; index < 49; index++) await appendFact(index);
  const lastVisible = await facts.listFacts(f.leader, { projectId: f.projectId });
  expect(lastVisible?.facts).toHaveLength(50); expect(lastVisible?.facts[49]?.factId).toBe(f.input.factId);
  expect((await reader.readLeadership(f.leader, f.projectId, f.input.factId)).positions).toHaveLength(2);
  await appendFact(49);
  const page = await facts.listFacts(f.leader, { projectId: f.projectId });
  expect(page?.facts).toHaveLength(50); expect(page?.next).not.toBeNull();
  expect(page?.facts.some((row) => row.factId === f.input.factId)).toBe(false);
  await expect(reader.readLeadership(f.leader, f.projectId, f.input.factId)).rejects.toMatchObject({ code: "DENIED" });
  const second = await facts.listFacts(f.leader, { projectId: f.projectId, afterFactType: page!.next });
  expect(second?.facts.some((row) => row.factId === f.input.factId)).toBe(true);
  expect((await reader.readLeadership(f.leader, f.projectId, f.input.factId, page!.next)).positions).toHaveLength(2);
  await expect(reader.readLeadership(f.leader, f.projectId, f.input.factId, "z.not-present")).rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readLeadership(f.pm, f.projectId, f.input.factId, page!.next)).rejects.toMatchObject({ code: "DENIED" });
  const config = loadConfig(process.env);
  const { app, spec } = await createApp(config, new DatabaseProjectRepository(db), undefined, canonical, facts, authority,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, reader);
  try {
    await app.listen(0, "127.0.0.1");
    const token = await new SignJWT({ roles: f.leader.roles }).setProtectedHeader({ alg: "HS256" }).setSubject(f.leader.subject)
      .setIssuer("pdaa:local").setAudience("pdaa:api").setIssuedAt().setExpirationTime("5m")
      .sign(new TextEncoder().encode(config.SESSION_SECRET));
    const path = `${await app.getUrl()}/api/projects/${f.projectId}/fact-observations/${f.input.factId}/leadership-conflict`;
    const headers = { Authorization: `Bearer ${token}` }, query = `?afterFactType=${encodeURIComponent(page!.next!)}`;
    const denied = await fetch(path, { headers }); expect(denied.status).toBe(404);
    const allowed = await fetch(path + query, { headers }); expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    const body = await allowed.text();
    compileContract(spec).response("GET", "/api/projects/{id}/fact-observations/{factId}/leadership-conflict", 200, "application/json", body);
    expect(JSON.parse(body).positions).toHaveLength(2);
    const sourceId = f.versions[0]!.sourceId, access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
    await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: access!.revision,
      state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
    await expect(reader.readLeadership(f.leader, f.projectId, f.input.factId, page!.next)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const unavailable = await fetch(path + query, { headers }); expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(sourceId);
  } finally { await app.close(); }
  await expect(reader.readLeadership(f.leader, f.projectId, page!.facts[0]!.factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(reader.readLeadership(f.leader, f.projectId, randomUUID())).rejects.toMatchObject({ code: "DENIED" });
}, 120000);
it("coordinates source-access revocation and scalar observation in both lock orders", async () => {
  const f = await fixture(false), sourceId = f.versions[0]!.sourceId;
  const makeReader = (database: unknown) => new DatabaseScalarConflictObservationRepository(database as never);
  async function blocked(waiting: number, blocking: number, fragments: string[]) {
    for (let i = 0; i < 40; i++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && fragments.every((item) => rows[0]!.query.includes(item))) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  let writerPid = 0, readerPid = 0, writerReady!: () => void, readerReady!: () => void, releaseWriter!: () => void;
  const writerEntered = new Promise<void>((resolve) => { writerReady = resolve; });
  const readerEntered = new Promise<void>((resolve) => { readerReady = resolve; });
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let paused = false;
  const gatedWriter = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!paused && sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) { paused = true; writerReady(); await writerGate; }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  let passedProjectGate = false, loadedSourceAccess = false;
  const startedReader = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      readerReady(); return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) passedProjectGate = true;
          return output;
        };
        if (key === "factSourceAccess" && value && typeof value === "object") return new Proxy(value, { get(model, method) {
          const fn = Reflect.get(model, method);
          if (method === "findMany" && typeof fn === "function") return async (...args: unknown[]) => {
            const output = await Reflect.apply(fn, model, args); loadedSourceAccess = true; return output;
          };
          return typeof fn === "function" ? fn.bind(model) : fn;
        } });
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const initial = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  const writer = new DatabaseProjectFactRepository(gatedWriter as never).setSourceAccess(f.pmo, { projectId: f.projectId, sourceId,
    expectedRevision: initial!.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
  void writer.catch(() => {});
  let waiting: ReturnType<DatabaseScalarConflictObservationRepository["readLeadership"]> | undefined, writerFirst = false;
  try {
    await Promise.race([writerEntered, writer.then(() => { throw new Error("Writer exited before barrier"); })]);
    waiting = makeReader(startedReader).readLeadership(f.leader, f.projectId, f.input.factId); void waiting.catch(() => {});
    await Promise.race([readerEntered, waiting.then(() => { throw new Error("Reader exited before barrier"); })]);
    writerFirst = await blocked(readerPid, writerPid, ['FROM public."Project"', "FOR SHARE"]);
  } finally { releaseWriter(); await Promise.allSettled(waiting ? [writer, waiting] : [writer]); }
  expect(writerFirst).toBe(true); await writer;
  await expect(waiting).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(passedProjectGate && loadedSourceAccess).toBe(true);
  expect(await db.factSourceReader.count({ where: { customerId, projectId: f.projectId, sourceId, subject: f.leader.subject } })).toBe(0);
  const revoked = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  const restored = await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: revoked!.revision,
    state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, f.leader.subject] }, context);
  expect((await makeReader(startedReader).readLeadership(f.leader, f.projectId, f.input.factId)).positions).toHaveLength(2);

  let heldPid = 0, latePid = 0, heldReady!: () => void, lateReady!: () => void, releaseHeld!: () => void, held = false;
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const lateEntered = new Promise<void>((resolve) => { lateReady = resolve; });
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const heldReader = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      heldPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!held && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) { held = true; heldReady(); await heldGate; }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const startedWriter = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      latePid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      lateReady(); return operation(tx);
    }, options as never) };
  const observation = makeReader(heldReader).readLeadership(f.leader, f.projectId, f.input.factId); void observation.catch(() => {});
  let later: ReturnType<DatabaseProjectFactRepository["setSourceAccess"]> | undefined, readerFirst = false;
  try {
    await Promise.race([heldEntered, observation.then(() => { throw new Error("Reader exited before barrier"); })]);
    later = new DatabaseProjectFactRepository(startedWriter as never).setSourceAccess(f.pmo, { projectId: f.projectId, sourceId,
      expectedRevision: restored.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
    void later.catch(() => {});
    await Promise.race([lateEntered, later.then(() => { throw new Error("Writer exited before barrier"); })]);
    readerFirst = await blocked(latePid, heldPid, ['FROM "Project"', "FOR UPDATE"]);
  } finally { releaseHeld(); await Promise.allSettled(later ? [observation, later] : [observation]); }
  expect(readerFirst).toBe(true); expect((await observation).positions).toHaveLength(2); await later;
  expect(await db.factSourceReader.count({ where: { customerId, projectId: f.projectId, sourceId, subject: f.leader.subject } })).toBe(0);
  await expect(makeReader(startedReader).readLeadership(f.leader, f.projectId, f.input.factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
}, 60000);
it("coordinates existing leadership grant removal and scalar observation in both lock orders", async () => {
  const f = await fixture(false);
  const grant = await db.accessGrant.findFirstOrThrow({ where: { customerId, subject: f.leader.subject, role: "leadership" } });
  const reader = (database: unknown) => new DatabaseScalarConflictObservationRepository(database as never);
  async function blocked(waiting: number, blocking: number, fragments: string[]) {
    for (let i = 0; i < 40; i++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && fragments.every((part) => rows[0]!.query.includes(part))) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  let writerPid = 0, readerPid = 0, writerReady!: () => void, readerReady!: () => void, releaseWriter!: () => void;
  const writerEntered = new Promise<void>((resolve) => { writerReady = resolve; });
  const readerEntered = new Promise<void>((resolve) => { readerReady = resolve; });
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writer = db.$transaction(async (tx) => {
    writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    await tx.accessGrant.delete({ where: { id: grant.id } }); writerReady(); await writerGate;
  }, { timeout: 20000 });
  void writer.catch(() => {});
  let finishedGrantQuery = false, returnedGrantCount = -1;
  const startedReader = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      readerReady(); return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) {
            finishedGrantQuery = true; returnedGrantCount = Array.isArray(output) ? output.length : -1;
          }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  let waiting: ReturnType<DatabaseScalarConflictObservationRepository["readLeadership"]> | undefined, writerFirst = false;
  try {
    await Promise.race([writerEntered, writer.then(() => { throw new Error("Grant writer exited before barrier"); })]);
    waiting = reader(startedReader).readLeadership(f.leader, f.projectId, f.input.factId); void waiting.catch(() => {});
    await Promise.race([readerEntered, waiting.then(() => { throw new Error("Reader exited before barrier"); })]);
    writerFirst = await blocked(readerPid, writerPid, ['FROM public."AccessGrant"', "FOR SHARE"]);
  } finally { releaseWriter(); await Promise.allSettled(waiting ? [writer, waiting] : [writer]); }
  expect(writerFirst).toBe(true); await writer;
  await expect(waiting).rejects.toMatchObject({ code: "DENIED" });
  expect(finishedGrantQuery && returnedGrantCount === 0).toBe(true);
  expect(await db.accessGrant.findUnique({ where: { id: grant.id } })).toBeNull();
  await db.accessGrant.create({ data: { id: grant.id, customerId, subject: grant.subject,
    scopeType: grant.scopeType, scopeId: grant.scopeId, role: grant.role } });
  expect((await reader(startedReader).readLeadership(f.leader, f.projectId, f.input.factId)).positions).toHaveLength(2);

  let heldPid = 0, latePid = 0, heldReady!: () => void, lateReady!: () => void, releaseHeld!: () => void, held = false;
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const lateEntered = new Promise<void>((resolve) => { lateReady = resolve; });
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  const heldReader = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      heldPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!held && sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) { held = true; heldReady(); await heldGate; }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const observation = reader(heldReader).readLeadership(f.leader, f.projectId, f.input.factId); void observation.catch(() => {});
  let later: Promise<unknown> | undefined, readerFirst = false;
  try {
    await Promise.race([heldEntered, observation.then(() => { throw new Error("Reader exited before grant barrier"); })]);
    later = db.$transaction(async (tx) => {
      latePid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      lateReady(); await tx.accessGrant.delete({ where: { id: grant.id } });
    }, { timeout: 20000 });
    void later.catch(() => {});
    await Promise.race([lateEntered, later.then(() => { throw new Error("Grant writer exited before barrier"); })]);
    readerFirst = await blocked(latePid, heldPid, ["DELETE", '"AccessGrant"']);
  } finally { releaseHeld(); await Promise.allSettled(later ? [observation, later] : [observation]); }
  expect(readerFirst).toBe(true); expect((await observation).positions).toHaveLength(2); await later;
  expect(await db.accessGrant.findUnique({ where: { id: grant.id } })).toBeNull();
  await expect(reader(startedReader).readLeadership(f.leader, f.projectId, f.input.factId)).rejects.toMatchObject({ code: "DENIED" });
}, 60000);
it("denies a first leadership grant until a later read in both insertion orders", async () => {
  const f = await fixture(false);
  const grant = await db.accessGrant.findFirstOrThrow({ where: { customerId, subject: f.leader.subject, role: "leadership" } });
  await db.accessGrant.delete({ where: { id: grant.id } });
  const grantData = { id: grant.id, customerId, subject: grant.subject, scopeType: grant.scopeType, scopeId: grant.scopeId, role: grant.role };
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
  const reader = new DatabaseScalarConflictObservationRepository(roleDb as never);
  let inserted!: () => void, releaseWriter!: () => void;
  const writerEntered = new Promise<void>((resolve) => { inserted = resolve; });
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writer = db.$transaction(async (tx) => { await tx.accessGrant.create({ data: grantData }); inserted(); await writerGate; }, { timeout: 20000 });
  void writer.catch(() => {});
  async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 2000);
    })]); } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  let beforeCommit: unknown;
  let pendingRead: Promise<unknown> | undefined;
  try {
    await Promise.race([writerEntered, writer.then(() => { throw new Error("Writer exited before barrier"); })]);
    pendingRead = reader.readLeadership(f.leader, f.projectId, f.input.factId).then(() => "unexpected success", (error) => error.code);
    beforeCommit = await within(pendingRead, "Absent grant read unexpectedly blocked");
  } finally { releaseWriter(); await Promise.allSettled(pendingRead ? [writer, pendingRead] : [writer]); }
  expect(beforeCommit).toBe("DENIED"); await writer;
  expect((await reader.readLeadership(f.leader, f.projectId, f.input.factId)).positions).toHaveLength(2);
  await db.accessGrant.delete({ where: { id: grant.id } });

  let observed!: () => void, releaseReader!: () => void, held = false, heldGrantCount = -1;
  const readerEntered = new Promise<void>((resolve) => { observed = resolve; });
  const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
  const heldDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!held && sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) {
            held = true; heldGrantCount = Array.isArray(output) ? output.length : -1; observed(); await readerGate;
          }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const oldRead = new DatabaseScalarConflictObservationRepository(heldDb as never).readLeadership(f.leader, f.projectId, f.input.factId);
  void oldRead.catch(() => {});
  let insertion: Promise<unknown> | undefined;
  try {
    await Promise.race([readerEntered, oldRead.then(() => { throw new Error("Reader exited before grant barrier"); })]);
    expect(heldGrantCount).toBe(0);
    insertion = db.accessGrant.create({ data: grantData }); void insertion.catch(() => {});
    await within(insertion, "First grant insertion unexpectedly blocked");
  } finally { releaseReader(); await Promise.allSettled(insertion ? [oldRead, insertion] : [oldRead]); }
  await expect(oldRead).rejects.toMatchObject({ code: "DENIED" });
  expect((await reader.readLeadership(f.leader, f.projectId, f.input.factId)).positions).toHaveLength(2);
}, 60000);
it.each(["fact-append", "policy-disable", "conflict-capture", "first-fact", "first-policy", "first-source", "first-observed-policy"] as const)(
  "coordinates %s and the scalar observation in both project-lock orders", async (kind) => {
    for (const order of ["writer-first", "reader-first"] as const) {
      const f = await fixture(false, true, kind !== "first-observed-policy");
      const newAuthor: Actor = { customerId, subject: "scalar-new-author-" + randomUUID(), roles: ["pmo_admin"] };
      if (kind === "first-source") await db.accessGrant.create({ data: { customerId, subject: newAuthor.subject,
        scopeType: "project", scopeId: f.projectId, role: "pmo_admin" } });
      let writerPid = 0, readerPid = 0, writerReady!: () => void, readerReady!: () => void, release!: () => void, held = false;
      const writerEntered = new Promise<void>((resolve) => { writerReady = resolve; });
      const readerEntered = new Promise<void>((resolve) => { readerReady = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const writerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
        db.$transaction(async (tx) => {
          writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
          if (order === "reader-first") writerReady();
          return operation(new Proxy(tx, { get(target, key) {
            const value = Reflect.get(target, key);
            if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
              const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
              if (order === "writer-first" && !held && sql.includes('"Project"') && sql.includes("FOR UPDATE")) {
                held = true; writerReady(); await gate;
              }
              return output;
            };
            return typeof value === "function" ? value.bind(target) : value;
          } }));
        }, options as never) };
      const readerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
          readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
          if (order === "writer-first") readerReady();
          return operation(new Proxy(tx, { get(target, key) {
            const value = Reflect.get(target, key);
            if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
              const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
              if (order === "reader-first" && !held && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) {
                held = true; readerReady(); await gate;
              }
              return output;
            };
            return typeof value === "function" ? value.bind(target) : value;
          } }));
        }, options as never) };
      const reader = new DatabaseScalarConflictObservationRepository(readerDb as never);
      const write = () => {
        const effectiveAt = new Date().toISOString();
        if (kind === "fact-append" || kind === "first-fact" || kind === "first-source") return new DatabaseProjectFactRepository(writerDb as never).appendHumanStatement(kind === "first-source" ? newAuthor : f.pmo, {
          projectId: f.projectId, factType: kind === "first-fact" ? "zz.first_fact" : f.factType, expectedRevision: kind === "first-fact" ? 0 : 2,
          idempotencyKey: randomUUID(), effectiveAt, validUntil: new Date(Date.now() + 3600000).toISOString(),
          originalStatement: "Synthetic race fact", value: { type: "date", value: "2026-10-03" },
        }, context);
        if (kind === "policy-disable" || kind === "first-policy" || kind === "first-observed-policy") return new DatabaseAuthorityRepository(writerDb as never).appendPolicy(f.pmo, {
          projectId: f.projectId, factType: kind === "first-policy" ? "zz.first_policy" : f.factType,
          expectedRevision: kind === "policy-disable" ? 1 : 0, idempotencyKey: randomUUID(), effectiveAt,
          definition: kind === "policy-disable" ? null : { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
            requiredApproval: "NOT_REQUIRED", validity: null }] }], conflictBehavior: "RETAIN_CONFLICT" },
        }, context);
        return new DatabaseScalarReconciliationRepository(writerDb as never).check(f.pmo, f.input, context);
      };
      async function blocked(waiting: number, blocking: number, fragments: string[]) {
        for (let i = 0; i < 40; i++) {
          const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
            "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
          if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && fragments.every((part) => rows[0]!.query.includes(part))) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
      }
      let writeResult: ReturnType<typeof write> | undefined;
      let readResult: ReturnType<DatabaseScalarConflictObservationRepository["readLeadership"]> | undefined;
      let sawBlock = false;
      try {
        if (order === "writer-first") {
          writeResult = write(); void writeResult.catch(() => {});
          await Promise.race([writerEntered, writeResult.then(() => { throw new Error("Writer exited before barrier"); })]);
          readResult = reader.readLeadership(f.leader, f.projectId, f.input.factId); void readResult.catch(() => {});
          await Promise.race([readerEntered, readResult.then(() => { throw new Error("Reader exited before barrier"); })]);
          sawBlock = await blocked(readerPid, writerPid, ['FROM public."Project"', "FOR SHARE"]);
        } else {
          readResult = reader.readLeadership(f.leader, f.projectId, f.input.factId); void readResult.catch(() => {});
          await Promise.race([readerEntered, readResult.then(() => { throw new Error("Reader exited before barrier"); })]);
          writeResult = write(); void writeResult.catch(() => {});
          await Promise.race([writerEntered, writeResult.then(() => { throw new Error("Writer exited before barrier"); })]);
          sawBlock = await blocked(writerPid, readerPid, ['"Project"', "FOR UPDATE"]);
        }
      } finally { release(); await Promise.allSettled([...(readResult ? [readResult] : []), ...(writeResult ? [writeResult] : [])]); }
      expect(sawBlock).toBe(true); await writeResult;
      if ((order === "writer-first" && (kind === "policy-disable" || kind === "first-source")) ||
        (order === "reader-first" && kind === "first-observed-policy")) await expect(readResult).rejects.toMatchObject({ code: "UNAVAILABLE" });
      else {
        const values = (await readResult!).positions.map((position) => position.value);
        expect(values).toEqual(order === "writer-first" && kind === "fact-append" ? ["2026-10-02", "2026-10-03"] : ["2026-10-01", "2026-10-02"]);
      }
      if (kind === "conflict-capture") expect(await db.factAuthorityConflict.count({ where: { customerId, projectId: f.projectId, factId: f.input.factId } })).toBeGreaterThan(0);
      if (kind === "policy-disable" || kind === "first-source") await expect(reader.readLeadership(f.leader, f.projectId, f.input.factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      else expect((await reader.readLeadership(f.leader, f.projectId, f.input.factId)).positions.map((position) => position.value))
        .toEqual(kind === "fact-append" ? ["2026-10-02", "2026-10-03"] : ["2026-10-01", "2026-10-02"]);
    }
  }, 120000,
);
it("coordinates a modeled health-style SHARE-to-conflict-insert upgrade in both orders", async () => {
  for (const order of ["writer-first", "reader-first"] as const) {
    const f = await fixture(false);
    const policy = await db.authorityPolicyRevision.findFirstOrThrow({ where: { customerId, projectId: f.projectId, factType: f.factType } });
    const [leftVersionId, rightVersionId] = f.versions.map((entry) => entry.id).sort();
    let writerPid = 0, readerPid = 0, writerReady!: () => void, readerReady!: () => void, release!: () => void, held = false;
    const writerEntered = new Promise<void>((resolve) => { writerReady = resolve; });
    const readerEntered = new Promise<void>((resolve) => { readerReady = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = () => db.$transaction(async (tx) => {
      writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      await tx.$queryRaw`SELECT id FROM public."Project" WHERE "customerId"=${customerId}::uuid AND id=${f.projectId}::uuid FOR SHARE`;
      if (order === "reader-first") writerReady();
      await tx.factAuthorityConflict.create({ data: { id: randomUUID(), customerId, projectId: f.projectId, factId: f.input.factId,
        factType: f.factType, leftVersionId: leftVersionId!, rightVersionId: rightVersionId!, policyRevisionId: policy.id,
        detectedAt: new Date(), revision: 1 } });
      if (order === "writer-first") { writerReady(); await gate; }
    }, { timeout: 20000 });
    const readerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (order === "writer-first") readerReady();
        return operation(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
            const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
            if (order === "reader-first" && !held && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) {
              held = true; readerReady(); await gate;
            }
            return output;
          };
          return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const reader = new DatabaseScalarConflictObservationRepository(readerDb as never);
    async function blocked(waiting: number, blocking: number, parts: string[]) {
      for (let i = 0; i < 40; i++) {
        const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
          "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
        if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && parts.every((part) => rows[0]!.query.includes(part))) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }
    let writeResult: ReturnType<typeof writer> | undefined, readResult: ReturnType<DatabaseScalarConflictObservationRepository["readLeadership"]> | undefined, sawBlock = false;
    try {
      if (order === "writer-first") {
        writeResult = writer(); void writeResult.catch(() => {});
        await Promise.race([writerEntered, writeResult.then(() => { throw new Error("Writer exited before barrier"); })]);
        readResult = reader.readLeadership(f.leader, f.projectId, f.input.factId); void readResult.catch(() => {});
        await Promise.race([readerEntered, readResult.then(() => { throw new Error("Reader exited before barrier"); })]);
        sawBlock = await blocked(readerPid, writerPid, ['FROM public."Project"', "FOR SHARE"]);
      } else {
        readResult = reader.readLeadership(f.leader, f.projectId, f.input.factId); void readResult.catch(() => {});
        await Promise.race([readerEntered, readResult.then(() => { throw new Error("Reader exited before barrier"); })]);
        writeResult = writer(); void writeResult.catch(() => {});
        await Promise.race([writerEntered, writeResult.then(() => { throw new Error("Writer exited before barrier"); })]);
        sawBlock = await blocked(writerPid, readerPid, ["INSERT", '"FactAuthorityConflict"']);
      }
    } finally { release(); await Promise.allSettled([...(readResult ? [readResult] : []), ...(writeResult ? [writeResult] : [])]); }
    expect(sawBlock).toBe(true); await writeResult;
    expect((await readResult!).positions).toHaveLength(2);
    expect(await db.factAuthorityConflict.count({ where: { customerId, projectId: f.projectId, factId: f.input.factId } })).toBe(1);
    expect((await reader.readLeadership(f.leader, f.projectId, f.input.factId)).positions).toHaveLength(2);
  }
}, 60000);
it("coordinates real health conflict capture with a role-switched scalar observation in both orders", async () => {
  for (const order of ["writer-first", "reader-first"] as const) {
    const tenant = randomUUID(), portfolioId = randomUUID();
    const pmo: Actor = { customerId: tenant, subject: "health-race-pmo-" + randomUUID(), roles: ["pmo_admin"] };
    const pm: Actor = { customerId: tenant, subject: "health-race-pm-" + randomUUID(), roles: ["project_manager"] };
    const leader: Actor = { customerId: tenant, subject: "health-race-leader-" + randomUUID(), roles: ["leadership"] };
    await db.customer.create({ data: { id: tenant, name: "Synthetic health concurrency customer" } });
    await db.portfolio.create({ data: { id: portfolioId, customerId: tenant, name: "Synthetic health concurrency portfolio" } });
    await db.accessGrant.createMany({ data: [pmo, pm, leader].map((actor) => ({ customerId: tenant, subject: actor.subject,
      scopeType: "portfolio", scopeId: portfolioId, role: actor.roles[0]! })) });
    const projectInput = canonicalFixture(portfolioId);
    projectInput.responsibilities = projectInput.responsibilities.map((row) => row.role === "PROJECT_MANAGER" ? { ...row, subject: pm.subject } : row);
    projectInput.raidItems = projectInput.raidItems.map((row, index) => ({ ...row, state: index === 0 ? "OPEN" : "COMPLETE" }));
    const projectId = (await canonical.createProject(pmo, projectInput, randomUUID())).id;
    const raid = await db.raidItem.findFirstOrThrow({ where: { customerId: tenant, projectId, state: "OPEN" } });
    const health = new DatabaseHealthAssessmentRepository(db);
    await health.setRetention(pmo, { contentRetentionHours: 24, auditRetentionHours: 48, idempotencyRetentionHours: 72 }, randomUUID());
    await health.setBlockerAgeThresholdPolicy(pmo, { expectedRevision: 0, minimumBlockerAgeDays: 5, auditRetentionHours: 720 }, randomUUID());
    const [clock] = await db.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
    const effectiveAt = new Date(clock!.now.getTime() - 60000).toISOString(), validUntil = new Date(clock!.now.getTime() + 3600000).toISOString();
    const dates = [11, 10].map((days) => new Date(clock!.now.getTime() - days * 86400000).toISOString().slice(0, 10));
    const current = { tiers: [{ selectors: [{ sourceType: "human_statement" as const, instanceId: null,
      requiredApproval: "NOT_REQUIRED" as const, validity: { basis: "observedAt" as const, durationMs: 86400000 } }] }], conflictBehavior: "RETAIN_CONFLICT" as const };
    const ongoing = { tiers: [{ selectors: [{ sourceType: "human_statement" as const, instanceId: null,
      requiredApproval: "NOT_REQUIRED" as const, validity: { mode: "UNTIL_SUPERSEDED" as const } }] }], conflictBehavior: "RETAIN_CONFLICT" as const };
    const testContext = { correlationId: randomUUID() };
    const configure = async (factType: string, definition: typeof current | typeof ongoing) => authority.appendPolicy(pmo,
      { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt, definition }, testContext);
    const add = async (actor: Actor, factType: string, revision: number, value: { type: "boolean"; value: boolean } | { type: "date"; value: string }) => {
      const entry = await facts.appendHumanStatement(actor, { projectId, factType, expectedRevision: revision, idempotencyKey: randomUUID(),
        effectiveAt, validUntil, originalStatement: "Synthetic health and scalar concurrency evidence.", value }, testContext);
      await facts.setSourceAccess(pmo, { projectId, sourceId: entry.entry.sourceId, expectedRevision: entry.entry.sourceAccessRevision,
        state: "AVAILABLE", readers: [pmo.subject, pm.subject, leader.subject] }, testContext);
      return entry;
    };
    const inventoryType = "project.open_blocker_inventory_complete", classificationType = `raid_item.${raid.id}.blocks_delivery`,
      openedType = `raid_item.${raid.id}.opened_at`;
    await configure(inventoryType, current); await add(pmo, inventoryType, 0, { type: "boolean", value: true });
    await configure(classificationType, current); await add(pmo, classificationType, 0, { type: "boolean", value: true });
    const openedPolicy = await configure(openedType, ongoing);
    const first = await add(pmo, openedType, 0, { type: "date", value: dates[0]! });
    const second = await add(pm, openedType, 1, { type: "date", value: dates[1]! });
    const factId = first.factId;
    expect(await db.factAuthorityConflict.count({ where: { customerId: tenant, projectId, factId } })).toBe(0);
    let writerPid = 0, readerPid = 0, writerReady!: () => void, readerReady!: () => void, release!: () => void, held = false;
    const writerEntered = new Promise<void>((resolve) => { writerReady = resolve; });
    const readerEntered = new Promise<void>((resolve) => { readerReady = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        return operation(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "factAuthorityConflict") return new Proxy(value, { get(model, method) {
            const fn = Reflect.get(model, method);
            if (method === "createMany" && typeof fn === "function") return async (...args: unknown[]) => {
              if (order === "reader-first") writerReady();
              const result = await Reflect.apply(fn, model, args);
              if (order === "writer-first") { writerReady(); await gate; }
              return result;
            };
            return typeof fn === "function" ? fn.bind(model) : fn;
          } });
          return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const readerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        expect((await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role"))[0]?.role).toBe("pdaa_api");
        readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (order === "writer-first") readerReady();
        return operation(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
            const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
            if (order === "reader-first" && !held && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) {
              held = true; readerReady(); await gate;
            }
            return output;
          };
          return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const writer = new DatabaseHealthAssessmentRepository(writerDb as never);
    const reader = new DatabaseScalarConflictObservationRepository(readerDb as never);
    async function blocked(waiting: number, blocking: number, parts: string[]) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
          "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
        if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && parts.every((part) => rows[0]!.query.includes(part))) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }
    let writeResult: ReturnType<DatabaseHealthAssessmentRepository["create"]> | undefined;
    let readResult: ReturnType<DatabaseScalarConflictObservationRepository["readLeadership"]> | undefined;
    let sawBlock: boolean;
    try {
      if (order === "writer-first") {
        writeResult = writer.create(pm, projectId, randomUUID(), randomUUID()); void writeResult.catch(() => {});
        await Promise.race([writerEntered, writeResult.then(() => { throw new Error("Health writer exited before barrier"); })]);
        readResult = reader.readLeadership(leader, projectId, factId); void readResult.catch(() => {});
        await Promise.race([readerEntered, readResult.then(() => { throw new Error("Scalar reader exited before barrier"); })]);
        sawBlock = await blocked(readerPid, writerPid, ['FROM public."Project"', "FOR SHARE"]);
      } else {
        readResult = reader.readLeadership(leader, projectId, factId); void readResult.catch(() => {});
        await Promise.race([readerEntered, readResult.then(() => { throw new Error("Scalar reader exited before barrier"); })]);
        writeResult = writer.create(pm, projectId, randomUUID(), randomUUID()); void writeResult.catch(() => {});
        await Promise.race([writerEntered, writeResult.then(() => { throw new Error("Health writer exited before barrier"); })]);
        sawBlock = await blocked(writerPid, readerPid, ["INSERT", '"FactAuthorityConflict"']);
      }
    } finally { release(); await Promise.allSettled([...(readResult ? [readResult] : []), ...(writeResult ? [writeResult] : [])]); }
    expect(sawBlock).toBe(true);
    expect(writerPid).toBeGreaterThan(0); expect(readerPid).toBeGreaterThan(0); expect(writerPid).not.toBe(readerPid);
    const saved = await writeResult;
    expect(saved).toMatchObject({ contentAvailable: true, blockerAgeCoverage: "UNASSESSABLE", input: { blockerAge: { candidates: [{
      raidItemId: raid.id, outcome: "UNASSESSABLE_OPENED_AT", openedAt: { factId, status: "UNKNOWN", reason: "CONFLICTING" },
    }] } } });
    const observed = await readResult!;
    expect(observed.positions.map((row) => row.value)).toEqual(dates);
    for (const [index, version] of [first.entry, second.entry].entries()) expect(observed.positions[index]!.supports).toMatchObject([{
      versionId: version.id, evidenceId: version.evidenceId, sourceId: version.sourceId, provenance: "HUMAN_CONFIRMED",
    }]);
    const conflicts = await db.factAuthorityConflict.findMany({ where: { customerId: tenant, projectId, factId } });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ policyRevisionId: openedPolicy.event.id, revision: 1,
      leftVersionId: [first.entry.id, second.entry.id].sort()[0], rightVersionId: [first.entry.id, second.entry.id].sort()[1] });
    expect(await db.healthAssessment.count({ where: { customerId: tenant, projectId } })).toBe(1);
    expect((await reader.readLeadership(leader, projectId, factId)).positions.map((row) => row.value)).toEqual(dates);
  }
}, 120000);
it("FR-EVD-007/012: commits owned scalar proof, byte-identical SQL identity and distinct retry/business reuse", async () => {
  const f = await fixture();
  const first = await reconciliation.check(f.pmo, f.input, context);
  expect(first.outcome).toBe("CREATED");
  expect(first.request?.assignment.reason).toBe("ASSIGNED");
  const proof = await db.factAssessment.findUniqueOrThrow({
    where: { id: first.assessment.assessmentId },
  });
  expect(proof.captureKind).toBe("SCALAR_REQUEST");
  expect(proof.scalarReconciliationCheckId).toBe(first.checkId);
  const sql = await db.$queryRaw<
    { identity: string; valid: boolean }[]
  >`SELECT public.scalar_reconciliation_identity(${proof.id}::uuid) AS identity,public.valid_scalar_reconciliation_check(${first.checkId}::uuid) AS valid`;
  expect(sql[0]?.valid).toBe(true);
  expect(sql[0]?.identity).toBe(scalarReconciliationIdentity(proof.result));
  const replay = await reconciliation.check(f.pmo, f.input, context);
  expect(replay.checkId).toBe(first.checkId);
  expect(replay.replayed).toBe(true);
  const reused = await reconciliation.check(
    f.pmo,
    { ...f.input, idempotencyKey: randomUUID() },
    context,
  );
  expect(reused.outcome).toBe("REUSED");
  expect(reused.request?.id).toBe(first.request?.id);
  expect(reused.assessment.assessmentId).not.toBe(proof.id);
  expect(reused.request?.assignment).toEqual(first.request?.assignment);
  // FR-EVD-007/012, NFR-REL-001: the CREATED fast path and distinct
  // REUSED path must independently validate their real owned proofs.
  const reusedProof = await db.factAssessment.findUniqueOrThrow({
    where: { id: reused.assessment.assessmentId },
  });
  expect(reusedProof.scalarReconciliationCheckId).toBe(reused.checkId);
  expect(reused.checkId).not.toBe(first.checkId);
  const bound = await db.$queryRaw<
    {
      createdValid: boolean;
      reusedValid: boolean;
      requestValid: boolean;
      createdAssessmentId: string;
      reusedAssessmentId: string;
      originalAssessmentId: string;
      originCommandId: string;
    }[]
  >`SELECT
    public.valid_scalar_reconciliation_check(c.id) AS "createdValid",
    public.valid_scalar_reconciliation_check(reused.id) AS "reusedValid",
    public.valid_scalar_reconciliation_request(r.id) AS "requestValid",
    c."assessmentId" AS "createdAssessmentId",
    reused."assessmentId" AS "reusedAssessmentId",
    r."originalAssessmentId",r."originCommandId"
    FROM public."ScalarReconciliationCheck" c
    JOIN public."ScalarReconciliationRequest" r ON r.id=c."requestId"
    JOIN public."ScalarReconciliationCheck" reused ON reused.id=${reused.checkId}::uuid
      AND reused."requestId"=r.id
    WHERE c.id=${first.checkId}::uuid AND c."customerId"=${customerId}::uuid
      AND c."projectId"=${f.projectId}::uuid`;
  expect(bound).toEqual([
    {
      createdValid: true,
      reusedValid: true,
      requestValid: true,
      createdAssessmentId: proof.id,
      reusedAssessmentId: reusedProof.id,
      originalAssessmentId: proof.id,
      originCommandId: first.checkId,
    },
  ]);
  expect(
    await db.factAssessment.findUnique({ where: { id: proof.id } }),
  ).toEqual(proof);
  expect(
    await reconciliation.check(
      f.pm,
      { ...f.input, idempotencyKey: randomUUID() },
      context,
    ),
  ).toMatchObject({ outcome: "REUSED" });
  const detail = await reconciliation.get(f.pm, {
    projectId: f.projectId,
    requestId: first.request!.id,
  });
  expect(detail?.assessment.assessmentId).toBe(proof.id);
  expect(
    await reconciliation.get(f.pmo, {
      projectId: f.projectId,
      requestId: first.request!.id,
    }),
  ).toBeNull();
});
it("FR-ADM-005: persists an owned negative check for explicit policy opt-out", async () => {
  const f = await fixture(true, false),
    result = await reconciliation.check(f.pmo, f.input, context);
  expect(result.outcome).toBe("NO_REQUEST");
  expect(result.request).toBeNull();
  const valid = await db.$queryRaw<
    { valid: boolean }[]
  >`SELECT public.valid_scalar_reconciliation_check(${result.checkId}::uuid) AS valid`;
  expect(valid[0]?.valid).toBe(true);
});
it("NFR-REL-002: an occupied-hash read shim rejects unequal scalar identity and rolls back every proof family", async () => {
  const f = await fixture();
  const first = await reconciliation.check(f.pmo, f.input, context);
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of [
      "ProjectFact",
      "ProjectFactVersion",
      "FactEvidence",
      "FactAuthorityConflict",
      "FactAssessment",
      "FactAssessmentVersion",
      "FactAssessmentConflict",
      "ScalarReconciliationCheck",
      "ScalarReconciliationRequest",
      "ScalarReconciliationAssignment",
      "AuditEvent",
    ]) {
      const scope =
        table === "AuditEvent"
          ? `detail->>'projectId'=$2`
          : `"projectId"=$2::uuid`;
      rows[table] = await db.$queryRawUnsafe(
        `SELECT to_jsonb(t)::text AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${scope} ORDER BY to_jsonb(t)::text COLLATE "C"`,
        customerId,
        f.projectId,
      );
    }
    return rows;
  };
  const before = await snapshot();
  let lookups = 0,
    injectedUnequalIdentity = false;
  // Labelled application branch control, NOT a generated SHA-256 collision.
  // Only the occupied-hash read result changes; native capture, guards and
  // transaction options are real and the full transaction must roll back.
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === "$transaction")
        return (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: Parameters<typeof db.$transaction>[1],
        ) =>
          target.$transaction(
            async (tx) =>
              callback(
                new Proxy(tx, {
                  get(transaction, name) {
                    if (name === "scalarReconciliationRequest")
                      return new Proxy(
                        transaction.scalarReconciliationRequest,
                        {
                          get(delegate, operation) {
                            if (operation === "findUnique")
                              return async (
                                input: Parameters<
                                  typeof delegate.findUnique
                                >[0],
                              ) => {
                                expect(
                                  input.where
                                    .customerId_projectId_factId_ruleRevision_contributorHash,
                                ).toMatchObject({
                                  customerId,
                                  projectId: f.projectId,
                                  factId: f.input.factId,
                                });
                                lookups++;
                                const actual = await delegate.findUnique(input);
                                expect(actual?.id).toBe(first.request!.id);
                                // Assert completion outside the repository's finite-error
                                // boundary so a failed fixture assertion cannot pass as the
                                // intended unequal-identity rejection.
                                injectedUnequalIdentity = true;
                                return {
                                  ...actual,
                                  contributorIdentity:
                                    "test-only unequal occupied identity",
                                };
                              };
                            const value = Reflect.get(delegate, operation);
                            return typeof value === "function"
                              ? value.bind(delegate)
                              : value;
                          },
                        },
                      );
                    const value = Reflect.get(transaction, name);
                    return typeof value === "function"
                      ? value.bind(transaction)
                      : value;
                  },
                }),
              ),
            options,
          );
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    new DatabaseScalarReconciliationRepository(observed).check(
      f.pmo,
      { ...f.input, idempotencyKey: randomUUID() },
      context,
    ),
  ).rejects.toThrow("Scalar reconciliation check unavailable");
  expect(lookups).toBe(1);
  expect(injectedUnequalIdentity).toBe(true);
  expect(await snapshot()).toEqual(before);
});
it("NFR-SEC-001 / FR-EVD-012: withdrawal of a retained non-contributor withholds original proof without closing the case", async () => {
  const f = await fixture();
  const third: Actor = {
    customerId,
    subject: "scalar-third-" + randomUUID(),
    roles: ["project_manager"],
  };
  await db.accessGrant.create({
    data: {
      customerId,
      subject: third.subject,
      role: "project_manager",
      scopeType: "project",
      scopeId: f.projectId,
    },
  });
  const effectiveAt = new Date(Date.now() - 1000).toISOString();
  const appended = await facts.appendHumanStatement(
    third,
    {
      projectId: f.projectId,
      factType: f.factType,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      effectiveAt,
      validUntil: new Date(Date.now() + 3600000).toISOString(),
      originalStatement: "Synthetic lower-authority corroboration",
      value: { type: "date", value: "2026-10-01" },
    },
    context,
  );
  const sourceId = appended.entry.sourceId;
  const access = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: access!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject, f.pm.subject, third.subject],
    },
    context,
  );
  const selector = (instanceId: string) => ({
    sourceType: "human_statement",
    instanceId,
    requiredApproval: "NOT_REQUIRED" as const,
    validity: null,
  });
  await authority.appendPolicy(
    f.pmo,
    {
      projectId: f.projectId,
      factType: f.factType,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      effectiveAt,
      definition: {
        conflictBehavior: "REQUEST_RECONCILIATION",
        tiers: [
          { selectors: f.versions.map((v) => selector(v.sourceId)) },
          { selectors: [selector(sourceId)] },
        ],
      },
    },
    context,
  );
  const first = await reconciliation.check(f.pmo, f.input, context);
  expect(first.outcome).toBe("CREATED");
  expect(first.assessment.result?.versions).toHaveLength(3);
  const request = await db.scalarReconciliationRequest.findUniqueOrThrow({
    where: { id: first.request!.id },
  });
  const contributors = JSON.parse(request.contributorIdentity)[5] as string[][];
  expect(contributors.map((v) => v[1]).sort()).toEqual(
    f.versions.map((v) => v.sourceId).sort(),
  );
  expect(contributors.some((v) => v[1] === sourceId)).toBe(false);
  const read = { projectId: f.projectId, requestId: request.id };
  expect(await reconciliation.get(f.pm, read)).toMatchObject({
    assessment: { visibility: "available" },
  });
  const proof = await db.factAssessment.findUniqueOrThrow({
    where: { id: first.assessment.assessmentId },
  });
  const current = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  const retained = await db.factAssessmentVersion.findMany({
    where: { assessmentId: proof.id, version: { sourceId } },
  });
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    customerId,
    projectId: f.projectId,
    factId: f.input.factId,
  });
  expect(contributors.some((v) => v[0] === retained[0]!.versionId)).toBe(false);
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: current!.revision,
      state: "AVAILABLE",
      readers: [third.subject],
    },
    context,
  );
  expect(await reconciliation.get(f.pm, read)).toMatchObject({
    assessment: { visibility: "restricted", result: null },
  });
  expect(await reconciliation.check(f.pmo, f.input, context)).toMatchObject({
    checkId: first.checkId,
    outcome: "CREATED",
    replayed: true,
    assessment: { visibility: "restricted", result: null },
  });
  const fresh = await reconciliation.check(
    f.pmo,
    { ...f.input, idempotencyKey: randomUUID() },
    context,
  );
  expect(fresh).toMatchObject({
    outcome: "NO_REQUEST",
    request: null,
    assessment: { visibility: "restricted", result: null },
  });
  expect(
    await db.factAssessment.findUniqueOrThrow({
      where: { id: fresh.assessment.assessmentId },
    }),
  ).toMatchObject({ result: { status: "REVALIDATION_REQUIRED" } });
  expect(
    await db.scalarReconciliationRequest.findUniqueOrThrow({
      where: { id: request.id },
    }),
  ).toEqual(request);
  expect(request.state).toBe("OPEN");
  expect(
    await db.factAssessment.findUniqueOrThrow({ where: { id: proof.id } }),
  ).toEqual(proof);
  expect(
    await db.scalarReconciliationRequest.count({
      where: { customerId, projectId: f.projectId },
    }),
  ).toBe(1);
});
it("FR-EVD-009: preserves legacy unassigned requests and append-only assignment CAS/retry", async () => {
  const f = await fixture(false),
    first = await reconciliation.check(f.pmo, f.input, context);
  expect(first.outcome).toBe("CREATED");
  expect(first.request?.assignment.reason).toBe("NO_CONFIGURED_PM");
  const input = {
    projectId: f.projectId,
    requestId: first.request!.id,
    expectedAssignmentRevision: 1,
    idempotencyKey: randomUUID(),
  };
  const refreshed = await reconciliation.refreshAssignment(
    f.pmo,
    input,
    context,
  );
  expect(refreshed.assignment.revision).toBe(2);
  expect(refreshed.assignment.reason).toBe("NO_CONFIGURED_PM");
  expect(await reconciliation.refreshAssignment(f.pmo, input, context)).toEqual(
    { ...refreshed, replayed: true },
  );
  await expect(
    reconciliation.refreshAssignment(
      f.pmo,
      { ...input, idempotencyKey: randomUUID() },
      context,
    ),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(
    await reconciliation.get(f.pm, {
      projectId: f.projectId,
      requestId: first.request!.id,
    }),
  ).toBeNull();
});
it("NFR-SEC-001 / FR-EVD-009: ordinary leadership capture creates no scalar check, request, assignment or owned proof", async () => {
  const f = await fixture();
  const proof = await authority.captureAssessment(
    f.leader,
    {
      projectId: f.projectId,
      factType: f.factType,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect(proof.result?.status).toBe("CONFLICTING");
  expect(proof.result?.resolvedValue).toBeNull();
  const where = { customerId, projectId: f.projectId };
  expect(await db.scalarReconciliationCheck.count({ where })).toBe(0);
  expect(await db.scalarReconciliationRequest.count({ where })).toBe(0);
  expect(await db.scalarReconciliationAssignment.count({ where })).toBe(0);
  expect(
    await db.factAssessment.count({
      where: { ...where, captureKind: "SCALAR_REQUEST" },
    }),
  ).toBe(0);
  expect(
    await db.factAssessment.findUnique({ where: { id: proof.assessmentId } }),
  ).toMatchObject({ captureKind: "SCALAR", scalarReconciliationCheckId: null });
});
it("NFR-SEC-001: leadership cannot request reconciliation; current source loss withholds old proof and replay", async () => {
  const f = await fixture(),
    first = await reconciliation.check(f.pmo, f.input, context);
  await expect(
    reconciliation.check(
      f.leader,
      { ...f.input, idempotencyKey: randomUUID() },
      context,
    ),
  ).rejects.toMatchObject({ code: "DENIED" });
  expect(
    await authority.getAssessment(f.leader, {
      projectId: f.projectId,
      assessmentId: first.assessment.assessmentId,
    }),
  ).toMatchObject({ visibility: "available" });
  const sourceId = f.versions[0]!.sourceId,
    access = await facts.getSourceAccess(f.pmo, {
      projectId: f.projectId,
      sourceId,
    });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: access!.revision,
      state: "AVAILABLE",
      readers: [f.leader.subject],
    },
    context,
  );
  expect(
    await reconciliation.get(f.pm, {
      projectId: f.projectId,
      requestId: first.request!.id,
    }),
  ).toMatchObject({ assessment: { visibility: "restricted", result: null } });
  expect(await reconciliation.check(f.pmo, f.input, context)).toMatchObject({
    checkId: first.checkId,
    replayed: true,
    outcome: "CREATED",
    assessment: { visibility: "restricted", result: null },
  });
  expect(
    await reconciliation.check(
      f.pmo,
      { ...f.input, idempotencyKey: randomUUID() },
      context,
    ),
  ).toMatchObject({ outcome: "NO_REQUEST", request: null });
});
it("NFR-REL-002: changed fact under the same key conflicts before capture", async () => {
  const f = await fixture();
  await reconciliation.check(f.pmo, f.input, context);
  await expect(
    reconciliation.check(f.pmo, { ...f.input, factId: randomUUID() }, context),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("NFR-REL-005: UTC audit linkage survives a non-UTC validation session", async () => {
  const f = await fixture(),
    checked = await reconciliation.check(f.pmo, f.input, context);
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kolkata'");
    return tx.$queryRaw<
      { request: boolean; check: boolean; assignment: boolean }[]
    >`
      SELECT public.valid_scalar_reconciliation_request(${checked.request!.id}::uuid) AS request,
        public.valid_scalar_reconciliation_check(${checked.checkId}::uuid) AS check,
        public.valid_scalar_reconciliation_assignment(${checked.request!.assignment.id}::uuid) AS assignment`;
  });
  expect(result).toEqual([{ request: true, check: true, assignment: true }]);
});

it("NFR-REL-005: a non-UTC session commits new checks and assignment refreshes", async () => {
  const f = await fixture();
  const zonedUrl = new URL(url);
  zonedUrl.searchParams.set("options", "-c timezone=Asia/Kolkata");
  const zoned = createDatabase(zonedUrl.toString());
  try {
    expect(await zoned.$queryRawUnsafe("SHOW TIME ZONE")).toEqual([
      { TimeZone: "Asia/Kolkata" },
    ]);
    const repository = new DatabaseScalarReconciliationRepository(zoned);
    const checked = await repository.check(f.pmo, f.input, context);
    expect(checked.outcome).toBe("CREATED");
    const refreshed = await repository.refreshAssignment(
      f.pmo,
      {
        projectId: f.projectId,
        requestId: checked.request!.id,
        expectedAssignmentRevision: 1,
        idempotencyKey: randomUUID(),
      },
      context,
    );
    expect(refreshed.assignment.revision).toBe(2);
    expect(
      await reconciliation.get(f.pm, {
        projectId: f.projectId,
        requestId: checked.request!.id,
      }),
    ).toMatchObject({ request: { assignment: refreshed.assignment } });
    expect(await zoned.$queryRawUnsafe("SHOW TIME ZONE")).toEqual([
      { TimeZone: "Asia/Kolkata" },
    ]);
  } finally {
    await zoned.$disconnect();
  }
});

it("NFR-REL-001: native COMMIT rejects orphan owned proof and rolls back conflicts and dependencies", async () => {
  const f = await fixture();
  const projection = async () => ({
    fact: await db.projectFact.findMany({ where: { projectId: f.projectId } }),
    assessments: await db.factAssessment.findMany({
      where: { projectId: f.projectId },
    }),
    versions: await db.factAssessmentVersion.findMany({
      where: { projectId: f.projectId },
    }),
    conflicts: await db.factAuthorityConflict.findMany({
      where: { projectId: f.projectId },
    }),
    dependencies: await db.factAssessmentConflict.findMany({
      where: { projectId: f.projectId },
    }),
    checks: await db.scalarReconciliationCheck.findMany({
      where: { projectId: f.projectId },
    }),
    requests: await db.scalarReconciliationRequest.findMany({
      where: { projectId: f.projectId },
    }),
    assignments: await db.scalarReconciliationAssignment.findMany({
      where: { projectId: f.projectId },
    }),
  });
  const before = await projection();
  const requireData = createRequire(
    new URL("../packages/data/package.json", import.meta.url),
  );
  const { Pool } = requireData("pg");
  const { PrismaPg } = requireData("@prisma/adapter-pg");
  const poolOptions = {
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 10000,
  };
  const writerPool = new Pool(poolOptions);
  const observerPool = new Pool(poolOptions);
  let observer: Awaited<ReturnType<typeof observerPool.connect>>;
  let writer: PrismaClient | undefined;
  const record = {
    nativeCommitAttempts: 0,
    callbackReturned: false,
    pid: 0,
    sessionUser: "",
    callbackReturnedAtCommit: false,
    native: undefined as
      | undefined
      | { code: string; message: string; constraint?: string },
    commitObserver: undefined as undefined | { phase: string },
  };
  watchCommits(
    writerPool,
    () => record,
    () => observer,
  );
  let reachedCommit = false;
  await runWithCleanup(
    async () => {
      observer = await observerPool.connect();
      writer = new PrismaClient({
        adapter: new PrismaPg(writerPool, { disposeExternalPool: false }),
      });
      await expect(
        writer.$transaction(async (tx) => {
          const principal = (
            await tx.$queryRaw<{ pid: number; sessionUser: string }[]>`
        SELECT pg_backend_pid() AS pid,session_user AS "sessionUser"`
          )[0]!;
          record.pid = principal.pid;
          record.sessionUser = principal.sessionUser;
          await tx.$queryRaw`SELECT id FROM public."Project" WHERE id=${f.projectId}::uuid FOR UPDATE`;
          const fact = (
            await tx.$queryRaw<
              { id: string; factType: string; revision: number }[]
            >`SELECT id,"factType",revision FROM public."ProjectFact" WHERE id=${f.input.factId}::uuid FOR UPDATE`
          )[0]!;
          const asOf = (
            await tx.$queryRaw<
              { now: Date }[]
            >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`
          )[0]!.now;
          const prepared = await authority.prepareAssessmentInTransaction(
            tx,
            f.pmo,
            { projectId: f.projectId, fact, asOf },
          );
          await authority.persistPreparedAssessmentInTransaction(tx, f.pmo, {
            prepared,
            subject: f.pmo.subject,
            idempotencyKey: randomUUID(),
            requestHash: "0".repeat(64),
            captureKind: "SCALAR_REQUEST",
            milestoneAssessmentId: null,
            scalarReconciliationCheckId: randomUUID(),
          });
          reachedCommit = true;
          record.callbackReturned = true;
        }),
      ).rejects.toThrow();
      expect(reachedCommit).toBe(true);
      // A Prisma timeout/connection error alone is never evidence of this guard.
      // The observer records the actual unchanged native COMMIT transport result.
      expect(record.nativeCommitAttempts).toBe(1);
      expect(record.callbackReturnedAtCommit).toBe(true);
      expect(record.commitObserver?.phase).toBe("native-commit-settled");
      expect([
        {
          code: "P0001",
          message: "Unowned scalar reconciliation assessment cannot commit",
          constraint: undefined,
        },
        {
          code: "23503",
          message:
            'insert or update on table "FactAssessment" violates foreign key constraint "ScalarAssessment_check_fk"',
          constraint: "ScalarAssessment_check_fk",
        },
      ]).toContainEqual(record.native);
      expect(await projection()).toEqual(before);
    },
    () =>
      drainAndClose(
        [],
        [
          () => writer?.$disconnect(),
          async () => {
            observer?.release();
            await observerPool.end();
          },
          () => writerPool.end(),
        ],
      ),
  );
});

it("NFR-REL-001: committed scalar history cannot be adopted, mutated, deleted or truncated", async () => {
  const f = await fixture(),
    result = await reconciliation.check(f.pmo, f.input, context);
  await expect(
    db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE public."FactAssessment"
        SET "scalarReconciliationCheckId"=${randomUUID()}::uuid
        WHERE id=${result.assessment.assessmentId}::uuid`;
      throw new Error("Assessment ownership mutation unexpectedly succeeded");
    }),
  ).rejects.toMatchObject({
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: {
          kind: "postgres",
          code: "P0001",
          originalCode: "P0001",
          message: "Invalid assessment seal",
          originalMessage: "Invalid assessment seal",
        },
      },
    },
  });
  for (const table of [
    "ScalarReconciliationRequest",
    "ScalarReconciliationCheck",
    "ScalarReconciliationAssignment",
  ]) {
    const before = await db.$queryRawUnsafe(
      'SELECT to_jsonb(t) AS row FROM public."' +
        table +
        '" t WHERE "projectId"=$1::uuid ORDER BY id',
      f.projectId,
    );
    for (const operation of ["UPDATE", "DELETE", "TRUNCATE"])
      await verifyImmutableHistoryMutation(db, table, operation);
    expect(
      await db.$queryRawUnsafe(
        'SELECT to_jsonb(t) AS row FROM public."' +
          table +
          '" t WHERE "projectId"=$1::uuid ORDER BY id',
        f.projectId,
      ),
    ).toEqual(before);
  }
});

it("NFR-REL-005: the year-range constraint rejects a coherently dated refresh and audit", async () => {
  const f = await fixture(false);
  const checked = await reconciliation.check(f.pmo, f.input, context);
  const request = checked.request!,
    previous = request.assignment;
  const id = randomUUID(),
    auditEventId = randomUUID();
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: f.projectId,
        requestId: request.id,
        expectedAssignmentRevision: 1,
      }),
    )
    .digest("hex");
  const overrides = JSON.stringify({
    id,
    auditEventId,
    kind: "REFRESH",
    revision: 2,
    expectedRevision: 1,
    previousAssignmentId: previous.id,
    idempotencyKey: randomUUID(),
    requestHash,
    occurredAt: "10000-01-01T00:00:00Z",
  });
  let auditInserted = false;
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public."Project" WHERE id=${f.projectId}::uuid FOR UPDATE`;
      await tx.$executeRaw`INSERT INTO public."AuditEvent" (id,"customerId",actor,"correlationId","occurredAt",event,detail)
      VALUES (${auditEventId}::uuid,${f.pmo.customerId}::uuid,${f.pmo.subject},${context.correlationId},
        TIMESTAMP '10000-01-01 00:00:00','scalar.reconciliation.assigned',
        jsonb_build_object('projectId',${f.projectId}::text,'factId',${f.input.factId}::text,
          'requestId',${request.id}::text,'assignmentId',${id}::text,'revision',2,'reason','NO_CONFIGURED_PM'))`;
      auditInserted = true;
      await tx.$executeRaw`INSERT INTO public."ScalarReconciliationAssignment"
      SELECT (jsonb_populate_record(NULL::public."ScalarReconciliationAssignment",to_jsonb(a) || ${overrides}::jsonb)).*
      FROM public."ScalarReconciliationAssignment" a WHERE id=${previous.id}::uuid`;
      throw new Error("Out-of-range refresh unexpectedly succeeded");
    }),
  ).rejects.toMatchObject({
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: "23514",
          originalMessage:
            'new row for relation "ScalarReconciliationAssignment" violates check constraint "ScalarAssignment_shape"',
        },
      },
    },
  });
  expect(auditInserted).toBe(true);
  expect(await db.auditEvent.count({ where: { id: auditEventId } })).toBe(0);
  expect(
    await db.scalarReconciliationAssignment.findMany({
      where: { requestId: request.id },
      select: { id: true },
    }),
  ).toEqual([{ id: previous.id }]);
});
