// EXEC-020: guard-valid stored history for real projection/API checks, not a delivery proof.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDatabase, DatabaseCanonicalProjectRepository, DatabaseHealthAssessmentRepository, DatabaseIngestionRepository, DatabaseProjectFactRepository,
  DatabaseAuthorityRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { atlasApprovalProjectCode, atlasIntegrationMilestoneKey, atlasJiraBlockerKey,
  renderProjectUpdateCapture } from "../../packages/domain/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { CredentialVault } from "../../packages/platform/dist/index.js";
import { atlasSpreadsheetDates, reviewAtlasSpreadsheet } from "./atlas-spreadsheet.mjs";
const { Pool } = createRequire(new URL("../../packages/data/package.json", import.meta.url))("pg");

export async function seedEscalationHistory(databaseUrl, { isolatedCustomer = false, customerId: selectedCustomerId,
  includeOlderCycle = false, atlasApproval = false } = {}) {
  const target = new URL(databaseUrl);
  assert(process.env.NODE_ENV !== "production" && process.env.DATA_MODE === "synthetic");
  assert(["localhost", "127.0.0.1"].includes(target.hostname));
  assert.match(target.pathname, /^\/pdaa_test_[0-9]+$/);
  const db = createDatabase(databaseUrl), pool = new Pool({ connectionString: databaseUrl });
  try {
    assert(!(isolatedCustomer && selectedCustomerId));
    // Epoch renewal must never invalidate another fixture/customer's invitations.
    assert(!includeOlderCycle || isolatedCustomer);
    const customerId = isolatedCustomer ? randomUUID() : selectedCustomerId ?? process.env.CUSTOMER_ID;
    assert(customerId);
    if (isolatedCustomer) await db.customer.create({ data: { id: customerId, name: "Synthetic isolated escalation customer" } });
    else assert(await db.customer.findUnique({ where: { id: customerId } }));
    const admin = { customerId, subject: "escalation-reviewer-" + randomUUID(), roles: ["pmo_admin"] };
    const writer = { customerId, subject: "escalation-writer-" + randomUUID(), roles: ["pmo_admin"] };
    const owner = { customerId, subject: atlasApproval ? "owner-atlas" : "synthetic-owner-4", roles: ["contributor"] };
    // Match IdentityService's real development PM persona for the saved browser journey.
    const pm = { customerId, subject: "pm-atlas", roles: ["project_manager"] };
    const service = "escalation-service-" + randomUUID(), portfolioId = randomUUID();
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic escalation history" } });
    for (const actor of [admin, writer]) await db.accessGrant.create({ data: {
      customerId, subject: actor.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin",
    } });
    const now = (await pool.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
    const createdAt = new Date(now.getTime() - 14 * 86400000);
    const birth = { $transaction: (operation, options) => db.$transaction(async (tx) => operation(
      new Proxy(tx, { get(object, key) {
        if (key === "canonicalProject") return new Proxy(object.canonicalProject, { get(delegate, method) {
          if (method === "create") return (args) => delegate.create({ ...args, data: { ...args.data, createdAt } });
          const value = Reflect.get(delegate, method);
          return typeof value === "function" ? value.bind(delegate) : value;
        } });
        const value = Reflect.get(object, key);
        return typeof value === "function" ? value.bind(object) : value;
      } })), options) };
    const canonical = canonicalFixture(portfolioId);
    let jiraIssue, jiraIntake, spreadsheetIntake;
    const jiraOrigin = "https://atlas-fixture.example.test";
    if (atlasApproval) {
      assert(isolatedCustomer);
      jiraIssue = { id: "950248", key: atlasJiraBlockerKey, fields: {
        project: { id: "950", key: "ATLAS" },
        updated: new Date(now.getTime() - 30_000).toISOString(),
        status: { name: "To Do" },
      } };
      canonical.code = atlasApprovalProjectCode;
      canonical.name = "Atlas · Delivery approval";
      canonical.dates = { ...canonical.dates, ...atlasSpreadsheetDates() };
      canonical.milestones.push({
        key: atlasIntegrationMilestoneKey, name: "Integration testing", state: "IN_PROGRESS",
        dates: { baselineStart: null, baselineEnd: null, plannedStart: "2026-10-05", plannedEnd: null,
          forecastStart: null, forecastEnd: null, actualStart: "2026-10-08", actualEnd: null },
      });
      canonical.workItems.push({
        key: jiraIssue.key, title: "Resolve integration API access", state: "OPEN", sprintKey: null,
        dates: { baselineStart: null, baselineEnd: null, plannedStart: null, plannedEnd: null,
          forecastStart: null, forecastEnd: null, actualStart: null, actualEnd: null },
      });
      canonical.requiredWorkItems.push({ milestoneKey: atlasIntegrationMilestoneKey, workItemKey: jiraIssue.key });
      canonical.raidItems = canonical.raidItems.map((item) => ({ ...item, state: "COMPLETE" }));
      canonical.raidItems.push({
        key: jiraIssue.key, kind: "ISSUE", title: "Integration API access blocker",
        description: "Synthetic Jira issue tracking the missing API access for integration testing.",
        state: "OPEN", ownerSubject: null,
      });
      canonical.sourceMappings.push({
        sourceSystem: "Jira", instanceKey: "atlas-demo", externalType: "issue", externalId: jiraIssue.key,
        externalRevision: jiraIssue.fields.updated, url: jiraOrigin + "/browse/" + jiraIssue.key,
        targetType: "RAID_ITEM", targetKey: jiraIssue.key,
      });
    }
    canonical.responsibilities = canonical.responsibilities.map((entry) =>
      entry.role === "PROJECT_MANAGER" ? { ...entry, subject: pm.subject, displayName: "Synthetic escalation PM" }
        : entry.role === "RESPONSIBLE_OWNER" && atlasApproval ? { ...entry, subject: owner.subject } : entry);
    const project = await new DatabaseCanonicalProjectRepository(birth).createProject(
      admin, canonical, randomUUID());
    const projectId = project.id;
    const facts = new DatabaseProjectFactRepository(db);
    for (const actor of [owner, pm]) await db.accessGrant.create({ data: {
      customerId, subject: actor.subject, scopeType: "project", scopeId: projectId, role: actor.roles[0],
    } });
    if (atlasApproval) await db.accessGrant.create({ data: {
      customerId, subject: "leader-atlas", scopeType: "project", scopeId: projectId, role: "leadership",
    } });
    if (jiraIssue) {
      const { admitSyntheticSourceInputs, ingestSyntheticJiraIssues } = await import("./golden-source-observations.mjs");
      const retentionAdmin = { customerId, subject: "atlas-demo-retention", roles: ["system_admin"] };
      await db.accessGrant.create({ data: {
        customerId, subject: retentionAdmin.subject, scopeType: "project", scopeId: projectId, role: "system_admin",
      } });
      const ingestion = new DatabaseIngestionRepository(db, new CredentialVault(randomBytes(32).toString("base64")));
      await ingestion.setRetention(retentionAdmin, { retentionHours: 24 }, randomUUID());
      const sourceReaders = [admin.subject, pm.subject, "leader-atlas"];
      spreadsheetIntake = await reviewAtlasSpreadsheet(ingestion, admin, projectId, sourceReaders);
      const { sourceId, receiptId } = await ingestSyntheticJiraIssues(db, {
        actor: admin, projectId, origin: jiraOrigin, jiraProject: jiraIssue.fields.project.key,
        readers: sourceReaders, issues: [jiraIssue],
      });
      const mappings = await db.$queryRaw`
        SELECT mapping.id AS "mappingId", outcome.ordinal, stream.id AS "streamId"
        FROM public."IngestionRowOutcome" outcome
        JOIN public."IngestionSourceRevision" revision ON
          (revision."customerId",revision."sourceId",revision.id)=(outcome."customerId",outcome."sourceId",outcome."sourceRevisionId")
        JOIN public."IngestionFactStream" stream ON (stream."customerId",stream."sourceId",stream."recordId")=
          (outcome."customerId",outcome."sourceId",outcome."recordId") AND stream."factType"='jira.status'
        JOIN public."CanonicalSourceMapping" mapping ON (mapping."customerId",mapping."projectId",
          mapping."externalId",mapping."externalRevision")=(outcome."customerId",outcome."projectId",outcome."recordKey",revision.revision)
        WHERE (outcome."customerId",outcome."sourceId",outcome."projectId",outcome."receiptId")=
          (${customerId}::uuid,${sourceId}::uuid,${projectId}::uuid,${receiptId}::uuid)
          AND outcome.state='ACCEPTED' AND mapping."sourceSystem"='Jira' AND mapping."instanceKey"='atlas-demo'
          AND mapping."targetType"='RAID_ITEM'`;
      assert.equal(mappings.length, 1);
      const { mappingId, streamId, ordinal } = mappings[0];
      const workItem = await db.workItem.findFirstOrThrow({ where: { customerId, projectId, key: jiraIssue.key } });
      const [admitted] = await admitSyntheticSourceInputs(pool, customerId, projectId, admin.subject, [{
        streamId, ordinal, receiptId, targetKind: "WORK_ITEM", targetId: workItem.id, type: "jira",
        states: { "To Do": "OPEN" }, snapshotField: null,
      }]);
      await facts.setSourceAccess(admin, { projectId, sourceId: admitted.source, expectedRevision: 1,
        state: "AVAILABLE", readers: sourceReaders }, { correlationId: randomUUID() });
      jiraIntake = { sourceId, receiptId, mappingId, factSourceId: admitted.source, sourceReaders };
    }
    const audit = async (connection, event, detail = {}) => {
      const id = randomUUID();
      await connection.query(`INSERT INTO public."AuditEvent"(id,"customerId",actor,event,"correlationId",detail)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [id, customerId, admin.subject, event, randomUUID(), JSON.stringify(detail)]);
      return id;
    };
    await pool.query('INSERT INTO public."ProjectUpdateIssuanceGate"("customerId") VALUES($1) ON CONFLICT DO NOTHING', [customerId]);
    let gate = (await pool.query('SELECT * FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1', [customerId])).rows[0];
    if (!gate.issuanceEnabled) {
      await pool.query(`UPDATE public."ProjectUpdateIssuanceGate" SET "issuanceEnabled"=true,revision=revision+1,
        "changedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2 WHERE "customerId"=$1`,
      [customerId, await audit(pool, "project_update.issuance.changed", { fixture: true })]);
      gate = (await pool.query('SELECT * FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1', [customerId])).rows[0];
    }
    const configuration = { customerId, mode: "CAPTURE", invitationLifetimeSeconds: 3600,
      contentRetentionSeconds: 86400, issuanceEpoch: gate.issuanceEpoch, responseReviewerSubjects: [admin.subject] };
    const zones = { customerId, customerTimeZone: "UTC", recipientTimeZones: [] };
    const updates = new DatabaseProjectUpdateRepository(db, service, zones,
      () => ({ globalShadowMode: "false", configuration }));
    const authority = new DatabaseAuthorityRepository(db);
    const sourceMarkerA = atlasApproval
      ? `The integration team last reported that API access was pending on ${jiraIssue.key}.`
      : "HISTORICAL_SOURCE_A_" + randomUUID();
    const sourceMarkerB = atlasApproval
      ? `The delivery team still needs an access date and an updated integration forecast for ${jiraIssue.key}.`
      : "CURRENT_SOURCE_B_" + randomUUID();
    const readers = [admin.subject, writer.subject, owner.subject, pm.subject, service];
    if (atlasApproval) readers.push("leader-atlas");
    const append = async (actor, factType, value, originalStatement) => {
      const fact = await db.projectFact.findFirst({ where: { customerId, projectId, factType } });
      const result = await facts.appendHumanStatement(actor, { projectId, factType,
        expectedRevision: fact?.revision ?? 0, idempotencyKey: randomUUID(), effectiveAt: now.toISOString(),
        value, originalStatement }, { correlationId: randomUUID() });
      await facts.setSourceAccess(admin, { projectId, sourceId: result.entry.sourceId,
        expectedRevision: result.entry.sourceAccessRevision, state: "AVAILABLE", readers }, { correlationId: randomUUID() });
      // Authority instance identity is the per-fact source stream UUID.
      return { sourceId: result.entry.sourceId, instanceId: result.entry.sourceId };
    };
    const selector = (source, validity = { basis: "observedAt", durationMs: 31536000000 }) => ({
      sourceType: "human_statement", instanceId: source.instanceId, requiredApproval: "NOT_REQUIRED", validity,
    });
    if (atlasApproval) {
      const blocker = await db.raidItem.findFirstOrThrow({ where: { customerId, projectId, key: jiraIssue.key } });
      const minimumBlockerAgeDays = 5;
      await new DatabaseHealthAssessmentRepository(db).setBlockerAgeThresholdPolicy(admin, {
        expectedRevision: 0, minimumBlockerAgeDays, auditRetentionHours: 720,
      }, randomUUID());
      const openedAt = new Date(now.getTime() - (minimumBlockerAgeDays + 2) * 86400000).toISOString().slice(0, 10);
      const dailyValidity = { basis: "observedAt", durationMs: 86400000 };
      for (const [factType, value, validity, statement] of [
        ["project.open_blocker_inventory_complete", { type: "boolean", value: true }, dailyValidity,
          `${jiraIssue.key} is the only open item in the Atlas blocker inventory.`],
        [`raid_item.${blocker.id}.blocks_delivery`, { type: "boolean", value: true }, dailyValidity,
          `${jiraIssue.key} blocks delivery of the integration work.`],
        [`raid_item.${blocker.id}.opened_at`, { type: "date", value: openedAt }, { mode: "UNTIL_SUPERSEDED" },
          `${jiraIssue.key} was opened on ${openedAt}.`],
      ]) {
        const source = await append(admin, factType, value, statement);
        await authority.appendPolicy(admin, {
          projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt: now.toISOString(),
          definition: { tiers: [{ selectors: [selector(source, validity)] }], conflictBehavior: "REQUEST_RECONCILIATION" },
        }, { correlationId: randomUUID() });
      }
    }
    const sourceA = await append(admin, "project.status", { type: "text", value: sourceMarkerA }, sourceMarkerA);
    await authority.appendPolicy(admin, { projectId, factType: "project.status", expectedRevision: 0,
      idempotencyKey: randomUUID(), effectiveAt: "2026-01-01T00:00:00.000Z",
      definition: { tiers: [{ selectors: [selector(sourceA)] }], conflictBehavior: "REQUEST_RECONCILIATION" } },
    { correlationId: randomUUID() });
    const requiredFacts = [
      { factType: "project.status", label: atlasApproval ? "API access status" : "Current status" },
      { factType: "project.forecast", label: atlasApproval
        ? "Expected API access date, current owner and impact on the integration forecast" : "Current forecast" },
    ];
    await updates.setPolicy(admin, projectId, { expectedRevision: 0, freshnessWindowSeconds: 3600,
      timeZone: "UTC", requiredFacts, responsibleSubject: owner.subject, scheduledScanEnabled: true,
      reminderBusinessDayOffsets: [1, 2], escalationAfterBusinessDays: 3,
      escalationRecipientSubject: pm.subject, quietHoursStartLocal: null, quietHoursEndLocal: null }, randomUUID());
    const initial = await updates.assess(admin, projectId, randomUUID());
    assert.equal(initial.obligation?.state, "OPEN");
    assert.deepEqual(initial.knownPosition.map((entry) => entry.sourceId), [sourceA.sourceId]);
    const activation = await updates.activateEngagement(admin, projectId, 1, randomUUID());
    assert(activation?.mode === "CAPTURE");
    const loadStages = async (generation) => (await pool.query(`SELECT s.*,o.id AS "outboxId" FROM public."ProjectUpdateStage" s
      JOIN public."ProjectUpdateOutbox" o ON o."customerId"=s."customerId" AND o."projectId"=s."projectId" AND o."stageId"=s.id
      WHERE s."customerId"=$1 AND s."projectId"=$2 AND s."engagementId"=$3 AND s.generation=$4 ORDER BY s.ordinal,s."recipientRole"`,
    [customerId, projectId, activation.engagementId, generation])).rows;
    let stages = await loadStages(1);
    assert.equal(stages.length, 5);
    let ownerStages = stages.filter((stage) => stage.recipientRole === "OWNER");
    let pmStage = stages.find((stage) => stage.recipientRole === "PROJECT_MANAGER");
    assert(pmStage && ownerStages.length === 4);
    const sameClockIds = [randomUUID(), randomUUID()].sort();
    const capture = async (stage, view, assessmentId, requestedId, capturedAtValue) => {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const requestId = requestedId ?? randomUUID(), invitationId = randomUUID(), locator = randomUUID();
        const assessment = (await connection.query('SELECT dependencies FROM public."ProjectUpdateAssessment" WHERE id=$1 AND "customerId"=$2 AND "projectId"=$3',
          [assessmentId, customerId, projectId])).rows[0];
        assert(assessment);
        const capturedAt = capturedAtValue ?? (await connection.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
        const rendered = renderProjectUpdateCapture({
          project: { id: projectId, code: view.project.code, name: view.project.name }, kind: stage.kind, policyRevision: stage.policyRevision,
          dueAt: stage.logicalDueAt.toISOString(), capturedAt: capturedAt.toISOString(),
          requiredFacts: requiredFacts.filter((fact) => stage.factTypes.includes(fact.factType)),
          knownPosition: view.knownPosition, dependencies: assessment.dependencies,
          responseReviewerSubjects: configuration.responseReviewerSubjects });
        const claimed = await connection.query(`UPDATE public."ProjectUpdateOutbox" SET state='CLAIMED',
          "claimGeneration"="claimGeneration"+1,"leaseUntil"=clock_timestamp()+interval '4 minutes',
          "auditEventId"=$2 WHERE id=$1 AND state='READY' RETURNING id`,
        [stage.outboxId, await audit(connection, "project_update.stage.claimed", { stageId: stage.id })]);
        assert.equal(claimed.rowCount, 1);
        const auditId = await audit(connection, "project_update.stage.captured", { stageId: stage.id, requestId, mode: "CAPTURE" });
        await connection.query(`INSERT INTO public."ProjectUpdateCapturedRequest"(id,"customerId","projectId","stageId",
          "sourceAssessmentId","issuanceEpoch","recipientSubject","reviewerSubjects","requiredFacts",dependencies,
          "rendererRevision","contentDigest","capturedAt","invitationLifetimeSeconds","contentRetentionSeconds","purgeAfter","auditEventId")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15::integer,
            $13::timestamptz+make_interval(secs=>$15::integer),$16)`, [requestId, customerId, projectId, stage.id, assessmentId,
          configuration.issuanceEpoch, stage.recipientSubject, configuration.responseReviewerSubjects,
          JSON.stringify(requiredFacts.filter((fact) => stage.factTypes.includes(fact.factType))), JSON.stringify(assessment.dependencies),
          rendered.rendererRevision, createHash("sha256").update(rendered.text, "utf8").digest("hex"), capturedAt,
          configuration.invitationLifetimeSeconds, configuration.contentRetentionSeconds, auditId]);
        await connection.query(`INSERT INTO public."ProjectUpdateInvitation"(id,locator,"customerId","projectId","requestId",
          "recipientSubject","issuanceEpoch","issuedAt","expiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,
          $8::timestamptz+make_interval(secs=>$9::integer))`, [invitationId, locator, customerId, projectId, requestId,
          stage.recipientSubject, configuration.issuanceEpoch, capturedAt, configuration.invitationLifetimeSeconds]);
        await connection.query('INSERT INTO public."ProjectUpdateRequestContent"("requestId","customerId","projectId",body) VALUES($1,$2,$3,$4)',
          [requestId, customerId, projectId, rendered.text]);
        await connection.query(`UPDATE public."ProjectUpdateOutbox" SET state='CAPTURED',"leaseUntil"=NULL,
          "completedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2 WHERE id=$1`, [stage.outboxId, auditId]);
        await connection.query("COMMIT");
        return { requestId, stageId: stage.id, generation: stage.generation, recipientRole: stage.recipientRole, locator,
          capturedAt: capturedAt.toISOString(), body: rendered.text };
      } catch (error) { await connection.query("ROLLBACK"); throw error; }
      finally { connection.release(); }
    };
    const olderCycle = [];
    if (includeOlderCycle) {
      for (const stage of stages) olderCycle.push(await capture(stage, initial, stage.assessmentId));
      const epoch = randomUUID();
      const previous = (await pool.query('SELECT * FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1', [customerId])).rows[0];
      await pool.query(`UPDATE public."ProjectUpdateIssuanceGate" SET "issuanceEnabled"=false,"issuanceEpoch"=$2,
        revision=revision+1,"changedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$3 WHERE "customerId"=$1 AND revision=$4`,
      [customerId, epoch, await audit(pool, "project_update.issuance.changed", { enabled: false, fixture: true }), previous.revision]);
      await pool.query(`UPDATE public."ProjectUpdateIssuanceGate" SET "issuanceEnabled"=true,
        revision=revision+1,"changedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2 WHERE "customerId"=$1 AND revision=$3`,
      [customerId, await audit(pool, "project_update.issuance.changed", { enabled: true, fixture: true }), previous.revision + 1]);
      configuration.issuanceEpoch = epoch;
      const renewed = await updates.beginCaptureGeneration(admin, projectId,
        { expectedEngagementGeneration: 1, expectedPolicyRevision: 1 }, randomUUID());
      assert.equal(renewed.engagementId, activation.engagementId);
      const head = await db.projectUpdateEngagement.findUniqueOrThrow({ where: { id: activation.engagementId } });
      assert.equal(head.generation, 2);
      stages = await loadStages(2);
      assert.equal(stages.length, 5);
      assert(stages.every((stage) => stage.policyRevision === 1));
      ownerStages = stages.filter((stage) => stage.recipientRole === "OWNER");
      pmStage = stages.find((stage) => stage.recipientRole === "PROJECT_MANAGER");
      assert(pmStage && ownerStages.length === 4);
    }
    const request = await capture(ownerStages[0], initial, ownerStages[0].assessmentId, sameClockIds[1]);
    const reminder = await capture(ownerStages[1], initial, ownerStages[1].assessmentId,
      sameClockIds[0], new Date(request.capturedAt));
    assert(reminder.requestId < request.requestId && reminder.capturedAt === request.capturedAt);
    const secondReminder = await capture(ownerStages[2], initial, ownerStages[2].assessmentId);
    const sourceB = await append(writer, "project.status", { type: "text", value: sourceMarkerB }, sourceMarkerB);
    await authority.appendPolicy(admin, { projectId, factType: "project.status", expectedRevision: 1,
      idempotencyKey: randomUUID(), effectiveAt: "2026-01-02T00:00:00.000Z",
      definition: { tiers: [{ selectors: [selector(sourceB)] }, { selectors: [selector(sourceA)] }],
        conflictBehavior: "REQUEST_RECONCILIATION" } }, { correlationId: randomUUID() });
    const correlationId = randomUUID();
    const current = await updates.assess(admin, projectId, correlationId);
    assert.deepEqual(current.knownPosition.map((entry) => entry.sourceId), [sourceB.sourceId]);
    const assessments = (await pool.query(`SELECT a.id FROM public."ProjectUpdateAssessment" a
      JOIN public."AuditEvent" e ON e."customerId"=a."customerId" AND e.id=a."auditEventId"
      WHERE a."customerId"=$1 AND a."projectId"=$2 AND e."correlationId"=$3`, [customerId, projectId, correlationId])).rows;
    assert.equal(assessments.length, 1);
    configuration.invitationLifetimeSeconds = 172800;
    configuration.contentRetentionSeconds = 172800;
    // A same-cycle capture can complete after the PM's own capture. It belongs
    // in the current history at read-as-of, with its actual later timestamp.
    const earlyPm = includeOlderCycle ? await capture(pmStage, current, assessments[0].id) : null;
    const ownerEscalation = await capture(ownerStages[3], current, assessments[0].id);
    const escalation = earlyPm ?? await capture(pmStage, current, assessments[0].id);
    if (earlyPm) assert(Date.parse(ownerEscalation.capturedAt) > Date.parse(escalation.capturedAt));
    const privateResponse = "PRIVATE_OWNER_RESPONSE_" + randomUUID();
    await updates.submitResponse(owner, request.locator,
      { text: privateResponse, idempotencyKey: randomUUID(), correctsResponseId: null }, randomUUID());
    await updates.submitResponse(pm, escalation.locator,
      { text: "PM own unconfirmed reply", idempotencyKey: randomUUID(), correctsResponseId: null }, randomUUID());
    return { customerId, projectId, admin, writer, owner, pm, service, zones, configuration, readers,
      sourceA, sourceB, sourceMarkerA, sourceMarkerB, privateResponse,
      request, reminder, secondReminder, ownerEscalation, escalation, olderCycle,
      engagementId: activation.engagementId, jiraIntake, spreadsheetIntake };
  } finally { await db.$disconnect(); await pool.end(); }
}
