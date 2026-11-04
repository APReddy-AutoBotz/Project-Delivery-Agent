import { test, expect } from "@playwright/test";

test("unrelated import completion reports a preparation restart", async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001";
  const first = "40000000-0000-4000-8000-000000000001", second = "40000000-0000-4000-8000-000000000002";
  const source = (sourceId: string) => ({ sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } });
  let firstPosts = 0, secondPosts = 0, releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args: Parameters<SubtleCrypto["digest"]>) => {
      const state = window as unknown as { armed?: boolean; digestStarted?: boolean; releaseDigest?: () => void };
      if (state.armed) { state.armed = false; state.digestStarted = true; await new Promise<void>((resolve) => { state.releaseDigest = resolve; }); }
      return digest(...args);
    };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await fetchOriginal(input, init);
      if (response.headers.get("x-first-import") === "held" && response.body) {
        const state = window as unknown as { firstEof?: boolean; firstReleased?: boolean }, stream = response.body, getReader = stream.getReader.bind(stream);
        stream.getReader = (() => { const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
          reader.read = async () => { const value = await read(); if (value.done) state.firstEof = true; return value; };
          reader.releaseLock = () => { release(); state.firstReleased = true; }; return reader; }) as typeof stream.getReader;
      }
      return response;
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-concurrent-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") return route.fulfill({ json: [source(first), source(second)] });
    if (path === `/api/ingestion/sources/${first}/csv-previews`) { firstPosts++; await firstGate; return route.fulfill({ status: 503, headers: { "x-first-import": "held" }, json: {} }); }
    if (path === `/api/ingestion/sources/${second}/csv-previews`) { secondPosts++; return route.fulfill({ status: 503, json: {} }); }
    return route.fulfill({ status: 404, json: {} });
  });
  const file = { name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) };
  try {
    await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await page.getByLabel("CSV file").setInputFiles(file); await page.getByRole("button", { name: "Upload and preview" }).click(); await expect.poll(() => firstPosts).toBe(1);
    await page.getByRole("button", { name: "Projects", exact: true }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await page.getByLabel("Configured source").selectOption(second); await page.getByLabel("CSV file").setInputFiles(file);
    await page.evaluate(() => { (window as unknown as { armed: boolean }).armed = true; });
    await page.getByRole("button", { name: "Upload and preview" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { digestStarted?: boolean }).digestStarted === true)).toBe(true);
    releaseFirst(); await expect.poll(() => page.evaluate(() => { const state = window as unknown as { firstEof?: boolean; firstReleased?: boolean }; return Boolean(state.firstEof && state.firstReleased); })).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.evaluate(() => (window as unknown as { releaseDigest?: () => void }).releaseDigest?.());
    await expect(page.getByText("Import activity changed. Review the source and try again.")).toBeVisible(); expect(secondPosts).toBe(0);
    await page.getByRole("button", { name: "Upload and preview" }).click(); await expect.poll(() => secondPosts).toBe(1);
  } finally { releaseFirst(); }
});
