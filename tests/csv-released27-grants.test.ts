// NFR-REL-001 / NFR-SEC-001: frozen fixture integrity, not a native ACL proof.
import {expect,it} from "vitest";
import {applyReleased27BusinessGrants} from "../scripts/acceptance/prior-twenty-seven-business-grants.mjs";
function fixture(count=27) {
  const writes:string[]=[];
  return {writes,client:{query:async(sql:string)=>{
    if (sql.startsWith("SELECT migration_name")) return {rows:Array.from({length:count},(_,index)=>({migration_name:index===26 ? "202611150001_ingestion_retention_audit" : "prior-"+index}))};
    if (sql.includes("current_user AS name,rolsuper")) return {rows:[{name:"pdaa_migrate",rolsuper:false}]};
    if (sql.includes("SELECT count(*)::int AS n FROM pg_class")) return {rows:[{n:0}]};
    writes.push(sql); return {rows:[]};
  }}};
}
it("verifies the runtime LF-normalized checksum and uses only the frozen released-27 ACL",async()=>{
  const f=fixture(); await applyReleased27BusinessGrants(f.client);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toContain('GRANT SELECT,INSERT,UPDATE,DELETE ON "Customer","Portfolio","Project","AccessGrant" TO pdaa_api');
  expect(f.writes[0]).toContain('GRANT SELECT,INSERT ON "IngestionSource"');
  expect(f.writes[0]).not.toMatch(/IngestionCsvHead|IngestionCsvContext|valid_ingestion_csv_/);
});
it.each([0,26,28])("refuses to apply the released fixture ACL at migration count %i",async(count)=>{
  const f=fixture(count); await expect(applyReleased27BusinessGrants(f.client)).rejects.toThrow();
  expect(f.writes).toEqual([]);
});
