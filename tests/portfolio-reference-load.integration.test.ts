import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { createApp } from "../apps/api/dist/app.js";
import { installScheduledReportRoutes } from "../apps/api/dist/scheduled-report-routes.js";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseConnectorRuntimeRepository,
  DatabaseProjectRepository, DatabaseProjectUpdateRepository,
} from "../packages/data/dist/index.js";
import { portfolioUpdatePageSize } from "../packages/domain/src/project-updates.js";
import type { Actor, ProjectReportSchedule } from "../packages/domain/src/index.js";
import { assertSyntheticDatabaseUrl, CredentialKeyRingVault, loadConfig } from "../packages/platform/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const projectCount = 200;
const workItemsPerProject = 100;
const userCount = 200;
const concurrentUsers = 20;
const dashboardDeadlineMs = 3000;
const renderedReportEvent = "project_report.scheduled_draft.rendered";

async function until(ready: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await delay(100);
  }
  throw new Error(`Reference workload timed out waiting for ${label}`);
}

it("loads core portfolio data while the separate scheduled report worker renders at the Release 1 reference size", async () => {
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
  const canonical = new DatabaseCanonicalProjectRepository(db);
  const projects = new DatabaseProjectRepository(db);
  const updates = new DatabaseProjectUpdateRepository(db, null, null, undefined, false, undefined, undefined, reportSchedule);
  const nonces = new DatabaseConnectorRuntimeRepository(db, new CredentialKeyRingVault(config.credentialKeys));
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  let worker: ReturnType<typeof spawn> | undefined;
  let workerExit: Promise<unknown> | undefined;
  const secrets = await mkdtemp(join(tmpdir(), "pdaa-reference-report-"));
  const schedulePath = join(secrets, "schedule.json"), keysPath = join(secrets, "report-keys.json");
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

    const apiConfig = { ...config, CUSTOMER_ID: customerId, projectReportSchedule: reportSchedule, projectReportTaskKeys: reportTaskKeys };
    ({ app } = await createApp(apiConfig, projects, undefined, canonical, undefined, undefined,
      undefined, undefined, (target) => installScheduledReportRoutes(target, apiConfig, nonces, updates),
      undefined, undefined, updates));
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
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
    ]);
    worker = spawn(process.execPath, ["apps/worker/dist/main.js"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, CUSTOMER_ID: customerId, INTERNAL_API_URL: origin,
        CONNECTOR_TASK_KEYS_FILE: undefined, PROJECT_UPDATE_TASK_KEYS_FILE: undefined,
        PROJECT_UPDATE_SERVICE_SUBJECT: undefined, PROJECT_UPDATE_ZONES_FILE: undefined,
        PROJECT_UPDATE_CAPTURE_FILE: undefined, PROJECT_REPORT_SCHEDULE_FILE: schedulePath,
        PROJECT_REPORT_TASK_KEYS_FILE: keysPath },
    });
    workerExit = once(worker, "exit");
    let workerLog = "";
    worker.stdout?.setEncoding("utf8").on("data", (chunk: string) => { workerLog = (workerLog + chunk).slice(-4096); });
    await until(async () => workerLog.includes('"worker.started"'), "worker startup");
    await db.$queryRaw`SELECT (graphile_worker.add_job('schedule_project_reports', '{}'::json)).id::text AS id`;
    const reportScope = { customerId, actor: reportSchedule.serviceSubject, event: renderedReportEvent };
    await until(async () => (await db.auditEvent.count({ where: reportScope })) > 0, "the first completed scheduled report");
    const readStarted = new Date();

    let maxDurationMs = 0;
    for (let first = 0; first < headers.length; first += concurrentUsers) {
      const wave = await Promise.all(headers.slice(first, first + concurrentUsers).map(async (authorization) => {
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
      maxDurationMs = Math.max(maxDurationMs, ...wave);
    }
    const readCompleted = new Date();
    expect(await db.auditEvent.count({ where: { ...reportScope, occurredAt: { gte: readStarted, lte: readCompleted } } }))
      .toBeGreaterThan(0);
    console.log(`Reference portfolio read: ${projectCount} projects, ${projectCount * workItemsPerProject} work items, ${userCount} users, ${concurrentUsers} concurrent, slowest ${Math.round(maxDurationMs)} ms`);
    expect(maxDurationMs).toBeLessThan(dashboardDeadlineMs);

    const { detail } = await db.auditEvent.findFirstOrThrow({ where: reportScope, orderBy: { occurredAt: "asc" },
      select: { detail: true } });
    const receipt = detail as { projectId: string; snapshotId: string; sha256: string; byteLength: number };
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.byteLength).toBeGreaterThan(0);
    const reportUrl = `${origin}/api/projects/${receipt.projectId}/management-draft?snapshotId=scheduled`;
    expect((await fetch(reportUrl, { headers: headers[0] })).status).toBe(404);
    const preview = await fetch(reportUrl, { headers: await auth(reviewer) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ snapshotId: receipt.snapshotId,
      draft: { projectId: receipt.projectId, approvalState: "DRAFT" }, powerpointBase64: expect.stringMatching(/^UEsDB/) });
  } finally {
    try {
      if (worker && workerExit && worker.exitCode === null) {
        worker.kill("SIGTERM");
        if (!await Promise.race([workerExit.then(() => true), delay(5000, false, { ref: false })])) {
          worker.kill("SIGKILL");
          await workerExit;
        }
      }
      await app?.close();
    } finally {
      await db.$disconnect();
      await Promise.allSettled([unlink(schedulePath), unlink(keysPath)]);
      await rmdir(secrets);
    }
  }
}, 180_000);
