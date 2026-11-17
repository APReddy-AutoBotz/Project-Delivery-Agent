// FR-CON-006/007/012 / NFR-SEC-001: applied SQL and restricted-role transitions.
import {afterAll,expect,it,vi} from "vitest";
import {createHash,randomUUID} from "node:crypto";
import {createDatabase,DatabaseIngestionRepository} from "../packages/data/src/index.js";
import {CredentialVault} from "../packages/platform/dist/index.js";
import type {Prisma} from "../packages/data/src/generated/prisma/client.js";
import type {Actor,IngestionConfiguration} from "../packages/domain/src/index.js";
import {serializeCsvComparisonState} from "../packages/domain/src/index.js";
import {assertCsvPrototypeTarget} from "../scripts/acceptance/csv-comparison-prototype.mjs";
import {verifyRequiredCsvHeads} from "../scripts/acceptance/restored-proof-integrity.mjs";

const url=process.env.PDAA_DATABASE_URL;
assertCsvPrototypeTarget(url);
const owner=createDatabase(url!);
afterAll(()=>owner.$disconnect());
type Tx=Prisma.TransactionClient;
type Options={isolationLevel?:"ReadCommitted";maxWait?:number;timeout?:number};
const vault=new CredentialVault(Buffer.alloc(32,71).toString("base64"));
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const errorCode=(error:unknown)=>(error as {meta?:{driverAdapterError?:{cause?:{originalCode?:string}}}})?.meta?.driverAdapterError?.cause?.originalCode;
type Row=readonly [string,string?,string?,string?,string?];
type Field=Extract<IngestionConfiguration["mapping"],{kind:"CSV"}>["fields"][number];

const own=(value:unknown,key:string):unknown=>value!==null && typeof value==="object" ? Object.getOwnPropertyDescriptor(value,key)?.value : undefined;
function nativeCodes(error:unknown) {
  const code=own(error,"code"),cause=own(own(own(error,"meta"),"driverAdapterError"),"cause"),sqlstate=own(cause,"originalCode");
  return {
    prismaCode:typeof code==="string" && ["P2010","P2028","P2024","P2034","P1001","P1002","P1008","P1017"].includes(code) ? code : "OTHER",
    sqlstate:own(cause,"kind")==="postgres" && typeof sqlstate==="string" &&
      ["57014","55P03","23503","23505","23514","P0001","PDC01","PDC02","PDC03","42501","22P02","53100","54000","40P01","40001","22023"].includes(sqlstate) ? sqlstate : "OTHER",
  };
}
function nativeQueryFamily(args:unknown[]) {
  const sql=typeof args[0]==="string" ? args[0] : Array.isArray(args[0]) ? args[0].join("?") : "";
  for (const [family,fragment] of [
    ["FACT_STREAM_INSERT",'INSERT INTO public."IngestionFactStream"'],["RECORD_INSERT",'INSERT INTO public."IngestionExternalRecord"'],
    ["REVISION_INSERT",'INSERT INTO public."IngestionSourceRevision"'],["PROJECTION_INSERT",'INSERT INTO public."IngestionProposalProjection"'],
    ["CONTENT_INSERT",'INSERT INTO public."IngestionProposalContent"'],["RECEIPT_INSERT",'INSERT INTO public."IngestionOperationReceipt"'],
    ["OUTCOME_INSERT",'INSERT INTO public."IngestionRowOutcome"'],["CONTEXT_INSERT",'INSERT INTO public."IngestionCsvContext"'],
    ["HEAD_UPDATE",'UPDATE public."IngestionCsvHead"'],["CONTEXT_VALIDATION","public.valid_ingestion_csv_context("],
    ["CONTENT_READ",'FROM public."IngestionProposalContent"'],
  ] as const) if (sql.includes(fragment)) return family;
  return "OTHER";
}

async function fixture(projectCount=1,fields?:Field[],sheet="Projects",diagnostic:"WIDE"|"SPARSE"|null=null) {
  const customerId=randomUUID(),portfolioId=randomUUID(),sourceId=randomUUID(),subject="csv-state-"+randomUUID();
  const actor:Actor={customerId,subject,roles:["pmo_admin"]};
  await owner.customer.create({data:{id:customerId,name:"Synthetic comparison fixture"}});
  await owner.portfolio.create({data:{id:portfolioId,customerId,name:"Synthetic comparison fixture"}});
  const projects=Array.from({length:projectCount},()=>randomUUID()).sort();
  await owner.project.createMany({data:projects.map((id)=>({id,customerId,portfolioId,code:"CSV-"+id,name:"CSV state fixture",description:"Synthetic only",reportedStatus:"UNKNOWN"}))});
  await owner.accessGrant.createMany({data:[{customerId,subject,scopeType:"portfolio",scopeId:portfolioId,role:"pmo_admin"},
    {customerId,subject:subject+"-system",scopeType:"portfolio",scopeId:portfolioId,role:"system_admin"}]});
  const asApi=async<T>(operation:(tx:Tx)=>Promise<T>,options?:Options)=>{
    const started=Date.now();let completed=false,queryFailed=false,ordinal=0;
    let last={method:"NONE",family:"NONE",elapsedMs:0};
    try {return await owner.$transaction(async(tx)=>{
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    const [principal]=await tx.$queryRaw<{role:string;superuser:boolean;migrationMember:boolean}[]>`SELECT current_user::text AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,pg_has_role(current_user,'pdaa_migrate','MEMBER') AS "migrationMember"`;
    expect(principal).toEqual({role:"pdaa_api",superuser:false,migrationMember:false});
    const observed=diagnostic===null ? tx : new Proxy(tx,{get(target,property){
      const value=Reflect.get(target,property,target);
      if (["$executeRaw","$queryRaw","$executeRawUnsafe","$queryRawUnsafe"].includes(String(property))) return async(...args:unknown[])=>{
        ordinal++;const at=Date.now();last={method:String(property),family:nativeQueryFamily(args),elapsedMs:0};
        try {return await Reflect.apply(value,target,args);} catch(error) {queryFailed=true;throw error;}
        finally {last.elapsedMs=Math.min(600000,Math.max(0,Date.now()-at));}
      };
      return typeof value==="function" ? value.bind(target) : value;
    }});
    const result=await operation(observed);completed=true;return result;
  },options);} catch(error) {
      // Test-only, before repository redaction. Emit finite labels/codes/timing;
      // never retain raw errors, messages, metadata, SQL, values or parameters.
      if (diagnostic!==null) try {console.error("CSV_NATIVE_DIAGNOSTIC",JSON.stringify({fixture:diagnostic,
        boundary:queryFailed ? "QUERY" : completed ? "COMMIT" : "TRANSACTION",ordinal,...last,
        transactionElapsedMs:Math.min(600000,Math.max(0,Date.now()-started)),...nativeCodes(error)}));} catch { /* Preserve the original failure unchanged. */ }
      throw error;
    }
  };
  const apiClient={$queryRaw:(sql:TemplateStringsArray,...values:unknown[])=>asApi((tx)=>tx.$queryRaw(sql,...values)),
    $transaction:asApi,auditEvent:{create:(input:Prisma.AuditEventCreateArgs)=>asApi((tx)=>tx.auditEvent.create(input))}};
  const api=new DatabaseIngestionRepository(apiClient as never,vault);
  await api.setRetention({...actor,subject:subject+"-system",roles:["system_admin"]},{retentionHours:24},randomUUID());
  const configuration:IngestionConfiguration={binding:{customerId,sourceId,sourceType:"spreadsheet",origin:"https://state.example"},
    projects:projects.map((projectId)=>({projectId,readers:[subject]})),mapping:{kind:"CSV",sheet,identityColumn:"Key",projectColumn:"Project",
      fields:fields ?? [{column:"Forecast",factType:"project.forecast",type:"date",required:false},{column:"Status",factType:"project.status",type:"text",required:false}]}};
  let revisions=await api.configure(actor,configuration,randomUUID());
  const input=(rows:readonly Row[],commandKey:string=randomUUID())=>({...revisions,commandKey,fileName:"input.csv",
    csv:"Key,Project,Forecast,Status,Note\n"+rows.map(([key,forecast="",status="",projectId=projects[0]!,note=""])=>[key,projectId,forecast,status,note].join(",")).join("\n")});
  const preview=async(rows:readonly Row[],commandKey?:string)=>{
    const command=input(rows,commandKey);
    const result=await api.persistCsvPreview(actor,command,randomUUID());
    const read=await api.readReceipt(actor,{sourceId,receiptId:result.receiptId});
    return {command,result,read};
  };
  const configure=async(next:IngestionConfiguration)=>{revisions=await api.configure(actor,next,randomUUID());return revisions;};
  const graph=async()=>{
    const result:Record<string,unknown>={};
    for (const table of ["IngestionSource","IngestionConfigurationRevision","IngestionConfigurationProject","IngestionConfigurationReader","IngestionFactStream",
      "IngestionCsvHead","IngestionCsvContext","IngestionExternalRecord","IngestionSourceRevision","IngestionProposalProjection","IngestionProposalContent",
      "IngestionOperationReceipt","IngestionRowOutcome","IngestionReceiptProjectScope","IngestionReviewedImport","IngestionReviewedImportRow"]) {
      const sourceColumn=table==="IngestionSource" ? "id" : '"sourceId"';
      result[table]=await owner.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM public."${table}" t WHERE "customerId"=$1::uuid AND ${sourceColumn}=$2::uuid ORDER BY to_jsonb(t)::text COLLATE "C"`,customerId,sourceId);
    }
    result.retention=await owner.ingestionRetentionPolicy.findUniqueOrThrow({where:{customerId}});
    result.audits=await owner.auditEvent.findMany({where:{customerId,event:{not:"ingestion.operation.denied"}},orderBy:{id:"asc"}});
    return result;
  };
  return {customerId,sourceId,projects,actor,api,apiClient,asApi,configuration,configure,input,preview,graph,stopDiagnostics:()=>{diagnostic=null;}};
}

it("stores accepted NONE identities and carries omitted optional references without refreshing their clocks",async()=>{
  const f=await fixture();
  const first=await f.preview([["A","2027-01-01","start"],["B"]]);
  expect(first.read.outcomes.map((row)=>row.operation)).toEqual(["CREATE","NONE"]);
  const before=await owner.ingestionCsvContext.findUniqueOrThrow({where:{receiptId:first.result.receiptId}});
  const rows=before.rows as [string,string,string,[string,string][]][];
  expect(rows.map((row)=>row[3].length).sort()).toEqual([0,2]);
  const keyA=hash(JSON.stringify(["Projects","A"]));
  const dateRef=rows.find((row)=>row[0]===keyA)![3].find(([index])=>index==="0")![1];
  const originalContent=await owner.ingestionProposalContent.findUniqueOrThrow({where:{projectionId:dateRef}});
  const second=await f.preview([["A","","next"],["B"]]);
  expect(second.read.outcomes.map((row)=>row.operation)).toEqual(["UPDATE","UNCHANGED"]);
  const context=await owner.ingestionCsvContext.findUniqueOrThrow({where:{receiptId:second.result.receiptId}});
  expect((context.rows as typeof rows).find((row)=>row[0]===keyA)![3].find(([index])=>index==="0")![1]).toBe(dateRef);
  expect(await owner.ingestionProposalContent.findUniqueOrThrow({where:{projectionId:dateRef}})).toEqual(originalContent);
  const third=await f.preview([["A","2027-01-01","next",undefined,"unmapped changed"],["B"]]);
  expect(third.read.outcomes.map((row)=>row.operation)).toEqual(["UNCHANGED","UNCHANGED"]);
  expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(3);
  expect(await owner.projectFactVersion.count({where:{customerId:f.customerId}})).toBe(0);
});

it("hashes a raw 64-hex key once and requires conservative rename/move/duplicate review",async()=>{
  const f=await fixture(2),raw="a".repeat(64);
  const first=await f.preview([[raw,"2027-01-01","start"]]);
  expect(first.read.outcomes[0]!.identity?.[1]).toBe(hash(JSON.stringify(["Projects",raw])));
  expect(first.read.outcomes[0]!.identity?.[1]).not.toBe(raw);
  const renamed=await f.preview([["renamed","2027-01-02","next"]]);
  expect(renamed.read.outcomes[0]).toMatchObject({state:"REVIEW_REQUIRED",operation:"NONE"});
  const moved=await f.preview([[raw,"2027-01-02","next",f.projects[1]]]);
  expect(moved.read.outcomes[0]).toMatchObject({state:"INVALID",operation:"NONE"});
  expect(moved.read.outcomes[0]!.errorCodes).toContain("PROJECT_CHANGED");
  const duplicate=await f.preview([[raw,"2027-01-02","next"],[raw,"2027-01-03","later"]]);
  expect(duplicate.read.outcomes.every((row)=>row.state==="INVALID" && row.errorCodes.includes("DUPLICATE_KEY"))).toBe(true);
  expect(await owner.ingestionExternalRecord.count({where:{sourceId:f.sourceId}})).toBe(1);
});

it("compares all four native value types and preserves values through optional omissions and invalid numeric input",async()=>{
  const fields:Field[]=[{column:"Forecast",factType:"project.forecast",type:"date",required:false},
    {column:"Status",factType:"project.status",type:"text",required:false},{column:"Metric",factType:"project.metric",type:"number",required:false},
    {column:"Flag",factType:"project.flag",type:"boolean",required:false}];
  const f=await fixture(1,fields),base=f.input([]);
  const command=(date:string,status:string,metric:string,flag:string)=>({...base,commandKey:randomUUID(),
    csv:`Key,Project,Forecast,Status,Metric,Flag\nA,${f.projects[0]},${date},${status},${metric},${flag}\n`});
  const first=await f.api.persistCsvPreview(f.actor,command("2027-01-01","start","1.25","true"),randomUUID());
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:first.receiptId})).outcomes[0]!.operation).toBe("CREATE");
  const second=await f.api.persistCsvPreview(f.actor,command("2027-01-01","start","1.25","false"),randomUUID());
  const read=await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:second.receiptId});
  expect(read.outcomes[0]!.operation).toBe("UPDATE");
  expect(read.outcomes[0]!.proposals).toEqual([
    {factType:"project.flag",value:{type:"boolean",value:false}},
    {factType:"project.forecast",value:{type:"date",value:"2027-01-01"}},
    {factType:"project.metric",value:{type:"number",value:1.25}},
    {factType:"project.status",value:{type:"text",value:"start"}},
  ]);
  const omitted=await f.api.persistCsvPreview(f.actor,command("","","1.25","false"),randomUUID());
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:omitted.receiptId})).outcomes[0]!.operation).toBe("UNCHANGED");
  const invalid=await f.api.persistCsvPreview(f.actor,command("2027-01-01","start","1.250","false"),randomUUID());
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:invalid.receiptId})).outcomes[0]).toMatchObject({state:"INVALID",operation:"NONE"});
  const after=await f.api.persistCsvPreview(f.actor,command("2027-01-01","start","1.25","false"),randomUUID());
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:after.receiptId})).outcomes[0]!.operation).toBe("UNCHANGED");
});

it("round-trips a maximum sheet identity through CREATE, UPDATE, reviewed import and exact retry",async()=>{
  const sheet="S".repeat(256),f=await fixture(1,undefined,sheet);
  const first=await f.preview([["A","2027-01-01","start"]]);
  expect(first.read.outcomes[0]).toMatchObject({operation:"CREATE",identity:["spreadsheet:"+sheet,hash(JSON.stringify([sheet,"A"]))]});
  expect(first.read.outcomes[0]!.identity![0]).toHaveLength(268);
  const changed=await f.preview([["A","2027-01-02","next"]]);
  expect(changed.read.outcomes[0]).toMatchObject({operation:"UPDATE",identity:first.read.outcomes[0]!.identity});
  const command={sourceId:f.sourceId,previewReceiptId:changed.result.receiptId,rowOrdinals:[1],commandKey:randomUUID()};
  const reviewed=await f.api.commitCsvReviewedImport(f.actor,command,randomUUID());
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:reviewed.receiptId})).outcomes[0]!.identity).toEqual(first.read.outcomes[0]!.identity);
  const before=await f.graph();
  expect(await f.api.persistCsvPreview(f.actor,first.command,randomUUID())).toEqual({...first.result,replayed:true});
  expect(await f.api.commitCsvReviewedImport(f.actor,command,randomUUID())).toEqual({...reviewed,replayed:true});
  expect(await f.graph()).toEqual(before);
});

it("rejects a caller baseline without reading its getter or advancing comparison state",async()=>{
  const f=await fixture(),before=await f.graph(),getter=vi.fn(()=>{throw new Error("private baseline must not be read");});
  const command=Object.defineProperty(f.input([["A"]]),"baseline",{get:getter});
  await expect(f.api.persistCsvPreview(f.actor,command,randomUUID())).rejects.toMatchObject({code:"INVALID_REQUEST"});
  expect(getter).not.toHaveBeenCalled(); expect(await f.graph()).toEqual(before);
});

it("replays original preview and reviewed selection after newer heads and reader-only revisions",async()=>{
  const f=await fixture(),first=await f.preview([["A","2027-01-01","start"]]);
  const reviewCommand={sourceId:f.sourceId,previewReceiptId:first.result.receiptId,rowOrdinals:[1],commandKey:randomUUID()};
  const reviewed=await f.api.commitCsvReviewedImport(f.actor,reviewCommand,randomUUID());
  await f.preview([["A","2027-01-02","next"]]);
  await f.configure({...f.configuration,projects:f.configuration.projects.map((project)=>({...project,readers:[f.actor.subject,"another-reader"]}))});
  const before=await f.graph();
  expect(await f.api.persistCsvPreview(f.actor,first.command,randomUUID())).toEqual({...first.result,replayed:true});
  expect(await f.api.commitCsvReviewedImport(f.actor,reviewCommand,randomUUID())).toEqual({...reviewed,replayed:true});
  expect(await f.graph()).toEqual(before);
  await expect(f.api.persistCsvPreview(f.actor,{...first.command,csv:first.command.csv+"\n"},randomUUID())).rejects.toMatchObject({code:"CONFLICT"});
  await expect(f.api.persistCsvPreview(f.actor,{...first.command,commandKey:randomUUID()},randomUUID())).rejects.toMatchObject({code:"STALE_CONFIGURATION"});
  await f.configure({...f.configuration,projects:f.configuration.projects.map((project)=>({...project,readers:["another-reader"]}))});
  await expect(f.api.persistCsvPreview(f.actor,first.command,randomUUID())).rejects.toMatchObject({code:"DENIED"});
  await expect(f.api.commitCsvReviewedImport(f.actor,reviewCommand,randomUUID())).rejects.toMatchObject({code:"DENIED"});
});

it("fences the complete 200-project replay union before rejecting a removed original reader scope",async()=>{
  const f=await fixture(100),first=await f.preview([["A","2027-01-01","start"]]);
  const project=await owner.project.findUniqueOrThrow({where:{id:f.projects[0]!}}),additional=Array.from({length:100},()=>randomUUID()).sort();
  await owner.project.createMany({data:additional.map((id)=>({id,customerId:f.customerId,portfolioId:project.portfolioId,code:"EXTRA-"+id,
    name:"Additional replay scope",description:"Synthetic only",reportedStatus:"UNKNOWN"}))});
  await f.configure({...f.configuration,projects:additional.map((projectId)=>({projectId,readers:[f.actor.subject]}))});
  const observed:string[][]=[];
  const repository=new DatabaseIngestionRepository({...f.apiClient,$transaction:<T>(operation:(tx:Tx)=>Promise<T>,options?:Options)=>f.asApi((tx)=>
    operation(new Proxy(tx,{get(target,property,receiver){
      if (property==="$queryRaw") return async(sql:TemplateStringsArray,...values:unknown[])=>{
        const rows=await target.$queryRaw(sql,...values);
        if (sql.join("?").includes('FROM public."Project"') && sql.join("?").includes("FOR UPDATE"))
          observed.push((rows as {id:string}[]).map((row)=>row.id));
        return rows;
      };
      return Reflect.get(target,property,receiver);
    }})),options)} as never,vault);
  const before=await f.graph();
  await expect(repository.persistCsvPreview(f.actor,first.command,randomUUID())).rejects.toMatchObject({code:"DENIED"});
  expect(observed).toEqual([[...f.projects,...additional].sort()]);
  expect(await f.graph()).toEqual(before);
});

it.each([false,true])("rejects narrowing an unobserved comparison project (prior context=%s)",async(compared)=>{
  const f=await fixture(2);
  if (compared) await f.preview([["A","2027-01-01","start"]]);
  await f.configure({...f.configuration,projects:[f.configuration.projects[0]!]});
  const before=await f.graph();
  await expect(f.preview([["A","2027-01-02","next"]])).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await f.graph()).toEqual(before);
});

it("retains complete comparison scope through a widening that has been observed",async()=>{
  const f=await fixture();
  const initial=f.configuration;
  await f.preview([["A","2027-01-01","start"]]);
  const project=await owner.project.findUniqueOrThrow({where:{id:f.projects[0]!}}),extraId=randomUUID();
  await owner.project.create({data:{id:extraId,customerId:f.customerId,portfolioId:project.portfolioId,
    code:"EXTRA-"+extraId,name:"Widened comparison scope",description:"Synthetic only",reportedStatus:"UNKNOWN"}});
  await f.configure({...initial,projects:[...initial.projects,{projectId:extraId,readers:[f.actor.subject]}]});
  expect((await f.preview([["A","2027-01-02","next"]])).read.outcomes[0]!.operation).toBe("UPDATE");
  await f.configure(initial);
  const before=await f.graph();
  await expect(f.preview([["A","2027-01-03","later"]])).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await f.graph()).toEqual(before);
});

function gateRepository(f:Awaited<ReturnType<typeof fixture>>,matches:(sql:string)=>boolean) {
  let reached!:(pid:number)=>void,resume!:()=>void,used=false;
  const held=new Promise<void>((resolve)=>{resume=resolve;}),ready=new Promise<number>((resolve)=>{reached=resolve;});
  const repository=new DatabaseIngestionRepository({...f.apiClient,$transaction:<T>(operation:(tx:Tx)=>Promise<T>,options?:Options)=>
    f.asApi((tx)=>operation(new Proxy(tx,{get(target,property,receiver){
      if (property==="$queryRaw" || property==="$executeRaw") return async(sql:TemplateStringsArray,...values:unknown[])=>{
        if (!used && matches(sql.join("?"))) {
          used=true;
          const [backend]=await target.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
          reached(backend!.pid); await held;
        }
        const execute=Reflect.get(target,property,receiver) as (sql:TemplateStringsArray,...values:unknown[])=>Promise<unknown>;
        return execute.call(target,sql,...values);
      };
      return Reflect.get(target,property,receiver);
    }})),options)} as never,vault);
  return {repository,reached:ready,resume};
}

async function gateReached(gate:{reached:Promise<number>},work:Promise<unknown>) {
  return Promise.race([gate.reached,work.then(()=>{throw new Error("Expected native gate was not reached");})]);
}
async function blockedBy(holder:number) {
  const deadline=Date.now()+5000;
  while (Date.now()<deadline) {
    const rows=await owner.$queryRaw<{pid:number}[]>`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND ${holder}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock' ORDER BY pid`;
    if (rows.length) return rows[0]!.pid;
    await new Promise((resolve)=>setTimeout(resolve,20));
  }
  throw new Error("Expected specific PostgreSQL lock wait was not observed");
}

async function expireRevision(sourceId:string,secondsRemaining:number) {
  await owner.$transaction(async(tx)=>{
    // Owner-controlled age fixture only; no application can rewrite history.
    await tx.$executeRawUnsafe('ALTER TABLE public."IngestionSourceRevision" DISABLE TRIGGER ingestion_revision_guard');
    try {await tx.$executeRaw`UPDATE public."IngestionSourceRevision"
      SET "receivedAt"=clock_timestamp()-interval '24 hours'+make_interval(secs=>${secondsRemaining}) WHERE "sourceId"=${sourceId}::uuid`;}
    finally {await tx.$executeRawUnsafe('ALTER TABLE public."IngestionSourceRevision" ENABLE TRIGGER ingestion_revision_guard');}
  });
}

it("keeps metadata replay after expiry and lawful purge, while refusing fresh comparison and review",async()=>{
  const f=await fixture(),first=await f.preview([["A","2027-01-01","start"]]);
  await expireRevision(f.sourceId,-1);
  const before=await f.graph();
  expect(await f.api.persistCsvPreview(f.actor,first.command,randomUUID())).toEqual({...first.result,replayed:true});
  await expect(f.preview([["A","2027-01-02","next"]])).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  await expect(f.api.commitCsvReviewedImport(f.actor,{sourceId:f.sourceId,previewReceiptId:first.result.receiptId,rowOrdinals:[1],commandKey:randomUUID()},randomUUID()))
    .rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await f.graph()).toEqual(before);
  const redacted=await f.api.purgeExpired({...f.actor,subject:f.actor.subject+"-system",roles:["system_admin"]});
  expect(redacted).toBeGreaterThan(0);
  const purged=await f.graph();
  expect(await f.api.persistCsvPreview(f.actor,first.command,randomUUID())).toEqual({...first.result,replayed:true});
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:first.result.receiptId})).outcomes[0]).toMatchObject({contentAvailable:false,proposals:null});
  await expect(f.preview([["A","2027-01-01","start"]])).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await f.graph()).toEqual(purged);
});

it("maps expiry at the final native guard to the same bounded unavailable result and rolls back the entire new command",async()=>{
  const f=await fixture(); await f.preview([["A","2027-01-01","start"]]);
  await expireRevision(f.sourceId,3);
  const before=await f.graph(),gate=gateRepository(f,(sql)=>sql.includes('INSERT INTO public."IngestionCsvContext"'));
  const command=f.input([["A","2027-01-02","next"]]);
  const pending=gate.repository.persistCsvPreview(f.actor,command,randomUUID());
  pending.catch(()=>{});
  try {
    await Promise.race([gate.reached,pending.then(()=>{throw new Error("Native expiry gate was not reached");})]);
    const [{remaining}]=await owner.$queryRaw<{remaining:number}[]>`SELECT GREATEST(0,EXTRACT(EPOCH FROM max("receivedAt")+interval '24 hours'-clock_timestamp()))::double precision AS remaining
      FROM public."IngestionSourceRevision" WHERE "sourceId"=${f.sourceId}::uuid`;
    await new Promise((resolve)=>setTimeout(resolve,Math.ceil(remaining!*1000)+100));
  } finally {gate.resume();}
  await expect(pending).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await f.graph()).toEqual(before);
  expect(await f.api.purgeExpired({...f.actor,subject:f.actor.subject+"-system",roles:["system_admin"]})).toBeGreaterThan(0);
});

it.each(["identical","conflicting","distinct"])("serializes real concurrent %s preview commands or aborts a complete planning race",async(kind)=>{
  const f=await fixture(),first=f.input([["A","2027-01-01","start"]]);
  const second={...first,...(kind==="distinct" ? {commandKey:randomUUID()} : {}),
    ...(kind==="identical" ? {} : {csv:first.csv.replace("2027-01-01","2027-01-02")})};
  const results=await Promise.allSettled([f.api.persistCsvPreview(f.actor,first,randomUUID()),f.api.persistCsvPreview(f.actor,second,randomUUID())]);
  const successful=results.flatMap((result)=>result.status==="fulfilled" ? [result.value] : []);
  expect(successful.length).toBeGreaterThan(0);
  for (const result of results) if (result.status==="rejected") expect(result.reason).toMatchObject({code:"CONFLICT"});
  if (kind==="distinct") {
    expect(successful).toHaveLength(2);
    const operations=await owner.ingestionRowOutcome.findMany({where:{sourceId:f.sourceId},select:{operation:true}});
    expect(operations.map((row)=>row.operation).sort()).toEqual(["CREATE","UPDATE"]);
  } else {
    expect(new Set(successful.map((result)=>result.receiptId)).size).toBe(1);
    expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(1);
    const winner=successful[0]!,command=results[0]!.status==="fulfilled" ? first : second;
    expect(await f.api.persistCsvPreview(f.actor,command,randomUUID())).toEqual({...winner,replayed:true});
  }
  const contexts=await owner.ingestionCsvContext.findMany({where:{sourceId:f.sourceId},orderBy:{revision:"asc"}});
  expect(contexts.map((row)=>row.revision)).toEqual(kind==="distinct" ? [1n,2n] : [1n]);
  expect(await owner.auditEvent.count({where:{customerId:f.customerId,event:"ingestion.csv_preview.persisted"}})).toBe(contexts.length);
});

it.each(["preview-first","configure-first"])("uses canonical project/source ordering during %s configuration race",async(order)=>{
  const f=await fixture(),first=await f.preview([["A","2027-01-01","start"]]);
  const next={...f.configuration,projects:f.configuration.projects.map((project)=>({...project,readers:order==="configure-first" ? ["replacement-reader"] : [f.actor.subject,"extra-reader"]}))};
  const command=f.input([["A","2027-01-02","next"]]);
  const gate=gateRepository(f,(sql)=>order==="preview-first" ? sql.includes('INSERT INTO public."IngestionCsvContext"') : sql.includes('FROM public."IngestionSource"') && sql.includes("FOR UPDATE"));
  let preview:Promise<unknown>|undefined,configuration:Promise<unknown>|undefined;
  try {
    const held=order==="preview-first" ? (preview=gate.repository.persistCsvPreview(f.actor,command,randomUUID())) : (configuration=gate.repository.configure(f.actor,next,randomUUID()));
    held.catch(()=>{}); const holder=await gateReached(gate,held);
    const waiting=order==="preview-first" ? (configuration=f.api.configure(f.actor,next,randomUUID())) : (preview=f.api.persistCsvPreview(f.actor,command,randomUUID()));
    waiting.catch(()=>{}); expect(await blockedBy(holder)).not.toBe(holder);
  } finally {gate.resume();await Promise.allSettled([preview,configuration].filter((work)=>work!==undefined));}
  const [previewResult,configResult]=await Promise.allSettled([preview!,configuration!]);
  expect(configResult.status).toBe("fulfilled");
  if (order==="preview-first") {
    expect(previewResult.status).toBe("fulfilled"); expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(2);
    expect(await f.api.persistCsvPreview(f.actor,first.command,randomUUID())).toMatchObject({receiptId:first.result.receiptId,replayed:true});
  } else {
    expect(previewResult).toMatchObject({status:"rejected",reason:{code:"CONFLICT"}});
    await expect(f.api.persistCsvPreview(f.actor,command,randomUUID())).rejects.toMatchObject({code:"DENIED"});
    expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(1);
  }
});

it.each(["preview-first","revoke-first"])("retains grant fences during %s revocation race",async(order)=>{
  const f=await fixture(); await f.preview([["A","2027-01-01","start"]]);
  const command=f.input([["A","2027-01-02","next"]]);
  let releaseRevoke!:()=>void,revokeReached!:(pid:number)=>void;
  const held=new Promise<void>((resolve)=>{releaseRevoke=resolve;}),ready=new Promise<number>((resolve)=>{revokeReached=resolve;});
  const revoke=()=>f.asApi(async(tx)=>{
    await tx.$queryRaw`SELECT id FROM public."Project" WHERE "customerId"=${f.customerId}::uuid AND id=${f.projects[0]}::uuid FOR UPDATE`;
    await tx.$executeRaw`DELETE FROM public."AccessGrant" WHERE "customerId"=${f.customerId}::uuid AND subject=${f.actor.subject} AND role='pmo_admin'`;
    const [{pid}]=await tx.$queryRaw<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
    revokeReached(pid!); await held;
  },{timeout:20000});
  const gate=gateRepository(f,(sql)=>sql.includes('INSERT INTO public."IngestionCsvContext"'));
  let preview:Promise<unknown>|undefined,revocation:Promise<unknown>|undefined;
  try {
    if (order==="preview-first") {
      preview=gate.repository.persistCsvPreview(f.actor,command,randomUUID()); preview.catch(()=>{});
      const holder=await gateReached(gate,preview); revocation=revoke(); revocation.catch(()=>{}); await blockedBy(holder);
    } else {
      revocation=revoke(); revocation.catch(()=>{}); const holder=await Promise.race([ready,revocation.then(()=>{throw new Error("Revocation gate not reached");})]);
      preview=f.api.persistCsvPreview(f.actor,command,randomUUID()); preview.catch(()=>{}); await blockedBy(holder);
    }
  } finally {gate.resume();releaseRevoke();await Promise.allSettled([preview,revocation].filter((work)=>work!==undefined));}
  const [previewResult,revokeResult]=await Promise.allSettled([preview!,revocation!]);
  expect(revokeResult.status).toBe("fulfilled");
  expect(previewResult).toMatchObject(order==="preview-first" ? {status:"fulfilled"} : {status:"rejected",reason:{code:"DENIED"}});
  expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(order==="preview-first" ? 2 : 1);
  await expect(f.api.persistCsvPreview(f.actor,command,randomUUID())).rejects.toMatchObject({code:"DENIED"});
});

it("serializes an actual purge before a new comparison and refuses redacted baseline content",async()=>{
  const f=await fixture(); await f.preview([["A","2027-01-01","start"]]); await expireRevision(f.sourceId,-1);
  const before=await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}});
  const gate=gateRepository(f,(sql)=>sql.includes('FROM public."IngestionProposalContent" c'));
  const purge=gate.repository.purgeExpired({...f.actor,subject:f.actor.subject+"-system",roles:["system_admin"]}); purge.catch(()=>{});
  let preview:Promise<unknown>|undefined;
  try {
    const holder=await gateReached(gate,purge);
    preview=f.api.persistCsvPreview(f.actor,f.input([["A","2027-01-02","next"]]),randomUUID()); preview.catch(()=>{});
    await blockedBy(holder);
  } finally {gate.resume();await Promise.allSettled([purge,preview].filter((work)=>work!==undefined));}
  expect(await purge).toBeGreaterThan(0);
  await expect(preview).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}})).toEqual(before);
  expect(await owner.ingestionOperationReceipt.count({where:{sourceId:f.sourceId}})).toBe(1);
});

// Build a new, otherwise valid same-state command using only API-role grants.
// Tampering targets native guards directly; every failed graph/audit rolls back.
async function nativeTransition(f:Awaited<ReturnType<typeof fixture>>,baseReceiptId:string,mode:string,transaction?:Tx) {
  const operation=async(tx:Tx)=>{
    // Each transition validates immediately at the end; a following transition
    // in the same transaction still needs deferred graph construction.
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
    const [head]=await tx.$queryRaw<{revision:bigint;currentReceiptId:string;stateHash:string;canonicalHistoryBytes:bigint;dictionary:unknown}[]>`
      SELECT revision,"currentReceiptId","stateHash","canonicalHistoryBytes",dictionary FROM public."IngestionCsvHead"
      WHERE "customerId"=${f.customerId}::uuid AND "sourceId"=${f.sourceId}::uuid`;
    const [context]=await tx.$queryRaw<{rows:unknown;canonicalBytes:number;configRevision:number;mappingRevision:number}[]>`
      SELECT rows,"canonicalBytes","configRevision","mappingRevision" FROM public."IngestionCsvContext" WHERE "receiptId"=${head!.currentReceiptId}::uuid`;
    const receiptId=randomUUID(),auditEventId=randomUUID(),createdAt=mode==="backdated-missing-context" ? new Date("2000-01-01T00:00:00.000Z") : new Date();
    const kind=mode==="connector-event" ? "CONNECTOR_EVENT" : mode==="connector-page" ? "CONNECTOR_PAGE" : mode==="reviewed-parent" ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW";
    const source=await tx.ingestionSource.findUniqueOrThrow({where:{id:f.sourceId}});
    const configRevision=mode==="csv-on-connector" ? source.currentConfigRevision! : context!.configRevision;
    const mappingRevision=mode==="csv-on-connector" ? source.mappingRevision : context!.mappingRevision;
    const outcomes=await tx.ingestionRowOutcome.findMany({where:{receiptId:baseReceiptId},orderBy:{ordinal:"asc"}});
    let comparisonRows=context!.rows;
    const forgedValue=["wrong-value-type","formula-value","unsafe-number","empty-text","required-empty-text"].includes(mode);
    if (forgedValue) {
      const rows=JSON.parse(JSON.stringify(context!.rows)) as [string,string,string,[string,string][]][];
      const dictionary=head!.dictionary as [string,string][];
      const policy=await tx.ingestionRetentionPolicy.findUniqueOrThrow({where:{customerId:f.customerId}});
      for (const outcome of outcomes) {
        if (outcome.state!=="ACCEPTED") continue;
        const oldContent=await tx.ingestionProposalContent.findUniqueOrThrow({where:{projectionId:outcome.projectionId!}});
        const proposals=JSON.parse(JSON.stringify(oldContent.proposals)) as {factType:string;value:{type:string;value:unknown}}[];
        const target=proposals.find((proposal)=>proposal.factType===(mode==="wrong-value-type" ? "project.forecast" : mode==="unsafe-number" ? "project.metric" : "project.status"))!;
        expect(target).toBeDefined();
        if (mode==="wrong-value-type") target.value={type:"text",value:"2027-01-01"};
        else if (mode==="formula-value") target.value={type:"text",value:"\u00a0=unsafe-spreadsheet-expression"};
        else if (mode==="empty-text" || mode==="required-empty-text") target.value={type:"text",value:""};
        else target.value={type:"number",value:9007199254740992};
        const sourceRevisionId=randomUUID(),projectionId=randomUUID(),sourceHash=hash(randomUUID());
        await tx.ingestionSourceRevision.create({data:{id:sourceRevisionId,customerId:f.customerId,sourceId:f.sourceId,recordId:outcome.recordId!,
          revision:"sha256:"+sourceHash,sourceContentHash:sourceHash}});
        const [{proposalHash}]=await tx.$queryRaw<{proposalHash:string}[]>`SELECT encode(sha256(convert_to((${JSON.stringify(proposals)}::jsonb)::text,'UTF8')),'hex') AS "proposalHash"`;
        await tx.ingestionProposalProjection.create({data:{id:projectionId,customerId:f.customerId,sourceId:f.sourceId,recordId:outcome.recordId!,
          sourceRevisionId,mappingRevision:context!.mappingRevision,proposalHash:proposalHash!,factTypes:proposals.map((proposal)=>proposal.factType)}});
        await tx.ingestionProposalContent.create({data:{customerId:f.customerId,sourceId:f.sourceId,recordId:outcome.recordId!,projectionId,
          policyRevision:policy.revision,proposals:JSON.parse(JSON.stringify(proposals)) as Prisma.InputJsonValue}});
        outcome.sourceRevisionId=sourceRevisionId;outcome.projectionId=projectionId;
        const row=rows.find((row)=>row[1]===outcome.recordId)!;
        row[3]=proposals.map((proposal)=>[String(dictionary.findIndex(([factType])=>factType===proposal.factType)),projectionId] as [string,string]).sort(([a],[b])=>Number(a)-Number(b));
      }
      comparisonRows=rows;
    }
    const outcomeCount=outcomes.length+(mode==="mixed-duplicate" ? 1 : 0);
    const event=kind==="CSV_REVIEWED_IMPORT" ? "ingestion.csv_reviewed_import.persisted" : kind==="CONNECTOR_EVENT" ? "ingestion.connector_event.persisted" : kind==="CONNECTOR_PAGE" ? "ingestion.connector_page.persisted" : "ingestion.csv_preview.persisted";
    await tx.auditEvent.create({data:{id:auditEventId,customerId:f.customerId,actor:f.actor.subject,event,
      correlationId:randomUUID(),occurredAt:createdAt,detail:{receiptId,kind,sourceId:f.sourceId,
        configRevision,mappingRevision,scopeProjectIds:f.projects,requestHash:"f".repeat(64),outcomeCount}}});
    await tx.$executeRaw`INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","eventId","configRevision","mappingRevision","outcomeCount","auditEventId","createdAt","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter")
      VALUES (${receiptId}::uuid,${f.customerId}::uuid,${f.sourceId}::uuid,${f.actor.subject},${kind},${randomUUID()},${"f".repeat(64)},${kind==="CONNECTOR_EVENT" ? randomUUID() : null},${configRevision},${mappingRevision},${outcomeCount},${auditEventId}::uuid,${createdAt},
        ${kind==="CONNECTOR_PAGE" ? source.syncGeneration : null},${kind==="CONNECTOR_PAGE" ? source.syncGeneration : null},
        ${kind==="CONNECTOR_PAGE" ? source.cursorRevision : null},${kind==="CONNECTOR_PAGE" ? source.cursorRevision+1n : null})`;
    await tx.$executeRaw`INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
      SELECT "customerId","sourceId",${receiptId}::uuid,"projectId","grantId","grantRole","grantScopeType","grantScopeId"
      FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=${baseReceiptId}::uuid`;
    if (mode.startsWith("selective-")) await tx.$executeRawUnsafe("SET CONSTRAINTS ingestion_outcome_commit IMMEDIATE");
    const suppliedOutcomes=mode==="selective-incomplete" ? outcomes.slice(0,-1) : outcomes;
    for (const outcome of suppliedOutcomes) {
      if (mode==="selective-rejected-no-reason" && outcome.ordinal===1) {
        await tx.$executeRaw`INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes","projectId","recordKey")
          VALUES (${f.customerId}::uuid,${f.sourceId}::uuid,${receiptId}::uuid,1,'INVALID','NONE',ARRAY[]::text[],${outcome.projectId}::uuid,${outcome.recordKey})`;
      } else {
        await tx.ingestionRowOutcome.create({data:{...outcome,receiptId,
          operation:outcome.state==="ACCEPTED" ? forgedValue ? "UPDATE" : "UNCHANGED" : "NONE"}});
      }
    }
    if (mode==="selective-incomplete") await tx.$executeRawUnsafe("SET CONSTRAINTS ingestion_receipt_commit IMMEDIATE");
    if (mode==="mixed-duplicate") await tx.ingestionRowOutcome.create({data:{customerId:f.customerId,sourceId:f.sourceId,receiptId,
      ordinal:outcomeCount,state:"INVALID",operation:"NONE",errorCodes:["DUPLICATE_KEY"],projectId:outcomes[0]!.projectId,recordKey:outcomes[0]!.recordKey}});
    if (mode==="reviewed-parent") {
      await tx.$executeRaw`INSERT INTO public."IngestionReviewedImport" ("customerId","sourceId","receiptId","previewReceiptId")
        VALUES (${f.customerId}::uuid,${f.sourceId}::uuid,${receiptId}::uuid,${baseReceiptId}::uuid)`;
      throw new Error("Corrupted native reviewed-import parent unexpectedly accepted");
    }
    const revision=head!.revision+1n;
    const replacement=mode==="missing-identity" || forgedValue ? serializeCsvComparisonState(["pdaa.csv.state.v1",f.customerId,f.sourceId,String(context!.mappingRevision),head!.dictionary,mode==="missing-identity" ? [] : comparisonRows]) : null;
    const stateHash=replacement ? hash(replacement.text) : head!.stateHash;
    const canonicalBytes=replacement?.bytes ?? context!.canonicalBytes;
    if (!["missing-context","backdated-missing-context","head-only"].includes(mode)) {
      const rows=mode==="missing-identity" ? [] : comparisonRows;
      await tx.$executeRaw`INSERT INTO public."IngestionCsvContext" ("customerId","sourceId","receiptId","configRevision","mappingRevision",revision,
        "predecessorReceiptId","predecessorRevision","predecessorHash",rows,"canonicalBytes","stateHash")
        VALUES (${f.customerId}::uuid,${f.sourceId}::uuid,${receiptId}::uuid,${context!.configRevision},${context!.mappingRevision},${revision},
          ${head!.currentReceiptId}::uuid,${head!.revision},${mode==="forged-predecessor" ? "0".repeat(64) : head!.stateHash},${JSON.stringify(rows)}::jsonb,
          ${canonicalBytes+(mode==="forged-bytes" ? 1 : 0)},${mode==="forged-hash" ? "0".repeat(64) : stateHash})`;
    }
    if (!["missing-context","backdated-missing-context","orphan-context"].includes(mode)) await tx.$executeRaw`
      UPDATE public."IngestionCsvHead" SET revision=${revision},"currentReceiptId"=${receiptId}::uuid,"stateHash"=${stateHash},
        "canonicalHistoryBytes"=${head!.canonicalHistoryBytes+BigInt(canonicalBytes)+(mode==="forged-counter" ? 1n : 0n)}
      WHERE "customerId"=${f.customerId}::uuid AND "sourceId"=${f.sourceId}::uuid`;
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    return receiptId;
  };
  return transaction ? operation(transaction) : f.asApi(operation,{timeout:20000});
}

it.each(["missing-context","backdated-missing-context","head-only","orphan-context","forged-predecessor","forged-bytes","forged-hash","missing-identity","forged-counter","mixed-duplicate"])(
  "rejects native %s with no graph or audit effect",async(mode)=>{
    const f=await fixture(),first=await f.preview([["A","2027-01-01","start"]]),before=await f.graph();
    await expect(nativeTransition(f,first.result.receiptId,mode)).rejects.toThrow();
    expect(await f.graph()).toEqual(before);
  });

it("allows a real native same-state successor and retains older-context validity",async()=>{
  const f=await fixture(),first=await f.preview([["A","2027-01-01","start"]]);
  const receiptId=await nativeTransition(f,first.result.receiptId,"valid");
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId})).outcomes[0]!.operation).toBe("UNCHANGED");
  expect((await f.api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:first.result.receiptId})).outcomes[0]!.operation).toBe("CREATE");
  await f.asApi(async(tx)=>{
    await nativeTransition(f,first.result.receiptId,"valid",tx);
    await nativeTransition(f,first.result.receiptId,"valid",tx);
  },{timeout:20000});
  expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(4);
});

it("checks immediate CSV outcomes while their graph is built and leaves no ordinal for a late append", async () => {
  const f = await fixture();
  const first = await f.preview([["A","2027-01-01","start"],["B","2027-01-02","other"]]);
  const receiptId = await nativeTransition(f, first.result.receiptId, "selective-outcome");
  const read = await f.api.readReceipt(f.actor, {sourceId:f.sourceId,receiptId});
  expect(read.outcomes.map((row) => row.operation)).toEqual(["UNCHANGED","UNCHANGED"]);
  const empty = await f.preview([]);
  const before = await f.graph();
  const append = (target: string, ordinal: number) => f.asApi((tx) => tx.$executeRaw`
    INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes","projectId","recordKey","recordId","sourceRevisionId","projectionId")
    SELECT "customerId","sourceId",${target}::uuid,${ordinal}::integer,state,operation,"errorCodes","projectId","recordKey","recordId","sourceRevisionId","projectionId"
    FROM public."IngestionRowOutcome" WHERE "receiptId"=${receiptId}::uuid AND ordinal=1`);
  for (const [target, ordinal, code] of [[receiptId,1,"23505"],[receiptId,3,"P0001"],[empty.result.receiptId,1,"P0001"]] as const) {
    const failure = await append(target,ordinal).then(() => undefined, (error: unknown) => error);
    expect(errorCode(failure)).toBe(code);
  }
  for (const mode of ["selective-incomplete","selective-rejected-no-reason"]) {
    const failure = await nativeTransition(f,first.result.receiptId,mode).then(() => undefined, (error: unknown) => error);
    expect(errorCode(failure)).toBe("P0001");
    expect(own(own(own(own(failure,"meta"),"driverAdapterError"),"cause"),"originalMessage")).toBe("Incomplete ingestion receipt cannot commit");
  }
  expect(await f.graph()).toEqual(before);
});

it.each(["connector-event","connector-page","csv-on-connector","stale-config"])("rejects direct native receipt family or revision bypass %s",async(mode)=>{
  const f=await fixture(),first=await f.preview([["A","2027-01-01","start"]]);
  if (mode==="csv-on-connector") await f.configure({...f.configuration,mapping:{kind:"CONNECTOR",factTypes:["project.forecast","project.status"]}});
  if (mode==="stale-config") await f.configure({...f.configuration,projects:f.configuration.projects.map((project)=>({...project,readers:[f.actor.subject,"extra-reader"]}))});
  const before=await f.graph(); let failure:unknown;
  try {await nativeTransition(f,first.result.receiptId,mode);} catch(error) {failure=error;}
  expect(errorCode(failure)).toBe("P0001");
  expect((failure as {meta?:{driverAdapterError?:{cause?:{originalMessage?:string}}}})?.meta?.driverAdapterError?.cause?.originalMessage)
    .toBe(mode==="stale-config" ? "Ingestion receipt uses stale configuration" : "Ingestion receipt mapping family is invalid");
  expect(await f.graph()).toEqual(before);
});

it.each(["wrong-value-type","formula-value","unsafe-number","empty-text","required-empty-text"])("independently rejects an otherwise well-bound native %s proposal",async(mode)=>{
  const fields:Field[]=[{column:"Forecast",factType:"project.forecast",type:"date",required:false},
    {column:"Status",factType:"project.status",type:"text",required:mode==="required-empty-text"},{column:"Metric",factType:"project.metric",type:"number",required:false}];
  const f=await fixture(1,fields),command={...f.input([]),csv:`Key,Project,Forecast,Status,Metric\nA,${f.projects[0]},2027-01-01,start,1.25\n`};
  const first=await f.api.persistCsvPreview(f.actor,command,randomUUID()),before=await f.graph();
  let failure:unknown;
  try {await nativeTransition(f,first.receiptId,mode);} catch(error) {failure=error;}
  expect(errorCode(failure)).toBe("P0001");
  expect((failure as {meta?:{driverAdapterError?:{cause?:{originalMessage?:string}}}})?.meta?.driverAdapterError?.cause?.originalMessage)
    .toBe("Invalid CSV comparison value");
  expect(await f.graph()).toEqual(before);
});

it("accepts whitespace text and treats a later empty optional cell as omission",async()=>{
  const f=await fixture();
  await f.preview([["A","2027-01-01","start"]]);
  const changed=await f.preview([["A","2027-01-01","   "]]);
  expect(changed.read.outcomes[0]!.operation).toBe("UPDATE");
  expect(changed.read.outcomes[0]!.proposals).toContainEqual({factType:"project.status",value:{type:"text",value:"   "}});
  const context=await owner.ingestionCsvContext.findUniqueOrThrow({where:{receiptId:changed.result.receiptId}});
  const rows=context.rows as [string,string,string,[string,string][]][];
  const statusRef=rows[0]![3].find(([index])=>index==="1")![1];
  const before=await owner.ingestionProposalContent.findUniqueOrThrow({where:{projectionId:statusRef}});
  const omitted=await f.preview([["A","2027-01-01",""]]);
  expect(omitted.read.outcomes[0]!.operation).toBe("UNCHANGED");
  const next=await owner.ingestionCsvContext.findUniqueOrThrow({where:{receiptId:omitted.result.receiptId}});
  expect((next.rows as typeof rows)[0]![3].find(([index])=>index==="1")![1]).toBe(statusRef);
  expect(await owner.ingestionProposalContent.findUniqueOrThrow({where:{projectionId:statusRef}})).toEqual(before);
});

it("checks every field membership when multiple references share one metadata projection binding",async()=>{
  const f=await fixture();await f.preview([["A","2027-01-01","start"]]);
  const carried=await f.preview([["A"]]);
  expect(carried.read.outcomes[0]).toMatchObject({operation:"UNCHANGED",proposals:[]});
  const context=await owner.ingestionCsvContext.findUniqueOrThrow({where:{receiptId:carried.result.receiptId}});
  const rows=context.rows as [string,string,string,[string,string][]][];
  expect(rows[0]![3]).toHaveLength(2);
  const projectionId=rows[0]![3][0]![1];
  expect(rows[0]![3][1]![1]).toBe(projectionId);
  const observation=await owner.ingestionRowOutcome.findFirstOrThrow({where:{receiptId:carried.result.receiptId}});
  expect(observation.projectionId).not.toBe(projectionId);
  const before=await f.graph();
  await expect(owner.$transaction(async(tx)=>{
    expect(await tx.$queryRaw`SELECT public.valid_ingestion_csv_context(${carried.result.receiptId}::uuid) AS valid`).toEqual([{valid:true}]);
    await tx.$executeRawUnsafe('ALTER TABLE public."IngestionProposalProjection" DISABLE TRIGGER ingestion_projection_guard');
    try {
      await tx.$executeRaw`UPDATE public."IngestionProposalProjection" SET "factTypes"=ARRAY['project.forecast']::text[] WHERE id=${projectionId}::uuid`;
    } finally {await tx.$executeRawUnsafe('ALTER TABLE public."IngestionProposalProjection" ENABLE TRIGGER ingestion_projection_guard');}
    // Its current observation supplies no fields, so changing the carried
    // projection's factTypes cannot change this context's expected overlay.
    expect(await tx.$queryRaw`SELECT public.valid_ingestion_receipt(${carried.result.receiptId}::uuid) AS cheap,
      public.valid_ingestion_csv_context(${carried.result.receiptId}::uuid) AS full`).toEqual([{cheap:true,full:false}]);
    throw new Error("ROLLED_BACK_SHARED_PROJECTION_MEMBERSHIP");
  },{timeout:20000})).rejects.toThrow("ROLLED_BACK_SHARED_PROJECTION_MEMBERSHIP");
  expect(await f.graph()).toEqual(before);
});

it("requires full parent context for native reviewed-import birth and semantic reads even when the cheap receipt link still passes",async()=>{
  const f=await fixture(),first=await f.preview([["A","2027-01-01","start"]]),before=await f.graph();
  await expect(owner.$transaction(async(tx)=>{
    await tx.$executeRawUnsafe('ALTER TABLE public."IngestionCsvContext" DISABLE TRIGGER ingestion_csv_context_guard');
    try {await tx.$executeRaw`UPDATE public."IngestionCsvContext" SET rows='[]'::jsonb WHERE "receiptId"=${first.result.receiptId}::uuid`;}
    finally {await tx.$executeRawUnsafe('ALTER TABLE public."IngestionCsvContext" ENABLE TRIGGER ingestion_csv_context_guard');}
    expect(await tx.$queryRaw`SELECT public.valid_ingestion_receipt(${first.result.receiptId}::uuid) AS cheap,
      public.valid_ingestion_csv_context(${first.result.receiptId}::uuid) AS full`).toEqual([{cheap:true,full:false}]);
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
    const api=new DatabaseIngestionRepository({$queryRaw:tx.$queryRaw.bind(tx),$transaction:<T>(operation:(tx:Tx)=>Promise<T>)=>operation(tx),auditEvent:tx.auditEvent} as never,vault);
    await expect(api.readReceipt(f.actor,{sourceId:f.sourceId,receiptId:first.result.receiptId})).rejects.toMatchObject({code:"INTEGRITY_CONFLICT"});
    await tx.$executeRawUnsafe("SAVEPOINT reviewed_parent_probe");
    let failure:unknown;
    try {await nativeTransition(f,first.result.receiptId,"reviewed-parent",tx);} catch(error) {failure=error;}
    finally {await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT reviewed_parent_probe");}
    expect(errorCode(failure)).toBe("P0001");
    expect((failure as {meta?:{driverAdapterError?:{cause?:{originalMessage?:string}}}})?.meta?.driverAdapterError?.cause?.originalMessage)
      .toBe("Reviewed import parent comparison is invalid");
    throw new Error("ROLLED_BACK_OWNED_PARENT_CORRUPTION");
  },{timeout:20000})).rejects.toThrow("ROLLED_BACK_OWNED_PARENT_CORRUPTION");
  expect(await f.graph()).toEqual(before);
});

it("detects an omitted head on a restored empty CSV source before any context row exists",async()=>{
  const f=await fixture(),before=await f.graph();
  await verifyRequiredCsvHeads(owner);
  await expect(owner.$transaction(async(tx)=>{
    await tx.$executeRawUnsafe('ALTER TABLE public."IngestionCsvHead" DISABLE TRIGGER ingestion_csv_head_guard');
    try {await tx.$executeRaw`DELETE FROM public."IngestionCsvHead" WHERE "customerId"=${f.customerId}::uuid AND "sourceId"=${f.sourceId}::uuid`;}
    finally {await tx.$executeRawUnsafe('ALTER TABLE public."IngestionCsvHead" ENABLE TRIGGER ingestion_csv_head_guard');}
    expect(await tx.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(0);
    await expect(verifyRequiredCsvHeads(tx)).rejects.toThrow("missing its required comparison head");
    throw new Error("ROLLED_BACK_OWNED_HEAD_OMISSION");
  },{timeout:20000})).rejects.toThrow("ROLLED_BACK_OWNED_HEAD_OMISSION");
  expect(await f.graph()).toEqual(before);
  await verifyRequiredCsvHeads(owner);
});

it.each(["IngestionCsvHead","IngestionCsvContext"])("denies API deletion, truncation and identity edits on %s",async(table)=>{
  const f=await fixture(); await f.preview([["A","2027-01-01","start"]]); const before=await f.graph();
  for (const sql of [`DELETE FROM public."${table}"`,`TRUNCATE public."${table}" CASCADE`,
    `UPDATE public."${table}" SET "customerId"="customerId"`]) {
    let failure:unknown;
    try {await f.asApi((tx)=>tx.$executeRawUnsafe(sql));} catch(error) {failure=error;}
    expect(errorCode(failure)).toBe("42501");
  }
  expect(await f.graph()).toEqual(before);
});

const wideFields:Field[]=Array.from({length:32},(_,index)=>({column:"F"+index,factType:"f"+String(index).padStart(2,"0"),type:"text",required:false}));
function wideCsv(projectId:string,count:number,value:(row:number,field:number)=>string) {
  return ["Key,Project,"+wideFields.map((field)=>field.column).join(","),...Array.from({length:count},(_,row)=>
    ["K"+row,projectId,...wideFields.map((_,field)=>value(row,field))].join(","))].join("\n");
}
it("persists a reachable 1000-row/32-field state and genuinely exhausts the canonical-history byte budget",async({signal,onTestFailed,onTestFinished})=>{
  let stage = "INITIAL_PREVIEW";
  let committed = 0;
  let target = 0;
  let filling: Promise<void> | undefined;
  const started = performance.now();
  onTestFailed(() => {
    console.error("CSV_NATIVE_CAPACITY_PROGRESS", JSON.stringify({stage,committed,target,elapsedMs:Math.round(performance.now()-started)}));
  });
  // The test owns the fill even when Vitest's deadline wins the race.
  onTestFinished(async () => { await filling?.catch(() => undefined); }, 70000);
  const f=await fixture(1,wideFields,"Projects","WIDE"),command={...f.input([]),csv:wideCsv(f.projects[0]!,1000,()=>"v")};
  expect(Buffer.byteLength(command.csv)).toBeLessThanOrEqual(1048576);
  const first=await f.api.persistCsvPreview(f.actor,command,randomUUID());
  f.stopDiagnostics();
  committed = 1;
  stage = "REPLAY_BEFORE_FILL";
  signal.throwIfAborted();
  expect(first.rowCount).toBe(1000);
  const context=await owner.ingestionCsvContext.findUniqueOrThrow({where:{receiptId:first.receiptId}});
  const rows=context.rows as [string,string,string,[string,string][]][];
  expect(rows).toHaveLength(1000); expect(rows.reduce((n,row)=>n+row[3].length,0)).toBe(32000);
  expect(context.canonicalBytes).toBeGreaterThan(1600000); expect(context.canonicalBytes).toBeLessThanOrEqual(2097152);
  const before=await f.graph();
  expect(await f.api.persistCsvPreview(f.actor,command,randomUUID())).toEqual({...first,replayed:true});
  expect(await f.graph()).toEqual(before);
  target=Math.floor(268435456/context.canonicalBytes);
  expect(target).toBeGreaterThan(1); expect(target).toBeLessThan(4096);
  stage = "FILL";
  filling=fillNativeContexts(f,target,signal,(revision)=>{committed=revision;});
  await filling;
  stage = "CAPACITY_REJECTION";
  signal.throwIfAborted();
  const head=await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}});
  expect(head.canonicalHistoryBytes).toBe(BigInt(target*context.canonicalBytes));
  expect(head.canonicalHistoryBytes+BigInt(context.canonicalBytes)).toBeGreaterThan(268435456n);
  const empty={...command,commandKey:randomUUID(),csv:wideCsv(f.projects[0]!,0,()=>"")};
  await expect(f.api.persistCsvPreview(f.actor,empty,randomUUID())).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}})).toEqual(head);
  expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(target);
  expect(await owner.ingestionOperationReceipt.count({where:{sourceId:f.sourceId}})).toBe(target);
  expect(await f.api.persistCsvPreview(f.actor,command,randomUUID())).toEqual({...first,replayed:true});
},420000);

// Actual API-role commands, not forged counters. Every entry passes the live
// constructor, exact head advance and all deferred completeness checks. Bounded
// chunks retain the normal 10-second query and 60-second transaction deadlines.
async function fillNativeContexts(f:Awaited<ReturnType<typeof fixture>>,target:number,signal:AbortSignal,onCommit?:(revision:number)=>void) {
  expect(Number.isInteger(target) && target>1 && target<=4096).toBe(true);
  expect(/^[a-f0-9-]{36}$/.test(f.customerId) && /^[a-f0-9-]{36}$/.test(f.sourceId)).toBe(true);
  expect(/^csv-state-[a-f0-9-]{36}$/.test(f.actor.subject)).toBe(true);
  if (f.configuration.mapping.kind!=="CSV") throw new Error("CSV capacity fixture mapping required");
  const emptyCsv=[f.configuration.mapping.identityColumn,f.configuration.mapping.projectColumn,...f.configuration.mapping.fields.map((field)=>field.column)].join(",")+"\n";
  const requestHash=hash(JSON.stringify({baseline:null,configRevision:1,csvHash:hash(emptyCsv),mappingRevision:1}));
  expect(/^[a-f0-9]{64}$/.test(requestHash)).toBe(true);
  let head=await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}});
  while (head.revision<BigInt(target)) {
    signal.throwIfAborted();
    const size=Math.min(target-Number(head.revision),target>1000 ? 32 : 1);
    await f.asApi(async(tx)=>{
      await tx.$queryRaw`SELECT id FROM public."Project" WHERE "customerId"=${f.customerId}::uuid AND id=ANY(${f.projects}::uuid[]) ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM public."AccessGrant" WHERE "customerId"=${f.customerId}::uuid AND subject=${f.actor.subject} ORDER BY id FOR SHARE`;
      await tx.$queryRaw`SELECT revision FROM public."IngestionRetentionPolicy" WHERE "customerId"=${f.customerId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM public."IngestionSource" WHERE "customerId"=${f.customerId}::uuid AND id=${f.sourceId}::uuid FOR UPDATE`;
      signal.throwIfAborted();
      // All interpolated literals above were generated and format-checked here;
      // DO cannot bind parameters inside its dollar-quoted body.
      await tx.$executeRawUnsafe(`DO $capacity$
        DECLARE h public."IngestionCsvHead"%ROWTYPE; prior public."IngestionCsvContext"%ROWTYPE;
          original public."IngestionOperationReceipt"%ROWTYPE; new_receipt uuid; new_audit uuid; at_time timestamptz; i integer;
        BEGIN
          FOR i IN 1..${size} LOOP
            SELECT * INTO h FROM public."IngestionCsvHead" WHERE "customerId"='${f.customerId}'::uuid AND "sourceId"='${f.sourceId}'::uuid FOR UPDATE;
            SELECT * INTO prior FROM public."IngestionCsvContext" WHERE "receiptId"=h."currentReceiptId";
            SELECT * INTO original FROM public."IngestionOperationReceipt" WHERE id=h."currentReceiptId";
            new_receipt:=gen_random_uuid(); new_audit:=gen_random_uuid(); at_time:=date_trunc('milliseconds',clock_timestamp());
            INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
              VALUES (new_audit,h."customerId",original.subject,'ingestion.csv_preview.persisted',new_audit::text,
                jsonb_build_object('receiptId',new_receipt,'kind','CSV_PREVIEW','sourceId',h."sourceId",'configRevision',original."configRevision",'mappingRevision',h."mappingRevision",
                  'scopeProjectIds',(SELECT jsonb_agg("projectId"::text ORDER BY "projectId") FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=original.id),
                  'requestHash','${requestHash}','outcomeCount',0),at_time);
            INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","configRevision","mappingRevision","outcomeCount","auditEventId","createdAt")
              VALUES (new_receipt,h."customerId",h."sourceId",original.subject,'CSV_PREVIEW','native-capacity-'||new_receipt::text,'${requestHash}',original."configRevision",h."mappingRevision",0,new_audit,at_time);
            INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
              SELECT "customerId","sourceId",new_receipt,"projectId","grantId","grantRole","grantScopeType","grantScopeId" FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=original.id;
            INSERT INTO public."IngestionCsvContext" ("customerId","sourceId","receiptId","configRevision","mappingRevision",revision,"predecessorReceiptId","predecessorRevision","predecessorHash",rows,"canonicalBytes","stateHash")
              VALUES (h."customerId",h."sourceId",new_receipt,original."configRevision",h."mappingRevision",h.revision+1,h."currentReceiptId",h.revision,h."stateHash",prior.rows,prior."canonicalBytes",h."stateHash");
            UPDATE public."IngestionCsvHead" SET revision=h.revision+1,"currentReceiptId"=new_receipt,"canonicalHistoryBytes"=h."canonicalHistoryBytes"+prior."canonicalBytes"
              WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId";
          END LOOP;
        END $capacity$`);
      signal.throwIfAborted();
    },{timeout:60000});
    signal.throwIfAborted();
    const advanced=await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}});
    expect(advanced.revision).toBe(head.revision+BigInt(size)); head=advanced;
    onCommit?.(Number(head.revision));
  }
}

it("genuinely fills 4096 contexts, rejects the next command and retains exact metadata replay",async({signal})=>{
  const f=await fixture(),first=await f.preview([]);
  await fillNativeContexts(f,4096,signal);
  const before=await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}});
  expect(before.revision).toBe(4096n);
  await expect(f.api.persistCsvPreview(f.actor,f.input([]),randomUUID())).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await f.api.persistCsvPreview(f.actor,first.command,randomUUID())).toEqual({...first.result,replayed:true});
  expect(await owner.ingestionCsvHead.findUniqueOrThrow({where:{customerId_sourceId:{customerId:f.customerId,sourceId:f.sourceId}}})).toEqual(before);
  expect(await owner.ingestionCsvContext.count({where:{sourceId:f.sourceId}})).toBe(4096);
  expect(await owner.ingestionOperationReceipt.count({where:{sourceId:f.sourceId}})).toBe(4096);
  expect(await owner.auditEvent.count({where:{customerId:f.customerId,event:"ingestion.csv_preview.persisted"}})).toBe(4096);
},300000);

it("bounds the unique full PostgreSQL content union across sparse carry-forward before a new comparison",async()=>{
  const f=await fixture(1,wideFields,"Projects","SPARSE"),base=f.input([]);
  const first={...base,csv:wideCsv(f.projects[0]!,500,()=>"a".repeat(50))};
  await f.api.persistCsvPreview(f.actor,first,randomUUID());
  f.stopDiagnostics();
  const second={...base,commandKey:randomUUID(),csv:wideCsv(f.projects[0]!,500,(_row,field)=>field===0 ? "" : "b".repeat(50))};
  await f.api.persistCsvPreview(f.actor,second,randomUUID());
  const [{bytes,uniqueProjections}]=await owner.$queryRaw<{bytes:bigint;uniqueProjections:bigint}[]>`
    WITH refs AS (SELECT DISTINCT (ref->>1)::uuid AS id FROM public."IngestionCsvHead" h
      JOIN public."IngestionCsvContext" c ON c."receiptId"=h."currentReceiptId"
      CROSS JOIN LATERAL jsonb_array_elements(c.rows) row_value CROSS JOIN LATERAL jsonb_array_elements(row_value->3) ref
      WHERE h."customerId"=${f.customerId}::uuid AND h."sourceId"=${f.sourceId}::uuid)
    SELECT sum(octet_length(c.proposals::text))::bigint AS bytes,count(*)::bigint AS "uniqueProjections"
    FROM refs JOIN public."IngestionProposalContent" c ON c."projectionId"=refs.id`;
  expect(uniqueProjections).toBe(1000n); expect(bytes).toBeLessThanOrEqual(4194304n); expect(bytes).toBeGreaterThan(2800000n);
  const before=await f.graph();
  const third={...base,commandKey:randomUUID(),csv:wideCsv(f.projects[0]!,500,(_row,field)=>field===0 ? "" : "c".repeat(50))};
  expect(Buffer.byteLength(third.csv)).toBeLessThanOrEqual(1048576);
  await expect(f.api.persistCsvPreview(f.actor,third,randomUUID())).rejects.toMatchObject({code:"INVALID_PREVIEW"});
  expect(await f.graph()).toEqual(before);
  expect(await f.api.persistCsvPreview(f.actor,first,randomUUID())).toEqual(expect.objectContaining({replayed:true}));
},60000);
