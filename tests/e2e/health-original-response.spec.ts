import { expect, test, type Browser, type BrowserContext, type Request } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createDisclosureCheck, observeBrowserDisclosure } from "../../scripts/acceptance/disclosure.mjs";

// The generated canary is synthetic; avoid retaining it in failure artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

// Real loopback transport and the production CDP recorder exercise the actual
// app. No Playwright route mock, remote database or customer data is used.
async function heldProjectResponse(browser: Browser, injectCanary: boolean) {
  const projectId = "30000000-0000-4000-8000-000000000001";
  const customerId = "10000000-0000-4000-8000-000000000001";
  const project = { id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "SAFE", name: "Synthetic held-response project", description: "Fixture", reportedStatus: "UNKNOWN" };
  const dates = { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null };
  const detail = { ...project, configured: true, portfolio: { id: "30000000-0000-4000-8000-000000000050", name: "Fixture" }, programme: null,
    creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 }, dates,
    responsibilities: [], sprints: [], milestones: [], workItems: [], requiredWorkItems: [], raidItems: [], sourceMappings: [], sourceMappingsWithheld: true };
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  const canary = randomBytes(32).toString("base64url");
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname))
    throw new Error("Synthetic application upstream must be local HTTP");
  let projectReads = 0, held: ServerResponse | undefined, heldClosed = false, arrived!: () => void;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === tokenPath) return json(200, { access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") });
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "synthetic-local-token" });
    if (path === "/api/me") return json(200, { subject: "synthetic-pm", customerId, roles: ["project_manager"] });
    if (path === "/api/projects") return json(200, [project]);
    if (path === `/api/projects/${projectId}`) {
      projectReads++;
      if (projectReads === 2) {
        held = res; res.on("close", () => { if (!res.writableFinished) heldClosed = true; });
        res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "held-project" }); res.flushHeaders(); arrived(); return;
      }
      return json(200, project);
    }
    if (path === `/api/projects/${projectId}/canonical`) return json(200, detail);
    if (path === `/api/projects/${projectId}/health-assessments/latest`) return json(200, null);
    if (path === `/api/projects/${projectId}/facts`) return json(200, { canAppend: false, canConfigure: false, facts: [], next: null });
    if (path.startsWith("/api/")) return json(404, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
  });
  let context: BrowserContext | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    context = await browser.newContext();
    const heldIds = new Set<string>(), continued = new Set<string>(), bodies = new Map<string, string>();
    const heldNetworkIds = new Set<string>(), coordinatorNetworkIds = new Set<string>(), abortedNetworkIds = new Set<string>();
    const originalSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (target) => {
      const session = await originalSession(target);
      session.on("Network.requestWillBeSent", (event) => {
        if (new URL(event.request.url).pathname !== `/api/projects/${projectId}`) return;
        let stack = event.initiator.stack;
        while (stack) {
          if (stack.callFrames.some((frame) => frame.url.includes("health-scope-context"))) coordinatorNetworkIds.add(event.requestId);
          stack = stack.parent;
        }
      });
      session.on("Network.loadingFailed", (event) => { if (event.errorText === "net::ERR_ABORTED") abortedNetworkIds.add(event.requestId); });
      session.on("Fetch.requestPaused", (event) => {
        if (event.responseHeaders?.some((header) => header.name.toLowerCase() === "x-synthetic-case" && header.value === "held-project")) {
          heldIds.add(event.requestId); if (event.networkId) heldNetworkIds.add(event.networkId);
        }
      });
      const originalSend = session.send.bind(session);
      session.send = (async (method: string, params?: { requestId?: string }) => {
        const result = await originalSend(method as Parameters<typeof originalSend>[0], params);
        if (params?.requestId && heldIds.has(params.requestId) && method === "Fetch.getResponseBody") {
          const body = result as { body: string; base64Encoded: boolean };
          bodies.set(params.requestId, Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8").toString("utf8"));
        }
        if (params?.requestId && heldIds.has(params.requestId) && method === "Fetch.continueRequest") continued.add(params.requestId);
        return result;
      }) as typeof session.send;
      await session.send("Network.enable");
      return session;
    };
    await context.addInitScript((id) => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url, location.href).pathname === `/api/projects/${id}`) {
          const state = window as unknown as { projectSignals?: boolean[]; projectSignalAborts?: boolean[] };
          const index = state.projectSignals?.length ?? 0;
          state.projectSignals = [...(state.projectSignals ?? []), Boolean(init?.signal)];
          state.projectSignalAborts ??= []; state.projectSignalAborts[index] = Boolean(init?.signal?.aborted);
          init?.signal?.addEventListener("abort", () => { state.projectSignalAborts![index] = true; }, { once: true });
        }
        return original(input, init);
      };
    }, projectId);
    const disclosure = createDisclosureCheck([canary]);
    const capture = await observeBrowserDisclosure(context, origin, disclosure);
    const page = await capture.newPage();
    const projectRequests = new Map<Request, number>(); let heldRequestFailed = false;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/projects/${projectId}`) projectRequests.set(request, projectRequests.size + 1);
    });
    page.on("requestfailed", (request) => { if (projectRequests.get(request) === 2) heldRequestFailed = true; });
    await page.goto(origin);
    await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath);
    await capture.settle(page);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    await capture.settle(page);
    await page.getByRole("button", { name: /Synthetic held-response project/ }).click();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Held project request did not start")), 15000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    await expect.poll(() => page.evaluate(() => (window as unknown as { projectSignals?: boolean[] }).projectSignals?.length ?? 0)).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as unknown as { projectSignals: boolean[] }).projectSignals[1])).toBe(false);
    await expect(page.getByRole("heading", { name: "Schedule and blocker age" })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => projectReads).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("heading", { name: "Schedule and blocker age" })).toBeVisible();
    await expect(page.getByText("No saved assessment yet", { exact: false })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { projectSignalAborts: boolean[] }).projectSignalAborts[1])).toBe(false);
    expect(heldClosed).toBe(false);
    const heldProject = injectCanary ? { ...project, description: canary } : project;
    held!.end(JSON.stringify(heldProject));
    await capture(page);
    if (injectCanary) expect(await page.evaluate((value) => document.body.textContent?.includes(value) ?? false, canary)).toBe(false);
    await capture.close();
    expect(heldIds.size).toBe(1);
    expect(heldNetworkIds.size).toBe(1);
    expect(coordinatorNetworkIds.has([...heldNetworkIds][0]!)).toBe(true);
    expect(abortedNetworkIds.has([...heldNetworkIds][0]!)).toBe(false);
    expect(heldRequestFailed).toBe(false);
    const [heldId] = [...heldIds]; expect(heldId).toBeTruthy();
    expect(bodies.get(heldId!) === JSON.stringify(heldProject)).toBe(true);
    expect(continued.has(heldId!)).toBe(true);
    if (injectCanary) {
      expect(() => disclosure.verify(["browser-response-bodies"])).toThrow("Secret disclosure detected");
    } else {
      expect(disclosure.verify(["browser-response-bodies"])["browser-response-bodies"].captures).toBeGreaterThan(0);
    }
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally {
      try { await context?.close(); }
      finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  }
}

test("SEC-SECRET-001: scope revalidation retains a held original project response", async ({ browser }) => {
  test.setTimeout(90000); await heldProjectResponse(browser, false);
});

test("SEC-SECRET-001: the recorder detects a canary in the stale original response", async ({ browser }) => {
  test.setTimeout(90000); await heldProjectResponse(browser, true);
});

test("SEC-SECRET-001: an intentionally aborted original 2xx GET remains incomplete", async ({ browser }) => {
  test.setTimeout(90000);
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  let held: ServerResponse | undefined, paused!: (id: string) => void;
  const intercepted = new Promise<string>((resolve) => { paused = resolve; });
  const server = createServer((req, res) => {
    if (req.url === "/api/synthetic-abort") {
      held = res; res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "abort-control" }); res.flushHeaders(); return;
    }
    if (req.url === tokenPath) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") })); return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }); res.end("<h1>Synthetic control</h1>");
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error); server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
  });
  let context: BrowserContext | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    context = await browser.newContext(); const aborted = new Set<string>();
    const originalSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (target) => {
      const session = await originalSession(target);
      session.on("Fetch.requestPaused", (event) => {
        if (event.responseStatusCode === 200 && event.responseHeaders?.some((header) => header.name.toLowerCase() === "x-synthetic-case" && header.value === "abort-control") && event.networkId)
          paused(event.networkId);
      });
      session.on("Network.loadingFailed", (event) => { if (event.errorText === "net::ERR_ABORTED") aborted.add(event.requestId); });
      await session.send("Network.enable"); return session;
    };
    const disclosure = createDisclosureCheck([randomBytes(32).toString("base64url")]);
    const capture = await observeBrowserDisclosure(context, origin, disclosure), page = await capture.newPage();
    await page.goto(origin); await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath);
    await capture.settle(page);
    await page.evaluate(() => {
      const controller = new AbortController();
      (window as unknown as { abortControl: () => void }).abortControl = () => controller.abort();
      void fetch("/api/synthetic-abort", { signal: controller.signal }).catch(() => {});
    });
    let timer: ReturnType<typeof setTimeout> | undefined; let networkId: string;
    try { networkId = await Promise.race([intercepted, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Abort control did not reach headers")), 15000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    await page.evaluate(() => (window as unknown as { abortControl: () => void }).abortControl());
    await expect.poll(() => aborted.has(networkId)).toBe(true);
    if (held && !held.writableEnded && !held.destroyed) held.end("{}");
    await expect(capture(page)).rejects.toThrow("Browser disclosure capture incomplete");
    const diagnostic = capture.diagnostic();
    expect(diagnostic.counters.requests).toBeGreaterThan(0);
    // CDP observed the 200 headers while the recorder paused delivery; at the
    // Playwright request-failure stage no Response was yet exposed to it.
    expect(diagnostic.request).toMatchObject({ resource: "other", method: "GET", failure: "aborted", response: "none", phase: "identity" });
    await capture.close().catch(() => {});
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally {
      try { await context?.close(); }
      finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  }
});


// These controls use the actual application request helper and original
// loopback response body. They do not exercise the production API or database.
async function assessmentOriginalResponse(browser: Browser, status: 200 | 201) {
  const projectId = "30000000-0000-4000-8000-000000000001";
  const customerId = "10000000-0000-4000-8000-000000000001";
  const project = { id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "ASSESS", name: "Synthetic assessment transport project", description: "Fixture", reportedStatus: "UNKNOWN" };
  const dates = { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null };
  const detail = { ...project, configured: true, portfolio: { id: "30000000-0000-4000-8000-000000000050", name: "Fixture" }, programme: null,
    creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 }, dates,
    responsibilities: [], sprints: [], milestones: [], workItems: [], requiredWorkItems: [], raidItems: [], sourceMappings: [], sourceMappingsWithheld: true };
  const responseBody = (index: number) => JSON.stringify({ assessmentId: `30000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`, projectId,
    assessedAt: "2026-10-21T00:00:00.000Z", coverage: "SCHEDULE_ONLY", ruleRevision: "schedule-health@1",
    envelopeHash: "a".repeat(64), contentAvailable: false, input: null, result: null, replayed: false });
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token", canary = randomBytes(32).toString("base64url");
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Synthetic upstream must be local HTTP");
  let posts = 0; const commandKeys: string[] = [], expectedBodies: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === tokenPath) return json(200, { access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") });
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "synthetic-local-token" });
    if (path === "/api/me") return json(200, { subject: "synthetic-leader", customerId, roles: ["leadership"] });
    if (path === "/api/projects") return json(200, [project]);
    if (path === `/api/projects/${projectId}`) return json(200, project);
    if (path === `/api/projects/${projectId}/canonical`) return json(200, detail);
    if (path === `/api/projects/${projectId}/health-assessments/latest`) return json(200, null);
    if (path === `/api/projects/${projectId}/health-assessments` && req.method === "POST") {
      posts++; const responseIndex = posts, chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { commandKey: string };
          commandKeys.push(input.commandKey);
          const body = responseBody(responseIndex); expectedBodies.push(body);
          res.writeHead(status, { "Content-Type": "application/json", "x-synthetic-case": "assessment-original" }); res.end(body);
        } catch { json(400, { message: "Invalid fixture request" }); }
      }); return;
    }
    if (path === `/api/projects/${projectId}/facts`) return json(200, { canAppend: false, canConfigure: false, facts: [], next: null });
    if (path.startsWith("/api/")) return json(404, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error); server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
  });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    context = await browser.newContext();
    const responseIds = new Set<string>(), captured = new Map<string, string>(), continued = new Set<string>();
    const originalSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (target) => {
      const session = await originalSession(target);
      session.on("Fetch.requestPaused", (event) => {
        if (event.responseHeaders?.some((header) => header.name.toLowerCase() === "x-synthetic-case" && header.value === "assessment-original")) responseIds.add(event.requestId);
      });
      const originalSend = session.send.bind(session);
      session.send = (async (method: string, params?: { requestId?: string }) => {
        const result = await originalSend(method as Parameters<typeof originalSend>[0], params);
        if (params?.requestId && responseIds.has(params.requestId) && method === "Fetch.getResponseBody") {
          const body = result as { body: string; base64Encoded: boolean };
          captured.set(params.requestId, Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8").toString("utf8"));
        }
        if (params?.requestId && responseIds.has(params.requestId) && method === "Fetch.continueRequest") continued.add(params.requestId);
        return result;
      }) as typeof session.send;
      return session;
    };
    const disclosure = createDisclosureCheck([canary]), capture = await observeBrowserDisclosure(context, origin, disclosure);
    const page = await capture.newPage();
    const consoleKinds: { type: string; args: number }[] = [];
    page.on("console", (message) => {
      try {
        if (consoleKinds.length >= 32) return;
        const type = message.type();
        consoleKinds.push({ type: ["log", "debug", "info", "error", "warning", "dir", "trace", "assert"].includes(type) ? type : "other",
          args: Math.min(message.args().length, 32) });
      } catch { /* Diagnostic observation must not alter the recorder. */ }
    });
    await page.goto(origin); await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath); await capture.settle(page);
    await page.getByRole("button", { name: /^Leadership / }).click(); await capture.settle(page);
    await page.getByRole("button", { name: /Synthetic assessment transport project/ }).click();
    await expect(page.getByRole("button", { name: "Run assessment" })).toBeEnabled();
    await page.getByRole("button", { name: status === 201 ? "Run assessment" : "Assess schedule", exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    if (status !== 201) {
      await expect(page.getByRole("button", { name: "Assessment outcome unknown" })).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Assessment outcome unknown" }).first()).toBeDisabled();
      await expect(page.getByRole("button", { name: "Assessment outcome unknown" }).last()).toBeDisabled();
    }
    await capture(page);
    expect(responseIds.size).toBe(1);
    for (const responseId of responseIds) { expect(captured.get(responseId)).toBe(expectedBodies[0]); expect(continued.has(responseId)).toBe(true); }
    if (status === 201) {
      await expect(page.getByRole("button", { name: "Run assessment", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Assessment outcome unknown" })).toHaveCount(0);
      await page.getByRole("button", { name: "Run assessment", exact: true }).click();
      await expect.poll(() => posts).toBe(2); await capture(page);
      await expect(page.getByRole("button", { name: "Run assessment", exact: true })).toBeEnabled();
      expect(responseIds.size).toBe(2);
      expect([...responseIds].map((id) => captured.get(id)).sort()).toEqual([...expectedBodies].sort());
      for (const responseId of responseIds) expect(continued.has(responseId)).toBe(true);
      expect(commandKeys).toHaveLength(2); expect(commandKeys[1]).not.toBe(commandKeys[0]);
    }
    try { await capture.close(); }
    catch (error) {
      const counters: Record<string, number> = {};
      try {
        const cause = (error as Error & { cause?: Record<string, unknown> }).cause;
        for (const name of ["response", "headers", "body", "continuation", "console", "timeout", "targets", "requests", "unresolved"]) {
          const value = cause?.[name];
          if (typeof value === "number" && Number.isInteger(value) && value >= 0) counters[name] = Math.min(value, 32);
        }
      } catch { /* Keep only known numeric counters. */ }
      // Do not attach a raw protocol error: it may contain credentials or URLs.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Assessment response recorder incomplete: " + JSON.stringify({ counters, consoleKinds }));
    }
    expect(responseIds.size).toBe(status === 201 ? 2 : 1);
    expect([...responseIds].map((id) => captured.get(id)).sort()).toEqual([...expectedBodies].sort());
    for (const responseId of responseIds) expect(continued.has(responseId)).toBe(true);
    expect(disclosure.verify(["browser-response-bodies"])["browser-response-bodies"].captures).toBeGreaterThan(0);
    expect(posts).toBe(status === 201 ? 2 : 1);
  } finally {
    try { await context?.close(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
}

test("assessment confirmation consumes the original 201 over loopback", async ({ browser }) => {
  test.setTimeout(90000); await assessmentOriginalResponse(browser, 201);
});

test("assessment uncertainty consumes the original unexpected 200 over loopback", async ({ browser }) => {
  test.setTimeout(90000); await assessmentOriginalResponse(browser, 200);
});


// Header-time checks deliberately use native loopback without the CDP recorder:
// the recorder pauses original responses and cannot prove UI behavior before EOF.
async function heldMilestoneDenial(browser: Browser, status: 403 | 503, supersede = false) {
  const projectId = "30000000-0000-4000-8000-000000000001", milestoneId = "30000000-0000-4000-8000-000000000002";
  const customerId = "10000000-0000-4000-8000-000000000001";
  const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const project = { id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "HEAD", name: "Synthetic header project", description: "Fixture", reportedStatus: "UNKNOWN" };
  const dates = { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null };
  const detail = { ...project, configured: true, portfolio: { id: id(50), name: "Fixture" }, programme: null,
    creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 }, dates, responsibilities: [], sprints: [],
    milestones: [{ id: milestoneId, key: "MS-1", name: "First milestone", state: "COMPLETE", dates }],
    workItems: [], requiredWorkItems: [], raidItems: [], sourceMappings: [], sourceMappingsWithheld: true };
  const disagreement = () => {
    const now = Date.now(), validUntil = new Date(now + 60000).toISOString();
    const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20), provenance: "HUMAN_CONFIRMED",
      effectiveAt: new Date(now - 10000).toISOString(), observedAt: new Date(now - 10000).toISOString(),
      versionValidUntil: validUntil, assessedValidUntil: validUntil });
    return { projectId, milestoneId, bindingId: id(101), factId: id(102), factType: `canonical.state.${"0".repeat(29)}100`,
      asOf: new Date(now).toISOString(), policyRevisionId: id(103),
      positions: [{ state: "COMPLETE", supports: [support(110)] }, { state: "OPEN", supports: [support(111)] }] };
  };
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Synthetic upstream must be local HTTP");
  let held: ServerResponse | undefined, replacement: ServerResponse | undefined, arrived!: () => void, replacementArrived!: () => void;
  let heldClosed = false, reads = 0, writes = 0;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const replacementEntered = new Promise<void>((resolve) => { replacementArrived = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "synthetic-local-token" });
    if (path === "/api/me") return json(200, { subject: "synthetic-leader", customerId, roles: ["leadership"] });
    if (path === "/api/projects") return json(200, [project]);
    if (path === `/api/projects/${projectId}`) return json(200, project);
    if (path === `/api/projects/${projectId}/canonical`) return json(200, detail);
    if (path === `/api/projects/${projectId}/health-assessments/latest`) return json(200, null);
    if (path === `/api/projects/${projectId}/health-assessments` && req.method === "POST") { writes++; return json(503, { message: "Unavailable" }); }
    if (path === `/api/projects/${projectId}/facts`) return json(200, { canAppend: false, canConfigure: false, facts: [], next: null });
    if (path === "/api/pm/action-queue") return json(200, { projects: [] });
    if (path === `/api/projects/${projectId}/milestones/${milestoneId}/leadership-state-disagreement`) {
      reads++;
      if (reads === 2) { held = res; res.on("close", () => { if (!res.writableFinished) heldClosed = true; }); arrived(); return; }
      if (reads === 3 && supersede) { replacement = res; replacementArrived(); return; }
      return json(200, disagreement());
    }
    if (path.startsWith("/api/")) return json(503, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { const fail = (error: Error) => reject(error); server.once("error", fail);
    server.listen(0, "127.0.0.1", () => { server.off("error", fail); resolve(); }); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
    context = await browser.newContext(); const page = await context.newPage();
    await page.addInitScript((expectedStatus) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => originalFetch(input, init).then((response) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!new URL(url, location.href).pathname.endsWith("/leadership-state-disagreement") || response.status !== expectedStatus || !response.body) return response;
        const stream = response.body, getReader = stream.getReader.bind(stream);
        stream.getReader = (() => {
          const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
          reader.read = async () => {
            const result = await read();
            if (result.done) (window as unknown as { heldMilestoneEof?: boolean }).heldMilestoneEof = true;
            return result;
          };
          reader.releaseLock = () => { release(); (window as unknown as { heldMilestoneReleased?: boolean }).heldMilestoneReleased = true; };
          return reader;
        }) as typeof stream.getReader;
        return response;
      });
    }, status);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Synthetic header project/ }).click();
    await page.getByLabel("Milestone", { exact: true }).selectOption(milestoneId);
    await page.getByRole("button", { name: "Check for conflicting milestone states" }).click();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Refresh milestone state evidence" }).click();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Held request did not arrive")), 15000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    if (status === 403 || supersede) await page.getByRole("button", { name: "Refresh milestone state evidence" }).click();
    if (supersede) {
      await page.evaluate(async () => {
        const state = window as unknown as { oldErrorSeen?: boolean; oldErrorObserver?: MutationObserver };
        const marker = "Current conflicting state evidence could not be established";
        state.oldErrorSeen = false;
        state.oldErrorObserver = new MutationObserver((records) => {
          if (records.some((record) => record.oldValue?.includes(marker) || record.target.textContent?.includes(marker) ||
            [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(marker)))) state.oldErrorSeen = true;
        });
        state.oldErrorObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
        const canary = document.createElement("span"); canary.textContent = "initial"; document.body.append(canary); await Promise.resolve();
        canary.firstChild!.textContent = marker; canary.firstChild!.textContent = "cleared"; canary.remove(); await Promise.resolve();
      });
      expect(await page.evaluate(() => (window as unknown as { oldErrorSeen?: boolean }).oldErrorSeen)).toBe(true);
      await page.evaluate(() => { (window as unknown as { oldErrorSeen?: boolean }).oldErrorSeen = false; });
    }
    const matches = (url: string) => new URL(url).pathname.endsWith("/leadership-state-disagreement");
    const headers = page.waitForResponse((response) => matches(response.url()) && response.status() === status);
    held!.writeHead(status, { "Content-Type": "application/json" }); held!.flushHeaders();
    const original = (await headers).request(); let originalFailed = false;
    page.on("requestfailed", (request) => { if (request === original) originalFailed = true; });
    const finished = page.waitForEvent("requestfinished", (request) => request === original);
    if (status === 503 && !supersede) {
      await expect(page.getByText("Current conflicting state evidence could not be established", { exact: false })).toBeVisible();
      await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Run assessment", exact: true })).toBeDisabled();
    } else if (status === 403) {
      await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
      await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
    } else {
      await expect(page.getByText("Checking current milestone state evidence…")).toBeVisible();
      await expect(page.getByText("Current conflicting state evidence could not be established", { exact: false })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Run assessment", exact: true })).toBeDisabled();
    }
    expect(held!.writableEnded).toBe(false); expect(heldClosed).toBe(false); expect(reads).toBe(2); expect(writes).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { heldMilestoneEof?: boolean }).heldMilestoneEof ?? false)).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { heldMilestoneReleased?: boolean }).heldMilestoneReleased ?? false)).toBe(false);
    held!.end(JSON.stringify({ message: "Unavailable" })); await finished;
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldMilestoneEof?: boolean }).heldMilestoneEof ?? false)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldMilestoneReleased?: boolean }).heldMilestoneReleased ?? false)).toBe(true);
    expect(originalFailed).toBe(false);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (supersede) {
      let replacementTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([replacementEntered, new Promise<never>((_, reject) => { replacementTimer = setTimeout(() => reject(new Error("Replacement did not arrive")), 15000); })]); }
      finally { if (replacementTimer !== undefined) clearTimeout(replacementTimer); }
      await expect(page.getByText("Checking current milestone state evidence…")).toBeVisible();
      await expect(page.getByText("Current conflicting state evidence could not be established", { exact: false })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Run assessment", exact: true })).toBeDisabled(); expect(writes).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { oldErrorSeen?: boolean }).oldErrorSeen)).toBe(false);
      replacement!.writeHead(200, { "Content-Type": "application/json" }); replacement!.end(JSON.stringify(disagreement()));
      await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => (window as unknown as { oldErrorSeen?: boolean }).oldErrorSeen)).toBe(false);
      expect(reads).toBe(3); expect(writes).toBe(0);
    } else if (status === 503) {
      await page.getByRole("button", { name: "Refresh milestone state evidence" }).click();
      await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
      expect(reads).toBe(3);
    } else {
      await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
      expect(reads).toBe(2);
      await page.getByRole("button", { name: "Check access again", exact: true }).click();
      await expect(page.getByRole("button", { name: "Run assessment", exact: true })).toBeEnabled();
      await page.getByLabel("Milestone", { exact: true }).selectOption(milestoneId);
      await page.getByRole("button", { name: "Check for conflicting milestone states" }).click();
      await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
      expect(reads).toBe(3); expect(writes).toBe(0);
    }
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); if (replacement && !replacement.writableEnded && !replacement.destroyed) replacement.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
}

test("current milestone 503 hides evidence before its body ends", async ({ browser }) => {
  test.setTimeout(90000); await heldMilestoneDenial(browser, 503);
});

test("dirty milestone 403 latches health access before its body ends", async ({ browser }) => {
  test.setTimeout(90000); await heldMilestoneDenial(browser, 403);
});

test("superseded milestone 503 stays hidden while its replacement is held", async ({ browser }) => {
  test.setTimeout(90000); await heldMilestoneDenial(browser, 503, true);
});
