import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDatabase, DatabaseAuthorityRepository, DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository, DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { canonicalProjectCreateSchema } from "../../packages/domain/dist/index.js";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

test("PMO sees current update obligations, stale facts and conflicts only on shared projects", async ({ page, request }) => {
  const fixture = JSON.parse(readFileSync(process.env.PDAA_ESCALATION_FIXTURE_PATH!, "utf8"));
  const target = new URL(process.env.PDAA_ESCALATION_BROWSER_DATABASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
  expect(target.pathname).toMatch(/^\/pdaa_test_[0-9]+$/);
  const db = createDatabase(target.toString());
  const repository = new DatabaseCanonicalProjectRepository(db);
  const facts = new DatabaseProjectFactRepository(db);
  const authority = new DatabaseAuthorityRepository(db);
  const updates = new DatabaseProjectUpdateRepository(db);
  let projectId: string;
  try {
    const atlas = await db.project.findFirstOrThrow({ where: { customerId: fixture.customerId, id: fixture.projectId } });
    const hidden = await db.portfolio.create({ data: { id: randomUUID(), customerId: fixture.customerId, name: "PMO restricted portfolio" } });
    await db.accessGrant.create({ data: { customerId: fixture.customerId, subject: fixture.writer.subject,
      scopeType: "portfolio", scopeId: hidden.id, role: "pmo_admin" } });
    await repository.createProject(fixture.writer, canonicalProjectCreateSchema.parse({ ...canonicalFixture(hidden.id),
      code: "PMO-HIDDEN", name: "Unshared portfolio project" }), randomUUID());
    const created = await repository.createProject(fixture.admin, canonicalProjectCreateSchema.parse({ ...canonicalFixture(atlas.portfolioId),
      code: "PMO-UPDATE", name: "Portfolio update review" }), randomUUID());
    projectId = created.id;
    const observedAt = new Date().toISOString();
    const add = async (actor: typeof fixture.admin, factType: string, revision: number, value: string) => {
      const { entry } = await facts.appendHumanStatement(actor, { projectId, factType, expectedRevision: revision,
        idempotencyKey: randomUUID(), effectiveAt: observedAt, value: { type: "text", value }, originalStatement: value },
      { correlationId: randomUUID() });
      await facts.setSourceAccess(fixture.admin, { projectId, sourceId: entry.sourceId,
        expectedRevision: entry.sourceAccessRevision, state: "AVAILABLE",
        readers: [...new Set<string>([fixture.admin.subject, actor.subject])] }, { correlationId: randomUUID() });
    };
    await add(fixture.admin, "project.status", 0, "Synthetic authority says on track");
    await add(fixture.writer, "project.status", 1, "Synthetic authority says off track");
    await add(fixture.admin, "project.forecast", 0, "Synthetic forecast was previously confirmed");
    for (const factType of ["project.status", "project.forecast"]) await authority.appendPolicy(fixture.admin, {
      projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt: observedAt,
      definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED",
        validity: { basis: "observedAt", durationMs: 86_400_000 } }] }], conflictBehavior: "REQUEST_RECONCILIATION" },
    }, { correlationId: randomUUID() });
    await updates.setPolicy(fixture.admin, projectId, { expectedRevision: 0, timeZone: "UTC", freshnessWindowSeconds: 1,
      requiredFacts: [{ factType: "project.status", label: "Delivery status" },
        { factType: "project.forecast", label: "Forecast position" }, { factType: "project.cost", label: "Cost update" }],
      responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false,
      reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0, escalationRecipientSubject: null,
      quietHoursStartLocal: null, quietHoursEndLocal: null }, randomUUID());
  } finally { await db.$disconnect(); }

  const endpoint = "/api/pmo/portfolio-update-freshness";
  const signIn = async (persona: string) => {
    const session = await request.post("/api/auth/development", { data: { persona } });
    expect(session.ok()).toBe(true);
    return { Authorization: "Bearer " + (await session.json()).token };
  };
  expect((await request.get(endpoint, { headers: await signIn("pm-atlas") })).status()).toBe(404);
  const pmo = await signIn("pmo-portfolio");
  const readProject = async () => {
    const result = await request.get(endpoint, { headers: pmo });
    expect(result.status()).toBe(200);
    return (await result.json()).projects.find((project: { id: string }) => project.id === projectId);
  };
  await expect.poll(async () => {
    const project = await readProject();
    return { state: project?.assessment.state, stale: project?.assessment.stale };
  }).toEqual({ state: "STALE", stale: [{ factType: "project.forecast", label: "Forecast position" }] });
  const persisted = createDatabase(target.toString());
  try {
    const { obligation } = await new DatabaseProjectUpdateRepository(persisted).assess(fixture.admin, projectId, randomUUID());
    expect(obligation?.state).toBe("OPEN");
    expect((await readProject()).assessment.openObligation).toEqual({ id: obligation?.id, dueAt: obligation?.dueAt });
  } finally { await persisted.$disconnect(); }

  await page.goto("/");
  await page.getByRole("button", { name: /PMO administrator/ }).click();
  const overview = page.getByRole("region", { name: "Portfolio update freshness" });
  const row = overview.getByRole("row", { name: /PMO-UPDATE/ });
  await expect(row).toContainText("Open update obligation due");
  await expect(row.getByRole("cell").nth(1)).toHaveText("Cost update");
  await expect(row.getByRole("cell").nth(2)).toHaveText("Forecast position");
  await expect(row.getByRole("cell").nth(3)).toHaveText("Delivery status");
  await expect(overview.getByRole("row", { name: /PMO-HIDDEN/ })).toHaveCount(0);
  await expect(overview).not.toContainText("Synthetic authority says");
  await row.getByRole("link", { name: "Open PMO-UPDATE" }).click();
  await expect(page.getByRole("heading", { name: "Portfolio update review", level: 1 })).toBeVisible();
});
