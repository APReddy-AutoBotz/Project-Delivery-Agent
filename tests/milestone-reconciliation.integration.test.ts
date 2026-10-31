import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import {
  createDatabase,
  DatabaseProjectRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseAuthorityRepository,
  DatabaseProjectFactRepository,
  DatabaseMilestoneReconciliationRepository,
  DatabaseMilestoneConflictObservationRepository,
  DatabaseMilestoneStateDisagreementRepository,
} from "../packages/data/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import type { Prisma } from "../packages/data/dist/generated/prisma/client.js";
import { loadConfig } from "../packages/platform/dist/index.js";
import { createApp } from "../apps/api/dist/app.js";
import { compileContract } from "../scripts/validate-openapi.mjs";
import { possibleMutation, rawSqlText } from "./fixtures/read-only-sql.js";
import { findMatchingMilestoneRequest } from "../packages/data/dist/milestone-request-proof.js";
import type {
  Actor,
  AuthorityDefinition,
  StateBindingCreate,
  CanonicalStateBindingView,
} from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname))
  throw new Error(
    "Reconciliation integration requires an isolated synthetic database",
  );
const db = createDatabase(url),
  customerId = process.env.CUSTOMER_ID!;
const canonical = new DatabaseCanonicalProjectRepository(db),
  authority = new DatabaseAuthorityRepository(db),
  facts = new DatabaseProjectFactRepository(db),
  reconciliation = new DatabaseMilestoneReconciliationRepository(db);
const context = { correlationId: "reconciliation-integration" };
const definition: AuthorityDefinition = {
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
  conflictBehavior: "REQUEST_RECONCILIATION",
};
const config = loadConfig(process.env);
let app: Awaited<ReturnType<typeof createApp>>["app"],
  spec: Awaited<ReturnType<typeof createApp>>["spec"],
  validate: ReturnType<typeof compileContract>,
  base: string;
beforeAll(async () => {
  ({ app, spec } = await createApp(
    config,
    new DatabaseProjectRepository(db),
    undefined,
    canonical,
    facts,
    authority,
    reconciliation,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    new DatabaseMilestoneConflictObservationRepository({ $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) } as never),
    undefined,
    new DatabaseMilestoneStateDisagreementRepository({ $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) } as never),
    new DatabaseMilestoneConflictObservationRepository({ $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) } as never),
  ));
  validate = compileContract(spec);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});
async function api(
  actor: Actor | null,
  path: string,
  method = "GET",
  body?: unknown,
  expires = "5m",
) {
  const credential = actor
    ? await new SignJWT({ roles: actor.roles })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(actor.subject)
        .setIssuer("pdaa:local")
        .setAudience("pdaa:api")
        .setIssuedAt()
        .setExpirationTime(expires)
        .sign(new TextEncoder().encode(config.SESSION_SECRET))
    : null;
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(credential ? { Authorization: "Bearer " + credential } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const pathname = path.split("?")[0]!;
  const route =
    Object.keys(spec.paths).find((template) => template === pathname) ??
    Object.keys(spec.paths).find((template) =>
      new RegExp("^" + template.replace(/\{[A-Za-z]+\}/g, "[^/]+") + "$").test(
        pathname,
      ),
    )!;
  const text = await response.text();
  const result = validate.response(
    method,
    route,
    response.status,
    response.headers.get("content-type"),
    text,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  return { status: response.status, body: result };
}

async function fixture(
  pmCount = 1,
  grantPm = true,
  bindingThroughHttp = false,
  lastWorkComplete = false,
  relativeTimes = false,
  allWorkComplete = false,
  emptyRequired = false,
  cancelOne = false,
  skipOneBinding = false,
  expiredEvidence = false,
  omitMilestonePolicy = false,
) {
  const portfolioId = randomUUID();
  const pm: Actor = {
    customerId,
    subject: "reconciliation-pm-" + randomUUID(),
    roles: ["project_manager"],
  };
  const pmo: Actor = {
    customerId,
    subject: "reconciliation-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Reconciliation tests" },
  });
  for (const actor of grantPm ? [pmo, pm] : [pmo])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: actor.roles[0]!,
      },
    });
  const input = canonicalFixture(portfolioId);
  input.responsibilities = Array.from({ length: pmCount }, (_, index) => ({
    role: "PROJECT_MANAGER",
    subject: index === 0 ? pm.subject : "other-pm-" + randomUUID(),
    displayName: "Configured PM",
  }));
  input.raidItems = [];
  input.sourceMappings = [];
  input.workItems = [1, 2, 3].map((index) => ({
    ...input.workItems[0],
    key: "WI-" + index,
  }));
  input.requiredWorkItems = emptyRequired ? [] : [1, 2, 3].map((index) => ({
    milestoneKey: "MS-1",
    workItemKey: "WI-" + index,
  }));
  const project = await canonical.createProject(
    pmo,
    input,
    context.correlationId,
  );
  const milestone = await db.milestone.findFirstOrThrow({
    where: { projectId: project.id },
    orderBy: { id: "asc" },
  });
  const links = await db.requiredWorkItem.findMany({
    where: { projectId: project.id, milestoneId: milestone.id },
    orderBy: { id: "asc" },
  });
  const targets = [
    {
      targetKind: "MILESTONE" as const,
      targetId: milestone.id,
      initialState: "COMPLETE" as const,
    },
    ...links.map((link, index) => ({
      targetKind: "WORK_ITEM" as const,
      targetId: link.workItemId,
      initialState:
        cancelOne && index === links.length - 1 ? ("CANCELLED" as const) :
        allWorkComplete || (lastWorkComplete && index === links.length - 1)
          ? ("COMPLETE" as const)
          : ("OPEN" as const),
    })),
  ];
  const bindings = [];
  const policies = [];
  const createBinding = async (
    input: StateBindingCreate,
  ): Promise<CanonicalStateBindingView> => {
    if (!bindingThroughHttp)
      return reconciliation.createStateBinding(pmo, input, context);
    const result = await api(
      pmo,
      `/api/projects/${project.id}/state-bindings`,
      "POST",
      input,
    );
    expect(result.status).toBe(201);
    return result.body;
  };
  const clock = relativeTimes ? await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now` : [];
  const effectiveAt = relativeTimes ? new Date(clock[0]!.now.getTime() - 60_000).toISOString() : "2026-09-01T00:00:00.000Z";
  const validUntil = relativeTimes ? new Date(clock[0]!.now.getTime() + 86_400_000).toISOString() : "2027-09-01T00:00:00.000Z";
  const expiredUntil = expiredEvidence ? new Date(clock[0]!.now.getTime() - 10_000).toISOString() : validUntil;
  for (const [index, target] of targets.entries()) {
    if (skipOneBinding && index === targets.length - 1) continue;
    const bound = await createBinding({
      projectId: project.id,
      ...target,
      idempotencyKey: randomUUID(),
      effectiveAt,
      validUntil: expiredEvidence && index === targets.length - 1 ? expiredUntil : validUntil,
      originalStatement: "Synthetic confirmed " + target.initialState,
    });
    const policy = omitMilestonePolicy && index === 0 ? null : await authority.appendPolicy(
      pmo,
      {
        projectId: project.id,
        factType: bound.factType,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        effectiveAt,
        definition,
      },
      context,
    );
    await facts.setSourceAccess(
      pmo,
      {
        projectId: project.id,
        sourceId: bound.entry.sourceId,
        expectedRevision: bound.entry.sourceAccessRevision,
        state: "AVAILABLE",
        readers: [pmo.subject, pm.subject],
      },
      context,
    );
    bindings.push(bound);
    if (policy) policies.push(policy.event);
  }
  const check = {
    projectId: project.id,
    milestoneId: milestone.id,
    ruleRevision: "milestone-required-state/v1" as const,
    enabled: true,
    idempotencyKey: randomUUID(),
  };
  return {
    projectId: project.id,
    portfolioId,
    milestone,
    pm,
    pmo,
    bindings,
    policies,
    check,
  };
}

async function reconciliationRows(projectId: string, includeAudit = true) {
  const rows: Record<string, unknown> = {};
  for (const table of [
    "MilestoneConsistencyAssessment",
    "MilestoneConsistencyTarget",
    "MilestoneConsistencyContributorVersion",
    "FactAssessment",
    "FactAssessmentVersion",
    "FactAssessmentConflict",
    "FactAuthorityConflict",
    "MilestoneReconciliationRequest",
    "MilestoneReconciliationCheck",
    "MilestoneReconciliationAssignment",
    ...(includeAudit ? ["AuditEvent"] : []),
  ]) {
    const predicate =
      table === "AuditEvent"
        ? `detail->>'projectId'=$1`
        : `"projectId"=$1::uuid`;
    rows[table] = await db.$queryRawUnsafe(
      `SELECT to_jsonb(t)::text AS row FROM "${table}" t WHERE ${predicate} ORDER BY to_jsonb(t)::text COLLATE "C"`,
      projectId,
    );
  }
  return rows;
}

async function stateDisagreementFixture(omitMilestonePolicy = false, expiredAlternate = false) {
  const f = await fixture(1, true, false, false, true, false, false, false, false, false, omitMilestonePolicy);
  const leader: Actor = { customerId, subject: "state-leader-" + randomUUID(), roles: ["leadership"] };
  const alternate: Actor = { customerId, subject: "state-alternate-" + randomUUID(), roles: ["project_manager"] };
  await db.accessGrant.createMany({ data: [leader, alternate].map((actor) => ({ customerId, subject: actor.subject,
    scopeType: "project", scopeId: f.projectId, role: actor.roles[0]! })) });
  const target = f.bindings[0]!;
  const initialAccess = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: target.entry.sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: target.entry.sourceId,
    expectedRevision: initialAccess!.revision, state: "AVAILABLE", readers: [f.pmo.subject, leader.subject] }, context);
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const alternateVersion = await facts.appendHumanStatement(alternate, { projectId: f.projectId, factType: target.factType,
    expectedRevision: 1, idempotencyKey: randomUUID(), value: { type: "text", value: "OPEN" },
    effectiveAt: new Date(now!.getTime() - 10_000).toISOString(),
    validUntil: new Date(now!.getTime() + (expiredAlternate ? -1000 : 86_400_000)).toISOString(),
    originalStatement: "Synthetic alternative milestone state." }, context);
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId,
    expectedRevision: alternateVersion.entry.sourceAccessRevision, state: "AVAILABLE",
    readers: [alternate.subject, f.pmo.subject, leader.subject] }, context);
  const readerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
  const reader = new DatabaseMilestoneStateDisagreementRepository(readerDb as never);
  return { f, leader, alternate, target, alternateVersion, reader };
}

async function unrankedReadSnapshot(f: Awaited<ReturnType<typeof stateDisagreementFixture>>["f"], leader: Actor) {
  return {
    facts: await db.projectFact.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    versions: await db.projectFactVersion.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    evidence: await db.factEvidence.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    appendReceipts: await db.factAppendReceipt.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    sources: await db.factSource.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    access: await db.factSourceAccess.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { sourceId: "asc" } }),
    readers: await db.factSourceReader.findMany({ where: { customerId, projectId: f.projectId }, orderBy: [{ sourceId: "asc" }, { subject: "asc" }] }),
    policies: await db.authorityPolicy.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    policyRevisions: await db.authorityPolicyRevision.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    policyReceipts: await db.authorityPolicyReceipt.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    bindings: await db.canonicalStateBinding.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    grants: await db.accessGrant.findMany({ where: { customerId, OR: [{ scopeType: "project", scopeId: f.projectId },
      { scopeType: "portfolio", scopeId: f.portfolioId }] }, orderBy: { id: "asc" } }),
    leaderAudit: await db.auditEvent.findMany({ where: { customerId, actor: leader.subject }, orderBy: { id: "asc" } }),
    ...await reconciliationRows(f.projectId),
  };
}

it("observes unranked human milestone reports only while policy is absent and every source remains readable", async () => {
  const { f, leader, alternate, target, alternateVersion, reader } = await stateDisagreementFixture(true);
  const snapshot = () => unrankedReadSnapshot(f, leader);
  const before = await snapshot();
  const observed = await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id);
  expect(observed).toMatchObject({ kind: "UNRANKED_NO_POLICY", projectId: f.projectId, milestoneId: f.milestone.id,
    bindingId: target.id, factId: target.factId, factType: target.factType });
  expect(observed.positions.map((position) => ({ state: position.state, supports: position.supports.map((item) =>
    ({ versionId: item.versionId, evidenceId: item.evidenceId, sourceId: item.sourceId })) }))).toEqual([
    { state: "COMPLETE", supports: [{ versionId: target.entry.id, evidenceId: target.entry.evidenceId, sourceId: target.entry.sourceId }] },
    { state: "OPEN", supports: [{ versionId: alternateVersion.entry.id, evidenceId: alternateVersion.entry.evidenceId, sourceId: alternateVersion.entry.sourceId }] },
  ]);
  await expect(reader.readUnrankedLeadership(f.pm, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "DENIED" });
  const noGrant: Actor = { customerId, subject: "unranked-no-grant-" + randomUUID(), roles: ["leadership"] };
  await expect(reader.readUnrankedLeadership(noGrant, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readUnrankedLeadership(leader, randomUUID(), f.milestone.id)).rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readUnrankedLeadership(leader, f.projectId, randomUUID())).rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readUnrankedLeadership({ ...leader, customerId: randomUUID() }, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "DENIED" });
  expect(await snapshot()).toEqual(before);

  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId });
  const revoked = await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId,
    expectedRevision: access!.revision, state: "AVAILABLE", readers: [alternate.subject, f.pmo.subject] }, context);
  const afterRevocation = await snapshot();
  await expect(reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await snapshot()).toEqual(afterRevocation);
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId,
    expectedRevision: revoked.revision, state: "AVAILABLE", readers: [alternate.subject, f.pmo.subject, leader.subject] }, context);
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const policy = await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: target.factType, expectedRevision: 0,
    idempotencyKey: randomUUID(), effectiveAt: new Date(now!.getTime() - 1000).toISOString(), definition }, context);
  const afterPolicy = await snapshot();
  await expect(reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  const ranked = await reader.readLeadership(leader, f.projectId, f.milestone.id);
  expect(ranked.policyRevisionId).toBe(policy.event.id);
  expect(ranked.positions.map((position) => position.state)).toEqual(["COMPLETE", "OPEN"]);
  expect(ranked.positions.map((position) => position.supports.map((support) => support.versionId))).toEqual([[target.entry.id], [alternateVersion.entry.id]]);
  expect(await snapshot()).toEqual(afterPolicy);
}, 60000);

it("withholds an unranked milestone when an applicable source has expired", async () => {
  const { f, leader, reader } = await stateDisagreementFixture(true, true);
  const before = await unrankedReadSnapshot(f, leader);
  await expect(reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await unrankedReadSnapshot(f, leader)).toEqual(before);
}, 60000);

it.each(["same-state", "missing-validity"] as const)("withholds unranked reports for %s human heads", async (kind) => {
  const { f, leader, alternate, target, alternateVersion, reader } = await stateDisagreementFixture(true);
  expect((await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).kind).toBe("UNRANKED_NO_POLICY");
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const value = kind === "same-state" ? "COMPLETE" : "OPEN";
  const validUntil = kind === "missing-validity" ? null : new Date(now!.getTime() + 86_400_000).toISOString();
  const appended = await facts.appendHumanStatement(alternate, { projectId: f.projectId, factType: target.factType,
    expectedRevision: 2, idempotencyKey: randomUUID(), value: { type: "text", value },
    effectiveAt: now!.toISOString(), validUntil,
    originalStatement: "Synthetic updated report." }, context);
  expect(appended.entry).toMatchObject({ revision: 3, sourceId: alternateVersion.entry.sourceId,
    visibility: "available", content: { value: { type: "text", value }, validUntil } });
  expect(await db.authorityPolicy.count({ where: { customerId, projectId: f.projectId, factType: target.factType } })).toBe(0);
  const before = await unrankedReadSnapshot(f, leader);
  await expect(reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await unrankedReadSnapshot(f, leader)).toEqual(before);
}, 60000);

it.each(["disabled", "future"] as const)("withholds unranked reports when the policy revision is %s", async (kind) => {
  const { f, leader, target, reader } = await stateDisagreementFixture(true);
  expect((await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).kind).toBe("UNRANKED_NO_POLICY");
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const policy = await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: target.factType, expectedRevision: 0,
    idempotencyKey: randomUUID(), effectiveAt: new Date(now!.getTime() + (kind === "future" ? 86_400_000 : -1000)).toISOString(),
    definition: kind === "disabled" ? null : definition }, context);
  expect(policy.event.state).toBe(kind === "disabled" ? "DISABLED" : "ENABLED");
  const before = await unrankedReadSnapshot(f, leader);
  await expect(reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await unrankedReadSnapshot(f, leader)).toEqual(before);
}, 60000);

it.each(["reader", "writer"] as const)("serializes unranked milestone reads with first policy creation when %s starts first", async (firstKind) => {
  const { f, leader, target, alternateVersion, reader } = await stateDisagreementFixture(true);
  const baseline = await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id);
  expect(baseline.positions).toMatchObject([
    { state: "COMPLETE", supports: [{ versionId: target.entry.id, evidenceId: target.entry.evidenceId, sourceId: target.entry.sourceId }] },
    { state: "OPEN", supports: [{ versionId: alternateVersion.entry.id, evidenceId: alternateVersion.entry.evidenceId, sourceId: alternateVersion.entry.sourceId }] },
  ]);
  expect(await db.authorityPolicy.count({ where: { customerId, projectId: f.projectId, factType: target.factType } })).toBe(0);
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const wrapped = (role: "reader" | "writer", hold: boolean) => ({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(targetTx, key) {
        const value = Reflect.get(targetTx, key);
        if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
          const lock = role === "reader" ? sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")
            : sql.includes('FROM "Project"') && sql.includes("FOR UPDATE");
          if (!paused && lock) { paused = true; heldReady(); await gate; }
          return result;
        };
        return typeof value === "function" ? value.bind(targetTx) : value;
      } }));
    }, options as never),
  });
  const read = (database: unknown) => new DatabaseMilestoneStateDisagreementRepository(database as never)
    .readUnrankedLeadership(leader, f.projectId, f.milestone.id);
  const createPolicy = (database: unknown) => new DatabaseAuthorityRepository(database as never).appendPolicy(f.pmo, {
    projectId: f.projectId, factType: target.factType, expectedRevision: 0, idempotencyKey: randomUUID(),
    effectiveAt: new Date(now!.getTime() - 1000).toISOString(), definition,
  }, context);
  const first = firstKind === "reader" ? read(wrapped("reader", true)) : createPolicy(wrapped("writer", true));
  void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? createPolicy(wrapped("writer", false)) : read(wrapped("reader", false));
    void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const fragments = firstKind === "reader" ? ['FROM "Project"', "FOR UPDATE"] : ['FROM public."Project"', "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
  expect(sawBlock).toBe(true);
  let created: Awaited<ReturnType<DatabaseAuthorityRepository["appendPolicy"]>>;
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ kind: "UNRANKED_NO_POLICY", milestoneId: f.milestone.id, positions: baseline.positions });
    created = await second as typeof created;
  } else {
    created = await first as typeof created;
    await expect(second).rejects.toMatchObject({ code: "UNAVAILABLE" });
  }
  const policies = await db.authorityPolicy.findMany({ where: { customerId, projectId: f.projectId, factType: target.factType }, include: { events: true } });
  expect(policies).toHaveLength(1);
  expect(policies[0]).toMatchObject({ revision: 1, events: [{ id: created.event.id, revision: 1, state: "ENABLED" }] });
  const afterPolicy = await unrankedReadSnapshot(f, leader);
  await expect(reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await unrankedReadSnapshot(f, leader)).toEqual(afterPolicy);
}, 90000);

it.each(["reader", "writer"] as const)("serializes unranked milestone reads with fact append when %s starts first", async (firstKind) => {
  const { f, leader, alternate, target, alternateVersion, reader } = await stateDisagreementFixture(true);
  const baseline = await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id);
  expect(baseline.positions).toMatchObject([
    { state: "COMPLETE", supports: [{ versionId: target.entry.id, evidenceId: target.entry.evidenceId, sourceId: target.entry.sourceId }] },
    { state: "OPEN", supports: [{ versionId: alternateVersion.entry.id, evidenceId: alternateVersion.entry.evidenceId, sourceId: alternateVersion.entry.sourceId }] },
  ]);
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const wrapped = (role: "reader" | "writer", hold: boolean) => ({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(targetTx, key) {
        const value = Reflect.get(targetTx, key);
        if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
          const lock = role === "reader" ? sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")
            : sql.includes('FROM "Project"') && sql.includes("FOR UPDATE");
          if (!paused && lock) { paused = true; heldReady(); await gate; }
          return result;
        };
        return typeof value === "function" ? value.bind(targetTx) : value;
      } }));
    }, options as never),
  });
  const read = (database: unknown) => new DatabaseMilestoneStateDisagreementRepository(database as never)
    .readUnrankedLeadership(leader, f.projectId, f.milestone.id);
  const append = (database: unknown) => new DatabaseProjectFactRepository(database as never).appendHumanStatement(alternate, {
    projectId: f.projectId, factType: target.factType, expectedRevision: 2, idempotencyKey: randomUUID(),
    value: { type: "text", value: "OPEN" }, effectiveAt: now!.toISOString(),
    validUntil: new Date(now!.getTime() + 86_400_000).toISOString(), originalStatement: "Synthetic updated milestone report.",
  }, context);
  const first = firstKind === "reader" ? read(wrapped("reader", true)) : append(wrapped("writer", true));
  void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? append(wrapped("writer", false)) : read(wrapped("reader", false));
    void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const fragments = firstKind === "reader" ? ['FROM "Project"', "FOR UPDATE"] : ['FROM public."Project"', "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
  expect(sawBlock).toBe(true);
  let appended: Awaited<ReturnType<DatabaseProjectFactRepository["appendHumanStatement"]>>;
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ kind: "UNRANKED_NO_POLICY", milestoneId: f.milestone.id, positions: baseline.positions });
    appended = await second as typeof appended;
  } else {
    appended = await first as typeof appended;
  }
  const expectedPositions = [
    { state: "COMPLETE", supports: [{ versionId: target.entry.id, evidenceId: target.entry.evidenceId, sourceId: target.entry.sourceId }] },
    { state: "OPEN", supports: [{ versionId: appended.entry.id, evidenceId: appended.entry.evidenceId, sourceId: alternateVersion.entry.sourceId }] },
  ];
  expect(appended.entry.sourceId).toBe(alternateVersion.entry.sourceId);
  expect(appended.entry.revision).toBe(3);
  if (firstKind === "writer") expect(await second).toMatchObject({ kind: "UNRANKED_NO_POLICY", positions: expectedPositions });
  const afterAppend = await unrankedReadSnapshot(f, leader);
  expect((await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)).positions).toMatchObject(expectedPositions);
  expect(await unrankedReadSnapshot(f, leader)).toEqual(afterAppend);
}, 90000);

it("withholds milestone alternatives without a policy and exposes the tie only after policy creation", async () => {
  const { f, leader, target, reader } = await stateDisagreementFixture(true);
  expect(await db.authorityPolicy.count({ where: { customerId, projectId: f.projectId, factType: target.factType } })).toBe(0);
  const before = await reconciliationRows(f.projectId);
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect((await api(leader, `/api/projects/${f.projectId}/milestones/${f.milestone.id}/leadership-state-disagreement`)).status).toBe(503);
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const created = await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: target.factType, expectedRevision: 0,
    idempotencyKey: randomUUID(), effectiveAt: new Date(now!.getTime() - 1000).toISOString(), definition }, context);
  const result = await reader.readLeadership(leader, f.projectId, f.milestone.id);
  expect(result.policyRevisionId).toBe(created.event.id);
  expect(result.positions.map((position) => position.state)).toEqual(["COMPLETE", "OPEN"]);
}, 60000);

it("withholds an expired milestone alternative until that source provides a current revision", async () => {
  const { f, leader, alternate, target, alternateVersion, reader } = await stateDisagreementFixture(false, true);
  const path = `/api/projects/${f.projectId}/milestones/${f.milestone.id}/leadership-state-disagreement`;
  const before = await reconciliationRows(f.projectId);
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect((await api(leader, path)).status).toBe(503);
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const current = await facts.appendHumanStatement(alternate, { projectId: f.projectId, factType: target.factType,
    expectedRevision: 2, idempotencyKey: randomUUID(), value: { type: "text", value: "OPEN" },
    effectiveAt: new Date(now!.getTime() - 1000).toISOString(), validUntil: new Date(now!.getTime() + 86_400_000).toISOString(),
    originalStatement: "Synthetic current alternative milestone state." }, context);
  const result = await reader.readLeadership(leader, f.projectId, f.milestone.id);
  expect(current.entry.sourceId).toBe(alternateVersion.entry.sourceId);
  expect(result.positions.map((position) => position.state)).toEqual(["COMPLETE", "OPEN"]);
  expect(result.positions.find((position) => position.state === "OPEN")?.supports.map((support) =>
    ({ versionId: support.versionId, evidenceId: support.evidenceId, sourceId: support.sourceId }))).toEqual([
    { versionId: current.entry.id, evidenceId: current.entry.evidenceId, sourceId: alternateVersion.entry.sourceId },
  ]);
}, 60000);

it("observes all current human milestone-state alternatives without writing", async () => {
  const { f, leader, alternate, target, alternateVersion, reader } = await stateDisagreementFixture();
  const snapshot = async () => ({
    facts: await db.projectFact.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    versions: await db.projectFactVersion.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    evidence: await db.factEvidence.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    sources: await db.factSource.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    appendReceipts: await db.factAppendReceipt.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    sourceAccess: await db.factSourceAccess.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { sourceId: "asc" } }),
    sourceReaders: await db.factSourceReader.findMany({ where: { customerId, projectId: f.projectId }, orderBy: [{ sourceId: "asc" }, { subject: "asc" }] }),
    policies: await db.authorityPolicy.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    policyRevisions: await db.authorityPolicyRevision.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    policyReceipts: await db.authorityPolicyReceipt.findMany({ where: { customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    grants: await db.accessGrant.findMany({ where: { customerId, OR: [{ scopeType: "project", scopeId: f.projectId },
      { scopeType: "portfolio", scopeId: f.portfolioId }] }, orderBy: { id: "asc" } }),
    leaderAudit: await db.auditEvent.findMany({ where: { customerId, actor: leader.subject }, orderBy: { id: "asc" } }),
    ...await reconciliationRows(f.projectId),
  });
  const before = await snapshot();
  const observed = await reader.readLeadership(leader, f.projectId, f.milestone.id);
  expect(observed).toMatchObject({ projectId: f.projectId, milestoneId: f.milestone.id, bindingId: target.id,
    factId: target.factId, factType: target.factType, policyRevisionId: f.policies[0]!.id });
  expect(observed.positions.map((position) => ({ state: position.state, supports: position.supports.map((item) =>
    ({ versionId: item.versionId, evidenceId: item.evidenceId, sourceId: item.sourceId })) }))).toEqual([
    { state: "COMPLETE", supports: [{ versionId: target.entry.id, evidenceId: target.entry.evidenceId, sourceId: target.entry.sourceId }] },
    { state: "OPEN", supports: [{ versionId: alternateVersion.entry.id, evidenceId: alternateVersion.entry.evidenceId, sourceId: alternateVersion.entry.sourceId }] },
  ]);
  const path = `/api/projects/${f.projectId}/milestones/${f.milestone.id}/leadership-state-disagreement`;
  const http = await api(leader, path);
  expect(http.status).toBe(200);
  expect(http.body).toMatchObject({ projectId: f.projectId, milestoneId: f.milestone.id, positions: observed.positions });
  expect((await api(null, path)).status).toBe(401);
  expect((await api(f.pm, path)).status).toBe(404);
  const noGrant: Actor = { customerId, subject: "state-no-grant-" + randomUUID(), roles: ["leadership"] };
  expect((await api(noGrant, path)).status).toBe(404);
  expect((await api(leader, path.replace(f.projectId, randomUUID()))).status).toBe(404);
  const otherCustomer = randomUUID(), otherPortfolio = randomUUID(), otherProject = randomUUID();
  await db.customer.create({ data: { id: otherCustomer, name: "Synthetic other tenant" } });
  await db.portfolio.create({ data: { id: otherPortfolio, customerId: otherCustomer, name: "Synthetic other tenant" } });
  await db.project.create({ data: { id: otherProject, customerId: otherCustomer, portfolioId: otherPortfolio,
    code: "OTHER-" + otherProject, name: "Synthetic other tenant", description: "Scoped denial fixture", reportedStatus: "UNKNOWN" } });
  expect((await api(leader, path.replace(f.projectId, otherProject))).status).toBe(404);
  expect(await snapshot()).toEqual(before);
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId,
    expectedRevision: access!.revision, state: "AVAILABLE", readers: [alternate.subject, f.pmo.subject] }, context);
  const afterRevocation = await snapshot();
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect((await api(leader, path)).status).toBe(503);
  expect(await snapshot()).toEqual(afterRevocation);
  const revokedAccess = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId,
    expectedRevision: revokedAccess!.revision, state: "AVAILABLE", readers: [alternate.subject, f.pmo.subject, leader.subject] }, context);
  expect((await reader.readLeadership(leader, f.projectId, f.milestone.id)).positions).toEqual(observed.positions);
  const [{ now: disabledAt }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: target.factType, expectedRevision: 1,
    idempotencyKey: randomUUID(), effectiveAt: new Date(disabledAt!.getTime() - 1000).toISOString(), definition: null }, context);
  const afterDisable = await snapshot();
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect((await api(leader, path)).status).toBe(503);
  expect(await snapshot()).toEqual(afterDisable);
}, 60000);

it.each([["equal-tier", "reader"], ["equal-tier", "writer"], ["unranked", "reader"], ["unranked", "writer"]] as const)(
  "serializes %s milestone-state read and reader removal when %s starts first", async (mode, firstKind) => {
  const { f, leader, alternate, target, alternateVersion, reader } = await stateDisagreementFixture(mode === "unranked");
  const baseline = mode === "unranked" ? await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)
    : await reader.readLeadership(leader, f.projectId, f.milestone.id);
  expect(baseline.positions).toMatchObject([
    { state: "COMPLETE", supports: [{ versionId: target.entry.id, evidenceId: target.entry.evidenceId, sourceId: target.entry.sourceId }] },
    { state: "OPEN", supports: [{ versionId: alternateVersion.entry.id, evidenceId: alternateVersion.entry.evidenceId, sourceId: alternateVersion.entry.sourceId }] },
  ]);
  const sourceId = alternateVersion.entry.sourceId;
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const heldGate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const wrapped = (kind: "reader" | "writer", hold: boolean) => ({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          const projectLock = kind === "reader" ? sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")
            : sql.includes('FROM "Project"') && sql.includes("FOR UPDATE");
          if (!paused && projectLock) { paused = true; heldReady(); await heldGate; }
          return result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never),
  });
  const read = (database: unknown) => {
    const repository = new DatabaseMilestoneStateDisagreementRepository(database as never);
    return mode === "unranked" ? repository.readUnrankedLeadership(leader, f.projectId, f.milestone.id)
      : repository.readLeadership(leader, f.projectId, f.milestone.id);
  };
  const removeReader = (database: unknown) => new DatabaseProjectFactRepository(database as never).setSourceAccess(f.pmo, {
    projectId: f.projectId, sourceId, expectedRevision: access!.revision, state: "AVAILABLE",
    readers: [alternate.subject, f.pmo.subject],
  }, context);
  const first = firstKind === "reader" ? read(wrapped("reader", true)) : removeReader(wrapped("writer", true));
  void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? removeReader(wrapped("writer", false)) : read(wrapped("reader", false));
    void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const expectedSql = firstKind === "reader" ? ['FROM "Project"', "FOR UPDATE"] : ['FROM public."Project"', "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          expectedSql.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    release();
    await Promise.allSettled(second ? [first, second] : [first]);
  }
  expect(sawBlock).toBe(true);
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ milestoneId: f.milestone.id, positions: baseline.positions });
    await second;
  } else {
    await first;
    await expect(second).rejects.toMatchObject({ code: "UNAVAILABLE" });
  }
  expect(await db.factSourceReader.count({ where: { customerId, projectId: f.projectId, sourceId, subject: leader.subject } })).toBe(0);
  await expect(read(wrapped("reader", false))).rejects.toMatchObject({ code: "UNAVAILABLE" });
}, 90000);

it.each([["equal-tier", "reader"], ["equal-tier", "writer"], ["unranked", "reader"], ["unranked", "writer"]] as const)(
  "serializes %s milestone-state reads with leadership grant revocation when %s starts first", async (mode, firstKind) => {
  const { f, leader, reader } = await stateDisagreementFixture(mode === "unranked");
  const baseline = mode === "unranked" ? await reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)
    : await reader.readLeadership(leader, f.projectId, f.milestone.id);
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const wrapped = (role: "reader" | "writer", hold: boolean) => ({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(targetTx, key) {
        const value = Reflect.get(targetTx, key);
        if (hold && role === "reader" && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
          if (!paused && sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) {
            paused = true; heldReady(); await gate;
          }
          return result;
        };
        if (hold && role === "writer" && key === "accessGrant" && value && typeof value === "object") {
          return new Proxy(value, { get(model, method) {
            const fn = Reflect.get(model, method);
            if (method === "deleteMany" && typeof fn === "function") return async (...args: unknown[]) => {
              const result = await Reflect.apply(fn, model, args); heldReady(); await gate; return result;
            };
            return typeof fn === "function" ? fn.bind(model) : fn;
          } });
        }
        return typeof value === "function" ? value.bind(targetTx) : value;
      } }));
    }, options as never),
  });
  const read = (hold: boolean) => {
    const repository = new DatabaseMilestoneStateDisagreementRepository(wrapped("reader", hold) as never);
    return mode === "unranked" ? repository.readUnrankedLeadership(leader, f.projectId, f.milestone.id)
      : repository.readLeadership(leader, f.projectId, f.milestone.id);
  };
  const revoke = (hold: boolean) => new DatabaseProjectRepository(wrapped("writer", hold) as never).revokeGrant(f.pmo,
    { subject: leader.subject, scopeType: "project", scopeId: f.projectId }, context.correlationId);
  const first = firstKind === "reader" ? read(true) : revoke(true); void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? revoke(false) : read(false); void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const fragments = firstKind === "reader" ? ['DELETE', '"AccessGrant"'] : ['FROM public."AccessGrant"', "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
  expect(sawBlock).toBe(true);
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ milestoneId: f.milestone.id, positions: baseline.positions });
    await second;
  } else {
    await first;
    await expect(second).rejects.toMatchObject({ code: "DENIED" });
  }
  expect(await db.accessGrant.count({ where: { customerId, subject: leader.subject, scopeType: "project", scopeId: f.projectId } })).toBe(0);
  await expect(mode === "unranked" ? reader.readUnrankedLeadership(leader, f.projectId, f.milestone.id)
    : reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "DENIED" });
}, 90000);

it.each(["reader", "writer"] as const)("serializes milestone-state reads with direct source-reader deletion when %s starts first", async (firstKind) => {
  const { f, leader, alternateVersion, reader } = await stateDisagreementFixture();
  const baseline = await reader.readLeadership(leader, f.projectId, f.milestone.id);
  const sourceId = alternateVersion.entry.sourceId;
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const read = (hold: boolean) => new DatabaseMilestoneStateDisagreementRepository({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(targetTx, key) {
        const value = Reflect.get(targetTx, key);
        if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
          if (!paused && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) {
            paused = true; heldReady(); await gate;
          }
          return result;
        };
        return typeof value === "function" ? value.bind(targetTx) : value;
      } }));
    }, options as never),
  } as never).readLeadership(leader, f.projectId, f.milestone.id);
  const remove = (hold: boolean) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
    const count = await tx.$executeRaw`DELETE FROM public."FactSourceReader" WHERE "customerId"=${customerId}::uuid
      AND "projectId"=${f.projectId}::uuid AND "sourceId"=${sourceId}::uuid AND subject=${leader.subject}`;
    if (hold) { heldReady(); await gate; }
    return count;
  }, { timeout: 20000 });
  const first = firstKind === "reader" ? read(true) : remove(true); void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? remove(false) : read(false); void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const fragments = firstKind === "reader" ? ['DELETE FROM public."FactSourceReader"'] : ['FROM public."Project"', "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
  expect(sawBlock).toBe(true);
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ milestoneId: f.milestone.id, positions: baseline.positions });
    expect(await second).toBe(1);
  } else {
    expect(await first).toBe(1);
    await expect(second).rejects.toMatchObject({ code: "UNAVAILABLE" });
  }
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
}, 90000);

it.each(["fact", "policy"] as const)("serializes milestone-state reads with %s changes in both orders", async (kind) => {
  for (const firstKind of ["reader", "writer"] as const) {
    const { f, leader, alternate, target, reader } = await stateDisagreementFixture();
    const baseline = await reader.readLeadership(leader, f.projectId, f.milestone.id);
    let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
    const waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
    let heldPid = 0, waitingPid = 0, paused = false;
    const wrapped = (role: "reader" | "writer", hold: boolean) => ({
      $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
        return operation(new Proxy(tx, { get(targetTx, key) {
          const value = Reflect.get(targetTx, key);
          if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
            const result = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
            const lock = role === "reader" ? sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")
              : sql.includes('FROM "Project"') && sql.includes("FOR UPDATE");
            if (!paused && lock) { paused = true; heldReady(); await gate; }
            return result;
          };
          return typeof value === "function" ? value.bind(targetTx) : value;
        } }));
      }, options as never),
    });
    const read = (database: unknown) => new DatabaseMilestoneStateDisagreementRepository(database as never)
      .readLeadership(leader, f.projectId, f.milestone.id);
    const change = async (database: unknown) => {
      const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
      const effectiveAt = new Date(now!.getTime() - 1000).toISOString();
      if (kind === "policy") return new DatabaseAuthorityRepository(database as never).appendPolicy(f.pmo, {
        projectId: f.projectId, factType: target.factType, expectedRevision: 1, idempotencyKey: randomUUID(),
        effectiveAt, definition: null,
      }, context);
      return new DatabaseProjectFactRepository(database as never).appendHumanStatement(alternate, {
        projectId: f.projectId, factType: target.factType, expectedRevision: 2, idempotencyKey: randomUUID(),
        value: { type: "text", value: "COMPLETE" }, effectiveAt,
        validUntil: new Date(now!.getTime() + 86_400_000).toISOString(), originalStatement: "Synthetic revised milestone state.",
      }, context);
    };
    const first = firstKind === "reader" ? read(wrapped("reader", true)) : change(wrapped("writer", true));
    void first.catch(() => {});
    let second: Promise<unknown> | undefined, sawBlock = false;
    try {
      await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
      second = firstKind === "reader" ? change(wrapped("writer", false)) : read(wrapped("reader", false));
      void second.catch(() => {});
      await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
          "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
        const fragments = firstKind === "reader" ? ['FROM "Project"', "FOR UPDATE"] : ['FROM public."Project"', "FOR SHARE"];
        if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
            fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
    expect(sawBlock).toBe(true);
    if (firstKind === "reader") {
      expect(await first).toMatchObject({ milestoneId: f.milestone.id, positions: baseline.positions });
      await second;
    } else {
      await first;
      await expect(second).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  }
}, 120000);

it("NFR-REL-002: a test-only occupied-hash lookup with unequal identity rolls back every proof family", async () => {
  const f = await fixture();
  const existing = await reconciliation.check(f.pmo, f.check, context);
  const before = await reconciliationRows(f.projectId);
  let lookupCount = 0;
  // Read shim only: this is NOT a generated SHA-256 collision or SQL guard
  // bypass. The real capture/transaction/COMMIT options remain unchanged.
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
                  get(transaction, delegateName) {
                    if (delegateName === "milestoneReconciliationRequest")
                      return new Proxy(
                        transaction.milestoneReconciliationRequest,
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
                                    .customerId_projectId_milestoneId_ruleRevision_contributorHash,
                                ).toMatchObject({
                                  customerId,
                                  projectId: f.projectId,
                                  milestoneId: f.milestone.id,
                                });
                                lookupCount += 1;
                                return {
                                  id: existing.request!.id,
                                  sealed: true,
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
                    const value = Reflect.get(transaction, delegateName);
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
    new DatabaseMilestoneReconciliationRepository(observed).check(
      f.pmo,
      { ...f.check, idempotencyKey: randomUUID() },
      context,
    ),
  ).rejects.toThrow("Reconciliation check unavailable");
  expect(lookupCount).toBe(1);
  expect(await reconciliationRows(f.projectId)).toEqual(before);
});

it("FR-EVD-012: changed conflicting contributors create a new OPEN case and retain the original proof", async () => {
  const f = await fixture(),
    first = await reconciliation.check(f.pmo, f.check, context),
    read = { projectId: f.projectId, requestId: first.request!.id },
    original = await reconciliation.get(f.pm, read),
    binding = f.bindings[1]!;
  const appended = await facts.appendHumanStatement(
    f.pmo,
    {
      projectId: f.projectId,
      factType: binding.factType,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      value: { type: "text", value: "OPEN" },
      effectiveAt: "2026-09-02T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      originalStatement:
        "Synthetic newer confirmation of the same OPEN position",
    },
    context,
  );
  const access = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId: appended.entry.sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId: appended.entry.sourceId,
      expectedRevision: access!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject, f.pm.subject],
    },
    context,
  );
  const second = await reconciliation.check(
    f.pmo,
    {
      ...f.check,
      idempotencyKey: randomUUID(),
    },
    context,
  );
  expect(second.outcome).toBe("CREATED");
  expect(second.request!.id).not.toBe(first.request!.id);
  expect(second.assessment.assessmentId).not.toBe(
    first.assessment.assessmentId,
  );
  expect(
    await reconciliation.check(
      f.pmo,
      {
        ...f.check,
        idempotencyKey: randomUUID(),
      },
      context,
    ),
  ).toMatchObject({ outcome: "REUSED", request: { id: second.request!.id } });
  expect(await reconciliation.get(f.pm, read)).toEqual(original);
  expect(
    await db.milestoneReconciliationRequest.count({
      where: { projectId: f.projectId, state: "OPEN" },
    }),
  ).toBe(2);
});

it("FR-EVD-009: a noncontributing required-work source withholds the whole original PM and creator proof", async () => {
  const f = await fixture(1, true, false, true),
    checked = await reconciliation.check(f.pmo, f.check, context),
    read = { projectId: f.projectId, requestId: checked.request!.id },
    original = await reconciliation.get(f.pm, read),
    binding = f.bindings[3]!;
  if (
    original?.assessment.visibility !== "available" ||
    original.assessment.result.status !== "CONFLICTING"
  )
    throw new Error("Expected complete original conflicting proof");
  const result = original.assessment.result;
  expect(result.evaluations).toHaveLength(4);
  expect(result.contributors).toHaveLength(3);
  expect(result.contributors.some((row) => row.bindingId === binding.id)).toBe(
    false,
  );
  expect(result.dependencies.some((row) => row.bindingId === binding.id)).toBe(
    true,
  );
  const setReaders = async (readers: string[]) => {
    const current = await facts.getSourceAccess(f.pmo, {
      projectId: f.projectId,
      sourceId: binding.entry.sourceId,
    });
    await facts.setSourceAccess(
      f.pmo,
      {
        projectId: f.projectId,
        sourceId: binding.entry.sourceId,
        expectedRevision: current!.revision,
        state: "AVAILABLE",
        readers,
      },
      context,
    );
  };
  await setReaders([]);
  const before = await reconciliationRows(f.projectId);
  const withheld = {
    ...original.assessment,
    visibility: "restricted",
    revalidationRequired: true,
    result: null,
  };
  expect(await reconciliation.get(f.pm, read)).toEqual({
    request: original.request,
    assessment: withheld,
  });
  expect(await reconciliation.check(f.pmo, f.check, context)).toEqual({
    ...checked,
    replayed: true,
    assessment: { ...withheld, replayed: true },
  });
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  await setReaders([f.pmo.subject, f.pm.subject]);
  expect(await reconciliation.get(f.pm, read)).toEqual(original);
});

it("NFR-SEC-001: configured PM equality, exact role and inherited scope are independent HTTP gates", async () => {
  const f = await fixture(),
    other = await fixture(),
    checked = await reconciliation.check(f.pmo, f.check, context),
    prefix = `/api/projects/${f.projectId}/reconciliation-requests`,
    detail = prefix + "/" + checked.request!.id,
    outsider: Actor = {
      ...f.pm,
      subject: "other-authorized-pm-" + randomUUID(),
    };
  await db.accessGrant.create({
    data: {
      customerId,
      subject: outsider.subject,
      scopeType: "project",
      scopeId: f.projectId,
      role: "project_manager",
    },
  });
  const denied = await api(outsider, detail);
  expect(denied.status).toBe(404);
  expect(await api(outsider, prefix)).toEqual(denied);
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.pm.subject },
  });
  for (const wrong of [
    {
      scopeType: "portfolio",
      scopeId: f.portfolioId,
      role: "portfolio_manager",
    },
    {
      scopeType: "portfolio",
      scopeId: other.portfolioId,
      role: "project_manager",
    },
    { scopeType: "project", scopeId: other.projectId, role: "project_manager" },
  ]) {
    const grant = await db.accessGrant.create({
      data: { customerId, subject: f.pm.subject, ...wrong },
    });
    expect(await api(f.pm, detail)).toEqual(denied);
    expect(await api(f.pm, prefix)).toEqual(denied);
    await db.accessGrant.delete({ where: { id: grant.id } });
  }
  await db.accessGrant.create({
    data: {
      customerId,
      subject: f.pm.subject,
      scopeType: "project",
      scopeId: f.projectId,
      role: "project_manager",
    },
  });
  expect((await api(f.pm, detail)).status).toBe(200);
  const before = await reconciliationRows(f.projectId, false);
  for (const role of ["leadership", "system_admin"] as const) {
    const actor: Actor = {
      customerId,
      subject: role + "-" + randomUUID(),
      roles: [role],
    };
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "project",
        scopeId: f.projectId,
        role,
      },
    });
    expect(await api(actor, prefix + "/manage")).toEqual(denied);
    expect(
      await api(
        actor,
        `/api/projects/${f.projectId}/milestone-reconciliation-checks`,
        "POST",
        f.check,
      ),
    ).toEqual(denied);
    expect(
      await api(actor, detail + "/assignment", "POST", {
        projectId: f.projectId,
        requestId: checked.request!.id,
        expectedAssignmentRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).toEqual(denied);
  }
  // Denied attempts may append their designated audit event, never success history.
  expect(await reconciliationRows(f.projectId, false)).toEqual(before);
});

it("AC-HLT-005: one durable request across creators, original proof, explicit assignment and retry receipts", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    reconciliation.check(f.pmo, f.check, context),
    reconciliation.check(
      f.pm,
      { ...f.check, idempotencyKey: randomUUID() },
      context,
    ),
  ]);
  expect([a.outcome, b.outcome].sort()).toEqual(["CREATED", "REUSED"]);
  expect(a.request?.id).toBe(b.request?.id);
  expect(a.assessment.assessmentId).not.toBe(b.assessment.assessmentId);
  expect(a.request).toMatchObject({
    state: "OPEN",
    assignment: {
      revision: 1,
      reason: "ASSIGNED",
      recipientSubject: f.pm.subject,
    },
  });
  const before = await db.milestoneConsistencyAssessment.count({
    where: { projectId: f.projectId },
  });
  expect(await reconciliation.check(f.pmo, f.check, context)).toMatchObject({
    checkId: a.checkId,
    replayed: true,
    request: { id: a.request!.id },
  });
  expect(
    await db.milestoneConsistencyAssessment.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(before);
  await expect(
    reconciliation.check(f.pmo, { ...f.check, enabled: false }, context),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const read = { projectId: f.projectId, requestId: a.request!.id };
  const delivered = await reconciliation.get(f.pm, read);
  expect(delivered?.assessment).toMatchObject({
    visibility: "available",
    historical: true,
    result: { status: "CONFLICTING", contributors: expect.any(Array) },
  });
  if (
    delivered?.assessment.visibility === "available" &&
    delivered.assessment.result.status === "CONFLICTING"
  ) {
    expect(delivered.assessment.result.contributors).toHaveLength(4);
    expect(
      delivered.assessment.result.evaluations.map(
        (entry) => entry.assessment?.resolvedValue,
      ),
    ).toEqual(
      expect.arrayContaining([
        { type: "text", value: "COMPLETE" },
        { type: "text", value: "OPEN" },
      ]),
    );
  }
  expect(await reconciliation.get(f.pmo, read)).toBeNull();
  const refresh = {
    ...read,
    expectedAssignmentRevision: 1,
    idempotencyKey: randomUUID(),
  };
  expect(
    await reconciliation.refreshAssignment(f.pmo, refresh, context),
  ).toMatchObject({
    replayed: false,
    assignment: { revision: 2, recipientSubject: f.pm.subject },
  });
  expect(
    await reconciliation.refreshAssignment(f.pmo, refresh, context),
  ).toMatchObject({ replayed: true, assignment: { revision: 2 } });
  await expect(
    reconciliation.refreshAssignment(
      f.pmo,
      { ...refresh, expectedAssignmentRevision: 2 },
      context,
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const raw = await db.milestoneReconciliationAssignment.findFirstOrThrow({
    where: { requestId: read.requestId, revision: 1 },
  });
  expect(raw).toMatchObject({
    grantSubject: f.pm.subject,
    grantRole: "project_manager",
    grantScopeId: f.portfolioId,
  });
  expect(
    await reconciliation.list(f.pm, { projectId: f.projectId }, "recipient"),
  ).toMatchObject({
    requests: [{ id: read.requestId, assignment: { revision: 2 } }],
    next: null,
    live: true,
  });
});

it.each([
  [0, true, "NO_CONFIGURED_PM"],
  [2, true, "AMBIGUOUS_CONFIGURED_PM"],
  [1, false, "PM_SCOPE_UNAVAILABLE"],
] as const)(
  "retains a pending unassigned case for PM count %i / grant %s",
  async (count, grant, reason) => {
    const f = await fixture(count, grant);
    const checked = await reconciliation.check(f.pmo, f.check, context);
    expect(checked).toMatchObject({
      outcome: "CREATED",
      request: {
        state: "OPEN",
        assignment: { reason, recipientSubject: null },
      },
    });
    expect(
      await reconciliation.get(f.pm, {
        projectId: f.projectId,
        requestId: checked.request!.id,
      }),
    ).toBeNull();
    expect(
      await reconciliation.list(f.pmo, { projectId: f.projectId }, "manage"),
    ).toMatchObject({ requests: [{ id: checked.request!.id }] });
  },
);

it("revalidates all sources and current recipient identity/scope without corrupting saved history", async () => {
  const f = await fixture();
  const checked = await reconciliation.check(f.pmo, f.check, context),
    read = { projectId: f.projectId, requestId: checked.request!.id };
  const sourceId = f.bindings[1]!.entry.sourceId;
  const current = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: current!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject],
    },
    context,
  );
  expect(await reconciliation.get(f.pm, read)).toMatchObject({
    assessment: {
      visibility: "restricted",
      result: null,
      revalidationRequired: true,
    },
    request: { state: "OPEN" },
  });
  expect(
    await reconciliation.get({ ...f.pm, roles: ["portfolio_manager"] }, read),
  ).toBeNull();
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.pm.subject },
  });
  expect(await reconciliation.get(f.pm, read)).toBeNull();
  const validity = await db.$queryRaw<
    { valid: boolean }[]
  >`SELECT public.valid_milestone_reconciliation_request(${read.requestId}::uuid) AS valid`;
  expect(validity).toEqual([{ valid: true }]);
  const refreshed = await reconciliation.refreshAssignment(
    f.pmo,
    { ...read, expectedAssignmentRevision: 1, idempotencyKey: randomUUID() },
    context,
  );
  expect(refreshed.assignment).toMatchObject({
    revision: 2,
    reason: "PM_SCOPE_UNAVAILABLE",
  });
  expect(
    await db.milestoneReconciliationRequest.count({
      where: { projectId: f.projectId, state: "OPEN" },
    }),
  ).toBe(1);
});

it("disabled reevaluation and later non-conflicting facts never close a pending request", async () => {
  const f = await fixture(),
    first = await reconciliation.check(f.pmo, f.check, context);
  const disabled = await reconciliation.check(
    f.pmo,
    { ...f.check, enabled: false, idempotencyKey: randomUUID() },
    context,
  );
  expect(disabled).toMatchObject({
    outcome: "NO_REQUEST",
    request: null,
    assessment: { result: { status: "DISABLED" } },
  });
  const milestone = f.bindings[0]!;
  await facts.appendHumanStatement(
    f.pmo,
    {
      projectId: f.projectId,
      factType: milestone.factType,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      value: { type: "text", value: "OPEN" },
      effectiveAt: "2026-09-02T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      originalStatement: "Synthetic revised open state",
    },
    context,
  );
  const later = await reconciliation.check(
    f.pmo,
    { ...f.check, idempotencyKey: randomUUID() },
    context,
  );
  expect(later).toMatchObject({ outcome: "NO_REQUEST", request: null });
  expect(
    await db.milestoneReconciliationRequest.findUnique({
      where: { id: first.request!.id },
    }),
  ).toMatchObject({ state: "OPEN" });
});

it("an interrupted birth rolls the fresh assessment back with all its child proofs", async () => {
  const f = await fixture();
  // The capture audit insert fails after proof construction. Its entire
  // transaction, including all earlier scalar/target rows, must roll back.
  const occupied = (
    await db.auditEvent.findFirstOrThrow({
      where: { customerId },
      select: { id: true },
    })
  ).id;
  let calls = 0;
  const broken = new DatabaseMilestoneReconciliationRepository(db, () =>
    ++calls === 3 ? occupied : randomUUID(),
  );
  const before = await db.milestoneConsistencyAssessment.count({
    where: { projectId: f.projectId },
  });
  await expect(broken.check(f.pmo, f.check, context)).rejects.toThrow();
  expect(
    await db.milestoneConsistencyAssessment.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(before);
  expect(
    await db.milestoneReconciliationRequest.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(0);
  expect(
    await db.milestoneReconciliationCheck.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(0);
});

it("INT-EVD-004 / INT-HLT-005: real HTTP PM delivery retains the original proof and revalidates identity and every source", async () => {
  const f = await fixture(),
    prefix = `/api/projects/${f.projectId}`;
  const checked = await api(
    f.pmo,
    prefix + "/milestone-reconciliation-checks",
    "POST",
    f.check,
  );
  expect(checked.status).toBe(201);
  expect(checked.body).toMatchObject({
    outcome: "CREATED",
    replayed: false,
    assessment: { result: { status: "CONFLICTING" } },
  });
  const requestId = checked.body.request.id,
    detail = prefix + "/reconciliation-requests/" + requestId;
  expect(
    (
      await api(
        f.pmo,
        prefix + "/milestone-reconciliation-checks",
        "POST",
        f.check,
      )
    ).body,
  ).toMatchObject({ checkId: checked.body.checkId, replayed: true });
  const reused = await api(
    f.pm,
    prefix + "/milestone-reconciliation-checks",
    "POST",
    { ...f.check, idempotencyKey: randomUUID() },
  );
  expect(reused.body).toMatchObject({
    outcome: "REUSED",
    request: { id: requestId },
  });
  expect(reused.body.assessment.assessmentId).not.toBe(
    checked.body.assessment.assessmentId,
  );
  const delivered = await api(f.pm, detail);
  expect(delivered.status).toBe(200);
  expect(delivered.body.assessment.assessmentId).toBe(
    checked.body.assessment.assessmentId,
  );
  expect(delivered.body.assessment.result.contributors).toHaveLength(4);
  expect((await api(f.pmo, detail)).status).toBe(404);
  expect(
    (await api({ ...f.pm, subject: "unassigned-pm-" + randomUUID() }, detail))
      .status,
  ).toBe(404);
  expect(
    (await api({ ...f.pm, roles: ["portfolio_manager"] }, detail)).status,
  ).toBe(404);
  expect((await api(f.pm, detail, "GET", undefined, "-1s")).status).toBe(401);
  expect((await api(null, detail)).status).toBe(401);
  expect(
    (await api(f.pmo, prefix + "/reconciliation-requests/manage")).body
      .requests,
  ).toHaveLength(1);
  expect(
    (await api(f.pm, prefix + "/reconciliation-requests")).body.requests,
  ).toHaveLength(1);
  expect((await api(f.pmo, prefix + "/reconciliation-requests")).status).toBe(
    404,
  );
  const sourceId = f.bindings[3]!.entry.sourceId;
  const accessBeforeRevoke = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: accessBeforeRevoke!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject],
    },
    context,
  );
  const restricted = await api(f.pm, detail);
  expect(restricted.status).toBe(200);
  expect(restricted.body.assessment).toMatchObject({
    visibility: "restricted",
    result: null,
    revalidationRequired: true,
  });
  expect(Object.keys(restricted.body.assessment).sort()).toEqual([
    "asOf",
    "assessmentId",
    "historical",
    "milestoneId",
    "projectId",
    "replayed",
    "result",
    "revalidationRequired",
    "visibility",
  ]);
  const accessBeforeRestore = await facts.getSourceAccess(f.pmo, {
    projectId: f.projectId,
    sourceId,
  });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: accessBeforeRestore!.revision,
      state: "AVAILABLE",
      readers: [f.pmo.subject, f.pm.subject],
    },
    context,
  );
  expect((await api(f.pm, detail)).body.assessment.visibility).toBe(
    "available",
  );
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.pm.subject },
  });
  expect((await api(f.pm, detail)).status).toBe(404);
  const refresh = {
    projectId: f.projectId,
    requestId,
    expectedAssignmentRevision: 1,
    idempotencyKey: randomUUID(),
  };
  expect(
    (await api(f.pmo, detail + "/assignment", "POST", refresh)).body,
  ).toMatchObject({
    assignment: { revision: 2, reason: "PM_SCOPE_UNAVAILABLE" },
    replayed: false,
  });
  expect(
    (await api(f.pmo, detail + "/assignment", "POST", refresh)).body,
  ).toMatchObject({ assignment: { revision: 2 }, replayed: true });
  expect(
    (
      await api(f.pmo, detail + "/assignment", "POST", {
        ...refresh,
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await api(f.pmo, detail + "/assignment", "POST", {
        ...refresh,
        recipientSubject: f.pm.subject,
      })
    ).status,
  ).toBe(400);
});

it("FR-MOD-002 / FR-EVD-009: HTTP context is metadata-only and binding creation cannot assert source authority", async () => {
  const f = await fixture(1, true, true),
    prefix = `/api/projects/${f.projectId}`;
  const result = await api(
    f.pmo,
    prefix + `/milestones/${f.milestone.id}/reconciliation-context`,
  );
  expect(result.status).toBe(200);
  expect(result.body.targets).toHaveLength(4);
  expect(Object.keys(result.body.targets[0].binding).sort()).toEqual([
    "factId",
    "factType",
    "id",
  ]);
  // Binding exists already: fresh commands conflict without creating a second fact.
  const command = {
    projectId: f.projectId,
    targetKind: "MILESTONE",
    targetId: f.milestone.id,
    idempotencyKey: randomUUID(),
    initialState: "COMPLETE",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    validUntil: null,
    originalStatement: "Synthetic duplicate binding",
  };
  expect(
    (await api(f.pmo, prefix + "/state-bindings", "POST", command)).status,
  ).toBe(409);
  expect(
    (
      await api(f.pmo, prefix + "/state-bindings", "POST", {
        ...command,
        provenance: "SYSTEM_VERIFIED",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await api(
        { ...f.pmo, roles: ["leadership"] },
        prefix + "/milestone-reconciliation-checks",
        "POST",
        f.check,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await api(
        f.pmo,
        prefix + "/reconciliation-requests/manage?afterId=" + randomUUID(),
      )
    ).status,
  ).toBe(400);
});

// EXEC-030: synthetic database only; SET LOCAL ROLE exercises role privileges,
// not a separately authenticated production API login.
it("observes the current three-item conflict under the API role and withholds revoked sources", async () => {
  const f = await fixture(1, true, false, false, true);
  const leader: Actor = { customerId, subject: "observation-leader-" + randomUUID(), roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId, subject: leader.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  for (const binding of f.bindings) {
    const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId });
    await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId,
      expectedRevision: access!.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  }
  let roleReads = 0;
  const attemptedWrites: string[] = [];
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const role = await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role");
      expect(role[0]?.role).toBe("pdaa_api");
      const acl = await tx.$queryRawUnsafe<{ allowed: boolean }[]>(`SELECT has_table_privilege(current_user, 'public."AuditEvent"', 'SELECT') AS allowed`);
      expect(acl[0]?.allowed).toBe(true); roleReads++;
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if ((key === "$queryRaw" || key === "$queryRawUnsafe" || key === "$executeRaw" || key === "$executeRawUnsafe") && typeof value === "function")
          return async (...args: unknown[]) => {
            const sql = rawSqlText(args[0]);
            if ((String(key).startsWith("$execute") && !/^SET LOCAL (?:statement_timeout|lock_timeout)\s*=/.test(sql)) || possibleMutation(sql)) {
              attemptedWrites.push(sql); throw new Error("Unexpected mutation in conflict observation");
            }
            return Reflect.apply(value, target, args);
          };
        if (value && typeof value === "object" && typeof key === "string" && !key.startsWith("$")) return new Proxy(value, { get(model, method) {
          const fn = Reflect.get(model, method);
          if (typeof fn === "function" && /^(?:create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(String(method)))
            return () => { attemptedWrites.push(`${key}.${String(method)}`); throw new Error("Unexpected ORM mutation in observation"); };
          return typeof fn === "function" ? fn.bind(model) : fn;
        } });
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const reader = new DatabaseMilestoneConflictObservationRepository(apiDatabase as never);
  const scopeTables = ["ProjectFact", "ProjectFactVersion", "FactEvidence", "FactSource", "FactSourceAccess", "FactSourceReader",
    "AuthorityPolicy", "AuthorityPolicyRevision", "AuthorityPolicyReceipt", "CanonicalStateBinding", "CanonicalStateBindingReceipt", "RequiredWorkItem"];
  const sourceRows = () => Promise.all(scopeTables.map((table) => db.$queryRawUnsafe(
    `SELECT to_jsonb(t)::text AS row FROM public."${table}" t WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY to_jsonb(t)::text COLLATE "C"`, customerId, f.projectId)));
  const before = await reconciliationRows(f.projectId), sourceBefore = await sourceRows();
  const observed = await reader.readLeadership(leader, f.projectId, f.milestone.id);
  expect(observed).toMatchObject({ outcome: "CONFLICTING", positions: expect.any(Array) });
  if (observed.outcome !== "CONFLICTING") throw new Error("Expected conflict");
  expect(observed.positions).toHaveLength(4);
  expect(observed.positions.filter((entry) => entry.targetKind === "WORK_ITEM").map((entry) => entry.state)).toEqual(["OPEN", "OPEN", "OPEN"]);
  for (const position of observed.positions) {
    const binding = f.bindings.find((row) => row.id === position.bindingId)!;
    const policy = f.policies[f.bindings.indexOf(binding)]!;
    expect(position).toMatchObject({ targetKind: binding.targetKind, targetId: binding.targetId, factId: binding.factId,
      factType: binding.factType, policyRevisionId: policy.id });
    expect(position.supports).toMatchObject([{ versionId: binding.entry.id, evidenceId: binding.entry.evidenceId,
      sourceId: binding.entry.sourceId, provenance: "HUMAN_CONFIRMED", freshness: "CURRENT", validity: "FINITE" }]);
  }
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  expect(await sourceRows()).toEqual(sourceBefore);
  expect(attemptedWrites).toEqual([]);
  const observationPath = `/api/projects/${f.projectId}/milestones/${f.milestone.id}/leadership-conflict-observation`;
  const http = await api(leader, observationPath);
  expect(http).toMatchObject({ status: 200, body: { projectId: f.projectId, milestoneId: f.milestone.id, outcome: "CONFLICTING" } });
  expect((await api(f.pm, observationPath)).status).toBe(404);
  expect((await api(leader, observationPath.replace(f.projectId, randomUUID()))).status).toBe(404);
  await expect(reader.readLeadership({ ...f.pm, roles: ["project_manager", "leadership"] }, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readLeadership(leader, f.projectId, randomUUID())).rejects.toMatchObject({ code: "DENIED" });
  const saved = await reconciliation.check(f.pmo, f.check, context);
  expect(saved.assessment).toMatchObject({ visibility: "available", result: { status: observed.outcome } });
  if (saved.assessment.visibility !== "available" || saved.assessment.result.status !== "CONFLICTING") throw new Error("Expected captured conflict");
  for (const position of observed.positions) {
    const captured = saved.assessment.result.contributors.find((entry) => entry.bindingId === position.bindingId);
    expect(captured).toMatchObject({ targetKind: position.targetKind, targetId: position.targetId, factId: position.factId, factType: position.factType });
    expect(captured!.supportingVersionIds.slice().sort()).toEqual(position.supports.map((entry) => entry.versionId).sort());
    expect(captured!.supportingEvidenceIds.slice().sort()).toEqual(position.supports.map((entry) => entry.evidenceId).sort());
  }
  const sourceId = f.bindings[1]!.entry.sourceId;
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: access!.revision,
    state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
  const afterRevoke = await reconciliationRows(f.projectId);
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await reconciliationRows(f.projectId)).toEqual(afterRevoke);
  expect(attemptedWrites).toEqual([]);
  expect(roleReads).toBeGreaterThanOrEqual(4);

  const revoked = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  let restored = await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: revoked!.revision,
    state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  async function blocked(waiting: number, blocking: number, fragments: string[]) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && fragments.every((fragment) => rows[0]!.query.includes(fragment))) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  let writerPid = 0, readerPid = 0, writerReady!: () => void, readerReady!: () => void, releaseWriter!: () => void;
  const writerEntered = new Promise<void>((resolve) => { writerReady = resolve; });
  const readerEntered = new Promise<void>((resolve) => { readerReady = resolve; });
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let paused = false;
  const gatedWriterDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
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
  const startedReaderDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
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
  const writer = new DatabaseProjectFactRepository(gatedWriterDb as never).setSourceAccess(f.pmo, { projectId: f.projectId,
    sourceId, expectedRevision: restored.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
  void writer.catch(() => {});
  let waitingReader: ReturnType<DatabaseMilestoneConflictObservationRepository["readLeadership"]> | undefined, writerFirst = false;
  try {
    await Promise.race([writerEntered, writer.then(() => { throw new Error("Writer exited before barrier"); })]);
    waitingReader = new DatabaseMilestoneConflictObservationRepository(startedReaderDb as never).readLeadership(leader, f.projectId, f.milestone.id);
    void waitingReader.catch(() => {});
    await Promise.race([readerEntered, waitingReader.then(() => { throw new Error("Reader exited before barrier"); })]);
    writerFirst = await blocked(readerPid, writerPid, ['FROM public."Project"', "FOR SHARE"]);
  } finally { releaseWriter(); await Promise.allSettled(waitingReader ? [writer, waitingReader] : [writer]); }
  expect(writerFirst).toBe(true);
  const written = await writer;
  await expect(waitingReader).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(passedProjectGate && loadedSourceAccess).toBe(true);
  expect(await db.factSourceReader.count({ where: { customerId, projectId: f.projectId, sourceId, subject: leader.subject } })).toBe(0);
  restored = await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: written.revision,
    state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  expect(await reader.readLeadership(leader, f.projectId, f.milestone.id)).toMatchObject({ outcome: "CONFLICTING" });

  let heldPid = 0, latePid = 0, heldReady!: () => void, lateReady!: () => void, releaseHeld!: () => void;
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const lateEntered = new Promise<void>((resolve) => { lateReady = resolve; });
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let readerPaused = false;
  const heldReaderDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      heldPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!readerPaused && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) { readerPaused = true; heldReady(); await heldGate; }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const startedWriterDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      latePid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      lateReady(); return operation(tx);
    }, options as never) };
  const heldRead = new DatabaseMilestoneConflictObservationRepository(heldReaderDb as never).readLeadership(leader, f.projectId, f.milestone.id);
  void heldRead.catch(() => {});
  let lateWriter: ReturnType<DatabaseProjectFactRepository["setSourceAccess"]> | undefined, readerFirst = false;
  try {
    await Promise.race([heldEntered, heldRead.then(() => { throw new Error("Reader exited before barrier"); })]);
    lateWriter = new DatabaseProjectFactRepository(startedWriterDb as never).setSourceAccess(f.pmo, { projectId: f.projectId,
      sourceId, expectedRevision: restored.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
    void lateWriter.catch(() => {});
    await Promise.race([lateEntered, lateWriter.then(() => { throw new Error("Writer exited before barrier"); })]);
    readerFirst = await blocked(latePid, heldPid, ['FROM "Project"', "FOR UPDATE"]);
  } finally { releaseHeld(); await Promise.allSettled(lateWriter ? [heldRead, lateWriter] : [heldRead]); }
  expect(readerFirst).toBe(true);
  expect(await heldRead).toMatchObject({ outcome: "CONFLICTING" });
  await lateWriter;
  expect(await db.factSourceReader.count({ where: { customerId, projectId: f.projectId, sourceId, subject: leader.subject } })).toBe(0);
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
}, 60000);

// NOT_DETECTED is also gated by every required source; it is not a project-wide clearance.
it("requires every current required source for a negative completion observation", async () => {
  const f = await fixture(1, true, false, false, true, true);
  const leader: Actor = { customerId, subject: "observation-negative-" + randomUUID(), roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId, subject: leader.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  for (const binding of f.bindings) {
    const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId });
    await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId,
      expectedRevision: access!.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  }
  const alternate: Actor = { customerId, subject: "observation-alternate-" + randomUUID(), roles: ["project_manager"] };
  await db.accessGrant.create({ data: { customerId, subject: alternate.subject, scopeType: "project", scopeId: f.projectId, role: "project_manager" } });
  const target = f.bindings[3]!, sourceId = target.entry.sourceId;
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const effectiveAt = new Date(now!.getTime() - 10_000).toISOString(), validUntil = new Date(now!.getTime() + 86_400_000).toISOString();
  const alternateVersion = await facts.appendHumanStatement(alternate, { projectId: f.projectId, factType: target.factType,
    expectedRevision: 1, idempotencyKey: randomUUID(), value: { type: "text", value: "COMPLETE" }, effectiveAt, validUntil,
    originalStatement: "Synthetic alternative completed work." }, context);
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: alternateVersion.entry.sourceId,
    expectedRevision: alternateVersion.entry.sourceAccessRevision, state: "AVAILABLE", readers: [alternate.subject, f.pmo.subject, leader.subject] }, context);
  const selector = (instanceId: string) => ({ sourceType: "human_statement", instanceId, requiredApproval: "NOT_REQUIRED" as const, validity: null });
  await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: target.factType, expectedRevision: 1, idempotencyKey: randomUUID(),
    effectiveAt, definition: { tiers: [{ selectors: [selector(alternateVersion.entry.sourceId)] }, { selectors: [selector(sourceId)] }],
      conflictBehavior: "REQUEST_RECONCILIATION" } }, context);
  const capture = await reconciliation.check(f.pmo, { ...f.check, idempotencyKey: randomUUID() }, context);
  if (capture.assessment.visibility !== "available" || capture.assessment.result.status !== "NOT_DETECTED") throw new Error("Expected complete negative capture");
  const assessment = capture.assessment.result.evaluations.find((entry) => entry.binding?.id === target.id)?.assessment;
  expect(assessment?.supportingVersionIds).toEqual([alternateVersion.entry.id]);
  expect(assessment?.supportingVersionIds).not.toContain(target.entry.id);
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
  const reader = new DatabaseMilestoneConflictObservationRepository(apiDatabase as never);
  expect(await reader.readLeadership(leader, f.projectId, f.milestone.id)).toMatchObject({ outcome: "NOT_DETECTED" });
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: access!.revision,
    state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject] }, context);
  await expect(reader.readLeadership(leader, f.projectId, f.milestone.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  const restricted = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: restricted!.revision,
    state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  expect(await reader.readLeadership(leader, f.projectId, f.milestone.id)).toMatchObject({ outcome: "NOT_DETECTED" });
}, 60000);
// Both orders for a positive grant: revoke waits for the reader's locked grant,
// or a waiting reader sees the committed removal and denies the project.
it("serializes leadership grant revocation with an observation", async () => {
  const f = await fixture(1, true, false, false, true);
  const leader: Actor = { customerId, subject: "observation-grant-" + randomUUID(), roles: ["leadership"] };
  const grant = { customerId, subject: leader.subject, scopeType: "project" as const, scopeId: f.projectId, role: "leadership" as const };
  await db.accessGrant.create({ data: grant });
  for (const binding of f.bindings) {
    const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId });
    await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId, expectedRevision: access!.revision,
      state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  }
  async function blocked(waiting: number, blocking: number, fragments: string[]) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && fragments.every((x) => rows[0]!.query.includes(x))) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  let writerPid = 0, readerPid = 0, signalWriter!: () => void, signalReader!: () => void, releaseWriter!: () => void;
  const writerReady = new Promise<void>((resolve) => { signalWriter = resolve; });
  const readerReady = new Promise<void>((resolve) => { signalReader = resolve; });
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const revokeDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>) => db.$transaction(async (tx) => {
    writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    return operation(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "accessGrant" && value && typeof value === "object") return new Proxy(value, { get(model, method) {
        const fn = Reflect.get(model, method);
        if (method === "deleteMany" && typeof fn === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(fn, model, args); signalWriter(); await writerGate; return output;
        };
        return typeof fn === "function" ? fn.bind(model) : fn;
      } });
      return typeof value === "function" ? value.bind(target) : value;
    } }));
  }) };
  let readerPassedGrant = false;
  const waitingDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    signalReader(); return operation(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
        if (sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) readerPassedGrant = true;
        return output;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }));
  }, options as never) };
  const revoke = new DatabaseProjectRepository(revokeDb as never).revokeGrant(f.pmo,
    { subject: leader.subject, scopeType: "project", scopeId: f.projectId }, context.correlationId);
  void revoke.catch(() => {});
  let waiting: ReturnType<DatabaseMilestoneConflictObservationRepository["readLeadership"]> | undefined, writerFirst = false;
  try {
    await Promise.race([writerReady, revoke.then(() => { throw new Error("Revoke exited before barrier"); })]);
    waiting = new DatabaseMilestoneConflictObservationRepository(waitingDb as never).readLeadership(leader, f.projectId, f.milestone.id);
    void waiting.catch(() => {});
    await Promise.race([readerReady, waiting.then(() => { throw new Error("Reader exited before barrier"); })]);
    writerFirst = await blocked(readerPid, writerPid, ['FROM public."AccessGrant"', "FOR SHARE"]);
  } finally { releaseWriter(); await Promise.allSettled(waiting ? [revoke, waiting] : [revoke]); }
  expect(writerFirst && readerPassedGrant).toBe(true); await revoke;
  await expect(waiting).rejects.toMatchObject({ code: "DENIED" });
  expect(await db.accessGrant.count({ where: grant })).toBe(0);
  await db.accessGrant.create({ data: grant });

  let heldPid = 0, latePid = 0, signalHeld!: () => void, signalLate!: () => void, releaseHeld!: () => void;
  const heldReady = new Promise<void>((resolve) => { signalHeld = resolve; });
  const lateReady = new Promise<void>((resolve) => { signalLate = resolve; });
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let paused = false;
  const heldDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    heldPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    return operation(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
        if (!paused && sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) { paused = true; signalHeld(); await heldGate; }
        return output;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }));
  }, options as never) };
  const lateDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>) => db.$transaction(async (tx) => {
    latePid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    signalLate(); return operation(tx);
  }) };
  const held = new DatabaseMilestoneConflictObservationRepository(heldDb as never).readLeadership(leader, f.projectId, f.milestone.id);
  void held.catch(() => {});
  let late: ReturnType<DatabaseProjectRepository["revokeGrant"]> | undefined, readerFirst = false;
  try {
    await Promise.race([heldReady, held.then(() => { throw new Error("Reader exited before barrier"); })]);
    late = new DatabaseProjectRepository(lateDb as never).revokeGrant(f.pmo,
      { subject: leader.subject, scopeType: "project", scopeId: f.projectId }, context.correlationId);
    void late.catch(() => {});
    await Promise.race([lateReady, late.then(() => { throw new Error("Revoke exited before barrier"); })]);
    readerFirst = await blocked(latePid, heldPid, ['DELETE', '"AccessGrant"']);
  } finally { releaseHeld(); await Promise.allSettled(late ? [held, late] : [held]); }
  expect(readerFirst).toBe(true); expect(await held).toMatchObject({ outcome: "CONFLICTING" }); await late;
  expect(await db.accessGrant.count({ where: grant })).toBe(0);
  await expect(new DatabaseMilestoneConflictObservationRepository(waitingDb as never).readLeadership(leader, f.projectId, f.milestone.id))
    .rejects.toMatchObject({ code: "DENIED" });

  // A first insert cannot upgrade a read that already observed no positive row.
  let signalAbsent!: () => void, releaseAbsent!: () => void;
  const absentReady = new Promise<void>((resolve) => { signalAbsent = resolve; });
  const absentGate = new Promise<void>((resolve) => { releaseAbsent = resolve; });
  let absentPaused = false;
  const absentDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    return operation(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
        if (!absentPaused && sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) {
          expect(output).toEqual([]); absentPaused = true; signalAbsent(); await absentGate;
        }
        return output;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } }));
  }, options as never) };
  const absentRead = new DatabaseMilestoneConflictObservationRepository(absentDb as never).readLeadership(leader, f.projectId, f.milestone.id);
  void absentRead.catch(() => {});
  let inserted = false, timeout: ReturnType<typeof setTimeout> | undefined;
  let grantWrite: ReturnType<DatabaseProjectRepository["setGrant"]> | undefined;
  try {
    await Promise.race([absentReady, absentRead.then(() => { throw new Error("Read exited before absence barrier"); })]);
    grantWrite = new DatabaseProjectRepository(db).setGrant(f.pmo,
      { subject: leader.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" }, context.correlationId);
    await Promise.race([grantWrite.then(() => { inserted = true; }), new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error("Grant insert blocked")), 2000); })]);
  } finally { if (timeout) clearTimeout(timeout); releaseAbsent(); await Promise.allSettled(grantWrite ? [absentRead, grantWrite] : [absentRead]); }
  expect(inserted).toBe(true); await expect(absentRead).rejects.toMatchObject({ code: "DENIED" });
  expect(await new DatabaseMilestoneConflictObservationRepository(waitingDb as never).readLeadership(leader, f.projectId, f.milestone.id))
    .toMatchObject({ outcome: "CONFLICTING" });
}, 60000);
// The fact and policy paths take Project UPDATE before their authoritative
// mutation. Each case observes both backend IDs and the actual lock wait.
it.each(["fact", "policy"] as const)("serializes %s changes with current observations in both orders", async (kind) => {
  const f = await fixture(1, true, false, false, true);
  const leader: Actor = { customerId, subject: `observation-${kind}-` + randomUUID(), roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId, subject: leader.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  for (const binding of f.bindings) {
    const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId });
    await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId,
      expectedRevision: access!.revision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  }
  const target = f.bindings[1]!;
  async function isBlocked(waiting: number, blocking: number, fragments: string[]) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && fragments.every((x) => rows[0]!.query.includes(x))) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  const findPosition = (value: Awaited<ReturnType<DatabaseMilestoneConflictObservationRepository["readLeadership"]>>) => {
    if (value.outcome !== "CONFLICTING") throw new Error("Expected conflict");
    const position = value.positions.find((row) => row.bindingId === target.id);
    if (!position) throw new Error("Missing target");
    return position;
  };
  const operation = async (dbOverride: unknown, revision: number) => {
    const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    const effectiveAt = new Date(now!.getTime() - (revision === 1 ? 4000 : 1000)).toISOString();
    if (kind === "fact") {
      const result = await new DatabaseProjectFactRepository(dbOverride as never).appendHumanStatement(f.pmo, {
        projectId: f.projectId, factType: target.factType, expectedRevision: revision, idempotencyKey: randomUUID(),
        value: { type: "text", value: "OPEN" }, effectiveAt, validUntil: new Date(now!.getTime() + 86_400_000).toISOString(),
        originalStatement: "Synthetic current required work state." }, context);
      return result.entry.id;
    }
    const result = await new DatabaseAuthorityRepository(dbOverride as never).appendPolicy(f.pmo, {
      projectId: f.projectId, factType: target.factType, expectedRevision: revision, idempotencyKey: randomUUID(), effectiveAt, definition }, context);
    return result.event.id;
  };
  let writerPid = 0, readerPid = 0, signalWriter!: () => void, signalReader!: () => void, releaseWriter!: () => void;
  const writerReady = new Promise<void>((resolve) => { signalWriter = resolve; });
  const readerReady = new Promise<void>((resolve) => { signalReader = resolve; });
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let writerPaused = false, readerPassed = false;
  const writerDb = { $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    return fn(new Proxy(tx, { get(targetTx, key) {
      const value = Reflect.get(targetTx, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
        if (!writerPaused && sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) { writerPaused = true; signalWriter(); await writerGate; }
        return output;
      };
      return typeof value === "function" ? value.bind(targetTx) : value;
    } }));
  }, options as never) };
  const readerDb = { $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid; signalReader();
    return fn(new Proxy(tx, { get(targetTx, key) {
      const value = Reflect.get(targetTx, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
        if (sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) readerPassed = true;
        return output;
      };
      return typeof value === "function" ? value.bind(targetTx) : value;
    } }));
  }, options as never) };
  const firstWrite = operation(writerDb, 1); void firstWrite.catch(() => {});
  let waiting: ReturnType<DatabaseMilestoneConflictObservationRepository["readLeadership"]> | undefined, writerFirst = false;
  try {
    await Promise.race([writerReady, firstWrite.then(() => { throw new Error("Writer exited before barrier"); })]);
    waiting = new DatabaseMilestoneConflictObservationRepository(readerDb as never).readLeadership(leader, f.projectId, f.milestone.id); void waiting.catch(() => {});
    await Promise.race([readerReady, waiting.then(() => { throw new Error("Reader exited before barrier"); })]);
    writerFirst = await isBlocked(readerPid, writerPid, ['FROM public."Project"', "FOR SHARE"]);
  } finally { releaseWriter(); await Promise.allSettled(waiting ? [firstWrite, waiting] : [firstWrite]); }
  expect(writerFirst && readerPassed).toBe(true);
  const firstId = await firstWrite, afterWrite = findPosition((await waiting)!);
  if (kind === "fact") expect(afterWrite.supports.map((row) => row.versionId)).toEqual([firstId]);
  else expect(afterWrite.policyRevisionId).toBe(firstId);

  let heldPid = 0, latePid = 0, signalHeld!: () => void, signalLate!: () => void, releaseHeld!: () => void;
  const heldReady = new Promise<void>((resolve) => { signalHeld = resolve; });
  const lateReady = new Promise<void>((resolve) => { signalLate = resolve; });
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let heldPaused = false;
  const heldDb = { $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    heldPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    return fn(new Proxy(tx, { get(targetTx, key) {
      const value = Reflect.get(targetTx, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
        if (!heldPaused && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) { heldPaused = true; signalHeld(); await heldGate; }
        return output;
      };
      return typeof value === "function" ? value.bind(targetTx) : value;
    } }));
  }, options as never) };
  const lateDb = { $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    latePid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid; signalLate(); return fn(tx);
  }, options as never) };
  const held = new DatabaseMilestoneConflictObservationRepository(heldDb as never).readLeadership(leader, f.projectId, f.milestone.id); void held.catch(() => {});
  let late: ReturnType<typeof operation> | undefined, readerFirst = false;
  try {
    await Promise.race([heldReady, held.then(() => { throw new Error("Reader exited before barrier"); })]);
    late = operation(lateDb, 2); void late.catch(() => {});
    await Promise.race([lateReady, late.then(() => { throw new Error("Writer exited before barrier"); })]);
    readerFirst = await isBlocked(latePid, heldPid, ['FROM "Project"', "FOR UPDATE"]);
  } finally { releaseHeld(); await Promise.allSettled(late ? [held, late] : [held]); }
  expect(readerFirst).toBe(true);
  const heldPosition = findPosition(await held), lateId = await late;
  if (kind === "fact") expect(heldPosition.supports.map((row) => row.versionId)).toEqual([firstId]);
  else expect(heldPosition.policyRevisionId).toBe(firstId);
  const fresh = findPosition(await new DatabaseMilestoneConflictObservationRepository(readerDb as never).readLeadership(leader, f.projectId, f.milestone.id));
  if (kind === "fact") expect(fresh.supports.map((row) => row.versionId)).toEqual([lateId]);
  else expect(fresh.policyRevisionId).toBe(lateId);
}, 60000);

// Sealed structure and source-authority inputs must be complete; none of these
// cases should be reported as a clean completion result.
it.each(["empty required links", "missing binding", "cancelled work", "expired evidence", "disabled policy"] as const)(
  "withholds a completion result for %s", async (variant) => {
    const f = await fixture(1, true, false, false, true, false,
      variant === "empty required links", variant === "cancelled work", variant === "missing binding", variant === "expired evidence");
    const leader: Actor = { customerId, subject: "observation-incomplete-" + randomUUID(), roles: ["leadership"] };
    await db.accessGrant.create({ data: { customerId, subject: leader.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
    for (const binding of f.bindings) {
      const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId });
      await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId, expectedRevision: access!.revision,
        state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
    }
    if (variant === "disabled policy") {
      const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
      await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: f.bindings[1]!.factType, expectedRevision: 1,
        idempotencyKey: randomUUID(), effectiveAt: new Date(now!.getTime() - 1000).toISOString(), definition: null }, context);
    }
    if (variant === "expired evidence") {
      const rows = await db.projectFactVersion.findMany({ where: { id: { in: f.bindings.map((binding) => binding.entry.id) } } });
      const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      expect(rows.filter((row) => row.validUntil!.getTime() <= now!.getTime())).toHaveLength(1);
    }
    const linkCount = await db.requiredWorkItem.count({ where: { customerId, projectId: f.projectId, milestoneId: f.milestone.id } });
    expect(linkCount).toBe(variant === "empty required links" ? 0 : 3);
    expect(f.bindings).toHaveLength(variant === "missing binding" ? 3 : linkCount + 1);
    if (variant === "cancelled work") {
      const row = await db.projectFactVersion.findFirstOrThrow({ where: { id: f.bindings.at(-1)!.entry.id } });
      expect(row.value).toEqual({ type: "text", value: "CANCELLED" });
    }
    const captured = await reconciliation.check(f.pmo, { ...f.check, idempotencyKey: randomUUID() }, context);
    expect(captured.assessment).toMatchObject({ visibility: "available", result: { status: "UNKNOWN" } });
    const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
    await expect(new DatabaseMilestoneConflictObservationRepository(roleDb as never).readLeadership(leader, f.projectId, f.milestone.id))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
  }, 60000,
);
// A state-binding birth acquires Project UPDATE before it creates the reserved
// fact graph. A reader observes the complete before or after state under SHARE.
it.each(["writer-first", "reader-first"] as const)("serializes binding birth with an observation (%s)", async (order) => {
  const f = await fixture(1, true, false, false, true, false, false, false, true);
  const leader: Actor = { customerId, subject: "observation-birth-" + randomUUID(), roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId, subject: leader.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  for (const binding of f.bindings) {
    const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId });
    await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: binding.entry.sourceId, expectedRevision: access!.revision,
      state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  }
  const links = await db.requiredWorkItem.findMany({ where: { customerId, projectId: f.projectId, milestoneId: f.milestone.id } });
  const missing = links.find((link) => !f.bindings.some((binding) => binding.targetId === link.workItemId));
  if (!missing) throw new Error("Missing-birth fixture invalid");
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const effectiveAt = new Date(now!.getTime() - 1000).toISOString(), validUntil = new Date(now!.getTime() + 86_400_000).toISOString();
  let writerPid = 0, readerPid = 0, signalWriter!: () => void, signalReader!: () => void, release!: () => void;
  const writerReady = new Promise<void>((resolve) => { signalWriter = resolve; });
  const readerReady = new Promise<void>((resolve) => { signalReader = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writerPaused = false, readerPaused = false, bindingCount = -1, bindingIds: string[] = [];
  const writerDb = { $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    if (order === "reader-first") signalWriter();
    return fn(new Proxy(tx, { get(targetTx, key) {
      const value = Reflect.get(targetTx, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
        if (order === "writer-first" && !writerPaused && sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) {
          writerPaused = true; signalWriter(); await gate;
        }
        return output;
      };
      return typeof value === "function" ? value.bind(targetTx) : value;
    } }));
  }, options as never) };
  const readerDb = { $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    if (order === "writer-first") signalReader();
    return fn(new Proxy(tx, { get(targetTx, key) {
      const value = Reflect.get(targetTx, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const output = await Reflect.apply(value, targetTx, args), sql = rawSqlText(args[0]);
        if (order === "reader-first" && !readerPaused && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) {
          readerPaused = true; signalReader(); await gate;
        }
        return output;
      };
      if (key === "canonicalStateBinding" && value && typeof value === "object") return new Proxy(value, { get(model, method) {
        const fnModel = Reflect.get(model, method);
        if (method === "findMany" && typeof fnModel === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(fnModel, model, args); bindingCount = result.length; bindingIds = result.map((row: { id: string }) => row.id); return result;
        };
        return typeof fnModel === "function" ? fnModel.bind(model) : fnModel;
      } });
      return typeof value === "function" ? value.bind(targetTx) : value;
    } }));
  }, options as never) };
  const startWriter = () => new DatabaseMilestoneReconciliationRepository(writerDb as never).createStateBinding(f.pmo, {
    projectId: f.projectId, targetKind: "WORK_ITEM", targetId: missing.workItemId, initialState: "OPEN", idempotencyKey: randomUUID(),
    effectiveAt, validUntil, originalStatement: "Synthetic new binding for required work." }, context);
  const startReader = () => new DatabaseMilestoneConflictObservationRepository(readerDb as never).readLeadership(leader, f.projectId, f.milestone.id);
  let writer: ReturnType<typeof startWriter> | undefined, reader: ReturnType<typeof startReader> | undefined, observedBlock = false;
  try {
    if (order === "writer-first") {
      writer = startWriter(); void writer.catch(() => {});
      await Promise.race([writerReady, writer.then(() => { throw new Error("Writer exited before barrier"); })]);
      reader = startReader(); void reader.catch(() => {});
      await Promise.race([readerReady, reader.then(() => { throw new Error("Reader exited before barrier"); })]);
    } else {
      reader = startReader(); void reader.catch(() => {});
      await Promise.race([readerReady, reader.then(() => { throw new Error("Reader exited before barrier"); })]);
      writer = startWriter(); void writer.catch(() => {});
      await Promise.race([writerReady, writer.then(() => { throw new Error("Writer exited before barrier"); })]);
    }
    const waiting = order === "writer-first" ? readerPid : writerPid, blocking = order === "writer-first" ? writerPid : readerPid;
    const fragments = order === "writer-first" ? ['FROM public."Project"', "FOR SHARE"] : ['FROM "Project"', "FOR UPDATE"];
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && fragments.every((x) => rows[0]!.query.includes(x))) { observedBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally { release(); await Promise.allSettled([...(writer ? [writer] : []), ...(reader ? [reader] : [])]); }
  expect(observedBlock).toBe(true); const created = await writer;
  await expect(reader).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(bindingCount).toBe(order === "writer-first" ? 4 : 3);
  if (!created) throw new Error("Binding was not created");
  expect(bindingIds.includes(created.id)).toBe(order === "writer-first");
  await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: created.factType, expectedRevision: 0,
    idempotencyKey: randomUUID(), effectiveAt, definition }, context);
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId: created.entry.sourceId,
    expectedRevision: created.entry.sourceAccessRevision, state: "AVAILABLE", readers: [f.pmo.subject, f.pm.subject, leader.subject] }, context);
  const roleDb = { $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return fn(tx); }, options as never) };
  const fresh = await new DatabaseMilestoneConflictObservationRepository(roleDb as never).readLeadership(leader, f.projectId, f.milestone.id);
  expect(fresh).toMatchObject({ outcome: "CONFLICTING" });
  if (fresh.outcome !== "CONFLICTING") throw new Error("Expected configured conflict");
  expect(fresh.positions.find((position) => position.bindingId === created.id)).toMatchObject({ targetId: missing.workItemId,
    factId: created.factId, supports: [{ versionId: created.entry.id, evidenceId: created.entry.evidenceId, sourceId: created.entry.sourceId }] });
}, 60000);

it.each(["project-leadership", "portfolio-leadership"] as const)("reports a matching request without writing with %s grants", async (arrangement) => {
  const f = await fixture(1, true, false, false, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  if (arrangement === "portfolio-leadership") {
    const changed = await db.accessGrant.updateMany({ where: { customerId, subject: dual.subject, scopeType: "portfolio", scopeId: f.portfolioId },
      data: { role: "leadership" } });
    expect(changed.count).toBe(1);
  }
  await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId,
    role: arrangement === "project-leadership" ? "leadership" : "pmo_admin" } });
  const roleDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
  const reader = new DatabaseMilestoneConflictObservationRepository(roleDb as never);
  const read = () => reader.readForLeaderManager(dual, f.projectId, f.milestone.id);
  const before = await reconciliationRows(f.projectId);
  const absent = await read();
  expect(absent).toMatchObject({ observation: { projectId: f.projectId, milestoneId: f.milestone.id, outcome: "CONFLICTING" },
    requestStatus: "NO_MATCHING_REQUEST_RECORDED" });
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  const created = await reconciliation.check(f.pmo, f.check, context);
  expect(created.outcome).toBe("CREATED");
  const afterCreate = await reconciliationRows(f.projectId);
  const matched = await read();
  expect(matched).toMatchObject({ observation: { projectId: f.projectId, milestoneId: f.milestone.id, outcome: "CONFLICTING" },
    requestStatus: "MATCHING_REQUEST_RECORDED" });
  expect(JSON.stringify(matched)).not.toContain(created.request!.id);
  expect(JSON.stringify(matched)).not.toContain(f.pm.subject);
  expect(await reconciliationRows(f.projectId)).toEqual(afterCreate);
  await expect(reader.readForLeaderManager({ ...dual, roles: ["leadership"] }, f.projectId, f.milestone.id))
    .rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readForLeaderManager({ ...dual, roles: ["pmo_admin"] }, f.projectId, f.milestone.id))
    .rejects.toMatchObject({ code: "DENIED" });
  await expect(reader.readForLeaderManager(dual, randomUUID(), f.milestone.id)).rejects.toMatchObject({ code: "DENIED" });
  for (const role of ["leadership", "pmo_admin"]) {
    const grant = await db.accessGrant.findFirstOrThrow({ where: { customerId, subject: dual.subject, role } });
    await db.accessGrant.delete({ where: { id: grant.id } });
    await expect(read()).rejects.toMatchObject({ code: "DENIED" });
    await db.accessGrant.create({ data: grant });
  }
  const sourceId = f.bindings[0]!.entry.sourceId;
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: access!.revision,
    state: "AVAILABLE", readers: [f.pm.subject] }, context);
  const afterRevocation = await reconciliationRows(f.projectId);
  await expect(read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await reconciliationRows(f.projectId)).toEqual(afterRevocation);
}, 60000);

it("enforces dual-role and source access on the serialized request observation endpoint", async () => {
  const f = await fixture(1, true, false, false, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  const grant = await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  const path = `/api/projects/${f.projectId}/milestones/${f.milestone.id}/leadership-manager-request-observation`;
  const before = await reconciliationRows(f.projectId);
  const absent = await api(dual, path);
  expect(absent).toMatchObject({ status: 200, body: { requestStatus: "NO_MATCHING_REQUEST_RECORDED", observation: { outcome: "CONFLICTING" } } });
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  const created = await reconciliation.check(f.pmo, f.check, context);
  const afterCreate = await reconciliationRows(f.projectId);
  const matched = await api(dual, path);
  expect(matched).toMatchObject({ status: 200, body: { requestStatus: "MATCHING_REQUEST_RECORDED" } });
  expect(JSON.stringify(matched.body)).not.toContain(created.request!.id);
  expect(JSON.stringify(matched.body)).not.toContain(f.pm.subject);
  expect(await reconciliationRows(f.projectId)).toEqual(afterCreate);
  expect((await api({ ...dual, roles: ["leadership"] }, path)).status).toBe(404);
  expect((await api({ ...dual, roles: ["pmo_admin"] }, path)).status).toBe(404);
  expect((await api(dual, path.replace(f.projectId, randomUUID()))).status).toBe(404);
  await db.accessGrant.delete({ where: { id: grant.id } });
  expect((await api(dual, path)).status).toBe(404);
  await db.accessGrant.create({ data: grant });
  const sourceId = f.bindings[0]!.entry.sourceId;
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: access!.revision,
    state: "AVAILABLE", readers: [f.pm.subject] }, context);
  const afterRevoke = await reconciliationRows(f.projectId);
  expect((await api(dual, path)).status).toBe(503);
  expect(await reconciliationRows(f.projectId)).toEqual(afterRevoke);
}, 60000);

it("withholds request status for a non-conflict and fails closed after policy removal", async () => {
  const f = await fixture(1, true, false, false, true, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  const reader = new DatabaseMilestoneConflictObservationRepository({ $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) } as never);
  const read = () => reader.readForLeaderManager(dual, f.projectId, f.milestone.id);
  const before = await reconciliationRows(f.projectId);
  expect(await read()).toMatchObject({ observation: { outcome: "NOT_DETECTED" }, requestStatus: null });
  expect(await reconciliationRows(f.projectId)).toEqual(before);
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: f.bindings[0]!.factType, expectedRevision: 1,
    idempotencyKey: randomUUID(), effectiveAt: new Date(now!.getTime() - 1000).toISOString(), definition: null }, context);
  const afterPolicy = await reconciliationRows(f.projectId);
  await expect(read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await reconciliationRows(f.projectId)).toEqual(afterPolicy);
}, 60000);

it("matches only the current contributor identity when other evidence and policy change", async () => {
  const f = await fixture(1, true, false, true, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  const reader = new DatabaseMilestoneConflictObservationRepository({ $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) } as never);
  const read = () => reader.readForLeaderManager(dual, f.projectId, f.milestone.id);
  expect((await reconciliation.check(f.pmo, f.check, context)).outcome).toBe("CREATED");
  const initial = await read();
  expect(initial).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const effectiveAt = new Date(now!.getTime() - 1000).toISOString(), validUntil = new Date(now!.getTime() + 86_400_000).toISOString();
  const noncontributor = f.bindings.at(-1)!;
  await facts.appendHumanStatement(f.pmo, { projectId: f.projectId, factType: noncontributor.factType, expectedRevision: 1,
    idempotencyKey: randomUUID(), value: { type: "text", value: "COMPLETE" }, effectiveAt, validUntil,
    originalStatement: "Synthetic revised noncontributing completed work." }, context);
  await authority.appendPolicy(f.pmo, { projectId: f.projectId, factType: noncontributor.factType, expectedRevision: 1,
    idempotencyKey: randomUUID(), effectiveAt, definition }, context);
  const afterOtherChanges = await reconciliationRows(f.projectId);
  const afterOther = await read();
  expect(afterOther).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
  if (initial.observation.outcome !== "CONFLICTING" || afterOther.observation.outcome !== "CONFLICTING") throw new Error("Expected conflicts");
  expect(afterOther.observation.positions).toEqual(initial.observation.positions);
  expect(await reconciliationRows(f.projectId)).toEqual(afterOtherChanges);
  const contributor = f.bindings[1]!;
  await facts.appendHumanStatement(f.pmo, { projectId: f.projectId, factType: contributor.factType, expectedRevision: 1,
    idempotencyKey: randomUUID(), value: { type: "text", value: "OPEN" }, effectiveAt, validUntil,
    originalStatement: "Synthetic revised contributing open work." }, context);
  const afterContributorChange = await reconciliationRows(f.projectId);
  expect(await read()).toMatchObject({ requestStatus: "NO_MATCHING_REQUEST_RECORDED" });
  expect(await reconciliationRows(f.projectId)).toEqual(afterContributorChange);
}, 60000);

it("withholds a revoked original source in the isolated historical proof helper", async () => {
  const f = await fixture(1, true, false, false, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  const created = await reconciliation.check(f.pmo, f.check, context);
  expect(created.outcome).toBe("CREATED");
  const request = await db.milestoneReconciliationRequest.findUniqueOrThrow({ where: { id: created.request!.id }, select: { contributorIdentity: true } });
  const reader = new DatabaseMilestoneConflictObservationRepository({ $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) } as never);
  const read = () => reader.readForLeaderManager(dual, f.projectId, f.milestone.id);
  const before = await read();
  expect(before.requestStatus).toBe("MATCHING_REQUEST_RECORDED");
  const proof = () => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    await tx.$queryRaw`SELECT id FROM public."Project" WHERE "customerId"=${customerId}::uuid AND id=${f.projectId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM public."AccessGrant" WHERE "customerId"=${customerId}::uuid AND subject=${dual.subject}
      AND (("scopeType"='project' AND "scopeId"=${f.projectId}::uuid) OR ("scopeType"='portfolio' AND "scopeId"=${f.portfolioId}::uuid)) ORDER BY id FOR SHARE`;
    return findMatchingMilestoneRequest(tx, dual, before.observation, request.contributorIdentity);
  });
  await expect(proof()).resolves.toBe("MATCHING_REQUEST_RECORDED");
  const sourceId = f.bindings[0]!.entry.sourceId;
  const access = await facts.getSourceAccess(f.pmo, { projectId: f.projectId, sourceId });
  await facts.setSourceAccess(f.pmo, { projectId: f.projectId, sourceId, expectedRevision: access!.revision,
    state: "AVAILABLE", readers: [f.pm.subject] }, context);
  const afterRevocation = await reconciliationRows(f.projectId);
  await expect(read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  // Exercise the defense-in-depth helper separately. Normal reads withhold at
  // the current complete-prefix gate before reaching this historical check.
  await expect(proof()).rejects.toThrow("Milestone request proof unavailable");
  expect(await reconciliationRows(f.projectId)).toEqual(afterRevocation);
}, 60000);

it.each(["reader", "writer"] as const)("serializes matching-request observation and request birth when %s starts first", async (firstKind) => {
  const f = await fixture(1, true, false, false, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  const waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const wrapped = (kind: "reader" | "writer", hold: boolean) => ({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          const lock = sql.includes('FROM public."Project"') && sql.includes(kind === "reader" ? "FOR SHARE" : "FOR UPDATE");
          if (!paused && lock) { paused = true; heldReady(); await gate; }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never),
  });
  const read = (hold: boolean) => new DatabaseMilestoneConflictObservationRepository(wrapped("reader", hold) as never)
    .readForLeaderManager(dual, f.projectId, f.milestone.id);
  const write = (hold: boolean) => new DatabaseMilestoneReconciliationRepository(wrapped("writer", hold) as never)
    .check(f.pmo, f.check, context);
  const first = firstKind === "reader" ? read(true) : write(true); void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? write(false) : read(false); void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const fragments = ['FROM public."Project"', firstKind === "reader" ? "FOR UPDATE" : "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
  expect(sawBlock).toBe(true);
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ requestStatus: "NO_MATCHING_REQUEST_RECORDED" });
    expect(await second).toMatchObject({ outcome: "CREATED" });
  } else {
    expect(await first).toMatchObject({ outcome: "CREATED" });
    expect(await second).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
  }
  const afterWrite = await reconciliationRows(f.projectId);
  expect(await read(false)).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
  expect(await reconciliationRows(f.projectId)).toEqual(afterWrite);
}, 90000);

it.each(["reader", "writer"] as const)("serializes matching-request observation and direct reader removal when %s starts first", async (firstKind) => {
  const f = await fixture(1, true, false, false, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  expect((await reconciliation.check(f.pmo, f.check, context)).outcome).toBe("CREATED");
  const sourceId = f.bindings[0]!.entry.sourceId;
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  let waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const read = (hold: boolean) => new DatabaseMilestoneConflictObservationRepository({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!paused && sql.includes('FROM public."Project"') && sql.includes("FOR SHARE")) { paused = true; heldReady(); await gate; }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never),
  } as never).readForLeaderManager(dual, f.projectId, f.milestone.id);
  const remove = (hold: boolean) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
    const count = await tx.$executeRaw`DELETE FROM public."FactSourceReader" WHERE "customerId"=${customerId}::uuid
      AND "projectId"=${f.projectId}::uuid AND "sourceId"=${sourceId}::uuid AND subject=${dual.subject}`;
    if (hold) { heldReady(); await gate; }
    return count;
  }, { timeout: 20000 });
  expect(await read(false)).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
  waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  const beforeRace = await reconciliationRows(f.projectId);
  const first = firstKind === "reader" ? read(true) : remove(true); void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? remove(false) : read(false); void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const fragments = firstKind === "reader" ? ['DELETE FROM public."FactSourceReader"'] : ['FROM public."Project"', "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
  expect(sawBlock).toBe(true);
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
    expect(await second).toBe(1);
  } else {
    expect(await first).toBe(1);
    await expect(second).rejects.toMatchObject({ code: "UNAVAILABLE" });
  }
  await expect(read(false)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await reconciliationRows(f.projectId)).toEqual(beforeRace);
}, 90000);

it.each(["reader", "writer"] as const)("serializes matching-request observation and grant revocation when %s starts first", async (firstKind) => {
  const f = await fixture(1, true, false, false, true);
  const dual: Actor = { ...f.pmo, roles: ["leadership", "pmo_admin"] };
  const grant = await db.accessGrant.create({ data: { customerId, subject: dual.subject, scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  expect((await reconciliation.check(f.pmo, f.check, context)).outcome).toBe("CREATED");
  let release!: () => void, heldReady!: () => void, waitingReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldEntered = new Promise<void>((resolve) => { heldReady = resolve; });
  let waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  let heldPid = 0, waitingPid = 0, paused = false;
  const read = (hold: boolean) => new DatabaseMilestoneConflictObservationRepository({
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (hold && key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const output = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!paused && sql.includes('FROM public."AccessGrant"') && sql.includes("FOR SHARE")) { paused = true; heldReady(); await gate; }
          return output;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never),
  } as never).readForLeaderManager(dual, f.projectId, f.milestone.id);
  const revoke = (hold: boolean) => db.$transaction(async (tx) => {
    const pid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    if (hold) heldPid = pid; else { waitingPid = pid; waitingReady(); }
    const count = await tx.$executeRaw`DELETE FROM public."AccessGrant" WHERE id=${grant.id}::uuid`;
    if (hold) { heldReady(); await gate; }
    return count;
  }, { timeout: 20000 });
  expect(await read(false)).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
  waitingEntered = new Promise<void>((resolve) => { waitingReady = resolve; });
  const beforeRace = await reconciliationRows(f.projectId);
  const first = firstKind === "reader" ? read(true) : revoke(true); void first.catch(() => {});
  let second: Promise<unknown> | undefined, sawBlock = false;
  try {
    await Promise.race([heldEntered, first.then(() => { throw new Error("First transaction exited before its barrier"); })]);
    second = firstKind === "reader" ? revoke(false) : read(false); void second.catch(() => {});
    await Promise.race([waitingEntered, second.then(() => { throw new Error("Second transaction exited before its barrier"); })]);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waitingPid);
      const fragments = firstKind === "reader" ? ['DELETE FROM public."AccessGrant"'] : ['FROM public."AccessGrant"', "FOR SHARE"];
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldPid) &&
          fragments.every((fragment) => rows[0]!.query.includes(fragment))) { sawBlock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
  expect(sawBlock).toBe(true);
  if (firstKind === "reader") {
    expect(await first).toMatchObject({ requestStatus: "MATCHING_REQUEST_RECORDED" });
    expect(await second).toBe(1);
  } else {
    expect(await first).toBe(1);
    await expect(second).rejects.toMatchObject({ code: "DENIED" });
  }
  await expect(read(false)).rejects.toMatchObject({ code: "DENIED" });
  expect(await reconciliationRows(f.projectId)).toEqual(beforeRace);
}, 90000);
