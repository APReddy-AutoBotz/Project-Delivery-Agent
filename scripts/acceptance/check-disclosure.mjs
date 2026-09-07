import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDisclosureCheck, readFixtureSecrets } from "./disclosure.mjs";

// Only an already-generated, isolated acceptance fixture may invoke this checker.
const runId = process.env.PDAA_ACCEPTANCE_RUN_ID;
const profile = process.env.PDAA_CUSTOMER_PROFILE;
const customer = process.env.PDAA_ACCEPTANCE === "customer-composition";
const suffix =
  customer && ["bundled", "external"].includes(profile)
    ? "/customer-" + profile
    : "";
const directory = `/workspace/artifacts/${runId}${suffix}`;
const name = process.argv[2];
if (
  !/^pdaa-acceptance-\d+-[a-f0-9]{8}$/.test(runId ?? "") ||
  !(customer ? suffix : process.env.PDAA_ACCEPTANCE === "isolated") ||
  process.env.PDAA_ARTIFACT_DIR !== directory ||
  process.env.NODE_ENV !== "production" ||
  process.env.DEPLOYMENT_MODE !== "customer" ||
  !/^disclosure-host-[1-9][0-9]*$/.test(name ?? "") ||
  readFileSync("/run/secrets/ready", "utf8") !==
    "isolated synthetic acceptance\n"
)
  throw new Error("Isolated disclosure fixture required");

try {
  const input = JSON.parse(
    readFileSync(join(directory, name + ".input.json"), "utf8"),
  );
  const disclosure = createDisclosureCheck(readFixtureSecrets("/run/secrets"));
  if (
    !Array.isArray(input.captures) ||
    !Array.isArray(input.required) ||
    input.required.length === 0
  )
    throw new Error();
  for (const { channel, text } of input.captures) disclosure.add(channel, text);
  const channels = disclosure.verify(input.required);
  writeFileSync(
    join(directory, name + ".receipt.json"),
    JSON.stringify({
      status: "passed",
      runId,
      profile: customer ? profile : "production",
      phase: name,
      channels,
    }),
  );
  console.log("PASS: private host disclosure captures verified");
} catch {
  // Do not let parser errors or assertions reproduce private capture contents.
  throw new Error("Host disclosure verification failed");
}
