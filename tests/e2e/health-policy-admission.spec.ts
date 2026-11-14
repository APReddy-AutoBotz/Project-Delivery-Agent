import { expect, test } from "@playwright/test";

for (const kind of ["threshold", "schedule"] as const) {
  test(`the provider rejects a same-task stale ${kind} revision`, async ({ page }) => {
    await page.goto("/test-fixtures/policy-admission.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    await expect(page.getByRole("button", { name: "Save customer threshold" })).toBeEnabled();
    await page.getByRole("button", { name: `Stale ${kind}`, exact: true }).click();
    await expect(page.locator("#result")).toHaveText('{"lease":false,"posts":0,"uncertain":false}');
  });
  test(`the provider admits one current ${kind} revision`, async ({ page }) => {
    await page.goto("/test-fixtures/policy-admission.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    await expect(page.getByRole("button", { name: "Save customer threshold" })).toBeEnabled();
    await page.getByRole("button", { name: `Current ${kind}` }).click();
    await expect(page.locator("#result")).toHaveText('{"lease":true,"posts":1,"uncertain":false}');
  });
  test(`the provider admits initial ${kind} revision zero`, async ({ page }) => {
    await page.goto("/test-fixtures/policy-admission.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    await expect(page.getByRole("button", { name: "Save customer threshold" })).toBeEnabled();
    await page.getByRole("button", { name: `Initial ${kind}` }).click();
    await expect(page.locator("#result")).toHaveText('{"lease":true,"posts":1,"uncertain":false}');
  });
  test(`the actual ${kind} form rejects a stale same-task revision and preserves its draft`, async ({ page }) => {
    await page.goto("/test-fixtures/policy-admission.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    const panel = page.getByRole("region", { name: kind === "threshold" ? "Customer-wide blocker-age threshold" : "Project schedule overdue policy" });
    const field = panel.getByLabel(kind === "threshold" ? "Minimum blocker age (UTC calendar days)" : "Schedule health time zone (IANA)");
    const value = kind === "threshold" ? "7" : "America/New_York";
    await field.fill(value);
    const save = panel.getByRole("button", { name: kind === "threshold" ? "Save customer threshold" : "Save project schedule policy" });
    await expect(save).toBeEnabled();
    await page.getByRole("button", { name: `Stale ${kind} form` }).click();
    await expect(page.locator("#result")).toHaveText('{"lease":false,"posts":0,"uncertain":false,"submissions":1,"admissions":1,"granted":false}');
    await expect(field).toHaveValue(value);
    await expect(panel.getByText("This draft was based on revision 1.", { exact: false })).toBeVisible();
    await expect(panel.getByText("The save outcome could not be confirmed.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("A previous health write may still have an unknown outcome.", { exact: false })).toHaveCount(0);
    await expect(save).toBeDisabled();
    await panel.getByRole("button", { name: "Use current revision for this draft" }).click();
    await save.click(); await expect(page.locator("#posts")).toHaveText("1");
    const sent = JSON.parse((await page.locator("#last-post").textContent()) ?? "null");
    expect(sent.path).toBe(kind === "threshold" ? "/admin/blocker-age-threshold-policy" : "/projects/30000000-0000-4000-8000-000000000001/schedule-health-policy");
    expect(sent.body).toEqual(kind === "threshold" ? { expectedRevision: 2, minimumBlockerAgeDays: 7, auditRetentionHours: 24 }
      : { expectedRevision: 2, timeZone: "America/New_York", defaultMinimumOverdueDays: 1, targetOverrides: [] });
  });
}
