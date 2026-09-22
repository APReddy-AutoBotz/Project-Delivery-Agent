// FR-EVD-004/007/009/012: actual installed scalar UI action and OIDC PM proof.
// Reuse the configured project's HTTP-created identity/grants, never its milestone
// proof. All scalar facts, policies, checks and access changes use the public API.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import {
  api,
  observeResponse,
  changeSourceReaders,
} from "./milestone-reconciliation-workflow.mjs";
import { closeCustomerBrowserSession } from "./customer-session.mjs";

const factType = "project.forecast";
const region = (page) =>
  page.getByRole("region", {
    name: "PM scalar reconciliation request",
    exact: true,
  });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function openInstalledScalarProject(
  session,
  projectId,
  projectName,
) {
  assert.match(projectId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert(typeof projectName === "string" && projectName.length > 0);
  // OIDC tokens are memory-only. A page.goto reload loses the session, and a
  // bare ?project link is not a saved-proof route. Use the authenticated card.
  const pending = session.page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects/" + projectId) &&
      response.request().method() === "GET",
  );
  void pending.catch(() => {});
  await session.page
    .getByRole("button")
    .filter({
      has: session.page.getByRole("heading", {
        name: projectName,
        exact: true,
      }),
    })
    .click();
  const opened = await observeResponse(
    session,
    await pending,
    "installed scalar project navigation",
    200,
  );
  assert.equal(opened.observation.body.id, projectId);
  await session.capture.settle(session.page);
}

async function screenshot(session, output, file) {
  await session.capture.settle(session.page);
  const bytes = await session.page.screenshot({
    path: output + "/" + file,
    fullPage: true,
  });
  return { file, sha256: sha256(bytes) };
}
async function proofUi(session) {
  const view = region(session.page);
  for (const value of [
    "Packaged scalar forecast A",
    "Packaged scalar forecast B",
  ])
    await expect(view).toContainText(value);
  await expect(view).toContainText("Assigned to pm-atlas");
  await expect(view).toContainText("Pending scalar reconciliation");
}
async function refresh(session, detailSuffix, status) {
  const pending = session.page.waitForResponse(
    (value) =>
      value.url().endsWith("/api" + detailSuffix) &&
      value.request().method() === "GET",
  );
  void pending.catch(() => {});
  await region(session.page)
    .getByRole("button", { name: "Refresh scalar request access", exact: true })
    .click();
  const observed = await observeResponse(
    session,
    await pending,
    "scalar PM UI refresh",
    status,
  );
  await session.capture.settle(session.page);
  return observed.observation;
}
async function cleaned(sessions, action) {
  let primary, result;
  const failures = [];
  try {
    result = await action();
  } catch (error) {
    primary = error;
  }
  for (const [session, base] of [...sessions].reverse()) {
    try {
      await closeCustomerBrowserSession(session, base);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      primary ? [primary, ...failures] : failures,
      "Scalar workflow cleanup failed",
      { cause: primary ?? failures[0] },
    );
  if (primary) throw primary;
  return result;
}

export async function exerciseScalarReconciliationWorkflow({
  login,
  base,
  canonicalFixture,
  output,
  profile,
  runId,
}) {
  const sessions = [];
  return cleaned(sessions, async () => {
    const projectId = canonicalFixture.projectId,
      prefix = `/projects/${projectId}`;
    const pmo = await login("pmo-atlas");
    sessions.push([pmo, base]);
    const pm = await login("pm-atlas");
    sessions.push([pm, base]);
    const identities = {};
    for (const [key, session] of [
      ["creator", pmo],
      ["recipient", pm],
    ])
      identities[key] = (await api(session, base, "/me")).observation;
    const effectiveAt = new Date(Date.now() - 3600000).toISOString();
    const statements = [],
      sharing = [];
    for (const [index, session, value] of [
      [0, pmo, "Packaged scalar forecast A"],
      [1, pm, "Packaged scalar forecast B"],
    ]) {
      const input = {
        projectId,
        factType,
        expectedRevision: index,
        idempotencyKey: randomUUID(),
        value: { type: "text", value },
        originalStatement: value,
        effectiveAt,
        validUntil: new Date(Date.now() + 86400000).toISOString(),
      };
      const response = (
        await api(
          session,
          base,
          prefix + "/fact-statements",
          "POST",
          input,
          201,
        )
      ).observation;
      statements.push({ input, response });
      sharing.push(
        await changeSourceReaders(
          pmo,
          base,
          projectId,
          response.body.entry.sourceId,
          "AVAILABLE",
          ["pm-atlas", "pmo-atlas"],
          "scalar source sharing",
        ),
      );
    }
    const factId = statements[0].response.body.factId;
    assert.equal(statements[1].response.body.factId, factId);
    const policyInput = {
      projectId,
      factType,
      expectedRevision: 0,
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
                validity: null,
              },
            ],
          },
        ],
        conflictBehavior: "REQUEST_RECONCILIATION",
      },
    };
    const policy = {
      input: policyInput,
      response: (
        await api(
          pmo,
          base,
          prefix + "/authority-policies",
          "POST",
          policyInput,
          201,
        )
      ).observation,
    };
    // Navigate the installed web application; the material check is a real click.
    assert.equal(
      canonicalFixture.receipt.canonical.creation.body.id,
      projectId,
    );
    await openInstalledScalarProject(
      pmo,
      projectId,
      canonicalFixture.receipt.canonical.command.name,
    );
    await pmo.page.getByLabel("Fact type key", { exact: true }).fill(factType);
    await pmo.page
      .getByRole("button", { name: "Open fact history", exact: true })
      .click();
    const check = pmo.page.getByRole("region", {
      name: "Scalar reconciliation check",
      exact: true,
    });
    async function clickCheck() {
      const pending = pmo.page.waitForResponse(
        (value) =>
          value.url().endsWith(prefix + "/scalar-reconciliation-checks") &&
          value.request().method() === "POST",
      );
      void pending.catch(() => {});
      await check
        .getByRole("button", {
          name: "Check and request reconciliation",
          exact: true,
        })
        .click();
      const response = await pending;
      const input = response.request().postDataJSON();
      const observed = await observeResponse(
        pmo,
        response,
        "installed scalar check button",
        201,
      );
      await pmo.capture.settle(pmo.page);
      await expect(check).toContainText("Assigned to pm-atlas");
      return { input, response: observed.observation };
    }
    const created = await clickCheck();
    assert.equal(created.response.body.outcome, "CREATED");
    const replay = (
      await api(
        pmo,
        base,
        prefix + "/scalar-reconciliation-checks",
        "POST",
        created.input,
        201,
      )
    ).observation;
    const reused = await clickCheck();
    assert.equal(reused.response.body.outcome, "REUSED");
    const requestId = created.response.body.request.id,
      detailSuffix = `${prefix}/scalar-reconciliation-requests/${requestId}`;
    const managerDenied = (
      await api(pmo, base, detailSuffix, "GET", undefined, 404)
    ).observation;
    const managementQueue = (
      await api(pmo, base, prefix + "/managed-scalar-reconciliation-requests")
    ).observation;
    const recipientQueue = (
      await api(pm, base, prefix + "/scalar-reconciliation-requests")
    ).observation;
    const proofSession = await login(
      "pm-atlas",
      `/?project=${projectId}&scalarReconciliation=${requestId}`,
      "scalar-reconciliation",
      "/api" + detailSuffix,
    );
    sessions.push([proofSession, base]);
    const originalProof = (
      await observeResponse(
        proofSession,
        proofSession.initialResponse,
        "original scalar saved-link PM proof",
        200,
      )
    ).observation;
    await proofUi(proofSession);
    const image = await screenshot(
      proofSession,
      output,
      "scalar-reconciliation-pm-proof.png",
    );
    const withdrawal = await changeSourceReaders(
      pmo,
      base,
      projectId,
      statements[0].response.body.entry.sourceId,
      "AVAILABLE",
      ["pmo-atlas"],
      "scalar PM source withdrawal",
    );
    const restricted = await refresh(proofSession, detailSuffix, 200);
    await expect(region(proofSession.page)).toContainText(
      "Saved result withheld",
    );
    for (const statement of statements)
      await expect(region(proofSession.page)).not.toContainText(
        statement.input.value.value,
      );
    const regrant = await changeSourceReaders(
      pmo,
      base,
      projectId,
      statements[0].response.body.entry.sourceId,
      "AVAILABLE",
      ["pm-atlas", "pmo-atlas"],
      "scalar PM source regrant",
    );
    const availableAgain = await refresh(proofSession, detailSuffix, 200);
    assert.equal(availableAgain.bodyBase64, originalProof.bodyBase64);
    await proofUi(proofSession);
    return {
      projectId,
      requestId,
      detailSuffix,
      receipt: {
        family: "scalar-browser-workflow/v1",
        status: "awaiting-recreation",
        profile,
        runId,
        projectId,
        factId,
        factType,
        identities,
        statements,
        sharing,
        policy,
        created,
        replay,
        reused,
        managementQueue,
        recipientQueue,
        managerDenied,
        originalProof,
        sourceWithdrawal: { access: withdrawal, proof: restricted },
        sourceRegrant: { access: regrant, proof: availableAgain },
        screenshot: image,
      },
    };
  });
}

export async function openSavedScalarReconciliation({
  login,
  base,
  fixture,
  output,
}) {
  const session = await login(
    "pm-atlas",
    `/?project=${fixture.projectId}&scalarReconciliation=${fixture.requestId}`,
    "scalar-reconciliation",
    "/api" + fixture.detailSuffix,
  );
  try {
    const observation = (
      await observeResponse(
        session,
        session.initialResponse,
        "scalar saved-link proof after recreation",
        200,
      )
    ).observation;
    assert.equal(
      observation.bodyBase64,
      fixture.receipt.originalProof.bodyBase64,
    );
    await proofUi(session);
    return {
      session,
      observation,
      screenshot: await screenshot(
        session,
        output,
        "scalar-reconciliation-pm-proof-recreated.png",
      ),
    };
  } catch (error) {
    await cleaned([[session, base]], async () => {
      throw error;
    });
  }
}

export async function verifyScalarProjectWithdrawal({
  saved,
  base,
  fixture,
  withdrawal,
  output,
}) {
  return cleaned([[saved.session, base]], async () => {
    // Automatic project/queue revalidation may already have securely unmounted
    // the scalar controls. The outer project access button survives clearing.
    const uiPath = `/api/projects/${fixture.projectId}/facts`;
    const pending = saved.session.page.waitForResponse(
      (response) =>
        response.url().endsWith(uiPath) &&
        response.request().method() === "GET",
    );
    void pending.catch(() => {});
    await saved.session.page
      .getByRole("button", { name: "Refresh evidence access", exact: true })
      .click();
    const uiDenial = (
      await observeResponse(
        saved.session,
        await pending,
        "scalar project-access UI refresh",
        404,
      )
    ).observation;
    await saved.session.capture.settle(saved.session.page);
    const directDenial = (
      await api(
        saved.session,
        base,
        fixture.detailSuffix,
        "GET",
        undefined,
        404,
      )
    ).observation;
    assert.equal(uiDenial.bodyBase64, directDenial.bodyBase64);
    for (const statement of fixture.receipt.statements)
      await expect(saved.session.page.locator("body")).not.toContainText(
        statement.input.value.value,
      );
    await expect(region(saved.session.page)).toHaveCount(0);
    return {
      ...fixture.receipt,
      status: "passed",
      recreatedProof: {
        proof: saved.observation,
        screenshot: saved.screenshot,
      },
      projectScopeWithdrawal: {
        command: withdrawal.command,
        uiPath,
        uiDenial,
        directDenial,
        screenshot: await screenshot(
          saved.session,
          output,
          "scalar-reconciliation-pm-scope-denied.png",
        ),
      },
    };
  });
}
