// FR-CON-006/007/012: host verification of connected CSV comparison evidence.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {comparisonFiles,comparisonScreenshots} from "./csv-comparison-fixture.mjs";
const hash=(bytes)=>createHash("sha256").update(bytes).digest("hex");
const check=(value)=>assert(value,"Invalid CSV comparison workflow proof");
const id=(value)=>typeof value==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const sha=(value)=>typeof value==="string" && /^[0-9a-f]{64}$/.test(value);
const keys=(value,names)=>value && typeof value==="object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const states={prior:[["ACCEPTED","CREATE"],["ACCEPTED","CREATE"]],rename:[["REVIEW_REQUIRED","NONE"],["ACCEPTED","UNCHANGED"]],
  move:[["INVALID","NONE"],["ACCEPTED","UNCHANGED"]],changed:[["ACCEPTED","UPDATE"],["ACCEPTED","UNCHANGED"]]};
const tableCounts=(revision,reviewed)=>({
  IngestionSource:1,IngestionConfigurationRevision:1,IngestionConfigurationProject:2,IngestionConfigurationReader:2,IngestionRetentionPolicy:1,
  IngestionExternalRecord:2,IngestionFactStream:2,IngestionSourceRevision:revision===4 ? 4 : 2,IngestionProposalProjection:revision===4 ? 4 : 2,
  IngestionProposalContent:revision===4 ? 4 : 2,IngestionOperationReceipt:revision+(reviewed ? 1 : 0),IngestionReceiptProjectScope:2*(revision+(reviewed ? 1 : 0)),
  IngestionCursorTransition:0,IngestionRowOutcome:2*revision+(reviewed ? 1 : 0),IngestionReviewedImport:reviewed ? 1 : 0,
  IngestionReviewedImportRow:reviewed ? 1 : 0,IngestionCsvHead:1,IngestionCsvContext:revision,
});
function native(value,revision,receiptId,reviewed) {
  check(keys(value,["sha256","counts","headRevision","headReceiptId","allContextsValid","allReceiptsValid","allContentsValid","headValid","records"]));
  check(sha(value.sha256) && value.headRevision===revision && value.headReceiptId===receiptId && value.records===2);
  check(value.allContextsValid===true && value.allReceiptsValid===true && value.allContentsValid===true && value.headValid===true);
  const expected=tableCounts(revision,reviewed);
  check(keys(value.counts,Object.keys(expected)));
  for (const [table,count] of Object.entries(expected)) check(value.counts[table]===count);
}
function ack(value,receiptId,replayed,parent) {
  check(keys(value,parent ? ["receiptId","replayed","rowCount","parentPreviewReceiptId"] : ["receiptId","replayed","rowCount"]));
  check(value.receiptId===receiptId && value.replayed===replayed && value.rowCount===(parent ? 1 : 2));
  if (parent) check(value.parentPreviewReceiptId===parent);
}
function response(value) {check(keys(value,["status","bytes","sha256"]) && value.status===200 && Number.isSafeInteger(value.bytes) && value.bytes>0 && value.bytes<=65536 && sha(value.sha256));}
export function assertCsvComparisonWorkflowReceipt(value,expected) {
  check(keys(value,["schemaVersion","customerId","projectId","sourceId","profile","runId","movedProjectId","stages","screenshots","review","native","canonical","afterRecreation","storageBeforeBackup","restored"]));
  check(value.schemaVersion===1 && value.customerId==="10000000-0000-4000-8000-000000000002" && value.projectId==="30000000-0000-4000-8000-000000000003");
  check([value.sourceId,value.movedProjectId].every(id) && value.movedProjectId!==value.projectId);
  check(id(expected.originalSourceId) && value.sourceId!==expected.originalSourceId && value.movedProjectId===expected.movedProjectId);
  check(["bundled","external"].includes(value.profile) && value.profile===expected.profile && value.runId===expected.runId && /^pdaa-acceptance-\d+-[a-f0-9]{8}$/.test(value.runId));
  check(Array.isArray(value.stages) && value.stages.length===4);
  const files=comparisonFiles(value.projectId,value.movedProjectId),names=["prior","rename","move","changed"],ids=[];
  for (const [index,stage] of value.stages.entries()) {
    check(keys(stage,["name","receiptId","csvSha256","command","acknowledgement","receipt","receiptEvidence","native"]));
    check(stage.name===names[index] && id(stage.receiptId) && stage.csvSha256===hash(files[stage.name])); ids.push(stage.receiptId);
    check(keys(stage.command,["commandKey","configRevision","mappingRevision"]) && id(stage.command.commandKey) && stage.command.configRevision===1 && stage.command.mappingRevision===1);
    ack(stage.acknowledgement,stage.receiptId,false);
    response(stage.receiptEvidence);
    check(keys(stage.receipt,["id","kind","outcomes"]) && stage.receipt.id===stage.receiptId && stage.receipt.kind==="CSV_PREVIEW");
    check(Array.isArray(stage.receipt.outcomes) && stage.receipt.outcomes.length===2);
    stage.receipt.outcomes.forEach((row,ordinal)=>{
      check(keys(row,["ordinal","state","operation","errorCodes","proposalValue"]) && row.ordinal===ordinal+1 && Array.isArray(row.errorCodes));
      check(equal([row.state,row.operation],states[stage.name][ordinal]));
      if (row.state==="ACCEPTED") check(row.errorCodes.length===0 && row.proposalValue===(ordinal===1 ? "2027-04-15" : stage.name==="changed" ? "2027-03-02" : "2027-03-01"));
      else check(row.proposalValue===null);
    });
    if (stage.name==="move") check(stage.receipt.outcomes[0].errorCodes.includes("PROJECT_CHANGED"));
    if (stage.name==="rename") check(stage.receipt.outcomes[0].errorCodes.includes("ROW_IDENTITY_REVIEW"));
    native(stage.native,index+1,stage.receiptId,false);
  }
  check(new Set(ids).size===4 && new Set(value.stages.map((stage)=>stage.command.commandKey)).size===4);
  check(new Set(value.stages.map((stage)=>stage.native.sha256)).size===4);
  const parent=ids[3],review=value.review;
  check(keys(review,["receiptId","command","acknowledgement","receiptEvidence","operation","parentOrdinal","proposalValue"]) && id(review.receiptId) && !ids.includes(review.receiptId));
  check(keys(review.command,["previewReceiptId","rowOrdinals","commandKey"]) && review.command.previewReceiptId===parent && equal(review.command.rowOrdinals,[1]) && id(review.command.commandKey));
  ack(review.acknowledgement,review.receiptId,false,parent); response(review.receiptEvidence); check(review.operation==="UPDATE" && review.parentOrdinal===1 && review.proposalValue==="2027-03-02");
  native(value.native,4,parent,true);
  check(value.native.sha256!==value.stages[3].native.sha256);
  check(keys(value.canonical,["before","after"]) && sha(value.canonical.before) && value.canonical.before===value.canonical.after);
  check(Array.isArray(value.screenshots) && value.screenshots.length===4);
  check(equal(value.screenshots.map((item)=>item.file),comparisonScreenshots));
  value.screenshots.forEach((item)=>check(keys(item,["file","sha256"]) && sha(item.sha256)));
  const replay=value.afterRecreation;
  check(keys(replay,["preview","review","receiptId","nativeBefore","nativeAfter","canonicalUnchanged","proposalValue"]));
  ack(replay.preview,parent,true); ack(replay.review,review.receiptId,true,parent); check(replay.receiptId===review.receiptId && replay.canonicalUnchanged===true && replay.proposalValue==="2027-03-02");
  native(replay.nativeBefore,4,parent,true); native(replay.nativeAfter,4,parent,true); check(equal(replay.nativeBefore,replay.nativeAfter));
  native(value.storageBeforeBackup,4,parent,true);
  check(equal(replay.nativeBefore,value.storageBeforeBackup));
  const restored=value.restored;
  check(keys(restored,["method","native","apiCanConnect","workerCanConnect","applicationStarted"]));
  check(restored.method==="NATIVE_RETAINED_DATA_BEFORE_PROBES" && restored.apiCanConnect===false && restored.workerCanConnect===false && restored.applicationStarted===false);
  native(restored.native,4,parent,true); check(equal(restored.native,value.storageBeforeBackup));
  return true;
}
