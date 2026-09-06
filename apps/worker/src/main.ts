import { Pool } from "pg";
import { run, Logger } from "graphile-worker";
import { createDatabase, DatabaseWorkerHeartbeatRepository } from "@pdaa/data";
import {
  loadConfig,
  operationalLog,
  installFatalHandlers,
} from "@pdaa/platform";
import { createTasks } from "./tasks.js";
import { setInterval } from "node:timers";
installFatalHandlers("worker");
let stage = "configuration";
try {
  const config = loadConfig(process.env);
  const db = createDatabase(config.database);
  const pool = new Pool({
    ...config.database,
    max: 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  pool.on("error", () => operationalLog("worker.pool_error"));
  pool.on("connect", (client) => {
    client.on("error", () => operationalLog("worker.connection_error"));
  });
  stage = "startup";
  let lastProgress = Date.now();
  const heartbeat = new DatabaseWorkerHeartbeatRepository(db);
  // A healthy PID is insufficient: terminate if scheduled work stops progressing.
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgress > 180000) {
      operationalLog("worker.progress_timeout");
      process.exit(1);
    }
  }, 10000);
  watchdog.unref();
  const runner = await run({
    preset: { worker: { completeJobBatchDelay: 0, failJobBatchDelay: 0 } },
    pgPool: pool,
    schema: "graphile_worker",
    concurrency: 1,
    noHandleSignals: true,
    logger: new Logger(() => () => operationalLog("worker.event")),
    crontab: "* * * * * foundation_heartbeat",
    taskList: createTasks({
      recordHeartbeat: async (at) => {
        await heartbeat.recordHeartbeat(at);
        lastProgress = Date.now();
      },
    }),
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
  throw new Error("Worker ended without a shutdown signal");
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
