import { test, expect } from "@playwright/test";

test("confirmed preview retries its receipt without resending and saves reviewed proposals", async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const previewId = "50000000-0000-4000-8000-000000000001", reviewId = "50000000-0000-4000-8000-000000000002";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  const receipt = (review: boolean) => ({ receipt: { id: review ? reviewId : previewId, sourceId, actor: "actor-a", kind: review ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW",
    eventId: null, configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
    rowCount: review ? 1 : 3, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: review ? previewId : null },
    outcomes: (review ? [1] : [1, 2, 3]).map((ordinal) => ({ ordinal, parentOrdinal: review ? 1 : null, state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId,
      identity: ["csv-row", String(ordinal)], contentAvailable: true, proposals: [{ factType: "project.forecast", value: { type: "date", value: "2026-01-01" } }] })) });
  let previews = 0, reads = 0, reviews = 0; let reviewedBody: unknown;
  let releaseRecheck!: () => void, releaseRetry!: () => void;
  const recheckGate = new Promise<void>((resolve) => { releaseRecheck = resolve; });
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-receipt-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source] });
    if (path.endsWith("/csv-previews")) { previews++; return route.fulfill({ status: 201, json: { receiptId: previewId, replayed: false, rowCount: 3 } }); }
    if (path.endsWith(`/receipts/${previewId}`)) {
      reads++;
      if (reads === 1) return route.fulfill({ status: 503, json: {} });
      if (reads === 2) { await retryGate; return route.fulfill({ status: 503, json: {} }); }
      if (reads === 3) return route.fulfill({ status: 403, json: {} });
      if (reads === 4) return route.fulfill({ json: { ...receipt(false), outcomes: [] } });
      if (reads === 5) {
        const invalid = receipt(false); invalid.outcomes[0]!.contentAvailable = false;
        invalid.outcomes[0]!.proposals[0]!.value.value = "2099-09-09";
        return route.fulfill({ json: invalid });
      }
      if (reads === 7) {
        await recheckGate;
        const updated = receipt(false); updated.outcomes[0]!.proposals[0]!.value.value = "2026-02-02";
        updated.outcomes[2]!.contentAvailable = false; (updated.outcomes[2] as { proposals: unknown }).proposals = null;
        return route.fulfill({ json: updated });
      }
      return route.fulfill({ json: receipt(false) });
    }
    if (path.endsWith("/reviewed-imports")) { reviews++; reviewedBody = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { receiptId: reviewId, parentPreviewReceiptId: previewId, replayed: false, rowCount: 1 } }); }
    if (path.endsWith(`/receipts/${reviewId}`)) return route.fulfill({ json: receipt(true) });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByLabel("CSV file").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n2,${projectId},2026-01-01\n3,${projectId},2026-01-01\n`) });
  await page.getByRole("button", { name: "Upload and preview" }).click();
  await expect(page.getByText("Preview saved, but its receipt is unavailable.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload and preview" })).toBeDisabled();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: /Data imports/ }).click();
  await expect(page.getByText("The import operation was saved; its receipt is awaiting review.")).toBeVisible();
  await page.getByRole("button", { name: "Retry saved receipt" }).evaluate((button) => {
    const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Retry handler unavailable");
    (window as unknown as { oldReceiptRetry: () => void }).oldReceiptRetry = (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
  });
  await page.getByRole("button", { name: "Retry saved receipt" }).click();
  await expect.poll(() => reads).toBe(2);
  const busyRetry = page.getByRole("button", { name: "Retry saved receipt" }); await expect(busyRetry).toBeDisabled();
  await busyRetry.evaluate((button) => {
    const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Busy retry handler unavailable");
    (window as unknown as { busyReceiptRetry: () => void }).busyReceiptRetry = (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
  });
  releaseRetry();
  await expect(page.getByText("The saved receipt is unavailable.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry saved receipt" })).toBeEnabled(); expect(reads).toBe(2);
  await page.evaluate(() => (window as unknown as { oldReceiptRetry: () => void }).oldReceiptRetry());
  await page.evaluate(() => (window as unknown as { busyReceiptRetry: () => void }).busyReceiptRetry());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(reads).toBe(2);
  await page.getByRole("button", { name: "Retry saved receipt" }).click();
  await expect.poll(() => reads).toBe(3);
  await expect(page.getByRole("button", { name: "Retry saved receipt" })).toBeEnabled();
  await page.getByRole("button", { name: "Retry saved receipt" }).click();
  await expect.poll(() => reads).toBe(4);
  await expect(page.getByRole("button", { name: "Retry saved receipt" })).toBeEnabled();
  await page.getByRole("button", { name: "Retry saved receipt" }).click();
  await expect.poll(() => reads).toBe(5);
  await expect(page.getByRole("button", { name: "Retry saved receipt" })).toBeEnabled();
  await expect(page.getByText(/2099-09-09/)).toHaveCount(0);
  await page.getByRole("button", { name: "Retry saved receipt" }).click();
  await expect(page.getByText("Preview saved with 3 rows.", { exact: false })).toBeVisible(); expect(previews).toBe(1); expect(reads).toBe(6);
  await page.getByRole("button", { name: "Select eligible rows" }).click();
  await expect(page.getByLabel("Select row 1")).toBeChecked(); await expect(page.getByLabel("Select row 2")).toBeChecked(); await expect(page.getByLabel("Select row 3")).toBeChecked();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBe(7);
  await expect(page.getByLabel("Select row 1")).not.toBeVisible();
  releaseRecheck();
  await expect(page.getByText(/2026-02-02/)).toBeVisible();
  await expect(page.getByLabel("Select row 1")).not.toBeChecked();
  await expect(page.getByLabel("Select row 2")).toBeChecked();
  await expect(page.getByLabel("Select row 3")).not.toBeChecked(); await expect(page.getByLabel("Select row 3")).toBeDisabled();
  await expect(page.getByText("The preview changed. Review and select the proposals again.")).toBeVisible();
  await page.getByLabel("Select row 2").uncheck(); await page.getByLabel("Select row 1").check(); await page.getByRole("button", { name: "Save 1 reviewed proposal" }).click();
  await expect(page.getByText("Reviewed import receipt saved")).toBeVisible();
  expect(reviews).toBe(1); expect(reviewedBody).toMatchObject({ previewReceiptId: previewId, rowOrdinals: [1] });
  await expect(page.getByText("Canonical project facts were not changed.").first()).toBeVisible();
});
