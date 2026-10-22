// EXEC-019 / NFR-REL-001: populated handoff recovery through real repositories.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createDatabase, DatabaseCanonicalProjectRepository, DatabaseIngestionRepository,
  DatabaseConnectorRuntimeRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { ProjectUpdateScanCoordinator } from "../../packages/data/dist/project-update-scan.js";
import { CredentialVault, CredentialKeyRingVault } from "../../packages/platform/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
export const reassessmentTables = ["IngestionProjectReassessment"];
const controlColumns = ["state", "attemptCount", "totalAttempts", "recoveryRevision", "availableAt", "lastReason",
  "claimedGeneration", "assessmentId", "obligationId", "previewId", "completedAt", "auditEventId"];
const privateFunctions = ["guard_ingestion_project_reassessment()", "require_ingestion_reassessment_complete()", "lock_ingestion_reassessment_preview()", "reject_ingestion_reassessment_history()"];
const validators = ['valid_ingestion_reassessment_row(public."IngestionProjectReassessment")', "valid_ingestion_project_reassessment(uuid)"];

export async function verifyReassessmentPrivileges(pool) {
  assert.equal((await pool.query(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public."IngestionProjectReassessment"'::regclass`)).rows[0].owner, "pdaa_migrate");
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='IngestionProjectReassessment'")).rows;
  for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"]) {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
      const allowed = role === "pdaa_backup" ? privilege === "SELECT" : role === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege);
      assert.equal((await pool.query("SELECT has_table_privilege($1,'public.\"IngestionProjectReassessment\"',$2) AS allowed", [role, privilege])).rows[0].allowed, allowed, role + "/" + privilege);
      assert.equal((await pool.query("SELECT has_table_privilege($1,'public.\"IngestionProjectReassessment\"',$2) AS allowed", [role, privilege + " WITH GRANT OPTION"])).rows[0].allowed, false);
    }
    for (const { column_name } of columns) for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
      const allowed = role === "pdaa_backup" ? privilege === "SELECT" : role === "pdaa_api" &&
        (["SELECT", "INSERT"].includes(privilege) || privilege === "UPDATE" && controlColumns.includes(column_name));
      assert.equal((await pool.query("SELECT has_column_privilege($1,'public.\"IngestionProjectReassessment\"',$2,$3) AS allowed", [role, column_name, privilege])).rows[0].allowed, allowed, role + "/" + column_name + "/" + privilege);
    }
    for (const name of [...privateFunctions, ...validators])
      assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, "public." + name])).rows[0].allowed,
        role === "pdaa_api" && validators.includes(name), role + "/" + name);
  }
  return true;
}
const normalized = (value) => JSON.parse(JSON.stringify(value));
export async function claimReassessmentFixtureJob(runtime, customerId, expectedJobId) {
  // Real worker ticks may briefly return idle at the application/DB clock
  // boundary. Wait only for availability; never rewrite clocks or accept a
  // different job. A null tick consumes no connector or reassessment attempt.
  for (let tick = 0; tick < 5; tick++) {
    const job = await runtime.claimNextJob(customerId);
    if (job !== null) { assert.equal(job.jobId, expectedJobId); return job; }
    if (tick < 4) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Expected synthetic connector job did not become claimable: " + expectedJobId);
}
async function snapshot(pool, projectId) {
  return normalized({
    causes: (await pool.query('SELECT * FROM public."IngestionProjectReassessment" WHERE "projectId"=$1::uuid ORDER BY id', [projectId])).rows,
    scheduler: (await pool.query('SELECT * FROM public."ProjectUpdatePolicy" WHERE "projectId"=$1::uuid', [projectId])).rows,
  });
}
export async function seedReassessmentRecovery(pool, apiConnection, customerId, databaseFactory = createDatabase) {
  assert(["isolated", "customer-composition"].includes(process.env.PDAA_ACCEPTANCE));
  assert.match(process.env.PDAA_ACCEPTANCE_RUN_ID, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
  const portfolioId = randomUUID(), sourceId = randomUUID();
  const subject = "recovery-handoff-" + randomUUID(), service = "recovery-scan-" + randomUUID();
  const admin = { customerId, subject, roles: ["pmo_admin"] };
  await pool.query('INSERT INTO public."Portfolio" (id,"customerId",name) VALUES ($1::uuid,$2::uuid,\'Synthetic handoff recovery\')', [portfolioId, customerId]);
  for (const [actor, role] of [[subject, "pmo_admin"], [subject + "-system", "system_admin"]])
    await pool.query('INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1::uuid,$2::uuid,$3,\'portfolio\',$4::uuid,$5)', [randomUUID(), customerId, actor, portfolioId, role]);
  const db = databaseFactory(apiConnection);
  try {
    const { id: projectId } = await new DatabaseCanonicalProjectRepository(db).createProject(admin, canonicalFixture(portfolioId), randomUUID());
    const key = Buffer.alloc(32, 51).toString("base64");
    const ingestion = new DatabaseIngestionRepository(db, new CredentialVault(key));
    const runtime = new DatabaseConnectorRuntimeRepository(db, new CredentialKeyRingVault({ currentKeyId: "recovery", keys: { recovery: key } }));
    const updates = new DatabaseProjectUpdateRepository(db, service);
    const policy = { expectedRevision: 0, freshnessWindowSeconds: 1, timeZone: "UTC",
      requiredFacts: [{ factType: "project.status", label: "Current status" }], responsibleSubject: "synthetic-owner-4",
      scheduledScanEnabled: true, reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0,
      escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null };
    await updates.setPolicy(admin, projectId, policy, randomUUID());
    await ingestion.setRetention({ ...admin, subject: subject + "-system", roles: ["system_admin"] }, { retentionHours: 24 }, randomUUID());
    const binding = { customerId, sourceId, sourceType: "jira", origin: "https://recovery.atlassian.net" };
    await ingestion.configure(admin, { binding, projects: [{ projectId, readers: [subject] }], mapping: {
      kind: "CONNECTOR", factTypes: ["jira.status"], adapterConfiguration: JSON.stringify({ projects: [{ projectId, projectKey: "SAFE" }],
        fields: [{ jiraField: "status", factType: "jira.status", valueType: "text" }] }),
    } }, randomUUID());
    const secret = Buffer.alloc(32, 53).toString("hex");
    await runtime.setWebhookSecret({ customerId, sourceId, actorSubject: subject, secret });
    const page = async (sequence) => {
      const now = new Date(), rawBody = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated", timestamp: now.getTime() + sequence }));
      const receipt = await runtime.acceptWebhook({ sourceId, eventId: randomUUID(), rawBody,
        signature: "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex") });
      let job = await claimReassessmentFixtureJob(runtime, customerId, receipt.jobId);
      let state = await ingestion.readConnectorSyncSnapshot(customerId, job.jobId, job.claimGeneration);
      if (state.resetRequired) {
        await ingestion.resetConnectorCursorForJob(customerId, job.jobId, job.claimGeneration);
        job = await claimReassessmentFixtureJob(runtime, customerId, receipt.jobId);
        state = await ingestion.readConnectorSyncSnapshot(customerId, job.jobId, job.claimGeneration);
      }
      await ingestion.persistConnectorPageForJob({ customerId, jobId: job.jobId, expectedClaimGeneration: job.claimGeneration,
        expectedConfigRevision: state.configRevision, expectedMappingRevision: state.mappingRevision,
        expectedCursorRevision: state.cursorRevision, expectedGeneration: state.generation,
        page: { binding, inputCursor: null, nextCursor: null, terminal: true, records: [{
          ref: { customerId, sourceId, projectId, recordType: "jira.issue", recordId: "SAFE-1" },
          revision: String(sequence), sourceContentHash: String(sequence).padStart(64, "0"), observedAt: now.toISOString(), effectiveAt: now.toISOString(),
          deepLink: binding.origin + "/browse/SAFE-1",
          observations: [{ factType: "jira.status", value: { type: "text", value: "Synthetic proposal " + sequence } }],
        }] } });
    };
    await page(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await updates.scanScheduledProjects(1), 1);
    await page(2);
    await updates.setPolicy(admin, projectId, { ...policy, expectedRevision: 1, scheduledScanEnabled: false }, randomUUID());
    await updates.setPolicy(admin, projectId, { ...policy, expectedRevision: 2 }, randomUUID());
    await page(3);
    // Seed an already committed, unacknowledged claim for quarantined backup.
    // The independent native child-process test proves actual process death.
    const coordinator = new ProjectUpdateScanCoordinator(db, service, async () => { throw new Error("Fixture does not assess this claim"); });
    const claimed = await db.$transaction((tx) => coordinator.claim(tx));
    assert.equal(claimed?.causes.length, 1);
    await page(4);
    const saved = await snapshot(pool, projectId);
    assert.equal(saved.causes.length, 4);
    assert.equal(saved.causes.filter((row) => row.state === "COMPLETED" && row.obligationId !== null).length, 1);
    assert.equal(saved.causes.filter((row) => row.state === "BLOCKED").length, 1);
    assert.equal(saved.causes.filter((row) => row.state === "READY" && row.claimedGeneration !== null).length, 1);
    assert.equal(saved.causes.filter((row) => row.state === "READY" && row.claimedGeneration === null).length, 1);
    await verifyReassessmentPrivileges(pool);
    return { projectId, sourceId, ...saved };
  } finally { await db.$disconnect(); }
}
export async function verifyRestoredReassessments(pool, fixture) {
  assert.deepEqual(await snapshot(pool, fixture.projectId), { causes: fixture.causes, scheduler: fixture.scheduler });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public."IngestionProjectReassessment" WHERE public.valid_ingestion_project_reassessment(id) IS NOT TRUE')).rows[0].n, 0);
  await verifyReassessmentPrivileges(pool);
  const completed = fixture.causes.find((row) => row.state === "COMPLETED"); assert(completed);
  await pool.query("BEGIN");
  try {
    await pool.query("SET LOCAL ROLE pdaa_api");
    await assert.rejects(() => pool.query('UPDATE public."IngestionProjectReassessment" SET state=\'READY\' WHERE id=$1::uuid', [completed.id]));
  } finally { await pool.query("ROLLBACK"); }
  return { populatedStates: ["READY", "BLOCKED", "COMPLETED"], claimedAndUnclaimedReadyRetained: true, exactSchedulerAndLineage: true, immutableCompletionDenied: true, runtimeNotStarted: true };
}
