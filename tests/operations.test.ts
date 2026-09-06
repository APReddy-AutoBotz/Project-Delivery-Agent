import { it, expect, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import {
  readMigrations,
  validateHistory,
  migrateDatabase,
} from "../packages/operations/src/migrations.js";
import { loadOperationsConfig } from "../packages/operations/src/config.js";
import { pgEnvironment } from "../packages/operations/src/backup.js";
import {
  archivePath,
  sealArchive,
  openArchive,
  type BackupMetadata,
} from "../packages/operations/src/archive.js";

const temporaryRoot = resolve("tmp");
mkdirSync(temporaryRoot, { recursive: true });
const fixture = mkdtempSync(join(temporaryRoot, "operations-unit-"));
afterAll(() => {
  if (
    !resolve(fixture).startsWith(
      temporaryRoot + (process.platform === "win32" ? "\\" : "/"),
    )
  )
    throw new Error("Fixture containment failed");
  rmSync(fixture, { recursive: true, force: true });
});
const migrations = readMigrations(resolve("packages/data/prisma/migrations"));
const metadata: BackupMetadata = {
  format: "pdaa-backup-v1",
  customerId: "10000000-0000-4000-8000-000000000001",
  source: { host: "database", port: 5432, database: "pdaa" },
  postgresVersion: 170011,
  createdAt: "2026-09-06T00:00:00.000Z",
  graphileVersion: 19,
  migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
};
it("DEP-001: preserves complete SQL and rejects divergent or incomplete migration history", async () => {
  expect(migrations[0]!.sql).toContain(
    "CREATE FUNCTION reject_audit_mutation()",
  );
  expect(migrations[0]!.checksum).toBe(
    "9738bed726d754be02fb157ce2ee787def280d5e6e4c5319d778080d8b040aca",
  );
  const valid = {
    migration_name: migrations[0]!.name,
    checksum: migrations[0]!.checksum,
    finished_at: new Date(),
    rolled_back_at: null,
    applied_steps_count: 1,
  };
  expect(() => validateHistory([valid], migrations)).not.toThrow();
  for (const patch of [
    { checksum: "bad" },
    { finished_at: null },
    { rolled_back_at: new Date() },
    { migration_name: "unknown" },
    { applied_steps_count: 0 },
  ])
    expect(() =>
      validateHistory([{ ...valid, ...patch }], migrations),
    ).toThrow();
  expect(() => validateHistory([valid, valid], migrations)).toThrow();
  const dir = join(fixture, "migrations");
  const migrationDir = join(dir, "202609060002_failure");
  mkdirSync(migrationDir, { recursive: true });
  for (const sql of [
    "BEGIN; CREATE TABLE test(id int); COMMIT;",
    "CREATE INDEX CONCURRENTLY test ON thing(id);",
    "CREATE DATABASE other;",
    "CREATE TABLE x(id int); ABORT; CREATE TABLE escaped(id int);",
    "PREPARE TRANSACTION 'bad';",
    "-- $$\nABORT;\n-- $$\nCREATE TABLE escaped(id int);",
    "/* outer /* nested */ $$ */ ABORT; /* $$ */",
    "CREATE TABLE foo$tag$ (id integer); ABORT; -- $tag$\nCREATE TABLE escaped(id int);",
    "CREATE TABLE café$tag$ (id integer); ABORT; -- $tag$\nCREATE TABLE escaped(id int);",
    "-- comment\rABORT;\rCREATE TABLE escaped(id int);",
    "SELECT E'a'\n'\\''; ABORT; -- '\nCREATE TABLE escaped(id int);",
  ]) {
    writeFileSync(join(migrationDir, "migration.sql"), sql);
    expect(() => readMigrations(dir)).toThrow();
    await expect(
      migrateDatabase(
        {
          host: "unused.invalid",
          port: 5432,
          user: "unused",
          password: "unused",
          database: "unused",
          ssl: false,
        },
        [
          {
            name: "202609060002_invalid",
            sql,
            checksum: createHash("sha256").update(sql).digest("hex"),
          },
        ],
      ),
    ).rejects.toThrow(
      "Migration needs a separately reviewed execution strategy",
    );
  }
});
it("DEP-001: encrypts archives, authenticates metadata and rejects corruption before plaintext is retained", async () => {
  const key = randomBytes(32);
  const destination = archivePath(fixture, "backup-encryption.pdaa");
  const payload = Buffer.from(
    "Synthetic audit, grant and encrypted-credential dump".repeat(5000),
  );
  await sealArchive(Readable.from(payload), destination, key, metadata);
  expect(readFileSync(destination).includes(payload.subarray(0, 50))).toBe(
    false,
  );
  const plaintext = join(fixture, "restored.dump");
  expect(await openArchive(destination, plaintext, key)).toEqual(metadata);
  expect(readFileSync(plaintext)).toEqual(payload);
  const wrong = join(fixture, "wrong.dump");
  await expect(
    openArchive(destination, wrong, randomBytes(32)),
  ).rejects.toThrow(/authentication/);
  expect(existsSync(wrong)).toBe(false);
  const bytes = readFileSync(destination);
  bytes[bytes.length - 20]! ^= 1;
  writeFileSync(join(fixture, "backup-corrupt.pdaa"), bytes);
  await expect(
    openArchive(join(fixture, "backup-corrupt.pdaa"), wrong, key),
  ).rejects.toThrow(/authentication/);
  expect(existsSync(wrong)).toBe(false);
  bytes[20]! ^= 1;
  writeFileSync(join(fixture, "backup-header.pdaa"), bytes);
  await expect(
    openArchive(join(fixture, "backup-header.pdaa"), wrong, key),
  ).rejects.toThrow();
});
it("DEP-001: failed producers publish no backup and collisions cannot replace existing output", async () => {
  const key = randomBytes(32);
  const destination = archivePath(fixture, "backup-failed.pdaa");
  await expect(
    sealArchive(
      Readable.from("fixture"),
      destination,
      key,
      metadata,
      Promise.reject(new Error("dump failed")),
    ),
  ).rejects.toThrow();
  expect(existsSync(destination)).toBe(false);
  const collision = archivePath(fixture, "backup-collision.pdaa");
  writeFileSync(collision, "existing");
  await expect(
    sealArchive(Readable.from("fixture"), collision, key, metadata),
  ).rejects.toThrow();
  expect(readFileSync(collision, "utf8")).toBe("existing");
  expect(readdirSync(fixture).some((name) => name.endsWith(".partial"))).toBe(
    false,
  );
  for (const name of [
    "../other",
    "backup-../../secret.pdaa",
    "C:\\secret.pdaa",
    "backup-evil/part.pdaa",
  ])
    expect(() => archivePath(fixture, name)).toThrow();
});
it("DEP-001: confirms target and strips libpq overrides while preserving escaped credentials", () => {
  const password = join(fixture, "db-password");
  writeFileSync(password, "synthetic:pass\\word");
  const env = {
    NODE_ENV: "production",
    DEPLOYMENT_MODE: "customer",
    DATA_MODE: "synthetic",
    CUSTOMER_ID: metadata.customerId,
    CUSTOMER_NAME: "Synthetic",
    PDAA_DB_HOST: "database",
    PDAA_DB_NAME: "pdaa",
    PDAA_DB_USER: "pdaa_backup",
    PDAA_DB_PASSWORD_FILE: password,
    PDAA_OPS_TARGET: "database:5432/pdaa",
  };
  const config = loadOperationsConfig(env);
  expect(() =>
    loadOperationsConfig({ ...env, PDAA_OPS_TARGET: "different:5432/pdaa" }),
  ).toThrow();
  expect(() =>
    loadOperationsConfig({ ...env, PDAA_DB_NAME: "x;DROP" }),
  ).toThrow();
  expect(() =>
    loadOperationsConfig({ ...env, NODE_ENV: "development" }),
  ).toThrow();
  const priorService = process.env.PGSERVICE,
    priorMode = process.env.PGSSLMODE;
  process.env.PGSERVICE = "wrong-service";
  process.env.PGSSLMODE = "disable";
  try {
    const childEnv = pgEnvironment(config, fixture);
    expect(childEnv.PGSSLMODE).toBe("verify-full");
    expect(childEnv).not.toHaveProperty("PGSERVICE");
    expect(childEnv).not.toHaveProperty("PGPASSWORD");
    expect(readFileSync(childEnv.PGPASSFILE, "utf8")).toContain(
      "synthetic\\:pass\\\\word",
    );
  } finally {
    if (priorService === undefined) delete process.env.PGSERVICE;
    else process.env.PGSERVICE = priorService;
    if (priorMode === undefined) delete process.env.PGSSLMODE;
    else process.env.PGSSLMODE = priorMode;
  }
});
it("NFR-AVL-001: fatal rejection and exception exit without reflecting database or secret details", () => {
  const module = new URL("../packages/platform/dist/index.js", import.meta.url)
    .href;
  for (const failure of [
    "Promise.reject(new Error('synthetic-secret-token'))",
    "setTimeout(() => { throw new Error('synthetic-secret-token') }, 0)",
  ]) {
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { installFatalHandlers } from ${JSON.stringify(module)}; installFatalHandlers('worker'); ${failure}`,
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('"event":"worker.fatal"');
    expect(run.stdout + run.stderr).not.toContain("synthetic-secret-token");
    expect(run.stderr).toBe("");
  }
});
