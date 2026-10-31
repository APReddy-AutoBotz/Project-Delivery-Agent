import { expect, test, type Locator, type Page } from "@playwright/test";
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
const oldMarker = "2098-01-02T03:04:05.000Z";
function oldPage(projectId: string, scalar: boolean, number: number) {
  return { requests: [{ id: id(800 + number), projectId,
    ...(scalar ? { factId: id(900 + number), factType: "project.schedule" } : { milestoneId: id(900 + number) }),
    createdAt: oldMarker, state: "OPEN", assignment: { id: id(950 + number), revision: 1,
      occurredAt: oldMarker, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }], next: null, live: true };
}
async function installPreviewProbe(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch; let firstCalls = 0, readersReleased = 0, completeBodies = 0, staleRendered = false;
    const initialSignals: (AbortSignal | null | undefined)[] = [];
    const marker = "2098-01-02T03:04:05.000Z";
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue?.includes(marker) || record.target.textContent?.includes(marker) || Array.from(record.addedNodes).some((node) => node.textContent?.includes(marker)))
          staleRendered = true;
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    (window as Window & { previewProbe?: () => { readersReleased: number; completeBodies: number; staleRendered: boolean; started: number; initialAborted: boolean } }).previewProbe =
      () => ({ readersReleased, completeBodies, staleRendered, started: firstCalls,
        initialAborted: initialSignals.every((signal) => signal?.aborted === true) });
    window.fetch = (input, init) => {
      if (!String(input).includes("reconciliation-requests")) return original(input, init);
      const first = ++firstCalls <= 2;
      if (first) initialSignals.push(init?.signal);
      return original(input, { ...init, signal: undefined }).then((response) => {
        if (first && response.body) {
          const getReader = response.body.getReader.bind(response.body);
          Object.defineProperty(response.body, "getReader", { value: () => {
            const reader = getReader(), release = reader.releaseLock.bind(reader), read = reader.read.bind(reader);
            const decoder = new TextDecoder(); let released = false, ended = false, body = "";
            reader.read = async () => {
              const result = await read();
              if (!result.done) body += decoder.decode(result.value, { stream: true });
              else if (!ended) {
                ended = true;
                try { if (JSON.parse(body + decoder.decode()).requests?.[0]?.createdAt === marker) completeBodies++; } catch { /* Invalid old body is not a completed observation. */ }
              }
              return result;
            };
            reader.releaseLock = () => { release(); if (!released) { released = true; readersReleased++; } };
            return reader;
          } });
        }
        return response;
      });
    };
  });
}
async function expectEmptyPreviewBatch(panel: Locator) {
  for (let index = 1; index <= 5; index++) {
    const row = panel.getByRole("heading", { name: `Preview project ${index}`, exact: true }).locator("..");
    await expect(row).toHaveCount(1);
    for (const kind of ["Milestone", "Scalar"]) {
      const category = row.getByRole("heading", { name: `${kind} reconciliation`, exact: true }).locator("..");
      await expect(category.getByText("No recorded open requests on this page.", { exact: true })).toHaveCount(1);
    }
  }
  await expect(panel).not.toContainText("Requests unavailable for this project and type");
}
function trackPreviewHandlers() {
  const pending: Promise<void>[] = []; let failures = 0;
  return {
    async run(work: () => Promise<void>) {
      let finish!: () => void;
      pending.push(new Promise<void>((resolve) => { finish = resolve; }));
      try { await work(); } catch (error) { failures++; throw error; } finally { finish(); }
    },
    async settle() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all(pending), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Preview route settlement timed out")), 5000);
        })]);
        expect(failures).toBe(0);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}

test("StrictMode mount replay permits an explicit preview load", async ({ page }) => {
  await page.goto("/test/pm-preview-strict-harness.html");
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect(panel.getByText("No recorded open requests on this page.")).toHaveCount(2);
});

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
  await expect(panel).toContainText("More may exist in the project");
  await expect(panel).toContainText("Requests unavailable for this project and type");
  await expect(panel).not.toContainText("private denial");
  await expect.poll(() => calls).toBe(9); expect(maximum).toBeLessThanOrEqual(2);
  await panel.getByRole("button", { name: "Next project batch" }).click();
  await expect(panel).toContainText("Project batch 2 of 2"); expect(calls).toBe(9);
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect.poll(() => calls).toBe(11);
});

for (const kind of ["milestone", "scalar"] as const) test(`explicit ${kind} pagination replaces the old live page`, async ({ page }) => {
  const paths: string[] = [];
  const endpoint = kind === "milestone" ? "reconciliation-requests" : "scalar-reconciliation-requests";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    if (path === `/projects/${id(1)}/${endpoint}`) {
      paths.push(url.search);
      const after = url.searchParams.has("afterId"), numbers = after ? [120, 121] : Array.from({ length: 20 }, (_, i) => 100 + i);
      const createdAt = after ? "2026-10-21T11:00:01.000Z" : asOf;
      const requests = numbers.map((number) => ({ id: id(number), projectId: id(1),
        ...(kind === "scalar" ? { factId: id(500), factType: "project.schedule" } : { milestoneId: id(500) }),
        createdAt, state: "OPEN", assignment: { id: id(600 + number), revision: 1,
          occurredAt: asOf, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }));
      return route.fulfill({ json: { requests, next: after ? null : { id: id(119), createdAt: asOf }, live: true } });
    }
    if (/\/(scalar-)?reconciliation-requests$/.test(path)) return route.fulfill({ json: empty });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  const project = panel.locator("article").filter({ has: page.getByRole("heading", { name: "Preview project 1", exact: true }) });
  const category = project.getByRole("heading", { name: `${kind === "milestone" ? "Milestone" : "Scalar"} reconciliation` }).locator("..");
  await expect(category.getByRole("button", { name: new RegExp(`Open ${kind} request`) })).toHaveCount(20);
  await category.getByRole("button", { name: "Next page" }).click();
  await expect(category.getByRole("button", { name: new RegExp(`Open ${kind} request`) })).toHaveCount(2);
  await expect(category).toContainText("2026-10-21T11:00:01.000Z");
  await expect(category).not.toContainText(asOf);
  expect(Object.fromEntries(new URLSearchParams(paths[1]))).toEqual({ limit: "20", afterCreatedAt: asOf, afterId: id(119) });
  await expect(project.getByText("This category was cleared.")).toBeVisible();
  await category.getByRole("button", { name: "Check first page" }).click();
  await expect(category.getByRole("button", { name: new RegExp(`Open ${kind} request`) })).toHaveCount(20);
  expect(new URLSearchParams(paths[2]).has("afterId")).toBe(false);
});

test("a queue refresh synchronously invalidates old row and next-page actions", async ({ page }) => {
  let nextCalls = 0, queueReads = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") { queueReads++; return route.fulfill({ json: queue }); }
    if (path === `/projects/${id(1)}/reconciliation-requests`) {
      if (url.searchParams.has("afterId")) nextCalls++;
      const requests = Array.from({ length: 20 }, (_, n) => ({ id: id(100 + n), projectId: id(1), milestoneId: id(500),
        createdAt: asOf, state: "OPEN", assignment: { id: id(600 + n), revision: 1, occurredAt: asOf, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }));
      return route.fulfill({ json: { requests, next: { id: id(119), createdAt: asOf }, live: true } });
    }
    if (/\/(scalar-)?reconciliation-requests$/.test(path)) return route.fulfill({ json: empty });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect(panel.getByRole("button", { name: "Next page" })).toHaveCount(1);
  const before = page.url();
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const refresh = buttons.find((button) => button.textContent?.trim() === "Refresh suggestions")!;
    const next = buttons.find((button) => button.textContent?.trim() === "Next page")!;
    const open = buttons.find((button) => button.getAttribute("aria-label")?.startsWith("Open milestone request"))!;
    refresh.click(); next.click(); open.click();
  });
  await expect.poll(() => queueReads).toBeGreaterThan(1);
  await expect(panel).toContainText("Load this batch");
  expect(nextCalls).toBe(0); expect(page.url()).toBe(before);
});

test("a denied next page clears both categories before its body finishes", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    const state = window as Window & { deniedPageCalls?: number; releasePageDenial?: () => void };
    state.deniedPageCalls = 0;
    window.fetch = (input, init) => {
      if (String(input).includes("reconciliation-requests?") && String(input).includes("afterId=")) {
        state.deniedPageCalls!++;
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          state.releasePageDenial = () => { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); };
        } }), { status: 403 }));
      }
      return original(input, init);
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    if (path === `/projects/${id(1)}/reconciliation-requests`) {
      const requests = Array.from({ length: 20 }, (_, n) => ({ id: id(100 + n), projectId: id(1), milestoneId: id(500),
        createdAt: asOf, state: "OPEN", assignment: { id: id(600 + n), revision: 1, occurredAt: asOf, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }));
      return route.fulfill({ json: { requests, next: { id: id(119), createdAt: asOf }, live: true } });
    }
    if (/\/(scalar-)?reconciliation-requests$/.test(path)) return route.fulfill({ json: empty });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  await expect(panel.getByRole("button", { name: "Next page" })).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Next page" })).toBeEnabled();
  try {
    await page.evaluate(() => {
      const next = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Next page")!;
      next.click(); next.click();
    });
    const project = panel.locator("article").filter({ has: page.getByRole("heading", { name: "Preview project 1", exact: true }) });
    await expect(project.getByText("Requests unavailable for this project and type.")).toHaveCount(2);
    await expect(project.getByRole("button", { name: /Open (milestone|scalar) request/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { deniedPageCalls: number }).deniedPageCalls)).toBe(1);
  } finally {
    await page.evaluate(() => (window as Window & { releasePageDenial?: () => void }).releasePageDenial?.());
  }
  await expect(panel).not.toContainText("Checking request access for this batch");
});

for (const transition of ["same-token session", "focus"] as const) test(`a delayed next page cannot publish after ${transition} change`, async ({ page }) => {
  const marker = "2098-01-02T03:04:05.000Z";
  await page.addInitScript(({ projectId, marker }) => {
    const original = window.fetch;
    const state = window as Window & { releaseLatePage?: () => void; latePageRendered?: boolean; latePageEOF?: boolean; resetLateObserver?: () => void };
    state.latePageRendered = false;
    state.latePageEOF = false;
    state.resetLateObserver = () => { state.latePageRendered = false; };
    new MutationObserver((records) => {
      if (records.some((record) => record.oldValue?.includes(marker) || record.target.textContent?.includes(marker) ||
        [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(marker)))) state.latePageRendered = true;
    }).observe(document, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    window.fetch = (input, init) => {
      if (String(input).includes("reconciliation-requests?") && String(input).includes("afterId="))
        return new Promise<Response>((resolve) => { state.releaseLatePage = () => {
          const response = new Response(JSON.stringify({ live: true, next: null,
          requests: [{ id: "30000000-0000-4000-8000-000000000120", projectId, milestoneId: "30000000-0000-4000-8000-000000000500",
            createdAt: marker, state: "OPEN", assignment: { id: "30000000-0000-4000-8000-000000000700", revision: 1,
              occurredAt: marker, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }] }), { status: 200 });
          const stream = response.body!, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader);
            reader.read = async () => { const part = await read(); if (part.done) state.latePageEOF = true; return part; };
            return reader;
          }) as typeof stream.getReader;
          resolve(response);
        }; });
      return original(input, init);
    };
  }, { projectId: id(1), marker });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    if (path === `/projects/${id(1)}/reconciliation-requests`) {
      const requests = Array.from({ length: 20 }, (_, n) => ({ id: id(100 + n), projectId: id(1), milestoneId: id(500),
        createdAt: asOf, state: "OPEN", assignment: { id: id(600 + n), revision: 1, occurredAt: asOf, reason: "ASSIGNED", recipientSubject: "pm-atlas" } }));
      return route.fulfill({ json: { requests, next: { id: id(119), createdAt: asOf }, live: true } });
    }
    if (/\/(scalar-)?reconciliation-requests$/.test(path)) return route.fulfill({ json: empty });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
  await page.evaluate((value) => { const canary = document.createElement("span"); canary.textContent = value; document.body.append(canary); canary.remove(); }, marker);
  await expect.poll(() => page.evaluate(() => (window as Window & { latePageRendered: boolean }).latePageRendered)).toBe(true);
  await page.evaluate(() => (window as Window & { resetLateObserver: () => void }).resetLateObserver());
  const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
  await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
  const next = panel.getByRole("button", { name: "Next page" });
  await expect(next).toBeEnabled(); await next.click();
  await expect.poll(() => page.evaluate(() => typeof (window as Window & { releaseLatePage?: () => void }).releaseLatePage)).toBe("function");
  try {
    if (transition === "same-token session") {
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("button", { name: /^Project manager / }).click();
    } else await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  } finally { await page.evaluate(() => (window as Window & { releaseLatePage?: () => void }).releaseLatePage?.()); }
  await expect.poll(() => page.evaluate(() => (window as Window & { latePageEOF: boolean }).latePageEOF)).toBe(true);
  await expect(panel).toContainText("Load this batch");
  await expect(panel).not.toContainText(marker);
  expect(await page.evaluate(() => (window as Window & { latePageRendered: boolean }).latePageRendered)).toBe(false);
});

test("refresh hides old previews and retains the lease until both late calls settle", async ({ page }) => {
  let calls = 0, releaseFirst!: () => void, releaseSecond!: () => void;
  const held = [new Promise<void>((resolve) => { releaseFirst = resolve; }),
    new Promise<void>((resolve) => { releaseSecond = resolve; })];
  const delivered: number[] = [], fresh = new Map<string, number>(), handlers = trackPreviewHandlers();
  await installPreviewProbe(page);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    const match = /^\/projects\/([^/]+)\/(scalar-)?reconciliation-requests$/.exec(path);
    if (match) return handlers.run(async () => {
      const number = ++calls;
      if (number <= 2) await held[number - 1];
      else { const key = `${match[1]}:${match[2] ? "scalar" : "milestone"}`; fresh.set(key, (fresh.get(key) ?? 0) + 1); }
      await route.fulfill({ json: number <= 2 ? oldPage(match[1]!, Boolean(match[2]), number) : empty });
      if (number <= 2) delivered.push(number);
    });
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
    releaseFirst(); await expect.poll(() => delivered).toEqual([1]);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { readersReleased: number } }).previewProbe().readersReleased)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { completeBodies: number } }).previewProbe().completeBodies)).toBe(1);
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel).toContainText("Previews are unavailable"); expect(calls).toBe(2);
    await expect(panel).not.toContainText("No recorded open requests on this page");
    releaseSecond(); await expect.poll(() => [...delivered].sort()).toEqual([1, 2]);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { readersReleased: number } }).previewProbe().readersReleased)).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { completeBodies: number } }).previewProbe().completeBodies)).toBe(2);
    await expect(panel).not.toContainText(oldMarker);
    await expect(async () => {
      if (calls === 2) await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
      await expect.poll(() => calls, { timeout: 1000 }).toBe(12);
    }).toPass({ timeout: 5000, intervals: [100] });
    expect([...fresh.keys()].sort()).toEqual(Array.from({ length: 5 }, (_, i) =>
      [`${id(i + 1)}:milestone`, `${id(i + 1)}:scalar`]).flat().sort());
    expect([...fresh.values()].every((count) => count === 1)).toBe(true);
    await expectEmptyPreviewBatch(panel);
    expect(await page.evaluate(() => (window as Window & { previewProbe: () => { staleRendered: boolean } }).previewProbe().staleRendered)).toBe(false);
  } finally {
    let snapshot: { started: number; initialAborted: boolean } | undefined;
    try { snapshot = await page.evaluate(() => { window.dispatchEvent(new Event("focus"));
      return (window as Window & { previewProbe?: () => { started: number; initialAborted: boolean } }).previewProbe?.(); }); }
    finally { releaseFirst(); releaseSecond();
      try { if (snapshot) await expect.poll(() => calls, { timeout: 5000 }).toBe(snapshot.started); }
      finally { await handlers.settle(); } }
    if (snapshot?.started) {
      expect(snapshot.initialAborted).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { readersReleased: number } }).previewProbe().readersReleased),
        { timeout: 5000 }).toBe(Math.min(snapshot.started, 2));
    }
  }
});

test("a stalled batch times out visibly but cannot overlap later browser requests", async ({ page }) => {
  let calls = 0, releaseFirst!: () => void, releaseSecond!: () => void;
  const held = [new Promise<void>((resolve) => { releaseFirst = resolve; }),
    new Promise<void>((resolve) => { releaseSecond = resolve; })];
  const delivered: number[] = [], fresh = new Map<string, number>(), handlers = trackPreviewHandlers();
  await installPreviewProbe(page);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-preview-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pm-atlas", customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [] });
    if (path === "/pm/action-queue") return route.fulfill({ json: queue });
    const match = /^\/projects\/([^/]+)\/(scalar-)?reconciliation-requests$/.exec(path);
    if (match) return handlers.run(async () => {
      const number = ++calls;
      if (number <= 2) await held[number - 1];
      else { const key = `${match[1]}:${match[2] ? "scalar" : "milestone"}`; fresh.set(key, (fresh.get(key) ?? 0) + 1); }
      await route.fulfill({ json: number <= 2 ? oldPage(match[1]!, Boolean(match[2]), number) : empty });
      if (number <= 2) delivered.push(number);
    });
    return route.fulfill({ status: 404, json: {} });
  });
  try {
    await page.clock.install(); await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).click();
    const panel = page.getByRole("region", { name: "Recorded reconciliation requests" });
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click(); await expect.poll(() => calls).toBe(2);
    await page.clock.fastForward(15001); await expect(panel).toContainText("Previews are unavailable");
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel).toContainText("Previews are unavailable"); expect(calls).toBe(2);
    releaseFirst(); await expect.poll(() => delivered).toEqual([1]);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { readersReleased: number } }).previewProbe().readersReleased)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { completeBodies: number } }).previewProbe().completeBodies)).toBe(1);
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel).toContainText("Previews are unavailable"); expect(calls).toBe(2);
    await expect(panel).not.toContainText("No recorded open requests on this page");
    releaseSecond(); await expect.poll(() => [...delivered].sort()).toEqual([1, 2]);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { readersReleased: number } }).previewProbe().readersReleased)).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { completeBodies: number } }).previewProbe().completeBodies)).toBe(2);
    await expect(panel).not.toContainText(oldMarker);
    await expect(async () => {
      if (calls === 2) await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
      await expect.poll(() => calls, { timeout: 1000 }).toBe(12);
    }).toPass({ timeout: 5000, intervals: [100] });
    expect([...fresh.keys()].sort()).toEqual(Array.from({ length: 5 }, (_, i) =>
      [`${id(i + 1)}:milestone`, `${id(i + 1)}:scalar`]).flat().sort());
    expect([...fresh.values()].every((count) => count === 1)).toBe(true);
    await expectEmptyPreviewBatch(panel);
    expect(await page.evaluate(() => (window as Window & { previewProbe: () => { staleRendered: boolean } }).previewProbe().staleRendered)).toBe(false);
  } finally {
    let snapshot: { started: number; initialAborted: boolean } | undefined;
    try { snapshot = await page.evaluate(() => { window.dispatchEvent(new Event("focus"));
      return (window as Window & { previewProbe?: () => { started: number; initialAborted: boolean } }).previewProbe?.(); }); }
    finally { releaseFirst(); releaseSecond();
      try { if (snapshot) await expect.poll(() => calls, { timeout: 5000 }).toBe(snapshot.started); }
      finally { await handlers.settle(); } }
    if (snapshot?.started) {
      expect(snapshot.initialAborted).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as Window & { previewProbe: () => { readersReleased: number } }).previewProbe().readersReleased),
        { timeout: 5000 }).toBe(Math.min(snapshot.started, 2));
    }
  }
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
