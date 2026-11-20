// EXEC-019 / NFR-REL-001: populate released migration 24, then retain its fence.
import assert from "node:assert/strict";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { createDatabase, DatabaseCanonicalProjectRepository, DatabaseIngestionRepository,
  DatabaseConnectorRuntimeRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { assertSyntheticDatabaseUrl, CredentialVault, CredentialKeyRingVault } from "../../packages/platform/dist/index.js";
import { readMigrations, migrateDatabase } from "../../packages/operations/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { claimReassessmentFixtureJob } from "./ingestion-reassessment.mjs";
import { Pool } from "./common.mjs";
import { applyBusinessTableGrants } from "../../packages/operations/dist/business-grants.js";
import {prepareCsvComparisonUpgrade,verifyCsvComparisonUpgrade} from "./csv-comparison-upgrade.mjs";
import {applyReleased27BusinessGrants} from "./prior-twenty-seven-business-grants.mjs";
import { verifyXlsxReceiptCodec } from "./xlsx-receipt-codec.mjs";
export async function verifyIngestionAssuranceUpgrade(sourceUrl) {
  const locator = assertSyntheticDatabaseUrl(sourceUrl, "pdaa");
  assert.equal(process.env.DATA_MODE, "synthetic"); assert.notEqual(process.env.NODE_ENV, "production");
  assert(["127.0.0.1", "localhost"].includes(locator.hostname)); assert.equal(locator.pathname, "/pdaa");
  locator.pathname = "/postgres";
  const creator = createDatabase(locator.toString()), name = "pdaa_upgrade24_" + Date.now();
  assert.match(name, /^pdaa_upgrade24_\d+$/);
  await creator.$executeRawUnsafe('CREATE DATABASE "' + name + '"'); await creator.$disconnect();
  locator.pathname = "/" + name;
  const config = { host: locator.hostname, port: Number(locator.port), database: name,
    user: decodeURIComponent(locator.username), password: decodeURIComponent(locator.password), ssl: false };
  const migrations = readMigrations("packages/data/prisma/migrations");
  assert.equal(migrations.length, 37);
  assert.equal(migrations[28].name, "202611180001_csv_comparison_validation_cost");
  assert.equal(migrations[29].name, "202611190001_xlsx_receipt_codec");
  assert.equal(migrations[30].name, "202611190002_xlsx_source_genesis");
  assert.equal(migrations[31].name, "202611190003_xlsx_preview_context");
  assert.equal(migrations[32].name, "202611190004_xlsx_preview_retry");
  assert.equal(migrations[33].name, "202611190005_xlsx_preview_writer");
  assert.equal(migrations[34].name, "202611190006_xlsx_reviewed_import");
  assert.equal(migrations[35].name, "202611190007_xlsx_preview_receipt_read");
  assert.equal(migrations[36].name, "202611190008_xlsx_source_catalogue");
  await migrateDatabase(config, migrations.slice(0, 24));
  const db = createDatabase(locator.toString());
  // Project released columns explicitly before and after the additive workbook discriminator.
  const readLegacySource = (id) => db.ingestionSource.findUniqueOrThrow({ where:{id}, select:{
    id:true,customerId:true,sourceType:true,origin:true,currentConfigRevision:true,mappingRevision:true,
    cursorRevision:true,syncGeneration:true,cursorEnvelope:true,cursorState:true,healthState:true,healthCode:true,
    healthCheckedAt:true,lastSuccessReceiptId:true,createdAt:true,
  }});
  try {
    const customerId = randomUUID(), portfolioId = randomUUID(), sourceId = randomUUID(), service = "legacy-scanner-" + randomUUID();
    const admin = { customerId, subject: "legacy-pmo-" + randomUUID(), roles: ["pmo_admin"] };
    await db.customer.create({ data: { id: customerId, name: "Synthetic legacy fence" } });
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic legacy fence" } });
    for (const [subject, role] of [[admin.subject, "pmo_admin"], [admin.subject + "-system", "system_admin"]])
      await db.accessGrant.create({ data: { customerId, subject, role, scopeType: "portfolio", scopeId: portfolioId } });
    const { id: projectId } = await new DatabaseCanonicalProjectRepository(db).createProject(admin, canonicalFixture(portfolioId), randomUUID());
    const updates = new DatabaseProjectUpdateRepository(db, service);
    await updates.setPolicy(admin, projectId, { expectedRevision: 0, freshnessWindowSeconds: 86400, timeZone: "UTC",
      requiredFacts: [{ factType: "project.status", label: "Current status" }], responsibleSubject: "synthetic-owner-4",
      scheduledScanEnabled: true, reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0,
      escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null }, randomUUID());
    await db.$executeRaw`UPDATE public."ProjectUpdatePolicy" SET "scheduledScanLastAttemptAt"=clock_timestamp(),
      "scheduledScanNextEligibleAt"=date_trunc('milliseconds',clock_timestamp()+interval '5 minutes') WHERE "projectId"=${projectId}::uuid`;
    const [before] = await db.$queryRaw`SELECT "scheduledScanNextEligibleAt" FROM public."ProjectUpdatePolicy" WHERE "projectId"=${projectId}::uuid`;
    const beforeLedger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    // Populate an actual prior-release source after migration 25, then prove
    // that migration 26 preserves its sealed configuration and authorization.
    await migrateDatabase(config, migrations.slice(0, 25));
    const legacySourceId = randomUUID();
    const legacyIngestion = new DatabaseIngestionRepository(db, new CredentialVault(Buffer.alloc(32, 60).toString("base64")));
    const legacyConfiguration = { binding: { customerId, sourceId: legacySourceId, sourceType: "test.tracker", origin: "https://legacy.example" },
      projects: [{ projectId, readers: [admin.subject] }], mapping: { kind: "CONNECTOR", factTypes: ["project.forecast"] } };
    await legacyIngestion.configure(admin, legacyConfiguration, randomUUID());
    await legacyIngestion.configure(admin, { ...legacyConfiguration,
      projects: [{ projectId, readers: [admin.subject, "legacy-extra-reader"] }] }, randomUUID());
    const legacyBefore = {
      source: await readLegacySource(legacySourceId),
      configurations: await db.ingestionConfigurationRevision.findMany({ where: { sourceId: legacySourceId }, orderBy: { revision: "asc" } }),
      projects: await db.ingestionConfigurationProject.findMany({ where: { sourceId: legacySourceId }, orderBy: [{ configRevision: "asc" }, { projectId: "asc" }] }),
      readers: await db.ingestionConfigurationReader.findMany({ where: { sourceId: legacySourceId }, orderBy: [{ configRevision: "asc" }, { projectId: "asc" }, { subject: "asc" }] }),
    };
    const before26Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before26Ledger.length, 25);
    assert.equal(legacyBefore.configurations.length, 2);
    await migrateDatabase(config, migrations.slice(0, 26));
    // A real released-26 policy/audit must survive the additive audit-pointer fix.
    const retentionAdministrator = { ...admin, subject: admin.subject + "-system", roles: ["system_admin"] };
    await legacyIngestion.setRetention(retentionAdministrator, { retentionHours: 24 }, randomUUID());
    const oldRetention = await db.ingestionRetentionPolicy.findUniqueOrThrow({ where: { customerId } });
    const oldRetentionAudit = await db.auditEvent.findUniqueOrThrow({ where: { id: oldRetention.auditEventId } });
    await assert.rejects(legacyIngestion.setRetention(retentionAdministrator, { retentionHours: 48 }, randomUUID()),
      (error) => error?.code === "PERSISTENCE_FAILED");
    assert.deepEqual(await db.ingestionRetentionPolicy.findUniqueOrThrow({ where: { customerId } }), oldRetention);
    assert.deepEqual(await db.auditEvent.findUniqueOrThrow({ where: { id: oldRetention.auditEventId } }), oldRetentionAudit);
    const functionBoundary = () => db.$queryRaw`SELECT p.oid::text AS "functionId",p.proowner::regrole::text AS owner,
      p.prosecdef AS definer,p.proconfig AS settings,p.proacl::text AS acl FROM pg_proc p
      WHERE p.oid='public.guard_ingestion_retention()'::regprocedure`;
    const retentionBoundaryBefore27 = await functionBoundary();
    const before27Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before27Ledger.length, 26);
    await migrateDatabase(config, migrations.slice(0,27));
    assert.deepEqual(await functionBoundary(), retentionBoundaryBefore27);
    assert.deepEqual(await db.ingestionRetentionPolicy.findUniqueOrThrow({ where: { customerId } }), oldRetention);
    assert.equal(await legacyIngestion.setRetention(retentionAdministrator, { retentionHours: 48 }, randomUUID()), 2);
    const retentionAfter27 = await db.ingestionRetentionPolicy.findUniqueOrThrow({ where: { customerId } });
    assert.equal(retentionAfter27.retentionHours, 48);
    assert.equal(retentionAfter27.revision, 2);
    assert.notEqual(retentionAfter27.auditEventId, oldRetention.auditEventId);
    assert.deepEqual(await db.auditEvent.findUniqueOrThrow({ where: { id: oldRetention.auditEventId } }), oldRetentionAudit);
    assert.deepEqual((await db.auditEvent.findUniqueOrThrow({ where: { id: retentionAfter27.auditEventId } })).detail,
      { retentionHours: 48, revision: 2 });
    assert.deepEqual({
      source: await readLegacySource(legacySourceId),
      configurations: await db.ingestionConfigurationRevision.findMany({ where: { sourceId: legacySourceId }, orderBy: { revision: "asc" } }),
      projects: await db.ingestionConfigurationProject.findMany({ where: { sourceId: legacySourceId }, orderBy: [{ configRevision: "asc" }, { projectId: "asc" }] }),
      readers: await db.ingestionConfigurationReader.findMany({ where: { sourceId: legacySourceId }, orderBy: [{ configRevision: "asc" }, { projectId: "asc" }, { subject: "asc" }] }),
    }, legacyBefore);
    const legacyGrantPool=new Pool({connectionString:locator.toString()});
    try {
      await legacyGrantPool.query(`DO $owners$ DECLARE item record; BEGIN
        FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('ALTER TABLE %I.%I OWNER TO pdaa_migrate','public',item.relname); END LOOP;
      END $owners$`);
      await applyReleased27BusinessGrants(legacyGrantPool);
    } finally {await legacyGrantPool.end();}
    const released27 = await prepareCsvComparisonUpgrade(db,legacyIngestion,admin,projectId);
    await migrateDatabase(config,migrations.slice(0,28));
    const csvComparisonUpgrade = await verifyCsvComparisonUpgrade(db,legacyIngestion,admin,projectId,released27);
    const {sourceId:csvSourceId} = released27.cases.find((entry)=>entry.kind === "empty");
    const csvScope = {customerId,sourceId:csvSourceId};
    const csvHeadWhere = {customerId_sourceId:csvScope};
    const csvHead = await db.ingestionCsvHead.findUniqueOrThrow({where:csvHeadWhere});
    assert.equal(csvHead.revision,1n);
    const csvSource = await readLegacySource(csvSourceId);
    const emptyInput = {sourceId:csvSourceId,configRevision:csvSource.currentConfigRevision,
      mappingRevision:csvSource.mappingRevision,commandKey:randomUUID(),fileName:"empty.csv",csv:"Key,Project,Forecast\n"};
    const emptyPreview = await legacyIngestion.persistCsvPreview(admin,emptyInput,randomUUID());
    assert.equal(emptyPreview.rowCount,0);
    const readCsvContexts = () => db.ingestionCsvContext.findMany({where:csvScope,orderBy:{revision:"asc"}});
    const savedContexts = await readCsvContexts();
    assert.equal(savedContexts.length,2);
    assert.equal(savedContexts[0].rows.length,1);
    assert.deepEqual(savedContexts[1].rows,savedContexts[0].rows);
    const savedHead = await db.ingestionCsvHead.findUniqueOrThrow({where:csvHeadWhere});
    const csvFunctionBoundary = () => db.$queryRaw`SELECT p.oid::text AS id,p.proowner::regrole::text AS owner,
      p.prosecdef AS definer,p.provolatile::text AS volatility,p.proconfig AS settings,p.proacl::text AS acl
      FROM pg_proc p WHERE p.oid IN ('public.valid_ingestion_csv_context(uuid)'::regprocedure,
        'public.guard_ingestion_csv_context()'::regprocedure,
        'public.ingestion_csv_state_text(uuid,uuid,integer,jsonb,jsonb)'::regprocedure) ORDER BY p.oid`;
    const savedBoundary = await csvFunctionBoundary();
    assert.equal(savedBoundary.length,3);
    const before29Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before29Ledger.length,28);
    await migrateDatabase(config,migrations.slice(0,29));
    const before30Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    const before30Contexts = await readCsvContexts();
    const before30Head = await db.ingestionCsvHead.findUniqueOrThrow({where:csvHeadWhere});
    assert.equal(before30Ledger.length,29);
    await migrateDatabase(config,migrations.slice(0,30));
    const before31Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before31Ledger.length,30);
    await migrateDatabase(config,migrations.slice(0,31));
    const before32Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before32Ledger.length,31);
    await migrateDatabase(config,migrations.slice(0,32));
    const before33Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before33Ledger.length,32);
    await migrateDatabase(config,migrations.slice(0,33));
    const before34Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before34Ledger.length,33);
    await migrateDatabase(config,migrations.slice(0,34));
    const before35Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before35Ledger.length,34);
    await migrateDatabase(config,migrations.slice(0,35));
    const before36Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before36Ledger.length,35);
    await migrateDatabase(config,migrations.slice(0,36));
    const before37Ledger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.equal(before37Ledger.length,36);
    await migrateDatabase(config,migrations);
    await migrateDatabase(config,migrations);
    assert.deepEqual(await csvFunctionBoundary(),savedBoundary);
    assert.deepEqual(await readCsvContexts(),savedContexts);
    assert.deepEqual(await db.ingestionCsvHead.findUniqueOrThrow({where:csvHeadWhere}),savedHead);
    assert.deepEqual(await readCsvContexts(),before30Contexts);
    assert.deepEqual(await db.ingestionCsvHead.findUniqueOrThrow({where:csvHeadWhere}),before30Head);
    for (const {receiptId} of savedContexts) {
      assert.deepEqual(await db.$queryRaw`SELECT public.valid_ingestion_csv_context(${receiptId}::uuid) AS valid`,[{valid:true}]);
    }
    assert.deepEqual(await legacyIngestion.persistCsvPreview(admin,emptyInput,randomUUID()),{...emptyPreview,replayed:true});
    const carry = await legacyIngestion.persistCsvPreview(admin,{...emptyInput,commandKey:randomUUID()},randomUUID());
    const carryContext = await db.ingestionCsvContext.findUniqueOrThrow({where:{receiptId:carry.receiptId}});
    assert.equal(carryContext.predecessorReceiptId,emptyPreview.receiptId);
    assert.equal(carryContext.stateHash,savedHead.stateHash);
    assert.deepEqual(carryContext.rows,savedContexts[1].rows);
    const advancedHead = await db.ingestionCsvHead.findUniqueOrThrow({where:csvHeadWhere});
    assert.equal(advancedHead.canonicalHistoryBytes,savedHead.canonicalHistoryBytes+BigInt(carryContext.canonicalBytes));
    const csvValidationCostUpgrade = {priorMigrationCount:28,migrationCount:29,retainedPriorChecksums:28,
      preservedPopulatedContexts:2,preservedHead:true,functionBoundaryPreserved:true,repeatAndReplayPassed:true,successorCharged:true};
    const grantPool = new Pool({ connectionString: locator.toString() });
    let xlsxReceiptCodec;
    try {
      await grantPool.query(`DO $owners$ DECLARE item record; BEGIN
        FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')
            AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
        LOOP EXECUTE format('ALTER TABLE %I.%I OWNER TO pdaa_migrate','public',item.relname); END LOOP;
      END $owners$`);
      await applyBusinessTableGrants(grantPool);
      xlsxReceiptCodec = await verifyXlsxReceiptCodec(grantPool);
    } finally { await grantPool.end(); }
    const otherPortfolio = randomUUID(), otherProject = randomUUID(), otherSubject = "upgrade-other-" + randomUUID();
    await db.portfolio.create({ data: { id: otherPortfolio, customerId, name: "Synthetic replacement scope" } });
    await db.project.create({ data: { id: otherProject, customerId, portfolioId: otherPortfolio, code: "UPGRADE-" + otherProject,
      name: "Synthetic replacement scope", description: "Prior-release source fixture", reportedStatus: "UNKNOWN" } });
    await db.accessGrant.createMany({ data: [
      { customerId, subject: otherSubject, scopeType: "project", scopeId: otherProject, role: "pmo_admin" },
      { customerId, subject: admin.subject, scopeType: "project", scopeId: otherProject, role: "pmo_admin" },
    ] });
    const replacement = { ...legacyConfiguration, projects: [{ projectId: otherProject, readers: [admin.subject] }] };
    await assert.rejects(legacyIngestion.configure({ customerId, subject: otherSubject, roles: ["pmo_admin"] }, replacement, randomUUID()),
      (error) => error?.code === "DENIED");
    assert.deepEqual(await readLegacySource(legacySourceId), legacyBefore.source);
    const directAudits = [];
    const directReplace = (subject) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      const [principal] = await tx.$queryRaw`SELECT current_user AS role,
        (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass,
        pg_has_role(current_user,'pdaa_migrate','MEMBER') AS "migrationMember"`;
      assert.deepEqual(principal, { role: "pdaa_api", superuser: false, bypass: false, migrationMember: false });
      const at = new Date(), auditEventId = randomUUID();
      directAudits.push(auditEventId);
      await tx.auditEvent.create({ data: { id: auditEventId, customerId, actor: subject, event: "ingestion.configuration.changed",
        correlationId: randomUUID(), occurredAt: at, detail: { sourceId: legacySourceId, configRevision: 3, mappingRevision: 1 } } });
      await tx.ingestionConfigurationRevision.create({ data: { customerId, sourceId: legacySourceId, revision: 3,
        mappingRevision: 1, mapping: legacyBefore.configurations[1].mapping, changedBy: subject, auditEventId, createdAt: at, sealed: false } });
      await tx.ingestionConfigurationProject.create({ data: { customerId, sourceId: legacySourceId, configRevision: 3, projectId: otherProject } });
      await tx.ingestionConfigurationRevision.update({ where: { customerId_sourceId_revision: { customerId, sourceId: legacySourceId, revision: 3 } }, data: { sealed: true } });
      await tx.ingestionSource.update({ where: { id: legacySourceId }, data: { currentConfigRevision: 3, mappingRevision: 1,
        cursorEnvelope: null, cursorState: "RESET_REQUIRED" } });
    }, { timeout: 20000 });
    await assert.rejects(directReplace(otherSubject), (error) =>
      /requires current PMO project grants/.test(error?.meta?.driverAdapterError?.cause?.originalMessage ?? error?.message ?? ""));
    assert.equal(await db.ingestionConfigurationRevision.count({ where: { sourceId: legacySourceId } }), 2);
    assert.equal(await db.ingestionConfigurationProject.count({ where: { sourceId: legacySourceId, configRevision: 3 } }), 0);
    assert.equal(await db.auditEvent.count({ where: { id: { in: directAudits } } }), 0);
    await directReplace(admin.subject);
    assert.equal((await db.ingestionSource.findUniqueOrThrow({ where: { id: legacySourceId } })).currentConfigRevision, 3);
    const [after] = await db.$queryRaw`SELECT "scheduledScanNextEligibleAt","scanFailureNextEligibleAt","scanClaimGeneration","scanClaimUntil" FROM public."ProjectUpdatePolicy" WHERE "projectId"=${projectId}::uuid`;
    assert.deepEqual(after, { scheduledScanNextEligibleAt: before.scheduledScanNextEligibleAt,
      scanFailureNextEligibleAt: before.scheduledScanNextEligibleAt, scanClaimGeneration: 0, scanClaimUntil: null });
    const key = Buffer.alloc(32, 61).toString("base64"), secret = Buffer.alloc(32, 63).toString("hex");
    const ingestion = new DatabaseIngestionRepository(db, new CredentialVault(key));
    const runtime = new DatabaseConnectorRuntimeRepository(db, new CredentialKeyRingVault({ currentKeyId: "legacy", keys: { legacy: key } }));
    const binding = { customerId, sourceId, sourceType: "jira", origin: "https://legacy.atlassian.net" };
    await ingestion.setRetention({ ...admin, subject: admin.subject + "-system", roles: ["system_admin"] }, { retentionHours: 24 }, randomUUID());
    await ingestion.configure(admin, { binding, projects: [{ projectId, readers: [admin.subject] }], mapping: {
      kind: "CONNECTOR", factTypes: ["jira.status"], adapterConfiguration: JSON.stringify({ projects: [{ projectId, projectKey: "SAFE" }],
        fields: [{ jiraField: "status", factType: "jira.status", valueType: "text" }] }),
    } }, randomUUID());
    await runtime.setWebhookSecret({ customerId, sourceId, actorSubject: admin.subject, secret });
    const rawBody = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated", timestamp: Date.now() }));
    const delivery = await runtime.acceptWebhook({ sourceId, eventId: randomUUID(), rawBody,
      signature: "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex") });
    let job = await claimReassessmentFixtureJob(runtime, customerId, delivery.jobId);
    let state = await ingestion.readConnectorSyncSnapshot(customerId, job.jobId, job.claimGeneration);
    if (state.resetRequired) {
      await ingestion.resetConnectorCursorForJob(customerId, job.jobId, job.claimGeneration);
      job = await claimReassessmentFixtureJob(runtime, customerId, delivery.jobId);
      state = await ingestion.readConnectorSyncSnapshot(customerId, job.jobId, job.claimGeneration);
    }
    const observedAt = new Date().toISOString();
    await ingestion.persistConnectorPageForJob({ customerId, jobId: job.jobId, expectedClaimGeneration: job.claimGeneration,
      expectedConfigRevision: state.configRevision, expectedMappingRevision: state.mappingRevision,
      expectedCursorRevision: state.cursorRevision, expectedGeneration: state.generation,
      page: { binding, inputCursor: null, nextCursor: null, terminal: true, records: [{
        ref: { customerId, sourceId, projectId, recordType: "jira.issue", recordId: "SAFE-1" }, revision: "1",
        sourceContentHash: "1".repeat(64), observedAt, effectiveAt: observedAt, deepLink: binding.origin + "/browse/SAFE-1",
        observations: [{ factType: "jira.status", value: { type: "text", value: "Synthetic legacy proposal" } }],
      }] } });
    const [cause] = await db.ingestionProjectReassessment.findMany({ where: { projectId } });
    assert(cause && cause.availableAt <= new Date());
    assert.equal(await updates.scanScheduledProjects(1), 0);
    assert.deepEqual(await db.ingestionProjectReassessment.findUnique({ where: { id: cause.id } }), cause);
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM public."ProjectUpdateAssessment"`)[0].n, 0);
    // Positive control: preserve the same future periodic timer and clear only
    // the owner-controlled synthetic failure fence. Available causes now bypass
    // periodic timing, proving the preceding denial exercised the new fence.
    await db.projectUpdatePolicy.updateMany({ where: { projectId }, data: { scanFailureNextEligibleAt: null } });
    assert.deepEqual((await db.projectUpdatePolicy.findFirstOrThrow({ where: { projectId } })).scheduledScanNextEligibleAt, before.scheduledScanNextEligibleAt);
    assert.equal(await updates.scanScheduledProjects(1), 1);
    assert.equal((await db.ingestionProjectReassessment.findUniqueOrThrow({ where: { id: cause.id } })).state, "COMPLETED");
    const afterLedger = await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
    assert.deepEqual(afterLedger.slice(0, 24), beforeLedger);
    assert.equal(afterLedger[24].checksum, createHash("sha256").update(migrations[24].sql).digest("hex"));
    assert.deepEqual(afterLedger.slice(0, 25), before26Ledger);
    assert.deepEqual(afterLedger.slice(0, 26), before27Ledger);
    assert.equal(afterLedger.length, 37);
    assert.equal(afterLedger[25].checksum, createHash("sha256").update(migrations[25].sql).digest("hex"));
    assert.equal(afterLedger[26].checksum, createHash("sha256").update(migrations[26].sql).digest("hex"));
    assert.deepEqual(afterLedger.slice(0,27),released27.ledger);
    assert.equal(afterLedger[27].checksum,createHash("sha256").update(migrations[27].sql).digest("hex"));
    assert.deepEqual(afterLedger.slice(0,28),before29Ledger);
    assert.equal(afterLedger[28].checksum,createHash("sha256").update(migrations[28].sql).digest("hex"));
    assert.deepEqual(afterLedger.slice(0,29),before30Ledger);
    assert.deepEqual(afterLedger[29],{migration_name:migrations[29].name,checksum:migrations[29].checksum});
    assert.deepEqual(afterLedger.slice(0,30),before31Ledger);
    assert.deepEqual(afterLedger[30],{migration_name:migrations[30].name,checksum:migrations[30].checksum});
    assert.deepEqual(afterLedger.slice(0,31),before32Ledger);
    assert.deepEqual(afterLedger[31],{migration_name:migrations[31].name,checksum:migrations[31].checksum});
    assert.deepEqual(afterLedger.slice(0,32),before33Ledger);
    assert.deepEqual(afterLedger[32],{migration_name:migrations[32].name,checksum:migrations[32].checksum});
    assert.deepEqual(afterLedger.slice(0,33),before34Ledger);
    assert.deepEqual(afterLedger[33],{migration_name:migrations[33].name,checksum:migrations[33].checksum});
    assert.deepEqual(afterLedger.slice(0,34),before35Ledger);
    assert.deepEqual(afterLedger[34],{migration_name:migrations[34].name,checksum:migrations[34].checksum});
    assert.deepEqual(afterLedger.slice(0,35),before36Ledger);
    assert.deepEqual(afterLedger[35],{migration_name:migrations[35].name,checksum:migrations[35].checksum});
    assert.deepEqual(afterLedger.slice(0,36),before37Ledger);
    assert.deepEqual(afterLedger[36],{migration_name:migrations[36].name,checksum:migrations[36].checksum});
    console.log("Populated released-24 upgrade retained all 24 checksums and its exact failure fence; a real available cause remained uncharged, then completed after only that fence was cleared.");
    return { priorMigrationCount: 24, databaseName: name, retainedLegacyFailureFence: true, scanBlockedByFence: true,
      availableCauseUncharged: true, positiveControlCompleted: true, retainedPriorChecksums: 24,
      retentionAuditUpgrade: { priorGuardRejected: true, priorMigrationCount: 26, migrationCount: 27,
        originalAuditPreserved: true, freshRevisionRecorded: true, functionBoundaryPreserved: true },
      csvComparisonUpgrade,csvValidationCostUpgrade,
      xlsxReceiptCodecUpgrade:{...xlsxReceiptCodec, retainedPriorChecksums:29, preservedPopulatedCsv:true} };
  } finally { await db.$disconnect(); }
}
