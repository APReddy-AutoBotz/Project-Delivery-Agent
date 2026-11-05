import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// Synthetic actual-App identity issuance and owner control for an invitation.
for (const nextActor of ["actor-a", "actor-b"] as const) {
  test(`invitation actions wait for the current identity and ${nextActor} invitation`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const customerId = "10000000-0000-4000-8000-000000000001", locator = "20000000-0000-4000-8000-000000000001";
    const requestId = "30000000-0000-4000-8000-000000000001", responseId = "40000000-0000-4000-8000-000000000001";
    const invitation = (actor: string) => ({ requestId, project: { id: locator, code: "S", name: `${actor} project` }, stageKind: "REQUEST",
      dueAt: "2026-01-01T00:00:00.000Z", capturedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      body: `${actor} synthetic invitation`, requiredFacts: [{ factType: "project.forecast", label: "Forecast" }],
      rawResponseReaders: [actor], responses: [], escalationContext: null });
    let phase = 0, logins = 0, posts = 0, identity: ServerResponse | undefined, fresh: ServerResponse | undefined;
    const bearer: Array<string | undefined> = [], freshDispatch: Array<{ identityDone: string | undefined; method: string | undefined; bearer: string | undefined }> = [];
    const commands: Array<{ method: string | undefined; bearer: string | undefined; contentType: string | undefined; raw: string; body: { text: string; idempotencyKey: string; correctsResponseId: string | null } }> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") { logins++; return json(200, { token: "invitation-synthetic-token" }); }
      if (path === "/api/me") {
        if (phase === 1 && !identity) { identity = res; bearer.push(req.headers.authorization); res.writeHead(200, { "Content-Type": "application/json", "x-invitation-test": "identity" }); res.flushHeaders(); return; }
        return json(200, { customerId, subject: phase < 2 ? "actor-a" : nextActor, roles: ["contributor"] });
      }
      if (path === "/api/projects") return json(200, []);
      if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
      if (path === `/api/project-update-invitations/${locator}/responses`) {
        posts++; const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          commands.push({ method: req.method, bearer: req.headers.authorization, contentType: req.headers["content-type"], raw, body: JSON.parse(raw) });
          res.writeHead(201, { "Content-Type": "application/json", "x-invitation-test": "receipt" });
          res.end(JSON.stringify({ responseId, requestId, receivedAt: "2026-01-01T00:00:00.000Z", state: "UNCONFIRMED", message: "Response recorded; required facts remain unconfirmed." }));
        }); return;
      }
      if (path === `/api/project-update-invitations/${locator}`) {
        if (phase === 2 && !fresh) { fresh = res; freshDispatch.push({ identityDone: req.headers["x-test-identity-finished"] as string | undefined, method: req.method, bearer: req.headers.authorization });
          res.writeHead(200, { "Content-Type": "application/json", "x-invitation-test": "fresh" }); res.flushHeaders(); return; }
        return json(200, invitation(phase < 2 ? "actor-a" : nextActor));
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
          (window as unknown as { digestStarts?: number }).digestStarts = ((window as unknown as { digestStarts?: number }).digestStarts ?? 0) + 1;
          return digest(...args);
        };
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
          const state = window as unknown as { armed?: boolean; oldSubmit?: HTMLButtonElement; live?: boolean; clicks?: number; postDispatches?: number;
            identityEof?: boolean; identityReleased?: boolean; freshEof?: boolean; freshReleased?: boolean; receiptEof?: boolean; receiptReleased?: boolean };
          if (path === "/api/me" && state.armed) {
            state.armed = false; state.live = Boolean(state.oldSubmit?.isConnected && !state.oldSubmit.disabled); state.oldSubmit?.click();
          }
          if (path.endsWith("/responses")) state.postDispatches = (state.postDispatches ?? 0) + 1;
          const headers = new Headers(init?.headers); headers.set("x-test-identity-finished", String(Boolean(state.identityEof && state.identityReleased)));
          const response = await original(input, { ...init, headers }), marker = response.headers.get("x-invitation-test");
          if (marker && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              reader.read = async () => { const result = await read(); if (result.done) { if (marker === "identity") state.identityEof = true; else if (marker === "fresh") state.freshEof = true; else state.receiptEof = true; } return result; };
              reader.releaseLock = () => { release(); if (marker === "identity") state.identityReleased = true; else if (marker === "fresh") state.freshReleased = true; else state.receiptReleased = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}/update-requests/${locator}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await expect(page.getByText("actor-a synthetic invitation")).toBeVisible();
      await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).fill("Synthetic retained draft");
      await page.evaluate(() => {
        const state = window as unknown as { oldSubmit: HTMLButtonElement; clicks: number; submits: number; digestBaseline: number };
        const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Record response");
        if (!(button instanceof HTMLButtonElement)) throw new Error("Submit unavailable");
        state.oldSubmit = button; state.clicks = 0; state.submits = 0; state.digestBaseline = (window as unknown as { digestStarts?: number }).digestStarts ?? 0;
        button.addEventListener("click", () => { state.clicks++; });
        button.form?.addEventListener("submit", () => { state.submits++; });
      });
      phase = 1; await page.evaluate(() => { (window as unknown as { armed: boolean }).armed = true; window.dispatchEvent(new Event("focus")); });
      await expect.poll(() => Boolean(identity)).toBe(true);
      expect(await page.evaluate(() => { const s = window as unknown as { live?: boolean; clicks?: number; submits?: number }; return { live: s.live, clicks: s.clicks, submits: s.submits }; })).toEqual({ live: true, clicks: 1, submits: 1 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(posts).toBe(0); expect(await page.evaluate(() => (window as unknown as { postDispatches?: number }).postDispatches ?? 0)).toBe(0);
      expect(await page.evaluate(() => { const s = window as unknown as { digestStarts?: number; digestBaseline: number }; return (s.digestStarts ?? 0) - s.digestBaseline; })).toBe(0);
      expect(bearer).toEqual(["Bearer invitation-synthetic-token"]);
      await expect(page.getByText("actor-a synthetic invitation")).not.toBeVisible();
      phase = 2; identity!.end(JSON.stringify({ customerId, subject: nextActor, roles: ["contributor"] }));
      await expect.poll(() => page.evaluate(() => { const s = window as unknown as { identityEof?: boolean; identityReleased?: boolean }; return Boolean(s.identityEof && s.identityReleased); })).toBe(true);
      await expect.poll(() => Boolean(fresh)).toBe(true);
      expect(freshDispatch).toEqual([{ identityDone: "true", method: "GET", bearer: "Bearer invitation-synthetic-token" }]);
      await expect(page.getByText("actor-a synthetic invitation")).not.toBeVisible();
      fresh!.end(JSON.stringify(invitation(nextActor)));
      await expect(page.getByText(`${nextActor} synthetic invitation`)).toBeVisible();
      await expect.poll(() => page.evaluate(() => { const s = window as unknown as { freshEof?: boolean; freshReleased?: boolean }; return Boolean(s.freshEof && s.freshReleased); })).toBe(true);
      const input = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
      await expect(input).toHaveValue(nextActor === "actor-a" ? "Synthetic retained draft" : "");
      expect(posts).toBe(0); expect(await page.evaluate(() => (window as unknown as { postDispatches?: number }).postDispatches ?? 0)).toBe(0);
      expect(await page.evaluate(() => { const s = window as unknown as { digestStarts?: number; digestBaseline: number }; return (s.digestStarts ?? 0) - s.digestBaseline; })).toBe(0);
      if (nextActor === "actor-b") await input.fill("Current actor draft");
      await page.getByRole("button", { name: "Record response" }).click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]?.method).toBe("POST"); expect(commands[0]?.bearer).toBe("Bearer invitation-synthetic-token");
      expect(commands[0]?.contentType).toContain("application/json");
      expect(commands[0]?.body).toMatchObject({ text: nextActor === "actor-a" ? "Synthetic retained draft" : "Current actor draft", correctsResponseId: null });
      expect(commands[0]?.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
      await expect.poll(() => page.evaluate(() => { const s = window as unknown as { receiptEof?: boolean; receiptReleased?: boolean }; return Boolean(s.receiptEof && s.receiptReleased); })).toBe(true);
      await expect(page.getByText("Response recorded; required facts remain unconfirmed.")).toBeVisible();
      await expect(page.getByText(`${nextActor} synthetic invitation`)).toBeVisible();
      if (nextActor === "actor-b") await expect(page.getByText("actor-a synthetic invitation")).toHaveCount(0);
      expect(posts).toBe(1); expect(logins).toBe(1);
    } finally {
      try { if (identity && !identity.writableEnded && !identity.destroyed) identity.end(); }
      finally { try { if (fresh && !fresh.writableEnded && !fresh.destroyed) fresh.end(); }
        finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } } }
    }
  });
}
