import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

test("CSV mapping does not submit when identity revalidation begins", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001";
  const sourceId = "40000000-0000-4000-8000-000000000001";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" },
      projects: [{ projectId, readers: ["actor-a"] }], mapping: { kind: "CSV", sheet: "Existing sheet", identityColumn: "Issue ID", projectColumn: "Project ID",
        fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  let phase = 0, identity: ServerResponse | undefined, writes = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "csv-identity-token" });
    if (path === "/api/me") {
      if (phase === 1 && !identity) { identity = res; res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders(); return; }
      return json(200, { customerId, subject: "actor-a", roles: ["pmo_admin"] });
    }
    if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === "/api/ingestion/sources") return json(200, phase < 2 ? [] : [source]);
    if (path === "/api/ingestion/sources/configuration") { writes++; return json(503, {}); }
    if (path.startsWith("/api/")) return json(404, {});
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback unavailable");
    context = await browser.newContext(); await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        const state = window as unknown as { armed?: boolean; button?: HTMLButtonElement; live?: boolean; clicks?: number; submits?: number; writes?: number };
        if (path === "/api/me" && state.armed) { state.armed = false; state.live = Boolean(state.button?.isConnected && !state.button.disabled); state.button?.click(); }
        if (path === "/api/ingestion/sources/configuration") state.writes = (state.writes ?? 0) + 1;
        return original(input, init);
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await page.getByLabel("Synthetic project").check();
    await page.getByLabel("Sheet label").fill("New mapping draft");
    // Force the old form handler after the discard click in the same task.
    await page.evaluate(() => {
      const discard = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Discard mapping draft");
      const submit = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create mapping");
      if (!(discard instanceof HTMLButtonElement) || !(submit instanceof HTMLButtonElement) || !submit.form) throw new Error("Draft controls unavailable");
      const key = Object.keys(submit.form).find((name) => name.startsWith("__reactProps$"));
      if (!key) throw new Error("React fixture props unavailable");
      const props = (submit.form as unknown as Record<string, { onSubmit: (event: unknown) => void }>)[key]!;
      const oldSubmit = props.onSubmit; discard.click();
      oldSubmit({ preventDefault() {}, nativeEvent: { submitter: submit } });
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(writes).toBe(0); await expect(page.getByLabel("Sheet label")).toHaveValue("Projects");
    await page.getByLabel("Synthetic project").check(); await page.getByLabel("Sheet label").fill("New mapping draft");
    await page.evaluate(() => { const state = window as unknown as { button: HTMLButtonElement; clicks: number; submits: number };
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Create mapping");
      if (!(button instanceof HTMLButtonElement) || !button.form) throw new Error("Mapping unavailable"); state.button = button; state.clicks = 0; state.submits = 0;
      document.addEventListener("click", (event) => { if (event.target === button) state.clicks++; }, true);
      button.form.addEventListener("submit", () => state.submits++); });
    phase = 1; await page.evaluate(() => { (window as unknown as { armed: boolean }).armed = true; window.dispatchEvent(new Event("focus")); });
    await expect.poll(() => Boolean(identity)).toBe(true);
    expect(await page.evaluate(() => { const state = window as unknown as { live?: boolean; clicks?: number; submits?: number }; return { live: state.live, clicks: state.clicks, submits: state.submits }; })).toEqual({ live: true, clicks: 1, submits: 1 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(writes).toBe(0); expect(await page.evaluate(() => (window as unknown as { writes?: number }).writes ?? 0)).toBe(0);
    await expect(page.getByText("Review a CSV import")).not.toBeVisible();
    phase = 2; identity!.end(JSON.stringify({ customerId, subject: "actor-a", roles: ["pmo_admin"] }));
    await expect(page.getByText("Review a CSV import")).toBeVisible();
    await expect(page.getByLabel("Synthetic project")).toBeChecked();
    await expect(page.getByLabel("Sheet label")).toHaveValue("New mapping draft");
    await expect(page.getByLabel("Configured source")).toHaveValue("");
    await page.getByRole("button", { name: "Create mapping" }).click();
    await expect.poll(() => writes).toBe(1);
  } finally { if (identity && !identity.writableEnded && !identity.destroyed) identity.end(); await context?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
