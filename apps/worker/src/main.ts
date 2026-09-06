import { Pool } from "pg";
import { run, Logger } from "graphile-worker";
import { createDatabase } from "@pdaa/data";
import { loadConfig, operationalLog } from "@pdaa/platform";
let stage = "configuration";
try {
  const config = loadConfig(process.env);
  const db = createDatabase(config.database);
  const pool = new Pool({
    ...config.database,
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", () => operationalLog("worker.pool_error"));
  pool.on("connect", (client) => {
    client.on("error", () => operationalLog("worker.connection_error"));
  });
  stage = "startup";
  const runner = await run({
    pgPool: pool,
    schema: "graphile_worker",
    concurrency: 1,
    noHandleSignals: true,
    logger: new Logger(() => () => operationalLog("worker.event")),
    crontab: "* * * * * foundation_heartbeat",
    taskList: {
      foundation_heartbeat: async () => {
        await db.serviceHeartbeat.upsert({
          where: { id: "worker" },
          create: { id: "worker", occurredAt: new Date() },
          update: { occurredAt: new Date() },
        });
      },
    },
  });
  operationalLog("worker.started");
  stage = "running";
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, async () => {
      await runner.stop();
      await db.$disconnect();
      await pool.end();
      process.exit(0);
    });
  await runner.promise;
} catch (error) {
  // Fixed categories only: database errors can otherwise disclose credentials/SQL.
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  const kind =
    code === "42501"
      ? "permission_denied"
      : code === "42P01"
        ? "schema_missing"
        : code === "28P01"
          ? "authentication_failed"
          : code === "ECONNREFUSED"
            ? "connection_refused"
            : code === "ERR_TLS_CERT_ALTNAME_INVALID"
              ? "certificate_identity"
              : error instanceof Error &&
                  /connection timeout|timeout exceeded when trying to connect/i.test(
                    error.message,
                  )
                ? "connection_timeout"
                : "unknown";
  operationalLog(`worker.start_failed.${stage}.${kind}`);
  process.exit(1);
}
