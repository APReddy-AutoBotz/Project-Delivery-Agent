import { test, expect } from "@playwright/test";

test("exhausted denied receipt tickets send no retry until the view is reopened", async ({ page }) => {
  test.setTimeout(180000);
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001", reviewId = "60000000-0000-4000-8000-000000000001";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  let previews = 0; const receiptReads = new Map<string, number>(), reviewBodies: unknown[] = [];
  const receipt = (id: string, parent: string | null) => ({ receipt: { id, sourceId, actor: "actor-a", kind: parent ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW",
    eventId: null, configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
    rowCount: 1, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: parent }, outcomes: [{ ordinal: 1, parentOrdinal: parent ? 1 : null,
      state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId, identity: ["csv-row", "one"], contentAvailable: true,
      proposals: [{ factType: "project.forecast", value: { type: "date", value: "2026-01-01" } }] }] });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-denied-capacity-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source] });
    if (path.endsWith("/csv-previews")) { previews++; return route.fulfill({ status: 201, json: { receiptId: `50000000-0000-4000-8000-${previews.toString(16).padStart(12, "0")}`, replayed: false, rowCount: 1 } }); }
    if (path.endsWith("/reviewed-imports")) { const body = route.request().postDataJSON() as { previewReceiptId: string }; reviewBodies.push(body);
      return reviewBodies.length === 1 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 201, json: { receiptId: reviewId, parentPreviewReceiptId: body.previewReceiptId, replayed: true, rowCount: 1 } }); }
    const match = /\/receipts\/([^/]+)$/.exec(path);
    if (match) {
      const id = match[1]!; if (id === reviewId) return route.fulfill({ json: receipt(id, `50000000-0000-4000-8000-${(64).toString(16).padStart(12, "0")}`) });
      const count = (receiptReads.get(id) ?? 0) + 1; receiptReads.set(id, count);
      return count === 2 ? route.fulfill({ status: 403, json: {} }) : route.fulfill({ json: receipt(id, null) });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  const file = { name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) };
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  for (let index = 1; index <= 64; index++) {
    await page.getByLabel("CSV file").setInputFiles(file); await page.getByRole("button", { name: "Upload and preview" }).click();
    await expect.poll(() => previews).toBe(index); await expect(page.getByLabel("Select row 1")).toBeVisible();
    if (index === 64) {
      await page.getByLabel("Select row 1").check(); await page.getByRole("button", { name: "Save 1 reviewed proposal" }).click();
      await expect(page.getByRole("button", { name: "Retry original reviewed selection" })).toBeEnabled(); expect(reviewBodies).toHaveLength(1);
    }
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert").filter({ hasText: "The receipt is unavailable." })).toBeVisible();
  }
  await page.getByRole("button", { name: "Retry original reviewed selection" }).click();
  await expect(page.getByText("Receipt access is at capacity. Reopen Data imports to try again.")).toBeVisible();
  expect(reviewBodies).toHaveLength(1);
  await page.getByRole("button", { name: "Projects", exact: true }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByRole("button", { name: "Retry original reviewed selection" }).click();
  await expect(page.getByText("Reviewed import receipt saved")).toBeVisible();
  expect(reviewBodies).toHaveLength(2); expect(reviewBodies[1]).toEqual(reviewBodies[0]);
});
