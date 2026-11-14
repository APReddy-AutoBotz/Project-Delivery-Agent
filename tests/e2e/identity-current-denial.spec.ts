import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: a current /me denial must end the issuing session at headers,
// while its original bounded response remains owned until the reader releases.
for (const status of [403, 404] as const) {
  test(`current identity ${status} ends the session before body EOF`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const projectId = "30000000-0000-4000-8000-000000000001";
    let armed = false, held: ServerResponse | undefined, heldClosed = false, arrived!: () => void, projectReads = 0, detailReads = 0;
    const entered = new Promise<void>((resolve) => { arrived = resolve; });
    const bearer: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") return json(200, { token: "same-synthetic-token" });
      if (path === "/api/me") {
        if (armed && !held) {
          held = res; bearer.push(req.headers.authorization); res.on("close", () => { if (!res.writableFinished) heldClosed = true; });
          res.writeHead(status, { "Content-Type": "application/json", "x-synthetic-case": "identity-denial" }); res.flushHeaders(); arrived(); return;
        }
        return json(200, { subject: "current-actor", customerId: "10000000-0000-4000-8000-000000000001", roles: ["contributor"] });
      }
      if (path === "/api/projects") { projectReads++; return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]); }
      if (path === `/api/projects/${projectId}`) { detailReads++; return json(200, { id: projectId, code: "S", name: "Synthetic detail", description: "Fixture", reportedStatus: "UNKNOWN" }); }
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
          const state = window as unknown as { armed?: boolean; actionWasLive?: boolean; oldProjectCard?: HTMLButtonElement };
          if (state.armed && new URL(url, location.href).pathname === "/api/me") {
            state.armed = false;
            // The issuance itself closes the old action before React commits.
            state.actionWasLive = Boolean(state.oldProjectCard?.isConnected && !state.oldProjectCard.disabled);
            state.oldProjectCard?.click();
          }
          const response = await original(input, init);
          if (response.headers.get("x-synthetic-case") === "identity-denial" && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              const state = window as unknown as { identityReaderAcquired: boolean; oldNav?: HTMLButtonElement; denialActionLive?: boolean };
              state.identityReaderAcquired = true;
              // The sidebar persists through identity checking. Its old action
              // is invoked after denial headers but before sign-out commits.
              state.denialActionLive = Boolean(state.oldNav?.isConnected && !state.oldNav.disabled);
              state.oldNav?.click();
              reader.read = async () => { const value = await read(); if (value.done) (window as unknown as { identityEof: boolean }).identityEof = true; return value; };
              reader.releaseLock = () => { release(); (window as unknown as { identityReleased: boolean }).identityReleased = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await expect(page.getByText("current-actor", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Synthetic project/ })).toBeVisible();
      // Positive action control: the card actually navigates before denial.
      await page.getByRole("button", { name: /Synthetic project/ }).click();
      await expect(page.getByRole("heading", { name: "Synthetic detail", level: 1 })).toBeVisible();
      await page.getByRole("button", { name: /All projects/ }).click();
      await expect(page.getByRole("button", { name: /Synthetic project/ })).toBeVisible();
      await page.getByRole("button", { name: "Projects", exact: true }).click();
      await expect(page.getByRole("button", { name: /Synthetic project/ })).toBeVisible();
      await page.evaluate(() => {
        const state = window as unknown as { oldProjectCard: HTMLButtonElement; oldNav: HTMLButtonElement; navigationWrites: number; nativeClicks: number; navClicks: number };
        const card = document.querySelector("button.project-card");
        const nav = [...document.querySelectorAll("nav button")].find((button) => button.textContent?.trim().endsWith("Projects"));
        if (!(card instanceof HTMLButtonElement) || !(nav instanceof HTMLButtonElement)) throw new Error("Project action unavailable");
        state.oldProjectCard = card; state.oldNav = nav; state.navigationWrites = 0; state.nativeClicks = 0; state.navClicks = 0;
        card.addEventListener("click", () => { state.nativeClicks++; });
        nav.addEventListener("click", () => { state.navClicks++; });
        const replace = history.replaceState.bind(history);
        history.replaceState = (...args) => { state.navigationWrites++; return replace(...args); };
      });
      const projectReadBaseline = projectReads, detailReadBaseline = detailReads; armed = true;
      await page.evaluate(() => { (window as unknown as { armed: boolean }).armed = true; window.dispatchEvent(new Event("focus")); });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([entered, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Identity denial was not issued")), 15000); })]); }
      finally { if (timeout !== undefined) clearTimeout(timeout); }
      expect(bearer).toEqual(["Bearer same-synthetic-token"]);
      await expect(page.getByText("Your access could not be established. Please sign in again.")).toBeVisible();
      await expect(page.getByRole("button", { name: /Synthetic project/ })).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { identityReaderAcquired?: boolean }).identityReaderAcquired))).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { actionWasLive: boolean }).actionWasLive)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { nativeClicks: number }).nativeClicks)).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { denialActionLive: boolean; navClicks: number }).denialActionLive)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { navClicks: number }).navClicks)).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { navigationWrites: number }).navigationWrites)).toBe(0);
      expect(heldClosed).toBe(false);
      expect(await page.evaluate(() => Boolean((window as unknown as { identityEof?: boolean }).identityEof))).toBe(false);
      expect(projectReads).toBe(projectReadBaseline);
      expect(detailReads).toBe(detailReadBaseline);
      held!.end(JSON.stringify({ message: "Synthetic identity denial" }));
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { identityEof?: boolean; identityReleased?: boolean }).identityEof &&
        (window as unknown as { identityReleased?: boolean }).identityReleased))).toBe(true);
    } finally {
      try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
