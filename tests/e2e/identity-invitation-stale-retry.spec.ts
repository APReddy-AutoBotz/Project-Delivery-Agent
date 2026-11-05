import { test, expect } from "@playwright/test";

test("an old invitation access retry cannot reopen a later denial or a successful read", async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", locator = "20000000-0000-4000-8000-000000000001";
  const requestId = "30000000-0000-4000-8000-000000000001";
  const requests: string[] = []; let allow = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "invitation-retry-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["project_manager"] } });
    if (path === "/api/projects") return route.fulfill({ json: [] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === `/api/project-update-invitations/${locator}`) {
      requests.push(route.request().method());
      if (!allow) return route.fulfill({ status: 403, json: { message: "Unavailable" } });
      return route.fulfill({ json: { requestId, project: { id: locator, code: "S", name: "Synthetic project" }, stageKind: "REQUEST",
        dueAt: "2026-01-01T00:00:00.000Z", capturedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
        body: "Current invitation", requiredFacts: [{ factType: "project.forecast", label: "Forecast" }],
        rawResponseReaders: ["actor-a"], responses: [], escalationContext: null } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`/update-requests/${locator}`); await page.getByRole("button", { name: /^Project manager / }).first().click();
  const retry = page.getByRole("button", { name: "Check request access" }); await expect(retry).toBeVisible();
  await retry.evaluate((button) => {
    const key = Object.keys(button).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Retry handler unavailable");
    (window as unknown as { oldInvitationRetry: () => void }).oldInvitationRetry = (button as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
  });
  const first = requests.length; await retry.click(); await expect.poll(() => requests.length).toBe(first + 1); await expect(retry).toBeVisible();
  await page.evaluate(() => (window as unknown as { oldInvitationRetry: () => void }).oldInvitationRetry());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(requests).toHaveLength(first + 1); await expect(retry).toBeVisible();
  allow = true; await retry.click(); await expect(page.getByText("Current invitation")).toBeVisible(); expect(requests).toHaveLength(first + 2);
  await page.evaluate(() => (window as unknown as { oldInvitationRetry: () => void }).oldInvitationRetry());
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(requests).toHaveLength(first + 2); await expect(page.getByText("Current invitation")).toBeVisible();
  expect(requests.every((method) => method === "GET")).toBe(true);
});

test("an older invitation submit cannot send a changed draft", async ({ page }) => {
  const customerId = "10000000-0000-4000-8000-000000000001", locator = "20000000-0000-4000-8000-000000000001";
  const requestId = "30000000-0000-4000-8000-000000000001", responseId = "40000000-0000-4000-8000-000000000001";
  const posts: Array<{ text: string }> = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "invitation-draft-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["project_manager"] } });
    if (path === "/api/projects") return route.fulfill({ json: [] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === `/api/project-update-invitations/${locator}/responses`) {
      posts.push(JSON.parse(route.request().postData() ?? "{}") as { text: string });
      return route.fulfill({ status: 201, json: { responseId, requestId, receivedAt: "2026-01-01T00:00:00.000Z", state: "UNCONFIRMED", message: "Response recorded; required facts remain unconfirmed." } });
    }
    if (path === `/api/project-update-invitations/${locator}`) return route.fulfill({ json: { requestId, project: { id: locator, code: "S", name: "Synthetic project" }, stageKind: "REQUEST",
      dueAt: "2026-01-01T00:00:00.000Z", capturedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      body: "Current invitation", requiredFacts: [{ factType: "project.forecast", label: "Forecast" }], rawResponseReaders: ["actor-a"], responses: [], escalationContext: null } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`/update-requests/${locator}`); await page.getByRole("button", { name: /^Project manager / }).first().click();
  const input = page.getByRole("textbox", { name: "Your update (unconfirmed)" }); await input.fill("Earlier draft");
  await input.evaluate((element) => {
    const form = element.closest("form"); if (!form) throw new Error("Response form unavailable");
    const key = Object.keys(form).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Response handler unavailable");
    (window as unknown as { oldInvitationSubmit: (event: { preventDefault: () => void }) => void }).oldInvitationSubmit = (form as unknown as Record<string, { onSubmit: (event: { preventDefault: () => void }) => void }>)[key]!.onSubmit;
  });
  await input.fill("Current draft");
  await page.evaluate(() => (window as unknown as { oldInvitationSubmit: (event: { preventDefault: () => void }) => void }).oldInvitationSubmit({ preventDefault() {} }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); expect(posts).toHaveLength(0);
  await page.getByRole("button", { name: "Record response" }).click(); await expect.poll(() => posts.length).toBe(1); expect(posts[0]?.text).toBe("Current draft");
});
