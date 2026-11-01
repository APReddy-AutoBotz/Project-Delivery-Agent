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
type SessionCheckFailure = "other_sessions" | "query_failed" | "invalid_result";
type BackendKind = "autovacuum_worker" | "parallel_worker" | "logical_replication_worker" | "other_nonclient" | "unknown";
export type SessionObservation = { count: "one" | "multiple"; client: "yes" | "no" | "unknown"; nonclient: "yes" | "no" | "unknown"; null_type: "yes" | "no" | "unknown"; backend_kind: BackendKind };
export async function assertNoOtherSessions(client: Client, onFailure?: (category: SessionCheckFailure, observation?: SessionObservation) => void) {
  const report = (category: SessionCheckFailure, observation?: SessionObservation) => {
    try {
      if (observation) onFailure?.(category, observation);
      else onFailure?.(category);
    } catch { /* Diagnostics must not change restore behavior. */ }
  };
  let result: unknown;
  try {
    result = await client.query(
      onFailure
        ? `SELECT count(*)::int AS n,
             bool_or(backend_type = 'client backend') AS client,
             bool_or(backend_type <> 'client backend' AND backend_type IS NOT NULL) AS nonclient,
             bool_or(backend_type IS NULL) AS null_type,
             CASE WHEN count(*) = 1 THEN max(CASE
               WHEN backend_type COLLATE "C" = 'autovacuum worker' THEN 'autovacuum_worker'
               WHEN backend_type COLLATE "C" = 'parallel worker' THEN 'parallel_worker'
               WHEN backend_type COLLATE "C" = 'logical replication worker' THEN 'logical_replication_worker'
               WHEN backend_type IS NOT NULL AND backend_type COLLATE "C" <> 'client backend' THEN 'other_nonclient'
               ELSE 'unknown' END) ELSE 'unknown' END AS backend_kind
           FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`
        : "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
    );
  } catch (error) {
    report("query_failed");
    throw error;
  }
  let count: unknown;
  try {
    const rows = (result as { rows?: unknown }).rows;
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") throw new Error();
    count = (rows[0] as { n?: unknown }).n;
  } catch {
    report("invalid_result");
    throw new Error("Target has another database session");
  }
  if (count !== 0) {
    if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) {
      const flag = (key: "client" | "nonclient" | "null_type"): boolean | undefined => {
        try {
          const value = (result as { rows: Record<string, unknown>[] }).rows[0]![key];
          return typeof value === "boolean" ? value : undefined;
        } catch { return undefined; }
      };
      const clientSeen = flag("client"), nonclientSeen = flag("nonclient"), nullTypeSeen = flag("null_type");
      const flags = [clientSeen, nonclientSeen, nullTypeSeen];
      const contradiction = flags.every((value) => value === false) ||
        (count === 1 && flags.filter((value) => value === true).length > 1);
      const classify = (seen: boolean | undefined): "yes" | "no" | "unknown" =>
        contradiction ? "unknown" : seen === true ? "yes" : seen === false && nullTypeSeen === false ? "no" : "unknown";
      let backendKind: BackendKind = "unknown";
      if (count === 1 && clientSeen === false && nonclientSeen === true && nullTypeSeen === false && !contradiction) {
        try {
          const value = (result as { rows: Record<string, unknown>[] }).rows[0]!.backend_kind;
          if (typeof value === "string" && ["autovacuum_worker", "parallel_worker", "logical_replication_worker", "other_nonclient"].includes(value))
            backendKind = value as BackendKind;
        } catch { /* A diagnostic getter cannot change the guard. */ }
      }
      report("other_sessions", { count: count === 1 ? "one" : "multiple", client: classify(clientSeen), nonclient: classify(nonclientSeen), null_type: contradiction ? "unknown" : nullTypeSeen === true ? "yes" : nullTypeSeen === false ? "no" : "unknown", backend_kind: backendKind });
    } else report("invalid_result");
    throw new Error("Target has another database session");
  }
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
