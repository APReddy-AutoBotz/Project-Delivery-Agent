import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

test("a stale mapping acknowledgment leaves its source unresolved", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  let held: ServerResponse | undefined, writes = 0, identityReads = 0;
  const bodies: unknown[] = [];
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }], mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "csv-write-token" });
    if (path === "/api/me") { identityReads++; return json(200, { customerId, subject: "actor-a", roles: ["pmo_admin"] }); }
    if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === "/api/ingestion/sources") return json(200, [source]);
    if (path === "/api/ingestion/sources/configuration") { writes++; const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); held = res; res.writeHead(201, { "Content-Type": "application/json", "x-csv-write": "held" }); res.flushHeaders(); }); return; }
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
        const response = await original(input, init), state = window as unknown as { eof?: boolean; released?: boolean };
        if (response.headers.get("x-csv-write") === "held" && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => { const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            reader.read = async () => { const value = await read(); if (value.done) state.eof = true; return value; };
            reader.releaseLock = () => { release(); state.released = true; }; return reader; }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await expect(page.getByRole("button", { name: "Save mapping" })).toBeEnabled();
    // Invoke the captured React handlers in one task to force the pre-commit
    // ordering; the later requestSubmit calls exercise native submission.
    expect(await page.getByLabel("Sheet label").evaluate((input) => {
      if (!(input instanceof HTMLInputElement) || !input.form) throw new Error("Mapping field unavailable");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const button = [...input.form.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Save mapping");
      const root = input.closest(".csv-ingestion");
      const props = (element: Element) => {
        const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
        if (!key) throw new Error("React fixture props unavailable");
        return (element as unknown as Record<string, Record<string, (...args: unknown[]) => void>>)[key]!;
      };
      if (!setter || !root || !(button instanceof HTMLButtonElement)) throw new Error("Mapping controls unavailable");
      const capture = props(root).onChangeCapture!, change = props(input).onChange!, submit = props(input.form).onSubmit!;
      setter.call(input, "Edited sheet");
      capture({ target: input, stopPropagation() { throw new Error("Current edit unexpectedly blocked"); } });
      change({ target: input });
      submit({ preventDefault() {}, nativeEvent: { submitter: button } });
      return true;
    })).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(writes, JSON.stringify(bodies)).toBe(0); await expect(page.getByLabel("Sheet label")).toHaveValue("Edited sheet");
    await page.evaluate(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Save mapping");
      if (!(button instanceof HTMLButtonElement) || !button.form) throw new Error("Mapping unavailable");
      button.form.requestSubmit(button); button.form.requestSubmit(button); });
    await expect.poll(() => bodies.length).toBe(1); expect(writes).toBe(1);
    expect(bodies[0]).toMatchObject({ binding: { customerId, sourceId }, mapping: { sheet: "Edited sheet" } });
    const previousIdentityReads = identityReads; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => identityReads).toBeGreaterThan(previousIdentityReads);
    await expect(page.getByText("A mapping change is pending.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Saving mapping|Save mapping/ })).toBeDisabled();
    held!.end(JSON.stringify({ sourceId, configRevision: 2, mappingRevision: 1 }));
    await expect.poll(() => page.evaluate(() => { const state = window as unknown as { eof?: boolean; released?: boolean }; return Boolean(state.eof && state.released); })).toBe(true);
    await expect(page.getByText("An earlier mapping change could not be confirmed.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save mapping" })).toBeDisabled();
    await expect(page.getByText("Mapping saved.", { exact: false })).toHaveCount(0); expect(writes).toBe(1);
  } finally { if (held && !held.writableEnded && !held.destroyed) held.end(); await context?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
