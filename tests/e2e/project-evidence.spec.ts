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

async function prepareScalar(request: APIRequestContext, legacy = false) {
  const f = await fixture(request, !legacy, legacy);
  const first = await f.append("pmo-portfolio", 0, "Original scalar value A");
  const second = await f.append("pm-atlas", 1, "Original scalar value B");
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
  return { ...f, first, second };
}
async function scalarCheckUI(page: Page) {
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith("/scalar-reconciliation-checks") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", {
      name: "Check and request reconciliation",
      exact: true,
    })
    .click();
  const response = await pending;
  expect(response.status()).toBe(201);
  return {
    input: response.request().postDataJSON(),
    result: await response.json(),
  };
}

test("FR-EVD-009/012: a real legacy scalar request remains explicitly unassigned through UI and HTTP", async ({
  page,
  request,
}) => {
  const f = await prepareScalar(request, true);
  const canonical = await f.api("pmo-portfolio", f.prefix + "/canonical");
  expect(canonical.status()).toBe(200);
  expect((await canonical.json()).configured).toBe(false);
  await open(page, f.payload.name);
  await openFact(page, f.factType);
  const { result } = await scalarCheckUI(page);
  expect(result.outcome).toBe("CREATED");
  expect(result.request.state).toBe("OPEN");
  expect(result.request.assignment.reason).toBe("NO_CONFIGURED_PM");
  expect(result.request.assignment.recipientSubject).toBeNull();
  await expect(
    page.getByRole("region", {
      name: "Scalar reconciliation check",
      exact: true,
    }),
  ).toContainText("Durable unassigned routing");
  await page
    .getByLabel("Scalar request queue", { exact: true })
    .selectOption("manage");
  const queue = page.getByRole("region", {
    name: "Scalar reconciliation queue",
    exact: true,
  });
  await expect(queue).toContainText(f.factType);
  await expect(queue).toContainText("Durable unassigned routing");
  const managed = await (
    await f.api(
      "pmo-portfolio",
      f.prefix + "/managed-scalar-reconciliation-requests",
    )
  ).json();
  expect(
    managed.requests.some(
      (row: { id: string }) => row.id === result.request.id,
    ),
  ).toBe(true);
  const denied = await f.api(
    "pm-atlas",
    f.prefix + "/scalar-reconciliation-requests/" + result.request.id,
  );
  expect(denied.status()).toBe(404);
  expect(await denied.json()).toEqual({
    statusCode: 404,
    message: "Resource unavailable",
  });
  await page.screenshot({
    path: "artifacts/evidence-workflow-scalar-unassigned.png",
    fullPage: true,
  });
});

test("NFR-SEC-001 / FR-EVD-009: leadership captures real evidence but cannot request scalar reconciliation", async ({
  page,
  request,
}) => {
  const f = await prepareScalar(request);
  const managed = () =>
    f
      .api(
        "pmo-portfolio",
        f.prefix + "/managed-scalar-reconciliation-requests",
      )
      .then((r) => r.json());
  const before = await managed();
  expect(before.requests).toEqual([]);
  await open(page, f.payload.name, "Leadership");
  await openFact(page);
  await expect(
    page.getByRole("button", {
      name: "Check and request reconciliation",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Refresh configured scalar PM assignment",
      exact: true,
    }),
  ).toHaveCount(0);
  const captured = await captureUI(page);
  expect(captured.result.status).toBe("CONFLICTING");
  expect(captured.result.resolvedValue).toBeNull();
  await expect(
    page.getByRole("region", { name: "Saved assessment", exact: true }),
  ).toContainText("Original scalar value A");
  const denied = await f.api(
    "leader-atlas",
    f.prefix + "/scalar-reconciliation-checks",
    "POST",
    { factId: f.first.factId, idempotencyKey: randomUUID() },
  );
  expect(denied.status()).toBe(404);
  expect(await denied.json()).toEqual({
    statusCode: 404,
    message: "Resource unavailable",
  });
  expect(await managed()).toEqual(before);
  await page.screenshot({
    path: "artifacts/evidence-workflow-scalar-leadership.png",
    fullPage: true,
  });
});

test("FR-EVD-004/007/012: a changed contributor creates a distinct UI request without replacing original proof or retry", async ({
  page,
  request,
  browser,
}) => {
  const f = await prepareScalar(request);
  await open(page, f.payload.name);
  await openFact(page);
  const first = await scalarCheckUI(page);
  expect(first.result.outcome).toBe("CREATED");
  const detailPath =
    f.prefix + "/scalar-reconciliation-requests/" + first.result.request.id;
  const originalResponse = await f.api("pm-atlas", detailPath);
  expect(originalResponse.status()).toBe(200);
  const originalBytes = await originalResponse.body();
  const original = JSON.parse(originalBytes.toString());
  const pmContext = await browser.newContext();
  try {
    const pm = await pmContext.newPage();
    await pm.goto(
      `/?project=${f.projectId}&scalarReconciliation=${first.result.request.id}`,
    );
    await pm.getByRole("button", { name: /^Project manager / }).click();
    const view = pm.getByRole("region", {
      name: "PM scalar reconciliation request",
      exact: true,
    });
    await expect(view).toContainText("Original scalar value A");
    const added = await f.append("pmo-portfolio", 2, "Changed scalar value C");
    const changed = await scalarCheckUI(page);
    expect(changed.result.outcome).toBe("CREATED");
    expect(changed.result.request.id).not.toBe(first.result.request.id);
    expect(changed.result.assessment.assessmentId).not.toBe(
      first.result.assessment.assessmentId,
    );
    expect(
      new Set(
        changed.result.assessment.result.conflicts.flatMap(
          (group: { versionIds: string[] }) => group.versionIds,
        ),
      ),
    ).toEqual(new Set([f.first.entry.id, f.second.entry.id, added.entry.id]));
    const oldAgain = await f.api("pm-atlas", detailPath);
    expect(await oldAgain.body()).toEqual(originalBytes);
    const replay = await f.api(
      "pmo-portfolio",
      f.prefix + "/scalar-reconciliation-checks",
      "POST",
      first.input,
    );
    expect(replay.status()).toBe(201);
    expect(await replay.json()).toEqual({
      ...first.result,
      replayed: true,
      assessment: { ...first.result.assessment, replayed: true },
    });
    const currentResponse = await f.api(
      "pm-atlas",
      f.prefix + "/scalar-reconciliation-requests/" + changed.result.request.id,
    );
    expect(currentResponse.status()).toBe(200);
    const current = await currentResponse.json();
    expect(current.assessment.assessmentId).toBe(
      changed.result.assessment.assessmentId,
    );
    expect(
      current.assessment.result.versions
        .map((v: { id: string }) => v.id)
        .sort(),
    ).toEqual([f.first.entry.id, f.second.entry.id, added.entry.id].sort());
    await view
      .getByRole("button", {
        name: "Refresh scalar request access",
        exact: true,
      })
      .click();
    await expect(view).toContainText(original.assessment.asOf);
    await expect(view).toContainText("Original scalar value A");
    await expect(view).toContainText("Original scalar value B");
    await expect(view).not.toContainText("Changed scalar value C");
    await pm.screenshot({
      path: "artifacts/evidence-workflow-scalar-original-after-change.png",
      fullPage: true,
    });
  } finally {
    await pmContext.close();
  }
});
test("FR-EVD-009: project access refresh remains usable after automatic scalar proof clearing", async ({
  page,
  request,
}) => {
  const f = await fixture(request, true);
  const first = await f.append(
    "pmo-portfolio",
    0,
    "Automatically cleared scalar A",
  );
  const second = await f.append(
    "pm-atlas",
    1,
    "Automatically cleared scalar B",
  );
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
  const checked = await f.api(
    "pmo-portfolio",
    f.prefix + "/scalar-reconciliation-checks",
    "POST",
    { factId: first.factId, idempotencyKey: randomUUID() },
  );
  expect(checked.status()).toBe(201);
  const created = await checked.json();
  await page.goto(
    `/?project=${f.projectId}&scalarReconciliation=${created.request.id}`,
  );
  await page.getByRole("button", { name: /^Project manager / }).click();
  const proof = page.getByRole("region", {
    name: "PM scalar reconciliation request",
    exact: true,
  });
  await expect(proof).toContainText("Automatically cleared scalar A");
  expect(
    (
      await f.api("operator", "/access-grants", "DELETE", {
        subject: "pm-atlas",
        scopeType: "project",
        scopeId: f.projectId,
      })
    ).status(),
  ).toBe(204);
  // Deliberately let the real 15-second authorization polling win the race.
  // No route fulfillment, clock manipulation or content restoration is used.
  await expect(proof).toHaveCount(0, { timeout: 30000 });
  const response = page.waitForResponse(
    (value) =>
      value.url().endsWith(f.prefix + "/facts") &&
      value.request().method() === "GET",
  );
  await page
    .getByRole("button", { name: "Refresh evidence access", exact: true })
    .click();
  expect((await response).status()).toBe(404);
  expect(
    (
      await f.api(
        "pm-atlas",
        f.prefix + "/scalar-reconciliation-requests/" + created.request.id,
      )
    ).status(),
  ).toBe(404);
  await expect(proof).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    "Automatically cleared scalar A",
  );
  await expect(page.locator("body")).not.toContainText(
    "Automatically cleared scalar B",
  );
});
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

test("E2E-HLT-007: PMO saves a project-local overdue policy and sees its canonical assessment evidence", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  const initialResponse = await f.api(
    "pmo-portfolio",
    f.prefix + "/schedule-health-policy",
  );
  expect(initialResponse.status()).toBe(200);
  const initialPolicy = await initialResponse.json();
  const milestoneKey = f.payload.milestones[0].key;
  const milestoneDueDate = f.payload.milestones[0].dates.forecastEnd;

  await open(page, f.payload.name);
  const panel = page.getByRole("region", {
    name: "Schedule and blocker age",
    exact: true,
  });
  const policyPanel = panel.getByRole("region", {
    name: "Project schedule overdue policy",
    exact: true,
  });
  await expect(policyPanel).toBeVisible();
  await policyPanel.getByLabel("Schedule health time zone (IANA)", { exact: true })
    .fill("America/Los_Angeles");
  await policyPanel
    .getByLabel("Default overdue threshold (local calendar days)", { exact: true })
    .fill("2");
  const overrides = [{
    targetType: "MILESTONE",
    targetKey: milestoneKey,
    minimumOverdueDays: 5,
  }];
  await policyPanel
    .getByLabel("Per-target threshold overrides (JSON)", { exact: true })
    .fill(JSON.stringify(overrides));

  const savedWait = page.waitForResponse(
    (response) =>
      response.url().endsWith(f.prefix + "/schedule-health-policy") &&
      response.request().method() === "POST",
  );
  await policyPanel
    .getByRole("button", { name: "Save project schedule policy", exact: true })
    .click();
  const savedResponse = await savedWait;
  expect(savedResponse.status()).toBe(200);
  const savedPolicy = await savedResponse.json();
  expect(savedPolicy).toMatchObject({
    revision: initialPolicy.revision + 1,
    timeZone: "America/Los_Angeles",
    defaultMinimumOverdueDays: 2,
    targetOverrides: overrides,
  });
  await expect(policyPanel).toContainText(
    "Schedule health policy revision " + savedPolicy.revision + ": America/Los_Angeles",
  );

  const assessmentWait = page.waitForResponse(
    (response) =>
      response.url().endsWith(f.prefix + "/health-assessments") &&
      response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Run assessment", exact: true }).click();
  const assessmentResponse = await assessmentWait;
  expect(assessmentResponse.status()).toBe(201);
  const assessment = await assessmentResponse.json();
  expect(assessment.ruleRevision).toBe("schedule-health@2+blocker-age@1");
  expect(assessment.input.scheduleHealthPolicy).toMatchObject({
    revision: savedPolicy.revision,
    timeZone: "America/Los_Angeles",
    defaultMinimumOverdueDays: 2,
    targetOverrides: overrides,
  });
  const milestoneSignal = assessment.result.objectiveSignals.find(
    (signal: { targetKey: string; kind: string }) =>
      signal.targetKey === milestoneKey && signal.kind === "OVERDUE_MILESTONE",
  );
  expect(milestoneSignal).toBeDefined();
  expect(milestoneSignal.state).toBe("ACTIVE");
  expect(milestoneSignal.rule.parameters).toEqual(expect.arrayContaining([
    { name: "timeZone", value: "America/Los_Angeles" },
    { name: "scheduleHealthPolicyRevision", value: savedPolicy.revision },
    { name: "minimumOverdueDays", value: 5 },
    { name: "selectedDateField", value: "forecastEnd" },
  ]));
  expect(milestoneSignal.rule.parameters.find(
    (parameter: { name: string }) => parameter.name === "daysOverdue",
  ).value).toBeGreaterThan(5);
  expect(milestoneSignal.sourceFacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "selectedDueDate", value: milestoneDueDate }),
    expect.objectContaining({ field: "selectedDateField", value: "forecastEnd" }),
  ]));

  const milestoneRow = panel.locator("tbody tr").filter({
    hasText: milestoneKey + " · Milestone",
  });
  await expect(milestoneRow).toContainText("ACTIVE · HIGH");
  await expect(milestoneRow).toContainText(milestoneDueDate);
  await expect(milestoneRow).toContainText("5 local day(s)");
  await expect(milestoneRow).toContainText("America/Los_Angeles");
  await page.screenshot({
    path: "artifacts/schedule-overdue-policy.png",
    fullPage: true,
  });
});

test("E2E-HLT-003 source-authorized case: visible age uses current human facts and the configured threshold", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  const assessmentRetention = await f.api(
    "pmo-portfolio",
    "/admin/health-assessment-retention",
    "POST",
    {
      contentRetentionHours: 24,
      auditRetentionHours: 48,
      idempotencyRetentionHours: 72,
    },
  );
  expect(assessmentRetention.status()).toBe(200);

  const policyResponse = await f.api(
    "pmo-portfolio",
    "/admin/blocker-age-threshold-policy",
  );
  expect(policyResponse.status()).toBe(200);
  const existingPolicy = await policyResponse.json();

  await open(page, f.payload.name);
  const panel = page.getByRole("region", {
    name: "Schedule and blocker age",
    exact: true,
  });
  const minimumAge = panel.getByLabel(
    "Minimum blocker age (UTC calendar days)",
    { exact: true },
  );
  const retention = panel.getByLabel(
    "Threshold audit retention (hours)",
    { exact: true },
  );
  await minimumAge.fill("10");
  await retention.fill("720");
  const thresholdSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/admin/blocker-age-threshold-policy") &&
      response.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "Save customer threshold", exact: true })
    .click();
  const thresholdResponse = await thresholdSaved;
  expect(thresholdResponse.status()).toBe(200);
  const savedPolicy = await thresholdResponse.json();
  expect(savedPolicy.minimumBlockerAgeDays).toBe(10);
  expect(savedPolicy.auditRetentionHours).toBe(720);
  expect(savedPolicy.revision).toBe((existingPolicy?.revision ?? 0) + 1);
  await expect(panel).toContainText(
    "Current revision " +
      savedPolicy.revision +
      ": blockers age after 10 UTC calendar days. Audit retention is 720 hours.",
  );

  const canonicalResponse = await f.api(
    "pmo-portfolio",
    f.prefix + "/canonical",
  );
  expect(canonicalResponse.status()).toBe(200);
  const canonical = (await canonicalResponse.json()) as {
    raidItems: Array<{ id: string; key: string; state: string }>;
  };
  expect(canonical.raidItems).toHaveLength(6);

  const effectiveAt = f.effectiveAt;
  const finiteValidity = {
    basis: "observedAt",
    durationMs: 86_400_000,
  };
  const currentDefinition = {
    tiers: [
      {
        selectors: [
          {
            sourceType: "human_statement",
            instanceId: null,
            requiredApproval: "NOT_REQUIRED",
            validity: finiteValidity,
          },
        ],
      },
    ],
    conflictBehavior: "REQUEST_RECONCILIATION",
  };
  const openedAtDefinition = {
    tiers: [
      {
        selectors: [
          {
            sourceType: "human_statement",
            instanceId: null,
            requiredApproval: "NOT_REQUIRED",
            validity: { mode: "UNTIL_SUPERSEDED" },
          },
        ],
      },
    ],
    conflictBehavior: "REQUEST_RECONCILIATION",
  };
  const configure = async (factType: string, definition: unknown) => {
    const response = await f.api(
      "pmo-portfolio",
      f.prefix + "/authority-policies",
      "POST",
      {
        projectId: f.projectId,
        factType,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        effectiveAt,
        definition,
      },
    );
    expect(response.status()).toBe(201);
  };
  const append = async (
    factType: string,
    value:
      | { type: "boolean"; value: boolean }
      | { type: "date"; value: string },
  ) => {
    const response = await f.api(
      "pm-atlas",
      f.prefix + "/fact-statements",
      "POST",
      {
        projectId: f.projectId,
        factType,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        value,
        originalStatement:
          "Synthetic authority input for blocker-age browser acceptance.",
        effectiveAt,
        validUntil: null,
      },
    );
    expect(response.status()).toBe(201);
    const saved = (await response.json()) as {
      entry: { sourceId: string };
    };
    await f.share(saved.entry.sourceId);
  };

  await configure(
    "project.open_blocker_inventory_complete",
    currentDefinition,
  );
  await append("project.open_blocker_inventory_complete", {
    type: "boolean",
    value: true,
  });

  const blockingRaid = canonical.raidItems[0]!;
  const openedDate = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const [index, raid] of canonical.raidItems.entries()) {
    const classificationType =
      "raid_item." + raid.id + ".blocks_delivery";
    await configure(classificationType, currentDefinition);
    const blocksDelivery = index === 0;
    await append(classificationType, {
      type: "boolean",
      value: blocksDelivery,
    });
    if (blocksDelivery) {
      const openedAtType = "raid_item." + raid.id + ".opened_at";
      await configure(openedAtType, openedAtDefinition);
      await append(openedAtType, { type: "date", value: openedDate });
    }
  }

  const assessmentSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        "/projects/" + f.projectId + "/health-assessments",
      ) && response.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "Run assessment", exact: true })
    .click();
  const assessmentResponse = await assessmentSaved;
  expect(assessmentResponse.status()).toBe(201);
  const assessment = await assessmentResponse.json();
  const blockerAge = assessment.result.blockerAge;
  expect(blockerAge).toMatchObject({
    coverage: "COMPLETE",
    minimumBlockerAgeDays: 10,
    thresholdRevision: savedPolicy.revision,
    assessedBlockerCount: 1,
    unknownCandidateCount: 0,
    agedBlockerCount: 1,
    noOpenBlockers: false,
  });
  const signal = blockerAge.assessments.find(
    (item: { targetKey: string }) => item.targetKey === blockingRaid.key,
  );
  expect(signal).toMatchObject({
    targetKey: blockingRaid.key,
    sourceDate: openedDate,
    status: "AGED",
  });
  expect(signal.ageDays).toBeGreaterThanOrEqual(10);
  expect(assessment.result.calculated.status).toEqual(expect.any(String));

  await expect(panel.getByText("GREEN · unchanged", { exact: true })).toBeVisible();
  await expect(panel).toContainText("Blocker-age coverage: complete");
  await expect(panel).toContainText(
    "1 blocker(s) assessed; 1 meet or exceed the threshold.",
  );
  await expect(panel.getByText("10 days", { exact: true })).toBeVisible();
  const blockerRow = panel
    .locator("tbody tr")
    .filter({ hasText: blockingRaid.key });
  await expect(blockerRow).toContainText(openedDate);
  await expect(blockerRow).toContainText(
    /AGED · \d+ days · threshold 10/,
  );
});

test("E2E-HLT-003 unresolved case: PMO reviews the threshold and incomplete inventory stays unassessable", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  const assessmentRetention = await f.api(
    "pmo-portfolio",
    "/admin/health-assessment-retention",
    "POST",
    {
      contentRetentionHours: 24,
      auditRetentionHours: 48,
      idempotencyRetentionHours: 72,
    },
  );
  expect(assessmentRetention.status()).toBe(200);

  const policyResponse = await f.api(
    "pmo-portfolio",
    "/admin/blocker-age-threshold-policy",
  );
  expect(policyResponse.status()).toBe(200);
  const existingPolicy = await policyResponse.json();

  await open(page, f.payload.name);
  const panel = page.getByRole("region", {
    name: "Schedule and blocker age",
    exact: true,
  });
  const minimumAge = panel.getByLabel(
    "Minimum blocker age (UTC calendar days)",
    { exact: true },
  );
  const retention = panel.getByLabel(
    "Threshold audit retention (hours)",
    { exact: true },
  );
  await expect(minimumAge).toBeVisible();
  await minimumAge.fill("10");
  await retention.fill("720");
  const thresholdSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/admin/blocker-age-threshold-policy") &&
      response.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "Save customer threshold", exact: true })
    .click();
  const thresholdResponse = await thresholdSaved;
  expect(thresholdResponse.status()).toBe(200);
  const savedPolicy = await thresholdResponse.json();
  expect(savedPolicy.minimumBlockerAgeDays).toBe(10);
  expect(savedPolicy.auditRetentionHours).toBe(720);
  expect(savedPolicy.revision).toBe((existingPolicy?.revision ?? 0) + 1);
  await expect(panel).toContainText(
    `Current revision ${savedPolicy.revision}: blockers age after 10 UTC calendar days. Audit retention is 720 hours.`,
  );

  const assessmentSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(
        `/projects/${f.projectId}/health-assessments`,
      ) && response.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "Run assessment", exact: true })
    .click();
  const assessmentResponse = await assessmentSaved;
  expect(assessmentResponse.status()).toBe(201);
  const assessment = await assessmentResponse.json();
  expect(assessment.result.blockerAge.coverage).toBe("UNASSESSABLE");
  expect(assessment.result.blockerAge.noOpenBlockers).toBeNull();
  expect(assessment.result.blockerAge.unknownCandidateCount).toBeGreaterThan(0);
  expect(assessment.result.blockerAge.agedBlockerCount).toBe(0);
  expect(assessment.result.calculated.status).toEqual(expect.any(String));
  await expect(panel.getByText("GREEN · unchanged", { exact: true })).toBeVisible();
  await expect(panel).toContainText("Blocker-age coverage: unassessable");
  await expect(panel).toContainText("Blocker age is unassessable.");
  await expect(panel).not.toContainText(
    "No open blockers were classified in the current, source-authorized complete inventory.",
  );
  await expect(panel.locator("table tbody tr")).toHaveCount(6);
});
test("E2E-HLT-004: reported GREEN stays separate from the stored RED schedule result with reproducible evidence and rationale", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  const retention = await f.api(
    "pmo-portfolio",
    "/admin/health-assessment-retention",
    "POST",
    {
      contentRetentionHours: 24,
      auditRetentionHours: 48,
      idempotencyRetentionHours: 72,
    },
  );
  expect(retention.status()).toBe(200);

  await open(page, f.payload.name);
  const panel = page.getByRole("region", {
    name: "Schedule health assessment",
    exact: true,
  });
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(f.prefix + "/health-assessments") &&
      response.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "Assess schedule", exact: true })
    .click();
  const response = await savedResponse;
  expect(response.status()).toBe(201);
  const assessment = await response.json();
  expect(assessment.coverage).toBe("SCHEDULE_AND_BLOCKER_AGE");
  expect(assessment.ruleRevision).toBe(
    "schedule-health@2+blocker-age@1",
  );
  expect(assessment.blockerAgeCoverage).toBe("UNASSESSABLE");
  expect(assessment.result.blockerAge).toMatchObject({
    coverage: "UNASSESSABLE",
    noOpenBlockers: null,
  });
  expect(assessment.contentAvailable).toBe(true);

  const input = assessment.input as {
    assessedAt: string;
    reportedStatus: string;
    reportedStatusFact: {
      value: string;
      source: { recordId: string };
    };
    calculationRule: { key: string; revision: string };
    signals: Array<{
      signalId: string;
      kind: string;
      targetType: string;
      targetKey: string;
      state: string;
      severity: string;
      rule: {
        key: string;
        revision: string;
        parameters: Array<{ name: string; value: unknown }>;
      };
      sourceFacts: Array<{ field: string; value: unknown }>;
    }>;
  };
  const result = assessment.result as {
    reported: { status: string };
    calculated: {
      status: string;
      rationale: { code: string; text: string; signalIds: string[] };
    };
    contradiction: {
      kind: string;
      severity: string;
      reportedStatus: string;
      calculatedStatus: string;
    } | null;
  };
  expect(input.reportedStatus).toBe("GREEN");
  expect(input.reportedStatusFact).toMatchObject({
    value: "GREEN",
    source: { recordId: f.projectId },
  });
  expect(input.calculationRule).toMatchObject({
    key: "schedule-health",
    revision: "1",
    severityBands: {
      red: ["CRITICAL", "HIGH"],
      amber: ["MEDIUM"],
      green: ["LOW"],
    },
  });
  expect(result.reported.status).toBe("GREEN");
  expect(result.calculated.status).toBe("RED");
  expect(result.calculated.rationale.code).toBe("ACTIVE_RED_SIGNALS");
  expect(result.calculated.rationale.text).toContain("schedule-health@1");
  expect(result.contradiction).toMatchObject({
    kind: "REPORTED_CALCULATED_MISMATCH",
    reportedStatus: "GREEN",
    calculatedStatus: "RED",
  });

  const overdueMilestone = input.signals.find(
    (signal) => signal.kind === "OVERDUE_MILESTONE",
  );
  expect(overdueMilestone).toBeTruthy();
  if (!overdueMilestone)
    throw new Error("The stored schedule input omitted its overdue milestone");
  const expectedMilestone = f.payload.milestones[0];
  expect(overdueMilestone).toMatchObject({
    kind: "OVERDUE_MILESTONE",
    targetType: "MILESTONE",
    targetKey: expectedMilestone.key,
    state: "ACTIVE",
    severity: "HIGH",
    rule: { key: "schedule-health", revision: "1" },
  });
  expect(overdueMilestone.rule.parameters).toEqual(
    expect.arrayContaining([
      { name: "assessedUtcDate", value: input.assessedAt.slice(0, 10) },
      { name: "minimumOverdueDays", value: 1 },
      { name: "selectedDateField", value: "forecastEnd" },
    ]),
  );
  expect(overdueMilestone.sourceFacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        field: "forecastEnd",
        value: expectedMilestone.dates.forecastEnd,
      }),
      expect.objectContaining({
        field: "plannedEnd",
        value: expectedMilestone.dates.plannedEnd,
      }),
      expect.objectContaining({
        field: "selectedDueDate",
        value: expectedMilestone.dates.forecastEnd,
      }),
    ]),
  );
  expect(result.calculated.rationale.signalIds).toContain(
    overdueMilestone.signalId,
  );

  const latestResponse = await f.api(
    "pmo-portfolio",
    f.prefix + "/health-assessments/latest",
  );
  expect(latestResponse.status()).toBe(200);
  const latest = await latestResponse.json();
  expect(latest.assessmentId).toBe(assessment.assessmentId);
  expect(latest.input).toEqual(assessment.input);
  expect(latest.result).toEqual(assessment.result);

  // Reopen the project so the UI renders the persisted latest read, not the POST cache.
  await open(page, f.payload.name);

  await expect(panel).toContainText(
    "Assessment coverage: SCHEDULE_AND_BLOCKER_AGE",
  );
  await expect(panel).toContainText(
    "Schedule calculation scope: SCHEDULE_ONLY",
  );
  await expect(panel).toContainText(
    "Blocker-age coverage: UNASSESSABLE",
  );
  await expect(panel).toContainText(
    "Rule: schedule-health@2+blocker-age@1",
  );
  await expect(panel).toContainText(/Reported status: GREEN/);
  await expect(panel).toContainText("Calculated schedule status: RED");
  await expect(panel).toContainText(result.calculated.rationale.text);
  await expect(panel).toContainText("OVERDUE_MILESTONE · ACTIVE · HIGH");
  await expect(panel).toContainText(
    "assessedUtcDate=" + input.assessedAt.slice(0, 10),
  );
  await expect(panel).toContainText(
    "minimumOverdueDays=1, selectedDateField=forecastEnd",
  );
  await expect(panel).toContainText(
    "forecastEnd: " + expectedMilestone.dates.forecastEnd,
  );
  await expect(panel).toContainText(
    "selectedDueDate: " + expectedMilestone.dates.forecastEnd,
  );
});

async function fixture(
  request: APIRequestContext,
  scalarPm = false,
  legacy = false,
) {
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
  const created = legacy
    ? await api(
        "pmo-portfolio",
        "/projects/30000000-0000-4000-8000-000000000001",
      )
    : await api("pmo-portfolio", "/projects", "POST", payload);
  expect(created.status()).toBe(legacy ? 200 : 201);
  const project = await created.json();
  if (legacy) payload.name = project.name;
  const projectId = project.id,
    prefix = `/projects/${projectId}`,
    factType = legacy
      ? "acceptance.scalar_" + randomUUID().slice(0, 8)
      : "project.forecast",
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
