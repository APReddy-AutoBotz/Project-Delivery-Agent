import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// Synthetic actual-App header-time controls. Old originals stay owned even
// when their queue, view or same-token session has been replaced.
for (const mode of ["current-403", "stale-403", "current-404", "stale-404", "current-401", "stale-401", "old-session-401", "timeout"] as const) {
  test(`preview ${mode} handles headers before its held original ends`, async ({ browser }) => {
    if (mode === "timeout") test.setTimeout(60000);
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const projectId = "30000000-0000-4000-8000-000000000001", asOf = "2026-01-01T00:00:00.000Z";
    const queue = { rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
      approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" }, projects: [{ projectId, name: "Synthetic preview project",
      schedule: { projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY", sourceAuthority: "NOT_ASSESSED", approvalItems: "UNAVAILABLE", rankPolicyRevision: "advice-core@1", asOf, items: [] },
      update: { projectId, audience: "project_manager", availability: "UNCONFIGURED", approvalItems: "UNAVAILABLE", asOf },
      blockerAge: { projectId, audience: "project_manager", ruleRevision: "blocker-age@1", orderRevision: "blocker-review-order@1", timeZone: "UTC", asOf,
        coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, items: [] } }], items: [] };
    let held: ServerResponse | undefined, prematureClose = false, previews = 0, lists = 0, queues = 0, logins = 0;
    const requests: Array<{ method: string | undefined; bearer: string | undefined }> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") { logins++; return json(200, { token: "same-preview-token" }); }
      if (path === "/api/me") return json(200, { customerId: "10000000-0000-4000-8000-000000000001", subject: "preview-actor", roles: ["project_manager"] });
      if (path === "/api/projects") { lists++; return json(200, []); }
      if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
      if (path === "/api/pm/action-queue") {
        queues++;
        if (queues === 1) return json(200, queue);
        res.writeHead(200, { "Content-Type": "application/json", "x-fresh-queue": "yes" });
        res.end(JSON.stringify({ ...queue, projects: [{ ...queue.projects[0], name: "Fresh preview project" }] })); return;
      }
      if (path === `/api/projects/${projectId}/reconciliation-requests` || path === `/api/projects/${projectId}/scalar-reconciliation-requests`) {
        previews++; requests.push({ method: req.method, bearer: req.headers.authorization });
        if (previews === 1) { held = res; res.on("close", () => { if (!res.writableFinished) prematureClose = true; }); return; }
        return json(200, { requests: [], next: null, live: true });
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
          const state = window as unknown as { signals?: boolean[]; redirects?: Array<RequestRedirect | undefined>; releasedAtDispatch?: boolean[]; firstDispatch?: number; acquired?: boolean; eof?: boolean; released?: boolean;
            denialHeaders?: boolean; listAfterHeaders?: number; queueEof?: boolean; queueReleased?: boolean };
          if (path === "/api/projects" && state.denialHeaders) state.listAfterHeaders = (state.listAfterHeaders ?? 0) + 1;
          if (/^\/api\/projects\/[^/]+\/(scalar-)?reconciliation-requests$/.test(path)) {
            (state.signals ??= []).push(Boolean(init?.signal)); (state.redirects ??= []).push(init?.redirect);
            (state.releasedAtDispatch ??= []).push(Boolean(state.released)); state.firstDispatch ??= performance.now();
          }
          const response = await original(input, init);
          if (response.headers.get("x-fresh-queue") === "yes" && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              reader.read = async () => { const result = await read(); if (result.done) state.queueEof = true; return result; };
              reader.releaseLock = () => { release(); state.queueReleased = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          if (response.headers.get("x-preview-denial") === "held" && response.body) {
            state.denialHeaders = true;
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); state.acquired = true;
              reader.read = async () => { const result = await read(); if (result.done) state.eof = true; return result; };
              reader.releaseLock = () => { release(); state.released = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      const signIn = () => page.getByRole("button", { name: /^Project manager / }).first().click();
      await signIn();
      const panel = page.getByRole("region", { name: "Action suggestions" });
      await expect(panel.getByRole("heading", { name: "Synthetic preview project" })).toBeVisible();
      await expect.poll(() => lists).toBeGreaterThan(0);
      if (mode === "timeout") {
        const calibrated = await page.evaluate(async () => {
          const state = window as unknown as { timeoutErrorAt?: number; timeoutObserver: MutationObserver };
          state.timeoutObserver = new MutationObserver((records) => {
            if (state.timeoutErrorAt === undefined && records.some((record) => [...record.addedNodes].some((node) =>
              node.textContent?.includes("Previews are unavailable. Retry after the previous reads have finished.")))) state.timeoutErrorAt = performance.now();
          });
          state.timeoutObserver.observe(document.body, { childList: true, subtree: true });
          const marker = document.createElement("p"); marker.textContent = "Previews are unavailable. Retry after the previous reads have finished.";
          document.body.append(marker); await Promise.resolve(); const seen = state.timeoutErrorAt !== undefined;
          marker.remove(); await Promise.resolve(); state.timeoutErrorAt = undefined; return seen;
        });
        expect(calibrated).toBe(true);
      }
      await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
      await expect.poll(() => previews).toBe(1);
      if (mode === "timeout") {
        await expect(panel.getByText("Previews are unavailable. Retry after the previous reads have finished.")).toBeVisible({ timeout: 20000 });
        await expect.poll(() => page.evaluate(() => typeof (window as unknown as { timeoutErrorAt?: number }).timeoutErrorAt === "number")).toBe(true);
        const elapsed = await page.evaluate(() => {
          const state = window as unknown as { firstDispatch: number; timeoutErrorAt: number; timeoutObserver: MutationObserver };
          state.timeoutObserver.disconnect(); return state.timeoutErrorAt - state.firstDispatch;
        });
        expect(elapsed).toBeGreaterThanOrEqual(14500); expect(elapsed).toBeLessThan(22000);
        await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(previews).toBe(1); expect(prematureClose).toBe(false);
        held!.writeHead(200, { "Content-Type": "application/json", "x-preview-denial": "held" }); held!.flushHeaders();
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { acquired?: boolean }).acquired))).toBe(true);
        expect(await page.evaluate(() => Boolean((window as unknown as { eof?: boolean }).eof))).toBe(false);
        held!.end(JSON.stringify({ requests: [], next: null, live: true }));
        await expect.poll(() => page.evaluate(() => { const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released); })).toBe(true);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
        await expect(panel.getByText("No recorded open requests on this page.")).toHaveCount(2);
        expect(previews).toBe(3); expect(logins).toBe(1); expect(prematureClose).toBe(false);
        expect(requests.every((item) => item.method === "GET" && item.bearer === "Bearer same-preview-token")).toBe(true);
        expect(await page.evaluate(() => { const state = window as unknown as { signals: boolean[]; redirects: Array<RequestRedirect | undefined> };
          return state.signals.every((signal) => !signal) && state.redirects.every((redirect) => redirect === "error"); })).toBe(true);
        expect(await page.evaluate(() => (window as unknown as { releasedAtDispatch: boolean[] }).releasedAtDispatch)).toEqual([false, true, true]);
        return;
      }
      if (mode.startsWith("stale-")) {
        await panel.getByRole("button", { name: "Refresh suggestions" }).click();
        await expect.poll(() => queues).toBe(2);
        await expect(panel.getByRole("heading", { name: "Fresh preview project" })).toBeVisible();
      } else if (mode === "old-session-401") {
        await panel.evaluate((node) => { (window as unknown as { oldPanel: Element }).oldPanel = node; });
        await page.getByRole("button", { name: "Sign out" }).click(); await signIn();
        await expect.poll(() => logins).toBe(2);
        await expect.poll(() => page.evaluate(() => !(window as unknown as { oldPanel: Element }).oldPanel.isConnected)).toBe(true);
        await expect(panel.getByRole("heading", { name: "Fresh preview project" })).toBeVisible();
      }
      if (mode.startsWith("stale-") || mode === "old-session-401") await expect.poll(() => page.evaluate(() => {
        const state = window as unknown as { queueEof?: boolean; queueReleased?: boolean }; return Boolean(state.queueEof && state.queueReleased);
      })).toBe(true);
      if (mode === "stale-403" || mode === "stale-404") {
        const calibrated = await page.evaluate(async () => {
          const state = window as unknown as { sawUnavailable: boolean; denialObserver: MutationObserver };
          state.sawUnavailable = false;
          state.denialObserver = new MutationObserver((records) => {
            if (records.some((record) => record.oldValue?.includes("Requests unavailable for this project and type.") ||
              [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes("Requests unavailable for this project and type.")))) state.sawUnavailable = true;
          });
          state.denialObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
          const marker = document.createElement("p"); marker.textContent = "Requests unavailable for this project and type.";
          document.body.append(marker); await Promise.resolve(); const seen = state.sawUnavailable;
          marker.remove(); await Promise.resolve(); state.sawUnavailable = false;
          const text = document.createTextNode("baseline"); document.body.append(text); await Promise.resolve();
          text.data = "Requests unavailable for this project and type."; text.data = "baseline"; await Promise.resolve();
          const textSeen = state.sawUnavailable; text.remove(); await Promise.resolve(); state.sawUnavailable = false; return seen && textSeen;
        });
        expect(calibrated).toBe(true);
      }
      const baselineLists = lists;
      held!.writeHead(mode.endsWith("403") ? 403 : mode.endsWith("404") ? 404 : 401, { "Content-Type": "application/json", "x-preview-denial": "held" }); held!.flushHeaders();
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { acquired?: boolean }).acquired))).toBe(true);
      if (mode === "current-403" || mode === "current-404") {
        await expect(panel.getByText("Requests unavailable for this project and type.")).toHaveCount(2);
        await expect.poll(() => lists).toBeGreaterThan(baselineLists);
        await expect.poll(() => page.evaluate(() => (window as unknown as { listAfterHeaders?: number }).listAfterHeaders ?? 0)).toBeGreaterThan(0);
      } else if (mode === "current-401" || mode === "stale-401") {
        await expect(page.getByText("Your session has ended. Please sign in again.")).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        if (mode === "stale-403" || mode === "stale-404") {
          expect(lists).toBe(baselineLists);
          expect(await page.evaluate(() => (window as unknown as { listAfterHeaders?: number }).listAfterHeaders ?? 0)).toBe(0);
          expect(await page.evaluate(() => (window as unknown as { sawUnavailable: boolean }).sawUnavailable)).toBe(false);
        }
        await expect(panel.getByText("Requests unavailable for this project and type.")).toHaveCount(0);
      }
      expect(previews).toBe(1); expect(prematureClose).toBe(false);
      expect(await page.evaluate(() => Boolean((window as unknown as { eof?: boolean }).eof))).toBe(false);
      held!.end(JSON.stringify({ message: "Synthetic denial" }));
      await expect.poll(() => page.evaluate(() => { const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released); })).toBe(true);
      if (mode === "stale-403" || mode === "stale-404" || mode === "old-session-401") {
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
        await expect(panel.getByText("No recorded open requests on this page.")).toHaveCount(2);
        expect(previews).toBe(3);
        if (mode === "stale-403" || mode === "stale-404") {
          expect(lists).toBe(baselineLists);
          expect(await page.evaluate(() => (window as unknown as { listAfterHeaders?: number }).listAfterHeaders ?? 0)).toBe(0);
          expect(await page.evaluate(() => {
            const state = window as unknown as { sawUnavailable: boolean; denialObserver: MutationObserver }; state.denialObserver.disconnect(); return state.sawUnavailable;
          })).toBe(false);
        }
      } else expect(previews).toBe(1);
      expect(logins).toBe(mode === "old-session-401" ? 2 : 1);
      expect(requests.every((item) => item.method === "GET" && item.bearer === "Bearer same-preview-token")).toBe(true);
      expect(await page.evaluate(() => { const state = window as unknown as { signals: boolean[]; redirects: Array<RequestRedirect | undefined> };
        return state.signals.every((signal) => !signal) && state.redirects.every((redirect) => redirect === "error"); })).toBe(true);
      expect(prematureClose).toBe(false);
    } finally {
      try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
