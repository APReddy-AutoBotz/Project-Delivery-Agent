// Genuine immutable-foundation -> current release upgrade in a disposable database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, config, guard, secret } from "./common.mjs";
import { createPriorReleaseDatabase } from "./prior-schema.mjs";
import { applyPriorFiveBusinessGrants } from "./prior-five-business-grants.mjs";
import { applyPriorSixBusinessGrants } from "./prior-six-business-grants.mjs";
import { verifyStateBindingBirthGuards } from "./state-binding-birth.mjs";
import {
  seedLegacyBindingCollision,
  verifyLegacyBindingCollision,
} from "./legacy-binding-collision.mjs";
import { migrateDatabase } from "../../packages/operations/dist/migrations.js";
import { migrateRelease } from "../../packages/operations/dist/provision.js";
import { engagementStorageTables, verifyEngagementStoragePrivileges } from "./update-engagement-storage.mjs";
import { applyBusinessTableGrants } from "../../packages/operations/dist/business-grants.js";
import {
  CredentialVault,
  loadConfig,
} from "../../packages/platform/dist/index.js";
import {
  projectFactTables,
  projectFactProjection,
  seedProjectFactHistory,
  verifyProjectFactPrivileges,
  verifyImmutableProjectFacts,
} from "./project-facts.mjs";
import {
  authorityTables,
  authorityProjection,
  seedAuthorityHistory,
  verifyAuthorityPrivileges,
  verifyAuthorityImmutable,
  verifyAuthorityIntegrity,
  verifyAssessmentCommitGuards,
} from "./authority-assessments.mjs";
import {
  canonicalTables,
  canonicalProjection,
  seedCanonicalHistory,
  verifyCanonicalPrivileges,
  verifyCanonicalImmutable,
  verifyCanonicalIntegrity,
  verifyCanonicalCommitGuards,
} from "./canonical-projects.mjs";
import {
  milestonePersistenceTables,
  milestonePersistenceProjection,
  seedMilestonePersistence,
  verifyMilestonePersistencePrivileges,
  verifyMilestonePersistenceImmutable,
  verifyMilestonePersistenceIntegrity,
  verifyMilestonePersistenceCommitGuards,
} from "./milestone-persistence.mjs";
import {
  milestoneReconciliationTables,
  milestoneReconciliationProjection,
  seedMilestoneReconciliation,
  seedPriorSixMilestoneReconciliation,
  verifyRetainedPriorSixReconciliation,
  verifyMilestoneReconciliationPrivileges,
  verifyMilestoneReconciliationImmutable,
  verifyMilestoneReconciliationIntegrity,
  verifyMilestoneReconciliationWorkerDenials,
} from "./milestone-reconciliation.mjs";

export async function verifyFoundationUpgrade(
  admin,
  migrations,
  priorCount = 1,
) {
  guard();
  assert([1, 2, 3, 4, 5, 6].includes(priorCount));
  assert.equal(migrations.length, 24);
  assert.equal(migrations[23].name, "202610010001_update_capture_response");
  assert.equal(migrations[21].name, "202609300001_update_engagement_storage");
    assert.equal(migrations[22].name, "202609300002_update_engagement_processing");
  assert.equal(migrations[15].name, "202609280001_atomic_raid_reopen");
  assert.equal(migrations[16].name, "202609280002_blocker_age_threshold");
  assert.equal(migrations[17].name, "202609280003_blocker_age_assessment");
  assert.equal(migrations[18].name, "202609280004_project_update_workflow");
  assert.equal(migrations[19].name, "202609290001_schedule_health_policy");
  assert.equal(migrations[20].name, "202609290002_project_update_cadence");
  assert.equal(migrations[14].name, "202609270001_health_assessment");
  assert.equal(
    migrations[9].name,
    "202609230001_durable_ingestion",
  );
  assert.equal(migrations[10].name, "202609240001_jira_runtime");
  assert.equal(migrations[11].name, "202609240002_jira_webhook_body_replay");
  assert.equal(migrations[13].name, "202609260001_connector_outcome_sync_scope");
  assert.equal(
    migrations[8].name,
    "202609220001_milestone_validation_projection",
  );
  assert.equal(
    migrations[7].name,
    "202609140001_scalar_validation_performance",
  );
  assert.equal(
    migrations[5].name,
    "202609120002_milestone_reconciliation_requests",
  );
  assert.equal(
    migrations[5].checksum,
    "bb3ad235cd2cbb9849650f6814011794a650b21cb7ee1a0f8cc2a5d127e36fdf",
  );
  assert.equal(
    migrations[6].name,
    "202609130001_scalar_reconciliation_requests",
  );
  assert.equal(
    migrations[4].name,
    "202609120001_milestone_consistency_persistence",
  );
  assert.equal(
    migrations[4].checksum,
    "4228440e0a7142b493f05dbcad76536e10d4b4b7da2f407fc393b8d6485a28c1",
  );
  assert.equal(migrations[3].name, "202609110001_canonical_projects");
  assert.equal(
    migrations[3].checksum,
    "6c48d2e8777924ff49089be9aa89e6e98e3f1ea1a89be24bc3fd7150b44cb184",
  );
  assert.equal(migrations[2].name, "202609100001_authority_assessments");
  assert.equal(
    migrations[2].checksum,
    "33fce28b45790d75c6922650336baaa2145c52143dc2dfecbf615224dda3fd3d",
  );
  assert.equal(migrations[1].name, "202609090001_project_facts");
  assert.equal(
    migrations[1].checksum,
    "64defd6bee6d86978f99a360e4f3c19f46b60bc6d8b76bea154c02970cff555e",
  );
  assert.equal(migrations[0].name, "202609060001_foundation");
  assert.equal(
    migrations[0].checksum,
    "9738bed726d754be02fb157ce2ee787def280d5e6e4c5319d778080d8b040aca",
  );
  const database = [
      "migration_upgrade",
      "migration_authority_upgrade",
      "migration_canonical_upgrade",
      "migration_milestone_persistence_upgrade",
      "migration_milestone_reconciliation_upgrade",
      "migration_scalar_reconciliation_upgrade",
    ][priorCount - 1],
    customerId = process.env.CUSTOMER_ID;
  const projectId = randomUUID(),
    portfolioId = randomUUID();
  await admin.query(
    `CREATE DATABASE ${database} OWNER pdaa_migrate TEMPLATE template0`,
  );
  const maintenance = { ...config().database, database };
  const owner = new Pool(maintenance);
  const supervisor = new Pool({
    ...config("database", "fixture_admin", "admin-password").database,
    database,
  });
  const release = {
    database: maintenance,
    customerId,
    customerName: process.env.CUSTOMER_NAME,
    roleFiles: {},
  };
  try {
    await supervisor.query(`COMMENT ON DATABASE ${database} IS 'pdaa.foundation.v1:${customerId}';
      REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${database} TO pdaa_migrate,pdaa_api,pdaa_worker,pdaa_backup;
      ALTER SCHEMA public OWNER TO pdaa_migrate;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO pdaa_api,pdaa_worker,pdaa_backup`);
    await migrateDatabase(maintenance, migrations.slice(0, priorCount));
    await owner.query('INSERT INTO "Customer" VALUES ($1,$2)', [
      customerId,
      process.env.CUSTOMER_NAME,
    ]);
    await owner.query('INSERT INTO "Portfolio" VALUES ($1,$2,$3)', [
      portfolioId,
      customerId,
      "Retained foundation",
    ]);
    await owner.query('INSERT INTO "Project" VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      projectId,
      customerId,
      portfolioId,
      "UPGRADE",
      "Retained project",
      "Synthetic foundation fixture",
      "UNKNOWN",
    ]);
    await owner.query('INSERT INTO "AccessGrant" VALUES ($1,$2,$3,$4,$5,$6)', [
      randomUUID(),
      customerId,
      "foundation-human",
      "project",
      projectId,
      "project_manager",
    ]);
    await owner.query(
      'INSERT INTO "AuditEvent" (id,"customerId",actor,event,"correlationId",detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        customerId,
        "foundation-human",
        "foundation.retained",
        "foundation-upgrade",
        { synthetic: true },
      ],
    );
    const vault = new CredentialVault(loadConfig(process.env).ENCRYPTION_KEY);
    await owner.query(
      'INSERT INTO "ConnectorCredential" (id,"customerId",name,envelope,"keyId") VALUES ($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        customerId,
        "Retained encrypted fixture",
        vault.encrypt(secret("connector-secret"), "foundation-upgrade"),
        "primary",
      ],
    );
    await owner.query('INSERT INTO "ServiceHeartbeat" VALUES ($1,$2)', [
      "foundation-checkpoint",
      "2026-09-09T00:00:00.000Z",
    ]);
    let priorFixture = null;
    let priorAuthorityFixture = null;
    let priorCanonicalFixture = null;
    let legacyBindingFixture = null;
    let priorMilestoneFixture = null;
    let priorReconciliationFixture = null;
    const databaseFactory = (connection) =>
      createPriorReleaseDatabase(connection, priorCount);
    const apiConnection = {
      ...config("database", "pdaa_api", "api-password").database,
      database,
    };
    if (priorCount >= 2) {
      // Exact finite privileges of the prior two-migration release. Its schema
      // genuinely has no authority tables; the current release ACL cannot run yet.
      await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pdaa_api,pdaa_worker,pdaa_backup;
        GRANT SELECT,INSERT,UPDATE,DELETE ON "Customer","Portfolio","Project","AccessGrant","ConnectorCredential" TO pdaa_api;
        GRANT SELECT,INSERT ON "AuditEvent" TO pdaa_api;
        GRANT SELECT ON "ServiceHeartbeat" TO pdaa_api;
        GRANT SELECT,INSERT,UPDATE ON "ServiceHeartbeat" TO pdaa_worker;
        GRANT SELECT,INSERT ON "ProjectFact","FactSource","FactSourceAccess","FactEvidence","ProjectFactVersion","FactAppendReceipt" TO pdaa_api;
        GRANT UPDATE (revision) ON "ProjectFact" TO pdaa_api;
        GRANT UPDATE (state,revision) ON "FactSourceAccess" TO pdaa_api;
        GRANT SELECT,INSERT,DELETE ON "FactSourceReader" TO pdaa_api;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdaa_backup`);
      // All five released migrations are already active here. Their birth
      // guards read authority/binding dependencies during the very first seed.
      if (priorCount === 5) await applyPriorFiveBusinessGrants(owner);
      if (priorCount === 6) await applyPriorSixBusinessGrants(owner);
      priorFixture = await seedProjectFactHistory(
        owner,
        {
          ...config("database", "pdaa_api", "api-password").database,
          database,
        },
        customerId,
        projectId,
        "prior-authority",
        databaseFactory,
      );
      await verifyProjectFactPrivileges(owner);
      await verifyImmutableProjectFacts(owner);
    }
    if (priorCount >= 3) {
      // Released three-migration ACL, before the new canonical tables exist.
      await owner.query(`GRANT SELECT,INSERT ON "AuthorityPolicy","AuthorityPolicyRevision","AuthorityPolicyReceipt","FactAuthorityConflict","FactAssessment","FactAssessmentVersion","FactAssessmentConflict" TO pdaa_api;
        GRANT UPDATE (revision) ON "AuthorityPolicy" TO pdaa_api;
        GRANT UPDATE (sealed) ON "FactAssessment" TO pdaa_api`);
      priorAuthorityFixture = await seedAuthorityHistory(
        owner,
        apiConnection,
        customerId,
        projectId,
        "prior-canonical",
        databaseFactory,
      );
      await verifyAuthorityPrivileges(owner);
      await verifyAuthorityImmutable(owner);
      await verifyAuthorityIntegrity(owner);
    }
    if (priorCount >= 4) {
      await owner.query(`GRANT SELECT,INSERT ON "Programme","CanonicalProject","ProjectResponsibility","Sprint","Milestone","WorkItem","RequiredWorkItem","RaidItem","CanonicalSourceMapping","CanonicalCreationReceipt" TO pdaa_api;
        GRANT UPDATE (sealed) ON "CanonicalProject" TO pdaa_api;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdaa_backup`);
      priorCanonicalFixture = await seedCanonicalHistory(
        owner,
        apiConnection,
        customerId,
        projectId,
        "prior-milestone-persistence",
      );
      await verifyCanonicalPrivileges(owner);
      await verifyCanonicalImmutable(owner);
      await verifyCanonicalIntegrity(owner);
      if (priorCount === 4)
        legacyBindingFixture = await seedLegacyBindingCollision(
          owner,
          apiConnection,
          customerId,
          projectId,
        );
    }
    if (priorCount >= 5) {
      priorMilestoneFixture = await seedMilestonePersistence(
        owner,
        apiConnection,
        customerId,
        priorCanonicalFixture.projectId,
        "prior-reconciliation",
        { databaseFactory, reserveForRestore: true },
      );
      await verifyMilestonePersistencePrivileges(owner);
      await verifyMilestonePersistenceImmutable(owner);
      await verifyMilestonePersistenceIntegrity(owner);
    }
    if (priorCount === 6) {
      priorReconciliationFixture = await seedPriorSixMilestoneReconciliation(
        owner,
        apiConnection,
        customerId,
        priorCanonicalFixture.projectId,
        "prior-scalar-reconciliation",
      );
      await verifyMilestoneReconciliationPrivileges(owner);
      await verifyMilestoneReconciliationImmutable(owner);
      await verifyMilestoneReconciliationIntegrity(owner);
    }
    const oldTables = [
      "Customer",
      "Portfolio",
      "Project",
      "AccessGrant",
      "AuditEvent",
      "ConnectorCredential",
      "ServiceHeartbeat",
      ...(priorCount >= 2 ? projectFactTables : []),
      ...(priorCount >= 3 ? authorityTables : []),
      ...(priorCount >= 4 ? canonicalTables : []),
      ...(priorCount >= 5 ? milestonePersistenceTables : []),
      ...(priorCount >= 6 ? milestoneReconciliationTables : []),
    ];
    // Freeze the old column inventory before adding nullable/defaulted columns.
    // Compare every old value byte-for-value after upgrade, then separately
    // assert the deterministic values of the newly added columns.
    const oldColumns = {};
    for (const table of oldTables)
      oldColumns[table] = (
        await owner.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [table],
        )
      ).rows
        .map(({ column_name }) => '"' + column_name.replaceAll('"', '""') + '"')
        .join(",");
    const oldProjection = async () => {
      const result = {};
      for (const table of oldTables)
        result[table] = (
          await owner.query(
            `SELECT * FROM (SELECT ${oldColumns[table]} FROM "${table}") t ORDER BY to_jsonb(t)::text COLLATE "C"`,
          )
        ).rows;
      return result;
    };
    const fullHistory = async () =>
      (
        await owner.query(
          'SELECT * FROM "_prisma_migrations" ORDER BY migration_name,started_at',
        )
      ).rows;
    const before = await oldProjection(),
      initialHistory = await fullHistory();
    assert.equal(initialHistory.length, priorCount);
    assert(
      oldTables.every((name) => before[name].length > 0),
      "Every prior business table must be populated",
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
        )
      ).rows[0].n,
      oldTables.length + 1,
    );
    const upgradeStarted = performance.now();
    // Stop immediately before cadence migration #21 and retain a genuinely
    // pre-cadence policy revision so the new SQL defaults are exercised.
    // This intermediate fixture is intentionally not the current release.
    // Apply its migrations only; current-release ACLs reference later functions.
    // The final migrateRelease below reconstructs and verifies the complete ACL.
    await migrateDatabase(maintenance, migrations.slice(0, 20));
    const cadenceProbeRevisionId = randomUUID();
    const cadenceProbeChangedAt = "2026-09-28T00:00:00.000Z";
    await owner.query(
      'INSERT INTO "ProjectUpdatePolicy" ("customerId","projectId",key,revision,"changedBy","changedAt") VALUES ($1,$2,\'project-update\',1,$3,$4)',
      [customerId, projectId, "foundation-human", cadenceProbeChangedAt],
    );
    await owner.query(
      'INSERT INTO "ProjectUpdatePolicyRevision" (id,"customerId","projectId",revision,"freshnessWindowSeconds","timeZone","requiredFacts","responsibleSubject","scheduledScanEnabled","scheduledServiceSubject","changedBy","changedAt") VALUES ($1,$2,$3,1,3600,\'UTC\',$4::jsonb,$5,false,NULL,$5,$6)',
      [
        cadenceProbeRevisionId,
        customerId,
        projectId,
        JSON.stringify([{ factType: "project.forecast", label: "Current forecast" }]),
        "foundation-human",
        cadenceProbeChangedAt,
      ],
    );
    const readCadenceProbeLegacy = async () => (
      await owner.query(
        'SELECT id,"customerId","projectId",revision,"freshnessWindowSeconds","timeZone","requiredFacts","responsibleSubject","scheduledScanEnabled","scheduledServiceSubject","changedBy","changedAt" FROM "ProjectUpdatePolicyRevision" WHERE id=$1',
        [cadenceProbeRevisionId],
      )
    ).rows[0];
    const cadenceProbeLegacyBefore = await readCadenceProbeLegacy();
    const applied = await migrateRelease(release, migrations);
    const upgradeElapsedMs = performance.now() - upgradeStarted;
    assert.equal(applied.length, migrations.length);
    const projectUpdateCadenceDefaults = (
      await owner.query(
        'SELECT "reminderBusinessDayOffsets","escalationAfterBusinessDays","escalationRecipientSubject","quietHoursStartLocal","quietHoursEndLocal" FROM "ProjectUpdatePolicyRevision" WHERE id=$1',
        [cadenceProbeRevisionId],
      )
    ).rows[0];
    assert.deepEqual(projectUpdateCadenceDefaults, {
      reminderBusinessDayOffsets: [],
      escalationAfterBusinessDays: 0,
      escalationRecipientSubject: null,
      quietHoursStartLocal: null,
      quietHoursEndLocal: null,
    });
    assert.deepEqual(await readCadenceProbeLegacy(), cadenceProbeLegacyBefore);
    if (priorCount >= 2) {
      // The final additive migration assigns these values to retained legacy
      // human statements; validate them separately from the old-column projection.
      const defaults = (
        await owner.query(`
          SELECT
            (SELECT count(*)::int FROM "FactSource"
              WHERE "sourceType" IS DISTINCT FROM 'human_statement') AS invalid_source_types,
            (SELECT count(*)::int FROM "ProjectFactVersion"
              WHERE "effectiveAtValidated" IS DISTINCT FROM false) AS invalid_validation_markers
        `)
      ).rows[0];
      assert.deepEqual(defaults, {
        invalid_source_types: 0,
        invalid_validation_markers: 0,
      });
    }
    assert.deepEqual(await oldProjection(), before);
    if (priorCount < 5) {
      assert.equal(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM "ProjectFact" WHERE "bindingBirthId" IS NOT NULL',
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM "FactAssessment" WHERE "captureKind"<>\'SCALAR\' OR "milestoneAssessmentId" IS NOT NULL',
          )
        ).rows[0].n,
        0,
      );
    }
    if (priorCount < 6)
      assert.equal(
        (
          await owner.query(
            'SELECT count(*)::int AS n FROM "MilestoneConsistencyAssessment" WHERE "reconciliationCheckId" IS NOT NULL',
          )
        ).rows[0].n,
        0,
      );
    assert.equal(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "FactAssessment" WHERE "scalarReconciliationCheckId" IS NOT NULL',
        )
      ).rows[0].n,
      0,
    );
    const upgradedHistory = await fullHistory();
    assert.deepEqual(upgradedHistory.slice(0, priorCount), initialHistory);
    assert.deepEqual(
      upgradedHistory.map((row) => [row.migration_name, row.checksum]),
      migrations.map((row) => [row.name, row.checksum]),
    );
    const addedTables = [
      ...(priorCount < 2 ? projectFactTables : []),
      ...(priorCount < 3 ? authorityTables : []),
      ...(priorCount < 4 ? canonicalTables : []),
      ...(priorCount < 5 ? milestonePersistenceTables : []),
      ...(priorCount < 6 ? milestoneReconciliationTables : []),
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
      "HealthAssessment",
      "HealthAssessmentCommandReceipt",
      "HealthAssessmentRetentionPolicy",
      "RaidReopenReceipt",
      "BlockerAgeThresholdPolicy",
      "ProjectUpdatePolicy",
      "ProjectUpdatePolicyRevision",
      "ProjectUpdateAssessment",
      "ProjectUpdateObligation",
      "ProjectUpdatePreview",
      "ScheduleHealthPolicyRevision",
      ...engagementStorageTables,
      "ProjectUpdateIssuanceGate", "ProjectUpdateCapturedRequest", "ProjectUpdateInvitation",
      "ProjectUpdateResponse", "ProjectUpdateRequestContent", "ProjectUpdateResponseContent",
    ];
    const emptyAddedTables = addedTables.filter(
      (table) => ![
        "ScheduleHealthPolicyRevision",
        "ProjectUpdatePolicy",
        "ProjectUpdatePolicyRevision",
        "ProjectUpdateIssuanceGate",
      ].includes(table),
    );
    for (const table of emptyAddedTables)
      assert.equal(
        (await owner.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]
          .n,
        0,
      );
    const scheduleHealthPolicyBackfill = (
      await owner.query(`
        SELECT
          (SELECT count(*)::int FROM "Project") AS project_count,
          (SELECT count(*)::int FROM "ScheduleHealthPolicyRevision") AS policy_count,
          (SELECT count(*)::int
            FROM "Project" p
            LEFT JOIN "ScheduleHealthPolicyRevision" r
              ON r."customerId"=p."customerId" AND r."projectId"=p.id
            WHERE r.id IS NULL
              OR r.revision IS DISTINCT FROM 1
              OR r."timeZone" IS DISTINCT FROM 'UTC'
              OR r."defaultMinimumOverdueDays" IS DISTINCT FROM 1
              OR r."targetOverrides" IS DISTINCT FROM '[]'::jsonb
              OR r."changedBy" IS DISTINCT FROM 'SYSTEM_DEFAULT'
          ) AS invalid_defaults
      `)
    ).rows[0];
    assert.equal(scheduleHealthPolicyBackfill.policy_count, scheduleHealthPolicyBackfill.project_count);
    assert.equal(scheduleHealthPolicyBackfill.invalid_defaults, 0);
    const legacyOccupiedBindingCollision = legacyBindingFixture
      ? await verifyLegacyBindingCollision(
          owner,
          apiConnection,
          legacyBindingFixture,
        )
      : null;
    await verifyProjectFactPrivileges(owner);
    const fixture =
      priorFixture ??
      (await seedProjectFactHistory(
        owner,
        {
          ...config("database", "pdaa_api", "api-password").database,
          database,
        },
        customerId,
        projectId,
        "upgraded",
      ));
    await verifyImmutableProjectFacts(owner);
    await verifyAuthorityPrivileges(owner);
    const authorityFixture =
      priorAuthorityFixture ??
      (await seedAuthorityHistory(
        owner,
        {
          ...config("database", "pdaa_api", "api-password").database,
          database,
        },
        customerId,
        projectId,
        "upgrade-" + priorCount,
      ));
    await verifyAuthorityImmutable(owner);
    await verifyAuthorityIntegrity(owner);
    const commitGuards = await verifyAssessmentCommitGuards(owner);
    const canonicalFixture =
      priorCanonicalFixture ??
      (await seedCanonicalHistory(
        owner,
        apiConnection,
        customerId,
        projectId,
        "upgrade-" + priorCount,
      ));
    await verifyCanonicalPrivileges(owner);
    await verifyCanonicalImmutable(owner);
    await verifyCanonicalIntegrity(owner);
    const canonicalCommitGuards = await verifyCanonicalCommitGuards(owner);
    const milestonePersistenceFixture =
      priorMilestoneFixture ??
      (await seedMilestonePersistence(
        owner,
        apiConnection,
        customerId,
        canonicalFixture.projectId,
        "upgrade-" + priorCount,
      ));
    if (priorMilestoneFixture) {
      const runtime = new Pool(apiConnection);
      try {
        const commitGuards = await verifyMilestonePersistenceCommitGuards(
          runtime,
          { assessmentId: priorMilestoneFixture.assessmentId },
        );
        commitGuards.bindingBirthGuards = await verifyStateBindingBirthGuards(
          runtime,
          priorMilestoneFixture.restoreBindingBirthProbe,
        );
        milestonePersistenceFixture.commitGuards = commitGuards;
      } finally {
        await runtime.end();
      }
    }
    await verifyMilestonePersistencePrivileges(owner);
    await verifyMilestonePersistenceImmutable(owner);
    await verifyMilestonePersistenceIntegrity(owner);
    const priorReconciliationRetention = priorReconciliationFixture
      ? await verifyRetainedPriorSixReconciliation(
          owner,
          apiConnection,
          priorReconciliationFixture,
        )
      : null;
    const milestoneReconciliationFixture = await seedMilestoneReconciliation(
      owner,
      apiConnection,
      customerId,
      canonicalFixture.projectId,
      "upgrade-reconciliation-" + priorCount,
    );
    await verifyMilestoneReconciliationPrivileges(owner);
    await verifyMilestoneReconciliationImmutable(owner);
    await verifyMilestoneReconciliationIntegrity(owner);
    const milestoneReconciliationWorkerDenied =
      await verifyMilestoneReconciliationWorkerDenials({
        ...config("database", "pdaa_worker", "worker-password").database,
        database,
      });
    const milestoneReconciliationPopulated =
      await milestoneReconciliationProjection(owner);
    const milestonePersistencePopulated =
      await milestonePersistenceProjection(owner);
    const canonicalPopulated = await canonicalProjection(owner);
    const authorityPopulated = await authorityProjection(owner);
    const populated = await projectFactProjection(owner);
    const retained = await oldProjection();
    await migrateRelease(release, migrations);
    assert.deepEqual(await fullHistory(), upgradedHistory);
    assert.deepEqual(await oldProjection(), retained);
    assert.deepEqual(await projectFactProjection(owner), populated);
    assert.deepEqual(await authorityProjection(owner), authorityPopulated);
    assert.deepEqual(await canonicalProjection(owner), canonicalPopulated);
    assert.deepEqual(
      await milestonePersistenceProjection(owner),
      milestonePersistencePopulated,
    );
    await verifyEngagementStoragePrivileges(owner);
    assert.deepEqual(
      await milestoneReconciliationProjection(owner),
      milestoneReconciliationPopulated,
    );
    await assert.rejects(
      () =>
        migrateRelease(
          {
            ...release,
            database: {
              ...config("database", "pdaa_backup", "backup-password").database,
              database,
            },
          },
          migrations,
        ),
      /Migration owner required/,
    );
    await supervisor.query('ALTER TABLE "FactSource" OWNER TO fixture_admin');
    try {
      await assert.rejects(
        () => migrateRelease(release, migrations),
        /Unexpected business table owner/,
      );
    } finally {
      await supervisor.query('ALTER TABLE "FactSource" OWNER TO pdaa_migrate');
    }
    // Owner-issued column grants must be removed as well as whole-table grants.
    await owner.query(
      'GRANT SELECT ("originalStatement") ON "FactEvidence" TO pdaa_worker; GRANT UPDATE ("id") ON "ProjectFact" TO pdaa_api',
    );
    assert.equal(
      (
        await owner.query(
          `SELECT has_column_privilege('pdaa_worker','"FactEvidence"','originalStatement','SELECT') AS allowed`,
        )
      ).rows[0].allowed,
      true,
    );
    await applyBusinessTableGrants(owner);
    assert.equal(
      (
        await owner.query(
          `SELECT has_column_privilege('pdaa_worker','"FactEvidence"','originalStatement','SELECT') AS allowed`,
        )
      ).rows[0].allowed,
      false,
    );
    await verifyProjectFactPrivileges(owner);
    for (const table of authorityTables)
      await owner.query(
        `GRANT SELECT ("customerId") ON "${table}" TO pdaa_worker`,
      );
    await applyBusinessTableGrants(owner);
    await verifyAuthorityPrivileges(owner);
    for (const table of canonicalTables)
      await owner.query(
        `GRANT SELECT ("customerId") ON "${table}" TO pdaa_worker`,
      );
    await owner.query(
      'GRANT UPDATE ("createdBy") ON "CanonicalProject" TO pdaa_api',
    );
    await applyBusinessTableGrants(owner);
    await verifyCanonicalPrivileges(owner);
    await verifyMilestonePersistencePrivileges(owner);
    // Reapplication must remove new-table and ownership-column privilege drift.
    for (const table of milestoneReconciliationTables)
      await owner.query(
        `GRANT SELECT ("customerId") ON "${table}" TO pdaa_worker`,
      );
    await owner.query(
      'GRANT UPDATE ("createdBy") ON "MilestoneReconciliationRequest" TO pdaa_api; GRANT UPDATE ("reconciliationCheckId") ON "MilestoneConsistencyAssessment" TO pdaa_api',
    );
    await applyBusinessTableGrants(owner);
    await verifyMilestoneReconciliationPrivileges(owner);
    assert.deepEqual(
      await milestoneReconciliationProjection(owner),
      milestoneReconciliationPopulated,
    );
    assert.deepEqual(await canonicalProjection(owner), canonicalPopulated);
    assert.deepEqual(
      await milestonePersistenceProjection(owner),
      milestonePersistencePopulated,
    );
    assert.deepEqual(await authorityProjection(owner), authorityPopulated);
    assert.deepEqual(await projectFactProjection(owner), populated);
    assert(
      vault.decrypt(
        (await owner.query('SELECT envelope FROM "ConnectorCredential"'))
          .rows[0].envelope,
        "foundation-upgrade",
      ) === secret("connector-secret"),
      "Retained encrypted credential must match the generated fixture",
    );
    return {
      status: "passed",
      foundationChecksum: migrations[0].checksum,
      migrations: upgradedHistory.map((row) => ({
        name: row.migration_name,
        checksum: row.checksum,
      })),
      // NFR-REL-001/002: original ledger timing and fixture size, not a
      // production-scale or concurrent-write availability claim.
      upgradeMeasurement: {
        elapsedMs: upgradeElapsedMs,
        priorProjectFactVersionRows: before.ProjectFactVersion?.length ?? 0,
        appliedLedgerRows: upgradedHistory.slice(priorCount),
      },
      retainedFoundationTables: oldTables,
      emptyAddedTablesAfterUpgrade: emptyAddedTables,
      scheduleHealthPolicyBackfill,
      projectUpdateCadenceDefaults,
      scheduleHealthPolicyTables: ["ScheduleHealthPolicyRevision"],
      priorMigrationCount: priorCount,
      retainedPriorLedgerRows: initialHistory,
      retainedPriorBusinessTables: oldTables,
      retainedPriorRowCounts: Object.fromEntries(
        Object.entries(before).map(([table, rows]) => [table, rows.length]),
      ),
      authorityFixture,
      authorityCommitGuards: commitGuards,
      canonicalFixture,
      milestonePersistenceFixture,
      milestoneReconciliationFixture,
      priorReconciliationRetention,
      milestoneReconciliationWorkerDenied,
      milestoneReconciliationTables,
      milestoneReconciliationRows: Object.fromEntries(
        Object.entries(milestoneReconciliationPopulated).map(([name, rows]) => [
          name,
          rows.length,
        ]),
      ),
      legacyOccupiedBindingCollision,
      canonicalCommitGuards,
      canonicalRows: Object.fromEntries(
        Object.entries(canonicalPopulated).map(([name, rows]) => [
          name,
          rows.length,
        ]),
      ),
      businessTableCount: oldTables.length + addedTables.length,
      priorAuthorityRetained: priorCount >= 3,
      priorCanonicalRetained: priorCount >= 4,
      priorMilestoneRetained: priorCount >= 5,
      priorReconciliationRetained: priorCount === 6,
      retainedRows: Object.fromEntries(
        Object.entries(populated).map(([name, rows]) => [name, rows.length]),
      ),
      migrationOwnerUpgrade: true,
      repeatNoReplay: true,
      wrongRoleDenied: true,
      ownershipDriftDenied: true,
      columnGrantDriftRemoved: true,
      encryptedCredentialRetained: true,
      fixture,
    };
  } finally {
    await owner.end();
    await supervisor.end();
  }
}
