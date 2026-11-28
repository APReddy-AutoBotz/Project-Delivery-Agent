import { Pool } from "pg";
import { createHash } from "node:crypto";
import { run, Logger } from "graphile-worker";
import { createDatabase, DatabaseWorkerHeartbeatRepository } from "@pdaa/data";
import { projectManagementDraftOutputSchema } from "@pdaa/domain";
import { renderProjectManagementDraft } from "@pdaa/reporting";
import {
  loadConfig,
  operationalLog,
  installFatalHandlers,
  signConnectorTaskRequest,
} from "@pdaa/platform";
import { createTasks } from "./tasks.js";
import { createScheduledReportTasks } from "./scheduled-report-tasks.js";
import { setInterval, clearInterval } from "node:timers";
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
  const { INTERNAL_API_URL: reportApi, projectReportTaskKeys } = config;
  const reportTasks = reportApi && projectReportTaskKeys ? createScheduledReportTasks({
    post: async (path, command) => {
      const body = Buffer.from(JSON.stringify(command));
      const headers = signConnectorTaskRequest({ method: "POST", path, body, keyRing: projectReportTaskKeys });
      const response = await fetch(new URL(path, reportApi), {
        method: "POST", body, headers: { ...headers, "content-type": "application/json" },
        redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("scheduled_report_request_failed");
      }
      return response;
    },
    render: async ({ draft, snapshotId }) => {
      const output = projectManagementDraftOutputSchema.parse(await renderProjectManagementDraft(draft, snapshotId));
      const bytes = Buffer.from(output.powerpointBase64, "base64");
      return { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
    },
    onFailure: operationalLog,
  }) : {};
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
    concurrency: config.projectReportSchedule ? 2 : 1,
    noHandleSignals: true,
    logger: new Logger(() => () => operationalLog("worker.event")),
    crontab: "* * * * * foundation_heartbeat\n* * * * * connector_sync_dispatch\n* * * * * project_update_scan_dispatch\n* * * * * project_update_engagement_dispatch\n* * * * * project_update_content_retention\n0 * * * * health_assessment_retention" +
      (config.projectReportSchedule ? "\n0 * * * * schedule_project_reports" : ""),
    taskList: { ...createTasks(
      {
        recordHeartbeat: async (at) => {
          await heartbeat.recordHeartbeat(at);
          lastProgress = Date.now();
        },
      },
      config,
      fetch,
      signConnectorTaskRequest,
      async () => {
        await db.$queryRawUnsafe("SELECT public.purge_expired_health_assessments()");
        await db.$queryRawUnsafe(
          "SELECT public.purge_expired_blocker_age_threshold_audit_events()",
        );
        lastProgress = Date.now();
      },
    ), ...reportTasks },
  });
  operationalLog("worker.started");
  stage = "running";
  let shutdown: Promise<void> | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      if (shutdown) return;
      clearInterval(watchdog);
      shutdown = (async () => {
        await runner.stop();
        await db.$disconnect();
        await pool.end();
      })();
    });
  await runner.promise;
  if (!shutdown) throw new Error("Worker ended without a shutdown signal");
  await shutdown;
  process.exit(0);
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
