import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { assertSyntheticDatabaseUrl } from "../packages/platform/dist/index.js";
const local = parseEnv(readFileSync(".env", "utf8"));
assertSyntheticDatabaseUrl(local.PDAA_DATABASE_URL ?? "", "pdaa");
if (local.NODE_ENV !== "development" || local.DATA_MODE !== "synthetic")
  throw new Error(
    "Local command requires an explicit synthetic loopback pdaa database",
  );
const child = spawn(process.execPath, process.argv.slice(2), {
  env: { ...process.env, ...local },
  stdio: "inherit",
});
child.on("error", () => {
  console.error("Local process could not start");
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
