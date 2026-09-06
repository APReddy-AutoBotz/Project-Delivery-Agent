import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  connect,
  assertPostgres17,
  lock,
  type OperationsConfig,
} from "./config.js";
import { assertCustomer } from "./provision.js";
import { history, validateHistory, type Migration } from "./migrations.js";
import { archivePath, sealArchive, type BackupMetadata } from "./archive.js";

export function pgEnvironment(config: OperationsConfig, directory: string) {
  const db = config.database;
  const values = [db.host, String(db.port), db.database, db.user, db.password];
  if (values.some((value) => /[\r\n\0]/.test(value)))
    throw new Error("Unsupported PostgreSQL password-file value");
  const passfile = join(directory, "pgpass");
  writeFileSync(
    passfile,
    values
      .map((value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:"))
      .join(":") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  // Do not inherit service, hostaddr, password, options, library or TLS overrides.
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    PGHOST: db.host,
    PGPORT: String(db.port),
    PGDATABASE: db.database,
    PGUSER: db.user,
    PGPASSFILE: passfile,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: config.caFile ?? "system",
    PGCONNECT_TIMEOUT: "5",
    PGOPTIONS: "-c statement_timeout=300000 -c lock_timeout=10000",
  };
}
export function postgresTool(
  command: "pg_dump" | "pg_restore",
  args: string[],
  config: OperationsConfig,
  temporary: string,
) {
  const child = spawn(command, [...args, "--no-password"], {
    env: pgEnvironment(config, temporary),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300000,
  });
  let warning = false;
  child.stderr.on("data", () => {
    warning = true;
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.on("error", () => reject(new Error("PostgreSQL client unavailable")));
    child.on("close", (code) =>
      code === 0 && !warning
        ? resolve()
        : reject(new Error("PostgreSQL client operation failed")),
    );
  });
  return { child, completed };
}
export async function backup(
  config: OperationsConfig,
  migrations: Migration[],
  directory: string,
  key: Buffer,
) {
  const client = await connect(config.database);
  const temporary = mkdtempSync(join(tmpdir(), "pdaa-backup-"));
  let metadata: BackupMetadata;
  try {
    await client.query("SELECT pg_advisory_lock(72707370)");
    await lock(client);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const postgresVersion = await assertPostgres17(client);
    await assertCustomer(client, config);
    const applied = await history(client);
    validateHistory(applied, migrations);
    if (applied.length !== migrations.length)
      throw new Error("Backup requires the current release schema");
    const graphileVersion = Number(
      (
        await client.query(
          "SELECT max(id) AS version FROM graphile_worker.migrations",
        )
      ).rows[0].version,
    );
    if (graphileVersion !== 19) throw new Error("Unsupported Graphile schema");
    const rls = await client.query(`SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity) +
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='graphile_worker' AND c.relrowsecurity AND
        NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='pdaa_backup_read' AND p.polcmd='r' AND p.polpermissive AND pg_get_expr(p.polqual,p.polrelid)='true' AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='pdaa_backup')])) +
      (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='graphile_worker' AND NOT p.polpermissive) AS n`);
    if (Number(rls.rows[0].n))
      throw new Error("Backup row-security contract mismatch");
    metadata = {
      format: "pdaa-backup-v1",
      customerId: config.customerId,
      source: {
        host: config.database.host,
        port: config.database.port,
        database: config.database.database,
      },
      postgresVersion,
      createdAt: new Date().toISOString(),
      graphileVersion,
      migrations: applied.map((row) => ({
        name: row.migration_name,
        checksum: row.checksum,
      })),
    };
    const snapshot = (
      await client.query("SELECT pg_export_snapshot() AS snapshot")
    ).rows[0].snapshot;
    const name = `backup-${Date.now()}-${randomUUID()}.pdaa`;
    const destination = archivePath(directory, name);
    const { child, completed } = postgresTool(
      "pg_dump",
      ["--format=custom", "--enable-row-security", "--snapshot", snapshot],
      config,
      temporary,
    );
    try {
      await sealArchive(child.stdout, destination, key, metadata, completed);
    } finally {
      if (child.exitCode === null) child.kill();
    }
    return { file: name, customerId: config.customerId, encrypted: true };
  } finally {
    await client.end();
    rmSync(temporary, { recursive: true, force: true });
  }
}
