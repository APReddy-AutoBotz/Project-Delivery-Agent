import { test, expect } from "@playwright/test";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

test.beforeAll(async ({ request }) => {
  expect((await request.get("/api/health/ready")).status()).toBe(200);
});

test("INT-MOD-001: PMO creates a programme and project, then inspects the saved delivery structure", async ({
  page,
}) => {
  const code = "WEB-" + Date.now();
  await page.goto("/");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByText("Create a programme in this portfolio", { exact: true })
    .click();
  await page.getByLabel("Programme code", { exact: true }).fill("P-" + code);
  await page
    .getByLabel("Programme name", { exact: true })
    .fill("Synthetic browser programme");
  await page
    .getByRole("button", { name: "Create programme", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Programme", exact: true }),
  ).toHaveValue(/^[a-f0-9-]{36}$/);
  await page.getByLabel("Project code", { exact: true }).fill(code);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Synthetic browser delivery project");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Synthetic creation workflow, unverified input");
  await page
    .getByRole("combobox", { name: "Reported status", exact: true })
    .selectOption("GREEN");
  await page
    .getByLabel("Baseline start", { exact: true })
    .first()
    .fill("2026-01-01");
  await page
    .getByLabel("Baseline end", { exact: true })
    .first()
    .fill("2026-06-30");
  await page
    .getByLabel("Planned end", { exact: true })
    .first()
    .fill("2026-07-01");
  await page
    .getByLabel("Forecast end", { exact: true })
    .first()
    .fill("2026-07-15");
  await page
    .getByLabel("Actual start", { exact: true })
    .first()
    .fill("2026-01-07");
  await page
    .getByRole("button", { name: "Add responsibility", exact: true })
    .click();
  const responsibility = page.getByRole("group", {
    name: "Responsibility 1",
    exact: true,
  });
  await responsibility
    .getByRole("combobox", { name: "Responsibility", exact: true })
    .selectOption("PROJECT_MANAGER");
  await responsibility
    .getByLabel("Account subject", { exact: true })
    .fill("synthetic-browser-owner");
  await responsibility
    .getByLabel("Display name", { exact: true })
    .fill("Synthetic project manager");
  await page.getByRole("button", { name: "Add sprint", exact: true }).click();
  const sprint = page.getByRole("group", { name: "Sprint 1", exact: true });
  await sprint.getByLabel("Reference", { exact: true }).fill("SPR-1");
  await sprint
    .getByLabel("Sprint name", { exact: true })
    .fill("Delivery sprint");
  await page
    .getByRole("button", { name: "Add milestone", exact: true })
    .click();
  const milestone = page.getByRole("group", {
    name: "Milestone 1",
    exact: true,
  });
  await milestone.getByLabel("Reference", { exact: true }).fill("MS-1");
  await milestone
    .getByLabel("Milestone name", { exact: true })
    .fill("Launch milestone");
  await page
    .getByRole("button", { name: "Add work item", exact: true })
    .click();
  const work = page.getByRole("group", { name: "Work item 1", exact: true });
  await work.getByLabel("Reference", { exact: true }).fill("WI-1");
  await work
    .getByLabel("Work item title", { exact: true })
    .fill("Delivery work item");
  await work
    .getByRole("combobox", { name: "Sprint reference", exact: true })
    .selectOption("SPR-1");
  await page
    .getByRole("button", { name: "Add required work link", exact: true })
    .click();
  const link = page.getByRole("group", {
    name: "Required work link 1",
    exact: true,
  });
  await link
    .getByRole("combobox", { name: "Milestone reference", exact: true })
    .selectOption("MS-1");
  await link
    .getByRole("combobox", { name: "Work item reference", exact: true })
    .selectOption("WI-1");
  await page
    .getByRole("button", { name: "Add risk or action record", exact: true })
    .click();
  const raid = page.getByRole("group", {
    name: "Risk or action record 1",
    exact: true,
  });
  await raid.getByLabel("Reference", { exact: true }).fill("RISK-1");
  await raid
    .getByLabel("Record title", { exact: true })
    .fill("Synthetic supplier risk");
  await page
    .getByRole("button", { name: "Add source reference", exact: true })
    .click();
  const source = page.getByRole("group", {
    name: "Source reference 1",
    exact: true,
  });
  for (const [label, value] of [
    ["Source system", "Synthetic tracker"],
    ["Source instance reference", code],
    ["Source record type", "issue"],
    ["Source record identifier", "EXT-1"],
    ["Source URL", "https://tracker.example.test/" + code],
  ])
    await source.getByLabel(label, { exact: true }).fill(value);
  await source
    .getByRole("combobox", { name: "Target record type", exact: true })
    .selectOption("WORK_ITEM");
  await source
    .getByRole("combobox", { name: "Target reference", exact: true })
    .selectOption("WI-1");
  await page
    .getByRole("button", { name: "Review project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review project", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Reported status: GREEN · Unassessed", { exact: true }),
  ).toBeVisible();
  let firstCreatedId: string | undefined;
  const requestKeys: string[] = [];
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requestKeys.push(route.request().postDataJSON().idempotencyKey);
    if (requestKeys.length > 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    firstCreatedId = (await response.json()).id;
    await route.abort("failed"); // The server committed, but the browser lost the response.
  });
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  await page
    .getByRole("button", { name: "Review project", exact: true })
    .click();
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  expect((await created).status()).toBe(201);
  expect((await (await created).json()).id).toBe(firstCreatedId);
  expect(requestKeys).toHaveLength(2);
  expect(requestKeys[0]).toBe(requestKeys[1]);
  await expect(
    page.getByRole("heading", { name: "Delivery structure", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic supplier risk", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open source reference", exact: true }),
  ).toHaveAttribute("href", "https://tracker.example.test/" + code);
  await expect(
    page.getByText("2026-01-01 → 2026-06-30", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "artifacts/canonical-project-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page.getByRole("button", { name: new RegExp(code) }).click();
  await expect(
    page.getByText("Synthetic supplier risk", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "artifacts/canonical-project-mobile.png",
    fullPage: true,
  });
  await page.screenshot({
    path: "artifacts/canonical-project-mobile-viewport.png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Creation rejects reversed dates and session loss removes the sensitive draft", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByLabel("Project code", { exact: true })
    .fill("DRAFT-" + Date.now());
  await page
    .getByLabel("Project name", { exact: true })
    .fill("PRIVATE-DRAFT-ONLY");
  await page.getByLabel("Baseline start", { exact: true }).fill("2026-08-01");
  await page.getByLabel("Baseline end", { exact: true }).fill("2026-07-01");
  await page
    .getByRole("button", { name: "Review project", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Each end date");
  await page.route("**/api/project-setup", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"statusCode":401,"message":"Sign-in required"}',
    }),
  );
  await page.clock.fastForward(16000);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("heading", { name: "Welcome to your workspace" }),
  ).toBeVisible();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("PRIVATE-DRAFT-ONLY");
  await page.unroute("**/api/project-setup");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "",
  );
});

test("Project-only manager sees no creation controls and legacy structure stays unknown", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Project manager" }).click();
  await expect(
    page.getByRole("button", { name: "Create project", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Atlas · Customer platform/ }).click();
  await expect(
    page.getByText(
      "No delivery structure has been configured for this project.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open source reference" }),
  ).toHaveCount(0);
});

test("Current project grant reveals delivery details, withholds source mappings and removes cached content after revocation", async ({
  page,
  request,
}) => {
  const pmoLogin = await request.post("/api/auth/development", {
    data: { persona: "pmo-portfolio" },
  });
  expect(pmoLogin.status()).toBe(200);
  const pmoHeaders = {
    Authorization: "Bearer " + (await pmoLogin.json()).token,
  };
  const setup = await (
    await request.get("/api/project-setup", { headers: pmoHeaders })
  ).json();
  const input = canonicalFixture(setup.portfolios[0].id);
  const created = await request.post("/api/projects", {
    headers: pmoHeaders,
    data: input,
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const operator = await request.post("/api/auth/development", {
    data: { persona: "operator" },
  });
  const headers = { Authorization: "Bearer " + (await operator.json()).token };
  const grant = { subject: "pm-atlas", scopeType: "project", scopeId: id };
  expect(
    (
      await request.post("/api/access-grants", {
        headers,
        data: { ...grant, role: "project_manager" },
      })
    ).status(),
  ).toBe(204);
  try {
    await page.clock.install();
    await page.goto("/");
    await page.getByRole("button", { name: "Project manager" }).click();
    const detailResponse = page.waitForResponse((response) =>
      response.url().endsWith("/projects/" + id + "/canonical"),
    );
    await page.getByRole("button", { name: new RegExp(input.code) }).click();
    const detail = await (await detailResponse).json();
    expect(detail.sourceMappingsWithheld).toBe(true);
    expect(detail.sourceMappings).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain("tracker.example.test");
    await expect(
      page.getByRole("heading", { name: "Delivery structure", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open source reference" }),
    ).toHaveCount(0);
    expect(
      (
        await request.delete("/api/access-grants", { headers, data: grant })
      ).status(),
    ).toBe(204);
    await page.clock.fastForward(16000);
    await page.evaluate(() =>
      window.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(
      page.getByRole("heading", { name: "Delivery structure", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(input.name, { exact: true })).toHaveCount(0);
  } finally {
    expect(
      (
        await request.delete("/api/access-grants", { headers, data: grant })
      ).status(),
    ).toBe(204);
  }
});

test("A programme retry retains its request and selection when the setup list omits the new record", async ({
  page,
}) => {
  const code = "LIMIT-" + Date.now();
  const keys: string[] = [];
  let programmeId: string | undefined;
  // Simulate a capped setup response; programme/project creation still uses the real API.
  await page.route("**/api/project-setup", async (route) => {
    const response = await route.fetch();
    const setup = await response.json();
    for (const portfolio of setup.portfolios) {
      portfolio.programmes = [];
      portfolio.programmesTruncated = true;
    }
    await route.fulfill({ response, json: setup });
  });
  await page.route("**/api/portfolios/*/programmes", async (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (keys.length > 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    programmeId = (await response.json()).id;
    await route.abort("failed");
  });
  await page.goto("/");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByText("Create a programme in this portfolio", { exact: true })
    .click();
  await page.getByLabel("Programme code", { exact: true }).fill(code);
  await page
    .getByLabel("Programme name", { exact: true })
    .fill("Retained programme");
  await page
    .getByRole("button", { name: "Create programme", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByLabel("Programme name", { exact: true })
    .fill("Temporary edit");
  await page
    .getByLabel("Programme name", { exact: true })
    .fill("Retained programme");
  await page
    .getByRole("button", { name: "Create programme", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Programme", exact: true }),
  ).toHaveValue(programmeId!);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(
    page.getByRole("option", {
      name: "Retained programme (" + code + ")",
      exact: true,
    }),
  ).toHaveCount(1);
  await page.getByLabel("Project code", { exact: true }).fill(code);
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Programme selection fixture");
  await page
    .getByRole("button", { name: "Review project", exact: true })
    .click();
  await expect(
    page.getByText(/Digital delivery \/ Retained programme/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Delivery structure", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Digital delivery \/ Retained programme/),
  ).toBeVisible();
});

test("Changed child references remain visible and must be corrected before review", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page
    .getByLabel("Project code", { exact: true })
    .fill("REF-" + Date.now());
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Reference correction fixture");
  await page.getByRole("button", { name: "Add sprint", exact: true }).click();
  const sprint = page.getByRole("group", { name: "Sprint 1", exact: true });
  await sprint.getByLabel("Reference", { exact: true }).fill("SPR-1");
  await sprint.getByLabel("Sprint name", { exact: true }).fill("A sprint");
  await page
    .getByRole("button", { name: "Add work item", exact: true })
    .click();
  const work = page.getByRole("group", { name: "Work item 1", exact: true });
  await work.getByLabel("Reference", { exact: true }).fill("WI-1");
  await work.getByLabel("Work item title", { exact: true }).fill("A work item");
  const reference = work.getByRole("combobox", {
    name: "Sprint reference",
    exact: true,
  });
  await reference.selectOption("SPR-1");
  await sprint.getByLabel("Reference", { exact: true }).fill("SPR-2");
  await expect(reference).toHaveValue("SPR-1");
  await expect(reference.locator("option:checked")).toHaveText(
    "Unavailable reference: SPR-1",
  );
  await page
    .getByRole("button", { name: "Review project", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Work item 1: choose an available sprint reference",
  );
  await reference.selectOption("SPR-2");
  await page
    .getByRole("button", { name: "Remove sprint 1", exact: true })
    .click();
  await expect(reference.locator("option:checked")).toHaveText(
    "Unavailable reference: SPR-2",
  );
  await reference.selectOption("");
  await page
    .getByRole("button", { name: "Add source reference", exact: true })
    .click();
  const source = page.getByRole("group", {
    name: "Source reference 1",
    exact: true,
  });
  for (const [name, value] of [
    ["Source system", "Synthetic"],
    ["Source instance reference", "INSTANCE"],
    ["Source record type", "work"],
    ["Source record identifier", "EXTERNAL"],
  ])
    await source.getByLabel(name, { exact: true }).fill(value);
  await source
    .getByRole("combobox", { name: "Target record type", exact: true })
    .selectOption("WORK_ITEM");
  const target = source.getByRole("combobox", {
    name: "Target reference",
    exact: true,
  });
  expect(
    await target.evaluate(
      (element: HTMLSelectElement) => element.validity.valueMissing,
    ),
  ).toBe(true);
  await target.selectOption("WI-1");
  await page
    .getByRole("button", { name: "Review project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review project", exact: true }),
  ).toBeVisible();
});
