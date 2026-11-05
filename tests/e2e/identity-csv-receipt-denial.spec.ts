import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

for (const scenario of ["stale", "current", "stale-selection"] as const) test(`receipt ${scenario} denial preserves exact review retry ownership`, async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const previewId = "50000000-0000-4000-8000-000000000001", reviewId = "50000000-0000-4000-8000-000000000002";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  const receipt = (review: boolean) => ({ receipt: { id: review ? reviewId : previewId, sourceId, actor: "actor-a", kind: review ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW",
    eventId: null, configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
    rowCount: 1, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: review ? previewId : null },
    outcomes: [{ ordinal: 1, parentOrdinal: review ? 1 : null, state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId,
      identity: ["csv-row", "one"], contentAvailable: true, proposals: [{ factType: "project.forecast", value: { type: "date", value: "2026-01-01" } }] }] });
  let reads = 0, reviews = 0, oldRead: ServerResponse | undefined, retryRead: ServerResponse | undefined;
  const reviewBodies: unknown[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "csv-denial-token" });
    if (path === "/api/me") return json(200, { customerId, subject: "actor-a", roles: ["pmo_admin"] });
    if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === "/api/ingestion/sources") return json(200, [source]);
    if (path === `/api/ingestion/sources/${sourceId}/csv-previews`) { req.resume(); return json(201, { receiptId: previewId, replayed: false, rowCount: 1 }); }
    if (path === `/api/ingestion/sources/${sourceId}/receipts/${previewId}`) {
      reads++; if (reads === 2) { oldRead = res; return; } if (reads === 3) { retryRead = res; return; } return json(200, receipt(false));
    }
    if (path === `/api/ingestion/sources/${sourceId}/reviewed-imports`) {
      reviews++; const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
        reviewBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (reviews === 1) json(503, {}); else json(201, { receiptId: reviewId, parentPreviewReceiptId: previewId, replayed: true, rowCount: 1 });
      }); return;
    }
    if (path === `/api/ingestion/sources/${sourceId}/receipts/${reviewId}`) return json(200, receipt(true));
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
        const response = await original(input, init), marker = response.headers.get("x-receipt-test");
        const state = window as unknown as { oldCallback?: () => void; invoked?: number; oldEof?: boolean; oldReleased?: boolean; currentEof?: boolean; currentReleased?: boolean };
        if (marker && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            if (marker === "current" && state.oldCallback) { state.invoked = (state.invoked ?? 0) + 1; state.oldCallback(); }
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            reader.read = async () => { const value = await read(); if (value.done) { if (marker === "old") state.oldEof = true; else state.currentEof = true; } return value; };
            reader.releaseLock = () => { release(); if (marker === "old") state.oldReleased = true; else state.currentReleased = true; }; return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await page.getByLabel("CSV file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) });
    await page.getByRole("button", { name: "Upload and preview" }).click(); await page.getByLabel("Select row 1").check();
    if (scenario === "stale-selection") {
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => Boolean(oldRead)).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => Boolean(retryRead)).toBe(true);
      retryRead!.writeHead(200, { "Content-Type": "application/json" }); retryRead!.end(JSON.stringify(receipt(false)));
      await expect(page.getByLabel("Select row 1")).toBeEnabled();
      await page.getByLabel("Select row 1").check();
      oldRead!.writeHead(403, { "Content-Type": "application/json", "x-receipt-test": "old" }); oldRead!.end(JSON.stringify({ message: "denied" }));
      await expect.poll(() => page.evaluate(() => { const s = window as unknown as { oldEof?: boolean; oldReleased?: boolean }; return Boolean(s.oldEof && s.oldReleased); })).toBe(true);
      await expect(page.getByLabel("Select row 1")).toBeChecked();
      await page.getByRole("button", { name: "Save 1 reviewed proposal" }).click();
      await expect.poll(() => reviews).toBe(1);
      await expect.poll(() => reviewBodies.length).toBe(1);
      expect(reviewBodies[0]).toMatchObject({ previewReceiptId: previewId, rowOrdinals: [1] });
      return;
    }
    await page.getByRole("button", { name: "Save 1 reviewed proposal" }).click();
    await expect(page.getByRole("button", { name: "Retry original reviewed selection" })).toBeEnabled(); expect(reviews).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => Boolean(oldRead)).toBe(true);
    const retry = page.getByRole("button", { name: "Retry original reviewed selection" }); await expect(retry).toBeEnabled();
    await retry.evaluate((button) => {
      const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Retry handler unavailable");
      const props = (button as unknown as Record<string, { onClick: () => void }>)[key]!;
      (window as unknown as { oldCallback: () => void }).oldCallback = props.onClick;
    });
    await retry.click(); await expect.poll(() => Boolean(retryRead)).toBe(true); expect(reads).toBe(3);
    if (scenario === "stale") {
      oldRead!.writeHead(403, { "Content-Type": "application/json", "x-receipt-test": "old" }); oldRead!.flushHeaders();
      retryRead!.writeHead(200, { "Content-Type": "application/json" }); retryRead!.end(JSON.stringify(receipt(false)));
      await expect(page.getByText("Reviewed import receipt saved")).toBeVisible(); expect(reviews).toBe(2);
      oldRead!.end(JSON.stringify({ message: "denied" }));
      await expect.poll(() => page.evaluate(() => { const s = window as unknown as { oldEof?: boolean; oldReleased?: boolean }; return Boolean(s.oldEof && s.oldReleased); })).toBe(true);
      await expect(page.getByText("Reviewed import receipt saved")).toBeVisible();
    } else {
      retryRead!.writeHead(403, { "Content-Type": "application/json", "x-receipt-test": "current" }); retryRead!.flushHeaders();
      await expect.poll(() => page.evaluate(() => (window as unknown as { invoked?: number }).invoked ?? 0)).toBe(1);
      expect(reviews).toBe(1); expect(reads).toBe(3);
      oldRead!.writeHead(200, { "Content-Type": "application/json" }); oldRead!.end(JSON.stringify(receipt(false)));
      retryRead!.end(JSON.stringify({ message: "denied" }));
      await expect.poll(() => page.evaluate(() => { const s = window as unknown as { currentEof?: boolean; currentReleased?: boolean }; return Boolean(s.currentEof && s.currentReleased); })).toBe(true);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("alert").filter({ hasText: "The receipt is unavailable." })).toBeVisible();
      expect(reads).toBe(3);
      await expect(retry).toBeEnabled(); await retry.click();
      await expect(page.getByText("Reviewed import receipt saved")).toBeVisible(); expect(reviews).toBe(2); expect(reads).toBe(4);
    }
    expect(reviewBodies).toHaveLength(2); expect(reviewBodies[1]).toEqual(reviewBodies[0]);
  } finally {
    for (const response of [oldRead, retryRead]) if (response && !response.writableEnded && !response.destroyed) response.end();
    await context?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
