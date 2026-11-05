import { test, expect } from "@playwright/test";

for (const replayed of [true, false]) test(`CSV preview and review retry their original command with replayed=${replayed}`, async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const previewId = "50000000-0000-4000-8000-000000000001", reviewId = "50000000-0000-4000-8000-000000000002";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  const receipt = (review: boolean) => ({ receipt: { id: review ? reviewId : previewId, sourceId, actor: "actor-a", kind: review ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW",
    eventId: null, configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
    rowCount: review ? 1 : 3, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: review ? previewId : null },
    outcomes: (review ? [1] : [1, 2, 3]).map((ordinal) => ({ ordinal, parentOrdinal: review ? 1 : null, state: "ACCEPTED", operation: ordinal === 2 ? "NONE" : "CREATE", errorCodes: ordinal === 3 ? ["INVALID_VALUE"] : [], projectId,
      identity: ["csv-row", String(ordinal)], contentAvailable: true, proposals: ordinal === 2 ? [] : [{ factType: "project.forecast", value: { type: "date", value: "2026-01-01" } }] })) });
  const previewBodies: string[] = [], reviewBodies: Array<{ previewReceiptId: string; rowOrdinals: number[]; commandKey: string }> = [];
  const previewMetadata: Array<{ method: string; bearer: string | undefined }> = [];
  let previewReads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-replay-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source] });
    if (path.endsWith("/csv-previews")) { previewBodies.push(route.request().postData() ?? ""); previewMetadata.push({ method: route.request().method(), bearer: route.request().headers().authorization });
      return previewBodies.length === 1 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 201, json: { receiptId: previewId, replayed, rowCount: 3 } }); }
    if (path.endsWith(`/receipts/${previewId}`)) {
      previewReads++; const value = receipt(false);
      if (reviewBodies.length) for (const row of value.outcomes) { row.contentAvailable = false; (row as { proposals: unknown }).proposals = null; }
      return route.fulfill({ json: value });
    }
    if (path.endsWith("/reviewed-imports")) { reviewBodies.push(route.request().postDataJSON()); return reviewBodies.length <= 2 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 201, json: { receiptId: reviewId, parentPreviewReceiptId: previewId, replayed, rowCount: 1 } }); }
    if (path.endsWith(`/receipts/${reviewId}`)) return route.fulfill({ json: receipt(true) });
    return route.fulfill({ status: 404, json: {} });
  });
  const contents = `Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n2,${projectId},2026-01-01\n3,${projectId},2026-01-01\n`;
  const file = (text: string) => ({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(text) });
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByLabel("CSV file").setInputFiles(file(contents)); await page.getByRole("button", { name: "Upload and preview" }).click();
  await expect(page.getByRole("button", { name: "Retry same preview" })).toBeEnabled(); expect(previewBodies).toHaveLength(1);
  await page.getByLabel("CSV file").setInputFiles(file(contents.replace("2026-01-01", "2027-01-01")));
  await page.getByRole("button", { name: "Retry same preview" }).click();
  await expect(page.getByText("Only the original preview can be retried.")).toBeVisible(); expect(previewBodies).toHaveLength(1);
  await page.getByLabel("CSV file").setInputFiles(file(contents)); await page.getByRole("button", { name: "Retry same preview" }).click();
  await expect(page.getByText("Preview saved with 3 rows.", { exact: false })).toBeVisible(); expect(previewBodies).toHaveLength(2);
  const key = (body: string) => /name="commandKey"\r\n\r\n([^\r\n]+)/.exec(body)?.[1];
  expect(key(previewBodies[0]!)).toBeTruthy(); expect(key(previewBodies[1]!)).toBe(key(previewBodies[0]!));
  for (const body of previewBodies) {
    expect(body).toContain(contents);
    expect(body).toMatch(/name="configRevision"\r\n\r\n1\r\n/);
    expect(body).toMatch(/name="mappingRevision"\r\n\r\n1\r\n/);
  }
  expect(previewMetadata).toEqual([{ method: "POST", bearer: "Bearer csv-replay-token" }, { method: "POST", bearer: "Bearer csv-replay-token" }]);
  await expect(page.getByLabel("Select row 2")).toBeDisabled();
  await expect(page.getByLabel("Select row 3")).toBeDisabled();
  await page.getByLabel("Select row 1").check(); await page.getByRole("button", { name: "Save 1 reviewed proposal" }).click();
  await expect(page.getByRole("button", { name: "Retry original reviewed selection" })).toBeEnabled(); expect(reviewBodies).toHaveLength(1);
  const retryReview = page.getByRole("button", { name: "Retry original reviewed selection" });
  await retryReview.evaluate((button) => { const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Retry handler unavailable");
    (window as unknown as { oldReviewRetry: () => void }).oldReviewRetry = (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick; });
  await retryReview.click(); await expect(retryReview).toBeEnabled(); expect(reviewBodies).toHaveLength(2);
  await page.evaluate(() => (window as unknown as { oldReviewRetry: () => void }).oldReviewRetry());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(reviewBodies).toHaveLength(2);
  await page.getByRole("button", { name: "Projects", exact: true }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByRole("button", { name: "Retry original reviewed selection" }).click();
  await expect(page.getByText("Reviewed import receipt saved")).toBeVisible();
  expect(reviewBodies).toHaveLength(3); expect(reviewBodies[1]).toEqual(reviewBodies[0]); expect(reviewBodies[2]).toEqual(reviewBodies[0]);
  expect(previewReads).toBeGreaterThanOrEqual(2);
  expect(reviewBodies[0]).toMatchObject({ previewReceiptId: previewId, rowOrdinals: [1] });
  await expect(page.getByText("Canonical project facts were not changed.").first()).toBeVisible();
});
