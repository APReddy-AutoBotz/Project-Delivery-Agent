import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

for (const mode of ["actor-change", "exact-replay", "wrong-status", "wrong-receipt", "confirmed-refresh-failure"] as const) {
  test(`invitation ${mode} preserves uncertain write ownership`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const customerId = "10000000-0000-4000-8000-000000000001", locator = "20000000-0000-4000-8000-000000000001";
    const requestId = "30000000-0000-4000-8000-000000000001", responseId = "40000000-0000-4000-8000-000000000001";
    const view = (actor: string) => ({ requestId, project: { id: locator, code: "S", name: `${actor} project` }, stageKind: "REQUEST",
      dueAt: "2026-01-01T00:00:00.000Z", capturedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      body: `${actor} invitation`, requiredFacts: [{ factType: "project.forecast", label: "Forecast" }], rawResponseReaders: [actor], responses: [], escalationContext: null });
    const receipt = { responseId, requestId, receivedAt: "2026-01-01T00:00:00.000Z", state: "UNCONFIRMED", message: "Response recorded; required facts remain unconfirmed." };
    let actor = "actor-a", logins = 0, reads = 0, postCount = 0, failRefresh = false, held: ServerResponse | undefined, prematureClose = false;
    const commands: Array<{ method: string | undefined; bearer: string | undefined; contentType: string | undefined; raw: string; body: { text: string; idempotencyKey: string; correctsResponseId: string | null } }> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") { logins++; return json(200, { token: "write-synthetic-token" }); }
      if (path === "/api/me") return json(200, { customerId, subject: actor, roles: ["contributor"] });
      if (path === "/api/projects") return json(200, []);
      if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
      if (path === `/api/project-update-invitations/${locator}`) {
        reads++; if (failRefresh) { failRefresh = false; return json(503, { message: "Synthetic refresh failure" }); }
        return json(200, view(actor));
      }
      if (path === `/api/project-update-invitations/${locator}/responses`) {
        postCount++; const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          commands.push({ method: req.method, bearer: req.headers.authorization, contentType: req.headers["content-type"], raw, body: JSON.parse(raw) });
          if (postCount === 1 && mode === "actor-change") {
            held = res; res.on("close", () => { if (!res.writableFinished) prematureClose = true; });
            res.writeHead(201, { "Content-Type": "application/json", "x-held-write": "old" }); res.flushHeaders(); return;
          }
          if (postCount === 1 && mode === "exact-replay") {
            res.writeHead(503, { "Content-Type": "application/json", "x-held-write": "failed" }); res.end(JSON.stringify({ message: "Synthetic uncertain response" })); return;
          }
          if (postCount === 1 && (mode === "wrong-status" || mode === "wrong-receipt")) {
            res.writeHead(mode === "wrong-status" ? 200 : 201, { "Content-Type": "application/json", "x-held-write": "failed" });
            res.end(JSON.stringify(mode === "wrong-receipt" ? { ...receipt, requestId: locator } : receipt)); return;
          }
          if (postCount === 1 && mode === "confirmed-refresh-failure") failRefresh = true;
          res.writeHead(201, { "Content-Type": "application/json", "x-held-write": "confirmed" }); res.end(JSON.stringify(receipt)); return;
        }); return;
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
          const response = await original(input, init);
          const marker = response.headers.get("x-held-write");
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
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}/update-requests/${locator}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await expect(page.getByText("actor-a invitation")).toBeVisible();
      const input = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
      await input.fill("Original synthetic response");
      const submissions = await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Record response");
        if (!(button instanceof HTMLButtonElement) || !button.form) throw new Error("Submit unavailable");
        let count = 0; button.form.addEventListener("submit", () => { count++; }); button.form.requestSubmit(button); button.form.requestSubmit(button); return count;
      });
      expect(submissions).toBe(2); await expect.poll(() => commands.length).toBe(1); expect(postCount).toBe(1);
      expect(commands[0]).toMatchObject({ method: "POST", bearer: "Bearer write-synthetic-token", contentType: "application/json", body: { text: "Original synthetic response", correctsResponseId: null } });
      expect(commands[0]!.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
      if (mode === "actor-change") {
        await expect.poll(() => page.evaluate(() => ((window as unknown as { acquired?: string[] }).acquired ?? []).includes("old"))).toBe(true);
        actor = "actor-b"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(page.getByText("actor-b invitation")).toBeVisible();
        const current = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
        await expect(current).toHaveValue(""); await current.fill("Different actor draft");
        await expect(page.getByText("A response is being recorded. Wait for its result before sending another.")).toBeVisible();
        const readsBeforeRelease = reads; expect(prematureClose).toBe(false);
        held!.end(JSON.stringify(receipt));
        await expect.poll(() => page.evaluate(() => { const s = window as unknown as { eof?: string[]; released?: string[] }; return Boolean(s.eof?.includes("old") && s.released?.includes("old")); })).toBe(true);
        await expect(page.getByText("An earlier response could not be confirmed; it may already have been recorded.")).toBeVisible();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(current).toHaveValue("Different actor draft");
        await expect(page.getByText("Response recorded; required facts remain unconfirmed.")).toHaveCount(0);
        expect(reads).toBe(readsBeforeRelease); expect(postCount).toBe(1);
        await page.getByRole("button", { name: "Record response" }).click();
        await expect(page.getByText("An earlier response could not be confirmed. Retry the same response or check its history.")).toBeVisible();
        expect(postCount).toBe(1);
      } else if (mode === "confirmed-refresh-failure") {
        await expect(page.getByText("Response recorded; required facts remain unconfirmed.")).toBeVisible();
        await expect(page.getByText("This update request is unavailable or has expired.")).toBeVisible();
        await expect(page.getByText("Your response could not be confirmed. Retry the same response or check its history.")).toHaveCount(0);
        await page.getByRole("button", { name: "Check request access" }).click();
        await expect(page.getByText("actor-a invitation")).toBeVisible();
        await expect(input).toHaveValue(""); await input.fill("A later response");
        await page.getByRole("button", { name: "Record response" }).click(); await expect.poll(() => commands.length).toBe(2);
        expect(commands[1]!.body.idempotencyKey).not.toBe(commands[0]!.body.idempotencyKey);
        await expect(page.getByText("Response recorded; required facts remain unconfirmed.")).toBeVisible();
      } else {
        await expect(page.getByText("Your response could not be confirmed. Retry the same response or check its history.")).toBeVisible();
        await expect.poll(() => page.evaluate(() => { const s = window as unknown as { eof?: string[]; released?: string[] }; return Boolean(s.eof?.includes("failed") && s.released?.includes("failed")); })).toBe(true);
        await expect(input).toHaveValue("Original synthetic response");
        await input.fill("Changed response"); await page.getByRole("button", { name: "Record response" }).click();
        await expect(page.getByText("An earlier response could not be confirmed. Retry the same response or check its history.")).toBeVisible();
        expect(postCount).toBe(1);
        await input.fill("Original synthetic response"); await page.getByRole("button", { name: "Record response" }).click();
        await expect.poll(() => commands.length).toBe(2);
        expect(commands[1]).toEqual(commands[0]);
        await expect.poll(() => page.evaluate(() => { const s = window as unknown as { eof?: string[]; released?: string[] }; return Boolean(s.eof?.includes("confirmed") && s.released?.includes("confirmed")); })).toBe(true);
        await expect(page.getByText("Response recorded; required facts remain unconfirmed.")).toBeVisible();
        await expect(input).toHaveValue("");
      }
      expect(logins).toBe(1); expect(prematureClose).toBe(false);
    } finally {
      try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
