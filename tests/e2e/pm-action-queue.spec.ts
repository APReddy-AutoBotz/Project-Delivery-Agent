import { expect, test } from "@playwright/test";
import { buildBlockerAgeAdvice, buildPmActionQueue, buildScheduleAdviceSnapshot } from "../../packages/domain/dist/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const asOf = "2026-10-21T11:00:00.000Z";
const schedule = buildScheduleAdviceSnapshot({ asOf, recipient: { subject: "pm-atlas", audience: "project_manager" },
  snapshot: { projectId, projectRevision: 1, reportedStatus: "UNKNOWN", assessedAt: asOf,
    scheduleHealthPolicy: { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] },
    milestones: [{ id: "40000000-0000-4000-8000-000000000001", key: "M-PRIVATE-SYNTHETIC", state: "OPEN", forecastEnd: null, plannedEnd: null }], workItems: [] } });
const queue = buildPmActionQueue([{ projectId, name: "Synthetic queue project", schedule,
  update: { availability: "UNCONFIGURED", asOf, projectId, audience: "project_manager", approvalItems: "UNAVAILABLE" },
  blockerAge: buildBlockerAgeAdvice({ projectId, audience: "project_manager", asOf, coverage: "UNASSESSABLE",
    threshold: null, inventory: null, noOpenBlockers: null, candidates: [] }) }]);
const newSessionQueue = { ...queue, projects: queue.projects.map((project) => ({ ...project, name: "New session project" })) };

test("EXEC-026: PM queue hides stale or invalid responses across refresh and sign-out", async ({ page }) => {
  let behavior: "success" | "error" | "invalid" | "held" = "success";
  let sessions = 0, queueReads = 0;
  let release!: () => void, arrived!: () => void, finished!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const settled = new Promise<void>((resolve) => { finished = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const state = window as Window & { heldQueueEof?: boolean; heldQueueReleased?: boolean; queueDispatches?: Array<{ eof: boolean; released: boolean }> };
      if (String(input).endsWith("/api/pm/action-queue"))
        (state.queueDispatches ??= []).push({ eof: Boolean(state.heldQueueEof), released: Boolean(state.heldQueueReleased) });
      const response = await original(input, init);
      if (response.headers.get("x-synthetic-held-queue") !== "yes" || !response.body) return response;
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (() => {
        const reader = getReader(), read = reader.read.bind(reader), releaseLock = reader.releaseLock.bind(reader);
        reader.read = async () => { const result = await read();
          if (result.done) (window as Window & { heldQueueEof?: boolean }).heldQueueEof = true;
          return result; };
        reader.releaseLock = () => { releaseLock(); (window as Window & { heldQueueReleased?: boolean }).heldQueueReleased = true; };
        return reader;
      }) as typeof response.body.getReader;
      return response;
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: `synthetic-browser-token-${++sessions}` } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") {
      queueReads++;
      if (behavior === "held") {
        arrived();
        try { await held; await route.fulfill({ json: queue, headers: { "x-synthetic-held-queue": "yes" } }).catch(() => {}); }
        finally { finished(); }
        return;
      }
      if (behavior === "error") return route.fulfill({ status: 503, json: { statusCode: 503, message: "Unavailable" } });
      if (behavior === "invalid") return route.fulfill({ json: { ...queue, items: [] } });
      return route.fulfill({ json: sessions > 1 ? newSessionQueue : queue }).catch(() => {});
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Action suggestions" });
  await expect(panel).toContainText("M-PRIVATE-SYNTHETIC");
  await expect(panel).toContainText("Approvals and other categories are unavailable");
  await expect(panel).toContainText("Blocker-age review is unavailable");
  await expect(panel).toContainText("no update policy was configured");
  behavior = "error";
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await expect(panel).toContainText("Suggestions are unavailable");
  await expect(panel).not.toContainText("M-PRIVATE-SYNTHETIC");
  behavior = "success";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(panel).toContainText("M-PRIVATE-SYNTHETIC");
  const previousReads = queueReads;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => queueReads).toBeGreaterThan(previousReads);
  await expect(panel).toContainText("M-PRIVATE-SYNTHETIC");
  behavior = "invalid";
  await panel.getByRole("button", { name: "Refresh suggestions" }).click();
  await expect(panel).toContainText("Suggestions are unavailable");
  await expect(panel).not.toContainText("M-PRIVATE-SYNTHETIC");
  behavior = "held";
  try {
    await panel.getByRole("button", { name: "Refresh suggestions" }).click();
    await entered;
    const readsWithHeldOriginal = queueReads;
    await page.getByRole("button", { name: "Sign out" }).click();
    behavior = "success";
    await page.getByRole("button", { name: /^Project manager / }).click();
    await expect(panel).toContainText("Suggestions are unavailable");
    await expect(panel).not.toContainText("Synthetic queue project");
    expect(queueReads).toBe(readsWithHeldOriginal);
    release();
    await settled;
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & { heldQueueEof?: boolean }).heldQueueEof))).toBe(true);
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & { heldQueueReleased?: boolean }).heldQueueReleased))).toBe(true);
    await expect(panel).toContainText("New session project");
    expect(queueReads).toBe(readsWithHeldOriginal + 1);
    expect(await page.evaluate((previous) => (window as Window & { queueDispatches: Array<{ eof: boolean; released: boolean }> }).queueDispatches.slice(previous), readsWithHeldOriginal))
      .toEqual([{ eof: true, released: true }]);
  } finally { release(); }
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(panel).toContainText("New session project");
  await expect(panel).not.toContainText("Synthetic queue project");
});
