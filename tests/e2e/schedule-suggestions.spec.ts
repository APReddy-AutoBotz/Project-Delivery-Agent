import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

const portfolioId = "20000000-0000-4000-8000-000000000001";
test.setTimeout(90000);

test("EXEC-022: scoped schedule suggestions revalidate across view and access changes", async ({ page, request, browser }) => {
  const tokens: Record<string, string> = {};
  for (const persona of ["operator", "pmo-portfolio", "pm-atlas", "leader-atlas"]) {
    const response = await request.post("/api/auth/development", { data: { persona } });
    expect(response.status()).toBe(200);
    tokens[persona] = (await response.json()).token;
  }
  const api = (persona: string, path: string, method = "GET", data?: unknown) => request.fetch("/api" + path, {
    method,
    headers: { Authorization: `Bearer ${tokens[persona]}` },
    ...(data === undefined ? {} : { data }),
  });
  expect((await api("operator", "/access-grants", "POST", {
    subject: "pmo-portfolio", role: "pmo_admin", scopeType: "portfolio", scopeId: portfolioId,
  })).status()).toBe(204);
  const fixture = canonicalFixture(portfolioId);
  fixture.code = `ADV-${randomUUID().slice(0, 8)}`;
  fixture.name = `Schedule advice ${randomUUID().slice(0, 8)}`;
  fixture.responsibilities = fixture.responsibilities.map((entry: { role: string; subject: string }) =>
    entry.role === "PROJECT_MANAGER" ? { ...entry, subject: "pm-atlas" } : entry,
  );
  fixture.workItems[0].state = "COMPLETE";
  const created = await api("pmo-portfolio", "/projects", "POST", fixture);
  expect(created.status()).toBe(201);
  const projectId: string = (await created.json()).id;
  expect((await api("operator", "/access-grants", "POST", {
    subject: "pm-atlas", role: "project_manager", scopeType: "project", scopeId: projectId,
  })).status()).toBe(204);
  expect((await api("operator", "/access-grants", "POST", {
    subject: "leader-atlas", role: "leadership", scopeType: "project", scopeId: projectId,
  })).status()).toBe(204);
  const first = await api("pm-atlas", `/projects/${projectId}/delivery-suggestions`);
  expect(first.status()).toBe(200);
  expect(first.headers()["cache-control"]).toBe("no-store");
  const firstView = await first.json();
  expect(firstView).toMatchObject({
    projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY",
    sourceAuthority: "NOT_ASSESSED", approvalItems: "UNAVAILABLE",
  });

  await page.goto("/");
  await page.getByRole("button", { name: /^Project manager / }).click();
  await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
  const panel = page.getByRole("region", { name: "Schedule suggestions" });
  await expect(panel).toContainText("Schedule suggestions evaluated at");
  await expect(panel).toContainText("Source authority has not been assessed");
  await expect(panel).toContainText("Approval items are unavailable");
  await expect(panel).toContainText("MS-1");
  await expect(panel).toContainText("ACTIVE");
  await expect(panel).toContainText("CLEAR");
  await expect(panel).toContainText("minimumOverdueDays");
  await expect(panel).toContainText("Calculation schedule-health@2");

  const route = `**/api/projects/${projectId}/delivery-suggestions`;
  await page.route(route, (intercepted) => intercepted.fulfill({ status: 200, json: { ...firstView, items: [] } }));
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await expect(panel).toContainText("No rule-based suggestions were produced");
  await expect(panel).toContainText("Approval items remain unavailable");
  await page.unroute(route);
  await page.route(route, (intercepted) => intercepted.fulfill({ status: 503, json: { statusCode: 503, message: "Unavailable" } }));
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await expect(panel).toContainText("Suggestions are unavailable");
  await expect(panel).not.toContainText("No rule-based suggestions were produced");
  await page.unroute(route);
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await expect(panel).toContainText("MS-1");

  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route(route, async (intercepted) => { arrived(); await held; await intercepted.continue(); });
  const lateProjectResponse = page.waitForResponse((response) => response.url().endsWith(`/projects/${projectId}/delivery-suggestions`));
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await entered;
  await expect(panel).not.toContainText("MS-1");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Atlas · Customer platform/ }).click();
  release();
  const oldProjectResponse = await lateProjectResponse;
  expect(oldProjectResponse.status()).toBe(200);
  await oldProjectResponse.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.unroute(route);
  await expect(page.getByRole("region", { name: "Schedule suggestions" })).not.toContainText("MS-1");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
  await expect(panel).toContainText("MS-1");

  let releaseVisibility!: () => void;
  let arrivedVisibility!: () => void;
  const heldVisibility = new Promise<void>((resolve) => { releaseVisibility = resolve; });
  const enteredVisibility = new Promise<void>((resolve) => { arrivedVisibility = resolve; });
  await page.route(route, async (intercepted) => { arrivedVisibility(); await heldVisibility; await intercepted.continue(); });
  const visibilityResponse = page.waitForResponse((response) => response.url().endsWith(`/projects/${projectId}/delivery-suggestions`));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await enteredVisibility;
  await expect(panel).not.toContainText("MS-1");
  releaseVisibility();
  const refreshedVisibilityResponse = await visibilityResponse;
  expect(refreshedVisibilityResponse.status()).toBe(200);
  await refreshedVisibilityResponse.finished();
  await page.unroute(route);
  await expect(panel).toContainText("MS-1");

  let releaseSession!: () => void;
  let arrivedSession!: () => void;
  const heldSession = new Promise<void>((resolve) => { releaseSession = resolve; });
  const enteredSession = new Promise<void>((resolve) => { arrivedSession = resolve; });
  await page.route(route, async (intercepted) => { arrivedSession(); await heldSession; await intercepted.continue(); });
  const lateSessionResponse = page.waitForResponse((response) => response.url().endsWith(`/projects/${projectId}/delivery-suggestions`));
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await enteredSession;
  await page.getByRole("button", { name: "Sign out" }).click();
  releaseSession();
  const oldSessionResponse = await lateSessionResponse;
  expect(oldSessionResponse.status()).toBe(200);
  await oldSessionResponse.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.unroute(route);
  await expect(page.getByText("Rule-based suggestion — review required.")).toHaveCount(0);
  await page.getByRole("button", { name: /^Project manager / }).click();
  await page.getByRole("button", { name: new RegExp(fixture.name) }).click();
  await expect(panel).toContainText("MS-1");

  const leaderContext = await browser.newContext();
  try {
    const leaderPage = await leaderContext.newPage();
    await leaderPage.goto("/");
    await leaderPage.getByRole("button", { name: /^Leadership / }).click();
    await leaderPage.getByRole("button", { name: new RegExp(fixture.name) }).click();
    const leaderPanel = leaderPage.getByRole("region", { name: "Schedule suggestions" });
    await expect(leaderPanel).toContainText("Reported GREEN; schedule calculation RED");
    await expect(leaderPanel).toContainText("CLEAR");
    await expect(leaderPanel).toContainText("Review the schedule exposure and decide whether a recovery intervention is needed.");
  } finally {
    await leaderContext.close();
  }

  expect((await api("operator", "/access-grants", "DELETE", {
    subject: "pm-atlas", scopeType: "project", scopeId: projectId,
  })).status()).toBe(204);
  expect((await api("pm-atlas", `/projects/${projectId}/delivery-suggestions`)).status()).toBe(404);
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await expect(page.getByText("Rule-based suggestion — review required.")).toHaveCount(0);
});
