// EXEC-015 / FR-ESC-006 / NFR-REL-002: isolated historical archive construction.
// Only a fresh maintenance database before pg_restore's post-data phase may
// receive historical rows. Production clocks, guards and retention bounds stay exact.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { planProjectUpdateRecipientStage } from "../../packages/domain/dist/index.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, stable(child)])) : value;
const hash = (value) => sha(JSON.stringify(stable(value)));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = (name) => '"' + name.replaceAll('"', '""') + '"';
export function guardCaptureArchiveConnection(connection, archive = false) {
  if (typeof connection === "string") {
    const url = new URL(connection);
    assert.equal(process.env.DATA_MODE, "synthetic");
    assert.equal(process.env.NODE_ENV, "development");
    assert(["localhost", "127.0.0.1"].includes(url.hostname));
    assert.equal(url.port, "55432");
    assert.match(url.pathname, /^\/pdaa_test_[0-9]+$/);
    assert.equal(url.search, "");
  } else {
    assert.equal(process.env.PDAA_ACCEPTANCE, "isolated");
    assert.equal(process.env.DATA_MODE, "synthetic");
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(process.env.DEPLOYMENT_MODE, "customer");
    assert.match(process.env.PDAA_ACCEPTANCE_RUN_ID, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
    assert.equal(readFileSync("/run/secrets/ready", "utf8"), "isolated synthetic acceptance\n");
    assert.equal(connection.host, "database");
    assert.equal(connection.database, archive === "restored" ? "capture_history_restore" : archive ? "capture_history" : "pdaa");
  }
}

// Historical birth inputs are confined to this synthetic parent fixture. No
// capture, response, purge or operator operation gets a clock override.
export async function seedCaptureArchiveParent(connection) {
  guardCaptureArchiveConnection(connection);
  const db = createDatabase(connection);
  try {
    const customerId = process.env.CUSTOMER_ID;
    assert.match(customerId, uuid);
    const now = (await db.$queryRawUnsafe("SELECT date_trunc('milliseconds',clock_timestamp()) AS now"))[0].now;
    const createdAt = new Date(now.getTime() - 8 * 86400000);
    const assessedAt = new Date(now.getTime() - 6 * 86400000);
    const portfolioId = randomUUID(), subject = "capture-archive-" + randomUUID();
    const actor = { customerId, subject, roles: ["pmo_admin"] };
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic historical capture archive" } });
    await db.accessGrant.create({ data: { customerId, subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" } });
    const birth = {
      $transaction: (operation, options) => db.$transaction(async (tx) => operation(new Proxy(tx, { get(target, key) {
        if (key === "canonicalProject" || key === "auditEvent") return new Proxy(target[key], { get(delegate, method) {
          if (method === "create") return (args) => delegate.create({ ...args, data: { ...args.data,
            ...(key === "canonicalProject" ? { createdAt } : { occurredAt: createdAt }) } });
          const value = Reflect.get(delegate, method);
          return typeof value === "function" ? value.bind(delegate) : value;
        } });
        if (key === "$queryRawUnsafe") return (sql, ...args) => sql === "SELECT date_trunc('milliseconds',clock_timestamp()) AS now"
          ? Promise.resolve([{ now: assessedAt }]) : target.$queryRawUnsafe(sql, ...args);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } })), options),
    };
    const project = await new DatabaseCanonicalProjectRepository(birth).createProject(actor, canonicalFixture(portfolioId), randomUUID());
    for (const [recipient, role] of [["synthetic-owner-4", "contributor"], ["synthetic-owner-1", "project_manager"]])
      await db.accessGrant.create({ data: { customerId, subject: recipient, scopeType: "project", scopeId: project.id, role } });
    const updates = new DatabaseProjectUpdateRepository(birth);
    await updates.setPolicy(actor, project.id, { expectedRevision: 0, freshnessWindowSeconds: 3600, timeZone: "UTC",
      requiredFacts: [{ factType: "project.status", label: "Current status" }, { factType: "project.forecast", label: "Current forecast" }],
      responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false, reminderBusinessDayOffsets: [1, 2],
      escalationAfterBusinessDays: 3, escalationRecipientSubject: "synthetic-owner-1", quietHoursStartLocal: null, quietHoursEndLocal: null }, randomUUID());
    await updates.assess(actor, project.id, randomUUID());
    return { customerId, projectId: project.id, portfolioId, subject, createdAt: createdAt.toISOString(), assessedAt: assessedAt.toISOString() };
  } finally { await db.$disconnect(); }
}

async function insertRow(pool, schema, table, row) {
  const name = identifier(schema) + "." + identifier(table);
  await pool.query(`INSERT INTO ${name} SELECT * FROM json_populate_record(NULL::${name},$1::json)`, [JSON.stringify(row)]);
}

export async function constructCaptureArchive(source, target, parent, nonce, sourceConnection, targetConnection) {
  guardCaptureArchiveConnection(sourceConnection);
  guardCaptureArchiveConnection(targetConnection, true);
  assert.match(nonce, uuid);
  assert.match(parent.projectId, uuid);
  const identity = (await target.query("SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.match(identity.name, /^(capture_history|pdaa_test_[0-9]+)$/);
  assert.equal(identity.name, typeof targetConnection === "string" ? new URL(targetConnection).pathname.slice(1) : targetConnection.database);
  assert.equal((await source.query("SELECT current_database() AS name")).rows[0].name,
    typeof sourceConnection === "string" ? new URL(sourceConnection).pathname.slice(1) : sourceConnection.database);
  assert.notEqual(identity.name, typeof sourceConnection === "string" ? new URL(sourceConnection).pathname.slice(1) : sourceConnection.database);
  assert.equal(parent.customerId,process.env.CUSTOMER_ID);
  assert.equal(identity.marker, "pdaa.capture.archive.build:" + nonce);
  assert.equal((await target.query("SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")).rows[0].n, 0,
    "Historical construction is only allowed before unchanged post-data guards are installed");
  assert.equal((await target.query('SELECT count(*)::int AS n FROM public."Customer"')).rows[0].n, 0);
  const tables = (await source.query("SELECT c.table_name,array_agg(c.column_name::text) AS columns FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema='public' AND t.table_type='BASE TABLE' GROUP BY c.table_name ORDER BY c.table_name")).rows;
  const audits = new Set();
  await target.query("BEGIN");
  try {
    for (const { table_name: table, columns } of tables) {
      let where, args;
      if (table === "Customer") { where = 'id=$1::uuid'; args = [parent.customerId]; }
      else if (table === "Portfolio") { where = 'id=$1::uuid'; args = [parent.portfolioId]; }
      else if (["Project", "CanonicalProject"].includes(table)) { where = 'id=$1::uuid'; args = [parent.projectId]; }
      else if (table === "AccessGrant") { where = '"customerId"=$1::uuid AND "scopeId" IN ($2::uuid,$3::uuid)'; args = [parent.customerId, parent.portfolioId, parent.projectId]; }
      else if (columns.includes("projectId")) { where = '"customerId"=$1::uuid AND "projectId"=$2::uuid'; args = [parent.customerId, parent.projectId]; }
      else if (table === "_prisma_migrations") { where = "true"; args = []; }
      else continue;
      const rows = (await source.query(`SELECT * FROM public.${identifier(table)} WHERE ${where}`, args)).rows;
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) if (/auditEventId$/i.test(key) && value) audits.add(value);
        await insertRow(target, "public", table, row);
      }
    }
    const history = (await source.query('SELECT * FROM public."AuditEvent" WHERE "customerId"=$1::uuid AND (actor=$2 OR id=ANY($3::uuid[]))', [parent.customerId, parent.subject, [...audits]])).rows;
    for (const row of history) await insertRow(target, "public", "AuditEvent", row);
    if ((await source.query("SELECT to_regclass('graphile_worker.migrations') AS name")).rows[0].name)
      for (const row of (await source.query("SELECT * FROM graphile_worker.migrations ORDER BY id")).rows)
        await insertRow(target, "graphile_worker", "migrations", row);
    const assessment = (await target.query('SELECT * FROM public."ProjectUpdateAssessment" WHERE "projectId"=$1::uuid', [parent.projectId])).rows;
    assert.equal(assessment.length, 1);
    const a = assessment[0];
    assert.deepEqual(a.dependencies, []);
    assert.equal(a.envelopeHash, hash({ input: a.input, result: a.result, dependencies: a.dependencies }));
    assert.equal(a.assessedAt.toISOString(), parent.assessedAt);
    const obligation = (await target.query('SELECT * FROM public."ProjectUpdateObligation" WHERE "projectId"=$1::uuid AND state=\'OPEN\'', [parent.projectId])).rows[0];
    assert.equal(obligation.assessmentId, a.id);
    const epoch = randomUUID(), engagementId = randomUUID();
    const audit = async (event, at, detail = {}, actor = parent.subject, correlationId = "capture-archive-fixture") => {
      const id = randomUUID();
      await target.query('INSERT INTO public."AuditEvent"(id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',
        [id, parent.customerId, actor, event, correlationId, JSON.stringify(detail), at]);
      return id;
    };
    const gateAudit = await audit("project_update.issuance.changed", a.assessedAt, { enabled: true, revision: 1 });
    await target.query('INSERT INTO public."ProjectUpdateIssuanceGate"("customerId","issuanceEnabled","issuanceEpoch",revision,"changedAt","auditEventId") VALUES($1,true,$2,1,$3,$4)', [parent.customerId, epoch, a.assessedAt, gateAudit]);
    const engagementAudit = await audit("project_update.engagement.activated", a.assessedAt, { captureIssuanceEpoch: epoch });
    await target.query(`INSERT INTO public."ProjectUpdateEngagement"(id,"customerId","projectId","obligationId","policyRevisionId","policyRevision","assessmentId",
      "ownerSubject",generation,state,"auditEventId","createdAt","changedAt","sourceSatisfiedFactTypes","sourceAssessmentId","sourceAssessedAt")
      VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic-owner-4',53,'ACTIVE',$8,$9,$9,ARRAY[]::text[],$7,$9)`,
      [engagementId, parent.customerId, parent.projectId, obligation.id, a.policyRevisionId, a.policyRevision, a.id, engagementAudit, a.assessedAt]);
    const now = (await target.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
    const pairs = [];
    let previousStageId = null;
    for (let generation = 1; generation <= 53; generation++) {
      const capturedAt = new Date(now.getTime() - (generation === 53 ? 1000 : 2 * 86400000) + (generation === 53 ? 0 : generation * 10000));
      const receivedAt = new Date(capturedAt.getTime() + 10), availableAt = new Date(capturedAt.getTime() - 1000);
      assert(a.assessedAt < availableAt && availableAt >= obligation.freshnessThresholdAt);
      const stageId = randomUUID(), outboxId = randomUUID(), requestId = randomUUID(), invitationId = randomUUID(), responseId = randomUUID(), locator = randomUUID();
      const body = "Synthetic historical request " + generation + "; no external message was sent.";
      const responseText = "Synthetic unconfirmed historical reply " + generation + ".";
      const key = "archive-response-" + generation;
      const zone = generation % 2 ? "UTC" : "Africa/Abidjan";
      const plan = planProjectUpdateRecipientStage({ kind:"REQUEST",ordinal:0,recipientRole:"OWNER",recipientSubject:"synthetic-owner-4",
        logicalDueAt:obligation.freshnessThresholdAt.toISOString(),anchorAt:obligation.freshnessThresholdAt.toISOString(),
        recipientTimeZone:zone,projectTimeZone:"UTC",customerTimeZone:"UTC",quietHoursStartLocal:null,quietHoursEndLocal:null });
      const stageAudit = generation === 1 ? engagementAudit : await audit("project_update.engagement.replanned", availableAt,
        { engagementId, previousGeneration:generation-1, generation, captureIssuanceEpoch: epoch, reason:"RECIPIENT_ZONE_CHANGED", syntheticArchive:true });
      const claimAudit = await audit("project_update.stage.claimed", availableAt, { stageId, mode: "CAPTURE" });
      const captureAudit = await audit("project_update.stage.captured", capturedAt, { stageId, requestId });
      const responseAudit = await audit("project_update.response.recorded", receivedAt, { requestId, responseId, state: "UNCONFIRMED" });
      await target.query(`INSERT INTO public."ProjectUpdateStage"(id,"customerId","projectId","engagementId","obligationId","policyRevisionId","policyRevision","assessmentId",generation,
        kind,ordinal,"recipientSubject","recipientRole","factTypes","timeZone","zoneSource","logicalDueAt","candidateAt","scheduledAt","localAt","utcOffset","deferralReasons","ruleRevision",mode,"replacesStageId","auditEventId","createdAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'REQUEST',0,'synthetic-owner-4','OWNER',ARRAY['project.status','project.forecast'],$10,$11,$12,$13,$14,$15,$16,$17::text[],'engagement-schedule@1','CAPTURE',$18,$19,$20)`,
        [stageId, parent.customerId, parent.projectId, engagementId, obligation.id, a.policyRevisionId, a.policyRevision, a.id, generation, plan.timeZone, plan.zoneSource, obligation.freshnessThresholdAt, plan.candidateAt, plan.scheduledAt, plan.localAt, plan.utcOffset, plan.deferralReasons, previousStageId, stageAudit, availableAt]);
      await target.query(`INSERT INTO public."ProjectUpdateOutbox"(id,"customerId","projectId","stageId",state,"claimGeneration","availableAt","completedAt","auditEventId","createdAt") VALUES($1,$2,$3,$4,'CAPTURED',1,$5,$6,$7,$5)`,
        [outboxId, parent.customerId, parent.projectId, stageId, availableAt, capturedAt, captureAudit]);
      for (const [event, claimGeneration, at, auditId, lease] of [["ENQUEUED",0,availableAt,stageAudit,null], ["CLAIMED",1,availableAt,claimAudit,new Date(availableAt.getTime()+120000)], ["CAPTURED",1,capturedAt,captureAudit,null]])
        await target.query(`INSERT INTO public."ProjectUpdateDispatchAttempt"(id,"customerId","projectId","outboxId","claimGeneration",event,"availableAt","leaseUntil","auditEventId","recordedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [randomUUID(),parent.customerId,parent.projectId,outboxId,claimGeneration,event,availableAt,lease,auditId,at]);
      await target.query(`INSERT INTO public."ProjectUpdateCapturedRequest"(id,"customerId","projectId","stageId","sourceAssessmentId","issuanceEpoch","recipientSubject","reviewerSubjects","requiredFacts",dependencies,"rendererRevision","contentDigest","capturedAt","invitationLifetimeSeconds","contentRetentionSeconds","purgeAfter","auditEventId")
        VALUES($1,$2,$3,$4,$5,$6,'synthetic-owner-4',$7::text[],$8::jsonb,'[]'::jsonb,'project-update-capture@1',$9,$10,900,86400,$10::timestamptz+interval '1 day',$11)`,
        [requestId,parent.customerId,parent.projectId,stageId,a.id,epoch,[parent.subject],JSON.stringify(obligation.requiredFacts),sha(body),capturedAt,captureAudit]);
      await target.query(`INSERT INTO public."ProjectUpdateInvitation"(id,locator,"customerId","projectId","requestId","recipientSubject","issuanceEpoch","issuedAt","expiresAt") VALUES($1,$2,$3,$4,$5,'synthetic-owner-4',$6,$7,$7::timestamptz+interval '900 seconds')`,
        [invitationId,locator,parent.customerId,parent.projectId,requestId,epoch,capturedAt]);
      await target.query(`INSERT INTO public."ProjectUpdateResponse"(id,"customerId","projectId","requestId","invitationId","submittedBy","idempotencyKey","payloadDigest","contentDigest","receivedAt","contentRetentionSeconds","purgeAfter","auditEventId") VALUES($1,$2,$3,$4,$5,'synthetic-owner-4',$6,$7,$8,$9,86400,$9::timestamptz+interval '1 day',$10)`,
        [responseId,parent.customerId,parent.projectId,requestId,invitationId,key,hash({text:responseText,idempotencyKey:key,correctsResponseId:null}),sha(responseText),receivedAt,responseAudit]);
      const purged = generation === 52, purgedAt = purged ? new Date(now.getTime()-3600000) : null;
      for (const [table,idField,id,text,kind] of [["ProjectUpdateRequestContent","requestId",requestId,body,"REQUEST"],["ProjectUpdateResponseContent","responseId",responseId,responseText,"RESPONSE"]]) {
        const purgeAudit = purged ? await audit("project_update.content.purged", purgedAt, { contentKind: kind }, "system:update-engagement-retention", "project-update-retention") : null;
        await target.query(`INSERT INTO public.${identifier(table)}(${identifier(idField)},"customerId","projectId",body,state,"purgedAt","purgeAuditEventId") VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [id,parent.customerId,parent.projectId,purged?null:text,purged?"PURGED":"PRESENT",purgedAt,purgeAudit]);
      }
      if (generation === 53) await target.query('UPDATE public."ProjectUpdateEngagement" SET "auditEventId"=$2,"changedAt"=$3 WHERE id=$1', [engagementId,stageAudit,availableAt]);
      previousStageId = stageId;
      pairs.push({requestId,responseId,invitationId,locator,generation,contentDigest:sha(body),responseDigest:sha(responseText),payloadDigest:hash({text:responseText,idempotencyKey:key,correctsResponseId:null}),issuanceEpoch:epoch});
    }
    await target.query("COMMIT");
    return { ...parent, engagementId, issuanceEpoch: epoch, pairs, expected: { expiredPresent:51, priorPurged:1, livePresent:1 } };
  } catch (error) { await target.query("ROLLBACK"); throw error; }
}

export async function captureArchiveProjection(pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const result = {};
  for (const { tablename } of tables)
    result[tablename] = JSON.parse(JSON.stringify((await pool.query(`SELECT * FROM public.${identifier(tablename)} ORDER BY to_jsonb(${identifier(tablename)})::text COLLATE "C"`)).rows));
  return result;
}

export async function verifyCaptureArchiveIntegrity(pool, evidence) {
  assert.equal(evidence.pairs.length, 53);
  const rows = (await pool.query(`SELECT r.*,s.generation,s."createdAt" AS "stageCreatedAt",s."scheduledAt",a."assessedAt",
    i.locator,i."issuedAt",i."expiresAt",response.id AS "responseId",response."receivedAt",response."payloadDigest",response."idempotencyKey",
    response."contentDigest" AS "responseDigest",response."purgeAfter" AS "responsePurgeAfter",
    c.body,c.state,c."purgedAt",c."purgeAuditEventId",rc.body AS "responseBody",rc.state AS "responseState",
    rc."purgedAt" AS "responsePurgedAt",rc."purgeAuditEventId" AS "responsePurgeAuditEventId",o.state AS "outboxState",o."availableAt",o."completedAt",clock_timestamp() AS "databaseNow"
    FROM public."ProjectUpdateCapturedRequest" r JOIN public."ProjectUpdateStage" s ON s.id=r."stageId"
    JOIN public."ProjectUpdateAssessment" a ON a.id=r."sourceAssessmentId"
    JOIN public."ProjectUpdateInvitation" i ON i."requestId"=r.id
    JOIN public."ProjectUpdateResponse" response ON response."requestId"=r.id
    JOIN public."ProjectUpdateRequestContent" c ON c."requestId"=r.id
    JOIN public."ProjectUpdateResponseContent" rc ON rc."responseId"=response.id
    JOIN public."ProjectUpdateOutbox" o ON o."stageId"=s.id
    WHERE r."projectId"=$1::uuid ORDER BY s.generation`, [evidence.projectId])).rows;
  assert.equal(rows.length, 53);
  let previousReceivedAt;
  for (const row of rows) {
    if (previousReceivedAt) assert(previousReceivedAt < row.stageCreatedAt, "The prior response must precede the next generation transition");
    previousReceivedAt = row.receivedAt;
    const pair = evidence.pairs[row.generation - 1];
    assert.equal(row.id, pair.requestId);
    assert.equal(row.responseId, pair.responseId);
    assert.equal(row.locator, pair.locator);
    assert.equal(row.issuanceEpoch, pair.issuanceEpoch);
    assert.equal(row.contentDigest, pair.contentDigest);
    assert.equal(row.responseDigest, pair.responseDigest);
    assert.equal(row.payloadDigest,pair.payloadDigest);
    assert.equal(row.outboxState, "CAPTURED");
    assert(row.assessedAt <= row.stageCreatedAt && row.stageCreatedAt <= row.availableAt && row.scheduledAt <= row.availableAt && row.availableAt <= row.capturedAt);
    assert.equal(row.issuedAt.getTime(), row.capturedAt.getTime());
    assert.equal(row.completedAt.getTime(), row.capturedAt.getTime());
    assert(row.receivedAt >= row.issuedAt && row.receivedAt < row.expiresAt && row.receivedAt <= row.databaseNow);
    assert.equal(row.purgeAfter.getTime(), row.capturedAt.getTime() + 86400000);
    assert.equal(row.responsePurgeAfter.getTime(), row.receivedAt.getTime() + 86400000);
    if (row.state === "PRESENT") assert.equal(sha(row.body), row.contentDigest);
    if (row.responseState === "PRESENT") {
      assert.equal(sha(row.responseBody), row.responseDigest);
      assert.equal(row.payloadDigest, hash({ text: row.responseBody, idempotencyKey: row.idempotencyKey, correctsResponseId: null }));
    }
    for (const [kind,state,body,purgedAt,purgeAfter,auditId] of [
      ["REQUEST",row.state,row.body,row.purgedAt,row.purgeAfter,row.purgeAuditEventId],
      ["RESPONSE",row.responseState,row.responseBody,row.responsePurgedAt,row.responsePurgeAfter,row.responsePurgeAuditEventId],
    ]) {
      if(state==="PRESENT") {assert.equal(purgedAt,null);assert.equal(auditId,null);continue;}
      assert.equal(state,"PURGED");assert.equal(body,null);assert(purgedAt>=purgeAfter && purgedAt<=row.databaseNow);
      const audit=(await pool.query('SELECT * FROM public."AuditEvent" WHERE "customerId"=$1::uuid AND id=$2::uuid',[row.customerId,auditId])).rows;
      assert.equal(audit.length,1);assert.equal(audit[0].actor,"system:update-engagement-retention");
      assert.equal(audit[0].event,"project_update.content.purged");assert.equal(audit[0].correlationId,"project-update-retention");
      assert.deepEqual(audit[0].detail,{contentKind:kind});
    }
    const attempts=(await pool.query('SELECT * FROM public."ProjectUpdateDispatchAttempt" WHERE "outboxId"=(SELECT id FROM public."ProjectUpdateOutbox" WHERE "stageId"=$1::uuid)',[row.stageId])).rows;
    assert.equal(attempts.length,3);
    const claimed=attempts.find((entry)=>entry.event==="CLAIMED"), captured=attempts.find((entry)=>entry.event==="CAPTURED"), enqueued=attempts.find((entry)=>entry.event==="ENQUEUED");
    assert.equal(enqueued.claimGeneration,0);assert.equal(claimed.claimGeneration,1);assert.equal(captured.claimGeneration,1);
    assert(row.stageCreatedAt<=claimed.recordedAt && enqueued.recordedAt<=claimed.recordedAt && claimed.recordedAt<=row.capturedAt && row.capturedAt<claimed.leaseUntil);
    assert.equal(captured.recordedAt.getTime(),row.capturedAt.getTime());
    for(const attempt of attempts){assert.equal(attempt.customerId,evidence.customerId);assert.equal(attempt.projectId,evidence.projectId);assert.equal(attempt.reason,null);assert.equal(attempt.handoffAt,null);}

  }
  return rows;
}

// Tests the repository's clock-based body withholding before a purge batch.
// Issuance is explicitly enabled in this constructed maintenance fixture only.
export async function verifyExpiredArchiveDisclosure(connection, evidence) {
  guardCaptureArchiveConnection(connection, typeof connection === "object" && connection.database === "capture_history_restore" ? "restored" : true);
  const db = createDatabase(connection);
  try {
    const gate = await db.projectUpdateIssuanceGate.findUniqueOrThrow({ where: { customerId: evidence.customerId } });
    assert.equal(gate.issuanceEnabled, true);
    const api = { $transaction: (operation, options) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      return operation(tx);
    }, options) };
    const updates = new DatabaseProjectUpdateRepository(api, "archive-service", {
      customerId:evidence.customerId, customerTimeZone:"UTC", recipientTimeZones:[],
    }, () => ({ globalShadowMode:"false", configuration:{ customerId:evidence.customerId, mode:"CAPTURE", issuanceEpoch:gate.issuanceEpoch,
      invitationLifetimeSeconds:900, contentRetentionSeconds:86400, responseReviewerSubjects:[evidence.subject] } }));
    const actor = { customerId:evidence.customerId, subject:evidence.subject, roles:["pmo_admin"] };
    const entries=[];
    let beforeRequestId;
    do {
      const page=await updates.captureHistory(actor,evidence.projectId,beforeRequestId);
      entries.push(...page.entries);
      assert(entries.length<=53,"Historical cursor must make bounded progress");
      beforeRequestId=page.nextCursor ?? undefined;
    } while (beforeRequestId);
    assert.equal(entries.length,53);
    const live=entries.find((row)=>row.requestId===evidence.pairs[52].requestId);
    assert.equal(live.contentState,"PRESENT");
    assert.equal(sha(live.body),evidence.pairs[52].contentDigest);
    assert.equal(live.responses.length,1);
    assert.equal(sha(live.responses[0].text),evidence.pairs[52].responseDigest);
    for (const row of entries.filter((entry)=>entry.requestId!==live.requestId)) {
      assert.equal(row.contentState,"EXPIRED");
      assert.equal(row.body,null);
      assert.equal(row.recipientPath,null);
      for (const response of row.responses) { assert.equal(response.text,null); assert.equal(response.contentState,"EXPIRED"); }
    }
    const oldEpoch = gate.issuanceEpoch !== evidence.issuanceEpoch;
    if (oldEpoch) await assert.rejects(()=>updates.invitation({customerId:evidence.customerId,subject:"synthetic-owner-4",roles:["contributor"]},evidence.pairs[52].locator),error=>error.code==="DENIED");
    return { expiredBodiesWithheld:true, liveBodyRetained:true, historyEntries:entries.length, oldEpochInvitationDenied:oldEpoch };
  } finally { await db.$disconnect(); }
}
