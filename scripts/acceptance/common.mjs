import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { assertSyntheticDatabaseUrl, loadDatabaseConfig } from "../../packages/platform/dist/index.js";
export const { Pool } = createRequire(
  new URL("../../packages/data/package.json", import.meta.url),
)("pg");

export async function alignSyntheticFixtureOwnership(connection) {
  const target = assertSyntheticDatabaseUrl(connection);
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATA_MODE !== "synthetic" ||
    !/^\/pdaa_test_[0-9]+$/.test(target.pathname)
  )
    throw new Error("Ownership alignment requires an isolated synthetic database");

  const pool = new Pool({ connectionString: target.href });
  try {
    const { rows: [database] } = await pool.query("SELECT current_database() AS name");
    if (database.name !== target.pathname.slice(1))
      throw new Error("Synthetic database target does not match");
    // Tests can share a cluster with the packaged migration role. Keep
    // definer functions and their tables under that same owner in this fixture.
    await pool.query(`DO $owners$ DECLARE item record; BEGIN
      IF to_regrole('pdaa_migrate') IS NULL THEN RETURN; END IF;
      FOR item IN
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND c.relowner=current_user::regrole
      LOOP
        EXECUTE format('ALTER TABLE %I.%I OWNER TO pdaa_migrate','public',item.relname);
      END LOOP;
      FOR item IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind='f' AND p.proowner=current_user::regrole
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'
          )
      LOOP
        EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO pdaa_migrate','public',item.proname,item.args);
      END LOOP;
    END $owners$`);
  } finally {
    await pool.end();
  }
}

export const secret = (name) => readFileSync(`/run/secrets/${name}`, "utf8");
export function guard() {
  if (
    process.env.PDAA_ACCEPTANCE !== "isolated" ||
    process.env.DATA_MODE !== "synthetic" ||
    process.env.DEPLOYMENT_MODE !== "customer" ||
    process.env.NODE_ENV !== "production" ||
    process.env.PDAA_DB_HOST !== "database" ||
    process.env.PDAA_DB_NAME !== "pdaa" ||
    secret("ready") !== "isolated synthetic acceptance\n"
  )
    throw new Error("Isolated acceptance fixture required");
}
export function config(
  host = "database",
  user = "pdaa_migrate",
  file = "migration-password",
) {
  if (!["database", "external-database", "database-alias"].includes(host))
    throw new Error("Unknown fixture target");
  return loadDatabaseConfig({
    ...process.env,
    PDAA_DB_HOST: host,
    PDAA_DB_USER: user,
    PDAA_DB_PASSWORD_FILE: `/run/secrets/${file}`,
  });
}
export function migrate(host, patch = {}) {
  const result = spawnSync(
    process.execPath,
    ["../../node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: "/workspace/packages/data",
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, PDAA_DB_HOST: host, ...patch },
    },
  );
  // Raw engine errors can contain infrastructure or credentials. Never return them.
  return result.status === 0;
}
