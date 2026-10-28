// EXEC-018 / FR-HLT-002 / AC-HLT-002: real authority-to-completeness wiring.
import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectUpdateRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
} from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (
  !url ||
  process.env.NODE_ENV === "production" ||
  process.env.DATA_MODE !== "synthetic" ||
  !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
  !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname)
)
  throw new Error("Completeness checks require an isolated synthetic database");
const db = createDatabase(url);
afterAll(async () => {
  await db.$disconnect();
});

// Set only birth timestamps through real creation transactions. Never update
// immutable history or mock authority selection, permissions or the evaluator.
function birthDatabase(bornAt: Date) {
  return {
    $transaction: (
      operation: (tx: unknown) => Promise<unknown>,
      options: unknown,
    ) =>
      db.$transaction(
        async (tx) =>
          operation(
            new Proxy(tx, {
              get(target, key) {
                if (key === "canonicalProject")
                  return new Proxy(target.canonicalProject, {
                    get(delegate, method) {
                      if (method === "create")
                        return (args: Parameters<typeof delegate.create>[0]) =>
                          delegate.create({
                            ...args,
                            data: { ...args.data, createdAt: bornAt },
                          });
                      const value = Reflect.get(delegate, method);
                      return typeof value === "function"
                        ? value.bind(delegate)
                        : value;
                    },
                  });
                if (key === "factEvidence")
                  return new Proxy(target.factEvidence, {
                    get(delegate, method) {
                      if (method === "create")
                        return (args: Parameters<typeof delegate.create>[0]) =>
                          delegate.create({
                            ...args,
                            data: { ...args.data, observedAt: bornAt },
                          });
                      const value = Reflect.get(delegate, method);
                      return typeof value === "function"
                        ? value.bind(delegate)
                        : value;
                    },
                  });
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        options as never,
      ),
  };
}

async function fixture(configured = true) {
  const customerId = process.env.CUSTOMER_ID!;
  const portfolioId = randomUUID();
  const admin: Actor = {
    customerId,
    subject: "completeness-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  const writer: Actor = {
    customerId,
    subject: "completeness-writer-" + randomUUID(),
    roles: ["project_manager"],
  };
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Completeness fixture" },
  });
  for (const actor of [admin, writer])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: actor.roles[0]!,
      },
    });
  const bornAt = new Date(Date.now() - 86_400_000);
  const birth = birthDatabase(bornAt);
  const project = await new DatabaseCanonicalProjectRepository(
    birth as never,
  ).createProject(admin, canonicalFixture(portfolioId), randomUUID());
  const updates = new DatabaseProjectUpdateRepository(db);
  const facts = new DatabaseProjectFactRepository(birth as never);
  const authority = new DatabaseAuthorityRepository(db);
  const factType = "project.status";
  const statementReferences: string[] = [];
  if (configured) await updates.setPolicy(
    admin,
    project.id,
    {
      expectedRevision: 0,
      freshnessWindowSeconds: 1,
      timeZone: "UTC",
      requiredFacts: [{ factType, label: "Current status" }],
      responsibleSubject: "synthetic-owner-4",
      scheduledScanEnabled: false,
      reminderBusinessDayOffsets: [],
      escalationAfterBusinessDays: 0,
      escalationRecipientSubject: null,
      quietHoursStartLocal: null,
      quietHoursEndLocal: null,
    },
    randomUUID(),
  );
  const append = async (
    actor = admin,
    readers = [admin.subject],
    value = "Private completeness value",
  ) => {
    const fact = await db.projectFact.findFirst({
      where: { customerId, projectId: project.id, factType },
    });
    const result = await facts.appendHumanStatement(
      actor,
      {
        projectId: project.id,
        factType,
        expectedRevision: fact?.revision ?? 0,
        idempotencyKey: randomUUID(),
        effectiveAt: bornAt.toISOString(),
        value: { type: "text", value },
        originalStatement: "Private completeness statement",
      },
      { correlationId: randomUUID() },
    );
    await facts.setSourceAccess(
      admin,
      {
        projectId: project.id,
        sourceId: result.entry.sourceId,
        expectedRevision: result.entry.sourceAccessRevision,
        state: "AVAILABLE",
        readers,
      },
      { correlationId: randomUUID() },
    );
    statementReferences.push(
      result.entry.id,
      result.entry.sourceId,
      result.entry.evidenceId,
    );
    return result;
  };
  const policy = async (durationMs: number, expectedRevision = 0) =>
    authority.appendPolicy(
      admin,
      {
        projectId: project.id,
        factType,
        expectedRevision,
        idempotencyKey: randomUUID(),
        effectiveAt: bornAt.toISOString(),
        definition: {
          tiers: [
            {
              selectors: [
                {
                  sourceType: "human_statement",
                  instanceId: null,
                  requiredApproval: "NOT_REQUIRED",
                  validity: { basis: "observedAt", durationMs },
                },
              ],
            },
          ],
          conflictBehavior: "REQUEST_RECONCILIATION",
        },
      },
      { correlationId: randomUUID() },
    );
  const assess = () => updates.assess(admin, project.id, randomUUID());
  return {
    customerId,
    projectId: project.id,
    admin,
    writer,
    facts,
    authority,
    updates,
    append,
    policy,
    assess,
    factType,
    statementReferences,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
it("reads current update advice as the API role and withholds revoked source evidence without writes", async () => {
  const f = await fixture();
  const leader: Actor = { customerId: f.customerId, subject: `update-advice-${randomUUID()}`, roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId: f.customerId, subject: leader.subject,
    scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  let transactions = 0, readerPid = 0;
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const identity = await tx.$queryRawUnsafe<{ role: string; pid: number }[]>("SELECT current_user AS role, pg_backend_pid() AS pid");
      expect(identity[0]?.role).toBe("pdaa_api");
      readerPid = identity[0]!.pid;
      transactions++;
      return operation(tx);
    }, options as never) };
  const api = new DatabaseProjectUpdateRepository(apiDatabase as never);
  const counts = async () => Promise.all([
    db.projectUpdateAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateObligation.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdatePreview.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateEngagement.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateStage.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateOutbox.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.auditEvent.count({ where: { customerId: f.customerId } }),
  ]);
  const beforeMissing = await counts();
  const missing = await api.updateSuggestions(leader, f.projectId);
  expect(missing).toMatchObject({ availability: "AVAILABLE", completeness: { state: "INCOMPLETE",
    factAssessments: [expect.objectContaining({ state: "MISSING" })] } });
  expect(await counts()).toEqual(beforeMissing);
  const statement = await f.append(f.admin, [leader.subject, f.admin.subject]);
  const beforeUnconfirmed = await counts();
  const unconfirmed = await api.updateSuggestions(leader, f.projectId);
  expect(unconfirmed).toMatchObject({ availability: "AVAILABLE", completeness: {
    factAssessments: [expect.objectContaining({ state: "UNCONFIRMED", sourceAuthorityStatus: "NO_POLICY" })] } });
  expect(await counts()).toEqual(beforeUnconfirmed);
  await f.policy(31_536_000_000);
  const beforeResolved = await counts();
  const resolved = await api.updateSuggestions(leader, f.projectId);
  expect(resolved).toMatchObject({ availability: "AVAILABLE", completeness: { state: "COMPLETE" },
    freshness: { sourceDateField: "project.latestValidUpdateAt" },
    evidence: [expect.objectContaining({ sourceId: statement.entry.sourceId, versionId: statement.entry.id })] });
  expect(await counts()).toEqual(beforeResolved);
  const access = await db.factSourceAccess.findFirstOrThrow({ where: {
    customerId: f.customerId, projectId: f.projectId, sourceId: statement.entry.sourceId } });
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  const gatedDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => operation(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const result = await Reflect.apply(value, target, args);
        const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
        if (sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) { locked(); await gate; }
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } })), options as never) };
  const writer = new DatabaseProjectFactRepository(gatedDatabase as never).setSourceAccess(f.admin, {
    projectId: f.projectId, sourceId: statement.entry.sourceId,
    expectedRevision: access.revision, state: "AVAILABLE", readers: [f.admin.subject],
  }, { correlationId: randomUUID() });
  await Promise.race([ready, writer.then(() => { throw new Error("Writer exited before project lock"); })]);
  const pending = api.updateSuggestions(leader, f.projectId);
  const rejected = expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
  let observedWait = false;
  try {
    for (let attempt = 0; attempt < 100 && !observedWait; attempt++) {
      const waiting = await db.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND pid=$1
         AND wait_event_type='Lock' AND query LIKE '%FROM public."Project"%' AND query LIKE '%FOR SHARE%'`, readerPid,
      );
      observedWait = Number(waiting[0]?.count ?? 0) > 0;
      if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally { release(); }
  await writer;
  await rejected;
  expect(observedWait).toBe(true);
  const beforeDenied = await counts();
  await expect(api.updateSuggestions(leader, f.projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await counts()).toEqual(beforeDenied);
  expect(transactions).toBe(5);
});
it.each([true, false])("reads committed policy and post-wait clock after a supported writer (previously configured: %s)", async (configured) => {
  const f = await fixture(configured);
  const leader: Actor = { customerId: f.customerId, subject: `update-policy-reader-${randomUUID()}`, roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId: f.customerId, subject: leader.subject,
    scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  const gatedDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => operation(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
        const result = await Reflect.apply(value, target, args);
        const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
        if (sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) { locked(); await gate; }
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } })), options as never) };
  const writer = new DatabaseProjectUpdateRepository(gatedDatabase as never).setPolicy(f.admin, f.projectId, {
    expectedRevision: configured ? 1 : 0, freshnessWindowSeconds: 7200, timeZone: "UTC",
    requiredFacts: [{ factType: "project.forecast", label: "Forecast" }], responsibleSubject: "synthetic-owner-4",
    scheduledScanEnabled: false, reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0,
    escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null,
  }, randomUUID());
  await Promise.race([ready, writer.then(() => { throw new Error("Policy writer exited before locking"); })]);
  let readerPid = 0;
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const rows = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
      readerPid = rows[0]!.pid;
      return operation(tx);
    }, options as never) };
  const pending = new DatabaseProjectUpdateRepository(apiDatabase as never).updateSuggestions(leader, f.projectId);
  let observedWait = false;
  try {
    for (let attempt = 0; attempt < 100 && !observedWait; attempt++) {
      const waiting = await db.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND pid=$1
         AND wait_event_type='Lock' AND query LIKE '%FROM public."Project"%' AND query LIKE '%FOR SHARE%'`, readerPid,
      );
      observedWait = Number(waiting[0]?.count ?? 0) > 0;
      if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally { release(); }
  const changed = await writer;
  const result = await pending;
  expect(observedWait).toBe(true);
  expect(result).toMatchObject({ availability: "AVAILABLE", policyRevision: configured ? 2 : 1,
    completeness: { factAssessments: [expect.objectContaining({ factType: "project.forecast", state: "MISSING" })] } });
  expect(Date.parse(result.asOf)).toBeGreaterThanOrEqual(Date.parse(changed.changedAt));
});
it("denies after a concurrent qualifying grant revocation commits", async () => {
  const f = await fixture();
  const leader: Actor = { customerId: f.customerId, subject: `update-grant-reader-${randomUUID()}`, roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId: f.customerId, subject: leader.subject,
    scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  const writer = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('DELETE FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=$2 AND "scopeType"=\'project\' AND "scopeId"=$3::uuid',
      f.customerId, leader.subject, f.projectId);
    locked();
    await gate;
  }, { timeout: 20000 });
  await Promise.race([ready, writer.then(() => { throw new Error("Grant writer exited before locking"); })]);
  let readerPid = 0;
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const rows = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
      readerPid = rows[0]!.pid;
      return operation(tx);
    }, options as never) };
  const pending = new DatabaseProjectUpdateRepository(apiDatabase as never).updateSuggestions(leader, f.projectId);
  const denied = expect(pending).rejects.toMatchObject({ code: "DENIED" });
  let observedWait = false;
  try {
    for (let attempt = 0; attempt < 100 && !observedWait; attempt++) {
      const waiting = await db.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND pid=$1
         AND wait_event_type='Lock' AND query LIKE '%FROM public."AccessGrant"%' AND query LIKE '%FOR SHARE%'`, readerPid,
      );
      observedWait = Number(waiting[0]?.count ?? 0) > 0;
      if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally { release(); }
  await writer;
  await denied;
  expect(observedWait).toBe(true);
});
it("reports an accessible conflict without persisting prepared authority results", async () => {
  const f = await fixture();
  const leader: Actor = { customerId: f.customerId, subject: `update-conflict-reader-${randomUUID()}`, roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId: f.customerId, subject: leader.subject,
    scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  await f.append(f.admin, [f.admin.subject, leader.subject], "First authorized value");
  await f.append(f.writer, [f.admin.subject, leader.subject, f.writer.subject], "Different authorized value");
  await f.policy(31_536_000_000);
  const counts = async () => Promise.all([
    db.factAuthorityConflict.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.factAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectFact.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectFactVersion.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.factEvidence.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateObligation.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdatePreview.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateEngagement.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateStage.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateOutbox.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.auditEvent.count({ where: { customerId: f.customerId } }),
  ]);
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
  const before = await counts();
  expect(before[0]).toBe(0);
  const result = await new DatabaseProjectUpdateRepository(apiDatabase as never).updateSuggestions(leader, f.projectId);
  expect(result).toMatchObject({ availability: "AVAILABLE", completeness: { factAssessments: [
    expect.objectContaining({ state: "UNCONFIRMED", sourceAuthorityStatus: "CONFLICTING", conflict: "CONFLICTING" }),
  ] } });
  expect(JSON.stringify(result)).not.toContain("First authorized value");
  expect(JSON.stringify(result)).not.toContain("Different authorized value");
  expect(await counts()).toEqual(before);
});
it("accepts 1000 versions across two facts and fails closed at 1001 without writes", async () => {
  const f = await fixture();
  const leader: Actor = { customerId: f.customerId, subject: `update-budget-reader-${randomUUID()}`, roles: ["leadership"] };
  await db.accessGrant.create({ data: { customerId: f.customerId, subject: leader.subject,
    scopeType: "project", scopeId: f.projectId, role: "leadership" } });
  const first = await f.append(f.admin, [f.admin.subject, leader.subject]);
  await f.policy(31_536_000_000);
  const fact = await db.projectFact.findFirstOrThrow({ where: { customerId: f.customerId, projectId: f.projectId, factType: f.factType } });
  const evidence = await db.factEvidence.findUniqueOrThrow({ where: { id: first.entry.evidenceId } });
  const secondType = "project.forecast";
  const second = await f.facts.appendHumanStatement(f.admin, {
    projectId: f.projectId, factType: secondType, expectedRevision: 0, idempotencyKey: randomUUID(),
    effectiveAt: evidence.observedAt.toISOString(), value: { type: "text", value: "Private completeness value" },
    originalStatement: "Synthetic budget statement", validUntil: null,
  }, { correlationId: randomUUID() });
  await f.facts.setSourceAccess(f.admin, { projectId: f.projectId, sourceId: second.entry.sourceId,
    expectedRevision: second.entry.sourceAccessRevision, state: "AVAILABLE", readers: [f.admin.subject, leader.subject] },
    { correlationId: randomUUID() });
  await f.authority.appendPolicy(f.admin, {
    projectId: f.projectId, factType: secondType, expectedRevision: 0, idempotencyKey: randomUUID(),
    effectiveAt: evidence.observedAt.toISOString(), definition: { tiers: [{ selectors: [{ sourceType: "human_statement",
      instanceId: null, requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 31_536_000_000 } }] }],
      conflictBehavior: "REQUEST_RECONCILIATION" },
  }, { correlationId: randomUUID() });
  await f.updates.setPolicy(f.admin, f.projectId, { expectedRevision: 1, freshnessWindowSeconds: 1, timeZone: "UTC",
    requiredFacts: [{ factType: f.factType, label: "Current status" }, { factType: secondType, label: "Forecast" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false, reminderBusinessDayOffsets: [],
    escalationAfterBusinessDays: 0, escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null,
  }, randomUUID());
  const secondFact = await db.projectFact.findFirstOrThrow({ where: { customerId: f.customerId, projectId: f.projectId, factType: secondType } });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pg_temp.append_update_budget(fid uuid) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE item record; next_revision integer;
      BEGIN
        SELECT revision+1 INTO next_revision FROM public."ProjectFact" WHERE id=fid;
        FOR item IN SELECT e.* FROM public."FactEvidence" e WHERE e."factId"=fid
          AND NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" v WHERE v."evidenceId"=e.id)
          ORDER BY e."observedAt",e.id LOOP
          INSERT INTO public."ProjectFactVersion" (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,"effectiveAt","validUntil")
          VALUES (gen_random_uuid(),item."customerId",item."projectId",item."factId",item."sourceId",item.id,next_revision,
            jsonb_build_object('type','text','value','Private completeness value'),item."observedAt",NULL);
          next_revision:=next_revision+1;
        END LOOP;
      END $$`);
    for (const item of [{ factId: fact.id, sourceId: first.entry.sourceId }, { factId: secondFact.id, sourceId: second.entry.sourceId }]) {
      await tx.$executeRaw`
        INSERT INTO "FactEvidence" (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
        SELECT gen_random_uuid(),${f.customerId}::uuid,${f.projectId}::uuid,${item.factId}::uuid,${item.sourceId}::uuid,
          ${f.admin.subject},${evidence.observedAt},'Synthetic budget evidence' FROM generate_series(2,500)`;
      await tx.$executeRaw`SELECT pg_temp.append_update_budget(${item.factId}::uuid)`;
    }
  }, { timeout: 60000 });
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never) };
  const api = new DatabaseProjectUpdateRepository(apiDatabase as never);
  const before = await db.factAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } });
  const bounded = await api.updateSuggestions(leader, f.projectId);
  expect(bounded).toMatchObject({ availability: "AVAILABLE", completeness: { factAssessments: expect.arrayContaining([
    expect.objectContaining({ factType: f.factType, canonicalVersionCount: 500 }),
    expect.objectContaining({ factType: secondType, canonicalVersionCount: 500 }),
  ]) } });
  expect(await db.factAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } })).toBe(before);
  await f.append(f.admin, [f.admin.subject, leader.subject]);
  const counts = await Promise.all([
    db.factAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.factAuthorityConflict.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.auditEvent.count({ where: { customerId: f.customerId } }),
  ]);
  await expect(api.updateSuggestions(leader, f.projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await Promise.all([
    db.factAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.factAuthorityConflict.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.projectUpdateAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } }),
    db.auditEvent.count({ where: { customerId: f.customerId } }),
  ])).toEqual(counts);
}, 120000);
async function assertUnresolved(
  f: Fixture,
  count: number,
  reason: string,
  status: string,
) {
  const view = await f.assess();
  expect(view.completeness.factAssessments).toEqual([
    expect.objectContaining({
      factType: f.factType,
      state: "UNCONFIRMED",
      canonicalVersionCount: count,
      sourceAuthorityStatus: status,
      reasonCodes: expect.arrayContaining([reason]),
    }),
  ]);
  expect(view.freshness).toMatchObject({
    state: "STALE",
    sourceDateField: "project.createdAt",
  });
  expect(view.knownPosition).toEqual([]);
  expect(view.obligation?.state).toBe("OPEN");
  expect(view.preview?.requiredFacts).toEqual([
    expect.objectContaining({ state: "UNCONFIRMED" }),
  ]);
  expect(view.preview?.evidence).toEqual([]);
  const saved = await db.projectUpdateAssessment.findFirstOrThrow({
    where: { customerId: f.customerId, projectId: f.projectId },
    orderBy: [{ assessedAt: "desc" }, { id: "desc" }],
  });
  expect(saved.result).toMatchObject({ completeness: view.completeness });
  expect(saved.input).toMatchObject({
    latestValidUpdateAt: null,
    timestampBasis: "UNCONFIRMED",
  });
  expect(saved.result).toMatchObject({
    engagementFacts: [expect.objectContaining({ state: "UNRESOLVED" })],
  });
  expect(Object.keys(saved.result as object).sort()).toEqual([
    "completeness",
    "engagementFacts",
    "freshness",
  ]);
  expect(saved.dependencies).toEqual([]);
  const savedPreview = await db.projectUpdatePreview.findUniqueOrThrow({
    where: { id: view.preview!.id },
  });
  expect(savedPreview.preview).toEqual(view.preview);
  expect(savedPreview.preview).toMatchObject({ evidence: [] });
  for (const content of [
    view,
    saved.input,
    saved.result,
    saved.dependencies,
    savedPreview.preview,
  ]) {
    const serialized = JSON.stringify(content);
    expect(serialized).not.toMatch(/private completeness/i);
    for (const reference of f.statementReferences)
      expect(serialized).not.toContain(reference);
  }
  expect((await f.updates.latest(f.admin, f.projectId))?.completeness).toEqual(
    view.completeness,
  );
  const repeated = await f.assess();
  expect(repeated.obligation?.id).toBe(view.obligation?.id);
  expect(
    await db.projectUpdateObligation.count({
      where: {
        customerId: f.customerId,
        projectId: f.projectId,
        state: "OPEN",
      },
    }),
  ).toBe(1);
  return view;
}

it("keeps existing readable evidence without policy unconfirmed instead of missing", async () => {
  const f = await fixture();
  await f.append();
  await assertUnresolved(f, 1, "NO_APPLICABLE_AUTHORITY_POLICY", "NO_POLICY");
});

it("keeps expired readable evidence unconfirmed without freshness or satisfaction credit", async () => {
  const f = await fixture();
  await f.append();
  await f.policy(1000);
  await assertUnresolved(f, 1, "NO_CURRENT_AUTHORIZED_VALUE", "UNKNOWN");
});

it("counts no restricted-only evidence and preserves source revalidation", async () => {
  const f = await fixture();
  const statement = await f.append(f.writer, [f.writer.subject]);
  const view = await assertUnresolved(
    f,
    0,
    "SOURCE_REVALIDATION_REQUIRED",
    "REVALIDATION_REQUIRED",
  );
  expect(JSON.stringify(view)).not.toContain(statement.entry.sourceId);
  expect(JSON.stringify(view)).not.toContain(statement.entry.id);
});

it("counts only the readable part of mixed readable and restricted evidence", async () => {
  const f = await fixture();
  await f.append();
  const hidden = await f.append(
    f.writer,
    [f.writer.subject],
    "Different private completeness value",
  );
  const view = await assertUnresolved(
    f,
    1,
    "SOURCE_REVALIDATION_REQUIRED",
    "REVALIDATION_REQUIRED",
  );
  expect(JSON.stringify(view)).not.toContain(hidden.entry.sourceId);
  expect(JSON.stringify(view)).not.toContain(hidden.entry.id);
});

it("retains an expired recorded conflict without inventing zero-count authority input", async () => {
  const f = await fixture();
  await f.append();
  await f.append(
    f.writer,
    [f.admin.subject, f.writer.subject],
    "Different private completeness value",
  );
  await f.policy(31_536_000_000);
  // Preparing a project-update view calculates conflicts without publishing an
  // authority assessment. Persist the recorded conflict through its real API.
  const captured = await f.authority.captureAssessment(
    f.admin,
    {
      projectId: f.projectId,
      factType: f.factType,
      idempotencyKey: randomUUID(),
    },
    { correlationId: randomUUID() },
  );
  expect(captured).toMatchObject({
    visibility: "available",
    result: { status: "CONFLICTING" },
  });
  const initial = await f.assess();
  expect(initial.completeness.factAssessments[0]).toMatchObject({
    state: "UNCONFIRMED",
    canonicalVersionCount: 2,
    conflict: "CONFLICTING",
  });
  expect(
    await db.factAuthorityConflict.count({
      where: {
        customerId: f.customerId,
        projectId: f.projectId,
      },
    }),
  ).toBeGreaterThan(0);
  await f.policy(1000, 1);
  const view = await assertUnresolved(
    f,
    2,
    "CONFLICTING_AUTHORITY",
    "CONFLICTING",
  );
  expect(view.completeness.factAssessments[0]?.conflict).toBe("CONFLICTING");
});

it("keeps historical metadata immutable after revocation while a new assessment excludes the evidence", async () => {
  const f = await fixture();
  const statement = await f.append();
  await f.policy(31_536_000_000);
  const initial = await f.assess();
  expect(initial.completeness.factAssessments[0]).toMatchObject({
    state: "CONFIRMED",
    canonicalVersionCount: 1,
  });
  expect(initial.knownPosition).toHaveLength(1);
  const before = await db.projectUpdateAssessment.findFirstOrThrow({
    where: { customerId: f.customerId, projectId: f.projectId },
  });
  const access = await f.facts.getSourceAccess(f.admin, {
    projectId: f.projectId,
    sourceId: statement.entry.sourceId,
  });
  if (!access) throw new Error("Expected source access fixture");
  await f.facts.setSourceAccess(
    f.admin,
    {
      projectId: f.projectId,
      sourceId: statement.entry.sourceId,
      expectedRevision: access.revision,
      state: "AVAILABLE",
      readers: [f.writer.subject],
    },
    { correlationId: randomUUID() },
  );
  const historical = await f.updates.latest(f.admin, f.projectId);
  expect(historical?.completeness).toEqual(initial.completeness);
  expect(historical?.knownPosition).toEqual([]);
  expect(historical?.preview?.evidence).toEqual([]);
  expect(JSON.stringify(historical)).not.toMatch(/private completeness/i);
  for (const reference of f.statementReferences)
    expect(JSON.stringify(historical)).not.toContain(reference);
  await assertUnresolved(
    f,
    0,
    "SOURCE_REVALIDATION_REQUIRED",
    "REVALIDATION_REQUIRED",
  );
  expect(
    await db.projectUpdateAssessment.findUniqueOrThrow({
      where: { id: before.id },
    }),
  ).toEqual(before);
});

it("keeps a defined but empty fact and an absent fact missing", async () => {
  const f = await fixture();
  // Creating only a canonical fact definition adds no evidence or value version.
  await db.projectFact.create({
    data: {
      id: randomUUID(),
      customerId: f.customerId,
      projectId: f.projectId,
      factType: f.factType,
      revision: 0,
    },
  });
  const view = await f.assess();
  expect(view.completeness.factAssessments[0]).toMatchObject({
    state: "MISSING",
    canonicalVersionCount: 0,
    reasonCodes: ["NO_CANONICAL_VALUE"],
  });
  const absent = await fixture();
  expect((await absent.assess()).completeness.factAssessments[0]).toMatchObject(
    {
      state: "MISSING",
      canonicalVersionCount: 0,
      reasonCodes: ["NO_CANONICAL_VALUE"],
    },
  );
});

it("denies project and unconfigured service identities without assessment or obligation writes", async () => {
  const f = await fixture();
  await f.append();
  const outsider: Actor = {
    customerId: f.customerId,
    subject: "outside-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await expect(
    f.updates.assess(outsider, f.projectId, randomUUID()),
  ).rejects.toMatchObject({ code: "DENIED" });
  await expect(f.updates.scanScheduledProjects(1)).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
  expect(
    await db.projectUpdateAssessment.count({
      where: { customerId: f.customerId, projectId: f.projectId },
    }),
  ).toBe(0);
  expect(
    await db.projectUpdateObligation.count({
      where: { customerId: f.customerId, projectId: f.projectId },
    }),
  ).toBe(0);
});
