// EXEC-026: run only with the separately qualified disposable integration target.
import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, DatabaseAuthorityRepository, DatabaseCanonicalProjectRepository, DatabasePmActionQueueRepository,
  DatabaseProjectFactRepository, DatabaseProjectUpdateRepository } from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { canonicalProjectCreateSchema } from "../packages/domain/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
    new URL(url).hostname !== "127.0.0.1" || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Queue integration checks require a separately qualified disposable synthetic database");
const db = createDatabase(url);
afterAll(async () => { await db.$disconnect(); });

it("intersects PM assignment and grants under the API role without adding audits or assessments", async () => {
  const customerId = process.env.CUSTOMER_ID!;
  const portfolioId = randomUUID();
  const pm: Actor = { customerId, subject: `queue-pm-${randomUUID()}`, roles: ["project_manager"] };
  const admin: Actor = { customerId, subject: `queue-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic queue portfolio" } });
  await db.accessGrant.create({ data: { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" } });
  const canonical = new DatabaseCanonicalProjectRepository(db);
  async function makeProject(subject: string) {
    const input = canonicalFixture(portfolioId);
    input.responsibilities = input.responsibilities.map((item) =>
      item.role === "PROJECT_MANAGER" ? { ...item, subject } : item);
    return canonical.createProject(admin, canonicalProjectCreateSchema.parse(input), randomUUID());
  }
  const first = await makeProject(pm.subject), second = await makeProject(pm.subject);
  const unassigned = await makeProject(`other-${randomUUID()}`);
  await db.accessGrant.createMany({ data: [
    { customerId, subject: pm.subject, scopeType: "portfolio", scopeId: portfolioId, role: "project_manager" },
    { customerId, subject: pm.subject, scopeType: "project", scopeId: first.id, role: "project_manager" },
  ] });
  let apiTransactions = 0;
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const identity = await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role");
      expect(identity[0]?.role).toBe("pdaa_api");
      apiTransactions++;
      return operation(tx);
    }, options as never) };
  const queue = new DatabasePmActionQueueRepository(apiDatabase as never);
  const beforeAudits = await db.auditEvent.count({ where: { customerId } });
  const beforeAssessments = await db.healthAssessment.count({ where: { customerId } });
  const result = await queue.read(pm);
  expect(result.projects.map((project) => project.projectId)).toEqual([first.id, second.id].sort());
  expect(result.projects.some((project) => project.projectId === unassigned.id)).toBe(false);
  expect(result.projects.every((project) => project.schedule.audience === "project_manager" && project.update.audience === "project_manager")).toBe(true);
  expect(await db.auditEvent.count({ where: { customerId } })).toBe(beforeAudits);
  expect(await db.healthAssessment.count({ where: { customerId } })).toBe(beforeAssessments);
  await db.accessGrant.deleteMany({ where: { customerId, subject: pm.subject, scopeType: "portfolio", scopeId: portfolioId } });
  expect((await queue.read(pm)).projects.map((project) => project.projectId)).toEqual([first.id]);
  await db.accessGrant.create({ data: { customerId, subject: pm.subject, scopeType: "portfolio", scopeId: portfolioId, role: "leadership" } });
  const dual = await queue.read({ ...pm, roles: ["project_manager", "leadership"] });
  expect(dual.projects.map((project) => project.projectId)).toEqual([first.id]);
  expect(dual.projects[0]!.schedule.audience).toBe("project_manager");
  expect(dual.projects[0]!.update.audience).toBe("project_manager");
  const otherCustomer = randomUUID(), otherPortfolio = randomUUID();
  const otherAdmin: Actor = { customerId: otherCustomer, subject: `queue-other-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  await db.customer.create({ data: { id: otherCustomer, name: "Synthetic other queue customer" } });
  await db.portfolio.create({ data: { id: otherPortfolio, customerId: otherCustomer, name: "Synthetic other queue portfolio" } });
  await db.accessGrant.createMany({ data: [
    { customerId: otherCustomer, subject: otherAdmin.subject, scopeType: "portfolio", scopeId: otherPortfolio, role: "pmo_admin" },
    { customerId: otherCustomer, subject: pm.subject, scopeType: "portfolio", scopeId: otherPortfolio, role: "project_manager" },
  ] });
  const otherInput = canonicalFixture(otherPortfolio);
  otherInput.responsibilities = otherInput.responsibilities.map((item) =>
    item.role === "PROJECT_MANAGER" ? { ...item, subject: pm.subject } : item);
  const otherProject = await canonical.createProject(otherAdmin, canonicalProjectCreateSchema.parse(otherInput), randomUUID());
  expect((await queue.read({ ...pm, customerId: otherCustomer })).projects.map((project) => project.projectId)).toEqual([otherProject.id]);
  expect((await queue.read(pm)).projects.map((project) => project.projectId)).toEqual([first.id]);
  expect(await db.auditEvent.count({ where: { customerId } })).toBe(beforeAudits);
  expect(await db.healthAssessment.count({ where: { customerId } })).toBe(beforeAssessments);
  expect(apiTransactions).toBe(5);

  // Pause after the queue has acquired its positive PM grant lock. A concurrent
  // deletion must actually wait in PostgreSQL until the observation commits.
  let release!: () => void, ready!: () => void, writerReady!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<void>((resolve) => { ready = resolve; });
  const writerStarted = new Promise<void>((resolve) => { writerReady = resolve; });
  let paused = false, queuePid = 0, writerPid = 0, blocked = false;
  const controlledDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const identity = await tx.$queryRawUnsafe<{ pid: number; role: string }[]>("SELECT pg_backend_pid() AS pid, current_user AS role");
      expect(identity[0]?.role).toBe("pdaa_api"); queuePid = identity[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...parameters: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...parameters);
          if (!paused && sql.startsWith('SELECT id FROM public."AccessGrant"') && result.length) {
            paused = true; ready(); await gate;
          }
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const pending = new DatabasePmActionQueueRepository(controlledDatabase as never).read(pm);
  void pending.catch(() => {});
  let writer: Promise<unknown> | undefined;
  try {
    await Promise.race([locked, pending.then(() => { throw new Error("Queue completed before the grant barrier"); })]);
    writer = db.$transaction(async (tx) => {
      const identity = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
      writerPid = identity[0]!.pid; writerReady();
      const deleted = await tx.accessGrant.deleteMany({ where: { customerId, subject: pm.subject, scopeType: "project", scopeId: first.id } });
      expect(deleted.count).toBe(1);
    }, { timeout: 15000 });
    void writer.catch(() => {});
    await Promise.race([writerStarted, writer.then(() => { throw new Error("Grant writer completed before the barrier"); })]);
    for (let i = 0; i < 50 && !blocked; i++) {
      const state = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[] }[]>(
        "SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1", writerPid);
      blocked = state[0]?.wait_event_type === "Lock" && state[0].blockers.includes(queuePid);
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    release();
    await Promise.allSettled(writer ? [pending, writer] : [pending]);
  }
  expect(blocked).toBe(true);
  expect((await pending).projects.map((project) => project.projectId)).toEqual([first.id]);
  await writer;
  expect((await queue.read(pm)).projects).toEqual([]);
  expect((await queue.read({ ...pm, roles: ["project_manager", "leadership"] })).projects).toEqual([]);

  // A newly committed grant between the first and final discovery must make
  // the old empty observation unavailable, not silently omit the project.
  let allowDiscovery!: () => void, discoveryReady!: () => void;
  const discoveryGate = new Promise<void>((resolve) => { allowDiscovery = resolve; });
  const discovered = new Promise<void>((resolve) => { discoveryReady = resolve; });
  let discoveryPaused = false;
  const discoveryResults: string[][] = [];
  const insertionDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...parameters: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...parameters);
          if (sql.startsWith('SELECT p.id FROM public."Project" p')) {
            discoveryResults.push(result.map((row) => (row as { id: string }).id));
            if (!discoveryPaused) { discoveryPaused = true; expect(result).toEqual([]); discoveryReady(); await discoveryGate; }
          }
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const insertionRead = new DatabasePmActionQueueRepository(insertionDatabase as never).read(pm);
  void insertionRead.catch(() => {});
  try {
    await Promise.race([discovered, insertionRead.then(() => { throw new Error("Queue completed before the discovery barrier"); })]);
    await db.accessGrant.create({ data: { customerId, subject: pm.subject, scopeType: "project", scopeId: first.id, role: "project_manager" } });
  } finally {
    allowDiscovery();
    await Promise.allSettled([insertionRead]);
  }
  await expect(insertionRead).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(discoveryResults).toEqual([[], [first.id]]);
  expect((await queue.read(pm)).projects.map((project) => project.projectId)).toEqual([first.id]);
  expect(await db.auditEvent.count({ where: { customerId } })).toBe(beforeAudits);
  expect(await db.healthAssessment.count({ where: { customerId } })).toBe(beforeAssessments);
}, 45000);

it("fails closed on an unsealed candidate visible inside its creating transaction", async () => {
  const customerId = process.env.CUSTOMER_ID!, portfolioId = randomUUID(), projectId = randomUUID();
  const pm: Actor = { customerId, subject: `queue-unsealed-${randomUUID()}`, roles: ["project_manager"] };
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic unsealed queue portfolio" } });
  let discovered = false, assignmentRejected = false;
  const database = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.project.create({ data: { id: projectId, customerId, portfolioId, code: `QUEUE-${randomUUID()}`,
        name: "Synthetic unsealed project", description: "Synthetic transaction fixture", reportedStatus: "UNKNOWN" } });
      await tx.canonicalProject.create({ data: { id: projectId, customerId, portfolioId, createdBy: pm.subject,
        responsibilitiesCount: 1, sprintsCount: 0, milestonesCount: 0, workItemsCount: 0,
        requiredWorkItemsCount: 0, raidItemsCount: 0, sourceMappingsCount: 0 } });
      await tx.projectResponsibility.create({ data: { id: randomUUID(), customerId, projectId,
        role: "PROJECT_MANAGER", subject: pm.subject, displayName: "Synthetic manager" } });
      await tx.accessGrant.create({ data: { customerId, subject: pm.subject, scopeType: "project", scopeId: projectId, role: "project_manager" } });
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...parameters: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...parameters);
          if (sql.startsWith('SELECT p.id FROM public."Project" p'))
            discovered = result.some((row) => (row as { id: string }).id === projectId);
          if (sql.startsWith('SELECT r.id FROM public."ProjectResponsibility"')) assignmentRejected = result.length === 0;
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  await expect(new DatabasePmActionQueueRepository(database as never).read(pm)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(discovered).toBe(true); expect(assignmentRejected).toBe(true);
  expect(await db.project.findUnique({ where: { id: projectId } })).toBeNull();
});

it("accepts 25 distinct assigned projects and rejects a 26th without truncating", async () => {
  const customerId = randomUUID(), portfolioId = randomUUID();
  const pm: Actor = { customerId, subject: `queue-capacity-pm-${randomUUID()}`, roles: ["project_manager"] };
  const admin: Actor = { customerId, subject: `queue-capacity-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  await db.customer.create({ data: { id: customerId, name: "Synthetic queue capacity customer" } });
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic queue capacity portfolio" } });
  await db.accessGrant.createMany({ data: [
    { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" },
    { customerId, subject: pm.subject, scopeType: "portfolio", scopeId: portfolioId, role: "project_manager" },
  ] });
  const canonical = new DatabaseCanonicalProjectRepository(db), ids: string[] = [];
  async function addProject() {
    const input = canonicalFixture(portfolioId);
    input.responsibilities = input.responsibilities.map((item) =>
      item.role === "PROJECT_MANAGER" ? { ...item, subject: pm.subject } : item);
    const created = await canonical.createProject(admin, canonicalProjectCreateSchema.parse(input), randomUUID());
    ids.push(created.id);
  }
  for (let i = 0; i < 25; i++) await addProject();
  await db.accessGrant.create({ data: { customerId, subject: pm.subject, scopeType: "project", scopeId: ids[0]!, role: "project_manager" } });
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const identity = await tx.$queryRawUnsafe<{ role: string }[]>("SELECT current_user AS role");
      expect(identity[0]?.role).toBe("pdaa_api"); return operation(tx);
    }, options as never) };
  const queue = new DatabasePmActionQueueRepository(apiDatabase as never);
  expect((await queue.read(pm)).projects.map((project) => project.projectId)).toEqual([...ids].sort());
  await addProject();
  const discovery: string[][] = [];
  let projectLocks = 0;
  const observedDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...parameters: unknown[]) => {
          if (sql.startsWith('SELECT id FROM public."Project"') && sql.includes("FOR SHARE")) projectLocks++;
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...parameters);
          if (sql.startsWith('SELECT p.id FROM public."Project" p')) discovery.push(result.map((row) => (row as { id: string }).id));
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  await expect(new DatabasePmActionQueueRepository(observedDatabase as never).read(pm)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(discovery).toEqual([[...ids].sort()]); expect(projectLocks).toBe(0);
}, 120000);

it("rechecks source access after a supported revocation blocks the queue project lock", async () => {
  const customerId = process.env.CUSTOMER_ID!, portfolioId = randomUUID();
  const pm: Actor = { customerId, subject: `queue-source-pm-${randomUUID()}`, roles: ["project_manager"] };
  const admin: Actor = { customerId, subject: `queue-source-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic queue source portfolio" } });
  await db.accessGrant.createMany({ data: [
    { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" },
    { customerId, subject: pm.subject, scopeType: "portfolio", scopeId: portfolioId, role: "project_manager" },
  ] });
  const input = canonicalFixture(portfolioId);
  input.responsibilities = input.responsibilities.map((item) =>
    item.role === "PROJECT_MANAGER" ? { ...item, subject: pm.subject } : item);
  const projectId = (await new DatabaseCanonicalProjectRepository(db).createProject(admin, canonicalProjectCreateSchema.parse(input), randomUUID())).id;
  const factType = "project.status";
  await new DatabaseProjectUpdateRepository(db).setPolicy(admin, projectId, {
    expectedRevision: 0, freshnessWindowSeconds: 3600, timeZone: "UTC", requiredFacts: [{ factType, label: "Current status" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false, reminderBusinessDayOffsets: [],
    escalationAfterBusinessDays: 0, escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null,
  }, randomUUID());
  const facts = new DatabaseProjectFactRepository(db), effectiveAt = new Date(Date.now() - 86400000).toISOString();
  const statement = await facts.appendHumanStatement(admin, { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(),
    effectiveAt, value: { type: "text", value: "Synthetic source value" }, originalStatement: "Synthetic source statement" },
    { correlationId: randomUUID() });
  await facts.setSourceAccess(admin, { projectId, sourceId: statement.entry.sourceId,
    expectedRevision: statement.entry.sourceAccessRevision, state: "AVAILABLE", readers: [admin.subject, pm.subject] },
    { correlationId: randomUUID() });
  await new DatabaseAuthorityRepository(db).appendPolicy(admin, { projectId, factType, expectedRevision: 0,
    idempotencyKey: randomUUID(), effectiveAt, definition: { tiers: [{ selectors: [{ sourceType: "human_statement",
      instanceId: null, requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 31536000000 } }] }],
      conflictBehavior: "REQUEST_RECONCILIATION" } }, { correlationId: randomUUID() });
  const access = await db.factSourceAccess.findFirstOrThrow({ where: { customerId, projectId, sourceId: statement.entry.sourceId } });
  let queuePid = 0, writerPid = 0, queueReady = () => {}, writerReady!: () => void, release!: () => void;
  let traceQueue = false, projectLockCompleted = false, requiredFactRead = false;
  const writerLocked = new Promise<void>((resolve) => { writerReady = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const apiDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const identity = await tx.$queryRawUnsafe<{ role: string; pid: number }[]>("SELECT current_user AS role, pg_backend_pid() AS pid");
      expect(identity[0]?.role).toBe("pdaa_api"); queuePid = identity[0]!.pid; queueReady();
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...parameters: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...parameters);
          if (traceQueue && sql.startsWith('SELECT id FROM public."Project"') && sql.includes("FOR SHARE") && parameters[1] === projectId)
            projectLockCompleted = true;
          if (traceQueue && sql.startsWith('SELECT id,"factType",revision FROM public."ProjectFact"') &&
              result.some((row) => (row as { factType: string }).factType === factType)) requiredFactRead = true;
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const queue = new DatabasePmActionQueueRepository(apiDatabase as never);
  const before = await queue.read(pm), observation = before.projects[0]!.update;
  expect(observation).toMatchObject({ availability: "AVAILABLE", completeness: { state: "COMPLETE" },
    evidence: [expect.objectContaining({ sourceId: statement.entry.sourceId, versionId: statement.entry.id })] });
  let paused = false;
  const gatedDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      const identity = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid"); writerPid = identity[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "$queryRaw" && typeof value === "function") return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args);
          const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
          if (!paused && sql.includes('FROM "Project"') && sql.includes("FOR UPDATE")) { paused = true; writerReady(); await gate; }
          return result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const writer = new DatabaseProjectFactRepository(gatedDatabase as never).setSourceAccess(admin, { projectId,
    sourceId: statement.entry.sourceId, expectedRevision: access.revision, state: "AVAILABLE", readers: [admin.subject] },
    { correlationId: randomUUID() });
  void writer.catch(() => {});
  let pending: Promise<unknown> | undefined, blocked = false;
  try {
    await Promise.race([writerLocked, writer.then(() => { throw new Error("Source writer exited before the project barrier"); })]);
    const queueStarted = new Promise<void>((resolve) => { queueReady = resolve; });
    traceQueue = true;
    pending = queue.read(pm); void pending.catch(() => {});
    await Promise.race([queueStarted, pending.then(() => { throw new Error("Queue exited before starting the read transaction"); })]);
    for (let i = 0; i < 40 && !blocked; i++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE pid=$1", queuePid);
      blocked = rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(writerPid) &&
        rows[0].query.includes('SELECT id FROM public."Project"') && rows[0].query.includes("FOR SHARE");
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    release();
    await Promise.allSettled(pending ? [writer, pending] : [writer]);
  }
  expect(blocked).toBe(true); await writer;
  await expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(projectLockCompleted).toBe(true); expect(requiredFactRead).toBe(true); traceQueue = false;
  expect(await db.factSourceReader.count({ where: { customerId, projectId, sourceId: statement.entry.sourceId, subject: pm.subject } })).toBe(0);
  await expect(queue.read(pm)).rejects.toMatchObject({ code: "UNAVAILABLE" });

  // Complementary ordering: restore the reader, hold the queue's project
  // lock, and prove the supported revocation waits until the read commits.
  const deniedAccess = await db.factSourceAccess.findFirstOrThrow({ where: { customerId, projectId, sourceId: statement.entry.sourceId } });
  await facts.setSourceAccess(admin, { projectId, sourceId: statement.entry.sourceId, expectedRevision: deniedAccess.revision,
    state: "AVAILABLE", readers: [admin.subject, pm.subject] }, { correlationId: randomUUID() });
  expect((await queue.read(pm)).projects[0]!.update).toMatchObject({ availability: "AVAILABLE", completeness: { state: "COMPLETE" },
    evidence: [expect.objectContaining({ sourceId: statement.entry.sourceId, versionId: statement.entry.id })] });
  const restoredAccess = await db.factSourceAccess.findFirstOrThrow({ where: { customerId, projectId, sourceId: statement.entry.sourceId } });
  let heldReaderPid = 0, laterWriterPid = 0, readerLocked!: () => void, laterWriterStarted!: () => void, releaseReader!: () => void;
  const readerReady = new Promise<void>((resolve) => { readerLocked = resolve; });
  const laterWriterReady = new Promise<void>((resolve) => { laterWriterStarted = resolve; });
  const readerGate = new Promise<void>((resolve) => { releaseReader = resolve; });
  let readerPaused = false;
  const heldDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const identity = await tx.$queryRawUnsafe<{ role: string; pid: number }[]>("SELECT current_user AS role, pg_backend_pid() AS pid");
      expect(identity[0]?.role).toBe("pdaa_api"); heldReaderPid = identity[0]!.pid;
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (sql: string, ...parameters: unknown[]) => {
          const result = await tx.$queryRawUnsafe<unknown[]>(sql, ...parameters);
          if (!readerPaused && sql.startsWith('SELECT id FROM public."Project"') && sql.includes("FOR SHARE") && parameters[1] === projectId) {
            expect(result).toHaveLength(1); readerPaused = true; readerLocked(); await readerGate;
          }
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  const reader = new DatabasePmActionQueueRepository(heldDatabase as never).read(pm);
  void reader.catch(() => {});
  let laterWriter: Promise<unknown> | undefined, writerBlocked = false;
  try {
    await Promise.race([readerReady, reader.then(() => { throw new Error("Queue exited before the reader barrier"); })]);
    const laterDatabase = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        const identity = await tx.$queryRawUnsafe<{ pid: number }[]>("SELECT pg_backend_pid() AS pid");
        laterWriterPid = identity[0]!.pid; laterWriterStarted(); return operation(tx);
      }, options as never) };
    laterWriter = new DatabaseProjectFactRepository(laterDatabase as never).setSourceAccess(admin, { projectId,
      sourceId: statement.entry.sourceId, expectedRevision: restoredAccess.revision, state: "AVAILABLE", readers: [admin.subject] },
      { correlationId: randomUUID() });
    void laterWriter.catch(() => {});
    await Promise.race([laterWriterReady, laterWriter.then(() => { throw new Error("Source writer exited before the held reader"); })]);
    for (let i = 0; i < 40 && !writerBlocked; i++) {
      const rows = await db.$queryRawUnsafe<{ wait_event_type: string | null; blockers: number[]; query: string }[]>(
        "SELECT wait_event_type, pg_blocking_pids(pid) AS blockers, query FROM pg_stat_activity WHERE pid=$1", laterWriterPid);
      writerBlocked = rows[0]?.wait_event_type === "Lock" && rows[0].blockers.includes(heldReaderPid) &&
        rows[0].query.includes('FROM "Project"') && rows[0].query.includes("FOR UPDATE");
      if (!writerBlocked) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    releaseReader();
    await Promise.allSettled(laterWriter ? [reader, laterWriter] : [reader]);
  }
  expect(writerBlocked).toBe(true);
  expect((await reader).projects[0]!.update).toMatchObject({ availability: "AVAILABLE", completeness: { state: "COMPLETE" },
    evidence: [expect.objectContaining({ sourceId: statement.entry.sourceId, versionId: statement.entry.id })] });
  await laterWriter;
  expect(await db.factSourceReader.count({ where: { customerId, projectId, sourceId: statement.entry.sourceId, subject: pm.subject } })).toBe(0);
  await expect(queue.read(pm)).rejects.toMatchObject({ code: "UNAVAILABLE" });
}, 45000);
