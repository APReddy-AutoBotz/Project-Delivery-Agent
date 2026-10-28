import { test, expect, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

const portfolioId = "20000000-0000-4000-8000-000000000001";
test.setTimeout(90000);
test("EXEC-023: update suggestions revalidate scope, access and visibility", async ({ page, request, browser }) => {
  const tokens: Record<string, string> = {};
  for (const persona of ["operator", "pmo-portfolio", "pm-atlas", "leader-atlas"]) {
    const response = await request.post("/api/auth/development", { data: { persona } });
    expect(response.status()).toBe(200);
    tokens[persona] = (await response.json()).token;
  }
  const api = (persona: string, path: string, method = "GET", data?: unknown) => request.fetch(`/api${path}`, {
    method, headers: { Authorization: `Bearer ${tokens[persona]}` }, ...(data === undefined ? {} : { data }),
  });
  expect((await api("operator", "/access-grants", "POST", { subject: "pmo-portfolio", role: "pmo_admin",
    scopeType: "portfolio", scopeId: portfolioId })).status()).toBe(204);
  const fixture = canonicalFixture(portfolioId);
  fixture.code = `UPD-${randomUUID().slice(0, 8)}`;
  fixture.name = `Update advice ${randomUUID().slice(0, 8)}`;
  fixture.responsibilities = fixture.responsibilities.map((row: { role: string; subject: string }) =>
    row.role === "PROJECT_MANAGER" ? { ...row, subject: "pm-atlas" } : row);
  const created = await api("pmo-portfolio", "/projects", "POST", fixture);
  expect(created.status()).toBe(201);
  const projectId: string = (await created.json()).id;
  expect((await api("operator", "/access-grants", "POST", { subject: "pm-atlas", role: "project_manager",
    scopeType: "project", scopeId: projectId })).status()).toBe(204);
  expect((await api("operator", "/access-grants", "POST", { subject: "leader-atlas", role: "leadership",
    scopeType: "project", scopeId: projectId })).status()).toBe(204);
  const path = `/projects/${projectId}/update-suggestions`;
  const unconfigured = await api("pm-atlas", path);
  expect(unconfigured.status()).toBe(200);
  expect(unconfigured.headers()["cache-control"]).toBe("no-store");
  expect(await unconfigured.json()).toMatchObject({ availability: "UNCONFIGURED", projectId });
  await page.goto("/");
  await page.getByRole("button", { name: /^Project manager / }).click();
  await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
  const panel = page.getByRole("region", { name: "Update information" });
  await expect(panel).toContainText("No project update policy is configured");
  const policy = await api("pmo-portfolio", `/projects/${projectId}/project-update-policy`, "POST", {
    expectedRevision: 0, freshnessWindowSeconds: 3600, timeZone: "UTC",
    requiredFacts: [{ factType: "delivery.status", label: "Delivery status" }], responsibleSubject: "synthetic-owner-4",
    scheduledScanEnabled: false, reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0,
    escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null,
  });
  expect(policy.status(), await policy.text()).toBe(200);
  const first = await api("pm-atlas", path);
  expect(first.status()).toBe(200);
  const firstView = await first.json();
  expect(firstView).toMatchObject({ availability: "AVAILABLE", completeness: { state: "INCOMPLETE" },
    suggestion: { category: "UPDATE_FOLLOW_UP", priority: "MEDIUM" } });
  await panel.getByRole("button", { name: "Refresh update suggestions" }).click();
  await expect(panel).toContainText("Delivery status");
  await expect(panel).toContainText("Project creation time is the fallback");
  await expect(panel).toContainText("Freshness threshold for this observation:");
  await expect(panel).toContainText("Review priority: MEDIUM");
  const route = `**/api${path}`;
  await page.route(route, (intercepted) => intercepted.fulfill({ status: 503, json: { statusCode: 503, message: "Unavailable" } }));
  await panel.getByRole("button", { name: "Refresh update suggestions" }).click();
  await expect(panel).toContainText("Update information is unavailable");
  await expect(panel).not.toContainText("Delivery status");
  await page.unroute(route);
  await panel.getByRole("button", { name: "Refresh update suggestions" }).click();
  await expect(panel).toContainText("Delivery status");
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  let heldRequest: Request | undefined;
  await page.route(route, async (intercepted) => {
    if (heldRequest) return intercepted.continue();
    heldRequest = intercepted.request(); arrived(); await held; await intercepted.continue();
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await entered;
  const response = page.waitForResponse((item) => item.request() === heldRequest);
  await expect(panel).not.toContainText("Delivery status");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Atlas · Customer platform/ }).click();
  release();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.unroute(route);
  await expect(page.getByRole("region", { name: "Update information" })).not.toContainText("Delivery status");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
  await expect(panel).toContainText("Delivery status");
  let releaseSession!: () => void, arrivedSession!: () => void;
  const heldSession = new Promise<void>((resolve) => { releaseSession = resolve; });
  const enteredSession = new Promise<void>((resolve) => { arrivedSession = resolve; });
  let heldSessionRequest: Request | undefined;
  await page.route(route, async (intercepted) => {
    if (heldSessionRequest) return intercepted.continue();
    heldSessionRequest = intercepted.request(); arrivedSession(); await heldSession; await intercepted.continue();
  });
  await panel.getByRole("button", { name: "Refresh update suggestions" }).click();
  await enteredSession;
  const sessionResponse = page.waitForResponse((item) => item.request() === heldSessionRequest);
  await page.getByRole("button", { name: "Sign out" }).click();
  releaseSession();
  await (await sessionResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.unroute(route);
  await expect(page.getByText("Delivery status", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: /^Project manager / }).click();
  await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
  await expect(panel).toContainText("Delivery status");
  const leaderContext = await browser.newContext();
  try {
    const leaderPage = await leaderContext.newPage();
    await leaderPage.goto("/");
    await leaderPage.getByRole("button", { name: /^Leadership / }).click();
    await leaderPage.getByRole("button", { name: new RegExp(fixture.name) }).click();
    await expect(leaderPage.getByRole("region", { name: "Update information" })).toContainText("decide whether intervention is needed");
  } finally { await leaderContext.close(); }
  // Produce the clear state through actual human evidence, access and authority APIs.
  const effectiveAt = new Date(Date.now() - 60000).toISOString();
  const statement = await api("pmo-portfolio", `/projects/${projectId}/fact-statements`, "POST", {
    projectId, factType: "delivery.status", expectedRevision: 0, idempotencyKey: randomUUID(),
    value: { type: "text", value: "Synthetic delivery update" }, originalStatement: "Synthetic delivery update",
    effectiveAt, validUntil: null,
  });
  expect(statement.status()).toBe(201);
  const sourceId: string = (await statement.json()).entry.sourceId;
  const accessPath = `/projects/${projectId}/fact-sources/${sourceId}/access`;
  const currentAccess = await api("pmo-portfolio", accessPath);
  expect(currentAccess.status()).toBe(200);
  const access = await currentAccess.json();
  expect((await api("pmo-portfolio", accessPath, "POST", { projectId, sourceId, expectedRevision: access.revision,
    state: "AVAILABLE", readers: ["pmo-portfolio", "pm-atlas", "leader-atlas"] })).status()).toBe(200);
  const authority = await api("pmo-portfolio", `/projects/${projectId}/authority-policies`, "POST", {
    projectId, factType: "delivery.status", expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt,
    definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
      requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 7200000 } }] }],
      conflictBehavior: "REQUEST_RECONCILIATION" },
  });
  expect(authority.status()).toBe(201);
  const clear = await api("pm-atlas", path);
  expect(clear.status()).toBe(200);
  expect(await clear.json()).toMatchObject({ availability: "AVAILABLE", completeness: { state: "COMPLETE" },
    freshness: { state: "CURRENT", sourceDateField: "project.latestValidUpdateAt" }, suggestion: null });
  await panel.getByRole("button", { name: "Refresh update suggestions" }).click();
  await expect(panel).toContainText("No update follow-up suggestion was produced");
  expect((await api("operator", "/access-grants", "DELETE", { subject: "pm-atlas", scopeType: "project", scopeId: projectId })).status()).toBe(204);
  expect((await api("pm-atlas", path)).status()).toBe(404);
  await panel.getByRole("button", { name: "Refresh update suggestions" }).click();
  await expect(panel).not.toContainText("Delivery status");
});
