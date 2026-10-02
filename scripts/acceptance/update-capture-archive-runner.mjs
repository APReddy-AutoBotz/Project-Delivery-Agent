// EXEC-015 / NFR-REL-002: packaged historical retention and recovery fixture.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {Pool,config,guard} from "./common.mjs";
import {seedCaptureArchiveParent,constructCaptureArchive,captureArchiveProjection,verifyCaptureArchiveIntegrity,verifyExpiredArchiveDisclosure} from "./update-capture-archive.mjs";
import {verifyUpdateCapturePrivileges,assertUpdateCaptureRestoreProjection} from "./update-capture-storage.mjs";
guard();
assert.match(process.env.PDAA_ACCEPTANCE_RUN_ID,/^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
const sourceConfig=config("database","fixture_admin","admin-password").database;
const output=process.env.PDAA_ARTIFACT_DIR;
const file=(name)=>output+"/capture-history-"+name+".json";
const save=(name,value)=>writeFileSync(file(name),JSON.stringify(value,null,2)+"\n");
const read=(name)=>JSON.parse(readFileSync(file(name),"utf8"));
const source=new Pool(sourceConfig);
const withTarget=async(name,operation)=>{assert(["capture_history","capture_history_restore","capture_history_bad","capture_history_failed"].includes(name));const pool=new Pool({...sourceConfig,database:name});try{return await operation(pool);}finally{await pool.end();}};
const mode=process.argv[2];
try {
 if(mode==="prepare") {
  const parent=await seedCaptureArchiveParent(sourceConfig), nonce=randomUUID();
  for(const name of ["capture_history","capture_history_restore","capture_history_bad","capture_history_failed"]) {
   await source.query('CREATE DATABASE "'+name+'" TEMPLATE template0');
   await source.query('REVOKE CONNECT ON DATABASE "'+name+'" FROM PUBLIC,pdaa_api,pdaa_worker');
   await source.query('GRANT CONNECT ON DATABASE "'+name+'" TO pdaa_migrate,pdaa_backup');
  }
  await source.query('COMMENT ON DATABASE capture_history IS '+"'pdaa.capture.archive.build:"+nonce+"'");
  await source.query('COMMENT ON DATABASE capture_history_bad IS '+"'pdaa.capture.archive.build:"+nonce+"'");
  save("parent",{parent,nonce,runId:process.env.PDAA_ACCEPTANCE_RUN_ID});
 } else if(mode==="construct") {
  const {parent,nonce,runId}=read("parent");assert.equal(runId,process.env.PDAA_ACCEPTANCE_RUN_ID);
  const evidence=await withTarget("capture_history",pool=>constructCaptureArchive(source,pool,parent,nonce,sourceConfig,{...sourceConfig,database:"capture_history"}));
  save("evidence",evidence);
 } else if(mode==="source") {
  const evidence=read("evidence");
  await withTarget("capture_history",async(pool)=>{
   await verifyUpdateCapturePrivileges(pool);
   const rows=await verifyCaptureArchiveIntegrity(pool,evidence);
   for(const [stateField,deadline] of [["state","purgeAfter"],["responseState","responsePurgeAfter"]]) {
    assert.equal(rows.filter(r=>r[stateField]==="PRESENT"&&r[deadline]<=r.databaseNow).length,51);
    assert.equal(rows.filter(r=>r[stateField]==="PURGED").length,1);
    assert.equal(rows.filter(r=>r[stateField]==="PRESENT"&&r[deadline]>r.databaseNow).length,1);
   }
   const disclosure=await verifyExpiredArchiveDisclosure({...sourceConfig,database:"capture_history"},evidence);
   save("source-disclosure",disclosure);save("before",await captureArchiveProjection(pool));
   await pool.query('COMMENT ON DATABASE capture_history IS '+"'pdaa.foundation.v1:"+evidence.customerId+"'");
  });
 } else if(mode==="bad-data") {
  const {nonce}=read("parent"),evidence=read("evidence");
  await withTarget("capture_history_bad",async(pool)=>{
   assert.equal((await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker,"pdaa.capture.archive.build:"+nonce);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")).rows[0].n,0);
   assert.equal((await pool.query('UPDATE public."CanonicalProject" SET sealed=false WHERE id=$1::uuid',[evidence.projectId])).rowCount,1);
   save("bad-before",await captureArchiveProjection(pool));
  });
 } else if(mode==="verify") {
  const evidence=read("evidence"), before=read("before");
  const receipt=await withTarget("capture_history_restore",async(pool)=>{
   await verifyUpdateCapturePrivileges(pool);await verifyCaptureArchiveIntegrity(pool,evidence);
   const after=await captureArchiveProjection(pool);assertUpdateCaptureRestoreProjection(after,before);
   for(const [table,idField] of [["ProjectUpdateRequestContent","requestId"],["ProjectUpdateResponseContent","responseId"]]) {
    assert.equal(after[table].filter(r=>r.state==="PURGED").length,51);assert.equal(after[table].filter(r=>r.state==="PRESENT").length,2);
    for(const pair of [evidence.pairs[51],evidence.pairs[52]]) assert.deepEqual(after[table].find(r=>r[idField]===pair[idField]),before[table].find(r=>r[idField]===pair[idField]));
   }
   const boundary=(await pool.query("SELECT shobj_description(oid,'pg_database') AS marker,has_database_privilege('pdaa_api',oid,'CONNECT') AS api,has_database_privilege('pdaa_worker',oid,'CONNECT') AS worker FROM pg_database WHERE datname=current_database()")).rows[0];
   assert.equal(boundary.marker,"pdaa.restore.quarantine.v1:"+evidence.customerId);assert.equal(boundary.api,false);assert.equal(boundary.worker,false);
   const tx=await pool.connect();try{await tx.query("BEGIN");await tx.query("SET LOCAL ROLE pdaa_api");
    assert.equal((await tx.query("SELECT public.purge_update_capture_content($1::uuid) AS n",[evidence.customerId])).rows[0].n,2);
    assert.equal((await tx.query("SELECT public.purge_update_capture_content($1::uuid) AS n",[evidence.customerId])).rows[0].n,0);
    await tx.query("COMMIT");}catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
   const final=await captureArchiveProjection(pool);
   for(const table of ["ProjectUpdateCapturedRequest","ProjectUpdateInvitation","ProjectUpdateResponse","ProjectUpdateStage","ProjectUpdateOutbox","ProjectUpdateDispatchAttempt"])assert.deepEqual(final[table],before[table]);
   return {requestResponsePairs:53,expiredPresentPairs:51,priorPurgedPairs:1,livePresentPairs:1,restorePurgedRequests:50,restorePurgedResponses:50,
    subsequentApiPurge:2,repeatApiPurge:0,metadataAndLocatorsExact:true,unchangedGuardsAndFinitePrivileges:true,runtimeConnectQuarantined:true,...read("source-disclosure")};
  });save("receipt",receipt);
 } else if(mode==="operator-prepare" || mode==="operator-promote") {
  const evidence=read("evidence");
  await withTarget("capture_history_restore",async(pool)=>{
   const gate=(await pool.query('SELECT "issuanceEnabled" AS enabled,"issuanceEpoch" AS epoch,revision FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1::uuid',[evidence.customerId])).rows[0];
   assert.equal(gate.enabled,false);
   assert.equal((await pool.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker,"pdaa.restore.quarantine.v1:"+evidence.customerId);
   if(mode==="operator-promote") await pool.query('COMMENT ON DATABASE capture_history_restore IS '+"'pdaa.foundation.v1:"+evidence.customerId+"'");
   save("operator",{customerId:evidence.customerId,gate,configuration:{customerId:evidence.customerId,mode:"CAPTURE",issuanceEpoch:gate.epoch,
    invitationLifetimeSeconds:900,contentRetentionSeconds:86400,responseReviewerSubjects:[evidence.subject]}});
  });
 } else if(mode==="operator-verify") {
  const evidence=read("evidence"), before=read("operator");
  await withTarget("capture_history_restore",async(pool)=>{
   const gate=(await pool.query('SELECT "issuanceEnabled" AS enabled,"issuanceEpoch" AS epoch,revision FROM public."ProjectUpdateIssuanceGate" WHERE "customerId"=$1::uuid',[evidence.customerId])).rows[0];
   assert.deepEqual(gate,{enabled:true,epoch:before.gate.epoch,revision:before.gate.revision+1});
   assert.equal((await pool.query("SELECT has_database_privilege('pdaa_api',current_database(),'CONNECT') AS api,has_database_privilege('pdaa_worker',current_database(),'CONNECT') AS worker")).rows[0].api,false);
   assert.equal((await pool.query("SELECT has_database_privilege('pdaa_worker',current_database(),'CONNECT') AS worker")).rows[0].worker,false);
   // The fixture promotion is explicit and never grants runtime CONNECT.
   // Old invitation epochs remain denied even after operator enable.
   const disclosure=await verifyExpiredArchiveDisclosure({...sourceConfig,database:"capture_history_restore"},evidence);
   assert.equal(disclosure.oldEpochInvitationDenied,true);
   const after=await captureArchiveProjection(pool), original=read("before");
   for(const table of ["ProjectUpdateCapturedRequest","ProjectUpdateInvitation","ProjectUpdateResponse"])assert.deepEqual(after[table],original[table]);
   save("operator-receipt",{explicitPackagedEnable:true,runtimeConnectStillQuarantined:true,invitationMetadataUnchanged:true,oldEpochInvitationDenied:true});
  });
 } else if(mode==="verify-failed") {
  const evidence=read("evidence");
  await withTarget("capture_history_failed",async(pool)=>{
   assert.deepEqual(await captureArchiveProjection(pool),read("bad-before"),"Failed maintenance must roll back issuance, content purge and audit changes");
   const boundary=(await pool.query("SELECT shobj_description(oid,'pg_database') AS marker,has_database_privilege('pdaa_api',oid,'CONNECT') AS api,has_database_privilege('pdaa_worker',oid,'CONNECT') AS worker FROM pg_database WHERE datname=current_database()")).rows[0];
   assert.equal(boundary.marker,"pdaa.restore.quarantine.v1:"+evidence.customerId);assert.equal(boundary.api,false);assert.equal(boundary.worker,false);
   save("failed-receipt",{maintenanceChangesRolledBack:true,runtimeConnectQuarantined:true,authenticatedInvalidCanonicalArchiveRejected:true});
  });
 } else throw new Error("Unknown historical capture fixture mode");
} finally {await source.end();}
