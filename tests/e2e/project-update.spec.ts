import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { signConnectorTaskRequest } from "../../packages/platform/dist/index.js";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

type ProjectUpdateTaskContext = {
  internalApiUrl: string;
  serviceSubject: string;
  keyRing: { currentKeyId: string; keys: Record<string, string> };
};

function projectUpdateTaskContext(): ProjectUpdateTaskContext | null {
  try {
    const local = parseEnv(readFileSync(".env", "utf8"));
    const taskKeysFile = local.PROJECT_UPDATE_TASK_KEYS_FILE;
    const internalApiUrl = local.INTERNAL_API_URL;
    const serviceSubject = local.PROJECT_UPDATE_SERVICE_SUBJECT;
    if (!taskKeysFile || !internalApiUrl || !serviceSubject) return null;
    const keyRing = JSON.parse(readFileSync(taskKeysFile, "utf8")) as
      ProjectUpdateTaskContext["keyRing"];
    return { internalApiUrl, serviceSubject, keyRing };
  } catch {
    return null;
  }
}

const localTaskContext = projectUpdateTaskContext();
const portfolioId = "20000000-0000-4000-8000-000000000001";
test.setTimeout(90000);

test("E2E-UPD-001: source-authorized stale assessment persists a value-free request preview", async ({
  page,
  request,
}) => {
  const f = await fixture(request, localTaskContext);
  if (process.env.CI === "true" && !f.taskContext)
    throw new Error("Foundation synthetic setup must configure the project-update scan task.");
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
    project: { code: f.payload.code, name: f.payload.name },
    reportedStatus: "GREEN",
    sourceDate: observedAt,
    timestampBasis: "REQUIRED_FACTS",
    freshnessState: "STALE",
    completenessState: "COMPLETE",
  });
  expect(assessment.knownPosition).toEqual([
    expect.objectContaining({
      factType: f.factType,
      label: "Current forecast",
      value: { type: "text", value: "First synthetic forecast" },
      timestampBasis: "HUMAN_OBSERVED_AT",
      observedAt,
    }),
  ]);
  expect(JSON.stringify(assessment.preview)).not.toContain("First synthetic forecast");

  await expect(panel).toContainText("Saved request preview · Draft · revision 1");
  await expect(panel).toContainText(`Project ${f.payload.code}: ${f.payload.name}.`);
  await expect(panel).toContainText("Authorized current known position");
  await expect(panel).toContainText("First synthetic forecast");
  await expect(panel).toContainText("This preview has not been sent.");
  await expect(panel.getByRole("button", { name: /send/i })).toHaveCount(0);
  const firstObligationId = assessment.obligation.id;
  const firstPreviewId = assessment.preview.id;

  const repeatedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(f.prefix + "/project-update-assessments") &&
      response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Assess project", exact: true }).click();
  const repeatedResponseValue = await repeatedResponse;
  expect(repeatedResponseValue.status()).toBe(201);
  const repeated = await repeatedResponseValue.json();
  expect(repeated.obligation.id).toBe(firstObligationId);
  expect(repeated.preview.id).not.toBe(firstPreviewId);
  expect(repeated.preview.revision).toBe(2);
  await expect(panel).toContainText("Saved request preview · Draft · revision 2");

  await page.getByLabel(/^Required facts/).fill(
    f.factType + " | Current forecast\nproject.schedule | Next milestone",
  );
  if (f.taskContext)
    await page.getByLabel("Enable scheduled assessments for this project").check();
  await page.getByRole("button", { name: "Save policy revision", exact: true }).click();
  await expect(panel).toContainText("Reporting policy saved as an immutable revision.");
  const incomplete = await (async () => {
    if (f.taskContext) {
      // The required set is incomplete, so freshness uses project creation.
      // The fixture has already crossed the one-second policy boundary.
      const scanResponse = await runScheduledProjectUpdateScan(request, f.taskContext);
      expect(scanResponse.status()).toBe(200);
      const scan = await scanResponse.json();
      expect([0, 1]).toContain(scan.processed);

      const policyResponse = await f.api(
        "pmo-portfolio",
        f.prefix + "/project-update-policy",
      );
      expect(policyResponse.status()).toBe(200);
      const scheduledPolicy = await policyResponse.json();
      expect(scheduledPolicy.scheduledScanEnabled).toBe(true);

      const latestResponse = await f.api(
        "pmo-portfolio",
        f.prefix + "/project-update-assessments/latest",
      );
      expect(latestResponse.status()).toBe(200);
      const latest = await latestResponse.json();
      expect(Date.parse(latest.assessedAt)).toBeGreaterThan(Date.parse(repeated.assessedAt));
      return latest;
    }

    const incompleteResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(f.prefix + "/project-update-assessments") &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Assess project", exact: true }).click();
    const incompleteResponseValue = await incompleteResponse;
    expect(incompleteResponseValue.status()).toBe(201);
    return incompleteResponseValue.json();
  })();
  expect(incomplete.preview.project).toMatchObject({
    code: f.payload.code,
    name: f.payload.name,
  });
  expect(incomplete.completeness).toMatchObject({
    state: "INCOMPLETE",
    confirmedCount: 1,
    requiredCount: 2,
  });
  expect(incomplete.freshness).toMatchObject({
    state: "STALE",
    sourceDateField: "project.createdAt",
  });
  expect(incomplete.obligation.id).not.toBe(firstObligationId);
  expect(incomplete.preview.requiredFacts).toContainEqual(
    expect.objectContaining({
      factType: "project.schedule",
      label: "Next milestone",
      state: "MISSING",
      reasonCodes: ["NO_CANONICAL_VALUE"],
    }),
  );
  expect(JSON.stringify(incomplete.preview)).not.toContain("First synthetic forecast");

  await open(page, f.payload.name);
  const persisted = page.getByRole("region", {
    name: "Project update freshness and completeness",
    exact: true,
  });
  await expect(persisted).toContainText("Saved request preview · Draft");
  await expect(persisted).toContainText(`Project ${f.payload.code}: ${f.payload.name}.`);
  await expect(persisted).toContainText(observedAt);
  await expect(persisted).toContainText("Next milestone: MISSING");
  await expect(persisted).toContainText("NO_CANONICAL_VALUE");
  await expect(persisted).toContainText("First synthetic forecast");
  const saved = await (
    await f.api(
      "pmo-portfolio",
      f.prefix + "/project-update-assessments/latest",
    )
  ).json();
  expect(saved.preview.id).toBe(incomplete.preview.id);

  const historyAfter = await (
    await f.api("pmo-portfolio", f.prefix + "/facts/" + f.factType + "/history")
  ).json();
  expect(historyAfter.entries.map((entry: { id: string }) => entry.id)).toEqual(
    historyBefore.entries.map((entry: { id: string }) => entry.id),
  );

  const accessPath = f.prefix + "/fact-sources/" + statement.entry.sourceId + "/access";
  const currentAccess = await (await f.api("pmo-portfolio", accessPath)).json();
  const revoked = await f.api("pmo-portfolio", accessPath, "POST", {
    projectId: f.projectId,
    sourceId: statement.entry.sourceId,
    expectedRevision: currentAccess.revision,
    state: "REVOKED",
    readers: [],
  });
  expect(revoked.status()).toBe(200);
  const protectedLatest = await f.api(
    "pmo-portfolio",
    f.prefix + "/project-update-assessments/latest",
  );
  expect(protectedLatest.status()).toBe(200);
  const protectedView = await protectedLatest.json();
  expect(protectedView.knownPosition).toEqual([]);
  expect(protectedView.preview.evidence).toEqual([]);
  expect(JSON.stringify(protectedView)).not.toContain("First synthetic forecast");
});

async function fixture(
  request: APIRequestContext,
  taskContext: ProjectUpdateTaskContext | null,
) {
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
      readers: [
        "pmo-portfolio",
        ...(taskContext ? [taskContext.serviceSubject] : []),
      ],
    });
    expect(response.status()).toBe(200);
  }
  return {
    api,
    payload,
    projectId,
    prefix,
    factType,
    effectiveAt,
    append,
    share,
    taskContext,
  };
}

async function runScheduledProjectUpdateScan(
  request: APIRequestContext,
  context: ProjectUpdateTaskContext,
) {
  const path = "/internal/project-updates/scan";
  const body = Buffer.from("{}", "utf8");
  const headers = signConnectorTaskRequest({
    method: "POST",
    path,
    body,
    keyRing: context.keyRing,
  });
  return request.post(new URL(path, context.internalApiUrl).toString(), {
    data: body,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function open(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: /^PMO administrator / }).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { name: "Project evidence", exact: true })).toBeVisible();
}
