import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

test("a held old invitation original cannot replace a new actor's invitation", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", locator = "20000000-0000-4000-8000-000000000001";
  const requestId = "30000000-0000-4000-8000-000000000001", oldText = "Actor A private invitation canary";
  const view = (actor: string) => ({ requestId, project: { id: locator, code: "S", name: `${actor} project` }, stageKind: "REQUEST",
    dueAt: "2026-01-01T00:00:00.000Z", capturedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    body: actor === "actor-a" ? oldText : "Actor B current invitation", requiredFacts: [{ factType: "project.forecast", label: "Forecast" }],
    rawResponseReaders: [actor], responses: [], escalationContext: null });
  let actor = "actor-a", reads = 0, logins = 0, posts = 0, targetIdentity = 0, held: ServerResponse | undefined, prematurelyClosed = false;
  const calls: Array<{ method: string | undefined; bearer: string | undefined; identityDone: string | undefined }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") { logins++; return json(200, { token: "held-read-token" }); }
    if (path === "/api/me") { res.writeHead(200, { "Content-Type": "application/json", "x-held-test": "identity" });
      res.end(JSON.stringify({ customerId, subject: actor, roles: ["contributor"] })); return; }
    if (path === "/api/projects") return json(200, []);
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === `/api/project-update-invitations/${locator}/responses`) { posts++; return json(500, { message: "Unexpected" }); }
    if (path === `/api/project-update-invitations/${locator}`) {
      reads++; calls.push({ method: req.method, bearer: req.headers.authorization, identityDone: req.headers["x-held-identity-done"] as string | undefined });
      if (reads === 1) { held = res; res.on("close", () => { if (!res.writableFinished) prematurelyClosed = true; });
        res.writeHead(200, { "Content-Type": "application/json", "x-held-test": "old" }); res.flushHeaders(); return; }
      const recipient = targetIdentity > 0 && req.headers["x-held-identity-done"] === String(targetIdentity) ? "actor-b" : "actor-a";
      res.writeHead(200, { "Content-Type": "application/json", "x-held-test": `fresh-${reads}` }); res.end(JSON.stringify(view(recipient))); return;
    }
    if (path.startsWith("/api/")) return json(404, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback unavailable");
    context = await browser.newContext();
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        const state = window as unknown as { identityIssued?: number; identityDone?: number; oldAcquired?: boolean; oldEof?: boolean; oldReleased?: boolean; freshEof?: string[]; freshReleased?: string[]; signals?: boolean[]; redirects?: Array<RequestRedirect | undefined> };
        let identitySequence = 0;
        if (path === "/api/me") { state.identityIssued = (state.identityIssued ?? 0) + 1; identitySequence = state.identityIssued; }
        if (path.startsWith("/api/project-update-invitations/")) { (state.signals ??= []).push(Boolean(init?.signal)); (state.redirects ??= []).push(init?.redirect); }
        const headers = new Headers(init?.headers); headers.set("x-held-identity-done", String(state.identityDone ?? 0));
        const response = await original(input, { ...init, headers }), marker = response.headers.get("x-held-test");
        if (marker && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
            if (marker === "old") state.oldAcquired = true;
              reader.read = async () => { const result = await read(); if (result.done) { eof = true; if (marker === "old") state.oldEof = true; if (marker.startsWith("fresh-")) (state.freshEof ??= []).push(marker); } return result; };
              reader.releaseLock = () => { release(); if (marker === "identity" && eof) state.identityDone = identitySequence; if (marker === "old") state.oldReleased = true; if (marker.startsWith("fresh-")) (state.freshReleased ??= []).push(marker); };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}/update-requests/${locator}`);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { oldAcquired?: boolean }).oldAcquired))).toBe(true);
    expect(reads).toBe(1); expect(prematurelyClosed).toBe(false);
    targetIdentity = await page.evaluate(() => ((window as unknown as { identityIssued?: number }).identityIssued ?? 0) + 1);
    actor = "actor-b"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => calls.some((call, index) => index > 0 && call.identityDone === String(targetIdentity))).toBe(true);
    const freshMarker = `fresh-${calls.findIndex((call, index) => index > 0 && call.identityDone === String(targetIdentity)) + 1}`;
    await expect(page.getByText("Actor B current invitation")).toBeVisible();
    await expect.poll(() => page.evaluate((marker) => { const s = window as unknown as { freshEof?: string[]; freshReleased?: string[] }; return Boolean(s.freshEof?.includes(marker) && s.freshReleased?.includes(marker)); }, freshMarker)).toBe(true);
    const calibrated = await page.evaluate(async (canary) => {
      const state = window as unknown as { sawOld: boolean; observer: MutationObserver }; state.sawOld = false;
      state.observer = new MutationObserver((records) => {
        if (records.some((record) => record.oldValue?.includes(canary) || record.target.textContent?.includes(canary) ||
          [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(canary)))) state.sawOld = true;
      });
      state.observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true });
      const marker = document.createElement("p"); marker.textContent = canary; document.body.append(marker); await Promise.resolve();
      const seen = state.sawOld; state.sawOld = false;
      marker.setAttribute("hidden", ""); marker.removeAttribute("hidden"); await Promise.resolve(); const attributeSeen = state.sawOld;
      marker.remove(); await Promise.resolve(); state.sawOld = false; return seen && attributeSeen;
    }, oldText);
    expect(calibrated).toBe(true);
    held!.end(JSON.stringify(view("actor-a")));
    await expect.poll(() => page.evaluate(() => { const s = window as unknown as { oldEof?: boolean; oldReleased?: boolean }; return Boolean(s.oldEof && s.oldReleased); })).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText("Actor B current invitation")).toBeVisible();
    expect(await page.evaluate(() => { const s = window as unknown as { sawOld: boolean; observer: MutationObserver }; s.observer.disconnect(); return s.sawOld; })).toBe(false);
    expect(calls.every((call) => call.method === "GET" && call.bearer === "Bearer held-read-token")).toBe(true);
    expect(await page.evaluate(() => { const s = window as unknown as { signals: boolean[]; redirects: Array<RequestRedirect | undefined> };
      return s.signals.every((signal) => !signal) && s.redirects.every((redirect) => redirect === "error"); })).toBe(true);
    expect(logins).toBe(1); expect(posts).toBe(0); expect(prematurelyClosed).toBe(false);
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
});
