import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { createApp } from "../apps/api/dist/app.js";
import { installConnectorRoutes } from "../apps/api/dist/connector-routes.js";
import { installScheduledReportRoutes } from "../apps/api/dist/scheduled-report-routes.js";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseConnectorRuntimeRepository,
  DatabaseProjectRepository, DatabaseProjectUpdateRepository,
} from "../packages/data/dist/index.js";
import { portfolioUpdatePageSize } from "../packages/domain/src/project-updates.js";
import type { Actor, ProjectReportSchedule } from "../packages/domain/src/index.js";
import { assertSyntheticDatabaseUrl, CredentialKeyRingVault, loadConfig, signConnectorTaskRequest } from "../packages/platform/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import { seedReferenceJira } from "./fixtures/reference-load-jira.js";

const projectCount = 200;
const workItemsPerProject = 100;
const userCount = 200;
const concurrentUsers = 20;
const dashboardDeadlineMs = 3000;
const renderedReportEvent = "project_report.scheduled_draft.rendered";

async function until(ready: () => Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await delay(100);
  }
  throw new Error(`Reference workload timed out waiting for ${label}`);
}

it("loads core portfolio data during scheduled Jira synchronization and report generation at the Release 1 reference size", async () => {
  const url = assertSyntheticDatabaseUrl(process.env.PDAA_DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
      !/^\/pdaa_test_[0-9]+$/.test(url.pathname))
    throw new Error("The portfolio load check requires an isolated synthetic database");

  const config = loadConfig(process.env), db = createDatabase(url.toString());
  const customerId = randomUUID(), portfolioId = randomUUID();
  const users = Array.from({ length: userCount }, (_, index): Actor => ({
    customerId, subject: `reference-portfolio-reader-${index}`, roles: [index === 0 ? "pmo_admin" : "portfolio_manager"],
  }));
  const administrator = users[0]!;
  const reportSchedule: ProjectReportSchedule = {
    customerId, portfolioId, serviceSubject: "reference-report-service", dayOfMonth: 1, hourUtc: 0,
  };
  const reportTaskKeys = { currentKeyId: "reference-report", keys: {
    "reference-report": randomBytes(32).toString("base64url"),
  } };
  const connectorTaskKeys = { currentKeyId: "reference-sync", keys: {
    "reference-sync": randomBytes(32).toString("base64url"),
  } };
  const canonical = new DatabaseCanonicalProjectRepository(db);
  const projects = new DatabaseProjectRepository(db);
  const updates = new DatabaseProjectUpdateRepository(db, null, null, undefined, false, undefined, undefined, reportSchedule);
  const nonces = new DatabaseConnectorRuntimeRepository(db, new CredentialKeyRingVault(config.credentialKeys));
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  const processes: { child: ChildProcess; exited: Promise<unknown> }[] = [];
  const track = (child: ChildProcess) => { processes.push({ child, exited: once(child, "exit") }); return child; };
  let resumeSynchronization = () => {};
  const secrets = await mkdtemp(join(tmpdir(), "pdaa-reference-load-"));
  const schedulePath = join(secrets, "schedule.json");
  const keysPath = join(secrets, "report-keys.json");
  const connectorKeysPath = join(secrets, "connector-keys.json");
  try {
    await db.customer.create({ data: { id: customerId, name: "Synthetic reference customer" } });
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic reference portfolio" } });
    await db.accessGrant.createMany({ data: users.map(({ subject, roles }) => ({
      customerId, subject, scopeId: portfolioId, scopeType: "portfolio", role: roles[0]!,
    })) });
    const reviewer = { customerId, subject: "reference-report-reviewer", roles: ["leadership"] } satisfies Actor;
    await db.accessGrant.createMany({ data: [reportSchedule.serviceSubject, reviewer.subject].map((subject) => ({
      customerId, subject, scopeId: portfolioId, scopeType: "portfolio", role: "leadership",
    })) });
    for (let index = 0; index < projectCount; index++) {
      const fixture = canonicalFixture(portfolioId);
      const project = await canonical.createProject(administrator, {
        ...fixture,
        name: `Synthetic reference project ${index + 1}`,
        workItems: Array.from({ length: workItemsPerProject }, (_, workItemIndex) => ({
          ...fixture.workItems[0], key: `WI-${workItemIndex + 1}`, title: `Synthetic work item ${workItemIndex + 1}`,
        })),
      }, randomUUID());
      await updates.setPolicy(administrator, project.id, {
        expectedRevision: 0, freshnessWindowSeconds: 1, timeZone: "UTC",
        requiredFacts: [{ factType: "project.status", label: "Current status" }],
        responsibleSubject: fixture.responsibilities[4]!.subject, scheduledScanEnabled: false,
        reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0,
        escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null,
      }, randomUUID());
    }
    expect(await db.project.count({ where: { customerId } })).toBe(projectCount);
    expect(await db.workItem.count({ where: { customerId } })).toBe(projectCount * workItemsPerProject);
    const projectIds = (await projects.listProjects(administrator)).map(({ id }) => id);
    expect(projectIds).toHaveLength(projectCount);
    const firstFreshnessPage = [...projectIds].sort().slice(0, portfolioUpdatePageSize);

    const apiConfig = { ...config, CUSTOMER_ID: customerId, connectorTaskKeys,
      projectReportSchedule: reportSchedule, projectReportTaskKeys: reportTaskKeys };
    const synchronization = await seedReferenceJira(db, apiConfig, nonces, administrator, portfolioId, projectIds);
    resumeSynchronization = synchronization.resume;
    ({ app } = await createApp(apiConfig, projects, undefined, canonical, undefined, undefined,
      undefined, undefined, (target) => {
        installScheduledReportRoutes(target, apiConfig, nonces, updates);
        installConnectorRoutes(target, apiConfig, nonces, synchronization.service, updates);
      },
      undefined, undefined, updates));
    await app.listen(0, "127.0.0.1");
    const taskOrigin = await app.getUrl();
    const secret = new TextEncoder().encode(config.SESSION_SECRET);
    const auth = async ({ subject, roles }: Actor) => ({
      Authorization: "Bearer " + await new SignJWT({ roles })
        .setProtectedHeader({ alg: "HS256" }).setIssuer("pdaa:local").setAudience("pdaa:api")
        .setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(secret),
    });
    const headers = await Promise.all(users.map(auth));
    await Promise.all([
      writeFile(schedulePath, JSON.stringify(reportSchedule), { flag: "wx", mode: 0o600 }),
      writeFile(keysPath, JSON.stringify(reportTaskKeys), { flag: "wx", mode: 0o600 }),
      writeFile(connectorKeysPath, JSON.stringify(connectorTaskKeys), { flag: "wx", mode: 0o600 }),
    ]);
    const runEnv = { ...process.env, CUSTOMER_ID: customerId, INTERNAL_API_URL: taskOrigin,
      CONNECTOR_TASK_KEYS_FILE: connectorKeysPath, PROJECT_UPDATE_TASK_KEYS_FILE: undefined,
      PROJECT_UPDATE_SERVICE_SUBJECT: undefined, PROJECT_UPDATE_ZONES_FILE: undefined,
      PROJECT_UPDATE_CAPTURE_FILE: undefined, PROJECT_REPORT_SCHEDULE_FILE: schedulePath,
      PROJECT_REPORT_TASK_KEYS_FILE: keysPath };
    const dashboard = track(fork(new URL("../scripts/acceptance/reference-dashboard-child.mjs", import.meta.url), {
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: runEnv,
    }));
    let origin = "";
    dashboard.once("message", ({ origin: value, pid }: { origin: string; pid: number }) => {
      if (pid === dashboard.pid && /^http:\/\/127\.0\.0\.1:\d+$/.test(value)) origin = value;
    });
    await until(async () => Boolean(origin), "interactive API startup");
    const worker = track(spawn(process.execPath, ["apps/worker/dist/main.js"], {
      stdio: ["ignore", "pipe", "ignore"], env: runEnv,
    }));
    expect(new Set([process.pid, worker.pid, dashboard.pid]).size).toBe(3);
    let workerLog = "";
    worker.stdout?.setEncoding("utf8").on("data", (chunk: string) => { workerLog = (workerLog + chunk).slice(-4096); });
    await until(async () => workerLog.includes('"worker.started"'), "worker startup");
    // Each source runs its normal cursor reset and then one bounded issue page.
    for (let setup = 0; setup < synchronization.sourceCount * 2; setup++) {
      await db.$queryRaw`SELECT (graphile_worker.add_job('connector_sync_dispatch', '{}'::json,
        queue_name => 'reference-sync')).id::text AS id`;
    }
    await until(async () => synchronization.waitForRead(), "a scheduled connector read");
    await db.$queryRaw`SELECT (graphile_worker.add_job('schedule_project_reports', '{}'::json)).id::text AS id`;
    const reportScope = { customerId, actor: reportSchedule.serviceSubject, event: renderedReportEvent };
    await until(async () => (await db.auditEvent.count({ where: reportScope })) > 0,
      "the first completed scheduled report", 20_000);
    const syncScope = { customerId, kind: "CONNECTOR_PAGE", executionMode: "CONNECTOR_SYNC" };
    const readStarted = new Date();
    let readCompleted = readStarted;
    const additionalReadDeadline = Date.now() + 30_000;

    let maxDurationMs = 0, overlappingReceipts = false;
    for (let first = 0; first < headers.length ||
        (!overlappingReceipts && Date.now() < additionalReadDeadline); first += concurrentUsers) {
      const waveStart = first % headers.length;
      const pending = Promise.all(headers.slice(waveStart, waveStart + concurrentUsers).map(async (authorization) => {
        const startedAt = performance.now();
        const request = { headers: authorization, signal: AbortSignal.timeout(10_000) };
        const [projectsResponse, freshnessResponse] = await Promise.all([
          fetch(origin + "/api/projects", request),
          fetch(origin + "/api/pmo/portfolio-update-freshness", request),
        ]);
        expect(projectsResponse.status).toBe(200);
        expect(freshnessResponse.status).toBe(200);
        const [rows, freshness] = await Promise.all([projectsResponse.json(), freshnessResponse.json()]) as [
          { id: string }[], { projects: { id: string; assessment: { missing: { factType: string }[] } }[]; next: string | null },
        ];
        const elapsedMs = performance.now() - startedAt;
        expect(rows.map(({ id }) => id)).toEqual(projectIds);
        expect(freshness.projects.map(({ id, assessment }) => [id, assessment.missing.map(({ factType }) => factType)]))
          .toEqual(firstFreshnessPage.map((id) => [id, ["project.status"]]));
        expect(freshness.next).toBe(firstFreshnessPage.at(-1));
        return elapsedMs;
      }));
      if (first === 0) resumeSynchronization();
      const wave = await pending;
      readCompleted = new Date();
      maxDurationMs = Math.max(maxDurationMs, ...wave);
      if (first + concurrentUsers >= headers.length) {
        const [connectors, reports] = await Promise.all([
          db.ingestionOperationReceipt.count({ where: { ...syncScope, createdAt: { gte: readStarted, lte: readCompleted } } }),
          db.auditEvent.count({ where: { ...reportScope, occurredAt: { gte: readStarted, lte: readCompleted } } }),
        ]);
        overlappingReceipts = connectors > 0 && reports > 0;
      }
    }
    expect(await db.ingestionOperationReceipt.count({ where: { ...syncScope, createdAt: { gte: readStarted, lte: readCompleted } } }))
      .toBeGreaterThan(0);
    expect(await db.auditEvent.count({ where: { ...reportScope, occurredAt: { gte: readStarted, lte: readCompleted } } }))
      .toBeGreaterThan(0);
    await until(async () => (await db.ingestionExternalRecord.count({ where: { customerId } })) === projectCount,
      "all scheduled Jira records");
    const synchronized = await db.ingestionExternalRecord.findMany({ where: { customerId }, select: { projectId: true } });
    expect(synchronized.map(({ projectId }) => projectId).sort()).toEqual([...projectIds].sort());
    const syncReceipts = await db.ingestionOperationReceipt.findMany({
      where: syncScope,
      select: { sourceId: true, outcomeCount: true },
    });
    expect(new Set(syncReceipts.map(({ sourceId }) => sourceId)).size).toBe(synchronization.sourceCount);
    expect(syncReceipts.reduce((count, { outcomeCount }) => count + outcomeCount, 0)).toBe(projectCount);
    await until(async () => (await db.auditEvent.count({ where: reportScope })) === projectCount,
      "all scheduled reports", 60_000);
    const rendered = await db.auditEvent.findMany({ where: reportScope, select: { detail: true } });
    expect(rendered.map(({ detail }) => (detail as { projectId: string }).projectId).sort()).toEqual([...projectIds].sort());
    console.log(`Reference portfolio read with scheduled sync and reporting: ${projectCount} projects, ${projectCount * workItemsPerProject} work items, ${userCount} users, ${concurrentUsers} concurrent, slowest ${Math.round(maxDurationMs)} ms`);
    expect(maxDurationMs).toBeLessThan(dashboardDeadlineMs);

    const { detail } = await db.auditEvent.findFirstOrThrow({ where: reportScope, orderBy: { occurredAt: "asc" },
      select: { detail: true } });
    const { actorKind, ...receipt } = detail as {
      projectId: string; reportingPeriod: string; snapshotId: string; sha256: string; byteLength: number; actorKind: string;
    };
    expect(actorKind).toBe("service");
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.byteLength).toBeGreaterThan(0);
    const frozen = await db.auditEvent.findUniqueOrThrow({ where: { id: receipt.snapshotId }, select: { detail: true } });
    const reportUrl = `${origin}/api/projects/${receipt.projectId}/management-draft?snapshotId=scheduled`;
    expect((await fetch(reportUrl, { headers: headers[0] })).status).toBe(404);
    const preview = await fetch(reportUrl, { headers: await auth(reviewer) });
    expect(preview.status).toBe(200);
    const output = await preview.json();
    expect(output.snapshotId).toBeUndefined();
    expect(output.draft).toEqual((frozen.detail as { draft: unknown }).draft);
    expect(output.powerpointBase64).toMatch(/^UEsDB/);
    const completePath = "/internal/project-reports/complete";
    for (const [sha256, status] of [[receipt.sha256, 200], ["0".repeat(64), 409]] as const) {
      const body = Buffer.from(JSON.stringify({ ...receipt, sha256 }));
      const headers = signConnectorTaskRequest({ method: "POST", path: completePath, body, keyRing: reportTaskKeys });
      const response = await fetch(taskOrigin + completePath, { method: "POST", body,
        headers: { ...headers, "content-type": "application/json" } });
      expect(response.status).toBe(status);
      await response.body?.cancel();
    }
    expect(await db.auditEvent.count({ where: { ...reportScope, detail: { path: ["snapshotId"], equals: receipt.snapshotId } } })).toBe(1);
  } finally {
    resumeSynchronization();
    try {
      for (const { child, exited } of processes.reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        child.kill("SIGTERM");
        if (!await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })])) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      await app?.close();
    } finally {
      await db.$disconnect();
      await Promise.allSettled([unlink(schedulePath), unlink(keysPath), unlink(connectorKeysPath)]);
      await rmdir(secrets);
    }
  }
}, 180_000);
