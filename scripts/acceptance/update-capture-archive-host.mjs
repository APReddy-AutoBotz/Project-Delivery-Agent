// EXEC-015 / NFR-REL-002: host-owned encrypted historical capture rehearsal.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
export function prepareHistoricalCaptureRecovery({docker,compose}) {
 docker(compose("run","--rm","--no-deps","verify","node","scripts/acceptance/update-capture-archive-runner.mjs","prepare"),"capture-history-prepare");
}
export function verifyHistoricalCaptureRecovery({docker,compose,operation,denied,output}) {
 const fixture=(mode)=>docker(compose("run","--rm","--no-deps","verify","node","scripts/acceptance/update-capture-archive-runner.mjs",mode),"capture-history-"+mode);
 const database=(command,...args)=>docker(compose("exec","-T","database",command,"-U","fixture_admin",...args),"capture-history-postgres-"+command+"-"+args.join("-").replace(/[^a-zA-Z0-9_-]/g,"_").slice(-80));
 const target=(name)=>({PDAA_DB_NAME:name,PDAA_OPS_TARGET:"database:5432/"+name});
 const backup=(name)=>{
  const result=docker(operation("backup",{...target(name),PDAA_DB_USER:"pdaa_backup",PDAA_DB_PASSWORD_FILE:"/run/secrets/backup-password"}),"capture-history-backup-"+name,"capture");
  const archive=JSON.parse(result.split("\n").find(line=>line.startsWith('{"operation"'))).result.file;
  assert.match(archive,/^backup-[a-zA-Z0-9-]+\.pdaa$/);return archive;
 };
 const schema="/tmp/pdaa-capture-history-schema.dump", full="/tmp/pdaa-capture-history-full.dump";
 database("pg_dump","-d","pdaa","--format=custom","--schema-only","--file",schema);
 database("pg_restore","-d","capture_history","--exit-on-error","--section=pre-data",schema);
 fixture("construct");
 database("pg_restore","-d","capture_history","--exit-on-error","--section=post-data",schema);
 fixture("source");
 const archive=backup("capture_history");
 docker(operation("restore",target("capture_history_restore"),[archive]),"capture-history-encrypted-restore");
 fixture("verify");
 // An authenticated archive with invalid canonical integrity reaches the real
 // maintenance transaction after rotation/purge, then must roll all of it back.
 // Corruption is injected only in the separate pre-post-data construction DB.
 database("pg_dump","-d","capture_history","--format=custom","--file",full);
 database("pg_restore","-d","capture_history_bad","--exit-on-error","--section=pre-data",full);
 database("pg_restore","-d","capture_history_bad","--exit-on-error","--section=data",full);
 fixture("bad-data");
 database("pg_restore","-d","capture_history_bad","--exit-on-error","--section=post-data",full);
 const invalidArchive=backup("capture_history_bad");
 denied(operation("restore",target("capture_history_failed"),[invalidArchive]),"capture-history-maintenance-failure");
 const diagnostic=readFileSync(join(output,"capture-history-maintenance-failure.log"),"utf8").split("\n")
  .filter(line=>line.startsWith('{"event":"operations.restore.failed"')).map(line=>JSON.parse(line));
 assert.equal(diagnostic.length,1);assert.equal(diagnostic[0].phase,"integrity");
 fixture("verify-failed");
 const receipt=JSON.parse(readFileSync(join(output,"capture-history-receipt.json"),"utf8"));
 const failed=JSON.parse(readFileSync(join(output,"capture-history-failed-receipt.json"),"utf8"));
 for(const [field,value] of Object.entries({requestResponsePairs:53,expiredPresentPairs:51,priorPurgedPairs:1,livePresentPairs:1,
  restorePurgedRequests:50,restorePurgedResponses:50,subsequentApiPurge:2,repeatApiPurge:0,historyEntries:53})) assert.equal(receipt[field],value);
 for(const field of ["metadataAndLocatorsExact","unchangedGuardsAndFinitePrivileges","runtimeConnectQuarantined","expiredBodiesWithheld","liveBodyRetained"])assert.equal(receipt[field],true);
 for(const field of ["maintenanceChangesRolledBack","runtimeConnectQuarantined","authenticatedInvalidCanonicalArchiveRejected"])assert.equal(failed[field],true);
 return {status:"passed",encryptedArchive:true,...receipt,failedMaintenance:{...failed,verifiedFailurePhase:diagnostic[0].phase}};
}
