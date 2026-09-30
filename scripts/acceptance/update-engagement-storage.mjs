// EXEC-015 Stage 2a: native storage evidence, not messaging/workflow acceptance.
// FR-ESC-006, NFR-REL-002, TR-DATA-001, NFR-SEC-001.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectUpdateRepository,
} from "../../packages/data/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { applyBusinessTableGrants } from "../../packages/operations/dist/business-grants.js";

const { Pool } = createRequire(new URL("../../packages/data/package.json", import.meta.url))("pg");
export const engagementStorageTables = [
  "ProjectUpdateEngagement", "ProjectUpdateStage", "ProjectUpdateOutbox", "ProjectUpdateDispatchAttempt",
];
export const engagementStorageFunctions = [
  "guard_update_engagement_storage", "reject_update_engagement_history", "guard_update_stage_snapshot",
  "guard_update_outbox", "guard_update_attempt_insert", "require_update_stage_outbox", "record_update_dispatch_attempt",
];
async function rejected(pool, sql, parameters, code, message) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await assert.rejects(async () => {
      await connection.query(sql, parameters);
      await connection.query("SET CONSTRAINTS ALL IMMEDIATE");
    }, (error) => error.code === code && (!message || error.message === message));
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
}
export async function verifyEngagementStoragePrivileges(pool) {
  for (const table of engagementStorageTables)
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"])
      for (const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER","MAINTAIN"]) {
        const row = (await pool.query("SELECT has_table_privilege($1,$2,$3) AS allowed",
          [role, 'public."' + table + '"', privilege])).rows[0];
        assert.equal(row.allowed, role === "pdaa_backup" && privilege === "SELECT",
          role + "/" + table + "/" + privilege);
      }
  for (const name of engagementStorageFunctions)
    for (const role of ["pdaa_api","pdaa_worker","pdaa_backup"])
      assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [role, "public." + name + "()"])).rows[0].allowed, false);
  const functions = (await pool.query(`SELECT p.proname,p.prosecdef,pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`, [engagementStorageFunctions])).rows;
  assert.equal(functions.length, engagementStorageFunctions.length);
  assert(functions.every((row) => !row.prosecdef && row.owner === "pdaa_migrate"));
}
export async function verifyUpdateEngagementStorage(databaseUrl) {
  const target = new URL(databaseUrl);
  if (process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
      !["localhost","127.0.0.1"].includes(target.hostname) || !/^\/pdaa_test_[0-9]+$/.test(target.pathname))
    throw new Error("Engagement storage checks require an isolated synthetic database");
  const db = createDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const customerId = process.env.CUSTOMER_ID;
    assert(customerId);
    const portfolioId = randomUUID();
    const actor = { customerId, subject: "engagement-storage-" + randomUUID(), roles: ["pmo_admin"] };
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic engagement storage" } });
    await db.accessGrant.create({ data: {
      customerId, subject: actor.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin",
    } });
    const project = await new DatabaseCanonicalProjectRepository(db).createProject(
      actor, canonicalFixture(portfolioId), randomUUID());
    const projectId = project.id;
    await db.accessGrant.create({ data: {
      customerId, subject: "synthetic-owner-1", scopeType: "project", scopeId: projectId, role: "project_manager",
    } });
    const updates = new DatabaseProjectUpdateRepository(db);
    await updates.setPolicy(actor, projectId, {
      expectedRevision: 0, freshnessWindowSeconds: 1, timeZone: "UTC",
      requiredFacts: [{ factType: "project.status", label: "Current status" }],
      responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false,
      reminderBusinessDayOffsets: [1,2,4], escalationAfterBusinessDays: 5,
      escalationRecipientSubject: "synthetic-owner-1", quietHoursStartLocal: "22:00", quietHoursEndLocal: "07:00",
    }, randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await updates.assess(actor, projectId, randomUUID());
    await updates.assess(actor, projectId, randomUUID());
    const obligation = (await pool.query(`SELECT * FROM "ProjectUpdateObligation"
      WHERE "customerId"=$1 AND "projectId"=$2 AND state='OPEN'`, [customerId,projectId])).rows[0];
    assert(obligation);
    const otherAssessment = (await pool.query(`SELECT id FROM "ProjectUpdateAssessment"
      WHERE "customerId"=$1 AND "projectId"=$2 AND id<>$3 LIMIT 1`,
      [customerId,projectId,obligation.assessmentId])).rows[0].id;
    const audit = async (connection = pool) => {
      const id = randomUUID();
      await connection.query(`INSERT INTO "AuditEvent" (id,"customerId",actor,event,"correlationId",detail)
        VALUES ($1,$2,$3,'update.engagement.storage.fixture',$4,'{}'::jsonb)`,
        [id,customerId,actor.subject,randomUUID()]);
      return id;
    };
    const engagementId = randomUUID();
    const engagementSql = `INSERT INTO "ProjectUpdateEngagement"
      (id,"customerId","projectId","obligationId","policyRevisionId","policyRevision","assessmentId","ownerSubject","auditEventId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'synthetic-owner-4',$8)`;
    const lineage = [engagementId,customerId,projectId,obligation.id,obligation.policyRevisionId,
      obligation.policyRevision,obligation.assessmentId,await audit()];
    const substituted = [...lineage]; substituted[0] = randomUUID(); substituted[6] = otherAssessment;
    await rejected(pool,engagementSql,substituted,"23503");
    await pool.query(engagementSql,lineage);
    const crossProject = [...lineage]; crossProject[0]=randomUUID();
    crossProject[2]="30000000-0000-4000-8000-000000000001";
    await rejected(pool,engagementSql,crossProject,"55000","Invalid engagement storage activation");
    const due = new Date(obligation.freshnessThresholdAt);
    const stageSql = `INSERT INTO "ProjectUpdateStage"
      (id,"customerId","projectId","engagementId","obligationId","policyRevisionId","policyRevision","assessmentId",
       generation,kind,ordinal,"recipientSubject","recipientRole","factTypes","timeZone","zoneSource",
       "logicalDueAt","candidateAt","scheduledAt","localAt","utcOffset","deferralReasons","ruleRevision",mode,"auditEventId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,'synthetic-owner-4','OWNER',ARRAY['project.status'],
        'UTC','PROJECT',$11,$11,$12,$13,'+00:00',$14,'engagement-schedule@1',$15,$16)`;
    const stageParameters = async (kind,ordinal,mode,deferred = false) => {
      const scheduled = new Date(due.getTime() + (deferred ? 3600000 : 0));
      return [randomUUID(),customerId,projectId,engagementId,obligation.id,obligation.policyRevisionId,
        obligation.policyRevision,obligation.assessmentId,kind,ordinal,due,scheduled,
        scheduled.toISOString().slice(0,19),deferred ? ["QUIET_HOURS"] : [],mode,await audit()];
    };
    const orphan = await stageParameters("REQUEST",0,"CAPTURE");
    await rejected(pool,stageSql,orphan,"55000","Engagement stage requires an outbox intent");
    const createIntent = async (parameters) => {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(stageSql,parameters);
        const id = randomUUID();
        await connection.query(`INSERT INTO "ProjectUpdateOutbox"
          (id,"customerId","projectId","stageId","availableAt","auditEventId")
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [id,customerId,projectId,parameters[0],parameters[11],parameters[15]]);
        await connection.query("COMMIT");
        return id;
      } catch (error) { await connection.query("ROLLBACK"); throw error; }
      finally { connection.release(); }
    };
    const mismatchedStage=[...orphan]; mismatchedStage[0]=randomUUID(); mismatchedStage[7]=otherAssessment;
    await rejected(pool,stageSql,mismatchedStage,"23503");
    const unreasonedStage=await stageParameters("REMINDER",4,"CAPTURE",true); unreasonedStage[13]=[];
    await rejected(pool,stageSql,unreasonedStage,"55000","Invalid engagement stage snapshot");
    const capture = await createIntent(orphan);
    const duplicate = await stageParameters("REQUEST",0,"CAPTURE");
    await rejected(pool,stageSql,duplicate,"23505");
    const shadow = await createIntent(await stageParameters("REMINDER",1,"SHADOW"));
    const lease = await createIntent(await stageParameters("REMINDER",2,"CAPTURE"));
    const unknown = await createIntent(await stageParameters("ESCALATION",5,"EMAIL"));
    const quiet = await createIntent(await stageParameters("REMINDER",4,"CAPTURE",true));
    const claimSql = `UPDATE "ProjectUpdateOutbox" SET state='CLAIMED',
      "claimGeneration"="claimGeneration"+1,"leaseUntil"=clock_timestamp()+interval '2 seconds',
      reason=NULL,"auditEventId"=$2 WHERE id=$1 AND state='READY' RETURNING id`;
    const claim = async (id) => (await pool.query(claimSql,[id,await audit()])).rowCount;
    const outcomes = await Promise.all([claim(capture),claim(capture)]);
    assert.equal(outcomes.reduce((sum,count) => sum+count,0),1,"Only one concurrent claim may win");
    await pool.query(`UPDATE "ProjectUpdateOutbox" SET state='CAPTURED',"leaseUntil"=NULL,
      "completedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2 WHERE id=$1`,
      [capture,await audit()]);
    await claim(shadow);
    await pool.query(`UPDATE "ProjectUpdateOutbox" SET state='SUPPRESSED',"leaseUntil"=NULL,
      "completedAt"=date_trunc('milliseconds',clock_timestamp()),reason='SHADOW_MODE',"auditEventId"=$2 WHERE id=$1`,
      [shadow,await audit()]);
    await claim(lease);
    const releaseSql = `UPDATE "ProjectUpdateOutbox" SET state='READY',"leaseUntil"=NULL,
      reason='LEASE_EXPIRED',"auditEventId"=$2 WHERE id=$1`;
    await rejected(pool,releaseSql,[lease,await audit()],"55000","Invalid engagement outbox transition");
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await pool.query(releaseSql,[lease,await audit()]);
    assert.equal(await claim(lease),1);
    await rejected(pool,`UPDATE "ProjectUpdateOutbox" SET state='CAPTURED',"claimGeneration"=1,
      "leaseUntil"=NULL,"completedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2 WHERE id=$1`,
      [lease,await audit()],"55000","Invalid engagement outbox transition");
    await claim(unknown);
    await pool.query(`UPDATE "ProjectUpdateOutbox" SET state='HANDED_OFF',"handoffAt"=date_trunc('milliseconds',clock_timestamp()),
      "auditEventId"=$2 WHERE id=$1`, [unknown,await audit()]);
    await pool.query(`UPDATE "ProjectUpdateOutbox" SET state='UNKNOWN',"leaseUntil"=NULL,
      "completedAt"=date_trunc('milliseconds',clock_timestamp()),reason='HANDOFF_UNCERTAIN',"auditEventId"=$2 WHERE id=$1`,
      [unknown,await audit()]);
    await rejected(pool,`UPDATE "ProjectUpdateOutbox" SET state='READY',"handoffAt"=NULL,
      "completedAt"=NULL,reason='LEASE_EXPIRED',"auditEventId"=$2 WHERE id=$1`,
      [unknown,await audit()],"55000","Invalid engagement outbox rewrite");
    await rejected(pool,`UPDATE "ProjectUpdateOutbox" SET state='READY',"completedAt"=NULL,
      reason=NULL,"auditEventId"=$2 WHERE id=$1`,[capture,await audit()],"55000","Invalid engagement outbox transition");
    await rejected(pool,`INSERT INTO "ProjectUpdateDispatchAttempt"
      (id,"customerId","projectId","outboxId","claimGeneration",event,"availableAt","auditEventId")
      VALUES ($1,$2,$3,$4,0,'ENQUEUED',$5,$6)`,
      [randomUUID(),customerId,projectId,quiet,due,await audit()],"55000",
      "Engagement attempts require an outbox transition");
    for (const table of ["ProjectUpdateStage","ProjectUpdateDispatchAttempt"]) {
      for (const operation of ["UPDATE","DELETE","TRUNCATE"])
        await rejected(pool,operation==="UPDATE" ? `UPDATE "${table}" SET id=id` :
          operation==="DELETE" ? `DELETE FROM "${table}"` : `TRUNCATE "${table}" CASCADE`,
          [],"55000","Engagement storage history is immutable");
    }
    const quietRecord = (await pool.query(`SELECT s."deferralReasons",s."candidateAt",s."scheduledAt",o.state
      FROM "ProjectUpdateStage" s JOIN "ProjectUpdateOutbox" o ON o."stageId"=s.id WHERE o.id=$1`, [quiet])).rows[0];
    assert.deepEqual(quietRecord.deferralReasons,["QUIET_HOURS"]);
    assert.equal(quietRecord.scheduledAt.getTime()-quietRecord.candidateAt.getTime(),3600000);
    const history = (await pool.query(`SELECT event,"claimGeneration" FROM "ProjectUpdateDispatchAttempt"
      WHERE "outboxId"=$1 ORDER BY "recordedAt",event`,[unknown])).rows;
    assert.deepEqual(history.map((row) => row.event).sort(),["ENQUEUED","CLAIMED","HANDED_OFF","UNKNOWN"].sort());
    // Verify both initial migration ACL and reconstruction after --no-acl restore.
    await verifyEngagementStoragePrivileges(pool);
    for (const name of engagementStorageFunctions)
      await pool.query(`GRANT EXECUTE ON FUNCTION public.${name}() TO PUBLIC`);
    const before = (await pool.query('SELECT * FROM "ProjectUpdateDispatchAttempt" ORDER BY id')).rows;
    await applyBusinessTableGrants(pool);
    await verifyEngagementStoragePrivileges(pool);
    assert.deepEqual((await pool.query('SELECT * FROM "ProjectUpdateDispatchAttempt" ORDER BY id')).rows,before);
    assert.equal((await pool.query(`SELECT has_column_privilege('pdaa_api','public."ProjectUpdateObligation"',
      'supersededAt','UPDATE') AS allowed`)).rows[0].allowed,true);
    return { projectId,engagementId,unknownOutboxId:unknown,quietOutboxId:quiet,
      stageCount:5,atomicIntent:true,concurrentClaim:true,preHandoffReclaim:true,
      postHandoffUnknown:true,immutableReceipts:true,quietReasonStored:true,finiteAcl:true };
  } finally { await db.$disconnect(); await pool.end(); }
}

export async function verifyRestoredEngagementStorage(database,evidence) {
  assert(evidence?.unknownOutboxId && evidence?.engagementId,"Populated engagement evidence required");
  for (const table of engagementStorageTables)
    assert((await database.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`))[0].n>0,
      "Restore must include populated " + table);
  const outcome = (await database.$queryRawUnsafe(
    'SELECT state,"handoffAt" FROM "ProjectUpdateOutbox" WHERE id=$1::uuid',evidence.unknownOutboxId))[0];
  assert.equal(outcome.state,"UNKNOWN");
  assert(outcome.handoffAt instanceof Date);
  const invalid = (await database.$queryRawUnsafe(`
    SELECT (
      SELECT count(*) FROM "ProjectUpdateStage" s WHERE NOT EXISTS (
        SELECT 1 FROM "ProjectUpdateOutbox" o WHERE o."customerId"=s."customerId"
          AND o."projectId"=s."projectId" AND o."stageId"=s.id
      )
    ) + (
      SELECT count(*) FROM "ProjectUpdateOutbox" o WHERE NOT EXISTS (
        SELECT 1 FROM "ProjectUpdateDispatchAttempt" a WHERE a."customerId"=o."customerId"
          AND a."projectId"=o."projectId" AND a."outboxId"=o.id AND a."claimGeneration"=o."claimGeneration"
          AND a.event=CASE WHEN o.state='READY' AND o."claimGeneration"=0 THEN 'ENQUEUED'
            WHEN o.state='READY' THEN 'RELEASED' ELSE o.state END
          AND a."handoffAt" IS NOT DISTINCT FROM o."handoffAt" AND a.reason IS NOT DISTINCT FROM o.reason
          AND a."auditEventId"=o."auditEventId"
      )
    ) AS n`))[0].n;
  assert.equal(Number(invalid),0,"Restored stages/intents/receipts must remain complete");
  for (const table of ["ProjectUpdateStage","ProjectUpdateDispatchAttempt"])
    for (const operation of ["UPDATE","DELETE","TRUNCATE"])
      await assert.rejects(() => database.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(operation==="UPDATE" ? `UPDATE "${table}" SET id=id` :
          operation==="DELETE" ? `DELETE FROM "${table}"` : `TRUNCATE "${table}" CASCADE`);
        throw new Error("History mutation unexpectedly succeeded");
      }), (error) => {
        const cause=error?.meta?.driverAdapterError?.cause;
        return error.code==="P2010" && cause?.originalCode==="55000" &&
          cause.originalMessage==="Engagement storage history is immutable";
      });
  await assert.rejects(() => database.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ProjectUpdateOutbox" SET state='READY',"handoffAt"=NULL,
      "completedAt"=NULL,"auditEventId"=$2::uuid WHERE id=$1::uuid`,
      evidence.unknownOutboxId,randomUUID());
    throw new Error("UNKNOWN replay unexpectedly succeeded");
  }), (error) => {
    const cause=error?.meta?.driverAdapterError?.cause;
    return error.code==="P2010" && cause?.originalCode==="55000" &&
      cause.originalMessage==="Invalid engagement outbox rewrite";
  });
}
