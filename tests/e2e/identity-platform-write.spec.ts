import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

test("a stale access grant acknowledgment cannot authorize a second change", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", scopeId = "30000000-0000-4000-8000-000000000001";
  let actor = "actor-a", held: ServerResponse | undefined, writes = 0;
  const commands: Array<{ method: string | undefined; bearer: string | undefined; body: unknown }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "platform-write-token" });
    if (path === "/api/me") return json(200, { customerId, subject: actor, roles: ["system_admin"] });
    if (path === "/api/projects") return json(200, []);
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === "/api/platform") return json(200, { database: `${actor} database`, worker: "running", heartbeat: null, shadowMode: true, identityMode: "development", dataMode: "synthetic" });
    if (path === "/api/access-operations") return json(200, []);
    if (path === "/api/access-grants") { writes++; const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
      commands.push({ method: req.method, bearer: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); held = res; }); return; }
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
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        const state = window as unknown as { dispatches?: number; grant204?: boolean; submits?: number };
        if (path === "/api/access-grants") state.dispatches = (state.dispatches ?? 0) + 1;
        const response = await original(input, init);
        if (path === "/api/access-grants" && response.status === 204) state.grant204 = true;
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "Platform operator" }).click(); await page.getByRole("button", { name: /Platform & access/ }).click();
    await expect(page.getByText("actor-a database")).toBeVisible();
    await page.getByLabel("Account subject").fill("shared-target"); await page.getByLabel("Scope identifier").fill(scopeId);
    await page.evaluate(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Grant access");
      if (!(button instanceof HTMLButtonElement) || !button.form) throw new Error("Grant unavailable");
      const state = window as unknown as { submits: number }; state.submits = 0; button.form.addEventListener("submit", () => state.submits++);
      button.form.requestSubmit(button); button.form.requestSubmit(button); });
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]).toEqual({ method: "POST", bearer: "Bearer platform-write-token", body: { subject: "shared-target", scopeType: "project", scopeId, role: "contributor" } });
    expect(await page.evaluate(() => (window as unknown as { submits?: number }).submits)).toBe(2); expect(writes).toBe(1);
    actor = "actor-b"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("actor-b database")).toBeVisible();
    await expect(page.getByLabel("Account subject")).toHaveValue("");
    await page.getByLabel("Account subject").fill("shared-target"); await page.getByLabel("Scope identifier").fill(scopeId);
    await expect(page.getByText("An access change is pending.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Grant access" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Revoke access" })).toBeDisabled();
    held!.writeHead(204); held!.end();
    await expect.poll(() => page.evaluate(() => (window as unknown as { grant204?: boolean }).grant204 === true)).toBe(true);
    await expect(page.getByText("An earlier access change could not be confirmed.", { exact: false })).toBeVisible();
    await expect(page.getByText("Grant operation recorded.")).toHaveCount(0);
    await expect(page.getByLabel("Account subject")).toHaveValue("shared-target");
    await expect(page.getByRole("button", { name: "Grant access" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Revoke access" })).toBeDisabled();
    expect(writes).toBe(1); expect(await page.evaluate(() => (window as unknown as { dispatches?: number }).dispatches)).toBe(1);
  } finally { if (held && !held.writableEnded && !held.destroyed) held.end(); await context?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
