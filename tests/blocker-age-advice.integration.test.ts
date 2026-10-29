// EXEC-027: run only against the separately qualified disposable synthetic target.
import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, DatabaseAuthorityRepository, DatabaseBlockerAgeAdviceRepository, DatabaseCanonicalProjectRepository,
  DatabaseHealthAssessmentRepository, DatabasePmActionQueueRepository, DatabaseProjectFactRepository, DatabaseProjectRepository } from "../packages/data/dist/index.js";
import { canonicalProjectCreateSchema, type Actor, type AuthorityDefinition } from "../packages/domain/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import { possibleMutation, rawSqlText } from "./fixtures/read-only-sql.js";
import * as blockerAssessment from "../packages/data/dist/blocker-age-assessment.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
    new URL(url).hostname !== "127.0.0.1" || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Blocker advice checks require a separately qualified disposable synthetic database");
const db = createDatabase(url);
afterAll(async () => { await db.$disconnect(); });

it("reads current source-authorized blocker review under the API role and withholds revoked evidence", async () => {
  const customerId = randomUUID(), portfolioId = randomUUID();
  const admin: Actor = { customerId, subject: `blocker-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  const pm: Actor = { customerId, subject: `blocker-pm-${randomUUID()}`, roles: ["project_manager"] };
  const leader: Actor = { customerId, subject: `blocker-leader-${randomUUID()}`, roles: ["leadership"] };
  await db.customer.create({ data: { id: customerId, name: "Synthetic blocker advice customer" } });
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic blocker advice portfolio" } });
  await db.accessGrant.createMany({ data: [
    { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" },
    { customerId, subject: pm.subject, scopeType: "portfolio", scopeId: portfolioId, role: "project_manager" },
    { customerId, subject: leader.subject, scopeType: "portfolio", scopeId: portfolioId, role: "leadership" },
  ] });
  const input = canonicalFixture(portfolioId);
  input.responsibilities = input.responsibilities.map((item) => item.role === "PROJECT_MANAGER" ? { ...item, subject: pm.subject } : item);
  input.raidItems = input.raidItems.map((item, index) => ({ ...item, state: index === 0 ? "OPEN" : "COMPLETE" }));
  const projectId = (await new DatabaseCanonicalProjectRepository(db).createProject(admin, canonicalProjectCreateSchema.parse(input), randomUUID())).id;
  const health = new DatabaseHealthAssessmentRepository(db);
  await health.setBlockerAgeThresholdPolicy(admin, { expectedRevision: 0, minimumBlockerAgeDays: 5, auditRetentionHours: 720 }, randomUUID());
  const raid = await db.raidItem.findFirstOrThrow({ where: { customerId, projectId, state: "OPEN" } });
  const [{ now }] = await db.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
  const effectiveAt = new Date(now!.getTime() - 60_000).toISOString(), openedAt = new Date(now!.getTime() - 10 * 86400000).toISOString().slice(0, 10);
  const current: AuthorityDefinition = { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
    requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 86400000 } }] }], conflictBehavior: "REQUEST_RECONCILIATION" };
  const ongoing: AuthorityDefinition = { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
    requiredApproval: "NOT_REQUIRED", validity: { mode: "UNTIL_SUPERSEDED" } }] }], conflictBehavior: "REQUEST_RECONCILIATION" };
  const authority = new DatabaseAuthorityRepository(db), facts = new DatabaseProjectFactRepository(db), context = { correlationId: randomUUID() };
  async function add(factType: string, value: { type: "boolean"; value: boolean } | { type: "date"; value: string }, definition: AuthorityDefinition) {
    const policy = await authority.appendPolicy(admin, { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt, definition }, context);
    const statement = await facts.appendHumanStatement(admin, { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(),
      value, effectiveAt, validUntil: null, originalStatement: "Synthetic current blocker evidence." }, context);
    const access = await facts.setSourceAccess(admin, { projectId, sourceId: statement.entry.sourceId,
      expectedRevision: statement.entry.sourceAccessRevision, state: "AVAILABLE", readers: [admin.subject, pm.subject, leader.subject] }, context);
    return { access, statement, policy: policy.event };
  }
  const inventory = await add("project.open_blocker_inventory_complete", { type: "boolean", value: true }, current);
  const classification = await add(`raid_item.${raid.id}.blocks_delivery`, { type: "boolean", value: true }, current);
  const opened = await add(`raid_item.${raid.id}.opened_at`, { type: "date", value: openedAt }, ongoing);
  await health.setRetention(admin, { contentRetentionHours: 24, auditRetentionHours: 48, idempotencyRetentionHours: 72 }, randomUUID());
  const saved = await health.create(pm, projectId, "synthetic-blocker-saved", randomUUID());
  expect(saved).toMatchObject({ contentAvailable: true, blockerAgeCoverage: "COMPLETE" });
  const writes: string[] = [];
  const inspectSql = (sql: string) => {
    if (possibleMutation(sql)) {
      writes.push(sql); throw new Error("Unexpected mutation in blocker advice read");
    }
  };
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect((await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role"))[0]?.role).toBe("pdaa_api");
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if ((key === "$queryRawUnsafe" || key === "$queryRaw" || key === "$executeRawUnsafe" || key === "$executeRaw") && typeof value === "function")
          return async (...args: unknown[]) => {
            const sql = rawSqlText(args[0]);
            if (String(key).startsWith("$execute") && !/^SET LOCAL (?:statement_timeout|lock_timeout)=/.test(sql)) {
              writes.push(sql); throw new Error("Unexpected execute in blocker advice read");
            }
            inspectSql(sql); return Reflect.apply(value, target, args);
          };
        if (value && typeof value === "object" && typeof key === "string" && !key.startsWith("$"))
          return new Proxy(value, { get(model, method) {
            const operation = Reflect.get(model, method);
            if (typeof operation === "function" && /^(?:create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(String(method)))
              return () => { writes.push(`${key}.${String(method)}`); throw new Error("Unexpected ORM mutation in blocker advice read"); };
            return typeof operation === "function" ? operation.bind(model) : operation;
          } });
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const queue = new DatabasePmActionQueueRepository(apiDatabase as never), leadership = new DatabaseBlockerAgeAdviceRepository(apiDatabase as never);
  const tables = ["Project", "AccessGrant", "CanonicalProject", "ProjectResponsibility", "RaidItem", "BlockerAgeThresholdPolicy",
    "AuditEvent", "HealthAssessment", "HealthAssessmentCommandReceipt", "FactAuthorityConflict", "FactAssessment", "FactAssessmentVersion", "FactAssessmentConflict", "ProjectFact", "ProjectFactVersion",
    "FactEvidence", "FactSource", "FactSourceAccess", "FactSourceReader", "FactAppendReceipt", "AuthorityPolicy", "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt", "ProjectUpdateAssessment", "ProjectUpdateObligation", "ProjectUpdatePreview", "ProjectUpdateEngagement",
    "ProjectUpdateStage", "ProjectUpdateOutbox"];
  async function snapshot() {
    return Promise.all(tables.map((table) => db.$queryRawUnsafe(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${table}" t WHERE t."customerId"=$1::uuid`, customerId)));
  }
  const before = await snapshot();
  const pmResult = await queue.read(pm), leaderResult = await leadership.readLeadership(leader, projectId);
  expect(pmResult.projects).toHaveLength(1);
  const pmFacet = pmResult.projects[0]!.blockerAge;
  const calendarAge = (asOf: string) => (Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - Date.parse(`${openedAt}T00:00:00Z`)) / 86400000;
  expect(pmFacet).toMatchObject({ coverage: "COMPLETE", items: [{ raidItemId: raid.id, ageDays: calendarAge(pmFacet.asOf) }] });
  expect(calendarAge(pmFacet.asOf)).toBeGreaterThanOrEqual(5);
  expect(leaderResult).toMatchObject({ audience: "leadership", coverage: "COMPLETE", items: [{ raidItemId: raid.id }] });
  expect(leaderResult.items[0]!.ageDays).toBe(calendarAge(leaderResult.asOf));
  expect(leaderResult.items[0]!.suggestedAction).toContain("intervention");
  const proof = (created: typeof inventory) => ({ factId: created.statement.factId, policyId: created.policy.policyId,
    policyRevisionId: created.policy.id, policyRevision: created.policy.revision,
    supports: [{ versionId: created.statement.entry.id, evidenceId: created.statement.entry.evidenceId,
      sourceId: created.statement.entry.sourceId, accessRevision: created.access.revision }] });
  expect(leaderResult.inventory).toMatchObject(proof(inventory));
  expect(leaderResult.items[0]!.classification).toMatchObject(proof(classification));
  expect(leaderResult.items[0]!.openedAtProof).toMatchObject(proof(opened));
  await expect(leadership.readLeadership({ ...pm, roles: ["project_manager", "leadership"] }, projectId)).rejects.toMatchObject({ code: "DENIED" });
  expect(await snapshot()).toEqual(before);
  expect(writes).toEqual([]);
  await health.setBlockerAgeThresholdPolicy(admin, { expectedRevision: 1, minimumBlockerAgeDays: 3650, auditRetentionHours: 720 }, randomUUID());
  const revised = await leadership.readLeadership(leader, projectId);
  expect(revised).toMatchObject({ coverage: "COMPLETE", threshold: { minimumBlockerAgeDays: 3650, revision: 2 }, noOpenBlockers: false, items: [] });
  const historical = await health.latest(pm, projectId);
  expect(historical).toMatchObject({ assessmentId: saved.assessmentId, contentAvailable: true, input: saved.input, result: saved.result });
  const revoked = await facts.setSourceAccess(admin, { projectId, sourceId: classification.access.sourceId, expectedRevision: classification.access.revision,
    state: "AVAILABLE", readers: [admin.subject] }, context);
  const hidden = await leadership.readLeadership(leader, projectId);
  expect(hidden).toMatchObject({ coverage: "UNASSESSABLE", inventory: null, items: [], noOpenBlockers: null });
  for (const id of [classification.statement.factId, classification.statement.entry.id, classification.statement.entry.evidenceId,
    classification.statement.entry.sourceId]) expect(JSON.stringify(hidden)).not.toContain(id);
  const restrictedQueue = await queue.read(pm);
  expect(restrictedQueue.projects[0]!.blockerAge).toMatchObject({ coverage: "UNASSESSABLE", items: [] });
  for (const id of [classification.statement.factId, classification.statement.entry.id, classification.statement.entry.evidenceId,
    classification.statement.entry.sourceId]) expect(JSON.stringify(restrictedQueue)).not.toContain(id);
  expect(restrictedQueue.projects[0]!.schedule.audience).toBe("project_manager");
  expect(await health.latest(pm, projectId)).toMatchObject({ assessmentId: saved.assessmentId, contentAvailable: false, input: null, result: null });
  // With both actors restored, exercise both supported source-access lock orders.
  await health.setBlockerAgeThresholdPolicy(admin, { expectedRevision: 2, minimumBlockerAgeDays: 5, auditRetentionHours: 720 }, randomUUID());
  let restored = await facts.setSourceAccess(admin, { projectId, sourceId: classification.access.sourceId, expectedRevision: revoked.revision,
    state: "AVAILABLE", readers: [admin.subject, pm.subject, leader.subject] }, context);
  expect((await leadership.readLeadership(leader, projectId)).items[0]!.classification).toMatchObject({
    ...proof(classification), supports: [{ ...proof(classification).supports[0], accessRevision: restored.revision }] });
  async function isBlocked(waiting: number, blocking: number, requiredQuery: string[]) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && requiredQuery.every((part) => rows[0]!.query.includes(part))) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  let writerPid = 0, readerPid = 0, announceWriter!: () => void, announceReader!: () => void, releaseWriter!: () => void;
  const writerReady = new Promise<void>((resolve) => { announceWriter = resolve; });
  const readerReady = new Promise<void>((resolve) => { announceReader = resolve; });
  const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let writerPaused = false;
  const gatedWriterDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
          if (!writerPaused && sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) {
            writerPaused = true; announceWriter(); await writerGate;
          }
          return result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const startedReaderDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      announceReader(); return operation(tx);
    }, options as never) };
  const writer = new DatabaseProjectFactRepository(gatedWriterDb as never).setSourceAccess(admin, { projectId,
    sourceId: classification.access.sourceId, expectedRevision: restored.revision, state: "AVAILABLE", readers: [admin.subject] }, context);
  void writer.catch(() => {});
  let reader: ReturnType<DatabaseBlockerAgeAdviceRepository["readLeadership"]> | undefined, writerFirstBlocked = false;
  try {
    await Promise.race([writerReady, writer.then(() => { throw new Error("Writer exited before lock barrier"); })]);
    reader = new DatabaseBlockerAgeAdviceRepository(startedReaderDb as never).readLeadership(leader, projectId); void reader.catch(() => {});
    await Promise.race([readerReady, reader.then(() => { throw new Error("Reader exited before lock barrier"); })]);
    writerFirstBlocked = await isBlocked(readerPid, writerPid, ['SELECT id,"portfolioId" FROM public."Project"', "FOR SHARE"]);
  } finally { releaseWriter(); await Promise.allSettled(reader ? [writer, reader] : [writer]); }
  expect(writerFirstBlocked).toBe(true);
  const writerResult = await writer;
  expect(await reader).toMatchObject({ coverage: "UNASSESSABLE", items: [], inventory: null });
  expect(await db.factSourceReader.count({ where: { customerId, projectId, sourceId: classification.access.sourceId, subject: leader.subject } })).toBe(0);
  restored = await facts.setSourceAccess(admin, { projectId, sourceId: classification.access.sourceId, expectedRevision: writerResult.revision,
    state: "AVAILABLE", readers: [admin.subject, pm.subject, leader.subject] }, context);
  expect((await leadership.readLeadership(leader, projectId)).items[0]!.classification).toMatchObject({
    ...proof(classification), supports: [{ ...proof(classification).supports[0], accessRevision: restored.revision }] });
  let heldPid = 0, lateWriterPid = 0, announceHeld!: () => void, announceLateWriter!: () => void, releaseHeld!: () => void;
  const heldReady = new Promise<void>((resolve) => { announceHeld = resolve; });
  const lateWriterReady = new Promise<void>((resolve) => { announceLateWriter = resolve; });
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let readerPaused = false;
  const heldReaderDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      heldPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
          if (!readerPaused && sql.includes('SELECT id,"portfolioId" FROM public."Project"') && sql.includes("FOR SHARE")) {
            readerPaused = true; announceHeld(); await heldGate;
          }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const startedWriterDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      lateWriterPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      announceLateWriter(); return operation(tx);
    }, options as never) };
  const heldRead = new DatabaseBlockerAgeAdviceRepository(heldReaderDb as never).readLeadership(leader, projectId); void heldRead.catch(() => {});
  let laterWriter: ReturnType<DatabaseProjectFactRepository["setSourceAccess"]> | undefined, readerFirstBlocked = false;
  try {
    await Promise.race([heldReady, heldRead.then(() => { throw new Error("Reader exited before lock barrier"); })]);
    laterWriter = new DatabaseProjectFactRepository(startedWriterDb as never).setSourceAccess(admin, { projectId,
      sourceId: classification.access.sourceId, expectedRevision: restored.revision, state: "AVAILABLE", readers: [admin.subject] }, context);
    void laterWriter.catch(() => {});
    await Promise.race([lateWriterReady, laterWriter.then(() => { throw new Error("Writer exited before lock barrier"); })]);
    readerFirstBlocked = await isBlocked(lateWriterPid, heldPid, ['FROM "Project"', "FOR UPDATE"]);
  } finally { releaseHeld(); await Promise.allSettled(laterWriter ? [heldRead, laterWriter] : [heldRead]); }
  expect(readerFirstBlocked).toBe(true);
  const heldResult = await heldRead;
  expect(heldResult).toMatchObject({ coverage: "COMPLETE", items: [{ raidItemId: raid.id }] });
  expect(heldResult.items[0]!.classification).toMatchObject({ ...proof(classification),
    supports: [{ ...proof(classification).supports[0], accessRevision: restored.revision }] });
  await laterWriter;
  expect(await db.factSourceReader.count({ where: { customerId, projectId, sourceId: classification.access.sourceId, subject: leader.subject } })).toBe(0);
  expect(await leadership.readLeadership(leader, projectId)).toMatchObject({ coverage: "UNASSESSABLE", items: [] });
  // Repeat the two lock orders for the customer-wide threshold gate. This
  // writer does not take Project UPDATE, so the advisory gate is essential.
  const lateResult = await laterWriter;
  restored = await facts.setSourceAccess(admin, { projectId, sourceId: classification.access.sourceId, expectedRevision: lateResult!.revision,
    state: "AVAILABLE", readers: [admin.subject, pm.subject, leader.subject] }, context);
  expect((await leadership.readLeadership(leader, projectId)).items[0]!.classification).toMatchObject({
    ...proof(classification), supports: [{ ...proof(classification).supports[0], accessRevision: restored.revision }] });
  let thresholdWriterPid = 0, thresholdReaderPid = 0, signalThresholdWriter!: () => void, signalThresholdReader!: () => void, releaseThresholdWriter!: () => void;
  const thresholdWriterReady = new Promise<void>((resolve) => { signalThresholdWriter = resolve; });
  const thresholdReaderReady = new Promise<void>((resolve) => { signalThresholdReader = resolve; });
  const thresholdWriterGate = new Promise<void>((resolve) => { releaseThresholdWriter = resolve; });
  let thresholdWriterPaused = false;
  const thresholdWriterDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      thresholdWriterPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
          if (!thresholdWriterPaused && sql.includes("pg_advisory_xact_lock(") && args[0] === "blocker-age-threshold:" + customerId) {
            thresholdWriterPaused = true; signalThresholdWriter(); await thresholdWriterGate;
          }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const thresholdReaderDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      thresholdReaderPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      signalThresholdReader(); return operation(tx);
    }, options as never) };
  const thresholdWriter = new DatabaseHealthAssessmentRepository(thresholdWriterDb as never).setBlockerAgeThresholdPolicy(admin,
    { expectedRevision: 3, minimumBlockerAgeDays: 3650, auditRetentionHours: 720 }, randomUUID());
  void thresholdWriter.catch(() => {});
  let thresholdReader: ReturnType<DatabaseBlockerAgeAdviceRepository["readLeadership"]> | undefined, thresholdWriterFirstBlocked = false;
  try {
    await Promise.race([thresholdWriterReady, thresholdWriter.then(() => { throw new Error("Threshold writer exited before barrier"); })]);
    thresholdReader = new DatabaseBlockerAgeAdviceRepository(thresholdReaderDb as never).readLeadership(leader, projectId); void thresholdReader.catch(() => {});
    await Promise.race([thresholdReaderReady, thresholdReader.then(() => { throw new Error("Threshold reader exited before barrier"); })]);
    thresholdWriterFirstBlocked = await isBlocked(thresholdReaderPid, thresholdWriterPid, ["pg_advisory_xact_lock_shared"]);
  } finally { releaseThresholdWriter(); await Promise.allSettled(thresholdReader ? [thresholdWriter, thresholdReader] : [thresholdWriter]); }
  expect(thresholdWriterFirstBlocked).toBe(true); await thresholdWriter;
  expect(await thresholdReader).toMatchObject({ coverage: "COMPLETE", threshold: { revision: 4, minimumBlockerAgeDays: 3650 }, items: [], noOpenBlockers: false });
  let heldThresholdPid = 0, laterThresholdPid = 0, signalHeldThreshold!: () => void, signalLaterThreshold!: () => void, releaseHeldThreshold!: () => void;
  const heldThresholdReady = new Promise<void>((resolve) => { signalHeldThreshold = resolve; });
  const laterThresholdReady = new Promise<void>((resolve) => { signalLaterThreshold = resolve; });
  const heldThresholdGate = new Promise<void>((resolve) => { releaseHeldThreshold = resolve; });
  let heldThresholdPaused = false;
  const heldThresholdDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      heldThresholdPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
          if (!heldThresholdPaused && sql.includes("pg_advisory_xact_lock_shared") && args[0] === "blocker-age-threshold:" + customerId) {
            heldThresholdPaused = true; signalHeldThreshold(); await heldThresholdGate;
          }
          return result;
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const laterThresholdDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      laterThresholdPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      signalLaterThreshold(); return operation(tx);
    }, options as never) };
  const heldThresholdRead = new DatabaseBlockerAgeAdviceRepository(heldThresholdDb as never).readLeadership(leader, projectId); void heldThresholdRead.catch(() => {});
  let laterThresholdWriter: ReturnType<DatabaseHealthAssessmentRepository["setBlockerAgeThresholdPolicy"]> | undefined, thresholdReaderFirstBlocked = false;
  try {
    await Promise.race([heldThresholdReady, heldThresholdRead.then(() => { throw new Error("Threshold reader exited before barrier"); })]);
    laterThresholdWriter = new DatabaseHealthAssessmentRepository(laterThresholdDb as never).setBlockerAgeThresholdPolicy(admin,
      { expectedRevision: 4, minimumBlockerAgeDays: 5, auditRetentionHours: 720 }, randomUUID()); void laterThresholdWriter.catch(() => {});
    await Promise.race([laterThresholdReady, laterThresholdWriter.then(() => { throw new Error("Threshold writer exited before barrier"); })]);
    thresholdReaderFirstBlocked = await isBlocked(laterThresholdPid, heldThresholdPid, ["pg_advisory_xact_lock("]);
  } finally { releaseHeldThreshold(); await Promise.allSettled(laterThresholdWriter ? [heldThresholdRead, laterThresholdWriter] : [heldThresholdRead]); }
  expect(thresholdReaderFirstBlocked).toBe(true);
  expect(await heldThresholdRead).toMatchObject({ coverage: "COMPLETE", threshold: { revision: 4, minimumBlockerAgeDays: 3650 }, items: [] });
  await laterThresholdWriter;
  expect(await leadership.readLeadership(leader, projectId)).toMatchObject({ coverage: "COMPLETE", threshold: { revision: 5, minimumBlockerAgeDays: 5 },
    items: [{ raidItemId: raid.id }] });
  // Policy changes are supported project writers. Exercise both orders using
  // the actual project-row blocker, then restore the active policy.
  const classificationType = `raid_item.${raid.id}.blocks_delivery`;
  async function policyRace(writerFirst: boolean, expectedRevision: number) {
    let policyWriterPid = 0, policyReaderPid = 0, signalHeld!: () => void, signalStarted!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; }); let paused = false;
    const writerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        policyWriterPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (!writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
            const result = await Reflect.apply(value, target, args), sql = rawSqlText(args[0]);
            if (writerFirst && !paused && sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) {
              paused = true; signalHeld(); await gate;
            }
            return result;
          };
          return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const readerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        policyReaderPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
            const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
            if (!writerFirst && !paused && sql.includes('SELECT id,"portfolioId" FROM public."Project"') && sql.includes("FOR SHARE")) {
              paused = true; signalHeld(); await gate;
            }
            return result;
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const write = () => new DatabaseAuthorityRepository(writerDb as never).appendPolicy(admin, { projectId, factType: classificationType,
      expectedRevision, idempotencyKey: randomUUID(), effectiveAt, definition: null }, context);
    const read = () => new DatabaseBlockerAgeAdviceRepository(readerDb as never).readLeadership(leader, projectId);
    const first = writerFirst ? write() : read(); void first.catch(() => {});
    let second: ReturnType<typeof write> | ReturnType<typeof read> | undefined, blocked = false;
    try {
      await Promise.race([held, first.then(() => { throw new Error("First policy operation exited before barrier"); })]);
      second = writerFirst ? read() : write(); void second.catch(() => {});
      await Promise.race([started, second.then(() => { throw new Error("Second policy operation exited before barrier"); })]);
      blocked = writerFirst ? await isBlocked(policyReaderPid, policyWriterPid, ['SELECT id,"portfolioId" FROM public."Project"', "FOR SHARE"]) :
        await isBlocked(policyWriterPid, policyReaderPid, ['FROM "Project"', "FOR UPDATE"]);
    } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
    expect(blocked).toBe(true);
    const firstResult = await first, secondResult = await second, result = writerFirst ? secondResult : firstResult;
    const written = (writerFirst ? firstResult : secondResult) as Awaited<ReturnType<typeof write>>;
    expect(written.event).toMatchObject({ state: "DISABLED", revision: expectedRevision + 1 });
    if (writerFirst) expect(result).toMatchObject({ coverage: "UNASSESSABLE", noOpenBlockers: null, items: [] });
    else expect(result).toMatchObject({ coverage: "COMPLETE", items: [{ raidItemId: raid.id,
      classification: { policyRevision: expectedRevision } }] });
    expect(await leadership.readLeadership(leader, projectId)).toMatchObject({ coverage: "UNASSESSABLE", items: [] });
    expect(await health.latest(pm, projectId)).toMatchObject({ assessmentId: saved.assessmentId, contentAvailable: true,
      input: saved.input, result: saved.result });
    const reenabled = await authority.appendPolicy(admin, { projectId, factType: classificationType, expectedRevision: expectedRevision + 1,
      idempotencyKey: randomUUID(), effectiveAt, definition: current }, context);
    expect(reenabled.event).toMatchObject({ state: "ENABLED", revision: expectedRevision + 2 });
    expect(await leadership.readLeadership(leader, projectId)).toMatchObject({ coverage: "COMPLETE", items: [{ raidItemId: raid.id,
      classification: { policyRevision: expectedRevision + 2 } }] });
  }
  await policyRace(true, 1);
  await policyRace(false, 3);
  // Hold a supported project gate beyond the configured lock deadline and
  // confirm timeout is generic; a fresh read succeeds after release.
  let timeoutWriterPid = 0, timeoutReaderPid = 0, announceTimeoutLock!: () => void, announceTimeoutReader!: () => void, releaseTimeout!: () => void;
  const timeoutLocked = new Promise<void>((resolve) => { announceTimeoutLock = resolve; });
  const timeoutStarted = new Promise<void>((resolve) => { announceTimeoutReader = resolve; });
  const timeoutGate = new Promise<void>((resolve) => { releaseTimeout = resolve; });
  let holderFinished = false;
  const lockHolder = db.$transaction(async (tx) => {
    timeoutWriterPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
    await tx.$queryRawUnsafe('SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR UPDATE', customerId, projectId);
    announceTimeoutLock(); await timeoutGate;
  }, { timeout: 10000 });
  void lockHolder.catch(() => {});
  void lockHolder.then(() => { holderFinished = true; }, () => { holderFinished = true; });
  const timeoutDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      timeoutReaderPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
      announceTimeoutReader(); return operation(tx);
    }, options as never) };
  let timedRead: ReturnType<DatabaseBlockerAgeAdviceRepository["readLeadership"]> | undefined;
  try {
    await Promise.race([timeoutLocked, lockHolder.then(() => { throw new Error("Project lock exited before timeout test"); })]);
    const startedAt = Date.now();
    timedRead = new DatabaseBlockerAgeAdviceRepository(timeoutDb as never).readLeadership(leader, projectId); void timedRead.catch(() => {});
    await Promise.race([timeoutStarted, timedRead.then(() => { throw new Error("Read exited before timeout test"); })]);
    expect(await isBlocked(timeoutReaderPid, timeoutWriterPid, ['SELECT id,"portfolioId" FROM public."Project"', "FOR SHARE"])).toBe(true);
    await expect(timedRead).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
    expect(holderFinished).toBe(false); expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2500);
  } finally { releaseTimeout(); await Promise.allSettled(timedRead ? [lockHolder, timedRead] : [lockHolder]); }
  await expect(lockHolder).resolves.toBeUndefined();
  expect(await leadership.readLeadership(leader, projectId)).toMatchObject({ coverage: "COMPLETE", items: [{ raidItemId: raid.id }] });
  // Supported grant revocation does not acquire Project UPDATE. Verify the
  // explicit positive grant row lock in both queue/read orders.
  const grants = new DatabaseProjectRepository(db);
  const grantScope = { subject: pm.subject, scopeType: "portfolio" as const, scopeId: portfolioId };
  async function grantRace(writerFirst: boolean) {
    let grantWriterPid = 0, queuePid = 0, signalHeld!: () => void, signalStarted!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; }); let paused = false;
    const writerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        grantWriterPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (!writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "accessGrant") return new Proxy(value, { get(model, method) {
            const fn = Reflect.get(model, method);
            if (writerFirst && method === "deleteMany") return async (...args: unknown[]) => {
              const result = await Reflect.apply(fn, model, args);
              if (!paused) { paused = true; signalHeld(); await gate; }
              return result;
            };
            return typeof fn === "function" ? fn.bind(model) : fn;
          } });
          return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const queueDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        queuePid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
            const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
            if (!writerFirst && !paused && sql.includes('SELECT id FROM public."AccessGrant"') && sql.includes("FOR SHARE") && args[2] === projectId) {
              expect(result.length).toBeGreaterThan(0); paused = true; signalHeld(); await gate;
            }
            return result;
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const write = () => new DatabaseProjectRepository(writerDb as never).revokeGrant(admin, grantScope, randomUUID());
    const read = () => new DatabasePmActionQueueRepository(queueDb as never).read(pm);
    const first = writerFirst ? write() : read(); void first.catch(() => {});
    let second: ReturnType<typeof write> | ReturnType<typeof read> | undefined, blocked = false;
    try {
      await Promise.race([held, first.then(() => { throw new Error("First grant operation exited before barrier"); })]);
      second = writerFirst ? read() : write(); void second.catch(() => {});
      await Promise.race([started, second.then(() => { throw new Error("Second grant operation exited before barrier"); })]);
      blocked = writerFirst ? await isBlocked(queuePid, grantWriterPid, ['FROM public."AccessGrant"', "FOR SHARE"]) :
        await isBlocked(grantWriterPid, queuePid, ["DELETE", "AccessGrant"]);
    } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
    expect(blocked).toBe(true);
    if (writerFirst) await expect(second).rejects.toMatchObject({ code: "UNAVAILABLE" });
    else expect(await first).toMatchObject({ projects: [{ projectId, blockerAge: { coverage: "COMPLETE", items: [{ raidItemId: raid.id }] } }] });
    await expect(writerFirst ? first : second).resolves.toBeUndefined();
    expect((await queue.read(pm)).projects).toEqual([]);
    await grants.setGrant(admin, { ...grantScope, role: "project_manager" }, randomUUID());
    expect((await queue.read(pm)).projects[0]!.blockerAge).toMatchObject({ coverage: "COMPLETE", items: [{ raidItemId: raid.id }] });
  }
  await grantRace(true);
  await grantRace(false);
  // A conflicting second source is prepared by the reader but must not
  // materialize the helper's proposed conflict or leak the competing IDs.
  const secondAdmin: Actor = { customerId, subject: `blocker-second-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  await db.accessGrant.create({ data: { customerId, subject: secondAdmin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" } });
  const conflicting = await facts.appendHumanStatement(secondAdmin, { projectId, factType: `raid_item.${raid.id}.blocks_delivery`,
    expectedRevision: 1, idempotencyKey: randomUUID(), value: { type: "boolean", value: false }, effectiveAt, validUntil: null,
    originalStatement: "Synthetic competing blocker evidence." }, context);
  await facts.setSourceAccess(secondAdmin, { projectId, sourceId: conflicting.entry.sourceId,
    expectedRevision: conflicting.entry.sourceAccessRevision, state: "AVAILABLE", readers: [secondAdmin.subject, admin.subject, pm.subject, leader.subject] }, context);
  expect(await db.factAuthorityConflict.count({ where: { customerId, projectId, factId: conflicting.factId } })).toBe(0);
  const beforeConflictRead = await snapshot();
  const originalBuilder = blockerAssessment.buildBlockerAgeAssessmentInTransaction;
  const conflictCounts: number[] = [];
  const spy = vi.spyOn(blockerAssessment, "buildBlockerAgeAssessmentInTransaction").mockImplementation(async (...args) => {
    const result = await originalBuilder(...args);
    conflictCounts.push(result.newConflicts.filter((entry) => entry.factId === conflicting.factId).length);
    return result;
  });
  let hiddenConflict, queueConflict;
  try { hiddenConflict = await leadership.readLeadership(leader, projectId); queueConflict = await queue.read(pm); }
  finally { spy.mockRestore(); }
  expect(conflictCounts).toHaveLength(2); expect(conflictCounts.every((count) => count > 0)).toBe(true);
  expect(hiddenConflict).toMatchObject({ coverage: "UNASSESSABLE", inventory: null, noOpenBlockers: null, items: [] });
  expect(queueConflict.projects[0]!.blockerAge).toMatchObject({ coverage: "UNASSESSABLE", items: [] });
  for (const id of [conflicting.factId, conflicting.entry.id, conflicting.entry.evidenceId, conflicting.entry.sourceId]) {
    expect(JSON.stringify(hiddenConflict)).not.toContain(id); expect(JSON.stringify(queueConflict)).not.toContain(id);
  }
  expect(await snapshot()).toEqual(beforeConflictRead);
  expect(writes).toEqual([]);
}, 120000);

it("rechecks supported RAID reopening in both project-lock orders", async () => {
  async function ordering(writerFirst: boolean) {
    const customerId = randomUUID(), portfolioId = randomUUID();
    const admin: Actor = { customerId, subject: `reopen-admin-${randomUUID()}`, roles: ["pmo_admin"] };
    const leader: Actor = { customerId, subject: `reopen-leader-${randomUUID()}`, roles: ["leadership"] };
    await db.customer.create({ data: { id: customerId, name: "Synthetic reopen advice customer" } });
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic reopen advice portfolio" } });
    await db.accessGrant.createMany({ data: [
      { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" },
      { customerId, subject: leader.subject, scopeType: "portfolio", scopeId: portfolioId, role: "leadership" },
    ] });
    const input = canonicalFixture(portfolioId); input.raidItems = input.raidItems.map((item) => ({ ...item, state: "COMPLETE" }));
    const projectId = (await new DatabaseCanonicalProjectRepository(db).createProject(admin, canonicalProjectCreateSchema.parse(input), randomUUID())).id;
    const raid = await db.raidItem.findFirstOrThrow({ where: { customerId, projectId, state: "COMPLETE" } });
    await new DatabaseHealthAssessmentRepository(db).setBlockerAgeThresholdPolicy(admin,
      { expectedRevision: 0, minimumBlockerAgeDays: 5, auditRetentionHours: 720 }, randomUUID());
    const [{ now }] = await db.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
    const effectiveAt = new Date(now!.getTime() - 60000).toISOString();
    const reopenedAt = new Date(now!.getTime() - 10 * 86400000).toISOString().slice(0, 10);
    const oldOpenedAt = new Date(now!.getTime() - 20 * 86400000).toISOString().slice(0, 10);
    const current: AuthorityDefinition = { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
      requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 86400000 } }] }], conflictBehavior: "REQUEST_RECONCILIATION" };
    const ongoing: AuthorityDefinition = { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
      requiredApproval: "NOT_REQUIRED", validity: { mode: "UNTIL_SUPERSEDED" } }] }], conflictBehavior: "REQUEST_RECONCILIATION" };
    const authority = new DatabaseAuthorityRepository(db), facts = new DatabaseProjectFactRepository(db), context = { correlationId: randomUUID() };
    async function add(factType: string, value: { type: "boolean"; value: boolean } | { type: "date"; value: string }, definition: AuthorityDefinition) {
      await authority.appendPolicy(admin, { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt, definition }, context);
      const row = await facts.appendHumanStatement(admin, { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(),
        value, effectiveAt: value.type === "date" ? `${value.value}T00:00:00.000Z` : effectiveAt,
        validUntil: null, originalStatement: "Synthetic pre-reopen evidence." }, context);
      await facts.setSourceAccess(admin, { projectId, sourceId: row.entry.sourceId, expectedRevision: row.entry.sourceAccessRevision,
        state: "AVAILABLE", readers: [admin.subject, leader.subject] }, context);
      return row;
    }
    await add("project.open_blocker_inventory_complete", { type: "boolean", value: true }, current);
    await add(`raid_item.${raid.id}.blocks_delivery`, { type: "boolean", value: true }, current);
    const priorDate = await add(`raid_item.${raid.id}.opened_at`, { type: "date", value: oldOpenedAt }, ongoing);
    const health = new DatabaseHealthAssessmentRepository(db);
    await health.setRetention(admin, { contentRetentionHours: 24, auditRetentionHours: 48, idempotencyRetentionHours: 72 }, randomUUID());
    const saved = await health.create(leader, projectId, "synthetic-before-reopen", randomUUID());
    expect(saved).toMatchObject({ contentAvailable: true, blockerAgeCoverage: "COMPLETE" });
    expect(saved.result).toMatchObject({ blockerAge: { noOpenBlockers: true } });
    let writerPid = 0, readerPid = 0, signalHeld!: () => void, signalStarted!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; }); let paused = false;
    const writerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        expect((await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role"))[0]?.role).toBe("pdaa_api");
        writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (!writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
            const result = await Reflect.apply(value, target, args);
            if (writerFirst && !paused && rawSqlText(args[0]).includes("reopen_canonical_raid_item")) {
              paused = true; signalHeld(); await gate;
            }
            return result;
          };
          return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const readerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
            const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
            if (!writerFirst && !paused && sql.includes('SELECT id,"portfolioId" FROM public."Project"') && sql.includes("FOR SHARE")) {
              paused = true; signalHeld(); await gate;
            }
            return result;
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const write = () => new DatabaseCanonicalProjectRepository(writerDb as never).reopenRaidItem(admin, projectId, raid.id,
      { expectedState: "COMPLETE", newState: "OPEN", expectedFactRevision: 1, openedAt: reopenedAt, validUntil: null,
        idempotencyKey: randomUUID(), originalStatement: "Synthetic reopened blocker date." }, randomUUID());
    const read = () => new DatabaseBlockerAgeAdviceRepository(readerDb as never).readLeadership(leader, projectId);
    const first = writerFirst ? write() : read(); void first.catch(() => {});
    let second: ReturnType<typeof write> | ReturnType<typeof read> | undefined, blocked = false;
    try {
      await Promise.race([held, first.then(() => { throw new Error("First reopen operation exited before barrier"); })]);
      second = writerFirst ? read() : write(); void second.catch(() => {});
      await Promise.race([started, second.then(() => { throw new Error("Second reopen operation exited before barrier"); })]);
      for (let i = 0; i < 40 && !blocked; i++) {
        const waiting = writerFirst ? readerPid : writerPid, blocking = writerFirst ? writerPid : readerPid;
        const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
          "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
        const expected = writerFirst ? 'SELECT id,"portfolioId" FROM public."Project"' : "reopen_canonical_raid_item";
        blocked = rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocking) && rows[0].query.includes(expected) &&
          (!writerFirst || rows[0].query.includes("FOR SHARE"));
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally { release(); await Promise.allSettled(second ? [first, second] : [first]); }
    expect(blocked).toBe(true);
    const firstResult = await first, secondResult = await second, result = writerFirst ? secondResult : firstResult;
    const reopen = (writerFirst ? firstResult : secondResult) as Awaited<ReturnType<typeof write>>;
    expect(reopen).toMatchObject({ projectId, raidItemId: raid.id, state: "OPEN", factRevision: 2, replayed: false });
    if (writerFirst) expect(result).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: false,
      items: [{ raidItemId: raid.id, openedAt: reopenedAt, openedAtProof: { supports: [expect.objectContaining({ versionId: reopen.versionId })] } }] });
    else expect(result).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: true, items: [] });
    const fresh = await new DatabaseBlockerAgeAdviceRepository(readerDb as never).readLeadership(leader, projectId);
    expect(fresh).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: false, items: [{ raidItemId: raid.id, openedAt: reopenedAt }] });
    expect(fresh.items[0]!.openedAtProof.supports.map((support) => support.versionId)).toEqual([reopen.versionId]);
    expect(fresh.items[0]!.openedAtProof.supports.map((support) => support.versionId)).not.toContain(priorDate.entry.id);
    expect(await health.latest(leader, projectId)).toMatchObject({ assessmentId: saved.assessmentId, contentAvailable: true,
      input: saved.input, result: saved.result });
    expect((await db.raidItem.findUniqueOrThrow({ where: { id: raid.id } })).state).toBe("OPEN");
  }
  await ordering(true);
  await ordering(false);
}, 120000);

it("serializes first threshold insertion against leadership reads in both lock orders", async () => {
  async function setup() {
    const customerId = randomUUID(), portfolioId = randomUUID();
    const admin: Actor = { customerId, subject: `first-threshold-admin-${randomUUID()}`, roles: ["pmo_admin"] };
    const leader: Actor = { customerId, subject: `first-threshold-leader-${randomUUID()}`, roles: ["leadership"] };
    await db.customer.create({ data: { id: customerId, name: "Synthetic first threshold customer" } });
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic first threshold portfolio" } });
    await db.accessGrant.createMany({ data: [
      { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" },
      { customerId, subject: leader.subject, scopeType: "portfolio", scopeId: portfolioId, role: "leadership" },
    ] });
    const input = canonicalProjectCreateSchema.parse(canonicalFixture(portfolioId));
    const projectId = (await new DatabaseCanonicalProjectRepository(db).createProject(admin, input, randomUUID())).id;
    return { customerId, admin, leader, projectId };
  }
  async function waitForBlock(waiting: number, blocker: number, query: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1", waiting);
      if (rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(blocker) && rows[0].query.includes(query)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  async function ordering(writerFirst: boolean) {
    const { customerId, admin, leader, projectId } = await setup();
    const other = writerFirst ? await setup() : null;
    let writerPid = 0, readerPid = 0, signalHeld!: () => void, signalStarted!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let paused = false; const observedThresholdRows: unknown[][] = [];
    const writerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        writerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (!writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
            const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
            if (writerFirst && !paused && sql.includes("pg_advisory_xact_lock(") && args[0] === "blocker-age-threshold:" + customerId) {
              paused = true; signalHeld(); await gate;
            }
            return result;
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const readerDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        readerPid = (await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"))[0]!.pid;
        if (writerFirst) signalStarted();
        return operation(new Proxy(tx, { get(target, key) {
          if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
            const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
            if (!writerFirst && !paused && sql.includes("pg_advisory_xact_lock_shared") && args[0] === "blocker-age-threshold:" + customerId) {
              paused = true; signalHeld(); await gate;
            }
            if (sql.includes('FROM public."BlockerAgeThresholdPolicy"')) observedThresholdRows.push(result);
            return result;
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        } }));
      }, options as never) };
    const write = () => new DatabaseHealthAssessmentRepository(writerDb as never).setBlockerAgeThresholdPolicy(admin,
      { expectedRevision: 0, minimumBlockerAgeDays: 5, auditRetentionHours: 720 }, randomUUID());
    const read = () => new DatabaseBlockerAgeAdviceRepository(readerDb as never).readLeadership(leader, projectId);
    const first = writerFirst ? write() : read(); void first.catch(() => {});
    let second: ReturnType<typeof write> | ReturnType<typeof read> | undefined;
    let otherRead: ReturnType<typeof read> | undefined, blocked = false;
    try {
      await Promise.race([held, first.then(() => { throw new Error("First operation exited before barrier"); })]);
      if (other) {
        let otherGateObserved = false;
        const otherDb = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
          db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
            return operation(new Proxy(tx, { get(target, key) {
              if (key === "$queryRawUnsafe") return async (sql: string, ...args: unknown[]) => {
                const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...args);
                if (sql.includes("pg_advisory_xact_lock_shared") && args[0] === "blocker-age-threshold:" + other.customerId) otherGateObserved = true;
                return result;
              };
              const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
            } }));
          }, options as never) };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          otherRead = new DatabaseBlockerAgeAdviceRepository(otherDb as never).readLeadership(other.leader, other.projectId);
          const bounded = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Unrelated customer read blocked")), 4000); });
          expect(await Promise.race([otherRead, bounded])).toMatchObject({ coverage: "UNASSESSABLE", items: [], noOpenBlockers: null });
          expect(otherGateObserved).toBe(true);
        } finally { if (timer) clearTimeout(timer); }
      }
      second = writerFirst ? read() : write(); void second.catch(() => {});
      await Promise.race([started, second.then(() => { throw new Error("Second operation exited before barrier"); })]);
      blocked = writerFirst ? await waitForBlock(readerPid, writerPid, "pg_advisory_xact_lock_shared") :
        await waitForBlock(writerPid, readerPid, "pg_advisory_xact_lock(");
    } finally { release(); await Promise.allSettled([first, ...(second ? [second] : []), ...(otherRead ? [otherRead] : [])]); }
    expect(blocked).toBe(true);
    const firstResult = await first, secondResult = await second;
    const adviceResult = writerFirst ? secondResult : firstResult;
    expect(adviceResult).toMatchObject({ coverage: "UNASSESSABLE", noOpenBlockers: null, inventory: null, items: [] });
    expect(observedThresholdRows).toHaveLength(1);
    if (writerFirst) expect(observedThresholdRows[0]).toMatchObject([{ revision: 1, minimumBlockerAgeDays: 5 }]);
    else expect(observedThresholdRows[0]).toEqual([]);
    expect(await db.blockerAgeThresholdPolicy.findUnique({ where: { customerId } })).toMatchObject({ revision: 1, minimumBlockerAgeDays: 5 });
  }
  await ordering(true);
  await ordering(false);
}, 120000);
