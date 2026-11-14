import { expect, test } from "@playwright/test";

for (const existing of [false, true]) test(`the reporting form waits for its ${existing ? "existing" : "empty"} initial policy before accepting edits`, async ({ page }) => {
  const projectId = "30000000-0000-4000-8000-000000000001";
  const customerId = "10000000-0000-4000-8000-000000000001";
  let entered!: () => void, release!: () => void, policyReads = 0;
  const arrived = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.addInitScript(() => {
    const state = window as Window & { firstPolicyReady?: { disabled: boolean; value: string } };
    new MutationObserver(() => {
      if (state.firstPolicyReady) return;
      const section = document.querySelector('section[aria-label="Project update freshness and completeness"]');
      const fieldset = section?.querySelector("form fieldset") as HTMLFieldSetElement | null;
      const input = fieldset?.querySelector('input[type="number"]') as HTMLInputElement | null;
      if (fieldset && input && !fieldset.closest("[hidden]")) state.firstPolicyReady = { disabled: fieldset.disabled, value: input.value };
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "disabled"] });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-policy-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "synthetic-pmo", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "P", name: "Policy fixture", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === `/projects/${projectId}`) return route.fulfill({ json: { id: projectId, code: "P", name: "Policy fixture", description: "Fixture", reportedStatus: "UNKNOWN" } });
    if (path === `/projects/${projectId}/project-update-policy`) {
      policyReads++; entered(); await held;
      return route.fulfill({ json: existing ? { projectId, key: "reporting", revision: 1, freshnessWindowSeconds: 3600, timeZone: "UTC",
        requiredFacts: [{ factType: "project.status", label: "Status" }], responsibleSubject: "synthetic-owner", scheduledScanEnabled: false,
        reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0, escalationRecipientSubject: null,
        quietHoursStartLocal: null, quietHoursEndLocal: null, changedBy: "synthetic-pmo", changedAt: "2026-10-20T00:00:00.000Z" } : null });
    }
    if (path === `/projects/${projectId}/project-update-assessments/latest`) return route.fulfill({ json: null });
    if (path === `/projects/${projectId}/facts`) return route.fulfill({ json: { canAppend: true, canConfigure: true, facts: [], next: null } });
    if (path === `/projects/${projectId}/ingestion-reassessments`) return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: {} });
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: /^PMO administrator / }).click();
    await page.getByRole("button", { name: /Policy fixture/ }).click();
    await arrived;
    await expect(page.getByRole("heading", { name: "Project update", exact: true })).toBeHidden();
    expect(policyReads).toBe(1);
    release();
    await expect.poll(() => page.evaluate(() => (window as Window & { firstPolicyReady?: { disabled: boolean; value: string } }).firstPolicyReady))
      .toEqual({ disabled: true, value: "" });
    await page.getByText("Reporting policy · PMO administration", { exact: true }).click();
    const freshness = page.getByLabel("Freshness window (seconds)", { exact: true });
    await expect(freshness).toBeEnabled();
    await expect(freshness).toHaveValue(existing ? "3600" : "");
    await expect(page.getByLabel("Project time zone (IANA)", { exact: true })).toHaveValue(existing ? "UTC" : "");
    await freshness.fill("7200");
    await expect(freshness).toHaveValue("7200");
  } finally { release(); }
});
