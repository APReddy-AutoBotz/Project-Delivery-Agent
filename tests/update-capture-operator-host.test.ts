// EXEC-015 / NFR-SEC-005: host proof ordering and output contracts, not Docker evidence.
import {afterEach,expect,it} from "vitest";
import {existsSync,mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {verifyCaptureOperatorOverlay} from "../scripts/acceptance/update-capture-operator-host.mjs";
const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0)){if(!resolve(directory).startsWith(resolve(tmpdir())+"\\") && !resolve(directory).startsWith(resolve(tmpdir())+"/"))throw new Error("Unsafe fixture cleanup");rmSync(directory,{recursive:true});}});
function fixture(shadow="true") {
 const directory=mkdtempSync(join(tmpdir(),"pdaa-capture-overlay-test-"));directories.push(directory,directory+"-capture-overlay");
 const epoch="10000000-0000-4000-8000-000000000001",customerId="20000000-0000-4000-8000-000000000001";
 const gate={enabled:false,epoch,revision:2};
 writeFileSync(join(directory,"capture-history-operator.json"),JSON.stringify({customerId,gate,configuration:{customerId,mode:"CAPTURE",issuanceEpoch:epoch,
  invitationLifetimeSeconds:900,contentRetentionSeconds:86400,responseReviewerSubjects:[]}}));
 writeFileSync(join(directory,"capture-history-operator-receipt.json"),JSON.stringify({explicitPackagedEnable:true,runtimeConnectStillQuarantined:true,invitationMetadataUnchanged:true,oldEpochInvitationDenied:true}));
 const env:Record<string,string>={SHADOW_MODE:"false",PDAA_UPDATE_CAPTURE_FILE:"previous-file"};
 const calls:string[]=[];let statusCount=0;
 const enabled={enabled:true,epoch,revision:3},disabled={enabled:false,epoch:"30000000-0000-4000-8000-000000000001",revision:4};
 const docker=(args:string[])=>{
  const command=args.at(-1)!;calls.push(command);
  if(args.includes("--format")){expect(args).toContain("--profile");expect(args[args.indexOf("--profile")+1]).toBe("operations");return JSON.stringify({services:Object.fromEntries(["api","operations"].map(service=>[service,{environment:{SHADOW_MODE:shadow,PROJECT_UPDATE_CAPTURE_FILE:"/run/secrets/project-update-capture"},secrets:[{source:"project-update-capture"}]}]))});}
  if(command==="update-issuance-status")return JSON.stringify({operation:command,result:++statusCount===1?gate:statusCount===2?enabled:disabled});
  if(command==="enable-update-issuance")return JSON.stringify({operation:command,result:enabled});
  if(command==="disable-update-issuance")return JSON.stringify({operation:command,result:disabled});
  if(args.includes("--entrypoint"))return JSON.stringify({captureConfigurationLoaded:true,shadowMode:true,networkStarted:false});
  return "";
 };
 const compose=(...args:string[])=>["compose","-f","deploy/acceptance/compose.yaml","-p","owned-run",...args];
 const denied=(args:string[],name:string)=>{calls.push(name);expect(args).toContain("deploy/customer/update-capture.yaml");};
 return {directory,run:()=>verifyCaptureOperatorOverlay({docker,compose,denied,output:directory,fixture:directory,env}),calls,env};
}
it("requires quarantine denial before fixture promotion and ends with packaged disable",()=>{
 const f=fixture();const receipt=f.run();expect(receipt.explicitPackagedEnable).toBe(true);expect(receipt.explicitPackagedDisable).toBe(true);
 expect(receipt.apiNetworkStarted).toBe(false);
 expect(existsSync(join(f.directory,"project-update-capture"))).toBe(false);
 expect(existsSync(join(f.directory+"-capture-overlay","project-update-capture"))).toBe(true);expect(f.calls.indexOf("capture-overlay-quarantine-denied")).toBeLessThan(f.calls.indexOf("operator-promote"));
 expect(f.calls.indexOf("disable-update-issuance")).toBeLessThan(f.calls.indexOf("capture-overlay-stale-disable-denied"));
 expect(f.env).toEqual({SHADOW_MODE:"false",PDAA_UPDATE_CAPTURE_FILE:"previous-file"});
});
it("rejects a composition that enables live capture and restores host environment",()=>{
 const f=fixture("false");expect(()=>f.run()).toThrow();expect(f.calls).not.toContain("enable-update-issuance");
 expect(f.env).toEqual({SHADOW_MODE:"false",PDAA_UPDATE_CAPTURE_FILE:"previous-file"});
});
