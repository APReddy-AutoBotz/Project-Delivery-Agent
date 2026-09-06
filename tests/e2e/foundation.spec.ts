import { test, expect } from "@playwright/test";
test.beforeAll(async ({ request }) => {
  expect(
    (await request.get("/api/health/ready")).status(),
    "Synthetic API/database must be ready before browser workflows",
  ).toBe(200);
});
test("Revoked project access removes cached project names and details", async ({
  page,
  request,
}) => {
  const login = await request.post("/api/auth/development", {
    data: { persona: "operator" },
  });
  const { token } = await login.json();
  const headers = { Authorization: "Bearer " + token };
  const grant = {
    subject: "pm-atlas",
    scopeType: "project",
    scopeId: "30000000-0000-4000-8000-000000000001",
  };
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Project manager" }).click();
  await page.getByRole("button", { name: /Atlas · Customer platform/ }).click();
  await expect(page.getByText("Unknown — no source connected")).toBeVisible();
  try {
    expect(
      (
        await request.delete("/api/access-grants", { headers, data: grant })
      ).status(),
    ).toBe(204);
    await page.clock.fastForward(16000);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(page.getByRole("alert")).toContainText(
      "unavailable for your account",
    );
    await expect(
      page.getByText("Atlas · Customer platform", { exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "All projects" }).click();
    await expect(
      page.getByText("No projects are shared with this account"),
    ).toBeVisible();
  } finally {
    expect(
      (
        await request.post("/api/access-grants", {
          headers,
          data: { ...grant, role: "project_manager" },
        })
      ).status(),
    ).toBe(204);
  }
});
test("Expired identity clears cached protected data and returns to sign-in", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "Project manager" }).click();
  await expect(
    page.getByRole("button", { name: /Atlas · Customer platform/ }),
  ).toBeVisible();
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"message":"Session expired"}',
    }),
  );
  await page.clock.fastForward(16000);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Your session has ended");
  await expect(
    page.getByRole("button", { name: /Atlas · Customer platform/ }),
  ).toHaveCount(0);
});
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
  await page.screenshot({
    path: "artifacts/projects-desktop.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: /Platform & access/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Atlas · Customer platform/ }).click();
  await expect(page.getByText("Unknown — no source connected")).toBeVisible();
  await page.screenshot({
    path: "artifacts/project-detail.png",
    fullPage: true,
  });
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
  await page.screenshot({
    path: "artifacts/platform-desktop.png",
    fullPage: true,
  });
  await page.getByLabel("Account subject").fill("synthetic-browser-user");
  await page
    .getByLabel("Scope identifier")
    .fill("30000000-0000-4000-8000-000000000001");
  const grant = page.getByRole("button", { name: "Grant access" });
  await page.getByLabel("Scope identifier", { exact: true }).press("Tab");
  await expect(grant).toBeFocused();
  await expect(grant).toHaveCSS("outline-style", "solid");
  await expect(grant).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Access granted.");
  await expect(grant).toBeEnabled();
  await grant.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Revoke access" }),
  ).toBeFocused();
  await page.keyboard.press("Space");
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
    page.getByRole("button", { name: /Atlas · Customer platform/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your projects" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/projects-mobile.png",
    fullPage: true,
  });
});

test("Synthetic OIDC workspace uses organization sign-in without a local-only claim", async ({
  page,
}) => {
  await page.route("**/api/auth/config", (route) =>
    route.fulfill({
      json: {
        mode: "oidc",
        dataMode: "synthetic",
        issuer: "https://identity.example.test",
        clientId: "synthetic-ui-fixture",
        scope: "openid profile",
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Synthetic workspace", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with your organization" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Project manager" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/limited to this local development environment/),
  ).toHaveCount(0);
});

test("Mobile operator controls fit the viewport and retain accessible labels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Platform operator" }).press("Enter");
  await page.getByRole("button", { name: /Platform & access/ }).press("Enter");
  for (const control of [
    page.getByLabel("Account subject", { exact: true }),
    page.getByRole("combobox", { name: "Scope", exact: true }),
    page.getByRole("combobox", { name: "Role", exact: true }),
    page.getByLabel("Scope identifier", { exact: true }),
    page.getByRole("button", { name: "Grant access" }),
    page.getByRole("button", { name: "Revoke access" }),
  ]) {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
});
