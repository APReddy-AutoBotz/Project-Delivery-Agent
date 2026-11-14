import { test, expect, type Page } from "@playwright/test";

const customerId = "10000000-0000-4000-8000-000000000001", firstPortfolio = "20000000-0000-4000-8000-000000000001", secondPortfolio = "20000000-0000-4000-8000-000000000002";
async function setup(page: Page) {
  const writes: Array<{ path: string; payload: Record<string, unknown> }> = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "creation-stale-token" } });
    if (path === "/api/me") return route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [
      { id: firstPortfolio, name: "First portfolio", programmes: [], programmesTruncated: false },
      { id: secondPortfolio, name: "Second portfolio", programmes: [], programmesTruncated: false }] } });
    if ((path === "/api/projects" || path.endsWith("/programmes")) && req.method() === "POST") {
      writes.push({ path, payload: JSON.parse(req.postData() ?? "{}") as Record<string, unknown> });
      return route.fulfill({ status: 503, json: { message: "Synthetic unavailable" } });
    }
    if (path === "/api/projects") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).first().click();
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  return writes;
}
async function capture(page: Page, selector: "programme" | "project") {
  const button = selector === "programme" ? page.getByRole("button", { name: "Create programme" }) : page.getByRole("button", { name: "Create project", exact: true });
  await expect(button).toBeEnabled();
  await button.evaluate((element, which) => {
    const key = Object.keys(element).find((name) => name.startsWith("__reactProps$")); if (!key) throw new Error("Handler unavailable");
    const state = window as unknown as { oldCreation?: Record<string, () => void> }; (state.oldCreation ??= {})[which] = (element as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
  }, selector);
}
async function callOld(page: Page, which: string) {
  await page.evaluate((name) => (window as unknown as { oldCreation: Record<string, () => void> }).oldCreation[name]!(), which);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("a stale programme callback cannot create old details or use an old portfolio", async ({ page }) => {
  const writes = await setup(page); await page.getByText("Create a programme in this portfolio").click();
  await page.getByLabel("Programme code").fill("OLD"); await page.getByLabel("Programme name").fill("Earlier programme"); await capture(page, "programme");
  await page.getByLabel("Programme name").fill("Current programme"); await page.getByLabel("Portfolio", { exact: true }).selectOption(secondPortfolio);
  await callOld(page, "programme"); expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Create programme" }).click(); await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.path).toBe(`/api/portfolios/${secondPortfolio}/programmes`); expect(writes[0]?.payload.name).toBe("Current programme");
});

test("a stale project create callback cannot send an earlier reviewed draft", async ({ page }) => {
  const writes = await setup(page); await page.getByLabel("Project code", { exact: true }).fill("SYN"); await page.getByLabel("Project name", { exact: true }).fill("Earlier project");
  await page.getByRole("button", { name: "Review project" }).click(); await capture(page, "project");
  await page.getByRole("button", { name: "Edit details" }).click(); await page.getByLabel("Project name", { exact: true }).fill("Current project");
  await page.getByRole("button", { name: "Review project" }).click(); await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
  await callOld(page, "project"); expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Create project", exact: true }).click(); await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.payload.name).toBe("Current project");
});
