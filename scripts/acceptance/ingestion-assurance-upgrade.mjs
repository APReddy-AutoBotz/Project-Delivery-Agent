// EXEC-019 / NFR-REL-001: populate released migration 24, then retain its fence.
import assert from "node:assert/strict";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { createDatabase, DatabaseCanonicalProjectRepository, DatabaseIngestionRepository,
  DatabaseConnectorRuntimeRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { assertSyntheticDatabaseUrl, CredentialVault, CredentialKeyRingVault } from "../../packages/platform/dist/index.js";
import { readMigrations, migrateDatabase } from "../../packages/operations/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { claimReassessmentFixtureJob } from "./ingestion-reassessment.mjs";
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
  const migrations = readMigrations("packages/data/prisma/migrations"); assert.equal(migrations.length, 25);
  await migrateDatabase(config, migrations.slice(0, 24));
  const db = createDatabase(locator.toString());
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
    await migrateDatabase(config, migrations);
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
    console.log("Populated released-24 upgrade retained all 24 checksums and its exact failure fence; a real available cause remained uncharged, then completed after only that fence was cleared.");
    return { priorMigrationCount: 24, databaseName: name, retainedLegacyFailureFence: true, scanBlockedByFence: true,
      availableCauseUncharged: true, positiveControlCompleted: true, retainedPriorChecksums: 24 };
  } finally { await db.$disconnect(); }
}
