import { Client, type ClientConfig } from "pg";
import {
  loadDatabaseConfig,
  readSecretFile,
  type DatabaseTransport,
} from "@pdaa/platform";

export const roles = [
  "pdaa_migrate",
  "pdaa_api",
  "pdaa_worker",
  "pdaa_backup",
] as const;
export type Role = (typeof roles)[number];
export type OperationsConfig = {
  database: DatabaseTransport;
  customerId: string;
  customerName: string;
  roleFiles: Record<Role, string>;
  caFile?: string;
};
export function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error("Invalid operations identifier");
  return '"' + value + '"';
}
export function loadOperationsConfig(env: NodeJS.ProcessEnv): OperationsConfig {
  if (env.NODE_ENV !== "production" || env.DEPLOYMENT_MODE !== "customer")
    throw new Error("Operations require customer configuration");
  const { database } = loadDatabaseConfig(env);
  identifier(database.database);
  identifier(database.user);
  const target = `${database.host}:${database.port}/${database.database}`;
  if (env.PDAA_OPS_TARGET !== target)
    throw new Error("Operations target confirmation mismatch");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      env.CUSTOMER_ID ?? "",
    )
  )
    throw new Error("Operations customer required");
  if (!env.CUSTOMER_NAME?.trim() || env.CUSTOMER_NAME.length > 200)
    throw new Error("Operations customer name required");
  return {
    database,
    customerId: env.CUSTOMER_ID!,
    customerName: env.CUSTOMER_NAME.trim(),
    caFile: env.PDAA_DB_CA_FILE,
    roleFiles: {
      pdaa_migrate: env.PDAA_MIGRATION_PASSWORD_FILE ?? "",
      pdaa_api: env.PDAA_API_PASSWORD_FILE ?? "",
      pdaa_worker: env.PDAA_WORKER_PASSWORD_FILE ?? "",
      pdaa_backup: env.PDAA_BACKUP_PASSWORD_FILE ?? "",
    },
  };
}
export function roleDatabase(
  config: OperationsConfig,
  role: Role,
): DatabaseTransport {
  return {
    ...config.database,
    user: role,
    password: readSecretFile(config.roleFiles[role], role),
  };
}
export const clientOptions = (database: DatabaseTransport): ClientConfig => ({
  ...database,
  connectionTimeoutMillis: 5000,
  query_timeout: 30000,
  statement_timeout: 25000,
  application_name: "pdaa-operations",
});
export async function connect(database: DatabaseTransport) {
  const client = new Client(clientOptions(database));
  // Unexpected socket errors are never emitted with raw infrastructure details.
  client.on("error", () => {});
  await client.connect();
  return client;
}
export async function assertPostgres17(client: Client) {
  const version = Number(
    (await client.query("SHOW server_version_num")).rows[0].server_version_num,
  );
  if (Math.floor(version / 10000) !== 17)
    throw new Error("Operations require PostgreSQL 17");
  return version;
}
export async function assertEmptyTarget(client: Client) {
  const unexpected = await client.query(`SELECT
    (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema','pg_toast') AND nspname !~ '^pg_(temp|toast_temp)_[0-9]+$') +
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') +
    (SELECT count(*) FROM pg_largeobject_metadata) +
    (SELECT count(*) FROM pg_default_acl) +
    (SELECT count(*) FROM pg_foreign_server) +
    (SELECT count(*) FROM pg_event_trigger) +
    (SELECT count(*) FROM pg_publication) +
    (SELECT count(*) FROM pg_subscription) +
    (SELECT count(*) FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_operator c JOIN pg_namespace n ON n.oid=c.oprnamespace WHERE n.nspname='public') AS n`);
  if (Number(unexpected.rows[0].n) !== 0)
    throw new Error("Target contains existing objects or extensions");
}
export async function assertNoOtherSessions(client: Client) {
  if (
    (
      await client.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
      )
    ).rows[0].n !== 0
  )
    throw new Error("Target has another database session");
}
export async function lock(client: Client) {
  const deadline = Date.now() + 10000;
  do {
    if (
      (await client.query("SELECT pg_try_advisory_lock(72707369) AS locked"))
        .rows[0].locked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Migration lock unavailable");
}
