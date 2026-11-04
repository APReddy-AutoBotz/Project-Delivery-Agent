import { test, expect } from "@playwright/test";

for (const transition of ["view", "actor", "failed-preparation"] as const) test(`held CSV digest cannot dispatch after ${transition} changes`, async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a", "actor-b"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  let actor = "actor-a", posts = 0;
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
      const state = window as unknown as { armDigest?: boolean; digestStarted?: boolean; failDigest?: boolean; releaseDigest?: () => void };
      if (state.armDigest) { state.armDigest = false; state.digestStarted = true; await new Promise<void>((resolve) => { state.releaseDigest = resolve; });
        if (state.failDigest) { state.failDigest = false; throw new Error("Synthetic digest failure"); } }
      return digest(...args);
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-digest-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: actor, roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source] });
    if (path.endsWith("/csv-previews")) { posts++; return route.fulfill({ status: 503, json: {} }); }
    return route.fulfill({ status: 404, json: {} });
  });
  const file = { name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) };
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByLabel("CSV file").setInputFiles(file);
  if (transition === "failed-preparation") await page.getByRole("button", { name: "Upload and preview" }).evaluate((button) => {
    const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Enabled preview handler unavailable");
    (window as unknown as { oldEnabledPreview: () => void }).oldEnabledPreview = (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
  });
  await page.evaluate((failure) => { const state = window as unknown as { armDigest: boolean; failDigest: boolean }; state.armDigest = true; state.failDigest = failure; }, transition === "failed-preparation");
  await page.getByRole("button", { name: "Upload and preview" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { digestStarted?: boolean }).digestStarted === true)).toBe(true);
  if (transition === "view") await page.getByRole("button", { name: "Projects", exact: true }).click();
  else if (transition === "actor") { actor = "actor-b"; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(page.getByText("actor-b", { exact: true })).toBeVisible(); }
  else {
    const busy = page.getByRole("button", { name: "Working…" }); await expect(busy).toBeDisabled();
    await busy.evaluate((button) => { const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Busy preview handler unavailable");
      (window as unknown as { busyPreview: () => void }).busyPreview = (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick; });
  }
  await page.evaluate(() => { (window as unknown as { releaseDigest?: () => void }).releaseDigest?.(); });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(posts).toBe(0);
  if (transition === "failed-preparation") {
    await expect(page.getByText("The preview could not be prepared.", { exact: false })).toBeVisible();
    await page.evaluate(() => (window as unknown as { busyPreview: () => void }).busyPreview());
    await page.evaluate(() => (window as unknown as { oldEnabledPreview: () => void }).oldEnabledPreview());
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(posts).toBe(0);
  }
  if (transition === "view") await page.getByRole("button", { name: /Data imports/ }).click();
  await page.getByLabel("CSV file").setInputFiles(file); await page.getByRole("button", { name: "Upload and preview" }).click();
  await expect.poll(() => posts).toBe(1);
});
