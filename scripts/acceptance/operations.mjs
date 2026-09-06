// TR-DEP-001/004, NFR-AVL-002: isolated fixtures only, never a customer command.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Pool, config, migrate, guard } from "./common.mjs";
import {
  readMigrations,
  migrateDatabase,
  history,
} from "../../packages/operations/dist/migrations.js";
import { assertEmptyTarget } from "../../packages/operations/dist/config.js";
import { createDatabase } from "../../packages/data/dist/index.js";
import {
  CredentialVault,
  loadConfig,
} from "../../packages/platform/dist/index.js";
guard();
const adminConfig = config(
  "database",
  "fixture_admin",
  "admin-password",
).database;
const admin = new Pool(adminConfig);
const migrations = readMigrations("/workspace/packages/data/prisma/migrations");
const output = process.env.PDAA_ARTIFACT_DIR;
const target = (database) => ({ ...adminConfig, database });
async function inDatabase(name, fn) {
  const pool = new Pool(target(name));
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
const projection = async (pool) => {
  const result = {};
  for (const table of [
    "Customer",
    "Portfolio",
    "Project",
    "AccessGrant",
    "ConnectorCredential",
    "AuditEvent",
    "_prisma_migrations",
  ])
    result[table] = (
      await pool.query(`SELECT * FROM "${table}" ORDER BY 1`)
    ).rows;
  result.graphileVersion = (
    await pool.query("SELECT max(id) AS n FROM graphile_worker.migrations")
  ).rows[0].n;
  result.queuedJob = (
    await pool.query(
      "SELECT j.id,j.task_identifier,p.payload,j.queue_name,j.run_at,j.attempts,j.key FROM graphile_worker.jobs j JOIN graphile_worker._private_jobs p ON p.id=j.id WHERE j.key='restore-fixture'",
    )
  ).rows;
  return result;
};
try {
  const mode = process.argv[2];
  if (mode === "prepare") {
    // Every name is fixed inside the generated, run-owned cluster.
    for (const name of [
      "restore_target",
      "restore_nonempty",
      "restore_large",
      "restore_connected",
      "restore_wrong",
      "migration_prisma",
      "migration_ops",
      "migration_failure",
    ])
      await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
    await inDatabase("restore_nonempty", async (pool) => {
      await pool.query(
        "CREATE FUNCTION public.keep_me() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      );
      await assert.rejects(() => assertEmptyTarget(pool));
    });
    await inDatabase("restore_large", async (pool) => {
      await pool.query("SELECT lo_create(0)");
      await assert.rejects(() => assertEmptyTarget(pool));
    });
    // Both adapters use one history; a release migration must never be replayed.
    assert(
      migrate("database", {
        PDAA_DB_NAME: "migration_prisma",
        PDAA_DB_USER: "fixture_admin",
        PDAA_DB_PASSWORD_FILE: "/run/secrets/admin-password",
      }),
    );
    assert.equal(
      (await migrateDatabase(target("migration_prisma"), migrations)).length,
      migrations.length,
    );
    const concurrent = await Promise.all([
      migrateDatabase(target("migration_ops"), migrations),
      migrateDatabase(target("migration_ops"), migrations),
    ]);
    assert(concurrent.every((result) => result.length === migrations.length));
    assert(
      migrate("database", {
        PDAA_DB_NAME: "migration_ops",
        PDAA_DB_USER: "fixture_admin",
        PDAA_DB_PASSWORD_FILE: "/run/secrets/admin-password",
      }),
    );
    await inDatabase("migration_ops", async (pool) => {
      const initial = await history(pool);
      for (const change of [
        "checksum='bad'",
        "finished_at=NULL",
        "migration_name='unknown'",
        "rolled_back_at=now()",
        "applied_steps_count=0",
      ]) {
        await pool.query(`UPDATE _prisma_migrations SET ${change}`);
        await assert.rejects(() =>
          migrateDatabase(target("migration_ops"), migrations),
        );
        await pool.query(
          "UPDATE _prisma_migrations SET checksum=$1,finished_at=$2,migration_name=$3,rolled_back_at=NULL,applied_steps_count=1",
          [
            initial[0].checksum,
            initial[0].finished_at,
            initial[0].migration_name,
          ],
        );
      }
    });
    const sql =
      "CREATE TABLE atomic_probe(id int); SELECT definitely_missing_function();";
    const failing = {
      name: "202609060002_failure",
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
    await assert.rejects(() =>
      migrateDatabase(target("migration_failure"), [...migrations, failing]),
    );
    await inDatabase("migration_failure", async (pool) => {
      assert.equal(
        (await pool.query("SELECT to_regclass('atomic_probe') AS name")).rows[0]
          .name,
        null,
      );
      assert.equal((await history(pool)).length, migrations.length);
    });
    // Seed an encrypted credential and immutable audit row via the approved owner.
    const db = createDatabase(adminConfig);
    try {
      const cipher = new CredentialVault(
        loadConfig(process.env).ENCRYPTION_KEY,
      );
      await db.connectorCredential.create({
        data: {
          id: "50000000-0000-4000-8000-000000000001",
          customerId: process.env.CUSTOMER_ID,
          name: "Restore fixture",
          keyId: "primary",
          envelope: cipher.encrypt(
            "synthetic-restore-credential",
            "restore-fixture",
          ),
        },
      });
    } finally {
      await db.$disconnect();
    }
    await admin.query(
      "SELECT graphile_worker.add_job('foundation_heartbeat', '{\"fixture\":\"retained\"}'::json, queue_name := 'restore-fixture', run_at := '2100-01-01'::timestamptz, job_key := 'restore-fixture')",
    );
    writeFileSync(
      output + "/restore-source.json",
      JSON.stringify(await projection(admin)),
    );
    console.log(
      "PASS: release migrations interoperate, serialize and roll back atomically; drift is denied",
    );
  } else if (mode === "hold") {
    const pool = new Pool({
      ...config("database", "pdaa_api", "api-password").database,
      database: "restore_connected",
    });
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      writeFileSync(output + "/restore-connected.json", "ready");
      await new Promise((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      });
    } finally {
      client.release();
      await pool.end();
    }
  } else if (mode === "held-ready") {
    const deadline = Date.now() + 15000;
    while (!existsSync(output + "/restore-connected.json")) {
      assert(Date.now() < deadline, "Restore fixture client did not connect");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } else if (mode === "corrupt") {
    const names = readdirSync("/backups").filter((name) =>
      /^backup-.*\.pdaa$/.test(name),
    );
    assert.equal(names.length, 1);
    const bytes = readFileSync("/backups/" + names[0]);
    bytes[bytes.length - 20] ^= 1;
    writeFileSync("/backups/backup-corrupt.pdaa", bytes);
  } else if (mode === "verify") {
    const expected = JSON.parse(
      readFileSync(output + "/restore-source.json", "utf8"),
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(await projection(admin))),
      expected,
      "Backup and restore must preserve source rows",
    );
    await inDatabase("restore_target", async (pool) => {
      assert.deepEqual(
        JSON.parse(JSON.stringify(await projection(pool))),
        expected,
      );
      assert.equal(expected.queuedJob.length, 1);
      assert.equal(expected.queuedJob[0].queue_name, "restore-fixture");
      const sequenceName = (
        await pool.query(
          "SELECT pg_get_serial_sequence('graphile_worker._private_jobs','id') AS name",
        )
      ).rows[0].name;
      assert(/^graphile_worker\.[a-z_]+$/.test(sequenceName));
      const sequence = (
        await pool.query(`SELECT last_value FROM ${sequenceName}`)
      ).rows[0];
      assert(BigInt(sequence.last_value) >= BigInt(expected.queuedJob[0].id));
      for (const role of ["pdaa_api", "pdaa_worker"])
        assert.equal(
          (
            await pool.query(
              "SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",
              [role],
            )
          ).rows[0].allowed,
          false,
        );
      assert.equal(
        (
          await pool.query(
            "SELECT pg_get_userbyid(typowner) AS owner FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='graphile_worker' AND t.typname='job_spec'",
          )
        ).rows[0].owner,
        "pdaa_worker",
      );
      await assert.rejects(() =>
        pool.query("UPDATE \"AuditEvent\" SET event='tamper'"),
      );
      const row = (
        await pool.query('SELECT "envelope" FROM "ConnectorCredential"')
      ).rows[0];
      const cipher = new CredentialVault(
        loadConfig(process.env).ENCRYPTION_KEY,
      );
      assert.equal(
        cipher.decrypt(row.envelope, "restore-fixture"),
        "synthetic-restore-credential",
      );
    });
    for (const [role, file] of [
      ["pdaa_api", "api-password"],
      ["pdaa_worker", "worker-password"],
    ]) {
      const pool = new Pool({
        ...config("database", role, file).database,
        database: "restore_target",
      });
      try {
        await assert.rejects(() => pool.query("SELECT 1"));
      } finally {
        await pool.end();
      }
    }
    await inDatabase("restore_wrong", (pool) => assertEmptyTarget(pool));
    await inDatabase("restore_nonempty", async (pool) =>
      assert.equal(
        (await pool.query("SELECT keep_me() AS value")).rows[0].value,
        1,
      ),
    );
    await inDatabase("restore_large", async (pool) =>
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM pg_largeobject_metadata",
            )
          ).rows[0].n,
        ),
        1,
      ),
    );
    await inDatabase("restore_connected", async (pool) => {
      await assertEmptyTarget(pool);
      assert.equal(
        (
          await pool.query(
            "SELECT has_database_privilege('pdaa_api',current_database(),'CONNECT') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
    });
    console.log(
      "PASS: authenticated whole-database restore preserves data, encryption, audit and ownership while runtime connections remain denied",
    );
  } else if (mode === "outage") {
    const started = Date.now();
    const response = await fetch("http://api:3001/api/health/ready", {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 503);
    assert(Date.now() - started < 5000);
    // Keep established connections blackholed beyond the worker's 10s query limit.
    await new Promise((resolve) => setTimeout(resolve, 12000));
    assert.equal(
      (
        await fetch("http://api:3001/api/health/ready", {
          signal: AbortSignal.timeout(5000),
        })
      ).status,
      503,
    );
    assert((await fetch("http://api:3001/api/health/live")).ok);
    assert((await fetch("https://gateway:8443/")).ok);
    console.log(
      "PASS: database blackhole produces bounded readiness failure while API and web remain live",
    );
  } else if (mode === "heartbeat") {
    const at = (
      await admin.query(
        'SELECT "occurredAt" FROM "ServiceHeartbeat" WHERE id=\'worker\'',
      )
    ).rows[0].occurredAt;
    writeFileSync(output + "/heartbeat-before.json", JSON.stringify(at));
  } else if (mode === "recovered") {
    const before = new Date(
      Math.max(
        Date.now(),
        new Date(
          JSON.parse(readFileSync(output + "/heartbeat-before.json", "utf8")),
        ).getTime(),
      ),
    );
    const deadline = Date.now() + 120000;
    for (;;) {
      let row;
      try {
        row = (
          await admin.query(
            'SELECT "occurredAt" FROM "ServiceHeartbeat" WHERE id=\'worker\'',
          )
        ).rows[0];
      } catch {
        /* The restarted database may still be accepting connections. */
      }
      if (
        row &&
        row.occurredAt > before &&
        (await fetch("http://api:3001/api/health/ready")).ok
      )
        break;
      assert(
        Date.now() < deadline,
        "Worker progress and API readiness must recover",
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(
      (await admin.query('SELECT count(*)::int AS n FROM "Project"')).rows[0].n,
      2,
    );
    console.log(
      "PASS: persisted data, API readiness and worker progress recover after database and worker restart",
    );
  } else throw new Error("Unknown fixture mode");
} finally {
  await admin.end();
}
