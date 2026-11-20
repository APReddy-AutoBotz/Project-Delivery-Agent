// FR-CON-006/007: real API-login retry against stored synthetic workbook receipts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase, DatabaseIngestionRepository } from "../../packages/data/dist/index.js";
import { CredentialVault } from "../../packages/platform/dist/index.js";
import { xlsxRetryFunction } from "../../packages/operations/dist/business-grants.js";

export async function verifyXlsxRetryPrivileges(pool, roles, { owner, apiExecute = false } = {}) {
  const {rows} = await pool.query(`SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
    ARRAY(SELECT a.grantee::regrole::text FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE' ORDER BY a.grantee) AS execute_roles,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND a.is_grantable) AS grants_execution
    FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,[xlsxRetryFunction]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].prosecdef,true);
  assert.deepEqual(rows[0].proconfig,["search_path=pg_catalog, pg_temp"]);
  assert.deepEqual(rows[0].execute_roles,apiExecute ? ["pdaa_api"] : []);
  assert.equal(rows[0].grants_execution,false);
  if (owner !== undefined) assert.equal(rows[0].owner,owner);
  for (const role of roles) assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
    [role,xlsxRetryFunction])).rows[0].allowed,role==="pdaa_api" && apiExecute);
  return {apiExecute,otherRolesDenied:true,fixedSearchPath:true};
}

async function ownerTransaction(pool, work) {
  const client=await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL ROLE pdaa_migrate");
    const result=await work(client);
    await client.query("COMMIT");
    return result;
  } finally {
    try { await client.query("ROLLBACK"); }
    finally { client.release(); }
  }
}

async function fixtureReceipt(pool) {
  const {rows}=await pool.query(`SELECT r.id AS "receiptId",r."customerId",r."sourceId",r.subject,r."commandKey",
    r."configRevision",r."mappingRevision",r."outcomeCount",c.mapping,scope."projectId",p."portfolioId",
    s."currentConfigRevision",scope."grantId"
    FROM public."IngestionXlsxContext" x JOIN public."IngestionOperationReceipt" r ON r.id=x."receiptId"
    JOIN public."IngestionSource" s ON s."customerId"=r."customerId" AND s.id=r."sourceId"
    JOIN public."IngestionConfigurationRevision" c ON c."customerId"=r."customerId" AND c."sourceId"=r."sourceId" AND c.revision=r."configRevision"
    JOIN public."IngestionReceiptProjectScope" scope ON scope."receiptId"=r.id
    JOIN public."Project" p ON p."customerId"=r."customerId" AND p.id=scope."projectId"
    WHERE x.revision=1 AND r."commandKey"='fixture-preview-1'`);
  assert.equal(rows.length,1);
  return rows[0];
}

async function reviseScope(pool, fixture, projectIds, readers) {
  const {customerId,sourceId,mappingRevision,mapping,subject}=fixture;
  return ownerTransaction(pool,async(client)=>{
    await client.query(`SELECT id FROM public."Project" WHERE "customerId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,[customerId,projectIds]);
    const {rows}=await client.query(`SELECT "currentConfigRevision" FROM public."IngestionSource"
      WHERE "customerId"=$1 AND id=$2 FOR UPDATE`,[customerId,sourceId]);
    const revision=rows[0].currentConfigRevision+1, audit=randomUUID(), at=new Date();
    await client.query(`INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
      VALUES ($1,$2,$3,'ingestion.configuration.changed',$4,$5,$6)`,[audit,customerId,subject,randomUUID(),at,
      {sourceId,configRevision:revision,mappingRevision}]);
    await client.query(`INSERT INTO public."IngestionConfigurationRevision" ("customerId","sourceId",revision,"mappingRevision",mapping,"changedBy","auditEventId","createdAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[customerId,sourceId,revision,mappingRevision,mapping,subject,audit,at]);
    for (const project of projectIds) {
      await client.query(`INSERT INTO public."IngestionConfigurationProject" VALUES ($1,$2,$3,$4)`,[customerId,sourceId,revision,project]);
      if (readers.includes(project)) await client.query(`INSERT INTO public."IngestionConfigurationReader" VALUES ($1,$2,$3,$4,$5)`,[customerId,sourceId,revision,project,subject]);
    }
    await client.query(`UPDATE public."IngestionConfigurationRevision" SET sealed=true WHERE "customerId"=$1 AND "sourceId"=$2 AND revision=$3`,[customerId,sourceId,revision]);
    await client.query(`UPDATE public."IngestionSource" SET "currentConfigRevision"=$3
      WHERE "customerId"=$1 AND id=$2`,[customerId,sourceId,revision]);
    return revision;
  });
}

const errorCode = (expected) => (error) => error?.code === expected;
const vault = new CredentialVault(Buffer.alloc(32, 7).toString("base64"));
const requestFor = ({sourceId,commandKey,configRevision,mappingRevision,mapping}) =>
  ({sourceId,commandKey,configRevision,mappingRevision,sheet:mapping.sheet});
const workbookFor = ({commandKey}) => Buffer.from("synthetic workbook " + commandKey);
const resultFor = ({receiptId,outcomeCount}) => ({receiptId,replayed:true,rowCount:outcomeCount});

export async function proveNativeXlsxPreviewRetry(pool, apiConnection) {
  const fixture=await fixtureReceipt(pool);
  const {customerId,sourceId,subject,projectId,portfolioId,grantId}=fixture;
  assert.equal(fixture.currentConfigRevision,fixture.configRevision,"Expected untouched synthetic fixture scope");
  const additionalProject=randomUUID(), additionalGrant=randomUUID();
  await ownerTransaction(pool,async(client)=>{
    await client.query(`INSERT INTO public."Project" (id,"customerId","portfolioId",code,name,description,"reportedStatus")
      VALUES ($1,$2,$3,$4,'Synthetic retry scope','Workbook replay fixture','UNKNOWN')`,[additionalProject,customerId,portfolioId,additionalProject]);
    await client.query(`INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role)
      VALUES ($1,$2,$3,'project',$4,'pmo_admin')`,[additionalGrant,customerId,subject,additionalProject]);
  });
  const projects=[projectId,additionalProject].sort();
  const currentRevision=await reviseScope(pool,fixture,projects,projects);
  const snapshot = async () => (await pool.query(`SELECT to_jsonb(h) AS head,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY revision) FROM public."IngestionXlsxContext" c WHERE c."sourceId"=h."sourceId") AS contexts,
    (SELECT count(*)::integer FROM public."IngestionOperationReceipt" r WHERE r."sourceId"=h."sourceId") AS receipts
    FROM public."IngestionXlsxHead" h WHERE h."customerId"=$1 AND h."sourceId"=$2`,[customerId,sourceId])).rows;
  const saved=await snapshot();
  const actor={customerId,subject,roles:["pmo_admin"]};
  const original=requestFor(fixture), workbook=workbookFor(fixture), expected=resultFor(fixture);
  const {rows:[latest]}=await pool.query(`SELECT r.id AS "receiptId",r."commandKey",r."configRevision",r."mappingRevision",r."outcomeCount"
    FROM public."IngestionXlsxHead" h JOIN public."IngestionOperationReceipt" r ON r.id=h."currentReceiptId"
    WHERE h."customerId"=$1 AND h."sourceId"=$2`,[customerId,sourceId]);
  const auditCount=async()=>Number((await pool.query(`SELECT count(*) AS n FROM public."AuditEvent"
    WHERE "customerId"=$1 AND actor=$2`,[customerId,subject])).rows[0].n);
  const beforeRetryAuditCount=await auditCount();
  const db=createDatabase(apiConnection);
  try {
    assert.deepEqual(await db.$queryRaw`SELECT session_user::text AS role`,[{role:"pdaa_api"}]);
    const repository=new DatabaseIngestionRepository(db,vault);
    const retry = (input=original,bytes=workbook,principal=actor) => repository.probeXlsxPreviewRetry(principal,input,bytes,randomUUID());
    const prepare = (input=original,bytes=workbook,principal=actor) => repository.prepareXlsxPreview(principal,input,bytes,randomUUID());
    assert.deepEqual(await retry(),expected);
    const replay = await prepare();
    assert.deepEqual(replay,{kind:"REPLAYED",result:expected});
    assert.equal(Object.isFrozen(replay),true);
    assert.equal(Object.isFrozen(replay.result),true);
    assert.deepEqual(await new DatabaseIngestionRepository(db,vault).probeXlsxPreviewRetry(actor,original,workbook,randomUUID()),expected);
    assert.notEqual(latest.receiptId,fixture.receiptId);
    assert.equal(latest.outcomeCount,0);
    assert.deepEqual(await retry(requestFor({...fixture,...latest}),workbookFor(latest)),resultFor(latest));
    assert.equal(await auditCount(),beforeRetryAuditCount);
    const altered=Buffer.from(workbook); altered[0]^=1;
    for (const [input,bytes] of [[original,altered],[original,Buffer.concat([workbook,Buffer.from("x")])],
      [{...original,configRevision:currentRevision},workbook],[{...original,mappingRevision:original.mappingRevision+1},workbook],
      [{...original,sheet:"Another sheet"},workbook]]) await assert.rejects(retry(input,bytes),errorCode("CONFLICT"));
    const fresh = {...original,commandKey:"missing-workbook-command",configRevision:currentRevision};
    const admission = await prepare(fresh,null);
    assert.deepEqual(admission,{kind:"FRESH",parserContract:fixture.mapping.parserContract});
    assert.equal(Object.isFrozen(admission),true);
    assert.equal(await retry(fresh,null),null);
    await assert.rejects(prepare({...fresh,sheet:"Another sheet"},null),errorCode("STALE_CONFIGURATION"));
    await assert.rejects(prepare({...fresh,mappingRevision:fresh.mappingRevision+1},null),errorCode("STALE_CONFIGURATION"));
    await assert.rejects(prepare({...fresh,configRevision:original.configRevision},null),errorCode("STALE_CONFIGURATION"));
    await assert.rejects(prepare(fresh,null,{...actor,subject:"another-synthetic-subject"}),errorCode("DENIED"));
    assert.deepEqual(await db.$queryRaw`SELECT * FROM public.probe_ingestion_xlsx_retry(
      ${randomUUID()}::uuid,${sourceId}::uuid,${subject}::text,ARRAY['pmo_admin']::text[],${original.commandKey}::text,
      ${original.configRevision}::integer,${original.mappingRevision}::integer,${original.sheet}::text,NULL::integer,NULL::text)`,
    [{status:"DENIED",receipt_id:null,row_count:null}]);
    await assert.rejects(retry({...original,sourceId:randomUUID()},null),errorCode("DENIED"));
    await assert.rejects(retry(original,null,{...actor,subject:"another-synthetic-subject"}),errorCode("DENIED"));
    await assert.rejects(retry(original,null,{...actor,roles:["project_manager"]}),errorCode("DENIED"));
    // Denial must precede byte inspection and same-key conflict reporting.
    for (const id of [grantId,additionalGrant]) {
      await pool.query(`UPDATE public."AccessGrant" SET role='leadership' WHERE id=$1`,[id]);
      try { await assert.rejects(retry({...original,configRevision:currentRevision},null),errorCode("DENIED")); }
      finally { await pool.query(`UPDATE public."AccessGrant" SET role='pmo_admin' WHERE id=$1`,[id]); }
    }
    await reviseScope(pool,fixture,projects,[additionalProject]);
    try { await assert.rejects(retry(original,null),errorCode("DENIED")); }
    finally { await reviseScope(pool,fixture,projects,projects); }
    const lock=await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(`SELECT id FROM public."Project" WHERE id=$1 FOR UPDATE`,[projectId]);
      const unentitled={...actor,subject:"another-synthetic-subject"};
      await assert.rejects(retry(original,null,unentitled),errorCode("DENIED"));
      await assert.rejects(retry({...original,commandKey:"missing-workbook-command"},null,unentitled),errorCode("DENIED"));
      await assert.rejects(retry(original,null),errorCode("PERSISTENCE_FAILED"));
    } finally {
      try { await lock.query("ROLLBACK"); }
      finally { lock.release(); }
    }
    assert.deepEqual(await retry(),expected);
    assert.deepEqual(await snapshot(),saved);
    return {exactAfterConfigAndHeadAdvance:true,sameKeyConflict:true,denialBeforeWorkbook:true,
      capturedAndCurrentGrantChecks:true,readerRevocationDenied:true,contentionFailsClosed:true,
      unauthorizedContentionDenial:true,emptyHeadReplayed:true,successfulRetryAuditUnchanged:true,
      freshAdmissionReturnsOnlySealedProfile:true,mapStateUnchanged:true};
  } finally { await db.$disconnect(); }
}
