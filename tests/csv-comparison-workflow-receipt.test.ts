// FR-CON-006/007/012: reject contradictory host evidence; no native success mocks.
import {expect,it} from "vitest";
import {createHash} from "node:crypto";
import {assertCsvComparisonWorkflowReceipt} from "../scripts/acceptance/csv-comparison-workflow-receipt.mjs";
import {comparisonFiles,comparisonScreenshots} from "../scripts/acceptance/csv-comparison-fixture.mjs";
const id=(n:number)=>"00000000-0000-4000-8000-"+n.toString().padStart(12,"0");
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function fixture() {
  const projectId="30000000-0000-4000-8000-000000000003",movedProjectId=id(90),sourceId=id(91);
  const expected={profile:"bundled",runId:"pdaa-acceptance-1794800000000-abcdefab",movedProjectId,originalSourceId:id(92)};
  const native=(revision:number,reviewed=false)=>({sha256:hash(revision+":"+reviewed),counts:{IngestionSource:1,IngestionConfigurationRevision:1,
    IngestionConfigurationProject:2,IngestionConfigurationReader:2,IngestionRetentionPolicy:1,IngestionExternalRecord:2,IngestionFactStream:2,
    IngestionSourceRevision:revision===4 ? 4 : 2,IngestionProposalProjection:revision===4 ? 4 : 2,IngestionProposalContent:revision===4 ? 4 : 2,
    IngestionOperationReceipt:revision+(reviewed ? 1 : 0),IngestionReceiptProjectScope:2*(revision+(reviewed ? 1 : 0)),IngestionCursorTransition:0,
    IngestionRowOutcome:2*revision+(reviewed ? 1 : 0),IngestionReviewedImport:reviewed ? 1 : 0,IngestionReviewedImportRow:reviewed ? 1 : 0,
    IngestionCsvHead:1,IngestionCsvContext:revision},headRevision:revision,headReceiptId:id(revision),allContextsValid:true,allReceiptsValid:true,allContentsValid:true,headValid:true,records:2});
  const response={status:200,bytes:500,sha256:"a".repeat(64)};
  const files=comparisonFiles(projectId,movedProjectId),names=["prior","rename","move","changed"] as const;
  const stages=names.map((name,index)=>{
    const operations=name==="prior" ? [["ACCEPTED","CREATE"],["ACCEPTED","CREATE"]] : name==="rename" ? [["REVIEW_REQUIRED","NONE"],["ACCEPTED","UNCHANGED"]]
      : name==="move" ? [["INVALID","NONE"],["ACCEPTED","UNCHANGED"]] : [["ACCEPTED","UPDATE"],["ACCEPTED","UNCHANGED"]];
    return {name,receiptId:id(index+1),csvSha256:hash(files[name]),command:{commandKey:id(index+20),configRevision:1,mappingRevision:1},
      acknowledgement:{receiptId:id(index+1),replayed:false,rowCount:2},receipt:{id:id(index+1),kind:"CSV_PREVIEW",outcomes:operations.map(([state,operation],ordinal)=>
        ({ordinal:ordinal+1,state,operation,errorCodes:ordinal===0 && name==="rename" ? ["ROW_IDENTITY_REVIEW"] : ordinal===0 && name==="move" ? ["PROJECT_CHANGED"] : [],
          proposalValue:state==="ACCEPTED" ? ordinal===1 ? "2027-04-15" : name==="changed" ? "2027-03-02" : "2027-03-01" : null}))},
      receiptEvidence:{...response},native:native(index+1)};
  });
  const review={receiptId:id(5),command:{previewReceiptId:id(4),rowOrdinals:[1],commandKey:id(25)},
    acknowledgement:{receiptId:id(5),replayed:false,rowCount:1,parentPreviewReceiptId:id(4)},receiptEvidence:{...response},operation:"UPDATE",parentOrdinal:1,proposalValue:"2027-03-02"};
  const value={schemaVersion:1,customerId:"10000000-0000-4000-8000-000000000002",projectId,movedProjectId,sourceId,profile:expected.profile,runId:expected.runId,stages,review,
    native:native(4,true),canonical:{before:"f".repeat(64),after:"f".repeat(64)},screenshots:comparisonScreenshots.map((file:string)=>({file,sha256:"b".repeat(64)})),
    afterRecreation:{preview:{receiptId:id(4),replayed:true,rowCount:2},review:{receiptId:id(5),replayed:true,rowCount:1,parentPreviewReceiptId:id(4)},receiptId:id(5),
      nativeBefore:native(4,true),nativeAfter:native(4,true),canonicalUnchanged:true,proposalValue:"2027-03-02"},storageBeforeBackup:native(4,true),
    restored:{method:"NATIVE_RETAINED_DATA_BEFORE_PROBES",native:native(4,true),apiCanConnect:false,workerCanConnect:false,applicationStarted:false}};
  return {value,expected};
}
it("accepts a structurally consistent complete comparison proof",()=>{
  const {value,expected}=fixture(); expect(assertCsvComparisonWorkflowReceipt(value,expected)).toBe(true);
});
const mutations:(readonly [string,(value:ReturnType<typeof fixture>["value"])=>void])[]=[
  ["wrong customer",value=>{value.customerId=id(99);}],
  ["unbound move project",value=>{value.movedProjectId=id(99);}],
  ["original source reused",value=>{value.sourceId=id(92);}],
  ["duplicate receipts",value=>{value.stages[1]!.receiptId=value.stages[0]!.receiptId;}],
  ["changed CSV bytes",value=>{value.stages[3]!.csvSha256="0".repeat(64);}],
  ["renamed row accepted",value=>{value.stages[1]!.receipt.outcomes[0]!.state="ACCEPTED";}],
  ["move reason omitted",value=>{value.stages[2]!.receipt.outcomes[0]!.errorCodes=[];}],
  ["update relabeled CREATE",value=>{value.stages[3]!.receipt.outcomes[0]!.operation="CREATE";}],
  ["changed forecast not retained",value=>{value.stages[3]!.receipt.outcomes[0]!.proposalValue="2027-03-01";}],
  ["saved forecast changed",value=>{value.review.proposalValue="2027-03-01";}],
  ["unbound parent",value=>{value.review.command.previewReceiptId=id(1);}],
  ["wrong selection",value=>{value.review.command.rowOrdinals=[2];}],
  ["missing context",value=>{value.native.counts.IngestionCsvContext=3;}],
  ["context not validated",value=>{value.native.allContextsValid=false;}],
  ["content not validated",value=>{value.native.allContentsValid=false;}],
  ["false immutable result",value=>{value.stages[1]!.native.sha256=value.stages[0]!.native.sha256;}],
  ["canonical mutation",value=>{value.canonical.after="0".repeat(64);}],
  ["snapshot changed on replay",value=>{value.afterRecreation.nativeAfter.sha256="0".repeat(64);}],
  ["recreation not tied to retained state",value=>{value.storageBeforeBackup.sha256="0".repeat(64);value.restored.native.sha256="0".repeat(64);}],
  ["new write claimed as replay",value=>{value.afterRecreation.preview.replayed=false;}],
  ["restore differs",value=>{value.restored.native.sha256="0".repeat(64);}],
  ["API CONNECT enabled",value=>{value.restored.apiCanConnect=true;}],
  ["worker CONNECT enabled",value=>{value.restored.workerCanConnect=true;}],
  ["restored app started",value=>{value.restored.applicationStarted=true;}],
  ["screenshot traversal",value=>{value.screenshots[0]!.file="../elsewhere.png";}],
];
it.each(mutations)("rejects %s",(_label,mutate)=>{
  const {value,expected}=fixture(); mutate(value); expect(()=>assertCsvComparisonWorkflowReceipt(value,expected)).toThrow("Invalid CSV comparison workflow proof");
});
