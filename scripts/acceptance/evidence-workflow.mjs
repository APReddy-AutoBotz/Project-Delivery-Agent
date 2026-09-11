// AC-EVD-001/002/003, AC-ADM-003: real TLS/OIDC browser and HTTP acceptance.
// Called only by the guarded, disposable customer-composition harness. Tokens
// stay in the verifier process; receipts contain synthetic IDs and assertions.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { expect } from "@playwright/test";

const factType = "acceptance.forecast";
const savedRegion = (page) =>
  page.getByRole("region", { name: "Saved assessment", exact: true });
async function api(session, base, path, method = "GET", data, status = 200) {
  const response = await session.context.request
    .fetch(base + "/api" + path, {
      method,
      headers: { Authorization: "Bearer " + session.token },
      ...(data === undefined ? {} : { data }),
    })
    .catch(() => {
      throw new Error("Evidence HTTP transport unavailable");
    });
  const body = await response.text();
  session.disclosure.add(
    "evidence-api-headers",
    JSON.stringify(response.headersArray()),
  );
  session.disclosure.add("evidence-api-bodies", body);
  assert.equal(response.status(), status, "Evidence HTTP status");
  return JSON.parse(body);
}
async function openFact(page) {
  await page.getByLabel("Fact type key", { exact: true }).fill(factType);
  await page
    .getByRole("button", { name: "Open fact history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Statement history", exact: true }),
  ).toBeVisible();
}
async function capture(session, base, projectId) {
  const response = session.page.waitForResponse(
    (r) => r.url().endsWith("/assessments") && r.request().method() === "POST",
  );
  await session.page
    .getByRole("button", { name: "Capture new assessment", exact: true })
    .click();
  assert.equal((await response).status(), 201);
  const result = await (await response).json();
  await expect(savedRegion(session.page)).toContainText(result.asOf);
  assert.deepEqual(
    await api(
      session,
      base,
      `/projects/${projectId}/assessments/${result.assessmentId}`,
    ),
    result,
  );
  return result;
}
async function publish(session, effectiveAt, duration) {
  const page = session.page;
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
    .fill(duration);
  await page
    .getByLabel("Conflict behavior", { exact: true })
    .selectOption("REQUEST_RECONCILIATION");
  await page
    .getByLabel("Rule effective at (UTC)", { exact: true })
    .fill(effectiveAt);
  await page
    .getByRole("button", { name: "Review authority rule", exact: true })
    .click();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/authority-policies") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Publish authority rule", exact: true })
    .click();
  assert.equal((await response).status(), 201);
  await expect(
    page.getByRole("heading", { name: "Authority rule", exact: true }),
  ).toBeVisible();
}
export async function exerciseEvidenceWorkflow({
  login,
  base,
  projectId,
  output,
}) {
  const pm = await login("pm-atlas"),
    pmo = await login("pmo-atlas");
  const prefix = `/projects/${projectId}`,
    effectiveAt = new Date(Date.now() - 3600000).toISOString();
  try {
    for (const session of [pm, pmo]) {
      await session.page
        .getByRole("button", { name: /Customer installation fixture/ })
        .click();
      await openFact(session.page);
    }
    const empty = await api(pm, base, `${prefix}/facts/${factType}/history`);
    assert.equal(empty.factId, null);
    assert.equal(empty.throughRevision, 0);
    // A changed value from the same human source retains its original record.
    const historyStatement = {
      projectId,
      factType: "acceptance.history",
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      value: { type: "number", value: 10 },
      originalStatement: "Synthetic original value ten",
      effectiveAt,
      validUntil: null,
    };
    const changedSourceBefore = await api(
      pm,
      base,
      prefix + "/fact-statements",
      "POST",
      historyStatement,
      201,
    );
    await api(
      pm,
      base,
      prefix + "/fact-statements",
      "POST",
      {
        ...historyStatement,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        value: { type: "number", value: 20 },
        originalStatement: "Synthetic changed value twenty",
      },
      201,
    );
    const changedSourceAfter = await api(
      pm,
      base,
      `${prefix}/facts/acceptance.history/history`,
    );
    assert.equal(changedSourceAfter.entries.length, 2);
    assert.deepEqual(changedSourceAfter.entries[0], changedSourceBefore.entry);
    assert.equal(
      changedSourceAfter.entries[1].sourceId,
      changedSourceBefore.entry.sourceId,
    );
    assert.deepEqual(changedSourceAfter.entries[1].content.value, {
      type: "number",
      value: 20,
    });
    // The PM confirms a statement through the delivered review form.
    await pm.page
      .getByLabel("Statement value", { exact: true })
      .fill("Synthetic forecast A");
    await pm.page
      .getByLabel("Original statement", { exact: true })
      .fill("Synthetic original forecast A");
    await pm.page
      .getByLabel("Effective at (UTC)", { exact: true })
      .fill(effectiveAt);
    await pm.page
      .getByRole("button", { name: "Review statement", exact: true })
      .click();
    await pm.page
      .getByRole("button", { name: "Confirm and save statement", exact: true })
      .click();
    await expect(
      pm.page.getByRole("article", { name: "History revision 1", exact: true }),
    ).toContainText("Synthetic original forecast A");
    const firstHistory = await api(
        pm,
        base,
        `${prefix}/facts/${factType}/history`,
      ),
      sourceId = firstHistory.entries[0].sourceId;
    const privateHistory = await api(
      pmo,
      base,
      `${prefix}/facts/${factType}/history`,
    );
    assert.equal(privateHistory.entries[0].visibility, "restricted");
    assert.equal(privateHistory.entries[0].content, undefined);
    await api(
      pm,
      base,
      `${prefix}/fact-sources/${sourceId}/access`,
      "GET",
      undefined,
      404,
    );
    // Sharing is an explicit, reviewed PMO action, additional to project access.
    await pmo.page
      .getByRole("button", { name: "Refresh history", exact: true })
      .click();
    await pmo.page
      .getByRole("button", { name: "Manage source readers", exact: true })
      .click();
    await pmo.page
      .getByLabel("Reader account subjects", { exact: true })
      .fill("pm-atlas\npmo-atlas");
    await pmo.page
      .getByRole("button", { name: "Review source access", exact: true })
      .click();
    await pmo.page
      .getByRole("button", { name: "Save source access", exact: true })
      .click();
    await expect(
      pmo.page.getByRole("article", {
        name: "History revision 1",
        exact: true,
      }),
    ).toContainText("Synthetic original forecast A");
    await publish(pmo, effectiveAt, "7200");
    const original = await capture(pm, base, projectId);
    assert.equal(original.result.status, "RESOLVED");
    assert.equal(original.result.versions[0].assessment.freshness, "CURRENT");
    const statement = {
      projectId,
      factType,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      value: { type: "text", value: "Synthetic forecast B" },
      originalStatement: "Synthetic original forecast B",
      effectiveAt,
      validUntil: null,
    };
    const second = await api(
      pmo,
      base,
      prefix + "/fact-statements",
      "POST",
      statement,
      201,
    );
    assert.equal(
      (
        await api(
          pmo,
          base,
          prefix + "/fact-statements",
          "POST",
          statement,
          201,
        )
      ).entry.id,
      second.entry.id,
    );
    const accessPath = `${prefix}/fact-sources/${second.entry.sourceId}/access`;
    const access = await api(pmo, base, accessPath);
    await api(pmo, base, accessPath, "POST", {
      projectId,
      sourceId: second.entry.sourceId,
      expectedRevision: access.revision,
      state: "AVAILABLE",
      readers: ["pm-atlas", "pmo-atlas"],
    });
    const history = await api(pm, base, `${prefix}/facts/${factType}/history`);
    assert.equal(history.entries.length, 2);
    const { sourceAccessRevision: originalAccessRevision, ...originalEntry } =
      firstHistory.entries[0];
    const { sourceAccessRevision: currentAccessRevision, ...retainedEntry } =
      history.entries[0];
    assert(currentAccessRevision > originalAccessRevision);
    assert.deepEqual(retainedEntry, originalEntry);
    assert.deepEqual(
      history.entries.map((entry) => entry.content.value),
      [
        { type: "text", value: "Synthetic forecast A" },
        { type: "text", value: "Synthetic forecast B" },
      ],
    );
    assert(
      history.entries.every((entry) =>
        entry.content.originalStatement.startsWith(
          "Synthetic original forecast",
        ),
      ),
    );
    const conflict = await capture(pm, base, projectId);
    assert.equal(conflict.result.status, "CONFLICTING");
    assert(
      conflict.result.versions.every(
        (v) => v.assessment.freshness === "CURRENT",
      ),
    );
    await publish(pmo, effectiveAt, "1");
    const stale = await capture(pm, base, projectId);
    assert.equal(stale.result.versions.length, 2);
    assert(
      stale.result.versions.every(
        (v) =>
          v.assessment.provenance === "HUMAN_CONFIRMED" &&
          v.assessment.freshness === "STALE" &&
          v.assessment.conflict === "CONFLICTING",
      ),
    );
    await expect(
      savedRegion(pm.page).getByText("Freshness: STALE", { exact: true }),
    ).toHaveCount(2);
    await expect(
      savedRegion(pm.page).getByText("Conflict: CONFLICTING", { exact: true }),
    ).toHaveCount(2);
    await expect(savedRegion(pm.page)).toContainText("Expired at capture");
    await expect(savedRegion(pm.page)).toContainText("has not been created");
    const screenshot = await pm.page.screenshot({
      path: output + "/evidence-stale-conflict.png",
      fullPage: true,
    });
    assert.deepEqual(
      await api(pm, base, `${prefix}/assessments/${original.assessmentId}`),
      original,
    );
    const firstPath = `${prefix}/fact-sources/${sourceId}/access`,
      before = await api(pmo, base, firstPath);
    const revoked = await api(pmo, base, firstPath, "POST", {
      projectId,
      sourceId,
      expectedRevision: before.revision,
      state: "REVOKED",
      readers: ["pmo-atlas"],
    });
    const hidden = await api(
      pm,
      base,
      `${prefix}/assessments/${original.assessmentId}`,
    );
    assert.equal(hidden.visibility, "restricted");
    assert.equal(hidden.result, null);
    await pm.page
      .getByRole("button", { name: "Refresh history", exact: true })
      .click();
    await expect(
      pm.page.getByRole("article", { name: "History revision 1", exact: true }),
    ).toContainText("Source restricted");
    await pm.page
      .getByRole("button", {
        name: "Recheck saved assessment access",
        exact: true,
      })
      .click();
    await expect(savedRegion(pm.page)).toContainText("Saved result withheld");
    await expect(pm.page.locator("body")).not.toContainText(
      "Synthetic forecast A",
    );
    await api(pmo, base, firstPath, "POST", {
      projectId,
      sourceId,
      expectedRevision: revoked.revision,
      state: "AVAILABLE",
      readers: ["pm-atlas", "pmo-atlas"],
    });
    assert.deepEqual(
      await api(pm, base, `${prefix}/assessments/${original.assessmentId}`),
      original,
    );
    await pm.capture(pm.page);
    await pmo.capture(pmo.page);
    return {
      original,
      receipt: {
        status: "awaiting-upgrade",
        projectId,
        factType,
        originalAssessmentId: original.assessmentId,
        emptyAuthorizedHistory: true,
        reviewedHumanStatement: true,
        originalHistoryPreserved: true,
        pmoOnlyReviewedSharing: true,
        identicalStatementReplay: true,
        currentConflict: true,
        humanStaleConflict: true,
        configuredExpiryWarning: true,
        subsequentPolicyOnly: true,
        sourceRevalidationWithheld: true,
        observations: {
          changedSourceBefore,
          changedSourceAfter,
          firstHistory,
          retainedHistory: history,
          original,
          conflict,
          stale,
          restricted: hidden,
        },
        screenshot: {
          file: "evidence-stale-conflict.png",
          sha256: createHash("sha256").update(screenshot).digest("hex"),
        },
      },
    };
  } finally {
    await pm.capture.close();
    await pmo.capture.close();
  }
}
export async function openSavedEvidence({ login, base, projectId, original }) {
  const session = await login(
    "pm-atlas",
    `/?project=${projectId}&assessment=${original.assessmentId}`,
  );
  await expect(savedRegion(session.page)).toContainText(original.asOf);
  await expect(savedRegion(session.page)).toContainText("Freshness: CURRENT");
  assert.deepEqual(
    await api(
      session,
      base,
      `/projects/${projectId}/assessments/${original.assessmentId}`,
    ),
    original,
  );
  return session;
}
export async function verifyEvidenceProjectRevocation({
  session,
  base,
  projectId,
  original,
}) {
  await session.page
    .getByRole("button", { name: "Refresh evidence access", exact: true })
    .click();
  await expect(savedRegion(session.page)).toHaveCount(0);
  await expect(session.page.locator("body")).not.toContainText(
    "Synthetic forecast A",
  );
  await api(
    session,
    base,
    `/projects/${projectId}/assessments/${original.assessmentId}`,
    "GET",
    undefined,
    404,
  );
  await session.capture(session.page);
  await session.capture.close();
}
