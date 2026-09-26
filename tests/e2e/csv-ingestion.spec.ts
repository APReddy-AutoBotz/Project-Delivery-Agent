import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const customerId = "10000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
let sourceId = "";
const previewReceiptId = randomUUID();
const reviewedReceiptId = randomUUID();
const actor = { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] };
const project = {
  id: projectId,
  code: "CSV-DEMO",
  name: "CSV import demonstration",
  description: "Synthetic project used by the browser workflow.",
  reportedStatus: "GREEN",
};
const source = {
  sourceId,
  sourceType: "csv-upload",
  origin: "https://csv-upload.invalid",
  configRevision: 1,
  mappingRevision: 1,
  configuration: {
    binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" },
    projects: [{ projectId, readers: [actor.subject] }],
    mapping: {
      kind: "CSV",
      sheet: "Projects",
      identityColumn: "Issue ID",
      projectColumn: "Project ID",
      fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }],
    },
  },
  healthState: "UNKNOWN",
  healthCode: "NONE",
  healthCheckedAt: null,
};
const preview = {
  receipt: {
    id: previewReceiptId,
    kind: "CSV_PREVIEW",
    rowCount: 3,
    configRevision: 1,
    mappingRevision: 1,
    parentPreviewReceiptId: null,
  },
  outcomes: [
    {
      ordinal: 1,
      parentOrdinal: null,
      state: "ACCEPTED",
      operation: "CREATE",
      errorCodes: [],
      projectId,
      identity: ["spreadsheet:Projects", "a".repeat(64)],
      contentAvailable: true,
      proposals: [{ factType: "project.forecast", value: { type: "date", value: "2027-03-01" } }],
    },
    {
      ordinal: 2,
      parentOrdinal: null,
      state: "INVALID",
      operation: "NONE",
      errorCodes: ["INVALID_VALUE"],
      projectId,
      identity: ["spreadsheet:Projects", "b".repeat(64)],
      contentAvailable: false,
      proposals: null,
    },
    {
      ordinal: 3,
      parentOrdinal: null,
      state: "ACCEPTED",
      operation: "UPDATE",
      errorCodes: [],
      projectId,
      identity: ["spreadsheet:Projects", "c".repeat(64)],
      contentAvailable: true,
      proposals: [{ factType: "project.forecast", value: { type: "date", value: "2027-04-15" } }],
    },
  ],
};

test("FR-CON-006/007: PMO admin saves selected CSV proposals without publishing facts", async ({ page }) => {
  let configured = false;
  let configurationBody: Record<string, unknown> | undefined;
  let previewContentType = "";
  let previewBody = "";
  let reviewedSelection: Record<string, unknown> | undefined;
  let factWrites = 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/auth/config")
      return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development")
      return route.fulfill({ json: { token: "synthetic-browser-token" } });
    if (path === "/me") return route.fulfill({ json: actor });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === "/project-setup") return route.fulfill({ json: { portfolios: [] } });
    if (path === "/ingestion/sources")
      return route.fulfill({ json: configured ? [source] : [] });
    if (path === "/ingestion/sources/configuration" && request.method() === "POST") {
      configurationBody = request.postDataJSON() as Record<string, unknown>;
      const binding = configurationBody.binding as { sourceId: string };
      sourceId = binding.sourceId;
      source.sourceId = sourceId;
      source.configuration = configurationBody as typeof source.configuration;
      configured = true;
      return route.fulfill({ status: 201, json: { sourceId, configRevision: 1, mappingRevision: 1 } });
    }
    if (path === `/ingestion/sources/${sourceId}/csv-previews` && request.method() === "POST") {
      previewContentType = request.headers()["content-type"] ?? "";
      previewBody = request.postDataBuffer()?.toString("utf8") ?? "";
      return route.fulfill({ status: 201, json: { receiptId: previewReceiptId, replayed: false, rowCount: 3 } });
    }
    if (path === `/ingestion/sources/${sourceId}/receipts/${previewReceiptId}`)
      return route.fulfill({ json: preview });
    if (path === `/ingestion/sources/${sourceId}/reviewed-imports` && request.method() === "POST") {
      reviewedSelection = request.postDataJSON() as Record<string, unknown>;
      return route.fulfill({ status: 201, json: { receiptId: reviewedReceiptId, parentPreviewReceiptId: previewReceiptId, replayed: false, rowCount: 2 } });
    }
    if (path === `/ingestion/sources/${sourceId}/receipts/${reviewedReceiptId}`)
      return route.fulfill({
        json: {
          ...preview,
          receipt: {
            ...preview.receipt,
            id: reviewedReceiptId,
            kind: "CSV_REVIEWED_IMPORT",
            rowCount: 2,
            parentPreviewReceiptId: previewReceiptId,
          },
          outcomes: preview.outcomes
            .filter((row) => row.ordinal === 1 || row.ordinal === 3)
            .map((row) => ({ ...row, parentOrdinal: row.ordinal })),
        },
      });
    if (/\/facts(?:\/|$)/.test(path) && request.method() !== "GET") factWrites++;
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page.getByRole("button", { name: /Data imports/ }).click();
  await expect(page.getByRole("heading", { name: "Review a CSV import" })).toBeVisible();
  await page.getByLabel(/CSV import demonstration/).check();
  await page.getByRole("button", { name: "Create mapping" }).click();
  await expect(page.getByText("Mapping saved.")).toBeVisible();
  expect(configurationBody).toMatchObject({
    binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" },
    projects: [{ projectId, readers: [actor.subject] }],
    mapping: { kind: "CSV", identityColumn: "Issue ID", projectColumn: "Project ID" },
  });

  await page.getByLabel("CSV file").setInputFiles({
    name: "review.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`Issue ID,Project ID,Forecast\nDELIVERY-1,${projectId},2027-03-01\nDELIVERY-2,${projectId},not-a-date\nDELIVERY-3,${projectId},2027-04-15`, "utf8"),
  });
  await page.getByRole("button", { name: "Upload and preview" }).click();
  await expect(page.getByRole("heading", { name: `Preview ${previewReceiptId.slice(0, 8)}` })).toBeVisible();
  expect(previewContentType).toMatch(/^multipart\/form-data\s*;\s*boundary=/i);
  expect(previewContentType).not.toContain("application/json");
  expect(previewBody).toContain(`Issue ID,Project ID,Forecast\nDELIVERY-1,${projectId},2027-03-01\nDELIVERY-2,${projectId},not-a-date\nDELIVERY-3,${projectId},2027-04-15`);

  // The preview presents both eligible planned operations and the invalid row
  // together before any reviewed proposal is saved.
  const previewRows = page.getByRole("row");
  await expect(previewRows).toHaveCount(4);
  await expect(previewRows.nth(1)).toContainText("ACCEPTED");
  await expect(previewRows.nth(1)).toContainText("CREATE");
  await expect(previewRows.nth(2)).toContainText("INVALID");
  await expect(previewRows.nth(2)).toContainText("INVALID VALUE");
  await expect(previewRows.nth(2)).toContainText("NONE");
  await expect(previewRows.nth(3)).toContainText("ACCEPTED");
  await expect(previewRows.nth(3)).toContainText("UPDATE");
  await expect(previewRows.nth(3)).toContainText("2027-04-15");
  await expect(page.getByRole("checkbox", { name: "Select row 1" })).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: "Select row 2" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Select row 3" })).toBeEnabled();

  await page.getByRole("button", { name: "Select eligible rows" }).click();
  await page.getByRole("button", { name: "Save 2 reviewed proposals" }).click();
  await expect(page.getByText("Reviewed import receipt saved")).toBeVisible();
  await expect(page.getByText("2 reviewed proposals saved. Canonical project facts were not changed.")).toBeVisible();
  await expect(page.getByText("Canonical project facts were not changed.", { exact: true })).toBeVisible();
  expect(reviewedSelection).toMatchObject({ previewReceiptId, rowOrdinals: [1, 3] });
  expect(factWrites).toBe(0);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/csv-reviewed-import.png", fullPage: true });
});
