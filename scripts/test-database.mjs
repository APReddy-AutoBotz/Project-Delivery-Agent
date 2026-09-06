import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import assert from "node:assert/strict";
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
const evidencePath = "artifacts/database-validation.json";
if (existsSync(evidencePath)) unlinkSync(evidencePath);
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
  ["../../node_modules/prisma/build/index.js", "migrate", "deploy"],
  process.cwd() + "/packages/data",
);
// INT-DATA-001: explicit clean-schema and migration-ledger evidence.
const migrated = createDatabase(source.toString());
let ledger;
try {
  const tables =
    await migrated.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  for (const table of [
    "Customer",
    "Portfolio",
    "Project",
    "AccessGrant",
    "AuditEvent",
    "ConnectorCredential",
    "ServiceHeartbeat",
  ])
    assert(
      tables.some((row) => row.tablename === table),
      "Missing foundation table: " + table,
    );
  ledger =
    await migrated.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name`;
  const names = readdirSync("packages/data/prisma/migrations", {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    ledger.map((row) => row.migration_name),
    names,
  );
  assert(
    ledger.every(
      (row) =>
        /^[a-f0-9]{64}$/.test(row.checksum) &&
        row.finished_at &&
        !row.rolled_back_at &&
        row.applied_steps_count > 0,
    ),
    "Incomplete migration ledger",
  );
} finally {
  await migrated.$disconnect();
}
node(
  ["../../node_modules/prisma/build/index.js", "migrate", "deploy"],
  process.cwd() + "/packages/data",
);
const repeated = createDatabase(source.toString());
try {
  assert.deepEqual(
    await repeated.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name`,
    ledger,
    "Repeat migration changed the completed ledger",
  );
} finally {
  await repeated.$disconnect();
}
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
  evidencePath,
  JSON.stringify(
    {
      testId: "INT-DATA-001",
      databaseName,
      foundationTables: 7,
      migrations: ledger.map((row) => ({
        name: row.migration_name,
        checksum: row.checksum,
      })),
      repeatUnchanged: true,
      completedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
