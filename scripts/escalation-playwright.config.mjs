import assert from "node:assert/strict";
import { defineConfig } from "@playwright/test";
const origin = new URL(process.env.PDAA_ESCALATION_BROWSER_ORIGIN ?? "");
assert.equal(origin.origin, "http://localhost:5174");
export default defineConfig({
  testDir: "../tests/escalation-browser", fullyParallel: false, workers: 1, reporter: "list",
  use: { baseURL: origin.origin, headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
