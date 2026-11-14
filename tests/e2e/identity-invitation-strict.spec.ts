import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// StrictMode component harness, not a full-App or real authorization test.
test("strict replay permits a fresh invitation and denial clears only its owner's cache", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const locator = "20000000-0000-4000-8000-000000000001", requestId = "30000000-0000-4000-8000-000000000001";
  const view = { requestId, project: { id: locator, code: "S", name: "Strict current project" }, stageKind: "REQUEST", dueAt: "2026-01-01T00:00:00.000Z",
    capturedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", body: "Strict current invitation",
    requiredFacts: [{ factType: "project.forecast", label: "Forecast" }], rawResponseReaders: ["strict-actor"], responses: [], escalationContext: null };
  let old: ServerResponse | undefined, denial: ServerResponse | undefined, deny = false, prematurelyClosed = false;
  const calls: Array<{ cleanups: string | undefined; bearer: string | undefined; method: string | undefined }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    if (path === `/api/project-update-invitations/${locator}`) {
      calls.push({ cleanups: req.headers["x-fixture-cleanups"] as string | undefined, bearer: req.headers.authorization, method: req.method });
      if (deny && !denial) { denial = res; res.writeHead(403, { "Content-Type": "application/json", "x-strict-response": "denial" }); res.flushHeaders(); return; }
      if (!old && req.headers["x-fixture-cleanups"] === "0") {
        old = res; res.on("close", () => { if (!res.writableFinished) prematurelyClosed = true; });
        res.writeHead(200, { "Content-Type": "application/json", "x-strict-response": "old" }); res.flushHeaders(); return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "x-strict-response": "fresh" }); res.end(JSON.stringify(view)); return;
    }
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
        const response = await original(input, init), marker = response.headers.get("x-strict-response");
        if (marker && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            const state = window as unknown as { acquired?: string[]; eof?: string[]; released?: string[] };
            (state.acquired ??= []).push(marker);
            reader.read = async () => { const result = await read(); if (result.done) (state.eof ??= []).push(marker); return result; };
            reader.releaseLock = () => { release(); (state.released ??= []).push(marker); };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}/test-fixtures/invitation-strict.html`);
    try { await expect(page.getByText("Strict current invitation")).toBeVisible(); }
    catch { throw new Error(`Strict fixture did not recover; synthetic request metadata: ${JSON.stringify(calls)}`); }
    expect(await page.evaluate(() => (window as unknown as { fixtureCleanups?: number }).fixtureCleanups ?? 0)).toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => { const s = window as unknown as { eof?: string[]; released?: string[] }; return Boolean(s.eof?.includes("fresh") && s.released?.includes("fresh")); })).toBe(true);
    expect(old).toBeDefined();
    await expect.poll(() => page.evaluate(() => ((window as unknown as { acquired?: string[] }).acquired ?? []).includes("old"))).toBe(true);
    const calibrated = await page.evaluate(async () => {
      const state = window as unknown as { sawOld: boolean; oldObserver: MutationObserver }; state.sawOld = false;
      state.oldObserver = new MutationObserver((records) => {
        if (records.some((record) => record.oldValue?.includes("Strict old invitation") ||
          [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes("Strict old invitation")))) state.sawOld = true;
      });
      state.oldObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      const marker = document.createElement("p"); marker.textContent = "Strict old invitation"; document.body.append(marker); await Promise.resolve();
      const seen = state.sawOld; marker.remove(); await Promise.resolve(); state.sawOld = false; return seen;
    });
    expect(calibrated).toBe(true);
    expect(prematurelyClosed).toBe(false); old!.end(JSON.stringify({ ...view, body: "Strict old invitation" }));
    await expect.poll(() => page.evaluate(() => { const s = window as unknown as { eof?: string[]; released?: string[] }; return Boolean(s.eof?.includes("old") && s.released?.includes("old")); })).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText("Strict old invitation")).toHaveCount(0);
    expect(await page.evaluate(() => { const s = window as unknown as { sawOld: boolean; oldObserver: MutationObserver }; s.oldObserver.disconnect(); return s.sawOld; })).toBe(false);
    await page.evaluate(() => {
      const s = window as unknown as { seed: (owner: string, scope: string) => void };
      s.seed("strict-owner", "older-identity"); s.seed("other-owner", "older-identity");
    });
    expect(await page.evaluate(() => { const s = window as unknown as { cached: (owner: string, scope: string) => boolean };
      return [s.cached("strict-owner", "older-identity"), s.cached("other-owner", "older-identity"), s.cached("strict-owner", "strict-admission")]; })).toEqual([true, true, true]);
    deny = true; await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => Boolean(denial)).toBe(true);
    await expect(page.getByText("This update request is unavailable or has expired.")).toBeVisible();
    await expect.poll(() => page.evaluate(() => { const s = window as unknown as { acquired?: string[] }; return Boolean(s.acquired?.includes("denial")); })).toBe(true);
    expect(await page.evaluate(() => { const s = window as unknown as { cached: (owner: string, scope: string) => boolean };
      return [s.cached("strict-owner", "older-identity"), s.cached("other-owner", "older-identity"), s.cached("strict-owner", "strict-admission")]; })).toEqual([false, true, false]);
    expect(await page.evaluate(() => ((window as unknown as { eof?: string[] }).eof ?? []).includes("denial"))).toBe(false);
    const beforeRetry = calls.length;
    await page.getByRole("button", { name: "Check request access" }).click();
    await expect.poll(() => calls.length).toBe(beforeRetry + 1);
    await expect(page.getByText("Strict current invitation")).toBeVisible();
    expect(await page.evaluate(() => ((window as unknown as { eof?: string[] }).eof ?? []).includes("denial"))).toBe(false);
    denial!.end(JSON.stringify({ message: "Synthetic denial" }));
    await expect.poll(() => page.evaluate(() => { const s = window as unknown as { eof?: string[]; released?: string[] }; return Boolean(s.eof?.includes("denial") && s.released?.includes("denial")); })).toBe(true);
    await expect(page.getByText("Strict current invitation")).toBeVisible();
    expect(await page.evaluate(() => { const s = window as unknown as { cached: (owner: string, scope: string) => boolean };
      return [s.cached("other-owner", "older-identity"), s.cached("strict-owner", "strict-admission")]; })).toEqual([true, true]);
    expect(calls.every((call) => call.method === "GET" && call.bearer === "Bearer strict-synthetic-token")).toBe(true);
    expect(prematurelyClosed).toBe(false);
  } finally {
    try { if (old && !old.writableEnded && !old.destroyed) old.end(); }
    finally { try { if (denial && !denial.writableEnded && !denial.destroyed) denial.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } } }
  }
});
