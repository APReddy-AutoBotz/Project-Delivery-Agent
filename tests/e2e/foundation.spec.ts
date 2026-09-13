import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  createDisclosureCheck,
  observeBrowserDisclosure,
} from "../../scripts/acceptance/disclosure.mjs";
test.beforeAll(async ({ request }) => {
  expect(
    (await request.get("/api/health/ready")).status(),
    "Synthetic API/database must be ready before browser workflows",
  ).toBe(200);
});
test("FR-EVD-009 / SEC-SECRET-001: expected queue denials finish their original bodies on load and revalidation", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Synthetic browser origin is required");
  const origin = new URL(baseURL).origin;
  const queuePath =
    "/api/projects/30000000-0000-4000-8000-000000000001/reconciliation-requests";
  const check = createDisclosureCheck([randomBytes(32).toString("base64url")]);
  const context = await browser.newContext();
  const capture = await observeBrowserDisclosure(context, origin, check);
  try {
    const page = await capture.newPage();
    let finished = 0;
    let pageErrors = 0;
    page.on("pageerror", () => pageErrors++);
    const statuses: number[] = [];
    page.on("response", (response) => {
      if (response.url() === origin + queuePath)
        statuses.push(response.status());
    });
    page.on("requestfinished", (request) => {
      if (request.url() === origin + queuePath) finished++;
    });
    await page.clock.install();
    await page.goto(origin);
    await page.getByRole("button", { name: "Project manager" }).click();
    await page
      .getByRole("button", { name: /Atlas · Customer platform/ })
      .click();
    await expect(page.getByText("Unknown — no source connected")).toBeVisible();
    await expect.poll(() => statuses).toEqual([404]);
    await expect.poll(() => finished).toBe(1);
    // No response routing/replacement: the recorder reads and continues the
    // server's original 404. settle also requires zero failed/unresolved captures.
    // Development sign-in has no OIDC token response; full expiry/disclosure is
    // separately required by the unchanged real-OIDC acceptance workflow.
    await capture.settle(page);
    await page.clock.fastForward(15001);
    await expect.poll(() => statuses).toEqual([404, 404]);
    await expect.poll(() => finished).toBe(2);
    await capture.settle(page);
    const reconciliation = page.getByRole("region", {
      name: "Milestone reconciliation",
      exact: true,
    });
    await expect(
      reconciliation.getByText(
        "This evidence or action is unavailable for your account. Refresh to check current access.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      reconciliation.getByText("Not Found", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Delivery structure", exact: true }),
    ).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(pageErrors).toBe(0);
    await page.screenshot({
      path: test.info().outputPath("queue-revalidation.png"),
      fullPage: true,
    });
    await capture.close();
    const channels = check.verify([
      "browser-response-headers",
      "browser-response-bodies",
    ]);
    expect(channels["browser-response-bodies"].captures).toBeGreaterThan(2);
  } catch (error) {
    const page = context.pages()[0];
    if (page)
      await page.screenshot({
        path: test.info().outputPath("queue-failure.png"),
        fullPage: true,
      });
    throw error;
  } finally {
    await context.close();
  }
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
      page.getByRole("heading", { name: "Your projects", exact: true }),
    ).toBeVisible();
    // Other independently granted synthetic projects may remain accessible.
    await expect(
      page.getByRole("button", { name: /Atlas · Customer platform/ }),
    ).toHaveCount(0);
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
  let publicConfigurationRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/config")
      publicConfigurationRequests++;
  });
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
  await expect(page.getByText(/Atlas · Customer platform/)).toHaveCount(0);
  await page.getByRole("button", { name: "Platform operator" }).click();
  await expect(
    page.getByText("No projects are shared with this account"),
  ).toBeVisible();
  await expect(page.getByText(/Atlas · Customer platform/)).toHaveCount(0);
  expect(publicConfigurationRequests).toBe(1);
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
