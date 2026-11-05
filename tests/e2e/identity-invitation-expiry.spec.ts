import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

for (const mode of ["identity-outage", "old-owner-timer", "delayed-timer"] as const) {
  test(`invitation expiry protects the draft during ${mode}`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const start = Date.parse("2030-01-01T00:00:00.000Z"), customerId = "10000000-0000-4000-8000-000000000001";
    const locator = "20000000-0000-4000-8000-000000000001", requestId = "30000000-0000-4000-8000-000000000001";
    let actor = "actor-a", holdIdentity = false, identity: ServerResponse | undefined, reads = 0, posts = 0;
    const invitationRequests: Array<{ identityDone: string | undefined; method: string | undefined; bearer: string | undefined; expiresAt: string }> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") return json(200, { token: "expiry-synthetic-token" });
      if (path === "/api/me") {
        if (holdIdentity && !identity) { identity = res; res.writeHead(200, { "Content-Type": "application/json", "x-expiry-identity": "yes" }); res.flushHeaders(); return; }
        res.writeHead(200, { "Content-Type": "application/json", "x-expiry-identity": "yes" });
        res.end(JSON.stringify({ customerId, subject: actor, roles: ["contributor"] })); return;
      }
      if (path === "/api/projects") return json(200, []);
      if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
      if (path === `/api/project-update-invitations/${locator}/responses`) { posts++; return json(500, { message: "Unexpected submission" }); }
      if (path === `/api/project-update-invitations/${locator}`) {
        reads++;
        const expiry = actor === "actor-b" || (mode === "delayed-timer" && reads > 1) ? start + 120000 : start + 10000;
        invitationRequests.push({ identityDone: req.headers["x-expiry-identity-done"] as string | undefined, method: req.method, bearer: req.headers.authorization, expiresAt: new Date(expiry).toISOString() });
        res.writeHead(200, { "Content-Type": "application/json", "x-expiry-invitation": String(reads) });
        res.end(JSON.stringify({ requestId, project: { id: locator, code: "S", name: `${actor} project` }, stageKind: "REQUEST",
          dueAt: "2029-01-01T00:00:00.000Z", capturedAt: "2029-01-01T00:00:00.000Z", expiresAt: new Date(expiry).toISOString(),
          body: `${actor} invitation`, requiredFacts: [{ factType: "project.forecast", label: "Forecast" }], rawResponseReaders: [actor], responses: [], escalationContext: null })); return;
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
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = (...args: Parameters<SubtleCrypto["digest"]>) => {
          const state = window as unknown as { digestStarts?: number }; state.digestStarts = (state.digestStarts ?? 0) + 1; return digest(...args);
        };
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
          const state = window as unknown as { identityIssued?: number; identityDone?: number; inviteEof?: string[]; inviteReleased?: string[]; posts?: number };
          let identitySequence = 0;
          if (path === "/api/me") { state.identityIssued = (state.identityIssued ?? 0) + 1; identitySequence = state.identityIssued; }
          if (path.endsWith("/responses")) state.posts = (state.posts ?? 0) + 1;
          const headers = new Headers(init?.headers); headers.set("x-expiry-identity-done", String(state.identityDone ?? 0));
          const response = await original(input, { ...init, headers });
          const marker = response.headers.get("x-expiry-invitation"), identityMarker = response.headers.get("x-expiry-identity");
          if ((marker || identityMarker) && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
              reader.read = async () => { const result = await read(); if (result.done) { eof = true; if (marker) (state.inviteEof ??= []).push(marker); } return result; };
              reader.releaseLock = () => { release(); if (marker) (state.inviteReleased ??= []).push(marker); if (identityMarker && eof) state.identityDone = Math.max(state.identityDone ?? 0, identitySequence); };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage();
      await page.clock.install({ time: start });
      await page.goto(`http://127.0.0.1:${address.port}/update-requests/${locator}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await expect(page.getByText("actor-a invitation")).toBeVisible();
      await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).fill("Actor A private draft");
      await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).evaluate((node) => { (window as unknown as { originalDraft: HTMLTextAreaElement }).originalDraft = node as HTMLTextAreaElement; });
      if (mode === "identity-outage") {
        const targetIdentity = await page.evaluate(() => ((window as unknown as { identityIssued?: number }).identityIssued ?? 0) + 1);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
        await expect.poll(() => invitationRequests.slice(1).some((item) => item.identityDone === String(targetIdentity))).toBe(true);
        const priorMarker = String(invitationRequests.findIndex((item, index) => index > 0 && item.identityDone === String(targetIdentity)) + 1);
        await expect.poll(() => page.evaluate((expected) => { const s = window as unknown as { inviteEof?: string[]; inviteReleased?: string[] };
          return Boolean(s.inviteEof?.includes(expected) && s.inviteReleased?.includes(expected)); }, priorMarker)).toBe(true);
        await expect(page.getByRole("textbox", { name: "Your update (unconfirmed)" })).toHaveValue("Actor A private draft");
        await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).evaluate((node) => { (window as unknown as { originalDraft: HTMLTextAreaElement }).originalDraft = node as HTMLTextAreaElement; });
        holdIdentity = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => Boolean(identity)).toBe(true);
        await expect(page.getByText("actor-a invitation")).not.toBeVisible();
        expect(await page.evaluate(() => !(window as unknown as { originalDraft: HTMLTextAreaElement }).originalDraft.isConnected)).toBe(true);
        await page.clock.fastForward(11000);
        await expect(page.locator("textarea")).toHaveCount(0);
        expect(await page.evaluate(() => !(window as unknown as { originalDraft: HTMLTextAreaElement }).originalDraft.isConnected)).toBe(true);
        identity!.end(JSON.stringify({ customerId, subject: actor, roles: ["contributor"] }));
        await expect(page.getByText("This update request is unavailable or has expired.")).toBeVisible();
        expect(posts).toBe(0);
      } else {
        if (mode === "old-owner-timer") actor = "actor-b";
        const targetIdentity = await page.evaluate(() => ((window as unknown as { identityIssued?: number }).identityIssued ?? 0) + 1);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
        await expect(page.getByText(`${actor} invitation`)).toBeVisible();
        await expect.poll(() => invitationRequests.slice(1).some((item) => item.identityDone === String(targetIdentity))).toBe(true);
        const freshIndex = invitationRequests.findIndex((item, index) => index > 0 && item.identityDone === String(targetIdentity));
        const marker = String(freshIndex + 1);
        await expect.poll(() => page.evaluate((expected) => { const s = window as unknown as { inviteEof?: string[]; inviteReleased?: string[] };
          return Boolean(s.inviteEof?.includes(expected) && s.inviteReleased?.includes(expected)); }, marker)).toBe(true);
        expect(invitationRequests[freshIndex]).toEqual({ identityDone: String(targetIdentity), method: "GET", bearer: "Bearer expiry-synthetic-token", expiresAt: "2030-01-01T00:02:00.000Z" });
        const input = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
        if (mode === "old-owner-timer") {
          await expect(input).toHaveValue(""); await input.fill("Actor B private draft");
          await page.clock.fastForward(11000);
          await expect(input).toHaveValue("Actor B private draft");
          await expect(page.getByText("actor-b invitation")).toBeVisible();
        } else {
          await expect(input).toHaveValue("Actor A private draft");
          await expect(page.getByText("Available until 2030-01-01T00:00:10.000Z.", { exact: false })).toBeVisible();
          // Playwright's setSystemTime changes Date without firing scheduled timers.
          await page.clock.setSystemTime(start + 11000);
          const clicks = await page.evaluate(() => {
            const state = window as unknown as { digestStarts?: number; posts?: number };
            const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Record response");
            if (!(button instanceof HTMLButtonElement) || !button.form) throw new Error("Submit unavailable");
            let nativeClicks = 0, submits = 0; button.addEventListener("click", () => { nativeClicks++; }); button.form.addEventListener("submit", () => { submits++; });
            const live = button.isConnected && !button.disabled, digest = state.digestStarts ?? 0;
            button.click(); return { live, nativeClicks, submits, digestBefore: digest, digestAfter: state.digestStarts ?? 0, posts: state.posts ?? 0 };
          });
          expect(clicks).toEqual({ live: true, nativeClicks: 1, submits: 1, digestBefore: 0, digestAfter: 0, posts: 0 });
          await page.evaluate(async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); });
          expect(await page.evaluate(() => { const s = window as unknown as { digestStarts?: number; posts?: number }; return { digest: s.digestStarts ?? 0, posts: s.posts ?? 0 }; })).toEqual({ digest: 0, posts: 0 });
          expect(posts).toBe(0);
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect(page.getByText("This update request is unavailable or has expired.")).toBeVisible();
          await expect(page.locator("textarea")).toHaveCount(0);
          expect(await page.evaluate(() => { const s = window as unknown as { digestStarts?: number; posts?: number }; return { digest: s.digestStarts ?? 0, posts: s.posts ?? 0 }; })).toEqual({ digest: 0, posts: 0 });
        }
      }
    } finally {
      try { if (identity && !identity.writableEnded && !identity.destroyed) identity.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
