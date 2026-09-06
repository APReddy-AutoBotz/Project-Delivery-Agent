import { Pool, type Client } from "pg";
import { makeWorkerUtils, Logger } from "graphile-worker";
import { readSecretFile } from "@pdaa/platform";
import {
  connect,
  assertPostgres17,
  assertEmptyTarget,
  identifier,
  roles,
  roleDatabase,
  clientOptions,
  type OperationsConfig,
} from "./config.js";
import { migrateDatabase, type Migration } from "./migrations.js";

export async function assertCustomer(client: Client, config: OperationsConfig) {
  const rows = (await client.query('SELECT id,name FROM "Customer"')).rows;
  if (
    rows.length !== 1 ||
    rows[0].id !== config.customerId ||
    rows[0].name !== config.customerName
  )
    throw new Error("Database customer identity mismatch");
}
export async function grants(
  client: Client,
  config: OperationsConfig,
  quarantine = false,
) {
  const db = identifier(config.database.database);
  await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC; REVOKE CREATE ON DATABASE ${db} FROM pdaa_api,pdaa_worker,pdaa_backup;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO pdaa_api,pdaa_worker,pdaa_backup;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pdaa_api,pdaa_worker,pdaa_backup;
    GRANT SELECT,INSERT,UPDATE,DELETE ON "Customer","Portfolio","Project","AccessGrant","ConnectorCredential" TO pdaa_api;
    GRANT SELECT,INSERT ON "AuditEvent" TO pdaa_api;
    GRANT SELECT ON "ServiceHeartbeat" TO pdaa_api;
    GRANT SELECT,INSERT,UPDATE ON "ServiceHeartbeat" TO pdaa_worker;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdaa_backup;
    GRANT USAGE ON SCHEMA graphile_worker TO pdaa_backup;
    GRANT SELECT ON ALL TABLES IN SCHEMA graphile_worker TO pdaa_backup;
    GRANT SELECT ON ALL SEQUENCES IN SCHEMA graphile_worker TO pdaa_backup;
    GRANT CONNECT ON DATABASE ${db} TO pdaa_migrate,pdaa_backup`);
  // Graphile enables RLS on private tables. A backup-only read policy avoids
  // granting cluster-wide BYPASSRLS or worker ownership to the backup account.
  await client.query(`DO $$ DECLARE item record; BEGIN
    FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='graphile_worker' AND c.relkind='r' AND c.relrowsecurity
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS pdaa_backup_read ON graphile_worker.%I',item.relname);
      EXECUTE format('CREATE POLICY pdaa_backup_read ON graphile_worker.%I FOR SELECT TO pdaa_backup USING (true)',item.relname);
    END LOOP;
  END $$`);
  await client.query(
    `${quarantine ? "REVOKE" : "GRANT"} CONNECT ON DATABASE ${db} ${quarantine ? "FROM" : "TO"} pdaa_api,pdaa_worker`,
  );
}
export async function verifyRoles(client: Client) {
  const rows = (
    await client.query(
      "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname = ANY($1)",
      [roles],
    )
  ).rows;
  if (
    rows.length !== roles.length ||
    rows.some(
      (row) =>
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolreplication ||
        row.rolbypassrls ||
        !row.rolcanlogin,
    )
  )
    throw new Error("Unexpected operations role privileges");
  if (
    (
      await client.query(
        "SELECT count(*)::int AS n FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1))",
        [roles],
      )
    ).rows[0].n
  )
    throw new Error("Operations roles must not inherit other roles");
}
export async function provision(
  config: OperationsConfig,
  migrations: Migration[],
) {
  // Read all credentials before creating anything, without changing existing passwords.
  const passwords = roles.map((role) =>
    readSecretFile(config.roleFiles[role], role),
  );
  const admin = await connect(config.database);
  const db = identifier(config.database.database);
  const marker = `pdaa.foundation.v1:${config.customerId}`;
  try {
    await assertPostgres17(admin);
    await admin.query("SELECT pg_advisory_lock(72707370)");
    const current = (
      await admin.query(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0].marker;
    if (current !== marker) {
      await assertEmptyTarget(admin);
      const existing = (
        await admin.query(
          "SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1)",
          [roles],
        )
      ).rows[0].n;
      if (current || existing)
        throw new Error("Refuse to provision an unowned or nonempty target");
      await admin.query("BEGIN");
      try {
        for (const [index, role] of roles.entries()) {
          const quoted = (
            await admin.query("SELECT quote_literal($1) AS value", [
              passwords[index],
            ])
          ).rows[0].value;
          await admin.query(
            `CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoted}`,
          );
        }
        await admin.query(`COMMENT ON DATABASE ${db} IS '${marker}';
          REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
          GRANT CONNECT ON DATABASE ${db} TO pdaa_migrate,pdaa_worker,pdaa_api,pdaa_backup;
          GRANT CREATE ON DATABASE ${db} TO pdaa_migrate;
          REVOKE ALL ON SCHEMA public FROM PUBLIC;
          ALTER SCHEMA public OWNER TO pdaa_migrate;
          CREATE SCHEMA graphile_worker AUTHORIZATION pdaa_worker;
          CREATE EXTENSION IF NOT EXISTS vector`);
        await admin.query("COMMIT");
      } catch {
        await admin.query("ROLLBACK");
        throw new Error("Provisioning rolled back");
      }
    }
    await verifyRoles(admin);
    // Configured passwords must match existing roles on repeat; never silently rotate.
    for (const role of roles) {
      const connection = await connect(roleDatabase(config, role));
      await connection.end();
    }
    const hasCustomer = (
      await admin.query("SELECT to_regclass('public.\"Customer\"') AS name")
    ).rows[0].name;
    // A marked partial initial installation can have an empty Customer table.
    // Existing customer data must match before any repeat migration/ACL change.
    if (
      hasCustomer &&
      (await admin.query('SELECT count(*)::int AS n FROM "Customer"')).rows[0]
        .n > 0
    )
      await assertCustomer(admin, config);
    const applied = await migrateDatabase(
      roleDatabase(config, "pdaa_migrate"),
      migrations,
    );
    await admin.query(`GRANT CREATE ON DATABASE ${db} TO pdaa_worker`);
    const pool = new Pool(clientOptions(roleDatabase(config, "pdaa_worker")));
    pool.on("error", () => {});
    try {
      const utils = await makeWorkerUtils({
        pgPool: pool,
        schema: "graphile_worker",
        logger: new Logger(() => () => {}),
      });
      try {
        await utils.migrate();
      } finally {
        await utils.release();
      }
    } finally {
      await pool.end();
      await admin.query(`REVOKE CREATE ON DATABASE ${db} FROM pdaa_worker`);
    }
    await admin.query(
      'INSERT INTO "Customer" (id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [config.customerId, config.customerName],
    );
    await assertCustomer(admin, config);
    await grants(admin, config);
    for (const role of roles) {
      const connection = await connect(roleDatabase(config, role));
      await connection.end();
    }
    return {
      migrations: applied,
      customerId: config.customerId,
      quarantine: false,
    };
  } finally {
    await admin.end();
  }
}

export async function migrateRelease(
  config: OperationsConfig,
  migrations: Migration[],
) {
  const client = await connect(config.database);
  try {
    await client.query("SELECT pg_advisory_lock(72707370)");
    const marker = (
      await client.query(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0].marker;
    if (marker !== `pdaa.foundation.v1:${config.customerId}`)
      throw new Error("Provisioned customer ownership required");
    await assertCustomer(client, config);
    return await migrateDatabase(config.database, migrations);
  } finally {
    await client.end();
  }
}
