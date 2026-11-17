// FR-CON-006/007/012 / NFR-REL-001: genuine populated released-27 upgrade.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {csvDigest} from "./csv-import-native.mjs";

const tables = ["IngestionSource","IngestionConfigurationRevision","IngestionConfigurationProject","IngestionConfigurationReader",
  "IngestionExternalRecord","IngestionFactStream","IngestionSourceRevision","IngestionProposalProjection","IngestionProposalContent",
  "IngestionOperationReceipt","IngestionReceiptProjectScope","IngestionRowOutcome"];
const mapping = {kind:"CSV",sheet:"Projects",identityColumn:"Key",projectColumn:"Project",
  fields:[{column:"Forecast",factType:"project.forecast",type:"date",required:true}]};
async function snapshot(db,customerId,sourceIds) {
  const result = {};
  for (const table of tables) {
    const sourcePredicate = table === "IngestionSource" ? 'id' : '"sourceId"';
    result[table] = await db.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM public."${table}" t
      WHERE "customerId"=$1::uuid AND ${sourcePredicate}=ANY($2::uuid[]) ORDER BY to_jsonb(t)::text COLLATE "C"`,customerId,sourceIds);
  }
  return result;
}

// No head-dependent writer is used to seed old history. These are real API-role
// SQL graphs checked by the released-27 native guards and deferred validators.
async function releasedPreview(db,actor,sourceId,projectId,valid) {
  const commandKey=randomUUID(),receiptId=randomUUID(),auditEventId=randomUUID();
  const csv=`Key,Project,Forecast\nRELEASED-27,${projectId},${valid ? "2027-01-01" : "not-a-date"}\n`;
  const requestHash=csvDigest({csvHash:csvDigestBytes(csv),configRevision:1,mappingRevision:1,baseline:null});
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    const [principal]=await tx.$queryRaw`SELECT current_user::text AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`;
    assert.deepEqual(principal,{role:"pdaa_api",superuser:false});
    await tx.$queryRaw`SELECT id FROM public."Project" WHERE "customerId"=${actor.customerId}::uuid AND id=${projectId}::uuid FOR UPDATE`;
    const [grant]=await tx.$queryRaw`SELECT id,"scopeType","scopeId",role FROM public."AccessGrant"
      WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject} AND role='pmo_admin'
        AND (("scopeType"='project' AND "scopeId"=${projectId}::uuid) OR ("scopeType"='portfolio'
          AND "scopeId"=(SELECT "portfolioId" FROM public."Project" WHERE id=${projectId}::uuid))) ORDER BY id FOR SHARE`;
    assert(grant);
    await tx.$queryRaw`SELECT id FROM public."IngestionSource" WHERE "customerId"=${actor.customerId}::uuid AND id=${sourceId}::uuid FOR UPDATE`;
    let recordId=null,sourceRevisionId=null,projectionId=null;
    const recordKey=csvDigest(["Projects","RELEASED-27"]);
    if (valid) {
      recordId=randomUUID(); sourceRevisionId=randomUUID(); projectionId=randomUUID();
      const sourceHash=csvDigest([["Forecast","2027-01-01"],["Key","RELEASED-27"],["Project",projectId]]);
      const proposals=JSON.stringify([{factType:"project.forecast",value:{type:"date",value:"2027-01-01"}}]);
      await tx.$executeRaw`INSERT INTO public."IngestionExternalRecord" (id,"customerId","sourceId","projectId","recordType","recordKey")
        VALUES (${recordId}::uuid,${actor.customerId}::uuid,${sourceId}::uuid,${projectId}::uuid,'spreadsheet:Projects',${recordKey})`;
      await tx.$executeRaw`INSERT INTO public."IngestionFactStream" (id,"customerId","sourceId","recordId","factType")
        VALUES (${randomUUID()}::uuid,${actor.customerId}::uuid,${sourceId}::uuid,${recordId}::uuid,'project.forecast')`;
      await tx.$executeRaw`INSERT INTO public."IngestionSourceRevision" (id,"customerId","sourceId","recordId",revision,"sourceContentHash")
        VALUES (${sourceRevisionId}::uuid,${actor.customerId}::uuid,${sourceId}::uuid,${recordId}::uuid,${"sha256:"+sourceHash},${sourceHash})`;
      await tx.$executeRaw`INSERT INTO public."IngestionProposalProjection" (id,"customerId","sourceId","recordId","sourceRevisionId","mappingRevision","proposalHash","factTypes")
        VALUES (${projectionId}::uuid,${actor.customerId}::uuid,${sourceId}::uuid,${recordId}::uuid,${sourceRevisionId}::uuid,1,
          encode(sha256(convert_to((${proposals}::jsonb)::text,'UTF8')),'hex'),ARRAY['project.forecast']::text[])`;
      await tx.$executeRaw`INSERT INTO public."IngestionProposalContent" ("customerId","sourceId","recordId","projectionId",proposals,"policyRevision")
        SELECT ${actor.customerId}::uuid,${sourceId}::uuid,${recordId}::uuid,${projectionId}::uuid,${proposals}::jsonb,revision
        FROM public."IngestionRetentionPolicy" WHERE "customerId"=${actor.customerId}::uuid`;
    }
    const createdAt=new Date();
    await tx.auditEvent.create({data:{id:auditEventId,customerId:actor.customerId,actor:actor.subject,
      event:"ingestion.csv_preview.persisted",correlationId:randomUUID(),occurredAt:createdAt,
      detail:{receiptId,kind:"CSV_PREVIEW",sourceId,configRevision:1,mappingRevision:1,scopeProjectIds:[projectId],requestHash,outcomeCount:1}}});
    await tx.$executeRaw`INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","configRevision","mappingRevision","outcomeCount","auditEventId","createdAt")
      VALUES (${receiptId}::uuid,${actor.customerId}::uuid,${sourceId}::uuid,${actor.subject},'CSV_PREVIEW',${commandKey},${requestHash},1,1,1,${auditEventId}::uuid,${createdAt})`;
    await tx.$executeRaw`INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
      VALUES (${actor.customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,${projectId}::uuid,${grant.id}::uuid,${grant.role},${grant.scopeType},${grant.scopeId}::uuid)`;
    await tx.$executeRaw`INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes","projectId","recordKey","recordId","sourceRevisionId","projectionId")
      VALUES (${actor.customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,1,${valid ? "ACCEPTED" : "INVALID"},${valid ? "CREATE" : "NONE"},
        ${valid ? [] : ["INVALID_FIELDS","INVALID_VALUE"]}::text[],${projectId}::uuid,${recordKey},${recordId}::uuid,${sourceRevisionId}::uuid,${projectionId}::uuid)`;
  },{timeout:20000});
  assert.deepEqual(await db.$queryRaw`SELECT public.valid_ingestion_receipt(${receiptId}::uuid) AS valid`,[{valid:true}]);
  return {receiptId,input:{sourceId,configRevision:1,mappingRevision:1,commandKey,fileName:"released27.csv",csv}};
}
import {createHash} from "node:crypto";
const csvDigestBytes=(text)=>createHash("sha256").update(text).digest("hex");

export async function prepareCsvComparisonUpgrade(db,repository,actor,projectId) {
  assert.equal(process.env.DATA_MODE,"synthetic"); assert.notEqual(process.env.NODE_ENV,"production");
  const [target]=await db.$queryRaw`SELECT current_database() AS name,to_regclass('public."IngestionCsvHead"')::text AS head`;
  assert.match(target.name,/^pdaa_upgrade24_[0-9]+$/); assert.equal(target.head,null);
  const ledger=await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
  assert.equal(ledger.length,27); assert.equal(ledger[26].migration_name,"202611150001_ingestion_retention_audit");
  const cases=[];
  for (const kind of ["empty","accepted","invalid-only","current-connector"]) {
    const sourceId=randomUUID();
    const configuration={binding:{customerId:actor.customerId,sourceId,sourceType:"spreadsheet",origin:"https://released-csv.example"},
      projects:[{projectId,readers:[actor.subject]}],mapping};
    await repository.configure(actor,configuration,randomUUID());
    const preview=kind === "empty" ? null : await releasedPreview(db,actor,sourceId,projectId,kind !== "invalid-only");
    if (kind === "current-connector") await repository.configure(actor,{...configuration,mapping:{kind:"CONNECTOR",factTypes:["project.forecast"]}},randomUUID());
    cases.push({kind,sourceId,configuration,preview});
  }
  assert.equal(await db.ingestionExternalRecord.count({where:{sourceId:cases.find((entry)=>entry.kind === "invalid-only").sourceId}}),0);
  const sourceIds=cases.map((entry)=>entry.sourceId);
  return {cases,ledger,before:await snapshot(db,actor.customerId,sourceIds)};
}

export async function verifyCsvComparisonUpgrade(db,repository,actor,projectId,prepared) {
  const {cases,ledger,before}=prepared;
  const afterLedger=await db.$queryRaw`SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name`;
  assert.equal(afterLedger.length,28); assert.deepEqual(afterLedger.slice(0,27),ledger);
  assert.deepEqual(await snapshot(db,actor.customerId,cases.map((entry)=>entry.sourceId)),before);
  const readiness={};
  for (const entry of cases) {
    const head=await db.ingestionCsvHead.findUnique({where:{customerId_sourceId:{customerId:actor.customerId,sourceId:entry.sourceId}}});
    if (entry.kind === "current-connector") assert.equal(head,null);
    else { assert(head); assert.equal(head.readiness,entry.kind === "empty" ? "READY" : "LEGACY_UNAVAILABLE"); assert.equal(head.revision,0n); }
    readiness[entry.kind]=head?.readiness ?? "NO_HEAD";
    if (entry.preview) {
      const read=await repository.readReceipt(actor,{sourceId:entry.sourceId,receiptId:entry.preview.receiptId});
      assert.equal(read.receipt.id,entry.preview.receiptId);
      assert.deepEqual(await repository.persistCsvPreview(actor,entry.preview.input,randomUUID()),{receiptId:entry.preview.receiptId,replayed:true,rowCount:1});
    }
    if (entry.kind === "current-connector") {
      await repository.configure(actor,entry.configuration,randomUUID());
      assert.equal((await db.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:actor.customerId,sourceId:entry.sourceId}}})).readiness,"LEGACY_UNAVAILABLE");
      assert.deepEqual(await db.$queryRaw`SELECT public.valid_ingestion_receipt(${entry.preview.receiptId}::uuid) AS valid`,[{valid:true}]);
      assert.equal((await repository.readReceipt(actor,{sourceId:entry.sourceId,receiptId:entry.preview.receiptId})).receipt.id,entry.preview.receiptId);
      assert.deepEqual(await repository.persistCsvPreview(actor,entry.preview.input,randomUUID()),{receiptId:entry.preview.receiptId,replayed:true,rowCount:1});
    }
    const source=await db.ingestionSource.findUniqueOrThrow({where:{id:entry.sourceId}});
    const input={sourceId:entry.sourceId,configRevision:source.currentConfigRevision,mappingRevision:source.mappingRevision,
      commandKey:randomUUID(),fileName:"new.csv",csv:`Key,Project,Forecast\nRELEASED-27,${projectId},2027-01-01\n`};
    if (entry.kind === "empty") {
      const preview=await repository.persistCsvPreview(actor,input,randomUUID());
      const result=await repository.readReceipt(actor,{sourceId:entry.sourceId,receiptId:preview.receiptId});
      assert.equal(result.outcomes[0].operation,"CREATE");
    } else {
      const before=await db.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:actor.customerId,sourceId:entry.sourceId}}});
      await assert.rejects(repository.persistCsvPreview(actor,input,randomUUID()),(error)=>error?.code === "INVALID_PREVIEW");
      assert.deepEqual(await db.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:actor.customerId,sourceId:entry.sourceId}}}),before);
      assert.equal(await db.ingestionCsvContext.count({where:{sourceId:entry.sourceId}}),0);
    }
  }
  return {priorMigrationCount:27,migrationCount:28,retainedPriorChecksums:27,readiness,
    releasedApiRoleGraphs:true,invalidOnlyHasNoRecords:true,historicalReadsAndExactReplay:true,
    lateActivationLegacy:true,emptySourceFirstContext:true,noChronologicalBackfill:true};
}
