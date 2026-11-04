import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// Synthetic browser fixture with real loopback transport; it does not mount
// the product App or establish backend authorization or disclosure capture.
async function runCase(browser: Browser, mode: "navigation" | "current401" | "old401" | "current403" | "old403") {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Synthetic upstream must be local HTTP");
  const body = JSON.stringify({ rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
    approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" }, projects: [], items: [] });
  let held: ServerResponse | undefined, arrived!: () => void, reads = 0, correctAuth = true, prematurelyClosed = false;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    if (path === "/api/pm/action-queue") {
      reads++; correctAuth &&= req.headers.authorization === "Bearer synthetic-fixture-token" && req.method === "GET";
      if (reads === 1) { held = res; res.on("close", () => { if (!res.writableFinished) prematurelyClosed = true; }); arrived(); return; }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(body); return;
    }
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
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => original(input, init).then((response) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url, location.href).pathname !== "/api/pm/action-queue") return response;
        const status = response.status;
        Object.defineProperty(response, "status", { configurable: true, get() {
          (window as unknown as { queueHeadersSeen?: number }).queueHeadersSeen = status; return status;
        } });
        if (response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader();
            (window as unknown as { queueReaderSeen?: boolean }).queueReaderSeen = true;
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      });
    });
    await page.goto(`http://127.0.0.1:${address.port}/test-fixtures/protected-queue-transport.html`);
    await page.getByRole("button", { name: "Load queue" }).click();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Queue request did not arrive")), 15000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    if (mode === "navigation") {
      held!.writeHead(200, { "Content-Type": "application/json" }); held!.flushHeaders();
      await expect.poll(() => page.evaluate(() => (window as unknown as { queueHeadersSeen?: number }).queueHeadersSeen)).toBe(200);
      await expect.poll(() => page.evaluate(() => (window as unknown as { queueReaderSeen?: boolean }).queueReaderSeen ?? false)).toBe(true);
      await page.getByRole("button", { name: "Leave queue" }).click();
      await page.getByRole("button", { name: "Return to queue" }).click();
      await page.getByRole("button", { name: "Load queue" }).click();
      await expect(page.locator("#state")).toHaveText("unavailable"); expect(reads).toBe(1);
      expect(held!.writableEnded).toBe(false); expect(prematurelyClosed).toBe(false);
      held!.end(body);
      await expect(page.locator("#settled")).toHaveText("2");
      await page.getByRole("button", { name: "Load queue" }).click();
      await expect(page.locator("#state")).toHaveText("ready"); expect(reads).toBe(2);
    } else if (mode === "current403" || mode === "old403") {
      if (mode === "old403") {
        await page.getByRole("button", { name: "Leave queue" }).click();
        await page.getByRole("button", { name: "Return to queue" }).click();
      }
      const headers = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pm/action-queue" && response.status() === 403);
      held!.writeHead(403, { "Content-Type": "application/json" }); held!.flushHeaders(); await headers;
      await expect.poll(() => page.evaluate(() => (window as unknown as { queueHeadersSeen?: number }).queueHeadersSeen)).toBe(403);
      await expect.poll(() => page.evaluate(() => (window as unknown as { queueReaderSeen?: boolean }).queueReaderSeen ?? false)).toBe(true);
      await expect(page.locator("#state")).toHaveText(mode === "current403" ? "unavailable" : "idle");
      expect(held!.writableEnded).toBe(false); expect(prematurelyClosed).toBe(false);
      held!.end("{}"); await expect(page.locator("#settled")).toHaveText("1");
      await page.getByRole("button", { name: "Load queue" }).click();
      await expect(page.locator("#state")).toHaveText("ready"); expect(reads).toBe(2);
    } else {
      if (mode === "current401") await page.getByRole("button", { name: "Leave queue" }).click();
      else {
        await page.getByRole("button", { name: "New session" }).click();
        await page.evaluate(async () => {
          const state = window as unknown as { expiredSeen?: boolean; expiredObserver?: MutationObserver };
          state.expiredSeen = false;
          state.expiredObserver = new MutationObserver((records) => {
            if (records.some((record) => record.oldValue?.includes("expired") || record.target.textContent?.includes("expired") ||
              [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes("expired")))) state.expiredSeen = true;
          });
          state.expiredObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
          const canary = document.createElement("span"); canary.textContent = "before"; document.body.append(canary); await Promise.resolve();
          canary.firstChild!.textContent = "expired"; canary.firstChild!.textContent = "after"; canary.remove(); await Promise.resolve();
        });
        expect(await page.evaluate(() => (window as unknown as { expiredSeen?: boolean }).expiredSeen)).toBe(true);
        await page.evaluate(() => { (window as unknown as { expiredSeen?: boolean }).expiredSeen = false; });
      }
      const headers = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pm/action-queue" && response.status() === 401);
      held!.writeHead(401, { "Content-Type": "application/json" }); held!.flushHeaders();
      await headers;
      await expect.poll(() => page.evaluate(() => (window as unknown as { queueHeadersSeen?: number }).queueHeadersSeen)).toBe(401);
      await expect.poll(() => page.evaluate(() => (window as unknown as { queueReaderSeen?: boolean }).queueReaderSeen ?? false)).toBe(true);
      if (mode === "current401") await expect(page.locator("#state")).toHaveText("expired");
      else {
        await expect(page.locator("#state")).toHaveText("idle");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(page.locator("#state")).toHaveText("idle");
        expect(await page.evaluate(() => (window as unknown as { expiredSeen?: boolean }).expiredSeen)).toBe(false);
      }
      expect(held!.writableEnded).toBe(false); expect(prematurelyClosed).toBe(false);
      held!.end("{}"); await expect(page.locator("#settled")).toHaveText("1");
      if (mode === "old401") {
        expect(await page.evaluate(() => (window as unknown as { expiredSeen?: boolean }).expiredSeen)).toBe(false);
        await page.getByRole("button", { name: "Load queue" }).click();
        await expect(page.locator("#state")).toHaveText("ready"); expect(reads).toBe(2);
      } else expect(reads).toBe(1);
    }
    expect(correctAuth).toBe(true); expect(prematurelyClosed).toBe(false);
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
}

test("queue transport keeps one real request across navigation until its body completes", async ({ browser }) => {
  test.setTimeout(90000); await runCase(browser, "navigation");
});
test("stale-view 401 expires the same session before the real body completes", async ({ browser }) => {
  test.setTimeout(90000); await runCase(browser, "current401");
});
test("old real 401 cannot expire a replacement session using the same token", async ({ browser }) => {
  test.setTimeout(90000); await runCase(browser, "old401");
});
test("current real 403 reports unavailable before its body completes", async ({ browser }) => {
  test.setTimeout(90000); await runCase(browser, "current403");
});
test("old-view real 403 cannot disturb the current queue view", async ({ browser }) => {
  test.setTimeout(90000); await runCase(browser, "old403");
});
