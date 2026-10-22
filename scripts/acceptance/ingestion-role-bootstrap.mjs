// EXEC-019 / NFR-REL-001, NFR-SEC-001: dedicated fresh synthetic cluster only.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readMigrations, migrateDatabase } from "../../packages/operations/dist/index.js";
import { applyBusinessTableGrants } from "../../packages/operations/dist/business-grants.js";
import { assertBusinessTableInventory } from "./upgrade-inventory-receipt.mjs";
import { verifyReassessmentPrivileges } from "./ingestion-reassessment.mjs";
const { Pool } = createRequire(new URL("../../packages/data/package.json", import.meta.url))("pg");
const roles = ["pdaa_api", "pdaa_worker", "pdaa_backup", "pdaa_migrate"];
const functions = ['valid_ingestion_reassessment_row(public."IngestionProjectReassessment")',
  "valid_ingestion_project_reassessment(uuid)", "guard_ingestion_project_reassessment()",
  "require_ingestion_reassessment_complete()", "lock_ingestion_reassessment_preview()",
  "reject_ingestion_reassessment_history()", "valid_ingestion_mapping(jsonb)"];
const apiFunctions = new Set([functions[0], functions[1], functions[6]]);
const controls = new Set(["state", "attemptCount", "totalAttempts", "recoveryRevision", "availableAt", "lastReason",
  "claimedGeneration", "assessmentId", "obligationId", "previewId", "completedAt", "auditEventId"]);
async function currentRoles(pool) {
  return (await pool.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname", [roles])).rows.map((row) => row.rolname);
}
async function privateBoundary(pool, presentRoles) {
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pg_proc p
    WHERE p.oid=ANY(SELECT to_regprocedure(name) FROM unnest($1::text[]) AS entries(name))
      AND (p.prosecdef OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE'))`, [functions.map((name) => "public." + name)])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pg_class c,
    LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='public."IngestionProjectReassessment"'::regclass AND a.grantee=0`)).rows[0].n, 0);
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='IngestionProjectReassessment'")).rows;
  for (const role of presentRoles) {
    for (const name of functions)
      assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, "public." + name])).rows[0].allowed,
        role === "pdaa_api" && apiFunctions.has(name), role + "/" + name);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"])
      assert.equal((await pool.query("SELECT has_table_privilege($1,'public.\"IngestionProjectReassessment\"',$2) AS allowed", [role, privilege])).rows[0].allowed,
        role === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege) || role === "pdaa_backup" && privilege === "SELECT", role + "/" + privilege);
    for (const { column_name } of columns)
      assert.equal((await pool.query("SELECT has_column_privilege($1,'public.\"IngestionProjectReassessment\"',$2,'UPDATE') AS allowed", [role, column_name])).rows[0].allowed,
        role === "pdaa_api" && controls.has(column_name), role + "/UPDATE/" + column_name);
  }
}
async function inventory(pool, migrations) {
  const names = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map((row) => row.tablename);
  assertBusinessTableInventory(names.filter((name) => name !== "_prisma_migrations"));
  const ledger = (await pool.query('SELECT migration_name,checksum FROM public."_prisma_migrations" ORDER BY migration_name')).rows;
  assert.deepEqual(ledger, migrations.map((migration) => ({ migration_name: migration.name, checksum: migration.checksum })));
  return { names, ledger };
}
export async function verifyIngestionRoleBootstrap(sourceUrl) {
  assert.equal(process.env.DATA_MODE, "synthetic"); assert.notEqual(process.env.NODE_ENV, "production");
  const url = new URL(sourceUrl);
  assert(["127.0.0.1", "localhost"].includes(url.hostname)); assert.equal(url.pathname, "/postgres");
  const creator = new Pool({ connectionString: url.toString() });
  const migrations = readMigrations("packages/data/prisma/migrations"); assert.equal(migrations.length, 25);
  try {
    assert.deepEqual((await creator.query("SELECT datname FROM pg_database ORDER BY datname")).rows.map((row) => row.datname), ["postgres", "template0", "template1"]);
    assert.deepEqual(await currentRoles(creator), []);
    const first = "pdaa_test_" + Date.now(), second = "pdaa_test_" + (Date.now() + 1);
    assert.notEqual(first, second);
    const run = async (name, presentRoles) => {
      assert.match(name, /^pdaa_test_\d+$/);
      await creator.query('CREATE DATABASE "' + name + '"');
      const target = new URL(url); target.pathname = "/" + name;
      const config = { host: target.hostname, port: Number(target.port), database: name,
        user: decodeURIComponent(target.username), password: decodeURIComponent(target.password), ssl: false };
      await migrateDatabase(config, migrations);
      const pool = new Pool({ connectionString: target.toString() });
      try {
        assert.deepEqual(await currentRoles(pool), presentRoles);
        const before = await inventory(pool, migrations);
        await privateBoundary(pool, presentRoles);
        await migrateDatabase(config, migrations);
        assert.deepEqual(await inventory(pool, migrations), before);
        assert.deepEqual(await currentRoles(pool), presentRoles);
        return { name, url: target.toString() };
      } finally { await pool.end(); }
    };
    const absent = await run(first, []);
    await creator.query("CREATE ROLE pdaa_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION");
    const partial = await run(second, ["pdaa_api"]);
    for (const role of ["pdaa_worker", "pdaa_backup", "pdaa_migrate"])
      await creator.query('CREATE ROLE "' + role + '" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
    for (const target of [absent, partial]) {
      const pool = new Pool({ connectionString: target.url });
      try {
        await pool.query(`DO $owners$ DECLARE item record; BEGIN
          FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
          LOOP EXECUTE format('ALTER TABLE %I.%I OWNER TO pdaa_migrate','public',item.relname); END LOOP;
        END $owners$`);
        for (const name of functions) await pool.query("ALTER FUNCTION public." + name + " OWNER TO pdaa_migrate");
        await applyBusinessTableGrants(pool);
        await verifyReassessmentPrivileges(pool);
        await privateBoundary(pool, roles.slice(0, 3));
        await inventory(pool, migrations);
      } finally { await pool.end(); }
    }
    return { rolesAbsentBeforeAnyBootstrap: true, rolelessDatabase: first, partialRoleDatabase: second,
      partialRoles: ["pdaa_api"], cleanAndRepeatPassed: true, migrationCount: 25, businessTables: 85,
      publicPrivilegesDenied: true, finiteAclAfterLaterBootstrap: true, retainedDatabases: true };
  } finally { await creator.end(); }
}
