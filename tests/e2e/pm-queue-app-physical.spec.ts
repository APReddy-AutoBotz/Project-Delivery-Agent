import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// Synthetic actual-App control: a queue original stays owned across a dirty
// refresh or an identity-driven panel replacement until its reader releases.
for (const mode of ["dirty-200", "dirty-403", "remount", "stable-render", "stale-row", "stale-view", "stale-aba", "current-401", "dirty-401", "old-session-401"] as const) {
  test(`queue ${mode} retains its held original`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const body = JSON.stringify({ rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
      approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" }, projects: [], items: [] });
    const projectId = "30000000-0000-4000-8000-000000000001", asOf = "2026-01-01T00:00:00.000Z";
    const freshBody = JSON.stringify({ ...JSON.parse(body), projects: [{ projectId, name: "Synthetic current queue project",
      schedule: { projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY", sourceAuthority: "NOT_ASSESSED",
        approvalItems: "UNAVAILABLE", rankPolicyRevision: "advice-core@1", asOf, items: [] },
      update: { projectId, audience: "project_manager", availability: "UNCONFIGURED", approvalItems: "UNAVAILABLE", asOf },
      blockerAge: { projectId, audience: "project_manager", ruleRevision: "blocker-age@1", orderRevision: "blocker-review-order@1",
        timeZone: "UTC", asOf, coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, items: [] } }] });
    const renewedBody = freshBody.replace("Synthetic current queue project", "Synthetic renewed queue project");
    let queueReads = 0, identities = 0, logins = 0, detailReads = 0, prematureClose = false;
    let held: ServerResponse | undefined, replacement: ServerResponse | undefined, setupHeld: ServerResponse | undefined;
    const requests: Array<{ method: string | undefined; bearer: string | undefined }> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") { logins++; return json(200, { token: "queue-synthetic-token" }); }
      if (path === "/api/me") { identities++; return json(200, { customerId: "10000000-0000-4000-8000-000000000001", subject: "queue-actor", roles: mode === "stale-view" || mode === "stale-aba" ? ["project_manager", "pmo_admin"] : ["project_manager"] }); }
      if (path === "/api/projects") return json(200, []);
      if (path === `/api/projects/${projectId}`) { detailReads++; return json(200, { id: projectId, code: "S", name: "Current project detail", description: "Synthetic", reportedStatus: "UNKNOWN" }); }
      if (path === "/api/project-setup") {
        if (mode === "stable-render") { setupHeld = res; return; }
        return json(200, { truncated: false, portfolios: [] });
      }
      if (path === "/api/pm/action-queue") {
        queueReads++; requests.push({ method: req.method, bearer: req.headers.authorization });
        if (queueReads === 2) {
          held = res; res.on("close", () => { if (!res.writableFinished) prematureClose = true; });
          if (["dirty-200", "remount", "stable-render", "stale-row", "stale-view", "stale-aba"].includes(mode)) { res.writeHead(200, { "Content-Type": "application/json", "x-queue-original": "held" }); res.flushHeaders(); }
          return;
        }
        if (queueReads === 3) { replacement = res; return; }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(["stale-row", "stale-view", "stale-aba"].includes(mode) ? freshBody : body); return;
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
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const state = window as unknown as { queueSignals?: boolean[]; redirects?: Array<RequestRedirect | undefined>; releaseAtDispatch?: boolean[]; acquired?: boolean; eof?: boolean; released?: boolean };
          if (new URL(url, location.href).pathname === "/api/pm/action-queue") {
            (state.queueSignals ??= []).push(Boolean(init?.signal)); (state.redirects ??= []).push(init?.redirect);
            (state.releaseAtDispatch ??= []).push(Boolean(state.released));
          }
          const response = await original(input, init);
          if (response.headers.get("x-queue-original") === "held" && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              state.acquired = true;
              reader.read = async () => { const result = await read(); if (result.done) state.eof = true; return result; };
              reader.releaseLock = () => { release(); state.released = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      const panel = page.getByRole("region", { name: "Action suggestions" });
      if (mode === "stale-row" || mode === "stale-view" || mode === "stale-aba") {
        await expect(panel.getByRole("heading", { name: "Synthetic current queue project" })).toBeVisible();
        const observed = await page.evaluate((selectedMode) => {
          const state = window as unknown as { oldQueuePanel: Element; nativeRow: number; nativeRefresh: number; nativePlatform: number; historyWrites: number; rowLive: boolean; refreshLive: boolean };
          const section = document.querySelector('section[aria-labelledby="pm-action-queue-heading"]');
          const row = [...(section?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Open project");
          const refresh = [...(section?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Refresh suggestions");
          const platform = [...document.querySelectorAll("nav button")].find((button) => button.textContent?.trim().endsWith("Platform & access"));
          const projects = [...document.querySelectorAll("nav button")].find((button) => button.textContent?.trim().endsWith("Projects"));
          if (!(row instanceof HTMLButtonElement) || !(refresh instanceof HTMLButtonElement) ||
              (selectedMode !== "stale-row" && !(platform instanceof HTMLButtonElement)) ||
              (selectedMode === "stale-aba" && !(projects instanceof HTMLButtonElement))) throw new Error("Queue controls unavailable");
          if (!(section instanceof Element)) throw new Error("Queue panel unavailable");
          state.oldQueuePanel = section; state.nativeRow = 0; state.nativeRefresh = 0; state.nativePlatform = 0; state.historyWrites = 0;
          row.addEventListener("click", () => { state.nativeRow++; }); refresh.addEventListener("click", () => { state.nativeRefresh++; });
          platform?.addEventListener("click", () => { state.nativePlatform++; });
          const replace = history.replaceState.bind(history); history.replaceState = (...args) => { state.historyWrites++; return replace(...args); };
          if (selectedMode === "stale-row") { refresh.click(); refresh.click(); }
          else if (platform instanceof HTMLButtonElement) platform.click();
          if (selectedMode === "stale-aba" && projects instanceof HTMLButtonElement) projects.click();
          state.rowLive = row.isConnected && !row.disabled; state.refreshLive = refresh.isConnected && !refresh.disabled;
          row.click();
          return { rowLive: state.rowLive, refreshLive: state.refreshLive, rowClicks: state.nativeRow,
            refreshClicks: state.nativeRefresh, platformClicks: state.nativePlatform, historyWrites: state.historyWrites };
        }, mode);
        expect(observed).toEqual({ rowLive: true, refreshLive: true, rowClicks: 1,
          refreshClicks: mode === "stale-row" ? 2 : 0, platformClicks: mode === "stale-row" ? 0 : 1,
          historyWrites: mode === "stale-row" ? 0 : mode === "stale-view" ? 1 : 2 });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(detailReads).toBe(0);
        if (mode !== "stale-row") await expect.poll(() => page.evaluate(() => !(window as unknown as { oldQueuePanel: Element }).oldQueuePanel.isConnected)).toBe(true);
        if (mode === "stale-view") await page.getByRole("button", { name: "Projects", exact: true }).click();
        await expect.poll(() => queueReads).toBe(2);
        await expect(panel.getByText("Checking assigned projects and current access…")).toBeVisible();
        await expect(panel.getByRole("heading", { name: "Synthetic current queue project" })).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { acquired?: boolean }).acquired))).toBe(true);
        held!.end(renewedBody);
        await expect.poll(() => page.evaluate(() => { const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released); })).toBe(true);
        await expect(panel.getByRole("heading", { name: "Synthetic renewed queue project" })).toBeVisible();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(queueReads).toBe(2);
        await panel.getByRole("button", { name: "Open project" }).first().click();
        await expect(page.getByRole("heading", { name: "Current project detail", level: 1 })).toBeVisible();
        expect(detailReads).toBeGreaterThanOrEqual(1);
        return;
      }
      await expect(panel.getByText("No schedule or update suggestions were produced from the available observations.")).toBeVisible();
      expect(queueReads).toBe(1);
      await panel.getByRole("button", { name: "Refresh suggestions" }).click();
      await expect.poll(() => queueReads).toBe(2);
      if (mode === "stable-render") {
        await expect(panel.getByText("Checking assigned projects and current access…")).toBeVisible();
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { acquired?: boolean }).acquired))).toBe(true);
        await panel.evaluate((node) => { (window as unknown as { oldQueuePanel: Element }).oldQueuePanel = node; });
        await expect.poll(() => Boolean(setupHeld)).toBe(true);
        setupHeld!.writeHead(200, { "Content-Type": "application/json" });
        setupHeld!.end(JSON.stringify({ truncated: false, portfolios: [{ id: "30000000-0000-4000-8000-000000000050", name: "Synthetic portfolio", programmes: [], programmesTruncated: false }] }));
        await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeVisible();
        await expect(panel.getByText("Checking assigned projects and current access…")).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { oldQueuePanel: Element }).oldQueuePanel.isConnected)).toBe(true);
        expect(queueReads).toBe(2); expect(prematureClose).toBe(false);
        held!.end(freshBody);
        await expect.poll(() => page.evaluate(() => {
          const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released);
        })).toBe(true);
        await expect(panel.getByText("Synthetic current queue project", { exact: true })).toBeVisible();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await page.evaluate(() => (window as unknown as { oldQueuePanel: Element }).oldQueuePanel.isConnected)).toBe(true);
        expect(queueReads).toBe(2); expect(logins).toBe(1);
        return;
      }
      if (mode === "current-401" || mode === "dirty-401" || mode === "old-session-401") {
        if (mode === "dirty-401") await panel.getByRole("button", { name: "Refresh suggestions" }).click();
        if (mode === "old-session-401") {
          await page.getByRole("button", { name: "Sign out" }).click();
          await page.getByRole("button", { name: /^Project manager / }).first().click();
          await expect.poll(() => logins).toBe(2);
          await expect(page.getByRole("region", { name: "Action suggestions" }).getByText("Suggestions are unavailable.", { exact: false })).toBeVisible();
        }
        held!.writeHead(401, { "Content-Type": "application/json", "x-queue-original": "held" }); held!.flushHeaders();
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { acquired?: boolean }).acquired))).toBe(true);
        if (mode !== "old-session-401") await expect(page.getByText("Your session has ended. Please sign in again.")).toBeVisible();
        else await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
        expect(queueReads).toBe(2); expect(prematureClose).toBe(false);
        expect(await page.evaluate(() => Boolean((window as unknown as { eof?: boolean }).eof))).toBe(false);
        held!.end(JSON.stringify({ message: "Synthetic expired session" }));
        await expect.poll(() => page.evaluate(() => {
          const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released);
        })).toBe(true);
        if (mode === "old-session-401") {
          await expect.poll(() => queueReads).toBe(3);
          replacement!.writeHead(200, { "Content-Type": "application/json" }); replacement!.end(body);
          await expect(page.getByRole("region", { name: "Action suggestions" }).getByText("No schedule or update suggestions were produced from the available observations.")).toBeVisible();
          await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
          expect(await page.evaluate(() => (window as unknown as { releaseAtDispatch: boolean[] }).releaseAtDispatch)).toEqual([false, false, true]);
        } else expect(queueReads).toBe(2);
        expect(requests.every((item) => item.method === "GET" && item.bearer === "Bearer queue-synthetic-token")).toBe(true);
        expect(await page.evaluate(() => {
          const state = window as unknown as { queueSignals: boolean[]; redirects: Array<RequestRedirect | undefined> };
          return state.queueSignals.every((signal) => !signal) && state.redirects.every((redirect) => redirect === "error");
        })).toBe(true);
        return;
      }
      if (mode === "remount") {
        await panel.evaluate((node) => { (window as unknown as { oldQueuePanel: Element }).oldQueuePanel = node; });
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => identities).toBeGreaterThan(1);
        await expect(page.getByText("queue-actor", { exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => !(window as unknown as { oldQueuePanel: Element }).oldQueuePanel.isConnected)).toBe(true);
        await expect(page.getByRole("region", { name: "Action suggestions" }).getByText("Suggestions are unavailable.", { exact: false })).toBeVisible();
      } else {
        const calibrated = await page.evaluate(async () => {
          const state = window as unknown as { queueTransient: boolean; queueObserver: MutationObserver };
          state.queueTransient = false;
          state.queueObserver = new MutationObserver(() => {
            if ([...document.querySelectorAll("section")].some((node) => node.getAttribute("aria-labelledby") === "pm-action-queue-heading" &&
              (node.textContent?.includes("Suggestions are unavailable.") || node.textContent?.includes("No schedule or update suggestions were produced")))) state.queueTransient = true;
          });
          state.queueObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
          const marker = document.createElement("section"); marker.setAttribute("aria-labelledby", "pm-action-queue-heading"); marker.textContent = "Suggestions are unavailable.";
          document.body.append(marker); await Promise.resolve(); const errorDetected = state.queueTransient;
          marker.remove(); await Promise.resolve(); state.queueTransient = false;
          marker.textContent = "No schedule or update suggestions were produced"; document.body.append(marker);
          await Promise.resolve(); const emptyDetected = state.queueTransient;
          marker.remove(); await Promise.resolve(); state.queueTransient = false; return errorDetected && emptyDetected;
        });
        expect(calibrated).toBe(true);
        await panel.getByRole("button", { name: "Refresh suggestions" }).click();
        if (mode === "dirty-403") { held!.writeHead(403, { "Content-Type": "application/json", "x-queue-original": "held" }); held!.flushHeaders(); }
      }
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { acquired?: boolean }).acquired))).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(queueReads).toBe(2); expect(prematureClose).toBe(false);
      expect(await page.evaluate(() => Boolean((window as unknown as { eof?: boolean }).eof))).toBe(false);
      if (mode !== "remount") await expect(panel.getByText("Suggestions are unavailable.", { exact: false })).toHaveCount(0);
      held!.end(mode === "dirty-403" ? JSON.stringify({ message: "denied" }) : body);
      await expect.poll(() => page.evaluate(() => {
        const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released);
      })).toBe(true);
      await expect.poll(() => queueReads).toBe(3);
      expect(replacement).toBeDefined();
      if (mode !== "remount") {
        expect(await page.evaluate(() => { const state = window as unknown as { queueTransient: boolean; queueObserver: MutationObserver }; state.queueObserver.disconnect(); return state.queueTransient; })).toBe(false);
      }
      replacement!.writeHead(200, { "Content-Type": "application/json" }); replacement!.end(body);
      await expect(page.getByRole("region", { name: "Action suggestions" }).getByText("No schedule or update suggestions were produced from the available observations.")).toBeVisible();
      expect(logins).toBe(1); expect(prematureClose).toBe(false);
      expect(requests).toEqual(Array.from({ length: 3 }, () => ({ method: "GET", bearer: "Bearer queue-synthetic-token" })));
      expect(await page.evaluate(() => {
        const state = window as unknown as { queueSignals?: boolean[]; redirects?: Array<RequestRedirect | undefined>; releaseAtDispatch?: boolean[] };
        return { signals: state.queueSignals, redirects: state.redirects, releaseAtDispatch: state.releaseAtDispatch };
      })).toEqual({ signals: [false, false, false], redirects: ["error", "error", "error"], releaseAtDispatch: [false, false, true] });
    } finally {
      try {
        try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
        finally { try { if (replacement && !replacement.writableEnded && !replacement.destroyed) replacement.end(); }
          finally { if (setupHeld && !setupHeld.writableEnded && !setupHeld.destroyed) setupHeld.end(); } }
      } finally {
        try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
      }
    }
  });
}
