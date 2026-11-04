import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

test("confirmed receipt recovers with GET only after a physical read slot is released", async ({ browser }) => {
  test.setTimeout(120000);
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001";
  const a = "40000000-0000-4000-8000-000000000001", b = "40000000-0000-4000-8000-000000000002";
  const receiptA = "50000000-0000-4000-8000-000000000001", receiptB = "50000000-0000-4000-8000-000000000002";
  const source = (sourceId: string) => ({ sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } });
  const receipt = (sourceId: string, id: string, value: string) => ({ receipt: { id, sourceId, actor: "actor-a", kind: "CSV_PREVIEW", eventId: null,
    configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
    rowCount: 1, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: null }, outcomes: [{ ordinal: 1, parentOrdinal: null,
      state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId, identity: ["csv-row", "one"], contentAvailable: true,
      proposals: [{ factType: "project.forecast", value: { type: "text", value } }] }] });
  let preferB = false, postsA = 0, postsB = 0, getsB = 0; const held: ServerResponse[] = [], aborted: number[] = [], methodsA: string[] = [], methodsB: string[] = [], methodsReceiptB: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "csv-physical-token" });
    if (path === "/api/me") return json(200, { customerId, subject: "actor-a", roles: ["pmo_admin"] });
    if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === "/api/ingestion/sources") return json(200, preferB ? [source(b), source(a)] : [source(a), source(b)]);
    if (path === `/api/ingestion/sources/${a}/csv-previews`) { postsA++; methodsA.push(req.method ?? ""); req.resume(); return json(201, { receiptId: receiptA, replayed: false, rowCount: 1 }); }
    if (path === `/api/ingestion/sources/${b}/csv-previews`) { postsB++; methodsB.push(req.method ?? ""); req.resume(); return json(201, { receiptId: receiptB, replayed: false, rowCount: 1 }); }
    if (path === `/api/ingestion/sources/${a}/receipts/${receiptA}`) {
      held.push(res); const index = held.length; res.on("close", () => { if (!res.writableFinished) aborted.push(index); });
      res.writeHead(200, { "Content-Type": "application/json", "x-held-receipt": String(index) }); res.flushHeaders(); return;
    }
    if (path === `/api/ingestion/sources/${b}/receipts/${receiptB}`) { getsB++; methodsReceiptB.push(req.method ?? ""); return json(200, receipt(b, receiptB, "current-b-only")); }
    if (path.startsWith("/api/")) return json(404, {});
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const heldServers = [0, 1].map(() => createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "x-held-receipt");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    server.emit("request", req, res);
  }));
  await Promise.all(heldServers.map((listener) => new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); })));
  const ports = heldServers.map((listener) => { const addr = listener.address(); if (!addr || typeof addr === "string") throw new Error("Held loopback unavailable"); return addr.port; });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback unavailable");
    context = await browser.newContext(); await context.addInitScript(({ ports, receiptPath }) => {
      const original = window.fetch.bind(window); let nextHeld = 0;
      window.fetch = async (input, init) => {
        const requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (requestUrl.pathname === receiptPath) {
          requestUrl.port = String(ports[nextHeld++ % ports.length]);
          input = input instanceof Request ? new Request(requestUrl, input) : requestUrl;
        }
        const response = await original(input, init), marker = response.headers.get("x-held-receipt");
        if (marker && response.body) {
          const state = window as unknown as { readers?: Record<string, boolean>; eof?: Record<string, boolean>; released?: Record<string, boolean> };
          state.readers ??= {}; state.eof ??= {}; state.released ??= {};
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => { state.readers![marker] = true; const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            reader.read = async () => { const value = await read(); if (value.done) state.eof![marker] = true; return value; };
            reader.releaseLock = () => { release(); state.released![marker] = true; }; return reader; }) as typeof stream.getReader;
        }
        return response;
      };
    }, { ports, receiptPath: `/api/ingestion/sources/${a}/receipts/${receiptA}` });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    const file = { name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) };
    await page.getByLabel("CSV file").setInputFiles(file); await page.getByRole("button", { name: "Upload and preview" }).click();
    for (let index = 1; index <= 8; index++) {
      await expect.poll(() => held.length).toBe(index);
      await expect.poll(() => page.evaluate((id) => Boolean((window as unknown as { readers?: Record<string, boolean> }).readers?.[id]), String(index))).toBe(true);
      expect(aborted).toEqual([]);
      if (index < 8) { await page.getByRole("button", { name: "Projects", exact: true }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
        await page.getByRole("button", { name: "Retry saved receipt" }).click(); }
    }
    expect(postsA).toBe(1); preferB = true;
    await page.getByRole("button", { name: "Projects", exact: true }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await expect(page.getByLabel("Configured source")).toHaveValue(b);
    await page.getByLabel("CSV file").setInputFiles(file); await page.getByRole("button", { name: "Upload and preview" }).click();
    await expect(page.getByText("Preview saved, but its receipt is unavailable.")).toBeVisible();
    expect(postsB).toBe(1); expect(getsB).toBe(0); await expect(page.getByRole("button", { name: "Retry saved receipt" })).toBeEnabled();
    held[0]!.end(JSON.stringify(receipt(a, receiptA, "old-a-canary")));
    await expect.poll(() => page.evaluate(() => { const state = window as unknown as { eof?: Record<string, boolean>; released?: Record<string, boolean> }; return Boolean(state.eof?.["1"] && state.released?.["1"]); })).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText(/old-a-canary/)).toHaveCount(0);
    await page.getByRole("button", { name: "Retry saved receipt" }).click();
    await expect(page.getByText(/current-b-only/)).toBeVisible(); expect(getsB).toBe(1); expect(postsB).toBe(1); expect(postsA).toBe(1); expect(methodsA).toEqual(["POST"]); expect(methodsB).toEqual(["POST"]); expect(methodsReceiptB).toEqual(["GET"]); expect(aborted).toEqual([]);
  } finally {
    for (const response of held) if (!response.writableEnded && !response.destroyed) response.end(JSON.stringify(receipt(a, receiptA, "cleanup")));
    await context?.close(); for (const listener of heldServers) { listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); }
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
