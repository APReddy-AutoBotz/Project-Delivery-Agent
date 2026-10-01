import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDatabase } from "../../packages/data/dist/index.js";
import { assertSyntheticDatabaseUrl } from "../../packages/platform/dist/index.js";
import {
  migrateDatabase,
  readMigrations,
} from "../../packages/operations/dist/index.js";
import { engagementStorageTables, verifyEngagementStoragePrivileges } from "./update-engagement-storage.mjs";
import { applyBusinessTableGrants } from "../../packages/operations/dist/business-grants.js";

const { Pool } = createRequire(
  new URL("../../packages/data/package.json", import.meta.url),
)("pg");
const ingestionTables = [
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
];
const jiraRuntimeTables = [
  "ConnectorSyncGrant",
  "ConnectorSyncJob",
  "ConnectorWebhookReceipt",
  "ConnectorTaskReceipt",
  "IngestionSyncReceiptProjectScope",
];
const healthAssessmentTables = [
  "HealthAssessmentRetentionPolicy",
  "HealthAssessment",
  "HealthAssessmentCommandReceipt",
];
const projectUpdateTables = [
  "ProjectUpdatePolicy",
  "ProjectUpdatePolicyRevision",
  "ProjectUpdateAssessment",
  "ProjectUpdateObligation",
  "ProjectUpdatePreview",
];
const introducedTables = [
  ...ingestionTables,
  ...jiraRuntimeTables,
  ...healthAssessmentTables,
  ...projectUpdateTables,
  ...engagementStorageTables,
  "RaidReopenReceipt",
  "BlockerAgeThresholdPolicy",
  "ScheduleHealthPolicyRevision",
];

async function assignSyntheticTableOwners(pool) {
  await pool.query(`DO $owners$ DECLARE item record; BEGIN
    FOR item IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    LOOP
      EXECUTE format('ALTER TABLE %I.%I OWNER TO pdaa_migrate','public',item.relname);
    END LOOP;
  END $owners$`);
}

export async function verifyIngestionPrefixNineUpgrade(sourceUrl) {
  const base = assertSyntheticDatabaseUrl(sourceUrl, "pdaa");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATA_MODE !== "synthetic" ||
    !["127.0.0.1", "localhost"].includes(base.hostname) ||
    base.pathname !== "/pdaa"
  )
    throw new Error("Prefix-nine upgrade requires local synthetic configuration");

  const databaseName = "pdaa_upgrade9_" + Date.now();
  if (!/^pdaa_upgrade9_[0-9]+$/.test(databaseName))
    throw new Error("Invalid isolated prefix-nine database name");
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const admin = createDatabase(adminUrl.toString());
  let prior;
  let pool;
  try {
    for (const role of ["pdaa_migrate", "pdaa_api", "pdaa_worker", "pdaa_backup"])
      await admin.$executeRawUnsafe(`DO $roles$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $roles$`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = "/" + databaseName;
    const databaseConfig = {
      host: databaseUrl.hostname,
      port: Number(databaseUrl.port),
      database: databaseName,
      user: decodeURIComponent(databaseUrl.username),
      password: decodeURIComponent(databaseUrl.password),
      ssl: false,
    };
    const migrations = readMigrations("packages/data/prisma/migrations");
    assert.equal(migrations.length, 23);
    assert.equal(migrations[21].name, "202609300001_update_engagement_storage");
    assert.equal(migrations[22].name, "202609300002_update_engagement_processing");
    assert.equal(migrations[8].name, "202609220001_milestone_validation_projection");
    assert.equal(migrations[9].name, "202609230001_durable_ingestion");
    assert.equal(migrations[10].name, "202609240001_jira_runtime");
    assert.equal(migrations[12].name, "202609250001_reviewed_csv_import");
    assert.equal(migrations[13].name, "202609260001_connector_outcome_sync_scope");
    assert.equal(migrations[14].name, "202609270001_health_assessment");
    assert.equal(migrations[15].name, "202609280001_atomic_raid_reopen");
    assert.equal(migrations[16].name, "202609280002_blocker_age_threshold");
    assert.equal(migrations[17].name, "202609280003_blocker_age_assessment");
    assert.equal(migrations[18].name, "202609280004_project_update_workflow");
    assert.equal(migrations[19].name, "202609290001_schedule_health_policy");
    assert.equal(migrations[20].name, "202609290002_project_update_cadence");
    assert.equal(migrations[11].name, "202609240002_jira_webhook_body_replay");
    await migrateDatabase(databaseConfig, migrations.slice(0, 9));
    pool = new Pool(databaseConfig);
    await assignSyntheticTableOwners(pool);

    prior = createDatabase(databaseUrl.toString());
    const customerId = randomUUID();
    const portfolioId = randomUUID();
    const projectId = randomUUID();
    const grantId = randomUUID();
    await prior.customer.create({
      data: { id: customerId, name: "Prefix-nine retained customer" },
    });
    await prior.portfolio.create({
      data: { id: portfolioId, customerId, name: "Prefix-nine portfolio" },
    });
    await prior.project.create({
      data: {
        id: projectId,
        customerId,
        portfolioId,
        code: "P9-" + projectId.slice(0, 8),
        name: "Prefix-nine project",
        description: "Populated released-nine upgrade fixture",
        reportedStatus: "UNKNOWN",
      },
    });
    await prior.accessGrant.create({
      data: {
        id: grantId,
        customerId,
        subject: "prefix-nine-manager",
        scopeType: "project",
        scopeId: projectId,
        role: "project_manager",
      },
    });
    await prior.auditEvent.create({
      data: {
        id: randomUUID(),
        customerId,
        actor: "prefix-nine-manager",
        event: "prefix9.fixture.created",
        correlationId: "prefix-nine-upgrade-fixture",
        detail: { fixture: true },
      },
    });

    const beforeTables = (
      await prior.$queryRaw`
        SELECT tablename FROM pg_tables
        WHERE schemaname='public' AND tablename<>'_prisma_migrations'
        ORDER BY tablename`
    ).map((row) => row.tablename);
    assert.equal(beforeTables.length, 42);
    assert(introducedTables.every((table) => !beforeTables.includes(table)));
    const beforeLedger = await prior.$queryRaw`SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name`;
    assert.equal(beforeLedger.length, 9);

    const beforeRows = new Map();
    for (const table of beforeTables) {
      assert.match(table, /^[A-Za-z0-9_]+$/);
      beforeRows.set(
        table,
        await prior.$queryRawUnsafe(
          `SELECT to_jsonb(t)::text AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
        ),
      );
    }

    await migrateDatabase(databaseConfig, migrations);
    await assignSyntheticTableOwners(pool);
    await applyBusinessTableGrants(pool);
    const after = createDatabase(databaseUrl.toString());
    try {
      const afterTables = (
        await after.$queryRaw`
          SELECT tablename FROM pg_tables
          WHERE schemaname='public' AND tablename<>'_prisma_migrations'
          ORDER BY tablename`
      ).map((row) => row.tablename);
      const replayIndexes = await after.$queryRaw`
        SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename='ConnectorWebhookReceipt'
          AND indexname='ConnectorWebhookReceipt_payload_key'`;
      assert.equal(replayIndexes.length, 1);
      assert.equal(afterTables.length, beforeTables.length + introducedTables.length);
      assert(introducedTables.every((table) => afterTables.includes(table)));
      for (const table of beforeTables) {
        assert(afterTables.includes(table));
        assert.deepEqual(
          await after.$queryRawUnsafe(
            `SELECT to_jsonb(t)::text AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
          ),
          beforeRows.get(table),
          `Released-nine ${table} rows must remain byte-for-byte equivalent`,
        );
      }
      for (const table of introducedTables) {
        const count = (
          await after.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM public."${table}"`,
          )
        )[0].n;
        if (table === "ScheduleHealthPolicyRevision") {
          assert.equal(count, 1, "Each existing project must receive a migration default");
        } else {
          assert.equal(count, 0, `New ${table} must start empty after upgrade`);
        }
      }
      const scheduleDefaults = await after.$queryRaw`
        SELECT revision,"timeZone","defaultMinimumOverdueDays","targetOverrides","changedBy"
        FROM public."ScheduleHealthPolicyRevision"
        WHERE "customerId"=${customerId}::uuid AND "projectId"=${projectId}::uuid
      `;
      assert.equal(scheduleDefaults.length, 1);
      assert.deepEqual(scheduleDefaults[0], {
        revision: 1,
        timeZone: "UTC",
        defaultMinimumOverdueDays: 1,
        targetOverrides: [],
        changedBy: "SYSTEM_DEFAULT",
      });
      const ledger = await after.$queryRaw`SELECT migration_name,checksum FROM "_prisma_migrations" ORDER BY migration_name`;
      assert.deepEqual(ledger.slice(0, 9), beforeLedger);
      assert.deepEqual(
        ledger.map((row) => [row.migration_name, row.checksum]),
        migrations.map(({ name, checksum }) => [name, checksum]),
      );
      await verifyEngagementStoragePrivileges(pool);
      const acl = await pool.query(`SELECT
        has_table_privilege('pdaa_api','public."IngestionOperationReceipt"','SELECT') AS api_read,
        has_table_privilege('pdaa_api','public."IngestionOperationReceipt"','INSERT') AS api_insert,
        has_table_privilege('pdaa_worker','public."IngestionOperationReceipt"','SELECT') AS worker_read,
        has_table_privilege('pdaa_backup','public."IngestionOperationReceipt"','SELECT') AS backup_read,
        has_column_privilege('pdaa_api','public."IngestionSource"','cursorEnvelope','UPDATE') AS api_cursor_update,
        has_column_privilege('pdaa_api','public."IngestionSource"','origin','UPDATE') AS api_origin_update,
        has_function_privilege('pdaa_api','public.valid_ingestion_receipt(uuid)','EXECUTE') AS api_receipt_validator`);
      assert.deepEqual(acl.rows, [
        {
          api_read: true,
          api_insert: true,
          worker_read: false,
          backup_read: true,
          api_cursor_update: true,
          api_origin_update: false,
          api_receipt_validator: true,
        },
      ]);
      const reviewedAcl = await pool.query(`SELECT
        has_table_privilege('pdaa_api','public."IngestionReviewedImport"','SELECT') AS api_review_read,
        has_table_privilege('pdaa_api','public."IngestionReviewedImport"','INSERT') AS api_review_insert,
        has_table_privilege('pdaa_worker','public."IngestionReviewedImport"','SELECT') AS worker_review_read,
        has_table_privilege('pdaa_backup','public."IngestionReviewedImport"','SELECT') AS backup_review_read,
        has_table_privilege('pdaa_api','public."IngestionReviewedImportRow"','INSERT') AS api_link_insert,
        has_table_privilege('pdaa_worker','public."IngestionReviewedImportRow"','SELECT') AS worker_link_read,
        has_table_privilege('pdaa_backup','public."IngestionReviewedImportRow"','SELECT') AS backup_link_read`);
      assert.deepEqual(reviewedAcl.rows, [{
        api_review_read: true,
        api_review_insert: true,
        worker_review_read: false,
        backup_review_read: true,
        api_link_insert: true,
        worker_link_read: false,
        backup_link_read: true,
      }]);
      const healthAcl = await pool.query(`SELECT
        has_table_privilege('pdaa_api','public."HealthAssessment"','SELECT') AS api_assessment_read,
        has_table_privilege('pdaa_api','public."HealthAssessment"','INSERT') AS api_assessment_insert,
        has_table_privilege('pdaa_api','public."HealthAssessment"','UPDATE') AS api_assessment_update,
        has_table_privilege('pdaa_api','public."HealthAssessment"','DELETE') AS api_assessment_delete,
        has_table_privilege('pdaa_api','public."HealthAssessmentCommandReceipt"','UPDATE') AS api_receipt_update,
        has_table_privilege('pdaa_api','public."HealthAssessmentRetentionPolicy"','UPDATE') AS api_policy_update,
        has_table_privilege('pdaa_worker','public."HealthAssessment"','SELECT') AS worker_assessment_read,
        has_table_privilege('pdaa_worker','public."HealthAssessment"','INSERT') AS worker_assessment_insert,
        has_table_privilege('pdaa_worker','public."HealthAssessment"','UPDATE') AS worker_assessment_update,
        has_table_privilege('pdaa_worker','public."HealthAssessmentCommandReceipt"','DELETE') AS worker_receipt_delete,
        has_table_privilege('pdaa_worker','public."HealthAssessmentRetentionPolicy"','UPDATE') AS worker_policy_update,
        has_function_privilege('pdaa_worker','public.purge_expired_health_assessments()','EXECUTE') AS worker_purge_execute,
        has_function_privilege('pdaa_api','public.purge_expired_health_assessments()','EXECUTE') AS api_purge_execute`);
      assert.deepEqual(healthAcl.rows, [{
        api_assessment_read: true,
        api_assessment_insert: true,
        api_assessment_update: false,
        api_assessment_delete: false,
        api_receipt_update: false,
        api_policy_update: true,
        worker_assessment_read: false,
        worker_assessment_insert: false,
        worker_assessment_update: false,
        worker_receipt_delete: false,
        worker_policy_update: false,
        worker_purge_execute: true,
        api_purge_execute: false,
      }]);
      return {
        databaseName,
        status: "passed",
        priorMigrationCount: 9,
        retainedTableCount: beforeTables.length,
        retainedRowTables: beforeTables.filter((table) => beforeRows.get(table).length > 0),
        businessTableCount: afterTables.length,
        addedMigrations: ledger.slice(9).map((row) => row.migration_name),
        introducedTablesEmpty: true,
        finiteIngestionAcl: true,
        finiteHealthAssessmentAcl: true,
      };
    } finally {
      await after.$disconnect();
    }
  } finally {
    if (pool) await pool.end();
    if (prior) await prior.$disconnect();
    await admin.$disconnect();
  }
}

