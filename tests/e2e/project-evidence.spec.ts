import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

const portfolioId = "20000000-0000-4000-8000-000000000001";
test.setTimeout(90000); // Multi-actor review/retry journeys, including independent saved-link login.

test("FR-EVD-007/012: scalar requests retain original PM proof, deduplicate and recheck source access", async ({
  page,
  request,
  browser,
}) => {
  const f = await fixture(request, true);
  const first = await f.append(
    "pmo-portfolio",
    0,
    "Scalar disputed forecast A",
  );
  const second = await f.append("pm-atlas", 1, "Scalar disputed forecast B");
  await f.share(first.entry.sourceId);
  await f.share(second.entry.sourceId);
  expect(
    (
      await f.api(
        "pmo-portfolio",
        f.prefix + "/authority-policies",
        "POST",
        f.policy(0),
      )
    ).status(),
  ).toBe(201);
  await open(page, f.payload.name);
  await openFact(page);
  const check = page.getByRole("region", {
    name: "Scalar reconciliation check",
    exact: true,
  });
  const response = page.waitForResponse(
    (value) =>
      value.url().endsWith("/scalar-reconciliation-checks") &&
      value.request().method() === "POST",
  );
  await check
    .getByRole("button", {
      name: "Check and request reconciliation",
      exact: true,
    })
    .click();
  const createdResponse = await response;
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  expect(created.outcome).toBe("CREATED");
  await expect(check).toContainText("Assigned to pm-atlas");
  const secondResponse = page.waitForResponse(
    (value) =>
      value.url().endsWith("/scalar-reconciliation-checks") &&
      value.request().method() === "POST",
  );
  await check
    .getByRole("button", {
      name: "Check and request reconciliation",
      exact: true,
    })
    .click();
  const reused = await (await secondResponse).json();
  expect(reused.outcome).toBe("REUSED");
  expect(reused.request.id).toBe(created.request.id);
  expect(reused.assessment.assessmentId).not.toBe(
    created.assessment.assessmentId,
  );
  await page
    .getByLabel("Scalar request queue", { exact: true })
    .selectOption("manage");
  await expect(
    page.getByRole("region", {
      name: "Scalar reconciliation queue",
      exact: true,
    }),
  ).toContainText(f.factType);
  const pmContext = await browser.newContext(),
    pm = await pmContext.newPage();
  try {
    await pm.goto(
      `/?project=${f.projectId}&scalarReconciliation=${created.request.id}`,
    );
    await pm.getByRole("button", { name: /^Project manager / }).click();
    const proof = pm.getByRole("region", {
      name: "PM scalar reconciliation request",
      exact: true,
    });
    await expect(proof).toContainText("Scalar disputed forecast A");
    await expect(proof).toContainText("Scalar disputed forecast B");
    await expect(
      proof.getByRole("link", {
        name: "Open saved assessment link",
        exact: true,
      }),
    ).toHaveAttribute("href", new RegExp(created.assessment.assessmentId));
    await f.share(first.entry.sourceId, ["pmo-portfolio", "leader-atlas"]);
    await proof
      .getByRole("button", {
        name: "Refresh scalar request access",
        exact: true,
      })
      .click();
    await expect(proof).toContainText("Saved result withheld");
    await expect(proof).not.toContainText("Scalar disputed forecast A");
    await expect(proof).not.toContainText("Scalar disputed forecast B");
  } finally {
    await pmContext.close();
  }
});
const epoch = () => new Date(Date.now() - 3600000).toISOString();
test("FR-EVD-009: a controlled second-page queue retains the exact assignment retry", async ({
  page,
  request,
}) => {
  const f = await fixture(request, true);
  const first = await f.append("pmo-portfolio", 0, "Scalar retry forecast A");
  const second = await f.append("pm-atlas", 1, "Scalar retry forecast B");
  await f.share(first.entry.sourceId);
  await f.share(second.entry.sourceId);
  expect(
    (
      await f.api(
        "pmo-portfolio",
        f.prefix + "/authority-policies",
        "POST",
        f.policy(0),
      )
    ).status(),
  ).toBe(201);
  const createdResponse = await f.api(
    "pmo-portfolio",
    f.prefix + "/scalar-reconciliation-checks",
    "POST",
    {
      factId: first.factId,
      idempotencyKey: randomUUID(),
    },
  );
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  // Controlled pagination isolates the retry UI: commands still reach the real
  // API, and the second page contains the real request. This is not DB-page proof.
  await page.route(
    "**/managed-scalar-reconciliation-requests*",
    async (route) => {
      const secondPage = new URL(route.request().url()).searchParams.has(
        "afterId",
      );
      await route.fulfill({
        json: {
          requests: [
            secondPage
              ? created.request
              : {
                  ...created.request,
                  id: "00000000-0000-4000-8000-000000000001",
                },
          ],
          next: secondPage
            ? null
            : {
                createdAt: created.request.createdAt,
                id: "00000000-0000-4000-8000-000000000001",
              },
        },
      });
    },
  );
  const commands: unknown[] = [];
  await page.route(
    `**/scalar-reconciliation-requests/${created.request.id}/assignment`,
    async (route) => {
      commands.push(route.request().postDataJSON());
      if (commands.length === 1) await route.abort("failed");
      else await route.continue();
    },
  );
  await open(page, f.payload.name);
  const queue = page.getByRole("region", {
    name: "Scalar reconciliation queue",
    exact: true,
  });
  await queue
    .getByLabel("Scalar request queue", { exact: true })
    .selectOption("manage");
  await queue
    .getByRole("button", { name: "Next scalar request page", exact: true })
    .click();
  await queue
    .getByRole("button", {
      name: "Refresh configured scalar PM assignment",
      exact: true,
    })
    .click();
  const retry = queue.getByRole("button", {
    name: "Retry same scalar assignment refresh",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await expect(
    queue.getByRole("button", { name: "Refresh scalar queue", exact: true }),
  ).toBeDisabled();
  await expect(
    queue.getByRole("button", {
      name: "First scalar request page",
      exact: true,
    }),
  ).toBeDisabled();
  const refreshed = page.waitForResponse(
    (value) =>
      value.url().endsWith(`/${created.request.id}/assignment`) &&
      value.request().method() === "POST",
  );
  await retry.click();
  expect((await refreshed).status()).toBe(201);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(
    queue.getByRole("button", { name: "Refresh scalar queue", exact: true }),
  ).toBeEnabled();
});
async function fixture(request: APIRequestContext, scalarPm = false) {
  const tokens: Record<string, string> = {};
  for (const persona of [
    "pmo-portfolio",
    "pm-atlas",
    "leader-atlas",
    "operator",
  ]) {
    const response = await request.post("/api/auth/development", {
      data: { persona },
    });
    expect(response.status()).toBe(200);
    tokens[persona] = (await response.json()).token;
  }
  async function api(
    persona: string,
    path: string,
    method = "GET",
    data?: unknown,
  ) {
    return request.fetch("/api" + path, {
      method,
      headers: { Authorization: "Bearer " + tokens[persona] },
      ...(data === undefined ? {} : { data }),
    });
  }
  expect(
    (
      await api("operator", "/access-grants", "POST", {
        subject: "pmo-portfolio",
        role: "pmo_admin",
        scopeType: "portfolio",
        scopeId: portfolioId,
      })
    ).status(),
  ).toBe(204);
  const payload = {
    ...canonicalFixture(portfolioId),
    code: "EVD-" + randomUUID().slice(0, 12),
    name: "Synthetic evidence " + randomUUID().slice(0, 8),
  };
  if (scalarPm)
    payload.responsibilities = [
      {
        role: "PROJECT_MANAGER",
        subject: "pm-atlas",
        displayName: "Configured scalar PM",
      },
    ];
  const created = await api("pmo-portfolio", "/projects", "POST", payload);
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id,
    prefix = `/projects/${projectId}`,
    factType = "project.forecast",
    effectiveAt = epoch();
  for (const [subject, role] of [
    ["pm-atlas", "project_manager"],
    ["leader-atlas", "leadership"],
  ])
    expect(
      (
        await api("operator", "/access-grants", "POST", {
          subject,
          role,
          scopeType: "project",
          scopeId: projectId,
        })
      ).status(),
    ).toBe(204);
  const statement = (
    expectedRevision: number,
    value = "First synthetic forecast",
    key = factType,
  ) => ({
    projectId,
    factType: key,
    expectedRevision,
    idempotencyKey: randomUUID(),
    value: { type: "text", value },
    originalStatement: value,
    effectiveAt,
    validUntil: null,
  });
  const policy = (expectedRevision: number, durationMs = 7200000) => ({
    projectId,
    factType,
    expectedRevision,
    idempotencyKey: randomUUID(),
    effectiveAt,
    definition: {
      tiers: [
        {
          selectors: [
            {
              sourceType: "human_statement",
              instanceId: null,
              requiredApproval: "NOT_REQUIRED",
              validity: { basis: "effectiveAt", durationMs },
            },
          ],
        },
      ],
      conflictBehavior: "REQUEST_RECONCILIATION",
    },
  });
  async function append(
    persona: string,
    revision: number,
    value?: string,
    key?: string,
  ) {
    const response = await api(
      persona,
      prefix + "/fact-statements",
      "POST",
      statement(revision, value, key),
    );
    expect(response.status()).toBe(201);
    return response.json();
  }
  async function share(
    sourceId: string,
    readers = ["pmo-portfolio", "pm-atlas", "leader-atlas"],
    state = "AVAILABLE",
  ) {
    const path = `${prefix}/fact-sources/${sourceId}/access`,
      read = await api("pmo-portfolio", path);
    expect(read.status()).toBe(200);
    const response = await api("pmo-portfolio", path, "POST", {
      projectId,
      sourceId,
      expectedRevision: (await read.json()).revision,
      state,
      readers,
    });
    expect(response.status()).toBe(200);
  }
  async function capture(persona = "pmo-portfolio") {
    const response = await api(persona, prefix + "/assessments", "POST", {
      projectId,
      factType,
      idempotencyKey: randomUUID(),
    });
    expect(response.status()).toBe(201);
    return response.json();
  }
  return {
    api,
    payload,
    projectId,
    prefix,
    factType,
    effectiveAt,
    statement,
    policy,
    append,
    share,
    capture,
  };
}
async function open(page: Page, name: string, persona = "PMO administrator") {
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(`^${persona} `) }).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(
    page.getByRole("heading", { name: "Project evidence", exact: true }),
  ).toBeVisible();
}
async function openFact(page: Page, factType = "project.forecast") {
  await page.getByLabel("Fact type key", { exact: true }).fill(factType);
  await page
    .getByRole("button", { name: "Open fact history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Statement history", exact: true }),
  ).toBeVisible();
}
async function enterStatement(page: Page, value: string, effectiveAt: string) {
  await page.getByLabel("Statement value", { exact: true }).fill(value);
  await page.getByLabel("Original statement", { exact: true }).fill(value);
  await page
    .getByLabel("Effective at (UTC)", { exact: true })
    .fill(effectiveAt);
  await page
    .getByRole("button", { name: "Review statement", exact: true })
    .click();
}
async function publishRule(page: Page, effectiveAt: string, seconds: string) {
  const form = page.locator("details").filter({
    has: page.getByText("Configure authority (PMO)", { exact: true }),
  });
  if ((await form.getAttribute("open")) === null)
    await page.getByText("Configure authority (PMO)", { exact: true }).click();
  await page
    .getByLabel("Required approval", { exact: true })
    .selectOption("NOT_REQUIRED");
  await page
    .getByLabel("Validity duration (seconds, optional)", { exact: true })
    .fill(seconds);
  await page
    .getByLabel("Conflict behavior", { exact: true })
    .selectOption("REQUEST_RECONCILIATION");
  await page
    .getByLabel("Rule effective at (UTC)", { exact: true })
    .fill(effectiveAt);
  await page
    .getByRole("button", { name: "Review authority rule", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Review authority replacement",
      exact: true,
    }),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/authority-policies") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Publish authority rule", exact: true })
    .click();
  expect((await saved).status()).toBe(201);
  await expect(
    page.getByRole("heading", { name: "Authority rule", exact: true }),
  ).toBeVisible();
}
async function captureUI(page: Page) {
  const captured = page.waitForResponse(
    (response) =>
      response.url().endsWith("/assessments") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Capture new assessment", exact: true })
    .click();
  const response = await captured;
  expect(response.status()).toBe(201);
  const body = await response.json();
  await expect(
    page.getByRole("region", { name: "Saved assessment", exact: true }),
  ).toBeVisible();
  return body;
}

test("INT-EVD-001: a lost statement response retains the same reviewed request through paging, a benign sharing change and transient project failure", async ({
  page,
  request,
}) => {
  const f = await fixture(request),
    first = await f.append("pmo-portfolio", 0);
  await f.append("pmo-portfolio", 1, "Second synthetic forecast");
  await f.append("pmo-portfolio", 0, "Other fact", "project.zeta");
  // Exercise the API's supported short pages without fabricating returned data.
  await page.route(`**/api${f.prefix}/facts**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/facts") || url.pathname.endsWith("/history"))
      url.searchParams.set("limit", "1");
    await route.continue({ url: url.toString() });
  });
  await page.clock.install();
  await open(page, f.payload.name);
  await openFact(page);
  const bodies: unknown[] = [],
    savedIds: string[] = [];
  await page.route(`**/api${f.prefix}/fact-statements`, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      savedIds.push((await response.json()).entry.id);
      await route.abort("failed");
    } else await route.continue();
  });
  await enterStatement(page, "Uncertain synthetic confirmation", f.effectiveAt);
  await page
    .getByRole("button", { name: "Confirm and save statement", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Retry same reviewed request",
      exact: true,
    }),
  ).toBeVisible();
  await f.share(first.entry.sourceId);
  await page
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Next history page", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Retry same reviewed request",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Next fact types", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Retry same reviewed request",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Manage source readers", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Close source readers", exact: true })
    .click();
  let transient = true;
  await page.route(`**/api${f.prefix}`, async (route) =>
    transient
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            statusCode: 503,
            message: "Service unavailable",
          }),
        })
      : route.continue(),
  );
  await page.clock.fastForward(16000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("button", {
      name: "Retry same reviewed request",
      exact: true,
    }),
  ).toBeHidden();
  transient = false;
  await page.clock.fastForward(16000);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByRole("button", {
      name: "Retry same reviewed request",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry same reviewed request", exact: true })
    .click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual(bodies[0]);
  const history = await (
    await f.api("pmo-portfolio", f.prefix + `/facts/${f.factType}/history`)
  ).json();
  expect(history.throughRevision).toBe(3);
  expect(history.entries[2].id).toBe(savedIds[0]);
});

test("GOLDEN-013 / E2E-EVD-003: authority changes show human, stale and conflicting dimensions while the old saved link stays frozen", async ({
  page,
  request,
  browser,
}) => {
  const f = await fixture(request);
  await open(page, f.payload.name);
  await openFact(page);
  await enterStatement(page, "Forecast A", f.effectiveAt);
  await page
    .getByRole("button", { name: "Confirm and save statement", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "History revision 1", exact: true }),
  ).toContainText("Forecast A");
  await publishRule(page, f.effectiveAt, "7200");
  const old = await captureUI(page);
  const saved = page.getByRole("region", {
    name: "Saved assessment",
    exact: true,
  });
  await expect(saved).toContainText("Freshness: CURRENT");
  await expect(saved).toContainText("Conflict: NONE");
  const oldLink = await page
    .getByRole("link", { name: "Open saved assessment link", exact: true })
    .getAttribute("href");
  const second = await f.append("pm-atlas", 1, "Forecast B");
  await page
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  const secondEntry = page.getByRole("article", {
    name: "History revision 2",
    exact: true,
  });
  await expect(secondEntry).toContainText("Source restricted");
  await expect(secondEntry).not.toContainText("Forecast B");
  await secondEntry
    .getByRole("button", { name: "Manage source readers", exact: true })
    .click();
  await page
    .getByLabel("Reader account subjects", { exact: true })
    .fill("pm-atlas\npmo-portfolio\nleader-atlas");
  await page
    .getByRole("button", { name: "Review source access", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save source access", exact: true })
    .click();
  await expect(secondEntry).toContainText("Forecast B");
  expect(second.entry.sourceId).toBeTruthy();
  const conflicting = await captureUI(page);
  expect(conflicting.result.status).toBe("CONFLICTING");
  await publishRule(page, f.effectiveAt, "1");
  const stale = await captureUI(page);
  expect(
    stale.result.versions.every(
      (version: { assessment: { freshness: string } }) =>
        version.assessment.freshness === "STALE",
    ),
  ).toBe(true);
  await expect(
    saved.getByText("Provenance: HUMAN_CONFIRMED", { exact: true }),
  ).toHaveCount(2);
  await expect(
    saved.getByText("Freshness: STALE", { exact: true }),
  ).toHaveCount(2);
  await expect(
    saved.getByText("Conflict: CONFLICTING", { exact: true }),
  ).toHaveCount(2);
  await expect(saved).toContainText("Expired at capture");
  await expect(saved).toContainText(
    "This assessment flag alone is not a durable reconciliation request",
  );
  await page.screenshot({
    path: "artifacts/evidence-workflow-stale-conflict.png",
    fullPage: true,
  });
  const context = await browser.newContext(),
    historical = await context.newPage();
  try {
    await historical.goto(new URL(oldLink!, page.url()).toString());
    await historical
      .getByRole("button", { name: /^PMO administrator / })
      .click();
    const snapshot = historical.getByRole("region", {
      name: "Saved assessment",
      exact: true,
    });
    await expect(snapshot).toContainText(old.asOf);
    await expect(snapshot).toContainText("Freshness: CURRENT");
    await expect(snapshot).toContainText("Fact: project.forecast");
    await openFact(historical, "project.another");
    await expect(snapshot).toContainText("Fact: project.forecast");
    await historical.clock.install();
    await historical.clock.fastForward(7200001);
    await expect(snapshot).toContainText(
      "Validity has elapsed since this capture",
    );
    await expect(snapshot).toContainText("Freshness: CURRENT");
    const read = await (
      await f.api(
        "pmo-portfolio",
        `${f.prefix}/assessments/${old.assessmentId}`,
      )
    ).json();
    expect(read.result).toEqual(old.result);
    expect(read.asOf).toBe(old.asOf);
  } finally {
    await context.close();
  }
});

test("FR-EVD-009: current source revalidation withholds copied content and a real API identity denial clears browser drafts", async ({
  page,
  request,
}) => {
  const f = await fixture(request),
    secret = "SYNTHETIC-EVIDENCE-" + randomUUID(),
    first = await f.append("pmo-portfolio", 0, secret);
  await f.share(first.entry.sourceId);
  expect(
    (
      await f.api(
        "pmo-portfolio",
        f.prefix + "/authority-policies",
        "POST",
        f.policy(0),
      )
    ).status(),
  ).toBe(201);
  await open(page, f.payload.name, "Project manager");
  await openFact(page);
  await captureUI(page);
  await expect(
    page.getByRole("region", { name: "Saved assessment", exact: true }),
  ).toContainText(secret);
  await page
    .getByLabel("Original statement", { exact: true })
    .fill("Private pending draft");
  await f.share(first.entry.sourceId, ["pmo-portfolio"], "REVOKED");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api${f.prefix}/facts/${f.factType}/history**`,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "History revision 1", exact: true }),
  ).toBeHidden();
  release();
  await expect(
    page.getByRole("article", { name: "History revision 1", exact: true }),
  ).toContainText("Source restricted");
  await page
    .getByRole("button", {
      name: "Recheck saved assessment access",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Saved assessment", exact: true }),
  ).toContainText("Saved result withheld");
  await expect(page.locator("body")).not.toContainText(secret);
  await expect(
    page.getByLabel("Original statement", { exact: true }),
  ).toHaveValue("");
  await page
    .getByLabel("Original statement", { exact: true })
    .fill("Another private draft");
  await page.unroute(`**/api${f.prefix}/facts/${f.factType}/history**`);
  await page.route(`**/api${f.prefix}/facts/${f.factType}/history**`, (route) =>
    route.continue({
      headers: {
        ...route.request().headers(),
        authorization: "Bearer invalid-session-fixture",
      },
    }),
  );
  await page
    .getByRole("button", { name: "Refresh history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Welcome to your workspace",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secret);
  await expect(
    page.getByLabel("Original statement", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
});

test("FR-EVD-009: uncertain source-access replacement requires reload and comparison, never an automatic second write", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  await f.append("pmo-portfolio", 0);
  await page.clock.install();
  await open(page, f.payload.name);
  await openFact(page);
  await page
    .getByRole("button", { name: "Manage source readers", exact: true })
    .click();
  await page
    .getByLabel("Reader account subjects", { exact: true })
    .fill("pmo-portfolio\nleader-atlas");
  await page
    .getByRole("button", { name: "Review source access", exact: true })
    .click();
  let writes = 0;
  await page.route(`**/api${f.prefix}/fact-sources/*/access`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "Save source access", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save source access", exact: true }),
  ).toBeDisabled();
  await page.clock.fastForward(16000);
  await expect(
    page.getByRole("button", { name: "Save source access", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "Source reader management", exact: true }),
  ).toContainText("Saved access has changed");
  expect(writes).toBe(1);
  await page
    .getByRole("button", { name: "Close and reload saved access", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Manage source readers", exact: true })
    .click();
  await expect(
    page.getByLabel("Reader account subjects", { exact: true }),
  ).toHaveValue("leader-atlas\npmo-portfolio");
  await page.screenshot({
    path: "artifacts/evidence-workflow-source-readers.png",
    fullPage: true,
  });
});
