import { test, expect } from "@playwright/test";

test("confirmed mapping remains confirmed when its source refresh fails", async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const source = (revision: number, sheet: string) => ({ sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: revision, mappingRevision: revision,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" },
      projects: [{ projectId, readers: ["actor-a"] }], mapping: { kind: "CSV", sheet, identityColumn: "Issue ID", projectColumn: "Project ID",
        fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } });
  let reads = 0, writes = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-recovery-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") { reads++; return reads === 1 ? route.fulfill({ json: [source(1, "Projects")] }) : reads === 2 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: [source(2, "Edited sheet")] }); }
    if (path === "/api/ingestion/sources/configuration") { writes++; return route.fulfill({ status: 201, json: { sourceId, configRevision: 2, mappingRevision: 2 } }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click();
  await page.getByRole("button", { name: /Data imports/ }).click();
  await expect(page.getByRole("button", { name: "Save mapping" })).toBeEnabled();
  await page.getByLabel("Sheet label").fill("Edited sheet");
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText("Source list is unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Mapping saved." })).toBeVisible();
  expect(writes).toBe(1); expect(reads).toBe(2);
  await page.getByRole("button", { name: "Retry sources" }).click();
  await expect(page.getByLabel("Sheet label")).toHaveValue("Edited sheet");
  await expect(page.getByRole("button", { name: "Save mapping" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reload mapping" })).toHaveCount(0);
  expect(writes).toBe(1); expect(reads).toBe(3);
});
