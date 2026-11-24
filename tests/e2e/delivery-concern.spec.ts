import { expect, test } from "@playwright/test";
import { exerciseDeliveryConcernWorkflow } from "../../scripts/acceptance/delivery-concern-workflow.mjs";

const portfolioId = "20000000-0000-4000-8000-000000000001";

test("GOLDEN-002: reported Green, critical overdue milestone, open critical blockers and stale trusted update", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90000);
  const tokens = new Map<string, string>();
  for (const persona of ["operator", "pmo-portfolio"]) {
    const response = await request.post("/api/auth/development", { data: { persona } });
    expect(response.status()).toBe(200);
    tokens.set(persona, (await response.json()).token);
  }
  const api = (path: string, method = "GET", data?: unknown, persona = "pmo-portfolio") =>
    request.fetch("/api" + path, {
      method,
      headers: { Authorization: "Bearer " + tokens.get(persona) },
      ...(data === undefined ? {} : { data }),
    });
  expect((await api("/access-grants", "POST", {
    subject: "pmo-portfolio", role: "pmo_admin", scopeType: "portfolio", scopeId: portfolioId,
  }, "operator")).status()).toBe(204);

  await exerciseDeliveryConcernWorkflow({
    api,
    portfolioId,
    screenshot: testInfo.outputPath("golden-002-delivery-concern.png"),
    async openProject(name: string) {
      await page.goto("/");
      await page.getByRole("button", { name: /^PMO administrator / }).click();
      await page.getByRole("button", { name: new RegExp(name) }).click();
      return page;
    },
  });
});
