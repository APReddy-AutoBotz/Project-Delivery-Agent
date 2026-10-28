import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DatabaseAuthorityRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseHealthAssessmentRepository,
  DatabaseProjectFactRepository,
} from "../../packages/data/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";

// NFR-SEC-001 / AC-HLT-003: this runs only after the guarded prefix-nine
// upgrade and its pristine checks, against that separately owned synthetic DB.
export async function verifyHealthApiRoleAfterGrantReapply(db, expectedDatabase, connectionUrl) {
  assert.match(expectedDatabase, /^pdaa_upgrade9_[0-9]+$/);
  const connection = new URL(connectionUrl);
  assert(["127.0.0.1", "localhost"].includes(connection.hostname));
  assert.equal(connection.pathname, "/" + expectedDatabase);
  assert.equal(process.env.DATA_MODE, "synthetic");
  assert.notEqual(process.env.NODE_ENV, "production");
  const [identity] = await db.$queryRawUnsafe("SELECT current_database() AS name");
  assert.equal(identity.name, expectedDatabase);
  const [policyAcl] = await db.$queryRawUnsafe(`SELECT
    pg_get_userbyid(c.relowner) AS owner,
    has_table_privilege('pdaa_api',c.oid,'SELECT WITH GRANT OPTION') AS select_grant,
    has_table_privilege('pdaa_api',c.oid,'INSERT WITH GRANT OPTION') AS insert_grant,
    has_table_privilege('pdaa_api',c.oid,'UPDATE WITH GRANT OPTION') AS update_grant,
    has_table_privilege('pdaa_worker',c.oid,'SELECT') AS worker_select,
    has_table_privilege('pdaa_worker',c.oid,'INSERT') AS worker_insert,
    has_table_privilege('pdaa_worker',c.oid,'UPDATE') AS worker_update,
    has_table_privilege('pdaa_worker',c.oid,'DELETE') AS worker_delete
    FROM pg_class c WHERE c.oid='public."BlockerAgeThresholdPolicy"'::regclass`);
  assert.deepEqual(policyAcl, { owner: "pdaa_migrate", select_grant: false, insert_grant: false, update_grant: false,
    worker_select: false, worker_insert: false, worker_update: false, worker_delete: false });
  const customerId = randomUUID(), portfolioId = randomUUID();
  const manager = { customerId, subject: `role-health-pm-${randomUUID()}`, roles: ["portfolio_manager", "project_manager"] };
  const admin = { customerId, subject: `role-health-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  await db.customer.create({ data: { id: customerId, name: "Synthetic role health" } });
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic role portfolio" } });
  await db.accessGrant.createMany({ data: [
    { customerId, subject: manager.subject, scopeType: "portfolio", scopeId: portfolioId, role: "portfolio_manager" },
    { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" },
  ] });
  const input = canonicalFixture(portfolioId);
  input.code = `ROLE-${randomUUID().slice(0, 8)}`;
  input.raidItems = input.raidItems.map((item, index) => ({ ...item, state: index === 0 ? "OPEN" : "COMPLETE" }));
  const projectId = (await new DatabaseCanonicalProjectRepository(db).createProject(manager, input, randomUUID())).id;
  await db.accessGrant.create({ data: { customerId, subject: manager.subject, scopeType: "project", scopeId: projectId, role: "project_manager" } });

  const forbidden = ["RaidItem", "Milestone", "WorkItem", "ProjectFactVersion", "FactAuthorityConflict", "AuthorityPolicyRevision", "FactSourceReader"];
  let apiTransactions = 0;
  let reportApiPid;
  const api = {
    $transaction: (operation, options) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const [role] = await tx.$queryRawUnsafe("SELECT current_user AS name");
      assert.equal(role.name, "pdaa_api");
      for (const table of forbidden) {
        const [privilege] = await tx.$queryRawUnsafe("SELECT has_any_column_privilege(current_user,$1,'UPDATE') AS allowed", `public."${table}"`);
        assert.equal(privilege.allowed, false, table + " UPDATE must remain unavailable");
      }
      const [threshold] = await tx.$queryRawUnsafe(`SELECT
        has_table_privilege(current_user,'public."BlockerAgeThresholdPolicy"','SELECT') AS "select",
        has_table_privilege(current_user,'public."BlockerAgeThresholdPolicy"','INSERT') AS "insert",
        has_table_privilege(current_user,'public."BlockerAgeThresholdPolicy"','UPDATE') AS "update",
        has_table_privilege(current_user,'public."BlockerAgeThresholdPolicy"','DELETE') AS "delete"`);
      assert.deepEqual(threshold, { select: true, insert: true, update: true, delete: false });
      apiTransactions += 1;
      if (reportApiPid) {
        const [backend] = await tx.$queryRawUnsafe("SELECT pg_backend_pid() AS pid");
        const report = reportApiPid;
        reportApiPid = undefined;
        report(backend.pid);
      }
      return operation(tx);
    }, options),
  };
  const health = new DatabaseHealthAssessmentRepository(api);
  await health.setRetention(admin, { contentRetentionHours: 24, auditRetentionHours: 48, idempotencyRetentionHours: 72 }, randomUUID());
  await health.setBlockerAgeThresholdPolicy(admin, { expectedRevision: 0, minimumBlockerAgeDays: 5, auditRetentionHours: 720 }, randomUUID());
  assert.equal((await health.blockerAgeThresholdPolicy(admin)).minimumBlockerAgeDays, 5);
  await health.setScheduleHealthPolicy(admin, projectId, { expectedRevision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 3,
    targetOverrides: [{ targetType: "MILESTONE", targetKey: "MS-1", minimumOverdueDays: 2 },
      { targetType: "WORK_ITEM", targetKey: "WI-1", minimumOverdueDays: 2 }] }, randomUUID());

  const [clock] = await db.$queryRawUnsafe("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
  const effectiveAt = new Date(clock.now.getTime() - 60_000).toISOString();
  const openedDate = new Date(clock.now.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
  const [raid] = await db.raidItem.findMany({ where: { customerId, projectId, state: "OPEN" } });
  assert(raid);
  const authority = new DatabaseAuthorityRepository(db), facts = new DatabaseProjectFactRepository(db);
  const context = { correlationId: "health-api-role-fixture" };
  let firstSource;
  for (const [factType, value] of [
    ["project.open_blocker_inventory_complete", { type: "boolean", value: true }],
    [`raid_item.${raid.id}.blocks_delivery`, { type: "boolean", value: true }],
    [`raid_item.${raid.id}.opened_at`, { type: "date", value: openedDate }],
  ]) {
    const definition = { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED",
      validity: factType.endsWith(".opened_at") ? { mode: "UNTIL_SUPERSEDED" } : { basis: "observedAt", durationMs: 86_400_000 } }] }],
      conflictBehavior: "REQUEST_RECONCILIATION" };
    await authority.appendPolicy(admin, { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt, definition }, context);
    const appended = await facts.appendHumanStatement(manager, { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(),
      value, effectiveAt, validUntil: null, originalStatement: "Synthetic role-scoped health evidence." }, context);
    const access = await facts.setSourceAccess(admin, { projectId, sourceId: appended.entry.sourceId,
      expectedRevision: appended.entry.sourceAccessRevision, state: "AVAILABLE", readers: [manager.subject, admin.subject] }, context);
    if (!firstSource) firstSource = access;
  }

  // Prove the former locking read is actually denied, in a separate
  // transaction for each table so a permission error cannot poison the test.
  for (const table of forbidden) {
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      await tx.$queryRawUnsafe(`SELECT 1 FROM public."${table}" LIMIT 1 FOR SHARE`);
    }), (error) => {
      const cause = error?.meta?.driverAdapterError?.cause;
      return cause?.originalCode === "42501";
    }, `${table} row lock must be denied`);
  }

  const commandKey = "role-health-assessment";
  const created = await health.create(manager, projectId, commandKey, randomUUID());
  assert.equal(created.coverage, "SCHEDULE_AND_BLOCKER_AGE");
  assert.equal(created.blockerAgeCoverage, "COMPLETE");
  assert.equal(created.contentAvailable, true);
  assert.equal(created.result.blockerAge.assessedBlockerCount, 1);
  assert.equal(created.result.blockerAge.unknownCandidateCount, 0);
  assert.equal(created.result.blockerAge.assessments[0].targetKey, raid.key);
  assert.equal(created.result.blockerAge.assessments[0].status, "AGED");
  const replay = await health.create(manager, projectId, commandKey, randomUUID());
  assert.equal(replay.replayed, true);
  assert.equal(replay.assessmentId, created.assessmentId);
  assert.equal((await health.latest(manager, projectId)).assessmentId, created.assessmentId);
  await assert.rejects(health.latest({ ...manager, subject: `ungranted-${randomUUID()}` }, projectId), { code: "DENIED" });

  // Observe the actual advisory-lock waiter, rather than inferring contention
  // from a delay. All connections use this dedicated synthetic database.
  let releaseWriter, markWriterLocked, writerTime;
  const writerGate = new Promise((resolve) => { releaseWriter = resolve; });
  const writerLocked = new Promise((resolve) => { markWriterLocked = resolve; });
  const writer = db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE', customerId, projectId);
    await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked", `schedule-health-policy:${customerId}:${projectId}`);
    markWriterLocked();
    await writerGate;
    [writerTime] = await tx.$queryRawUnsafe("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
  }, { timeout: 10000 });
  await Promise.race([writerLocked, writer.then(() => { throw new Error("Writer exited before lock"); })]);
  const apiPid = new Promise((resolve) => { reportApiPid = resolve; });
  const pending = health.create(manager, projectId, "role-health-contended", randomUUID());
  // Attach a rejection handler immediately; the original promise is awaited below.
  void pending.catch(() => {});
  let observedWait = false;
  try {
    const pid = await Promise.race([apiPid, pending.then(() => { throw new Error("Reader completed before lock wait"); })]);
    for (let attempt = 0; attempt < 100 && !observedWait; attempt += 1) {
      const [row] = await db.$queryRawUnsafe("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting", pid);
      observedWait = row.waiting;
      if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    releaseWriter();
    await writer;
  }
  assert.equal(observedWait, true, "API role must actually wait on the policy lock");
  const afterWait = await pending;
  assert(Date.parse(afterWait.assessedAt) >= writerTime.now.getTime());

  await facts.setSourceAccess(admin, { projectId, sourceId: firstSource.sourceId, expectedRevision: firstSource.revision,
    state: "AVAILABLE", readers: [admin.subject] }, context);
  const afterRevocation = await health.latest(manager, projectId);
  assert.equal(afterRevocation.contentAvailable, false);
  assert.equal(afterRevocation.input, null);
  assert.equal(afterRevocation.result, null);
  const replayAfterRevocation = await health.create(manager, projectId, commandKey, randomUUID());
  assert.equal(replayAfterRevocation.replayed, true);
  assert.equal(replayAfterRevocation.contentAvailable, false);
  assert.equal(replayAfterRevocation.input, null);
  assert.equal(replayAfterRevocation.result, null);
  assert(apiTransactions >= 7);
  return { status: "passed", role: "pdaa_api", blockedChildUpdates: forbidden.length, exercisedSourceRevocation: true };
}
