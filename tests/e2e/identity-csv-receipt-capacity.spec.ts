import { test, expect } from "@playwright/test";

test("completed receipt tickets are retired before a 65th preview", async ({ page }) => {
  test.setTimeout(120000);
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  let posts = 0, reads = 0; const keys: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-capacity-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source] });
    if (path.endsWith("/csv-previews")) { posts++; const body = route.request().postData() ?? ""; const key = /name="commandKey"\r\n\r\n([^\r\n]+)/.exec(body)?.[1];
      if (!key) throw new Error("Command key missing"); keys.push(key);
      const receiptId = `50000000-0000-4000-8000-${posts.toString(16).padStart(12, "0")}`;
      return route.fulfill({ status: 201, json: { receiptId, replayed: false, rowCount: 0 } }); }
    const match = /\/receipts\/([^/]+)$/.exec(path);
    if (match) { reads++; return route.fulfill({ json: { receipt: { id: match[1], sourceId, actor: "actor-a", kind: "CSV_PREVIEW", eventId: null,
      configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
      rowCount: 0, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: null }, outcomes: [] } }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByLabel("CSV file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) });
  for (let index = 1; index <= 65; index++) {
    const upload = page.getByRole("button", { name: "Upload and preview" }); await expect(upload).toBeEnabled(); await upload.click();
    await expect.poll(() => reads).toBe(index); await expect(upload).toBeEnabled();
  }
  expect(posts).toBe(65); expect(reads).toBe(65); expect(new Set(keys).size).toBe(65);
});
