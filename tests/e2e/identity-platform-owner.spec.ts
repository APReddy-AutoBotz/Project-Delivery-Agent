import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

for (const nextActor of ["actor-a", "actor-b"] as const) {
  test(`platform actions wait for the current identity ${nextActor}`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const customerId = "10000000-0000-4000-8000-000000000001", scopeId = "30000000-0000-4000-8000-000000000001";
    let phase = 0, identity: ServerResponse | undefined, writes = 0;
    const commands: Array<{ method: string | undefined; bearer: string | undefined; body: unknown }> = [];
    const reads: Array<{ path: string; identityFinished: string | undefined }> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") return json(200, { token: "platform-synthetic-token" });
      if (path === "/api/me") {
        if (phase === 1 && !identity) { identity = res; res.writeHead(200, { "Content-Type": "application/json", "x-test-body": "identity" }); res.flushHeaders(); return; }
        return json(200, { customerId, subject: phase < 2 ? "actor-a" : nextActor, roles: ["system_admin"] });
      }
      if (path === "/api/projects") return json(200, []);
      if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
      if (path === "/api/platform") { reads.push({ path, identityFinished: req.headers["x-test-identity-finished"] as string | undefined });
        return json(200, { database: phase < 2 ? "actor-a database" : `${nextActor} database`, worker: "running", heartbeat: null, shadowMode: true, identityMode: "development", dataMode: "synthetic" }); }
      if (path === "/api/access-operations") { reads.push({ path, identityFinished: req.headers["x-test-identity-finished"] as string | undefined }); return json(200, []); }
      if (path === "/api/access-grants") { writes++; const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
        commands.push({ method: req.method, bearer: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); res.writeHead(204); res.end(); }); return; }
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
          const state = window as unknown as { armed?: boolean; oldButton?: HTMLButtonElement; oldField?: HTMLInputElement; live?: boolean; clicks?: number; submits?: number; inputs?: number; dispatches?: number; eof?: boolean; released?: boolean };
          if (path === "/api/me" && state.armed) {
            state.armed = false; state.live = Boolean(state.oldButton?.isConnected && !state.oldButton.disabled); state.oldButton?.click();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            if (!setter || !state.oldField) throw new Error("Field unavailable");
            setter.call(state.oldField, "stale injected subject"); state.oldField.dispatchEvent(new Event("input", { bubbles: true }));
          }
          if (path === "/api/access-grants") state.dispatches = (state.dispatches ?? 0) + 1;
          const headers = new Headers(init?.headers); headers.set("x-test-identity-finished", String(Boolean(state.eof && state.released)));
          const response = await original(input, { ...init, headers });
          if (response.headers.get("x-test-body") === "identity" && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => { const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              reader.read = async () => { const value = await read(); if (value.done) state.eof = true; return value; };
              reader.releaseLock = () => { release(); state.released = true; }; return reader; }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: "Platform operator" }).click();
      await page.getByRole("button", { name: /Platform & access/ }).click();
      await expect(page.getByText("actor-a database")).toBeVisible();
      await page.getByLabel("Account subject").fill("temporary-subject"); await page.getByLabel("Scope identifier").fill(scopeId);
      await page.getByLabel("Account subject").evaluate((input) => {
        if (!(input instanceof HTMLInputElement) || !input.form) throw new Error("Access form unavailable");
        const key = Object.keys(input).find((name) => name.startsWith("__reactProps$"));
        const formKey = Object.keys(input.form).find((name) => name.startsWith("__reactProps$"));
        const button = [...input.form.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Grant access");
        if (!key || !formKey || !(button instanceof HTMLButtonElement)) throw new Error("Access fixture unavailable");
        const fieldProps = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!;
        const formProps = (input.form as unknown as Record<string, { onSubmit: (event: unknown) => void }>)[formKey]!;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setter) throw new Error("Input setter unavailable");
        const oldSubmit = formProps.onSubmit; setter.call(input, "retained-subject"); fieldProps.onChange({ target: input });
        oldSubmit({ preventDefault() {}, nativeEvent: { submitter: button } });
      });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(writes).toBe(0); await expect(page.getByLabel("Account subject")).toHaveValue("retained-subject");
      await page.evaluate(() => { const state = window as unknown as { oldButton: HTMLButtonElement; oldField: HTMLInputElement; clicks: number; submits: number; inputs: number };
        const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Grant access");
        const field = button?.form?.querySelector("input");
        if (!(button instanceof HTMLButtonElement) || !(field instanceof HTMLInputElement)) throw new Error("Grant unavailable"); state.oldButton = button; state.oldField = field; state.clicks = 0; state.submits = 0; state.inputs = 0;
        button.addEventListener("click", () => state.clicks++); button.form?.addEventListener("submit", () => state.submits++); field.addEventListener("input", () => state.inputs++); });
      phase = 1; await page.evaluate(() => { (window as unknown as { armed: boolean }).armed = true; window.dispatchEvent(new Event("focus")); });
      await expect.poll(() => Boolean(identity)).toBe(true);
      expect(await page.evaluate(() => { const state = window as unknown as { live?: boolean; clicks?: number; submits?: number; inputs?: number }; return { live: state.live, clicks: state.clicks, submits: state.submits, inputs: state.inputs }; })).toEqual({ live: true, clicks: 1, submits: 1, inputs: 1 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(writes).toBe(0); expect(await page.evaluate(() => (window as unknown as { dispatches?: number }).dispatches ?? 0)).toBe(0);
      await expect(page.getByText("actor-a database")).not.toBeVisible();
      phase = 2; identity!.end(JSON.stringify({ customerId, subject: nextActor, roles: ["system_admin"] }));
      await expect.poll(() => page.evaluate(() => { const s = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(s.eof && s.released); })).toBe(true);
      await expect(page.getByText(`${nextActor} database`)).toBeVisible();
      await expect.poll(() => reads.filter((r) => r.identityFinished === "true").length).toBeGreaterThanOrEqual(2);
      await expect(page.getByLabel("Account subject")).toHaveValue(nextActor === "actor-a" ? "retained-subject" : "");
      expect(writes).toBe(0); expect(await page.evaluate(() => (window as unknown as { dispatches?: number }).dispatches ?? 0)).toBe(0);
      if (nextActor === "actor-b") { await page.getByLabel("Account subject").fill("current-subject"); await page.getByLabel("Scope identifier").fill(scopeId); }
      await page.getByRole("button", { name: "Grant access" }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement) || !button.form) throw new Error("Grant form unavailable");
        const key = Object.keys(button.form).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Grant handler unavailable");
        const callback = (button.form as unknown as Record<string, { onSubmit: (event: unknown) => void }>)[key]!.onSubmit;
        (window as unknown as { oldGrantSubmit: () => void }).oldGrantSubmit = () => callback({ preventDefault() {}, nativeEvent: { submitter: button } });
      });
      await page.getByRole("button", { name: "Grant access" }).click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toEqual({ method: "POST", bearer: "Bearer platform-synthetic-token", body: { subject: nextActor === "actor-a" ? "retained-subject" : "current-subject", scopeType: "project", scopeId, role: "contributor" } });
      await expect(page.getByText("Grant operation recorded.")).toBeVisible();
      await page.evaluate(() => (window as unknown as { oldGrantSubmit: () => void }).oldGrantSubmit());
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(writes).toBe(1);
      await page.getByRole("button", { name: "Grant access" }).click(); await expect.poll(() => commands.length).toBe(2);
    } finally { if (identity && !identity.writableEnded && !identity.destroyed) identity.end(); await context?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
}
