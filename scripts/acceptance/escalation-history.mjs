// EXEC-020: guard-valid stored history for real projection/API checks, not a delivery proof.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectFactRepository,
  DatabaseAuthorityRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { renderProjectUpdateCapture } from "../../packages/domain/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
const { Pool } = createRequire(new URL("../../packages/data/package.json", import.meta.url))("pg");

export async function seedEscalationHistory(databaseUrl, { isolatedCustomer = false, customerId: selectedCustomerId,
  includeOlderCycle = false } = {}) {
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
    const owner = { customerId, subject: "synthetic-owner-4", roles: ["contributor"] };
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
    canonical.responsibilities = canonical.responsibilities.map((entry) =>
      entry.role === "PROJECT_MANAGER" ? { ...entry, subject: pm.subject, displayName: "Synthetic escalation PM" } : entry);
    const project = await new DatabaseCanonicalProjectRepository(birth).createProject(
      admin, canonical, randomUUID());
    const projectId = project.id;
    for (const actor of [owner, pm]) await db.accessGrant.create({ data: {
      customerId, subject: actor.subject, scopeType: "project", scopeId: projectId, role: actor.roles[0],
    } });
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
    const facts = new DatabaseProjectFactRepository(db), authority = new DatabaseAuthorityRepository(db);
    const sourceMarkerA = "HISTORICAL_SOURCE_A_" + randomUUID();
    const sourceMarkerB = "CURRENT_SOURCE_B_" + randomUUID();
    const readers = [admin.subject, writer.subject, owner.subject, pm.subject, service];
    const append = async (actor, marker) => {
      const fact = await db.projectFact.findFirst({ where: { customerId, projectId, factType: "project.status" } });
      const result = await facts.appendHumanStatement(actor, { projectId, factType: "project.status",
        expectedRevision: fact?.revision ?? 0, idempotencyKey: randomUUID(), effectiveAt: now.toISOString(),
        value: { type: "text", value: marker }, originalStatement: marker }, { correlationId: randomUUID() });
      await facts.setSourceAccess(admin, { projectId, sourceId: result.entry.sourceId,
        expectedRevision: result.entry.sourceAccessRevision, state: "AVAILABLE", readers }, { correlationId: randomUUID() });
      // Authority instance identity is the per-fact source stream UUID.
      return { sourceId: result.entry.sourceId, instanceId: result.entry.sourceId };
    };
    const selector = (source) => ({ sourceType: "human_statement", instanceId: source.instanceId,
      requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 31536000000 } });
    const sourceA = await append(admin, sourceMarkerA);
    await authority.appendPolicy(admin, { projectId, factType: "project.status", expectedRevision: 0,
      idempotencyKey: randomUUID(), effectiveAt: "2026-01-01T00:00:00.000Z",
      definition: { tiers: [{ selectors: [selector(sourceA)] }], conflictBehavior: "REQUEST_RECONCILIATION" } },
    { correlationId: randomUUID() });
    const requiredFacts = [{ factType: "project.status", label: "Current status" },
      { factType: "project.forecast", label: "Current forecast" }];
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
    const sourceB = await append(writer, sourceMarkerB);
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
      engagementId: activation.engagementId };
  } finally { await db.$disconnect(); await pool.end(); }
}
