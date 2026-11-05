import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

for (const resource of ["platform", "access-operations"] as const) {
  test(`current ${resource} denial hides previous content at headers and allows explicit retry`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const customerId = "10000000-0000-4000-8000-000000000001";
    let phase = 0, held: ServerResponse | undefined, deniedReads = 0, retries = 0;
    const status = (word: string) => ({ database: `${word} database`, worker: "running", heartbeat: null, shadowMode: true, identityMode: "development", dataMode: "synthetic" });
    const audit = (word: string) => [{ id: "50000000-0000-4000-8000-000000000001", event: "access.granted", actor: `${word}-actor`, occurredAt: "2026-09-06T00:00:00.000Z" }];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") return json(200, { token: "platform-denial-token" });
      if (path === "/api/me") return json(200, { customerId, subject: "actor-a", roles: ["system_admin"] });
      if (path === "/api/projects") return json(200, []);
      if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
      if (path === `/api/${resource}` && phase === 1) { deniedReads++; held = res; res.writeHead(403, { "Content-Type": "application/json", "x-platform-denial": "held" }); res.flushHeaders(); return; }
      if (path === `/api/${resource}` && phase === 2) retries++;
      if (path === "/api/platform") return json(200, status(phase === 2 ? "fresh" : "old"));
      if (path === "/api/access-operations") return json(200, audit(phase === 2 ? "fresh" : "old"));
      if (path.startsWith("/api/")) return json(404, {});
      const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
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
          const response = await original(input, init), state = window as unknown as { headers?: boolean; eof?: boolean; released?: boolean };
          if (response.headers.get("x-platform-denial") === "held" && response.body) {
            state.headers = true; const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => { const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              reader.read = async () => { const value = await read(); if (value.done) state.eof = true; return value; };
              reader.releaseLock = () => { release(); state.released = true; }; return reader; }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: "Platform operator" }).click(); await page.getByRole("button", { name: /Platform & access/ }).click();
      await expect(page.getByText(resource === "platform" ? "old database" : "old-actor")).toBeVisible();
      phase = 1; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => page.evaluate(() => (window as unknown as { headers?: boolean }).headers === true)).toBe(true);
      expect(deniedReads).toBe(1); expect(await page.evaluate(() => Boolean((window as unknown as { eof?: boolean }).eof))).toBe(false);
      await expect(page.getByText(resource === "platform" ? "old database" : "old-actor")).not.toBeVisible();
      const retry = page.getByRole("button", { name: resource === "platform" ? "Retry platform status" : "Retry operation history" });
      await expect(retry).toBeVisible(); phase = 2;
      expect(await retry.evaluate((button) => { let clicks = 0; button.addEventListener("click", () => clicks++); (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); return clicks; })).toBe(2);
      await expect(page.getByText(resource === "platform" ? "fresh database" : "fresh-actor")).toBeVisible();
      expect(retries).toBe(1); expect(await page.evaluate(() => Boolean((window as unknown as { eof?: boolean }).eof))).toBe(false);
      held!.end(JSON.stringify({ message: "denied" }));
      await expect.poll(() => page.evaluate(() => { const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released); })).toBe(true);
      await expect(page.getByText(resource === "platform" ? "fresh database" : "fresh-actor")).toBeVisible();
      await expect(page.getByText(resource === "platform" ? "old database" : "old-actor")).toHaveCount(0);
    } finally { if (held && !held.writableEnded && !held.destroyed) held.end(); await context?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
}
