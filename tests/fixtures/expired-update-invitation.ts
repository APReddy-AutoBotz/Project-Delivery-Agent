// SEC-UPD-003: historical application setup clock in a guarded synthetic fixture.
// PostgreSQL's actual clock and all triggers remain active for capture and reads.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { renderProjectUpdateCapture, type Actor } from "../../packages/domain/dist/index.js";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

export async function seedExpiredUpdateInvitation(url: string) {
  const parsed = new URL(url);
  assert(process.env.NODE_ENV !== "production" && process.env.DATA_MODE === "synthetic");
  assert(["localhost", "127.0.0.1"].includes(parsed.hostname) && /^\/pdaa_test_[0-9]+$/.test(parsed.pathname));
  const db = createDatabase(url);
  try {
    const now = (await db.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now"))[0]!.now;
    const createdAt = new Date(now.getTime() - 12 * 86400000), assessedAt = new Date(now.getTime() - 10 * 86400000);
    const customerId = randomUUID(), portfolioId = randomUUID(), service = "expiry-service-" + randomUUID();
    const admin: Actor = { customerId, subject: "expiry-admin-" + randomUUID(), roles: ["pmo_admin"] };
    const owner: Actor = { customerId, subject: "synthetic-owner-4", roles: ["contributor"] };
    const pm: Actor = { customerId, subject: "synthetic-owner-1", roles: ["project_manager"] };
    await db.customer.create({ data: { id: customerId, name: "Synthetic expired invitation customer" } });
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic expiry portfolio" } });
    await db.accessGrant.create({ data: { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" } });
    const birth = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => operation(new Proxy(tx, { get(target, key) {
        if (key === "canonicalProject" || key === "auditEvent") return new Proxy(target[key], { get(delegate, method) {
          if (method === "create") return (args: { data: Record<string, unknown> }) => delegate.create({ ...args, data: { ...args.data,
            ...(key === "canonicalProject" ? { createdAt } : { occurredAt: createdAt }) } } as never);
          const value = Reflect.get(delegate, method); return typeof value === "function" ? value.bind(delegate) : value;
        } });
        if (key === "$queryRawUnsafe") return (sql: string, ...args: unknown[]) =>
          sql === "SELECT date_trunc('milliseconds',clock_timestamp()) AS now" ? Promise.resolve([{ now: assessedAt }]) : target.$queryRawUnsafe(sql, ...args);
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } })), options as never) };
    const project = await new DatabaseCanonicalProjectRepository(birth as never).createProject(admin, canonicalFixture(portfolioId), randomUUID());
    for (const actor of [owner, pm]) await db.accessGrant.create({ data: { customerId, subject: actor.subject,
      scopeType: "project", scopeId: project.id, role: actor.roles[0]! } });
    await db.$executeRawUnsafe('INSERT INTO public."ProjectUpdateIssuanceGate"("customerId") VALUES($1::uuid)', customerId);
    const gate = await db.projectUpdateIssuanceGate.findUniqueOrThrow({ where: { customerId } });
    const gateAudit = await db.auditEvent.create({ data: { customerId, actor: admin.subject, event: "project_update.issuance.changed",
      correlationId: randomUUID(), detail: { fixture: "synthetic expiry" } } });
    let gateChangedAt: Date | undefined;
    for (let attempt = 0; attempt < 100 && !gateChangedAt; attempt++) {
      gateChangedAt = (await db.$queryRawUnsafe<{ now: Date }[]>(
        `SELECT greatest("changedAt",date_trunc('milliseconds',clock_timestamp())) AS now FROM public."ProjectUpdateIssuanceGate"
         WHERE "customerId"=$1::uuid AND "changedAt"<=clock_timestamp()`, customerId))[0]?.now;
    }
    assert(gateChangedAt);
    await db.projectUpdateIssuanceGate.update({ where: { customerId }, data: { issuanceEnabled: true, issuanceEpoch: gate.issuanceEpoch,
      revision: gate.revision + 1, changedAt: gateChangedAt, auditEventId: gateAudit.id } });
    const configuration = { customerId, mode: "CAPTURE" as const, invitationLifetimeSeconds: 900, contentRetentionSeconds: 86400,
      issuanceEpoch: gate.issuanceEpoch, responseReviewerSubjects: [admin.subject] };
    const zones = { customerId, customerTimeZone: "UTC", recipientTimeZones: [] };
    const updates = new DatabaseProjectUpdateRepository(birth as never, service, zones,
      () => ({ globalShadowMode: "false", configuration }));
    const requiredFacts = [{ factType: "project.status", label: "Current status" }];
    await updates.setPolicy(admin, project.id, { expectedRevision: 0, freshnessWindowSeconds: 3600, timeZone: "UTC", requiredFacts,
      responsibleSubject: owner.subject, scheduledScanEnabled: true, reminderBusinessDayOffsets: [1, 2], escalationAfterBusinessDays: 3,
      escalationRecipientSubject: pm.subject, quietHoursStartLocal: null, quietHoursEndLocal: null }, randomUUID());
    const initial = await updates.assess(admin, project.id, randomUUID());
    assert(initial.obligation?.state === "OPEN" && initial.knownPosition.length === 0);
    const activation = await updates.activateEngagement(admin, project.id, 1, randomUUID());
    assert(activation?.mode === "CAPTURE");
    const stages = await db.$queryRawUnsafe<Array<{ id: string; outboxId: string; kind: "REQUEST" | "REMINDER";
      policyRevision: number; logicalDueAt: Date; assessmentId: string; factTypes: string[]; recipientSubject: string; availableAt: Date }>>(
      `SELECT s.*,o.id AS "outboxId",o."availableAt" FROM public."ProjectUpdateStage" s JOIN public."ProjectUpdateOutbox" o
       ON o."customerId"=s."customerId" AND o."projectId"=s."projectId" AND o."stageId"=s.id
       WHERE s."customerId"=$1::uuid AND s."projectId"=$2::uuid AND s."engagementId"=$3::uuid
       AND s."recipientRole"='OWNER' AND s.kind IN ('REQUEST','REMINDER') ORDER BY s.ordinal`, customerId, project.id, activation.engagementId);
    const request = stages.find((stage) => stage.kind === "REQUEST"), reminder = stages.find((stage) => stage.kind === "REMINDER");
    assert(request && reminder);
    async function capture(stage: typeof request, capturedAt: Date) {
      const databaseNow = (await db.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now"))[0]!.now;
      assert(stage && stage.availableAt <= capturedAt && capturedAt <= databaseNow);
      return db.$transaction(async (tx) => {
        const assessment = await tx.projectUpdateAssessment.findUniqueOrThrow({ where: { id: stage.assessmentId } });
        assert(assessment.assessedAt <= capturedAt && Array.isArray(assessment.dependencies) && assessment.dependencies.length === 0);
        const requestId = randomUUID(), invitationId = randomUUID(), locator = randomUUID();
        const rendered = renderProjectUpdateCapture({ project: { id: project.id, code: initial.project.code, name: initial.project.name },
          kind: stage.kind, policyRevision: stage.policyRevision, dueAt: stage.logicalDueAt.toISOString(), capturedAt: capturedAt.toISOString(),
          requiredFacts: requiredFacts.filter((fact) => stage.factTypes.includes(fact.factType)), knownPosition: initial.knownPosition,
          dependencies: assessment.dependencies, responseReviewerSubjects: configuration.responseReviewerSubjects });
        const claimedAudit = await tx.auditEvent.create({ data: { customerId, actor: admin.subject, event: "project_update.stage.claimed",
          correlationId: randomUUID(), detail: { stageId: stage.id } } });
        const claim = await tx.$executeRawUnsafe(`UPDATE public."ProjectUpdateOutbox" SET state='CLAIMED',"claimGeneration"="claimGeneration"+1,
          "leaseUntil"=clock_timestamp()+interval '4 minutes',"auditEventId"=$2::uuid WHERE id=$1::uuid AND state='READY'`, stage.outboxId, claimedAudit.id);
        assert.equal(claim, 1);
        const audit = await tx.auditEvent.create({ data: { customerId, actor: admin.subject, event: "project_update.stage.captured",
          correlationId: randomUUID(), detail: { stageId: stage.id, requestId, mode: "CAPTURE" } } });
        await tx.$executeRawUnsafe(`INSERT INTO public."ProjectUpdateCapturedRequest"(id,"customerId","projectId","stageId","sourceAssessmentId",
          "issuanceEpoch","recipientSubject","reviewerSubjects","requiredFacts",dependencies,"rendererRevision","contentDigest","capturedAt",
          "invitationLifetimeSeconds","contentRetentionSeconds","purgeAfter","auditEventId") VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
          $6::uuid,$7,$8::text[],$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$13::timestamptz+make_interval(secs=>$15::integer),$16::uuid)`,
          requestId, customerId, project.id, stage.id, stage.assessmentId, configuration.issuanceEpoch, stage.recipientSubject,
          configuration.responseReviewerSubjects, JSON.stringify(requiredFacts.filter((fact) => stage.factTypes.includes(fact.factType))),
          JSON.stringify(assessment.dependencies), rendered.rendererRevision, createHash("sha256").update(rendered.text, "utf8").digest("hex"),
          capturedAt, configuration.invitationLifetimeSeconds, configuration.contentRetentionSeconds, audit.id);
        await tx.$executeRawUnsafe(`INSERT INTO public."ProjectUpdateInvitation"(id,locator,"customerId","projectId","requestId","recipientSubject",
          "issuanceEpoch","issuedAt","expiresAt") VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,$8::timestamptz+interval '900 seconds')`,
          invitationId, locator, customerId, project.id, requestId, stage.recipientSubject, configuration.issuanceEpoch, capturedAt);
        await tx.$executeRawUnsafe('INSERT INTO public."ProjectUpdateRequestContent"("requestId","customerId","projectId",body) VALUES($1::uuid,$2::uuid,$3::uuid,$4)',
          requestId, customerId, project.id, rendered.text);
        const complete = await tx.$executeRawUnsafe(`UPDATE public."ProjectUpdateOutbox" SET state='CAPTURED',"leaseUntil"=NULL,
          "completedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2::uuid WHERE id=$1::uuid`, stage.outboxId, audit.id);
        assert.equal(complete, 1);
        return { requestId, invitationId, locator, body: rendered.text };
      }, { timeout: 20000 });
    }
    const expired = await capture(request, new Date(now.getTime() - 20 * 60000));
    const liveNow = (await db.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now"))[0]!.now;
    const live = await capture(reminder, liveNow);
    const rows = await db.$queryRawUnsafe<Array<{ expired: boolean; retained: boolean }>>(`SELECT i."expiresAt"<=clock_timestamp() AS expired,
      r."purgeAfter">clock_timestamp() AND c.state='PRESENT' AS retained FROM public."ProjectUpdateInvitation" i
      JOIN public."ProjectUpdateCapturedRequest" r ON r.id=i."requestId" JOIN public."ProjectUpdateRequestContent" c ON c."requestId"=r.id
      WHERE i.id=$1::uuid`, expired.invitationId);
    assert(rows[0]?.expired && rows[0]?.retained);
    return { customerId, projectId: project.id, admin, owner, service, zones, configuration, expired, live };
  } finally { await db.$disconnect(); }
}
