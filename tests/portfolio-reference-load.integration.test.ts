import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { createApp } from "../apps/api/dist/app.js";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectRepository, DatabaseProjectUpdateRepository,
} from "../packages/data/dist/index.js";
import { portfolioUpdatePageSize } from "../packages/domain/src/project-updates.js";
import type { Actor } from "../packages/domain/src/index.js";
import { assertSyntheticDatabaseUrl, loadConfig } from "../packages/platform/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const projectCount = 200;
const workItemsPerProject = 100;
const userCount = 200;
const concurrentUsers = 20;
const dashboardDeadlineMs = 3000;

it("loads core portfolio data for 20 concurrent readers at the Release 1 reference size", async () => {
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
  const canonical = new DatabaseCanonicalProjectRepository(db);
  const projects = new DatabaseProjectRepository(db);
  const updates = new DatabaseProjectUpdateRepository(db);
  let app: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
  try {
    await db.customer.create({ data: { id: customerId, name: "Synthetic reference customer" } });
    await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic reference portfolio" } });
    await db.accessGrant.createMany({ data: users.map(({ subject, roles }) => ({
      customerId, subject, scopeId: portfolioId, scopeType: "portfolio", role: roles[0]!,
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

    ({ app } = await createApp({ ...config, CUSTOMER_ID: customerId }, projects, undefined, canonical, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, updates));
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    const secret = new TextEncoder().encode(config.SESSION_SECRET);
    const headers = await Promise.all(users.map(async ({ subject, roles }) => ({
      Authorization: "Bearer " + await new SignJWT({ roles })
        .setProtectedHeader({ alg: "HS256" }).setIssuer("pdaa:local").setAudience("pdaa:api")
        .setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(secret),
    })));

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
    console.log(`Reference portfolio read: ${projectCount} projects, ${projectCount * workItemsPerProject} work items, ${userCount} users, ${concurrentUsers} concurrent, slowest ${Math.round(maxDurationMs)} ms`);
    expect(maxDurationMs).toBeLessThan(dashboardDeadlineMs);
  } finally {
    try { await app?.close(); }
    finally { await db.$disconnect(); }
  }
}, 180_000);
