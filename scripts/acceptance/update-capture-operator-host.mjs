// EXEC-015 / NFR-SEC-005 / NFR-REL-002: unchanged optional customer overlay.
import assert from "node:assert/strict";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {randomBytes} from "node:crypto";
import {join} from "node:path";
export function verifyCaptureOperatorOverlay({docker,compose,denied,output,fixture,env}) {
 const step=(mode)=>docker(compose("run","--rm","--no-deps","verify","node","scripts/acceptance/update-capture-archive-runner.mjs",mode),"capture-overlay-"+mode);
 step("operator-prepare");
 const operator=JSON.parse(readFileSync(join(output,"capture-history-operator.json"),"utf8"));
 const operatorFixture=fixture+"-capture-overlay";
 mkdirSync(operatorFixture,{mode:0o700});
 const capturePath=join(operatorFixture,"project-update-capture"),zonePath=join(operatorFixture,"capture-history-zones"),keysPath=join(operatorFixture,"capture-history-task-keys");
 // The base fixture is container-owned. Keep these host-generated secrets in
 // a separate private directory owned by the host, without changing its ACLs.
 writeFileSync(capturePath,JSON.stringify(operator.configuration),{mode:0o644});
 writeFileSync(zonePath,JSON.stringify({customerId:operator.customerId,customerTimeZone:"UTC",recipientTimeZones:[]}),{mode:0o644});
 writeFileSync(keysPath,JSON.stringify({currentKeyId:"capture-fixture",keys:{"capture-fixture":randomBytes(32).toString("base64url")}}),{mode:0o644});
 const fixtureOverlay=join(operatorFixture,"capture-overlay.yaml");
 writeFileSync(fixtureOverlay,JSON.stringify({services:{api:{environment:{PROJECT_UPDATE_ZONES_FILE:"/run/secrets/capture-history-zones",
  PROJECT_UPDATE_TASK_KEYS_FILE:"/run/secrets/capture-history-task-keys",CONNECTOR_TASK_KEYS_FILE:"/run/secrets/capture-history-task-keys",PROJECT_UPDATE_SERVICE_SUBJECT:"archive-service",INTERNAL_API_URL:"https://gateway:8443"},
  secrets:["capture-history-zones","capture-history-task-keys"]}},secrets:{"capture-history-zones":{file:zonePath},"capture-history-task-keys":{file:keysPath}}}));
 const previous=Object.fromEntries(["PDAA_UPDATE_CAPTURE_FILE","SHADOW_MODE","PDAA_UPDATE_ISSUANCE_EXPECTED_REVISION","PDAA_UPDATE_ISSUANCE_EXPECTED_EPOCH"].map(key=>[key,env[key]]));
 try {
  env.PDAA_UPDATE_CAPTURE_FILE=capturePath;delete env.SHADOW_MODE;
  env.PDAA_UPDATE_ISSUANCE_EXPECTED_REVISION=String(operator.gate.revision);env.PDAA_UPDATE_ISSUANCE_EXPECTED_EPOCH=operator.gate.epoch;
  const overlay=(...args)=>{const base=compose(...args);return [...base.slice(0,3),"-f","deploy/customer/update-capture.yaml","-f",fixtureOverlay,...base.slice(3)];};
  const configured=JSON.parse(docker(overlay("--profile","operations","config","--format","json"),"capture-overlay-composition","capture"));
  assert.equal(configured.services.api.environment.SHADOW_MODE,"true");
  for(const service of ["api","operations"]) {
   assert.equal(configured.services[service].environment.PROJECT_UPDATE_CAPTURE_FILE,"/run/secrets/project-update-capture");
   assert(configured.services[service].secrets.some(secret=>secret.source==="project-update-capture"));
  }
  const operation=(command)=>overlay("run","--rm","--no-deps","-e","PDAA_DB_NAME=capture_history_restore","-e","PDAA_OPS_TARGET=database:5432/capture_history_restore","operations",command);
  const result=(command,name)=>{const text=docker(operation(command),name,"capture");return JSON.parse(text.split("\n").find(line=>line.startsWith('{"operation"'))).result;};
  assert.deepEqual(result("update-issuance-status","capture-overlay-disabled-status"),operator.gate);
  denied(operation("enable-update-issuance"),"capture-overlay-quarantine-denied");
  // Fixture-only promotion, explicitly after proving restore quarantine. Runtime
  // CONNECT remains denied; neither API nor worker is started against this DB.
  step("operator-promote");
  assert.deepEqual(result("enable-update-issuance","capture-overlay-explicit-enable"),{enabled:true,epoch:operator.gate.epoch,revision:operator.gate.revision+1});
  assert.deepEqual(result("update-issuance-status","capture-overlay-enabled-status"),{enabled:true,epoch:operator.gate.epoch,revision:operator.gate.revision+1});
  step("operator-verify");
  const code='import assert from "node:assert/strict";import {loadConfig} from "@pdaa/platform";const c=loadConfig(process.env);assert.equal(c.SHADOW_MODE,"true");assert.equal(c.projectUpdateCapture.customerId,c.CUSTOMER_ID);assert.equal(c.projectUpdateCapture.mode,"CAPTURE");assert(c.projectUpdateZones && c.projectUpdateTaskKeys && c.projectUpdateServiceSubject);console.log(JSON.stringify({captureConfigurationLoaded:true,shadowMode:true,networkStarted:false}));';
  const api=JSON.parse(docker(overlay("run","--rm","--no-deps","--entrypoint","node","api","--input-type=module","-e",code),"capture-overlay-api-configuration","capture"));
  assert.deepEqual(api,{captureConfigurationLoaded:true,shadowMode:true,networkStarted:false});
  env.PDAA_UPDATE_ISSUANCE_EXPECTED_REVISION=String(operator.gate.revision+1);
  const disabled=result("disable-update-issuance","capture-overlay-explicit-disable");
  assert.equal(disabled.enabled,false);assert.equal(disabled.revision,operator.gate.revision+2);assert.notEqual(disabled.epoch,operator.gate.epoch);
  denied(operation("disable-update-issuance"),"capture-overlay-stale-disable-denied");
  assert.deepEqual(result("update-issuance-status","capture-overlay-final-disabled-status"),disabled);
  const receipt=JSON.parse(readFileSync(join(output,"capture-history-operator-receipt.json"),"utf8"));
  for(const value of Object.values(receipt))assert.equal(value,true);
  return {...receipt,shippedOverlayMounted:true,explicitPackagedDisable:true,stalePackagedChangeDenied:true,defaultShadowMode:true,packagedApiConfigurationLoaded:true,apiNetworkStarted:false};
 } finally {for(const [key,value] of Object.entries(previous)){if(value===undefined)delete env[key];else env[key]=value;}}
}
