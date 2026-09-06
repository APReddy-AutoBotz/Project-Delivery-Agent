import { test, expect } from "@playwright/test";
test("Project manager can inspect scoped synthetic evidence and sign out", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Project manager" }).click();
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Atlas · Customer platform/ }),
  ).toBeVisible();
  await expect(page.getByText(/Draco/)).toHaveCount(0);
  await page.screenshot({path:'artifacts/projects-desktop.png',fullPage:true});
  await expect(
    page.getByRole("button", { name: /Platform & access/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Atlas · Customer platform/ }).click();
  await expect(page.getByText("Unknown — no source connected")).toBeVisible();
  await page.screenshot({path:'artifacts/project-detail.png',fullPage:true});
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
});
test("Operator has no implicit project access and can grant and revoke access with audit", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Platform operator" }).click();
  await expect(
    page.getByText("No projects are shared with this account"),
  ).toBeVisible();
  await page.getByRole("button", { name: /Platform & access/ }).click();
  await expect(page.getByText("Shadow mode", { exact: true })).toBeVisible();
  await page.screenshot({path:'artifacts/platform-desktop.png',fullPage:true});
  await page.getByLabel("Account subject").fill("synthetic-browser-user");
  await page
    .getByLabel("Scope identifier")
    .fill("30000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByRole("status")).toContainText("Access granted.");
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByRole("status")).toContainText("Access revoked.");
  await expect(
    page.getByText("Access revoked", { exact: true }).first(),
  ).toBeVisible();
});
test("Small screens retain sign-in and project navigation without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Project manager" }).click();
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({path:'artifacts/projects-mobile.png',fullPage:true});
});
