// FR-CON-006/007/012: independent native state and receipt checks for the journey.
import assert from "node:assert/strict";
import {csvStorageProjection,csvProjectionReceipt,csvDigest} from "./csv-import-native.mjs";
import {comparisonSheet} from "./csv-comparison-fixture.mjs";
const expected={prior:[["ACCEPTED","CREATE"],["ACCEPTED","CREATE"]],rename:[["REVIEW_REQUIRED","NONE"],["ACCEPTED","UNCHANGED"]],
  move:[["INVALID","NONE"],["ACCEPTED","UNCHANGED"]],changed:[["ACCEPTED","UPDATE"],["ACCEPTED","UNCHANGED"]]};
export async function inspectCsvComparison(pool,fixture) {
  const projection=await csvStorageProjection(pool,fixture);
  assert.equal(projection.IngestionSource.length,1); assert.equal(projection.IngestionConfigurationRevision.length,1);
  assert.deepEqual(projection.IngestionConfigurationProject.map((row)=>row.projectId).sort(),[fixture.projectId,fixture.movedProjectId].sort());
  assert.equal(projection.IngestionExternalRecord.length,2);
  assert.deepEqual(projection.IngestionExternalRecord.map((row)=>row.recordKey).sort(),["COMPARE-A","COMPARE-B"].map((key)=>csvDigest([comparisonSheet,key])).sort());
  assert(projection.IngestionExternalRecord.every((row)=>row.projectId===fixture.projectId && row.recordType==="spreadsheet:"+comparisonSheet));
  assert.equal(projection.IngestionCsvHead.length,1);
  const head=projection.IngestionCsvHead[0];
  assert.equal(head.readiness,"READY"); assert.equal(head.revision,fixture.stages.length);
  assert.equal(head.currentReceiptId,fixture.stages.at(-1).receiptId);
  assert.equal(projection.IngestionCsvContext.length,fixture.stages.length);
  const contexts=[...projection.IngestionCsvContext].sort((a,b)=>a.revision-b.revision);
  assert.deepEqual(contexts.map((row)=>row.revision),fixture.stages.map((_row,index)=>index+1));
  for (const [index,stage] of fixture.stages.entries()) {
    const receipt=projection.IngestionOperationReceipt.find((row)=>row.id===stage.receiptId);
    assert(receipt); assert.equal(receipt.kind,"CSV_PREVIEW"); assert.equal(receipt.commandKey,stage.command.commandKey);
    assert.equal(receipt.requestHash,csvDigest({csvHash:stage.csvSha256,configRevision:1,mappingRevision:1,baseline:null}));
    const rows=projection.IngestionRowOutcome.filter((row)=>row.receiptId===receipt.id).sort((a,b)=>a.ordinal-b.ordinal);
    assert.deepEqual(rows.map((row)=>[row.state,row.operation]),expected[stage.name]);
    rows.forEach((row,index)=>{
      if (row.state!=="ACCEPTED") {assert.equal(row.projectionId,null);return;}
      const content=projection.IngestionProposalContent.find((entry)=>entry.projectionId===row.projectionId);
      assert(content);
      assert.deepEqual(content.proposals,[{factType:"project.forecast",value:{type:"date",value:index===1 ? "2027-04-15" : stage.name==="changed" ? "2027-03-02" : "2027-03-01"}}]);
    });
    if (stage.name==="move") assert(rows[0].errorCodes.includes("PROJECT_CHANGED"));
    if (stage.name==="rename") assert(rows[0].errorCodes.includes("ROW_IDENTITY_REVIEW"));
    assert.equal(contexts[index].receiptId,receipt.id); assert.equal(contexts[index].rows.length,2);
    assert.equal(contexts[index].predecessorReceiptId,index===0 ? null : fixture.stages[index-1].receiptId);
  }
  const reviewed=fixture.review !== undefined;
  assert.equal(projection.IngestionOperationReceipt.length,fixture.stages.length+(reviewed ? 1 : 0));
  assert.equal(projection.IngestionReviewedImport.length,reviewed ? 1 : 0);
  if (reviewed) {
    const receipt=projection.IngestionOperationReceipt.find((row)=>row.id===fixture.review.receiptId);
    assert(receipt); assert.equal(receipt.kind,"CSV_REVIEWED_IMPORT"); assert.equal(receipt.commandKey,fixture.review.command.commandKey);
    assert.equal(receipt.requestHash,csvDigest({sourceId:fixture.sourceId,previewReceiptId:fixture.stages.at(-1).receiptId,
      rowOrdinals:[1],configRevision:1,mappingRevision:1}));
    const links=projection.IngestionReviewedImportRow;
    assert.equal(links.length,1); assert.equal(links[0].receiptId,fixture.review.receiptId);
    assert.equal(links[0].previewReceiptId,fixture.stages.at(-1).receiptId); assert.equal(links[0].previewOrdinal,1);
    const row=projection.IngestionRowOutcome.find((row)=>row.receiptId===fixture.review.receiptId);
    assert.equal(row.operation,"UPDATE"); assert.equal(row.state,"ACCEPTED");
    assert.deepEqual(projection.IngestionProposalContent.find((entry)=>entry.projectionId===row.projectionId).proposals,
      [{factType:"project.forecast",value:{type:"date",value:"2027-03-02"}}]);
  }
  const contextsValid=(await pool.query('SELECT "receiptId",public.valid_ingestion_csv_context("receiptId") AS valid FROM public."IngestionCsvContext" WHERE "customerId"=$1::uuid AND "sourceId"=$2::uuid ORDER BY revision',[fixture.customerId,fixture.sourceId])).rows;
  assert.deepEqual(contextsValid,fixture.stages.map((stage)=>({receiptId:stage.receiptId,valid:true})));
  const [{valid}]=(await pool.query('SELECT public.valid_ingestion_csv_head($1::uuid,$2::uuid) AS valid',[fixture.customerId,fixture.sourceId])).rows;
  assert.equal(valid,true);
  const receiptsValid=(await pool.query('SELECT id,public.valid_ingestion_receipt(id) AS valid FROM public."IngestionOperationReceipt" WHERE "customerId"=$1::uuid AND "sourceId"=$2::uuid ORDER BY id',[fixture.customerId,fixture.sourceId])).rows;
  assert.deepEqual(receiptsValid,projection.IngestionOperationReceipt.map(({id})=>({id,valid:true})).sort((a,b)=>a.id.localeCompare(b.id)));
  const contentsValid=(await pool.query('SELECT "projectionId",public.valid_ingestion_projection_content("projectionId",proposals) AS valid FROM public."IngestionProposalContent" WHERE "customerId"=$1::uuid AND "sourceId"=$2::uuid ORDER BY "projectionId"',[fixture.customerId,fixture.sourceId])).rows;
  assert.deepEqual(contentsValid,projection.IngestionProposalContent.map(({projectionId})=>({projectionId,valid:true})).sort((a,b)=>a.projectionId.localeCompare(b.projectionId)));
  const serialized=JSON.stringify(projection);
  for (const raw of ["COMPARE-A","COMPARE-B","COMPARE-RENAMED","comparison-private-","comparison.csv"]) assert(!serialized.includes(raw),"Input-only CSV data was retained");
  return {...csvProjectionReceipt(projection),headRevision:head.revision,headReceiptId:head.currentReceiptId,
    allContextsValid:true,allReceiptsValid:true,allContentsValid:true,headValid:true,records:2};
}
