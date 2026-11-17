// FR-CON-006/007/012 / NFR-SEC-001: finite SQL error and caller-baseline boundary.
import {expect,it,vi} from "vitest";
import {DatabaseIngestionRepository} from "../packages/data/src/ingestion-persistence.js";
import {CredentialVault} from "../packages/platform/dist/index.js";
import type {Actor} from "../packages/domain/src/index.js";

const actor:Actor={customerId:"10000000-0000-4000-8000-000000000001",subject:"synthetic-pmo",roles:["pmo_admin"]};
const input={sourceId:"20000000-0000-4000-8000-000000000001",configRevision:1,mappingRevision:1,commandKey:"synthetic-command",
  fileName:"private.csv",csv:"Key,Project,Value\nprivate-key,private-project,private-value"};
function repository(error:unknown) {
  const transaction=vi.fn(async()=>{throw error;}),audit=vi.fn(async(_input:unknown)=>({id:"30000000-0000-4000-8000-000000000001"}));
  return {transaction,audit,repository:new DatabaseIngestionRepository({$transaction:transaction,auditEvent:{create:audit}} as never,
    new CredentialVault(Buffer.alloc(32,73).toString("base64")))};
}
it.each([["PDC01","INVALID_PREVIEW"],["PDC02","CONFLICT"],["PDC03","DENIED"],["P0001","PERSISTENCE_FAILED"],["42501","PERSISTENCE_FAILED"],["PDC09","PERSISTENCE_FAILED"]])(
  "maps only dedicated native state %s without reading SQL diagnostics",async(sqlstate,expected)=>{
    const cause={kind:"postgres",code:sqlstate,originalCode:sqlstate};
    const diagnostics=vi.fn(()=>{throw new Error("private SQL diagnostics must not be read");});
    Object.defineProperties(cause,{message:{get:diagnostics},originalMessage:{get:diagnostics},detail:{get:diagnostics}});
    const f=repository({code:"P2010",meta:{driverAdapterError:{cause}}});
    const error=await f.repository.persistCsvPreview(actor,input,"synthetic-csv-error").catch((error:unknown)=>error);
    expect(error).toMatchObject({code:expected}); expect(diagnostics).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toMatch(/private-/);
    if (expected==="DENIED") {
      expect(f.audit).toHaveBeenCalledOnce();
      expect(f.audit.mock.calls[0]![0]).toMatchObject({data:{event:"ingestion.operation.denied",detail:{operation:"csv_preview",reason:expected}}});
    } else expect(f.audit).not.toHaveBeenCalled();
  });
it.each([
  {code:"P2010",meta:{driverAdapterError:{cause:{kind:"postgres",code:"P0001",originalCode:"PDC01"}}}},
  {code:"P2010",meta:{driverAdapterError:{cause:{kind:"other",code:"PDC01",originalCode:"PDC01"}}}},
  {code:"OTHER",meta:{driverAdapterError:{cause:{kind:"postgres",code:"PDC01",originalCode:"PDC01"}}}},
])("refuses lookalike or inconsistent adapter error shapes",async(error)=>{
  const f=repository(error);
  await expect(f.repository.persistCsvPreview(actor,input,"synthetic-csv-error")).rejects.toMatchObject({code:"PERSISTENCE_FAILED"});
});
it("rejects a caller baseline accessor before a transaction and without decoding it",async()=>{
  const f=repository(new Error("must not transact")),getter=vi.fn(()=>{throw new Error("must not decode");});
  const command=Object.defineProperty({...input},"baseline",{get:getter});
  await expect(f.repository.persistCsvPreview(actor,command,"synthetic-csv-baseline")).rejects.toMatchObject({code:"INVALID_REQUEST"});
  expect(getter).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
});
