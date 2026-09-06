import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createDatabase } from "../packages/data/dist/index.js";
import { assertSyntheticDatabaseUrl } from "../packages/platform/dist/index.js";
const source = assertSyntheticDatabaseUrl(
  process.env.PDAA_DATABASE_URL ?? "",
  "pdaa",
);
if (
  process.env.NODE_ENV === "production" ||
  process.env.DATA_MODE !== "synthetic" ||
  !["127.0.0.1", "localhost"].includes(source.hostname) ||
  source.pathname !== "/pdaa"
)
  throw new Error(
    "Database rehearsal requires local synthetic pdaa configuration",
  );
const admin = createDatabase(source.toString());
const databaseName = "pdaa_test_" + Date.now();
await admin.$executeRawUnsafe('CREATE DATABASE "' + databaseName + '"');
await admin.$disconnect();
source.pathname = "/" + databaseName;
const env = { ...process.env, PDAA_DATABASE_URL: source.toString() };
function node(args, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error("Database validation command failed");
}
node(
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  process.cwd() + "/packages/data",
);
node(
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  process.cwd() + "/packages/data",
);
node(["packages/data/dist/seed.js"]);
node([
  "node_modules/vitest/vitest.mjs",
  "run",
  "tests/database.integration.test.ts",
]);
console.log(
  "Isolated database migration, repeat deployment, seed and integration checks passed.",
);
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/database-validation.json",
  JSON.stringify(
    { databaseName, completedAt: new Date().toISOString() },
    null,
    2,
  ),
);
