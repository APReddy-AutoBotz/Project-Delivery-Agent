import { expect, test } from "@playwright/test";
import { buildBlockerAgeAdvice, buildPmActionQueue, buildScheduleAdviceSnapshot } from "../../packages/domain/dist/index.js";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = "10000000-0000-4000-8000-000000000001", asOf = "2026-10-21T11:00:00.000Z";
const queue = buildPmActionQueue(Array.from({ length: 6 }, (_, index) => {
  const projectId = id(index + 1);
  return { projectId, name: `Preview project ${index + 1}`,
    schedule: buildScheduleAdviceSnapshot({ asOf, recipient: { subject: "pm-atlas", audience: "project_manager" },
      snapshot: { projectId, projectRevision: 1, reportedStatus: "UNKNOWN", assessedAt: asOf,
        scheduleHealthPolicy: { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] },
        milestones: [], workItems: [] } }),
    update: { availability: "UNCONFIGURED" as const, asOf, projectId, audience: "project_manager" as const, approvalItems: "UNAVAILABLE" as const },
    blockerAge: buildBlockerAgeAdvice({ projectId, audience: "project_manager", asOf, coverage: "UNASSESSABLE",
      threshold: null, inventory: null, noOpenBlockers: null, candidates: [] }) };
}));
const empty = { requests: [], next: null, live: true };

test("explicit previews limit concurrency and distinguish denied and truncated pages", async ({ page }) => {
  let active = 0, maximum = 0, calls = 0; const projects = new Set<string>();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    const match = /^\/projects\/([^/]+)\/(scalar-)?reconciliation-requests$/.exec(path);
    if (!match) return route.fulfill({ status: 404, json: {} });
    const project = match[1]!; expect(projects.has(project)).toBe(false); projects.add(project);
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      if (project === id(1) && !match[2]) return await route.fulfill({ status: 403, json: { message: "private denial" } });
      if (project === id(2) && !match[2]) {
        const requests = Array.from({ length: 20 }, (_, n) => ({ id: id(100 + n), projectId: project, milestoneId: id(500),
          createdAt: asOf, state: "OPEN", assignment: { id: id(600 + n), revision: 1, occurredAt: asOf, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }));
        return await route.fulfill({ json: { requests, next: { id: requests[19]!.id, createdAt: asOf }, live: true } });
      }
      return await route.fulfill({ json: empty });
    } finally { active--; projects.delete(project); }
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await expect(panel).toContainText("Project batch 1 of 2"); expect(calls).toBe(0);
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect(panel).toContainText("First 20 shown; more may exist");
  await expect(panel).toContainText("Requests unavailable for this project and type");
  await expect(panel).not.toContainText("private denial");
  await expect.poll(() => calls).toBe(9); expect(maximum).toBeLessThanOrEqual(2);
  await panel.getByRole("button", { name: "Next project batch" }).click();
  await expect(panel).toContainText("Project batch 2 of 2"); expect(calls).toBe(9);
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect.poll(() => calls).toBe(11);
});

test("refresh hides old previews and retains the lease until both late calls settle", async ({ page }) => {
  let calls = 0, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, String(input).includes("reconciliation-requests") ? { ...init, signal: undefined } : init);
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    if (/\/reconciliation-requests$/.test(path)) { calls++; if (calls <= 2) await held; return route.fulfill({ json: empty }).catch(() => {}); }
    return route.fulfill({ status: 404, json: {} });
  });
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
    const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click(); await expect.poll(() => calls).toBe(2);
    await page.getByRole("button", { name: "Refresh suggestions" }).click();
    await expect(panel).toContainText("Load this batch");
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel).toContainText("Previews are unavailable"); expect(calls).toBe(2);
    release(); await page.waitForTimeout(100);
    await expect(panel).not.toContainText("No recorded open requests on this page");
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel).toContainText("No recorded open requests on this page");
  } finally { release(); }
});

test("a stalled batch times out visibly but cannot overlap later browser requests", async ({ page }) => {
  let calls = 0, release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => original(input, String(input).includes("reconciliation-requests") ? { ...init, signal: undefined } : init);
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    if (/\/(scalar-)?reconciliation-requests$/.test(path)) { calls++; if (calls <= 2) await held; return route.fulfill({ json: empty }).catch(() => {}); }
    return route.fulfill({ status: 404, json: {} });
  });
  try {
    await page.clock.install(); await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
    const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click(); await expect.poll(() => calls).toBe(2);
    await page.clock.fastForward(15001); await expect(panel).toContainText("Previews are unavailable");
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel).toContainText("Previews are unavailable"); expect(calls).toBe(2);
    release(); await page.waitForTimeout(100);
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel).toContainText("No recorded open requests on this page");
  } finally { release(); }
});

test("an unauthorized preview expires the current session without showing the response body", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    if (/\/(scalar-)?reconciliation-requests$/.test(path)) return route.fulfill({ status: 401, json: { message: "private expired response" } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect(page.getByRole("button", { name: /^Project manager / })).toBeVisible();
  await expect(panel).toHaveCount(0); await expect(page.getByText("private expired response")).toHaveCount(0);
});

test("a stalled project denial immediately clears an already visible request", async ({ page }) => {
  await page.addInitScript((project) => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith(`/projects/${project}/scalar-reconciliation-requests`)) {
        return new Promise<Response>((resolve) => {
          (window as Window & { releasePreviewDenial?: () => void }).releasePreviewDenial = () => resolve(new Response(
            new ReadableStream({ pull: () => new Promise<void>(() => {}) }), { status: 403 }));
        });
      }
      return original(input, init);
    };
  }, id(1));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    if (path === `/projects/${id(1)}/reconciliation-requests`) return route.fulfill({ json: {
      requests: [{ id: id(101), projectId: id(1), milestoneId: id(501), createdAt: asOf, state: "OPEN",
        assignment: { id: id(601), revision: 1, occurredAt: asOf, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }], next: null, live: true,
    } });
    if (/\/(scalar-)?reconciliation-requests$/.test(path)) return route.fulfill({ json: empty });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  const project = panel.locator("article").filter({ has: page.getByRole("heading", { name: "Preview project 1", exact: true }) });
  await expect(project.getByRole("button", { name: /Open milestone request/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as Window & { releasePreviewDenial?: () => void }).releasePreviewDenial)).toBe("function");
  await page.evaluate(() => (window as Window & { releasePreviewDenial: () => void }).releasePreviewDenial());
  await expect(project.getByRole("button", { name: /Open milestone request/ })).toHaveCount(0);
  await expect(project.getByText("Requests unavailable for this project and type.")).toHaveCount(2);
});

for (const oldStatus of [200, 401, 404]) test(`late ${oldStatus} from an old session cannot affect a new session with the same token`, async ({ page }) => {
  let projectReads = 0;
  await page.addInitScript((status) => {
    const original = window.fetch;
    const pending: Array<() => void> = []; let delivered = 0;
    const state = window as Window & { releaseOldDenials?: () => void; oldResponseCounts?: () => number[] };
    state.releaseOldDenials = () => pending.forEach((release) => release());
    state.oldResponseCounts = () => [pending.length, delivered];
    window.fetch = (input, init) => {
      if (!String(input).includes("reconciliation-requests")) return original(input, init);
      if (status === 200) return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        pending.push(() => { controller.enqueue(new TextEncoder().encode('{"requests":[],"next":null,"live":true}')); controller.close(); delivered++; });
      } }), { status }));
      return new Promise<Response>((resolve) => pending.push(() => { delivered++; resolve(new Response("{}", { status })); }));
    };
  }, oldStatus);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "same-synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") { projectReads++; return route.fulfill({ json: [] }); }
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect(panel).toContainText("Checking request access");
  await expect.poll(() => page.evaluate(() => (window as Window & { oldResponseCounts: () => number[] }).oldResponseCounts()[0])).toBe(2);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /^Project manager / }).click();
  await expect(panel).toContainText("Load this batch"); await page.waitForTimeout(100);
  const reads = projectReads;
  await page.evaluate(() => (window as Window & { releaseOldDenials: () => void }).releaseOldDenials());
  await expect.poll(() => page.evaluate(() => (window as Window & { oldResponseCounts: () => number[] }).oldResponseCounts()[1])).toBe(2);
  await page.waitForTimeout(200); expect(projectReads).toBe(reads);
  await expect(panel).toContainText("Load this batch");
  await expect(panel).not.toContainText("No recorded open requests on this page");
});

for (const kind of ["milestone", "scalar"] as const) {
  test(`opening a ${kind} preview enters the existing authorized request journey`, async ({ page }) => {
    const requestId = id(kind === "milestone" ? 701 : 702), project = id(1);
    let detailCalls = 0, forbiddenCalls = 0;
    const suffix = kind === "milestone" ? "reconciliation-requests" : "scalar-reconciliation-requests";
    const summary = { id: requestId, projectId: project, createdAt: asOf, state: "OPEN",
      assignment: { id: id(703), revision: 1, occurredAt: asOf, reason: "ASSIGNED", recipientSubject: "pm-atlas" },
      ...(kind === "milestone" ? { milestoneId: id(704) } : { factId: id(705), factType: "project.forecast" }) };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      if (route.request().method() !== "GET" && !path.startsWith("/auth/")) forbiddenCalls++;
      if (path.includes("/manage")) forbiddenCalls++;
      if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
      if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
      if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
      if (path === "/projects") return route.fulfill({ json: [] });
      if (path === "/pm/action-queue") return route.fulfill({ json: queue });
      if (path === `/projects/${project}/${suffix}/${requestId}`) { detailCalls++; return route.fulfill({ status: 404, json: {} }); }
      if (path === `/projects/${project}/${suffix}`) return route.fulfill({ json: { requests: [summary], next: null, live: true } });
      if (/\/(scalar-)?reconciliation-requests$/.test(path)) return route.fulfill({ json: empty });
      if (path === `/projects/${project}`) return route.fulfill({ json: { id: project, name: "Preview project 1", code: "P1", description: "Synthetic", reportedStatus: "UNKNOWN" } });
      if (path === `/projects/${project}/canonical`) return route.fulfill({ json: { milestones: [] } });
      if (path === `/projects/${project}/facts`) return route.fulfill({ json: { facts: [], next: null, canAppend: false, canConfigure: false } });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
    const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    const open = panel.getByRole("button", { name: new RegExp(`Open ${kind} request`) });
    await expect(open).toBeVisible(); expect(detailCalls).toBe(0); expect(forbiddenCalls).toBe(0);
    const detail = page.waitForResponse((response) => response.url().endsWith(`/projects/${project}/${suffix}/${requestId}`));
    await open.click(); expect((await detail).status()).toBe(404); await expect.poll(() => detailCalls).toBe(1);
    expect(new URL(page.url()).searchParams.get(kind === "milestone" ? "reconciliation" : "scalarReconciliation")).toBe(requestId);
    expect(new URL(page.url()).searchParams.get("project")).toBe(project);
    await expect(page.getByText("private expired response", { exact: false })).toHaveCount(0);
    expect(forbiddenCalls).toBe(0);
  });
}
