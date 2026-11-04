import { expect, test, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// Browser fixture combines the real queue driver and transport against a local
// synthetic server. It does not mount the product App or prove server auth.
for (const status of [403, 404, 503]) {
  test(`real queue driver coalesces a held superseded ${status}`, async ({ browser }) => {
    test.setTimeout(90000);
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Synthetic upstream must be local HTTP");
    const body = JSON.stringify({ rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
      approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" }, projects: [], items: [] });
    let held: ServerResponse | undefined, replacement: ServerResponse | undefined, firstArrived!: () => void, nextArrived!: () => void;
    let reads = 0, correctAuth = true, premature = false;
    const firstEntered = new Promise<void>((resolve) => { firstArrived = resolve; });
    const nextEntered = new Promise<void>((resolve) => { nextArrived = resolve; });
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      if (path === "/api/pm/action-queue") {
        reads++; correctAuth &&= req.method === "GET" && req.headers.authorization === "Bearer synthetic-fixture-token";
        if (reads === 2) { held = res; res.on("close", () => { if (!res.writableFinished) premature = true; }); firstArrived(); return; }
        if (reads === 3) { replacement = res; nextArrived(); return; }
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
      await page.addInitScript((expectedStatus) => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const isQueue = new URL(url, location.href).pathname === "/api/pm/action-queue";
          if (isQueue) {
            const state = window as unknown as { queueFetches?: number; driverReleased?: boolean; replacementAfterRelease?: boolean };
            state.queueFetches = (state.queueFetches ?? 0) + 1;
            if (state.queueFetches === 3) state.replacementAfterRelease = state.driverReleased === true;
          }
          return original(input, init).then((response) => {
            if (!isQueue || response.status !== expectedStatus || !response.body) return response;
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              (window as unknown as { driverReader?: boolean }).driverReader = true;
              reader.read = async () => { const value = await read(); if (value.done) (window as unknown as { driverEof?: boolean }).driverEof = true; return value; };
              reader.releaseLock = () => { release(); (window as unknown as { driverReleased?: boolean }).driverReleased = true; };
              return reader;
            }) as typeof stream.getReader;
            return response;
          });
        };
      }, status);
      await page.goto(`http://127.0.0.1:${address.port}/test-fixtures/protected-queue-transport.html`);
      await page.getByRole("button", { name: "Start queue driver" }).click();
      await expect(page.locator("#driver-state")).toHaveText("ready");
      await page.getByRole("button", { name: "Refresh queue driver" }).click();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([firstEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Held read did not arrive")), 15000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      await page.getByRole("button", { name: "Refresh queue driver" }).click();
      await page.evaluate(async () => {
        const state = window as unknown as { queueErrors?: Record<string, boolean>; queueErrorObserver?: MutationObserver };
        state.queueErrors = { unavailable: false, error: false };
        state.queueErrorObserver = new MutationObserver((records) => {
          for (const marker of ["unavailable", "error"]) {
            if (records.some((record) => record.oldValue?.includes(marker) || record.target.textContent?.includes(marker) ||
              [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(marker)))) state.queueErrors![marker] = true;
          }
        });
        state.queueErrorObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
        const canary = document.createElement("span"); canary.textContent = "before"; document.body.append(canary); await Promise.resolve();
        canary.firstChild!.textContent = "unavailable"; canary.firstChild!.textContent = "after"; await Promise.resolve();
        canary.firstChild!.textContent = "error"; canary.firstChild!.textContent = "after"; canary.remove(); await Promise.resolve();
      });
      expect(await page.evaluate(() => (window as unknown as { queueErrors?: Record<string, boolean> }).queueErrors)).toEqual({ unavailable: true, error: true });
      await page.evaluate(() => { (window as unknown as { queueErrors?: Record<string, boolean> }).queueErrors = { unavailable: false, error: false }; });
      held!.writeHead(status, { "Content-Type": "application/json" }); held!.flushHeaders();
      await expect.poll(() => page.evaluate(() => (window as unknown as { driverReader?: boolean }).driverReader ?? false)).toBe(true);
      await expect(page.locator("#driver-state")).toHaveText("loading");
      expect(reads).toBe(2); expect(held!.writableEnded).toBe(false); expect(premature).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { queueErrors?: Record<string, boolean> }).queueErrors)).toEqual({ unavailable: false, error: false });
      held!.end("{}");
      await expect.poll(() => page.evaluate(() => (window as unknown as { driverEof?: boolean }).driverEof ?? false)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as { driverReleased?: boolean }).driverReleased ?? false)).toBe(true);
      let nextTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([nextEntered, new Promise<never>((_, reject) => { nextTimer = setTimeout(() => reject(new Error("Replacement did not arrive")), 15000); })]); }
      finally { if (nextTimer !== undefined) clearTimeout(nextTimer); }
      expect(await page.evaluate(() => (window as unknown as { replacementAfterRelease?: boolean }).replacementAfterRelease)).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.locator("#driver-state")).toHaveText("loading");
      expect(await page.evaluate(() => (window as unknown as { queueErrors?: Record<string, boolean> }).queueErrors)).toEqual({ unavailable: false, error: false });
      replacement!.writeHead(200, { "Content-Type": "application/json" }); replacement!.end(body);
      await expect(page.locator("#driver-state")).toHaveText("ready");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => (window as unknown as { queueErrors?: Record<string, boolean> }).queueErrors)).toEqual({ unavailable: false, error: false });
      expect(reads).toBe(3); expect(correctAuth).toBe(true); expect(premature).toBe(false);
    } finally {
      try { if (held && !held.writableEnded && !held.destroyed) held.end(); if (replacement && !replacement.writableEnded && !replacement.destroyed) replacement.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
