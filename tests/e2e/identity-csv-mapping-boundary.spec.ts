import { test, expect } from "@playwright/test";

test("dirty mappings and old previews cannot authorize a reviewed import", async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const preview1 = "50000000-0000-4000-8000-000000000001", preview2 = "50000000-0000-4000-8000-000000000002", reviewId = "60000000-0000-4000-8000-000000000001";
  let revision = 1, previews = 0, reviews = 0; const previewBodies: string[] = [];
  const source = () => ({ sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: revision, mappingRevision: revision,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: revision === 1 ? "Projects" : "Projects v2", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } });
  const receipt = (id: string, sourceRevision: number, parent: string | null) => ({ receipt: { id, sourceId, actor: "actor-a", kind: parent ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW",
    eventId: null, configRevision: sourceRevision, mappingRevision: sourceRevision, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
    rowCount: 1, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: parent }, outcomes: [{ ordinal: 1, parentOrdinal: parent ? 1 : null,
      state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId, identity: ["csv-row", "one"], contentAvailable: true,
      proposals: [{ factType: "project.forecast", value: { type: "date", value: "2026-01-01" } }] }] });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-mapping-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source()] });
    if (path.endsWith("/csv-previews")) { previews++; previewBodies.push(route.request().postData() ?? "");
      return route.fulfill({ status: 201, json: { receiptId: previews === 1 ? preview1 : preview2, replayed: false, rowCount: 1 } }); }
    if (path.endsWith(`/receipts/${preview1}`)) return route.fulfill({ json: receipt(preview1, 1, null) });
    if (path.endsWith(`/receipts/${preview2}`)) return route.fulfill({ json: receipt(preview2, 2, null) });
    if (path.endsWith("/reviewed-imports")) { reviews++; const body = route.request().postDataJSON() as { previewReceiptId: string; rowOrdinals: number[] };
      expect(body).toMatchObject({ previewReceiptId: preview2, rowOrdinals: [1] });
      return route.fulfill({ status: 201, json: { receiptId: reviewId, parentPreviewReceiptId: preview2, replayed: false, rowCount: 1 } }); }
    if (path.endsWith(`/receipts/${reviewId}`)) return route.fulfill({ json: receipt(reviewId, 2, preview2) });
    return route.fulfill({ status: 404, json: {} });
  });
  const file = { name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) };
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByLabel("CSV file").setInputFiles(file); await page.getByRole("button", { name: "Upload and preview" }).click();
  await page.getByLabel("Select row 1").check(); await page.getByLabel("Sheet label").fill("Unsaved mapping");
  await expect(page.getByRole("button", { name: "Upload and preview" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save 1 reviewed proposal" })).toBeDisabled(); expect(previews).toBe(1); expect(reviews).toBe(0);
  await page.getByRole("button", { name: "Discard mapping draft" }).click();
  await expect(page.getByLabel("Sheet label")).toHaveValue("Projects");
  await expect(page.getByLabel("Select row 1")).toBeChecked();
  revision = 2; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByLabel("Sheet label")).toHaveValue("Projects v2");
  await expect(page.getByText("This preview used an earlier source configuration.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Select row 1")).toBeDisabled(); expect(reviews).toBe(0);
  await page.getByLabel("CSV file").setInputFiles(file); await page.getByRole("button", { name: "Upload and preview" }).click();
  await expect.poll(() => previews).toBe(2); expect(previewBodies[1]).toMatch(/name="configRevision"\r\n\r\n2\r\n/);
  await page.getByLabel("Select row 1").check(); await page.getByRole("button", { name: "Save 1 reviewed proposal" }).click();
  await expect(page.getByText("Reviewed import receipt saved")).toBeVisible(); expect(reviews).toBe(1);
});
