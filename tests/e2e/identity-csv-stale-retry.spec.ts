import { test, expect } from "@playwright/test";

test("an old preview retry callback cannot send a later command", async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  const bodies: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-stale-retry-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source] });
    if (path.endsWith("/csv-previews")) { bodies.push(route.request().postData() ?? "");
      return [1, 2, 4].includes(bodies.length) ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 201, json: {
        receiptId: `50000000-0000-4000-8000-${(bodies.length === 3 ? 1 : 2).toString(16).padStart(12, "0")}`, replayed: true, rowCount: 0 } }); }
    const match = /\/receipts\/([^/]+)$/.exec(path);
    if (match) return route.fulfill({ json: { receipt: { id: match[1], sourceId, actor: "actor-a", kind: "CSV_PREVIEW", eventId: null,
      configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
      rowCount: 0, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: null }, outcomes: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByLabel("CSV file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) });
  await page.getByRole("button", { name: "Upload and preview" }).click();
  const retry = page.getByRole("button", { name: "Retry same preview" }); await expect(retry).toBeEnabled();
  await retry.evaluate((button) => { const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Retry handler unavailable");
    (window as unknown as { oldPreviewRetry: () => void }).oldPreviewRetry = (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick; });
  await retry.click(); await expect(retry).toBeEnabled(); expect(bodies).toHaveLength(2);
  await page.evaluate(() => (window as unknown as { oldPreviewRetry: () => void }).oldPreviewRetry());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(bodies).toHaveLength(2);
  await retry.click(); await expect(page.getByRole("button", { name: "Upload and preview" })).toBeEnabled(); expect(bodies).toHaveLength(3);
  await page.getByRole("button", { name: "Upload and preview" }).click(); await expect(retry).toBeEnabled(); expect(bodies).toHaveLength(4);
  await page.evaluate(() => (window as unknown as { oldPreviewRetry: () => void }).oldPreviewRetry());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(bodies).toHaveLength(4);
  await retry.click(); await expect(page.getByRole("button", { name: "Upload and preview" })).toBeEnabled(); expect(bodies).toHaveLength(5);
  const key = (body: string) => /name="commandKey"\r\n\r\n([^\r\n]+)/.exec(body)?.[1];
  expect(key(bodies[0]!)).toBeTruthy(); expect(key(bodies[1]!)).toBe(key(bodies[0]!));
  expect(key(bodies[2]!)).toBe(key(bodies[0]!));
  expect(key(bodies[3]!)).not.toBe(key(bodies[0]!)); expect(key(bodies[4]!)).toBe(key(bodies[3]!));
});
