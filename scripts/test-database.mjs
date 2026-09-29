import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createDatabase,
  DatabaseHealthAssessmentRepository,
} from "../packages/data/dist/index.js";
import { assertSyntheticDatabaseUrl } from "../packages/platform/dist/index.js";
import { verifyIngestionPrefixNineUpgrade } from "./acceptance/ingestion-prefix-nine-upgrade.mjs";
const source = assertSyntheticDatabaseUrl(
  process.env.PDAA_DATABASE_URL ?? "",
  "pdaa",
);
if (
  process.env.NODE_ENV === "production" ||
  process.env.DATA_MODE !== "synthetic" ||
  !["127.0.0.1", "localhost"].includes(source.hostname) ||
  source.pathname !== "/pdaa"
)
  throw new Error(
    "Database rehearsal requires local synthetic pdaa configuration",
  );
const prefixNineUpgrade = await verifyIngestionPrefixNineUpgrade(
  process.env.PDAA_DATABASE_URL,
);
const evidencePath = "artifacts/database-validation.json";
if (existsSync(evidencePath))
  renameSync(
    evidencePath,
    "artifacts/database-validation-retained-" + randomUUID() + ".json",
  );
const databaseName = "pdaa_test_" + Date.now();
source.pathname = "/postgres";
const creator = createDatabase(source.toString());
await creator.$executeRawUnsafe('CREATE DATABASE "' + databaseName + '"');
await creator.$disconnect();
source.pathname = "/" + databaseName;
const env = { ...process.env, PDAA_DATABASE_URL: source.toString() };
function node(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error("Database validation command failed");
}
node(
  ["../../node_modules/prisma/build/index.js", "migrate", "deploy"],
  process.cwd() + "/packages/data",
);
// INT-DATA-001: explicit clean-schema and migration-ledger evidence.
const migrated = createDatabase(source.toString());
let ledger;
try {
  const tables =
    await migrated.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  const expectedTables = [
    "Customer",
    "Portfolio",
    "Project",
    "AccessGrant",
    "AuditEvent",
    "ConnectorCredential",
    "ServiceHeartbeat",
    "ProjectFact",
    "FactSource",
    "FactSourceAccess",
    "FactSourceReader",
    "FactEvidence",
    "ProjectFactVersion",
    "FactAppendReceipt",
    "AuthorityPolicy",
    "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt",
    "FactAuthorityConflict",
    "FactAssessment",
    "FactAssessmentVersion",
    "FactAssessmentConflict",
    "Programme",
    "CanonicalProject",
    "ProjectResponsibility",
    "Sprint",
    "Milestone",
    "WorkItem",
    "RequiredWorkItem",
    "RaidItem",
    "RaidReopenReceipt",
    "CanonicalSourceMapping",
    "CanonicalCreationReceipt",
    "CanonicalStateBinding",
    "CanonicalStateBindingReceipt",
    "MilestoneConsistencyAssessment",
    "MilestoneConsistencyTarget",
    "MilestoneConsistencyContributorVersion",
    "MilestoneReconciliationRequest",
    "MilestoneReconciliationCheck",
    "MilestoneReconciliationAssignment",
    "ScalarReconciliationRequest",
    "ScalarReconciliationCheck",
    "ScalarReconciliationAssignment",
    "IngestionSource",
    "IngestionConfigurationRevision",
    "IngestionConfigurationProject",
    "IngestionConfigurationReader",
    "IngestionRetentionPolicy",
    "IngestionExternalRecord",
    "IngestionFactStream",
    "IngestionSourceRevision",
    "IngestionProposalProjection",
    "IngestionProposalContent",
    "IngestionOperationReceipt",
    "IngestionReceiptProjectScope",
    "IngestionCursorTransition",
    "IngestionRowOutcome",
    "IngestionReviewedImport",
    "IngestionReviewedImportRow",
    "ConnectorSyncGrant",
    "ConnectorSyncJob",
    "ConnectorWebhookReceipt",
    "ConnectorTaskReceipt",
    "IngestionSyncReceiptProjectScope",
    "HealthAssessmentRetentionPolicy",
    "HealthAssessment",
    "HealthAssessmentCommandReceipt",
    "BlockerAgeThresholdPolicy",
    "ProjectUpdatePolicy",
    "ProjectUpdatePolicyRevision",
    "ProjectUpdateAssessment",
    "ProjectUpdateObligation",
    "ProjectUpdatePreview",
    "ScheduleHealthPolicyRevision",
  ];
  assert.deepEqual(
    tables.map((row) => row.tablename).sort(),
    [...expectedTables, "_prisma_migrations"].sort(),
  );
  for (const table of expectedTables)
    assert(
      tables.some((row) => row.tablename === table),
      "Missing foundation table: " + table,
    );
  const [healthPrivileges] = await migrated.$queryRaw`SELECT
      has_table_privilege('pdaa_api','public."HealthAssessment"','SELECT') AS api_assessment_select,
      has_table_privilege('pdaa_api','public."HealthAssessment"','INSERT') AS api_assessment_insert,
      has_table_privilege('pdaa_api','public."HealthAssessment"','UPDATE') AS api_assessment_update,
      has_table_privilege('pdaa_api','public."HealthAssessment"','DELETE') AS api_assessment_delete,
      has_table_privilege('pdaa_api','public."HealthAssessmentCommandReceipt"','SELECT') AS api_receipt_select,
      has_table_privilege('pdaa_api','public."HealthAssessmentCommandReceipt"','INSERT') AS api_receipt_insert,
      has_table_privilege('pdaa_api','public."HealthAssessmentCommandReceipt"','UPDATE') AS api_receipt_update,
      has_table_privilege('pdaa_api','public."HealthAssessmentCommandReceipt"','DELETE') AS api_receipt_delete,
      has_table_privilege('pdaa_api','public."HealthAssessmentRetentionPolicy"','SELECT') AS api_policy_select,
      has_table_privilege('pdaa_api','public."HealthAssessmentRetentionPolicy"','INSERT') AS api_policy_insert,
      has_table_privilege('pdaa_api','public."HealthAssessmentRetentionPolicy"','UPDATE') AS api_policy_update,
      has_table_privilege('pdaa_api','public."HealthAssessmentRetentionPolicy"','DELETE') AS api_policy_delete,
      has_table_privilege('pdaa_api','public."BlockerAgeThresholdPolicy"','SELECT') AS api_threshold_select,
      has_table_privilege('pdaa_api','public."BlockerAgeThresholdPolicy"','INSERT') AS api_threshold_insert,
      has_table_privilege('pdaa_api','public."BlockerAgeThresholdPolicy"','UPDATE') AS api_threshold_update,
      has_table_privilege('pdaa_api','public."BlockerAgeThresholdPolicy"','DELETE') AS api_threshold_delete,
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','SELECT') AS api_schedule_policy_select,
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','INSERT') AS api_schedule_policy_insert,
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','UPDATE') AS api_schedule_policy_update,
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','DELETE') AS api_schedule_policy_delete,
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','SELECT WITH GRANT OPTION') AS api_schedule_policy_grant_option,
      has_table_privilege('pdaa_worker','public."ScheduleHealthPolicyRevision"','SELECT') AS worker_schedule_policy_select,
      has_table_privilege('pdaa_backup','public."ScheduleHealthPolicyRevision"','SELECT') AS backup_schedule_policy_select,
      has_table_privilege('pdaa_worker','public."BlockerAgeThresholdPolicy"','SELECT') AS worker_threshold_select,
      has_table_privilege('pdaa_worker','public."BlockerAgeThresholdPolicy"','INSERT') AS worker_threshold_insert,
      has_table_privilege('pdaa_worker','public."BlockerAgeThresholdPolicy"','UPDATE') AS worker_threshold_update,
      has_table_privilege('pdaa_worker','public."BlockerAgeThresholdPolicy"','DELETE') AS worker_threshold_delete,
      has_function_privilege('pdaa_worker','public.purge_expired_blocker_age_threshold_audit_events()','EXECUTE') AS worker_threshold_purge_execute,
      has_function_privilege('pdaa_api','public.purge_expired_blocker_age_threshold_audit_events()','EXECUTE') AS api_threshold_purge_execute,
      has_table_privilege('pdaa_worker','public."HealthAssessment"','SELECT') AS worker_assessment_select,
      has_table_privilege('pdaa_worker','public."HealthAssessment"','INSERT') AS worker_assessment_insert,
      has_table_privilege('pdaa_worker','public."HealthAssessment"','UPDATE') AS worker_assessment_update,
      has_table_privilege('pdaa_worker','public."HealthAssessment"','DELETE') AS worker_assessment_delete,
      has_table_privilege('pdaa_worker','public."HealthAssessmentCommandReceipt"','SELECT') AS worker_receipt_select,
      has_table_privilege('pdaa_worker','public."HealthAssessmentCommandReceipt"','INSERT') AS worker_receipt_insert,
      has_table_privilege('pdaa_worker','public."HealthAssessmentRetentionPolicy"','UPDATE') AS worker_policy_update,
      has_function_privilege('pdaa_worker','public.purge_expired_health_assessments()','EXECUTE') AS worker_purge_execute,
      has_function_privilege('pdaa_api','public.purge_expired_health_assessments()','EXECUTE') AS api_purge_execute`;
  assert.deepEqual(healthPrivileges, {
    api_assessment_select: true,
    api_assessment_insert: true,
    api_assessment_update: false,
    api_assessment_delete: false,
    api_receipt_select: true,
    api_receipt_insert: true,
    api_receipt_update: false,
    api_receipt_delete: false,
    api_policy_select: true,
    api_policy_insert: true,
    api_policy_update: true,
    api_policy_delete: false,
    api_threshold_select: true,
    api_threshold_insert: true,
    api_threshold_update: true,
    api_threshold_delete: false,
    api_schedule_policy_select: true,
    api_schedule_policy_insert: true,
    api_schedule_policy_update: false,
    api_schedule_policy_delete: false,
    api_schedule_policy_grant_option: false,
    worker_schedule_policy_select: false,
    backup_schedule_policy_select: true,
    worker_threshold_select: false,
    worker_threshold_insert: false,
    worker_threshold_update: false,
    worker_threshold_delete: false,
    worker_threshold_purge_execute: true,
    api_threshold_purge_execute: false,
    worker_assessment_select: false,
    worker_assessment_insert: false,
    worker_assessment_update: false,
    worker_assessment_delete: false,
    worker_receipt_select: false,
    worker_receipt_insert: false,
    worker_policy_update: false,
    worker_purge_execute: true,
    api_purge_execute: false,
  });
  const [raidReopenPrivileges] = await migrated.$queryRaw`SELECT
      has_table_privilege('pdaa_api','public."RaidReopenReceipt"','SELECT') AS api_reopen_receipt_select,
      has_table_privilege('pdaa_api','public."RaidReopenReceipt"','INSERT') AS api_reopen_receipt_insert,
      has_table_privilege('pdaa_api','public."RaidReopenReceipt"','UPDATE') AS api_reopen_receipt_update,
      has_table_privilege('pdaa_api','public."RaidReopenReceipt"','DELETE') AS api_reopen_receipt_delete,
      has_table_privilege('pdaa_worker','public."RaidReopenReceipt"','SELECT') AS worker_reopen_receipt_select,
      has_table_privilege('pdaa_worker','public."RaidReopenReceipt"','INSERT') AS worker_reopen_receipt_insert,
      has_table_privilege('pdaa_worker','public."RaidReopenReceipt"','UPDATE') AS worker_reopen_receipt_update,
      has_table_privilege('pdaa_worker','public."RaidReopenReceipt"','DELETE') AS worker_reopen_receipt_delete,
      has_function_privilege('pdaa_api','public.reopen_canonical_raid_item(uuid,uuid,uuid,text,jsonb,text,text,integer,date,timestamptz,text,text,text,text,text)','EXECUTE') AS api_reopen_execute,
      has_function_privilege('pdaa_worker','public.reopen_canonical_raid_item(uuid,uuid,uuid,text,jsonb,text,text,integer,date,timestamptz,text,text,text,text,text)','EXECUTE') AS worker_reopen_execute`;
  assert.deepEqual(raidReopenPrivileges, {
    api_reopen_receipt_select: false,
    api_reopen_receipt_insert: false,
    api_reopen_receipt_update: false,
    api_reopen_receipt_delete: false,
    worker_reopen_receipt_select: false,
    worker_reopen_receipt_insert: false,
    worker_reopen_receipt_update: false,
    worker_reopen_receipt_delete: false,
    api_reopen_execute: true,
    worker_reopen_execute: false,
  });
  ledger =
    await migrated.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name`;
  const names = readdirSync("packages/data/prisma/migrations", {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    ledger.map((row) => row.migration_name),
    names,
  );
  assert(
    ledger.every(
      (row) =>
        /^[a-f0-9]{64}$/.test(row.checksum) &&
        row.finished_at &&
        !row.rolled_back_at &&
        row.applied_steps_count > 0,
    ),
    "Incomplete migration ledger",
  );
  for (const row of ledger)
    assert.equal(
      row.checksum,
      createHash("sha256")
        .update(
          readFileSync(
            "packages/data/prisma/migrations/" +
              row.migration_name +
              "/migration.sql",
          ),
        )
        .digest("hex"),
      "Migration checksum must match original SQL bytes",
    );
} finally {
  await migrated.$disconnect();
}
node(
  ["../../node_modules/prisma/build/index.js", "migrate", "deploy"],
  process.cwd() + "/packages/data",
);
const repeated = createDatabase(source.toString());
try {
  assert.deepEqual(
    await repeated.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name`,
    ledger,
    "Repeat migration changed the completed ledger",
  );
} finally {
  await repeated.$disconnect();
}
node(["packages/data/dist/seed.js"]);

async function verifyHealthAssessmentRetention(databaseUrl) {
  const db = createDatabase(databaseUrl);
  const customerId = randomUUID();
  const portfolioId = randomUUID();
  const projectId = randomUUID();
  const subject = "health-retention-reviewer";
  const policyEventId = randomUUID();
  const policy = {
    contentRetentionHours: 1,
    auditRetentionHours: 48,
    idempotencyRetentionHours: 120,
  };
  const repository = new DatabaseHealthAssessmentRepository(db);
  const actor = { customerId, subject, roles: ["project_manager"] };
  const otherActor = {
    customerId,
    subject: "health-retention-other",
    roles: ["project_manager"],
  };
  const digest = (value) =>
    createHash("sha256").update(value).digest("hex");
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO public."Customer" (id,name) VALUES ($1::uuid,$2)',
      customerId,
      "Synthetic health-retention customer",
    );
    await db.$executeRawUnsafe(
      'INSERT INTO public."Portfolio" (id,"customerId",name) VALUES ($1::uuid,$2::uuid,$3)',
      portfolioId,
      customerId,
      "Synthetic health-retention portfolio",
    );
    await db.$executeRawUnsafe(
      'INSERT INTO public."Project" (id,"customerId","portfolioId",code,name,description,"reportedStatus") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)',
      projectId,
      customerId,
      portfolioId,
      "HLT-" + projectId.slice(0, 8),
      "Synthetic health-retention project",
      "Isolated worker-retention fixture",
      "UNKNOWN",
    );
    await db.$executeRawUnsafe(
      'INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6)',
      randomUUID(),
      customerId,
      subject,
      "project",
      projectId,
      "project_manager",
    );
    await db.$executeRawUnsafe(
      'INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6)',
      randomUUID(),
      customerId,
      otherActor.subject,
      "project",
      projectId,
      "project_manager",
    );
    const policyChangedAt = new Date(Date.now() - 80 * 3600000);
    await db.$executeRawUnsafe(
      'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7)',
      policyEventId,
      customerId,
      "health-retention-admin",
      "health.assessment.retention.changed",
      "health-retention-fixture",
      JSON.stringify({ ...policy, revision: 1 }),
      policyChangedAt,
    );
    await db.$executeRawUnsafe(
      'INSERT INTO public."HealthAssessmentRetentionPolicy" ("customerId","contentRetentionHours","auditRetentionHours","idempotencyRetentionHours",revision,"changedBy","auditEventId","changedAt") VALUES ($1::uuid,$2,$3,$4,1,$5,$6::uuid,$7)',
      customerId,
      policy.contentRetentionHours,
      policy.auditRetentionHours,
      policy.idempotencyRetentionHours,
      "health-retention-admin",
      policyEventId,
      policyChangedAt,
    );

    const overdueWorkItemId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO public."CanonicalProject" (id,"customerId","portfolioId","createdBy","responsibilitiesCount","sprintsCount","milestonesCount","workItemsCount","requiredWorkItemsCount","raidItemsCount","sourceMappingsCount") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,0,0,0,1,0,0,0)',
        projectId,
        customerId,
        portfolioId,
        "health-retention-fixture",
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."WorkItem" (id,"customerId","projectId",key,title,state,"plannedEnd") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)',
        overdueWorkItemId,
        customerId,
        projectId,
        "HLT-WI-OVERDUE",
        "Synthetic overdue work item",
        "OPEN",
        new Date("2000-01-01T00:00:00.000Z"),
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."CanonicalCreationReceipt" (id,"customerId","portfolioId",subject,"idempotencyKey",operation,"requestHash","projectId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::uuid)',
        randomUUID(),
        customerId,
        portfolioId,
        "health-retention-fixture",
        "health-retention-key",
        "PROJECT",
        digest("health-retention-fixture:" + projectId),
        projectId,
      );
      await tx.$executeRawUnsafe(
        'UPDATE public."CanonicalProject" SET sealed=true WHERE id=$1::uuid',
        projectId,
      );
    });
    const firstAssessmentKey = "first-write-race";
    const [firstWrite, concurrentReplay] = await Promise.all([
      repository.create(actor, projectId, firstAssessmentKey, randomUUID()),
      repository.create(actor, projectId, firstAssessmentKey, randomUUID()),
    ]);
    assert.equal(firstWrite.assessmentId, concurrentReplay.assessmentId);
    assert.deepEqual(
      [firstWrite.replayed, concurrentReplay.replayed].sort(),
      [false, true],
    );
    assert.equal(firstWrite.coverage, "SCHEDULE_AND_BLOCKER_AGE");
    assert.equal(firstWrite.blockerAgeCoverage, "UNASSESSABLE");
    assert.equal(firstWrite.contentAvailable, true);
    assert.equal(firstWrite.result?.blockerAge?.coverage, "UNASSESSABLE");
    assert.equal(firstWrite.result.calculated.status, "RED");
    const storedFirstWrite = await db.$queryRawUnsafe(
      'SELECT h.id AS "assessmentId",h.input,h.result,h."envelopeHash",e.event,e.detail FROM public."HealthAssessment" h JOIN public."AuditEvent" e ON e."customerId"=h."customerId" AND e.event=\'health.assessment.created\' AND e.detail->>\'healthAssessmentId\'=h.id::text WHERE h.id=$1::uuid',
      firstWrite.assessmentId,
    );
    assert.equal(storedFirstWrite.length, 1);
    assert.equal(storedFirstWrite[0]?.event, "health.assessment.created");
    assert.equal(storedFirstWrite[0]?.input.signals[0]?.targetSource.recordId, overdueWorkItemId);
    assert.equal(
      storedFirstWrite[0]?.input.signals[0]?.sourceFacts.find(
        (fact) => fact.field === "selectedDueDate",
      )?.value,
      "2000-01-01",
    );
    assert.equal(storedFirstWrite[0]?.result.calculated.status, "RED");
    assert.equal(
      storedFirstWrite[0]?.detail.healthAssessmentId,
      firstWrite.assessmentId,
    );
    assert.equal(storedFirstWrite[0]?.detail.envelopeHash, firstWrite.envelopeHash);
    await assert.rejects(
      () =>
        repository.create(
          otherActor,
          projectId,
          firstAssessmentKey,
          randomUUID(),
        ),
      (error) => error?.code === "CONFLICT",
    );

    const fixture = async (commandKey, ageHours) => {
      const assessmentId = randomUUID();
      const commandKeyHash = digest(commandKey);
      const assessedAt = new Date(Date.now() - ageHours * 3600000);
      const contentExpiresAt = new Date(assessedAt.getTime() + 3600000);
      const auditExpiresAt = new Date(assessedAt.getTime() + 48 * 3600000);
      const receiptExpiresAt = new Date(assessedAt.getTime() + 120 * 3600000);
      const requestHash = digest(
        JSON.stringify({ operation: "health.assessment", projectId }),
      );
      const input = { privateFixture: commandKey };
      const result = { coverage: "SCHEDULE_ONLY", status: "UNKNOWN" };
      await db.$executeRawUnsafe(
        'INSERT INTO public."HealthAssessment" (id,"customerId","projectId","actorSubject","assessedAt","commandKeyHash","ruleRevision",input,result,"envelopeHash","contentExpiresAt","auditExpiresAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,\'schedule-health@1\',$7::jsonb,$8::jsonb,$9,$10,$11)',
        assessmentId,
        customerId,
        projectId,
        subject,
        assessedAt,
        commandKeyHash,
        JSON.stringify(input),
        JSON.stringify(result),
        digest("envelope:" + commandKey),
        contentExpiresAt,
        auditExpiresAt,
      );
      await db.$executeRawUnsafe(
        'INSERT INTO public."HealthAssessmentCommandReceipt" ("customerId","projectId","commandKeyHash","actorSubject","requestHash","assessmentId","createdAt","expiresAt") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8)',
        customerId,
        projectId,
        commandKeyHash,
        subject,
        requestHash,
        assessmentId,
        assessedAt,
        receiptExpiresAt,
      );
      await db.$executeRawUnsafe(
        'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,\'health.assessment.created\',$4,$5::jsonb,$6)',
        randomUUID(),
        customerId,
        subject,
        "health-retention-fixture",
        JSON.stringify({ healthAssessmentId: assessmentId, projectId }),
        assessedAt,
      );
      return { assessmentId, commandKey, commandKeyHash };
    };
    const redaction = await fixture("redaction-replay", 2);
    const tombstone = await fixture("tombstone-before-idempotency", 80);
    const expiredReceipt = await fixture("expired-receipt", 200);

    const hiddenReplay = await repository.create(
      actor,
      projectId,
      redaction.commandKey,
      randomUUID(),
    );
    assert.equal(hiddenReplay.assessmentId, redaction.assessmentId);
    assert.equal(hiddenReplay.replayed, true);
    assert.equal(hiddenReplay.contentAvailable, false);
    assert.equal(hiddenReplay.input, null);
    assert.equal(hiddenReplay.result, null);
    const beforeRedaction = await db.$queryRawUnsafe(
      'SELECT input,result FROM public."HealthAssessment" WHERE id=$1::uuid',
      redaction.assessmentId,
    );
    assert(beforeRedaction[0]?.input);
    assert(beforeRedaction[0]?.result);

    const purge = async () =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET SESSION AUTHORIZATION "pdaa_worker"',
        );
        const identity = await tx.$queryRawUnsafe(
          "SELECT session_user::text AS role",
        );
        assert.equal(identity[0]?.role, "pdaa_worker");
        const rows = await tx.$queryRawUnsafe(
          "SELECT * FROM public.purge_expired_health_assessments()",
        );
        await tx.$executeRawUnsafe("RESET SESSION AUTHORIZATION");
        return rows[0];
      });
    assert.deepEqual(await purge(), {
      redacted_count: 3,
      purged_assessment_count: 2,
      purged_receipt_count: 1,
    });

    const redacted = await db.$queryRawUnsafe(
      'SELECT input,result,"redactedAt" FROM public."HealthAssessment" WHERE id=$1::uuid',
      redaction.assessmentId,
    );
    assert.equal(redacted[0]?.input, null);
    assert.equal(redacted[0]?.result, null);
    assert(redacted[0]?.redactedAt instanceof Date);
    const policyRow = await db.$queryRawUnsafe(
      'SELECT "auditEventId" FROM public."HealthAssessmentRetentionPolicy" WHERE "customerId"=$1::uuid',
      customerId,
    );
    assert.equal(policyRow[0]?.auditEventId, null);
    const expiredPolicyEvents = await db.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM public."AuditEvent" WHERE "customerId"=$1::uuid AND event=\'health.assessment.retention.changed\'',
      customerId,
    );
    assert.equal(expiredPolicyEvents[0]?.count, 0);
    const survivingAssessmentEvents = await db.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM public."AuditEvent" WHERE "customerId"=$1::uuid AND detail->>\'healthAssessmentId\'=$2',
      customerId,
      redaction.assessmentId,
    );
    assert.equal(survivingAssessmentEvents[0]?.count, 2);
    const survivingReceipts = await db.$queryRawUnsafe(
      'SELECT "commandKeyHash" FROM public."HealthAssessmentCommandReceipt" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY "commandKeyHash"',
      customerId,
      projectId,
    );
    assert.deepEqual(
      survivingReceipts.map((row) => row.commandKeyHash.trim()).sort(),
      [
        redaction.commandKeyHash,
        tombstone.commandKeyHash,
        digest(firstAssessmentKey),
      ].sort(),
    );

    const afterRedactionReplay = await repository.create(
      actor,
      projectId,
      redaction.commandKey,
      randomUUID(),
    );
    assert.equal(afterRedactionReplay.assessmentId, redaction.assessmentId);
    assert.equal(afterRedactionReplay.replayed, true);
    assert.equal(afterRedactionReplay.contentAvailable, false);
    assert.equal(afterRedactionReplay.input, null);
    assert.equal(afterRedactionReplay.result, null);
    await assert.rejects(
      () =>
        repository.create(
          actor,
          projectId,
          tombstone.commandKey,
          randomUUID(),
        ),
      (error) => error?.code === "IDEMPOTENCY_RESULT_EXPIRED",
    );
    const expiredReceiptRows = await db.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM public."HealthAssessmentCommandReceipt" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "commandKeyHash"=$3',
      customerId,
      projectId,
      expiredReceipt.commandKeyHash,
    );
    assert.equal(expiredReceiptRows[0]?.count, 0);
    assert.deepEqual(await purge(), {
      redacted_count: 0,
      purged_assessment_count: 0,
      purged_receipt_count: 0,
    });
    await db.$executeRawUnsafe(
      'DELETE FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=$2 AND "scopeId"=$3::uuid',
      customerId,
      subject,
      projectId,
    );
    await assert.rejects(
      () => repository.latest(actor, projectId),
      (error) => error?.code === "DENIED",
    );
    console.log(
      "Health retention database checks passed: content redaction, policy-event expiry, tombstone purge, receipt horizon, replay and repeat sweep.",
    );
  } finally {
    await db.$disconnect();
  }
}
await verifyHealthAssessmentRetention(source.toString());

node([
  "node_modules/vitest/vitest.mjs",
  "run",
  "tests/database.integration.test.ts",
  "tests/project-facts.integration.test.ts",
  "tests/authority-persistence.integration.test.ts",
  "tests/blocker-age-assessment.integration.test.ts",
  "tests/canonical-project.integration.test.ts",
  "tests/milestone-persistence.integration.test.ts",
  "tests/milestone-reconciliation.integration.test.ts",
  "tests/scalar-reconciliation.integration.test.ts",
  "tests/ingestion-persistence.integration.test.ts",
  "tests/connector-runtime.integration.test.ts",
  "tests/project-evidence.integration.test.ts",
  "--no-file-parallelism",
]);
console.log(
  "Isolated database migration, repeat deployment, seed and integration checks passed.",
);
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  evidencePath,
  JSON.stringify(
    {
      testId: "INT-DATA-001",
      databaseName,
      foundationTables: 7,
      projectFactTables: [
        "ProjectFact",
        "FactSource",
        "FactSourceAccess",
        "FactSourceReader",
        "FactEvidence",
        "ProjectFactVersion",
        "FactAppendReceipt",
      ],
      authorityTables: [
        "AuthorityPolicy",
        "AuthorityPolicyRevision",
        "AuthorityPolicyReceipt",
        "FactAuthorityConflict",
        "FactAssessment",
        "FactAssessmentVersion",
        "FactAssessmentConflict",
      ],
      canonicalTables: [
        "Programme",
        "CanonicalProject",
        "ProjectResponsibility",
        "Sprint",
        "Milestone",
        "WorkItem",
        "RequiredWorkItem",
        "RaidItem",
        "CanonicalSourceMapping",
        "CanonicalCreationReceipt",
      ],
      milestonePersistenceTables: [
        "CanonicalStateBinding",
        "CanonicalStateBindingReceipt",
        "MilestoneConsistencyAssessment",
        "MilestoneConsistencyTarget",
        "MilestoneConsistencyContributorVersion",
      ],
      canonicalRepositoryChecks: "passed",
      milestonePersistenceChecks: "passed",
      milestoneReconciliationTables: [
        "MilestoneReconciliationRequest",
        "MilestoneReconciliationCheck",
        "MilestoneReconciliationAssignment",
      ],
      milestoneReconciliationChecks: "passed",
      evidenceHttpChecks: "passed",
      scalarReconciliationTables: [
        "ScalarReconciliationRequest",
        "ScalarReconciliationCheck",
        "ScalarReconciliationAssignment",
      ],
      scalarReconciliationChecks: "passed",
      ingestionTables: [
        "IngestionSource",
        "IngestionConfigurationRevision",
        "IngestionConfigurationProject",
        "IngestionConfigurationReader",
        "IngestionRetentionPolicy",
        "IngestionExternalRecord",
        "IngestionFactStream",
        "IngestionSourceRevision",
        "IngestionProposalProjection",
        "IngestionProposalContent",
        "IngestionOperationReceipt",
        "IngestionReceiptProjectScope",
        "IngestionCursorTransition",
        "IngestionRowOutcome",
        "IngestionReviewedImport",
        "IngestionReviewedImportRow",
        "ConnectorSyncGrant",
        "ConnectorSyncJob",
        "ConnectorWebhookReceipt",
        "ConnectorTaskReceipt",
        "IngestionSyncReceiptProjectScope",
      ],
      ingestionPersistenceChecks: "passed",
      prefixNineUpgrade,
      raidReopenTables: ["RaidReopenReceipt"],
      blockerAgeThresholdTables: ["BlockerAgeThresholdPolicy"],
      projectUpdateTables: [
        "ProjectUpdatePolicy",
        "ProjectUpdatePolicyRevision",
        "ProjectUpdateAssessment",
        "ProjectUpdateObligation",
        "ProjectUpdatePreview",
      ],
      businessTables: 73,
      healthAssessmentRetentionChecks: "passed",
      authorityRepositoryChecks: "passed",
      projectFactRepositoryChecks: "passed",
      migrations: ledger.map((row) => ({
        name: row.migration_name,
        checksum: row.checksum,
      })),
      repeatUnchanged: true,
      completedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
