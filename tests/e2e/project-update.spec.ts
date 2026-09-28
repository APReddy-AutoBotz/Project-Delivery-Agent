import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

const portfolioId = "20000000-0000-4000-8000-000000000001";
test.setTimeout(90000);

test("E2E-UPD-001: source-authorized stale assessment persists a value-free request preview", async ({
  page,
  request,
}) => {
  const f = await fixture(request);
  const statement = await f.append();
  await f.share(statement.entry.sourceId);
  const authority = await f.api("pmo-portfolio", f.prefix + "/authority-policies", "POST", {
    projectId: f.projectId,
    factType: f.factType,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    effectiveAt: f.effectiveAt,
    definition: {
      tiers: [{
        selectors: [{
          sourceType: "human_statement",
          instanceId: null,
          requiredApproval: "NOT_REQUIRED",
          validity: { basis: "effectiveAt", durationMs: 7200000 },
        }],
      }],
      conflictBehavior: "REQUEST_RECONCILIATION",
    },
  });
  expect(authority.status()).toBe(201);

  const historyBefore = await (
    await f.api("pmo-portfolio", f.prefix + "/facts/" + f.factType + "/history")
  ).json();
  expect(historyBefore.entries).toHaveLength(1);
  expect(historyBefore.entries[0].content.effectiveAt).toBe(f.effectiveAt);
  const observedAt = historyBefore.entries[0].content.observedAt;

  await open(page, f.payload.name);
  const panel = page.getByRole("region", {
    name: "Project update freshness and completeness",
    exact: true,
  });
  await panel.getByText("Reporting policy · PMO administration", { exact: true }).click();
  await page.getByLabel("Freshness window (seconds)", { exact: true }).fill("1");
  await page.getByLabel("Project time zone (IANA)", { exact: true }).fill("UTC");
  await page.getByLabel("Responsible owner subject", { exact: true }).fill("synthetic-owner-4");
  await page.getByLabel(/^Required facts/).fill(f.factType + " | Current forecast");
  await page.getByRole("button", { name: "Save policy revision", exact: true }).click();
  await expect(panel).toContainText("Reporting policy saved as an immutable revision.");

  await page.waitForTimeout(1500);
  const assessmentResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(f.prefix + "/project-update-assessments") &&
      response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Assess project", exact: true }).click();
  const response = await assessmentResponse;
  expect(response.status()).toBe(201);
  const assessment = await response.json();
  expect(assessment.completeness).toMatchObject({
    state: "COMPLETE",
    confirmedCount: 1,
    requiredCount: 1,
  });
  expect(assessment.freshness).toMatchObject({
    state: "STALE",
    sourceDateField: "project.latestValidUpdateAt",
    sourceDate: observedAt,
    freshnessWindowSeconds: 1,
  });
  expect(assessment.obligation).toMatchObject({
    state: "OPEN",
    dueAt: new Date(Date.parse(observedAt) + 1000).toISOString(),
  });
  expect(assessment.preview).toMatchObject({
    reportedStatus: "GREEN",
    sourceDate: observedAt,
    timestampBasis: "REQUIRED_FACTS",
    freshnessState: "STALE",
    completenessState: "COMPLETE",
  });
  expect(JSON.stringify(assessment)).not.toContain("First synthetic forecast");

  await expect(panel).toContainText("Saved request preview · Draft");
  await expect(panel).toContainText("This preview has not been sent.");
  await expect(panel.getByRole("button", { name: /send/i })).toHaveCount(0);
  const previewId = assessment.preview.id;

  await open(page, f.payload.name);
  const persisted = page.getByRole("region", {
    name: "Project update freshness and completeness",
    exact: true,
  });
  await expect(persisted).toContainText("Saved request preview · Draft");
  await expect(persisted).toContainText(observedAt);
  const saved = await (
    await f.api(
      "pmo-portfolio",
      f.prefix + "/project-update-assessments/latest",
    )
  ).json();
  expect(saved.preview.id).toBe(previewId);

  const historyAfter = await (
    await f.api("pmo-portfolio", f.prefix + "/facts/" + f.factType + "/history")
  ).json();
  expect(historyAfter.entries.map((entry: { id: string }) => entry.id)).toEqual(
    historyBefore.entries.map((entry: { id: string }) => entry.id),
  );
});

async function fixture(request: APIRequestContext) {
  const tokens: Record<string, string> = {};
  for (const persona of ["pmo-portfolio", "operator"]) {
    const response = await request.post("/api/auth/development", {
      data: { persona },
    });
    expect(response.status()).toBe(200);
    tokens[persona] = (await response.json()).token;
  }
  async function api(persona: string, path: string, method = "GET", data?: unknown) {
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
    code: "UPD-" + randomUUID().slice(0, 12),
    name: "Synthetic update " + randomUUID().slice(0, 8),
  };
  const created = await api("pmo-portfolio", "/projects", "POST", payload);
  expect(created.status()).toBe(201);
  const project = await created.json();
  const projectId = project.id;
  const prefix = "/projects/" + projectId;
  const factType = "project.forecast";
  const effectiveAt = new Date(Date.now() - 3600000).toISOString();
  const statementValue = "First synthetic forecast";
  async function append() {
    const response = await api("pmo-portfolio", prefix + "/fact-statements", "POST", {
      projectId,
      factType,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      value: { type: "text", value: statementValue },
      originalStatement: statementValue,
      effectiveAt,
      validUntil: null,
    });
    expect(response.status()).toBe(201);
    return response.json();
  }
  async function share(sourceId: string) {
    const path = prefix + "/fact-sources/" + sourceId + "/access";
    const current = await api("pmo-portfolio", path);
    expect(current.status()).toBe(200);
    const access = await current.json();
    const response = await api("pmo-portfolio", path, "POST", {
      projectId,
      sourceId,
      expectedRevision: access.revision,
      state: "AVAILABLE",
      readers: ["pmo-portfolio"],
    });
    expect(response.status()).toBe(200);
  }
  return { api, payload, projectId, prefix, factType, effectiveAt, append, share };
}

async function open(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /^PMO administrator / }).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { name: "Project evidence", exact: true })).toBeVisible();
}
