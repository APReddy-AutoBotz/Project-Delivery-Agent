// FR-CON-006/007/012: real browser/API/native comparison before saving proposals.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {expect} from "@playwright/test";
import {csvApi} from "./csv-import-workflow.mjs";
import {assertCsvFixture} from "./csv-import-native.mjs";
import {comparisonFiles,comparisonSheet,comparisonScreenshots} from "./csv-comparison-fixture.mjs";
import {inspectCsvComparison} from "./csv-comparison-native.mjs";
import {observeCsvPreviewCommand,readCsvPreviewCommand,restoreCsvPreviewCommand} from "./csv-import-preview-command.mjs";
import {closeCustomerBrowserSession} from "./customer-session.mjs";
const digest=(bytes)=>createHash("sha256").update(bytes).digest("hex");
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keys=(value,names)=>value && typeof value==="object" && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const waitResponse=(page,predicate)=>{const pending=page.waitForResponse(predicate);pending.catch(()=>{});return pending;};
async function drain(session) {
  await session.capture(session.page);
  session.disclosure.verify(["browser-response-headers","browser-response-bodies","browser-dom","browser-storage","csv-api-headers","csv-api-bodies"]);
}
function ack(body,replayed,parent) {
  assert(keys(body,parent ? ["receiptId","replayed","rowCount","parentPreviewReceiptId"] : ["receiptId","replayed","rowCount"]));
  assert.match(body.receiptId,uuid); assert.equal(body.replayed,replayed); assert.equal(body.rowCount,parent ? 1 : 2);
  if (parent) assert.equal(body.parentPreviewReceiptId,parent);
}
export async function exerciseCsvComparisonWorkflow({login,base,pool,binding,movedProjectId,canonicalSnapshot,output}) {
  assertCsvFixture(binding); assert.match(movedProjectId,uuid); assert.notEqual(movedProjectId,binding.projectId);
  const session=await login("pmo-atlas"),{page}=session;
  const fixture={schemaVersion:1,...binding,movedProjectId,stages:[],screenshots:[]};
  const files=comparisonFiles(binding.projectId,movedProjectId);
  const screenshot=async(file)=>{
    assert(comparisonScreenshots.includes(file)); await drain(session);
    await page.screenshot({path:join(output,file),fullPage:true});
    fixture.screenshots.push({file,sha256:digest(readFileSync(join(output,file)))});
  };
  try {
    page.setDefaultTimeout(15000);
    const before=await canonicalSnapshot(pool);
    await page.getByRole("button",{name:/Data imports/}).click();
    await expect(page.getByRole("heading",{name:"Review a CSV import",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"New mapping",exact:true}).click();
    await page.getByLabel("Sheet label",{exact:true}).fill(comparisonSheet);
    await page.getByLabel("Identity column",{exact:true}).fill("Issue ID");
    await page.getByLabel("Project ID column",{exact:true}).fill("Project ID");
    await page.getByLabel("CSV column",{exact:true}).fill("Forecast");
    await page.getByLabel("Proposal field",{exact:true}).fill("project.forecast");
    await page.getByLabel("Value type",{exact:true}).selectOption("date");
    await page.getByLabel("Required",{exact:true}).check();
    for (const id of [binding.projectId,movedProjectId]) {
      const rows=(await pool.query('SELECT name FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid',[binding.customerId,id])).rows;
      assert.equal(rows.length,1); await page.getByLabel(rows[0].name,{exact:false}).check();
    }
    const configured=waitResponse(page,(response)=>response.url()===base+"/api/ingestion/sources/configuration" && response.request().method()==="POST");
    await page.getByRole("button",{name:"Create mapping",exact:true}).click();
    const configurationResponse=await configured; assert.equal(configurationResponse.status(),201);
    const configuration=await configurationResponse.json(); assert.match(configuration.sourceId,uuid);
    assert.equal(configuration.configRevision,1); assert.equal(configuration.mappingRevision,1);
    fixture.sourceId=configuration.sourceId;
    const submitted=configurationResponse.request().postDataJSON();
    assert.deepEqual(submitted.projects.map((project)=>project.projectId).sort(),[binding.projectId,movedProjectId].sort());
    assert(submitted.projects.every((project)=>JSON.stringify(project.readers)===JSON.stringify(["pmo-atlas"])));
    await expect(page.getByRole("status").filter({hasText:"Mapping saved."})).toBeVisible();
    for (const name of ["prior","rename","move","changed"]) {
      const csv=files[name],url=base+`/api/ingestion/sources/${fixture.sourceId}/csv-previews`;
      await page.getByLabel("CSV file",{exact:true}).setInputFiles({name:"comparison.csv",mimeType:"text/csv",buffer:Buffer.from(csv)});
      await observeCsvPreviewCommand(page,{base,sourceId:fixture.sourceId});
      let command,body;
      try {
        const pending=waitResponse(page,(response)=>response.url()===url && response.request().method()==="POST");
        await page.getByRole("button",{name:"Upload and preview",exact:true}).click();
        const response=await pending; assert.equal(response.status(),201); body=await response.json(); ack(body,false);
        command=await readCsvPreviewCommand(page);
      } finally {await restoreCsvPreviewCommand(page);}
      await expect(page.getByRole("heading",{name:`Preview ${body.receiptId.slice(0,8)}`,exact:true})).toBeVisible();
      const read=await csvApi(session,base,`/ingestion/sources/${fixture.sourceId}/receipts/${body.receiptId}`,200);
      const expected=name==="prior" ? [["ACCEPTED","CREATE"],["ACCEPTED","CREATE"]] : name==="rename" ? [["REVIEW_REQUIRED","NONE"],["ACCEPTED","UNCHANGED"]]
        : name==="move" ? [["INVALID","NONE"],["ACCEPTED","UNCHANGED"]] : [["ACCEPTED","UPDATE"],["ACCEPTED","UNCHANGED"]];
      assert.deepEqual(read.body.outcomes.map((row)=>[row.state,row.operation]),expected);
      const rows=page.getByRole("row"); await expect(rows).toHaveCount(3);
      await expect(rows.nth(1)).toContainText(expected[0][0].replaceAll("_"," ")); await expect(rows.nth(1)).toContainText(expected[0][1]);
      await expect(rows.nth(2)).toContainText(expected[1][1]);
      read.body.outcomes.forEach((row,index)=>{
        if (row.state==="ACCEPTED") {
          const value=index===1 ? "2027-04-15" : name==="changed" ? "2027-03-02" : "2027-03-01";
          assert.deepEqual(row.proposals,[{factType:"project.forecast",value:{type:"date",value}}]);
          assert.equal(row.contentAvailable,true);
        } else {assert.equal(row.proposals,null);assert.equal(row.contentAvailable,false);}
      });
      await expect(rows.nth(2)).toContainText("2027-04-15");
      if (name==="prior" || name==="changed") await expect(rows.nth(1)).toContainText(name==="changed" ? "2027-03-02" : "2027-03-01");
      if (name==="rename" || name==="move") {
        await expect(page.getByRole("checkbox",{name:"Select row 1",exact:true})).toBeDisabled();
        await expect(page.getByRole("button",{name:"Save 0 reviewed proposals",exact:true})).toBeDisabled();
      }
      fixture.stages.push({name,receiptId:body.receiptId,csvSha256:digest(csv),command,acknowledgement:body,
        receipt:{id:read.body.receipt.id,kind:read.body.receipt.kind,outcomes:read.body.outcomes.map(({ordinal,state,operation,errorCodes,proposals})=>({ordinal,state,operation,errorCodes,proposalValue:proposals?.[0]?.value.value ?? null}))},
        receiptEvidence:read.evidence});
      fixture.stages.at(-1).native=await inspectCsvComparison(pool,fixture);
      if (name!=="prior") await screenshot("csv-comparison-"+name+".png");
    }
    const parent=fixture.stages.at(-1).receiptId;
    await page.getByRole("checkbox",{name:"Select row 1",exact:true}).check();
    await expect(page.getByRole("checkbox",{name:"Select row 2",exact:true})).not.toBeChecked();
    const reviewUrl=base+`/api/ingestion/sources/${fixture.sourceId}/reviewed-imports`;
    const pending=waitResponse(page,(response)=>response.url()===reviewUrl && response.request().method()==="POST");
    await page.getByRole("button",{name:"Save 1 reviewed proposal",exact:true}).click();
    const response=await pending; assert.equal(response.status(),201); const body=await response.json(); ack(body,false,parent);
    const command=response.request().postDataJSON(); assert.deepEqual(command.rowOrdinals,[1]); assert.equal(command.previewReceiptId,parent);
    await expect(page.getByText("Reviewed import receipt saved",{exact:true})).toBeVisible();
    const reviewed=await csvApi(session,base,`/ingestion/sources/${fixture.sourceId}/receipts/${body.receiptId}`,200);
    assert.equal(reviewed.body.outcomes.length,1); assert.equal(reviewed.body.outcomes[0].operation,"UPDATE"); assert.equal(reviewed.body.outcomes[0].parentOrdinal,1);
    assert.deepEqual(reviewed.body.outcomes[0].proposals,[{factType:"project.forecast",value:{type:"date",value:"2027-03-02"}}]);
    fixture.review={receiptId:body.receiptId,command,acknowledgement:body,receiptEvidence:reviewed.evidence,operation:"UPDATE",parentOrdinal:1,proposalValue:"2027-03-02"};
    fixture.native=await inspectCsvComparison(pool,fixture);
    await screenshot("csv-comparison-saved.png");
    const after=await canonicalSnapshot(pool); assert.deepEqual(after,before,"CSV comparison changed canonical/project rows");
    fixture.canonical={before:digest(JSON.stringify(before)),after:digest(JSON.stringify(after))};
    await drain(session);
    return fixture;
  } finally {await closeCustomerBrowserSession(session,base);}
}

export async function replayCsvComparisonAfterRecreation({login,base,pool,fixture,canonicalSnapshot}) {
  const session=await login("pmo-atlas");
  try {
    const canonicalBefore=await canonicalSnapshot(pool),before=await inspectCsvComparison(pool,fixture);
    const stage=fixture.stages.at(-1),csv=comparisonFiles(fixture.projectId,fixture.movedProjectId).changed;
    const preview=await csvApi(session,base,`/ingestion/sources/${fixture.sourceId}/csv-previews`,201,{method:"POST",multipart:{commandKey:stage.command.commandKey,configRevision:"1",mappingRevision:"1",file:{name:"comparison.csv",mimeType:"text/csv",buffer:Buffer.from(csv)}}});
    ack(preview.body,true); assert.equal(preview.body.receiptId,stage.receiptId);
    const review=await csvApi(session,base,`/ingestion/sources/${fixture.sourceId}/reviewed-imports`,201,{method:"POST",data:fixture.review.command});
    ack(review.body,true,stage.receiptId); assert.equal(review.body.receiptId,fixture.review.receiptId);
    const read=await csvApi(session,base,`/ingestion/sources/${fixture.sourceId}/receipts/${fixture.review.receiptId}`,200);
    assert.equal(read.body.outcomes[0].operation,"UPDATE");
    assert.deepEqual(read.body.outcomes[0].proposals,[{factType:"project.forecast",value:{type:"date",value:"2027-03-02"}}]);
    const after=await inspectCsvComparison(pool,fixture); assert.deepEqual(after,before);
    assert.deepEqual(await canonicalSnapshot(pool),canonicalBefore);
    await drain(session);
    return {preview:preview.body,review:review.body,receiptId:read.body.receipt.id,nativeBefore:before,nativeAfter:after,canonicalUnchanged:true,proposalValue:"2027-03-02"};
  } finally {await closeCustomerBrowserSession(session,base);}
}
export const snapshotCsvComparisonBeforeBackup=(pool,fixture)=>inspectCsvComparison(pool,fixture);
export async function verifyRestoredCsvComparison(pool,fixture) {
  const native=await inspectCsvComparison(pool,fixture); assert.deepEqual(native,fixture.storageBeforeBackup);
  const [{api,worker}]=(await pool.query("SELECT has_database_privilege('pdaa_api',current_database(),'CONNECT') AS api,has_database_privilege('pdaa_worker',current_database(),'CONNECT') AS worker")).rows;
  assert.equal(api,false); assert.equal(worker,false);
  return {method:"NATIVE_RETAINED_DATA_BEFORE_PROBES",native,apiCanConnect:false,workerCanConnect:false,applicationStarted:false};
}
