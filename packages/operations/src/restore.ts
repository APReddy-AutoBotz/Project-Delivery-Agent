import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  connect,
  assertPostgres17,
  assertEmptyTarget,
  assertNoOtherSessions,
  identifier,
  type OperationsConfig,
} from "./config.js";
import { assertCustomer, grants, verifyRoles } from "./provision.js";
import { history, validateHistory, type Migration } from "./migrations.js";
import { archivePath, openArchive, requireRestoreTmpfs } from "./archive.js";
import { postgresTool } from "./backup.js";

async function restoreOwners(client: Awaited<ReturnType<typeof connect>>) {
  // Extension objects retain extension ownership. All first-party objects receive
  // their reviewed owner; --no-owner must not collapse the worker/migration boundary.
  await client.query(`DO $$ DECLARE item record; owner_name text; BEGIN
    FOR item IN SELECT c.relname,n.nspname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','graphile_worker') AND c.relkind IN ('r','p','v','m','S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    LOOP
      owner_name := CASE WHEN item.nspname='public' THEN 'pdaa_migrate' ELSE 'pdaa_worker' END;
      EXECUTE format('ALTER %s %I.%I OWNER TO %I',CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,item.nspname,item.relname,owner_name);
    END LOOP;
    FOR item IN SELECT t.typname,n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid
      WHERE n.nspname IN ('public','graphile_worker') AND (t.typtype IN ('e','d') OR (t.typtype='c' AND c.relkind='c'))
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
    LOOP
      owner_name := CASE WHEN item.nspname='public' THEN 'pdaa_migrate' ELSE 'pdaa_worker' END;
      EXECUTE format('ALTER TYPE %I.%I OWNER TO %I',item.nspname,item.typname,owner_name);
    END LOOP;
    FOR item IN SELECT p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','graphile_worker') AND p.prokind='f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    LOOP
      owner_name := CASE WHEN item.nspname='public' THEN 'pdaa_migrate' ELSE 'pdaa_worker' END;
      EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO %I',item.nspname,item.proname,item.args,owner_name);
    END LOOP;
  END $$;
  ALTER SCHEMA public OWNER TO pdaa_migrate; ALTER SCHEMA graphile_worker OWNER TO pdaa_worker`);
}
export async function restore(
  config: OperationsConfig,
  migrations: Migration[],
  directory: string,
  name: string,
  key: Buffer,
) {
  requireRestoreTmpfs();
  const source = archivePath(directory, name);
  const temporary = mkdtempSync("/tmp/pdaa-restore-");
  const plaintext = join(temporary, "archive.dump");
  try {
    // Authentication must finish before any target connection or SQL execution.
    const metadata = await openArchive(source, plaintext, key);
    if (
      metadata.customerId !== config.customerId ||
      JSON.stringify(metadata.migrations) !==
        JSON.stringify(
          migrations.map(({ name, checksum }) => ({ name, checksum })),
        ) ||
      metadata.graphileVersion !== 19
    )
      throw new Error("Backup customer or release mismatch");
    if (
      metadata.source.database === config.database.database &&
      metadata.source.host === config.database.host &&
      metadata.source.port === config.database.port
    )
      throw new Error("Source cannot be the restore target");
    const client = await connect(config.database);
    const db = identifier(config.database.database);
    try {
      await assertPostgres17(client);
      await verifyRoles(client);
      await client.query("SELECT pg_advisory_lock(72707370)");
      await assertEmptyTarget(client);
      await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC,pdaa_api,pdaa_worker;
        COMMENT ON DATABASE ${db} IS 'pdaa.restore.quarantine.v1:${config.customerId}'`);
      // CONNECT is checked only during login: commit denial first, then reject
      // sessions that raced that boundary. Never terminate unrelated clients.
      await assertNoOtherSessions(client);
      const { child, completed } = postgresTool(
        "pg_restore",
        [
          "--single-transaction",
          "--exit-on-error",
          "--no-owner",
          "--no-acl",
          "--dbname",
          config.database.database,
          plaintext,
        ],
        config,
        temporary,
      );
      child.stdout.resume();
      await completed;
      await assertNoOtherSessions(client);
      await client.query("BEGIN");
      try {
        await restoreOwners(client);
        await grants(client, config, true);
        await assertCustomer(client, config);
        const applied = await history(client);
        validateHistory(applied, migrations);
        if (applied.length !== migrations.length)
          throw new Error("Restored migration set incomplete");
        await assertNoOtherSessions(client);
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        throw new Error(
          "Restored ownership or integrity validation failed; target remains quarantined",
        );
      }
      for (const role of ["pdaa_api", "pdaa_worker"]) {
        if (
          (
            await client.query(
              "SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",
              [role],
            )
          ).rows[0].allowed
        )
          throw new Error("Restore quarantine not enforced");
      }
      return {
        customerId: config.customerId,
        quarantine: true,
        applicationStarted: false,
      };
    } finally {
      await client.end();
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
