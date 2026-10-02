// EXEC-015 / NFR-REL-002 / NFR-SEC-001: historical loading is fixture-only.
import {afterEach,expect,it,vi} from "vitest";
import {guardCaptureArchiveConnection,constructCaptureArchive} from "../scripts/acceptance/update-capture-archive.mjs";
const source="postgresql://pdaa:fixture@127.0.0.1:55432/pdaa_test_100";
const target="postgresql://pdaa:fixture@127.0.0.1:55432/pdaa_test_200";
const customerId="10000000-0000-4000-8000-000000000001", nonce="20000000-0000-4000-8000-000000000001";
afterEach(()=>vi.unstubAllEnvs());
function environment(){vi.stubEnv("NODE_ENV","development");vi.stubEnv("DATA_MODE","synthetic");vi.stubEnv("CUSTOMER_ID",customerId);}
it("accepts only isolated local synthetic fixture connections",()=>{
 environment();expect(()=>guardCaptureArchiveConnection(source)).not.toThrow();
 for(const url of [source.replace("127.0.0.1","example.com"),source.replace("55432","5432"),source.replace("pdaa_test_100","pdaa"),source+"?sslmode=disable"])
  expect(()=>guardCaptureArchiveConnection(url)).toThrow();
 vi.stubEnv("NODE_ENV","production");expect(()=>guardCaptureArchiveConnection(source)).toThrow();
});
it.each(["marker","guards","customer","identity"])("denies %s mismatch before any historical insert",async(cause)=>{
 environment();const statements:string[]=[];
 const sourcePool={query:vi.fn().mockResolvedValue({rows:[{name:"pdaa_test_100"}]})};
 const targetPool={query:vi.fn(async(sql:string)=>{statements.push(sql);
  if(sql.includes("current_database()"))return{rows:[{name:cause==="identity"?"pdaa_test_999":"pdaa_test_200",marker:cause==="marker"?"pdaa.foundation.v1:"+customerId:"pdaa.capture.archive.build:"+nonce}]};
  if(sql.includes("pg_trigger"))return{rows:[{n:cause==="guards"?1:0}]};
  if(sql.includes('FROM public."Customer"'))return{rows:[{n:cause==="customer"?1:0}]};
  throw new Error("Unexpected fixture mutation");
 })};
 await expect(constructCaptureArchive(sourcePool,targetPool,{customerId,projectId:"30000000-0000-4000-8000-000000000001"},nonce,source,target)).rejects.toThrow();
 expect(statements.every(sql=>sql.startsWith("SELECT"))).toBe(true);
});
it("rejects the source database as its own historical construction target",async()=>{
 environment();const query=vi.fn(async(sql:string)=>({rows:[{name:"pdaa_test_200",marker:"pdaa.capture.archive.build:"+nonce}]}));
 await expect(constructCaptureArchive({query},{query},{customerId,projectId:"30000000-0000-4000-8000-000000000001"},nonce,target,target)).rejects.toThrow();
 expect(query.mock.calls.every(([sql])=>sql.startsWith("SELECT"))).toBe(true);
});
