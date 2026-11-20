import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Request } from "@playwright/test";

const api = "/api/ingestion/xlsx/sources";
const customerId = "10000000-0000-4000-8000-000000000001";
const projectId = "30000000-0000-4000-8000-000000000001";
const sourceId = "40000000-0000-4000-8000-000000000001";
const otherSourceId = "40000000-0000-4000-8000-000000000002";
const previewId = "50000000-0000-4000-8000-000000000001";
const reviewedId = "50000000-0000-4000-8000-000000000002";
const sheet = "État des projets";
const digest = "a".repeat(64);
const workbookMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const createdAt = "2026-11-20T00:00:00.000Z";
const fixture = () => readFile("tests/fixtures/xlsx-archive-portfolio.xlsx");
const uploadContractPath = "/api/ingestion/xlsx/sources/{sourceId}/previews";
const source = (id: string, worksheet: string) =>
  ({ sourceId: id, sheet: worksheet, configRevision: 2, mappingRevision: 3 });

async function mockIdentity(page: Page, role: "pmo_admin" | "project_manager" = "pmo_admin", subject = () => "xlsx-actor") {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config")
      return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "xlsx-synthetic-browser-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: subject(), roles: [role] } });
    if (path === "/api/projects" || path === "/api/ingestion/sources") return route.fulfill({ json: [] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
}

async function enter(page: Page, role: "pmo_admin" | "project_manager" = "pmo_admin") {
  await page.getByRole("button", { name: role === "pmo_admin" ? "PMO administrator" : "Project manager" }).click();
  await page.getByRole("button", { name: "Data imports" }).click();
  if (role === "pmo_admin") await page.getByRole("button", { name: "Excel imports" }).click();
}

async function extractUpload(request: Request) {
  const body = request.postDataBuffer();
  expect(body).toBeTruthy();
  const multipart = await new globalThis.Request("http://localhost", {
    method: "POST",
    headers: { "content-type": request.headers()["content-type"] },
    body: body!,
  }).formData();
  const workbook = multipart.get("file");
  if (!(workbook instanceof File)) throw new Error("Missing workbook part");
  return {
    names: [...multipart.keys()].sort(),
    fields: [...multipart.entries()].filter(([name]) => name !== "file"),
    workbook: Buffer.from(await workbook.arrayBuffer()),
    name: workbook.name,
  };
}

test("Excel uploader retries exact bytes and selection, pages rows, and reopens linked receipts", async ({ page }) => {
  await mockIdentity(page);
  const responses: Array<Awaited<ReturnType<typeof extractUpload>>> = [];
  const saves: unknown[] = [];
  let stored = false;
  let denied = false;
  const bytes = await fixture();
  const contract = JSON.parse(await readFile("docs/03-architecture/OPENAPI_FOUNDATION.json", "utf8"));
  const requiredParts = contract.paths[uploadContractPath].post.requestBody.content["multipart/form-data"].schema.required;
  const bound = { sourceId, previewReceiptId: previewId, configRevision: 2, mappingRevision: 3 };
  await page.route("**/api/ingestion/xlsx/sources**", async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    expect(request.headers().authorization).toBe("Bearer xlsx-synthetic-browser-token");
    if (pathname === api) return route.fulfill({ json: { sources: [source(sourceId, sheet)], nextSourceId: null } });
    if (pathname.endsWith("/previews") && request.method() === "POST") {
      responses.push(await extractUpload(request));
      return responses.length === 1
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ status: 201, json: { receiptId: previewId, replayed: true, rowCount: 52 } });
    }
    if (pathname.endsWith("/reviewed-imports")) {
      saves.push(request.postDataJSON());
      if (saves.length === 1) return route.fulfill({ status: 503, json: {} });
      stored = true;
      return route.fulfill({ status: 201, json: { receiptId: reviewedId, parentPreviewReceiptId: previewId, replayed: true, rowCount: 2 } });
    }
    if (denied) return route.fulfill({ status: 404, json: {} });
    if (pathname.endsWith("/review-details")) return route.fulfill({ json: {
      ...bound, mapping: { sheet, identityColumn: "Issue", projectColumn: "Project",
        fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] },
      reviewedImport: stored ? { receiptId: reviewedId, createdAt, rowCount: 2 } : null,
    } });
    if (pathname.endsWith(previewId)) {
      const after = Number(searchParams.get("afterOrdinal"));
      const outcomes = Array.from({ length: Math.min(50, 52 - after) }, (_, index) => {
        const ordinal = after + index + 1;
        const available = ordinal !== 2 && !stored;
        return { ordinal, state: ordinal === 2 ? "INVALID" : "ACCEPTED",
          operation: ordinal === 2 ? "NONE" : "CREATE", projectId: ordinal === 2 ? null : projectId,
          errorCodes: ordinal === 2 ? ["INVALID_VALUE"] : [], contentAvailable: available, selectable: available,
          proposals: available ? [{ factType: "project.forecast", value: { type: "date", value: "2027-03-02" } }] : null };
      });
      return route.fulfill({ json: { ...bound, createdAt, rowCount: 52, previewContextSha256: digest,
        selectionState: stored ? "REVIEWED" : "OPEN", outcomes, nextOrdinal: after === 0 ? 50 : null } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/");
  await enter(page);
  await page.getByRole("combobox", { name: "Excel source" }).selectOption(sourceId);
  await page.getByLabel("Excel workbook", { exact: true }).setInputFiles({ name: "private-local-filename.xlsx", mimeType: workbookMime, buffer: bytes });
  await page.getByRole("button", { name: "Upload and preview workbook" }).click();
  await expect(page.getByRole("alert")).toContainText("Retry the same workbook");
  await expect(page.getByLabel("Excel workbook", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same workbook" }).click();
  await expect(page.getByText("Sealed column mapping")).toBeVisible();
  await expect(page.getByText("Forecast → project.forecast (date, required)")).toBeVisible();
  expect(responses).toHaveLength(2);
  expect(responses[0]?.names).toEqual([...requiredParts].sort());
  expect(responses[1]).toEqual(responses[0]);
  expect(responses[0]).toMatchObject({ name: "workbook.xlsx", workbook: bytes });
  expect(Object.fromEntries(responses[0]!.fields)).toEqual({
    commandKey: expect.stringMatching(/^[a-f0-9-]{36}$/), configRevision: "2", mappingRevision: "3",
    sheet: Buffer.from(sheet).toString("base64url"),
  });

  await expect(page.getByLabel("Select Excel row 2", { exact: true })).toBeDisabled();
  await expect(page.getByText("INVALID VALUE")).toBeVisible();
  await page.getByLabel("Select Excel row 1", { exact: true }).check();
  await page.getByRole("button", { name: "More Excel rows" }).click();
  await page.getByLabel("Select Excel row 51", { exact: true }).check();
  await page.getByRole("button", { name: "Save reviewed Excel proposals (2)" }).click();
  await page.getByRole("button", { name: "Retry original Excel selection" }).click();
  await expect(page.getByText("Reviewed Excel import saved · 2 selected rows")).toBeVisible();
  expect(saves).toHaveLength(2);
  expect(saves[1]).toEqual(saves[0]);
  expect(saves[0]).toMatchObject({
    commandKey: expect.stringMatching(/^[a-f0-9-]{36}$/), previewReceiptId: previewId,
    rowOrdinals: [1, 51], previewContextSha256: digest,
  });
  await expect(page.getByText(reviewedId, { exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]));
  expect(storage).not.toContain("private-local-filename");
  expect(storage).not.toContain(Object.fromEntries(responses[0]!.fields).commandKey as string);
  expect(storage).not.toContain(previewId);
  expect(page.url()).not.toContain(previewId);

  await page.reload();
  await enter(page);
  await page.getByRole("combobox", { name: "Excel source" }).selectOption(sourceId);
  await page.getByLabel("Excel preview receipt ID").fill(previewId);
  await page.getByRole("button", { name: "Open Excel preview" }).click();
  await expect(page.getByText(reviewedId, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Select Excel row 1", { exact: true })).toBeDisabled();
  denied = true;
  await page.getByRole("button", { name: "Open Excel preview" }).click();
  await expect(page.getByRole("alert")).toContainText("receipt is unavailable");
  await expect(page.getByText(reviewedId, { exact: true })).toHaveCount(0);
  expect(saves).toHaveLength(2);
});

for (const change of ["source", "session"] as const) test(`Excel ${change} switch discards an in-flight upload and its retry state`, async ({ page }) => {
  let subject = "xlsx-actor";
  await mockIdentity(page, "project_manager", () => subject);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let reads = 0;
  await page.route("**/api/ingestion/xlsx/sources**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === api) return route.fulfill({ json: {
      sources: [source(sourceId, sheet), source(otherSourceId, "Other sheet")], nextSourceId: null,
    } });
    if (pathname.endsWith("/previews") && route.request().method() === "POST") {
      started.resolve();
      await finish.promise;
      try {
        await route.fulfill({ status: 201, json: { receiptId: previewId, replayed: false, rowCount: 2 } });
      } catch {
        // The browser may close the intercepted request on scope change.
      } finally { finished.resolve(); }
      return;
    }
    reads++;
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/");
  await enter(page, "project_manager");
  await expect(page.getByRole("button", { name: "CSV imports" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Excel source" }).selectOption(sourceId);
  await page.getByLabel("Excel workbook", { exact: true }).setInputFiles({ name: "fixture.xlsx", mimeType: workbookMime, buffer: await fixture() });
  await page.getByRole("button", { name: "Upload and preview workbook" }).click();
  await started.promise;
  if (change === "source") {
    await page.getByRole("combobox", { name: "Excel source" }).selectOption(otherSourceId);
    await expect(page.getByText("Other sheet", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Excel workbook", { exact: true })).toHaveValue("");
  } else {
    await page.getByRole("button", { name: "Sign out" }).click();
    subject = "replacement-actor";
    await enter(page, "project_manager");
  }
  finish.resolve();
  await finished.promise;
  await page.getByRole("combobox", { name: "Excel source" }).selectOption(sourceId);
  await expect(page.getByLabel("Excel workbook", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Excel preview receipt ID")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Retry same workbook" })).toHaveCount(0);
  expect(reads).toBe(0);
});

test("switching spreadsheet formats invalidates a CSV upload that is still preparing", async ({ page }) => {
  await mockIdentity(page);
  let uploads = 0;
  const csvSource = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid",
    configRevision: 1, mappingRevision: 1, healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" },
      projects: [{ projectId, readers: ["xlsx-actor"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID",
        fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } },
  };
  await page.route("**/api/ingestion/sources", (route) => route.fulfill({ json: [csvSource] }));
  await page.route("**/api/ingestion/xlsx/sources", (route) =>
    route.fulfill({ json: { sources: [], nextSourceId: null } }));
  await page.route("**/csv-previews", (route) => {
    uploads++;
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page.getByRole("button", { name: "Data imports" }).click();
  const file = { name: "fixture.csv", mimeType: "text/csv",
    buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2027-03-02\n`) };
  await page.getByLabel("CSV file").setInputFiles(file);

  const gate = await page.evaluateHandle(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    crypto.subtle.digest = async (algorithm, data) => {
      started.resolve();
      await released.promise;
      try { return await digest(algorithm, data); }
      finally { completed.resolve(); }
    };
    return {
      started: started.promise,
      completed: completed.promise,
      release() { crypto.subtle.digest = digest; released.resolve(); },
    };
  });
  await page.getByRole("button", { name: "Upload and preview", exact: true }).click();
  await gate.evaluate((value) => value.started);
  await page.getByRole("button", { name: "Excel imports" }).click();
  await expect(page.getByText("No authorized Excel sources on this page.")).toBeVisible();
  await page.getByRole("button", { name: "CSV imports" }).click();
  await expect(page.getByLabel("CSV file")).toHaveValue("");
  await gate.evaluate((value) => value.release());
  await gate.evaluate((value) => value.completed);
  await gate.dispose();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(uploads).toBe(0);
  await page.getByLabel("CSV file").setInputFiles(file);
  await page.getByRole("button", { name: "Upload and preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same preview" })).toBeEnabled();
  expect(uploads).toBe(1);
});
