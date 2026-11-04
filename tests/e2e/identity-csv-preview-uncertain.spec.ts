import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

test("a pending CSV preview blocks a different actor from starting another source command", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  let actor = "actor-a", held: ServerResponse | undefined, posts = 0;
  const bodies: string[] = [];
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a", "actor-b"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "csv-preview-token" });
    if (path === "/api/me") return json(200, { customerId, subject: actor, roles: ["pmo_admin"] });
    if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === "/api/ingestion/sources") return json(200, [source]);
    if (path === `/api/ingestion/sources/${sourceId}/csv-previews`) { posts++; const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8")); if (!held) held = res;
      else json(201, { receiptId: "50000000-0000-4000-8000-000000000001", replayed: true, rowCount: 1 });
    }); return; }
    if (path === `/api/ingestion/sources/${sourceId}/receipts/50000000-0000-4000-8000-000000000001`) return json(200, {
      receipt: { id: "50000000-0000-4000-8000-000000000001", sourceId, actor: "actor-a", kind: "CSV_PREVIEW", eventId: null,
        configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
        rowCount: 1, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: null },
      outcomes: [{ ordinal: 1, parentOrdinal: null, state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId,
        identity: ["csv-row", "one"], contentAvailable: true, proposals: [{ factType: "project.forecast", value: { type: "date", value: "2026-01-01" } }] }],
    });
    if (path.startsWith("/api/")) return json(404, {});
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback unavailable");
    context = await browser.newContext(); const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await page.getByLabel("CSV file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) });
    await page.getByRole("button", { name: "Upload and preview" }).click(); await expect.poll(() => Boolean(held)).toBe(true); expect(posts).toBe(1);
    actor = "actor-b"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("actor-b", { exact: true })).toBeVisible();
    await expect(page.getByLabel("CSV file")).toBeVisible();
    await page.getByLabel("CSV file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) });
    await expect(page.getByText("A source import operation is pending.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload and preview" })).toBeDisabled();
    await page.getByRole("button", { name: "Upload and preview" }).evaluate((button: HTMLButtonElement) => button.click());
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(posts).toBe(1);
    held!.writeHead(201, { "Content-Type": "application/json" }); held!.end(JSON.stringify({ receiptId: "50000000-0000-4000-8000-000000000001", replayed: false, rowCount: 1 }));
    await expect(page.getByText("An earlier source import operation could not be confirmed.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload and preview" })).toBeDisabled(); expect(posts).toBe(1);
    actor = "actor-a"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("actor-a", { exact: true })).toBeVisible();
    await page.getByLabel("CSV file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) });
    await page.getByRole("button", { name: "Retry same preview" }).click();
    await expect(page.getByText("Preview saved with 1 rows.", { exact: false })).toBeVisible(); expect(posts).toBe(2);
    const key = (body: string) => /name="commandKey"\r\n\r\n([^\r\n]+)/.exec(body)?.[1];
    expect(key(bodies[0]!)).toBeTruthy(); expect(key(bodies[1]!)).toBe(key(bodies[0]!));
  } finally { if (held && !held.writableEnded && !held.destroyed) held.end(); await context?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
