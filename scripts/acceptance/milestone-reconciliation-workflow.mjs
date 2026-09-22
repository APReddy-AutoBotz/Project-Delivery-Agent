// AC-EVD-004 / AC-HLT-005 / GOLDEN-003 / INT-EVD-004 / INT-HLT-005.
// Real TLS/OIDC and HTTP workflow for the disposable customer composition.
// Tokens stay in the verifier process. No connector, send, acknowledgement,
// read, approval, resolution or closure is represented by this fixture.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { canonicalFixture } from "./canonical-projects.mjs";
import { closeCustomerBrowserSession } from "./customer-session.mjs";

const ruleRevision = "milestone-required-state/v1";
const pmRegion = (page) =>
  page.getByRole("region", {
    name: "PM reconciliation request",
    exact: true,
  });
// Exact keys only: resolvedValue, supportingEvidenceIds and approvalStateAsOf
// are approved proof semantics, not workflow settlement claims.
const forbiddenClaimKey =
  /^(?:acknowledged|acknowledgement|read|readAt|readReceipt|sent|sentAt|delivered|deliveredAt|closed|closedAt|resolved|resolvedAt|approved|approvedAt|message|messageId)$/i;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes) {
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Reconciliation HTTP body unavailable");
  }
}

export async function observeResponse(session, response, label, expectedStatus) {
  const bytes = Buffer.from(await response.body()).subarray(),
    text = bytes.toString("utf8"),
    headers = await response.headersArray();
  session.disclosure.add(
    "reconciliation-api-headers",
    JSON.stringify({ label, headers }),
  );
  session.disclosure.add("reconciliation-api-bodies", text);
  assert.equal(response.status(), expectedStatus, "Reconciliation HTTP status");
  const observation = {
    label,
    status: response.status(),
    bytes: bytes.length,
    sha256: sha256(bytes),
    // Only strict product API responses are passed here. Authorization request
    // headers and OIDC token responses never enter a receipt. Keeping the exact
    // bytes makes the host validator independent of JSON reserialization.
    bodyBase64: bytes.toString("base64"),
    body: parseJson(bytes),
  };
  return { bytes, observation };
}

export async function api(
  session,
  base,
  path,
  method = "GET",
  data,
  status = 200,
  label = method + " " + path,
) {
  const response = await session.context.request
    .fetch(base + "/api" + path, {
      method,
      headers: { Authorization: "Bearer " + session.token },
      ...(data === undefined ? {} : { data }),
    })
    .catch(() => {
      throw new Error("Reconciliation HTTP transport unavailable");
    });
  return observeResponse(session, response, label, status);
}

async function uiRefresh(session, detailSuffix, status, label) {
  const pending = session.page.waitForResponse(
    (response) =>
      response.url().endsWith(detailSuffix) &&
      response.request().method() === "GET",
  );
  await pmRegion(session.page)
    .getByRole("button", { name: "Refresh request access", exact: true })
    .click();
  const observed = await observeResponse(session, await pending, label, status);
  // The disclosure collector has read and continued the original response
  // before this returns; no request or response was fulfilled or rewritten.
  await session.capture.settle(session.page);
  return observed;
}

function assertIdentity(observation, customerId, subject, role) {
  assert.equal(observation.status, 200);
  assert.equal(observation.body.customerId, customerId);
  assert.equal(observation.body.subject, subject);
  assert(Array.isArray(observation.body.roles));
  assert(observation.body.roles.includes(role));
}

function collectForbiddenClaimKeys(value, path = "$", found = []) {
  if (Array.isArray(value))
    value.forEach((item, index) =>
      collectForbiddenClaimKeys(item, `${path}[${index}]`, found),
    );
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenClaimKey.test(key)) found.push(path + "." + key);
      collectForbiddenClaimKeys(child, path + "." + key, found);
    }
  return found;
}

function assertNoSettlementClaims(...values) {
  const found = values.flatMap((value) => collectForbiddenClaimKeys(value));
  assert.deepEqual(found, []);
}

function targetKey(targetKind, targetId) {
  return targetKind + ":" + targetId;
}

function assertCompleteAndThreeOpen(delivery, targets) {
  assert.equal(delivery.visibility, "available");
  assert.equal(delivery.revalidationRequired, false);
  assert.equal(delivery.historical, true);
  const result = delivery.result;
  assert.equal(result.status, "CONFLICTING");
  assert.equal(result.ruleRevision, ruleRevision);
  assert.equal(result.evaluations.length, 4);
  assert.equal(result.contributors.length, 4);
  const expected = new Map(
    targets.map((target) => [
      targetKey(target.targetKind, target.targetId),
      target.initialState,
    ]),
  );
  assert.equal(expected.size, 4);
  const seen = new Set();
  for (const evaluation of result.evaluations) {
    const key = targetKey(evaluation.targetKind, evaluation.targetId),
      state = expected.get(key);
    assert(state, "Unexpected reconciliation target");
    assert(!seen.has(key), "Duplicate reconciliation target");
    seen.add(key);
    assert(evaluation.binding);
    assert(evaluation.assessment);
    assert.equal(evaluation.assessment.status, "RESOLVED");
    assert.deepEqual(evaluation.assessment.resolvedValue, {
      type: "text",
      value: state,
    });
    assert.equal(evaluation.assessment.supportingVersionIds.length, 1);
    assert.equal(evaluation.assessment.supportingEvidenceIds.length, 1);
    assert.equal(evaluation.assessment.versions.length, 1);
    const version = evaluation.assessment.versions[0];
    assert.equal(version.visibility, "available");
    assert.equal(version.provenance, "HUMAN_CONFIRMED");
    assert.equal(version.assessment.provenance, "HUMAN_CONFIRMED");
    assert.equal(version.assessment.freshness, "CURRENT");
    assert.equal(version.assessment.conflict, "NONE");
  }
  assert.deepEqual(seen, new Set(expected.keys()));
  const contributorTargets = new Set(
    result.contributors.map((row) => targetKey(row.targetKind, row.targetId)),
  );
  assert.deepEqual(contributorTargets, new Set(expected.keys()));
  assert.equal(
    result.evaluations.filter(
      (row) =>
        row.targetKind === "MILESTONE" &&
        row.assessment.resolvedValue.value === "COMPLETE",
    ).length,
    1,
  );
  assert.equal(
    result.evaluations.filter(
      (row) =>
        row.targetKind === "WORK_ITEM" &&
        row.assessment.resolvedValue.value === "OPEN",
    ).length,
    3,
  );
}

async function assertPmProofUi(session) {
  const proof = pmRegion(session.page);
  await expect(proof.getByText(/CONFLICTING: a milestone/)).toBeVisible();
  await expect(proof.getByRole("article")).toHaveCount(4);
  await expect(
    proof.getByText("Value at capture: COMPLETE (text)", { exact: true }),
  ).toBeVisible();
  await expect(
    proof.getByText("Value at capture: OPEN (text)", { exact: true }),
  ).toHaveCount(3);
  await expect(proof.getByText(/Provenance: HUMAN_CONFIRMED/)).toHaveCount(4);
  await expect(proof.getByText(/Freshness: CURRENT/)).toHaveCount(4);
  await expect(proof.getByText(/Historical proof as of/)).toBeVisible();
  await expect(
    session.page.getByRole("button", {
      name: /acknowledge|approve|resolve|close|send|sent|mark.*read/i,
    }),
  ).toHaveCount(0);
  await session.capture.settle(session.page);
}

export async function changeSourceReaders(
  pmo,
  base,
  projectId,
  sourceId,
  state,
  readers,
  label,
) {
  const path = `/projects/${projectId}/fact-sources/${sourceId}/access`,
    before = await api(
      pmo,
      base,
      path,
      "GET",
      undefined,
      200,
      label + " before",
    ),
    input = {
      projectId,
      sourceId,
      expectedRevision: before.observation.body.revision,
      state,
      readers,
    },
    changed = await api(
      pmo,
      base,
      path,
      "POST",
      input,
      200,
      label + " command",
    ),
    after = await api(pmo, base, path, "GET", undefined, 200, label + " after");
  assert.equal(changed.observation.body.sourceId, sourceId);
  assert(changed.observation.body.revision > before.observation.body.revision);
  assert.equal(
    after.observation.body.revision,
    changed.observation.body.revision,
  );
  assert.equal(after.observation.body.state, state);
  assert.deepEqual(after.observation.body.readers, readers);
  return {
    before: before.observation,
    input,
    command: changed.observation,
    after: after.observation,
  };
}

export async function exerciseMilestoneReconciliationWorkflow({
  login,
  base,
  portfolioId,
  customerId,
  output,
}) {
  const sessions = new Set();
  let primaryError, result;
  const cleanupErrors = [];
  let operator, pmo, pmIdentity, pmProof;
  try {
    operator = await login("operator");
    sessions.add(operator);
    pmo = await login("pmo-atlas");
    sessions.add(pmo);
    pmIdentity = await login("pm-atlas");
    sessions.add(pmIdentity);
    const operatorMe = await api(
        operator,
        base,
        "/me",
        "GET",
        undefined,
        200,
        "OIDC operator identity",
      ),
      pmoMe = await api(
        pmo,
        base,
        "/me",
        "GET",
        undefined,
        200,
        "OIDC PMO identity",
      ),
      pmMe = await api(
        pmIdentity,
        base,
        "/me",
        "GET",
        undefined,
        200,
        "OIDC PM identity",
      );
    assertIdentity(
      operatorMe.observation,
      customerId,
      "operator",
      "system_admin",
    );
    assertIdentity(pmoMe.observation, customerId, "pmo-atlas", "pmo_admin");
    assertIdentity(pmMe.observation, customerId, "pm-atlas", "project_manager");
    assert.notEqual(
      pmoMe.observation.body.subject,
      pmMe.observation.body.subject,
    );

    const pmoGrantCommand = {
        subject: pmoMe.observation.body.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: "pmo_admin",
      },
      pmoGrant = await api(
        operator,
        base,
        "/access-grants",
        "POST",
        pmoGrantCommand,
        204,
        "operator grants PMO portfolio scope",
      );
    assert.equal(pmoGrant.bytes.length, 0);

    const input = canonicalFixture(portfolioId);
    input.name = "Synthetic PM reconciliation " + randomUUID().slice(0, 8);
    input.responsibilities = [
      {
        role: "PROJECT_MANAGER",
        subject: pmMe.observation.body.subject,
        displayName: "Configured acceptance PM",
      },
    ];
    input.workItems = [1, 2, 3].map((number) => ({
      ...input.workItems[0],
      key: "WI-" + number,
      title: "Mandatory synthetic work " + number,
      state: "OPEN",
    }));
    input.requiredWorkItems = [1, 2, 3].map((number) => ({
      milestoneKey: "MS-1",
      workItemKey: "WI-" + number,
    }));
    input.raidItems = [];
    input.sourceMappings = [];
    const created = await api(
      pmo,
      base,
      "/projects",
      "POST",
      input,
      201,
      "PMO canonical project creation",
    );
    const projectId = created.observation.body.id;
    assert.match(projectId, /^[0-9a-f-]{36}$/);
    const prefix = `/projects/${projectId}`;

    const pmGrantCommand = {
        subject: pmMe.observation.body.subject,
        scopeType: "project",
        scopeId: projectId,
        role: "project_manager",
      },
      pmGrant = await api(
        operator,
        base,
        "/access-grants",
        "POST",
        pmGrantCommand,
        204,
        "operator grants configured PM project scope",
      );
    assert.equal(pmGrant.bytes.length, 0);
    const canonical = await api(
      pmo,
      base,
      prefix + "/canonical",
      "GET",
      undefined,
      200,
      "created canonical project",
    );
    assert.equal(canonical.observation.body.id, projectId);
    assert.equal(canonical.observation.body.creation.by, "pmo-atlas");
    assert.deepEqual(
      canonical.observation.body.responsibilities.map(({ role, subject }) => ({
        role,
        subject,
      })),
      [{ role: "PROJECT_MANAGER", subject: "pm-atlas" }],
    );
    const milestone = canonical.observation.body.milestones.find(
      (row) => row.key === "MS-1",
    );
    assert(milestone);
    const links = canonical.observation.body.requiredWorkItems.filter(
      (row) => row.milestoneKey === "MS-1",
    );
    assert.equal(links.length, 3);
    const targets = [
      {
        targetKind: "MILESTONE",
        targetId: milestone.id,
        initialState: "COMPLETE",
      },
      ...links.map((link) => ({
        targetKind: "WORK_ITEM",
        targetId: canonical.observation.body.workItems.find(
          (row) => row.key === link.workItemKey,
        ).id,
        initialState: "OPEN",
      })),
    ];
    assert.equal(targets.length, 4);

    const effectiveAt = new Date(Date.now() - 3_600_000).toISOString(),
      validUntil = new Date(Date.now() + 86_400_000).toISOString(),
      bindings = [],
      policies = [],
      sharing = [];
    for (const target of targets) {
      const bindingCommand = {
        projectId,
        ...target,
        effectiveAt,
        validUntil,
        originalStatement: "Synthetic human-confirmed " + target.initialState,
        idempotencyKey: randomUUID(),
      };
      const bound = await api(
        pmo,
        base,
        prefix + "/state-bindings",
        "POST",
        bindingCommand,
        201,
        "human state binding " + targetKey(target.targetKind, target.targetId),
      );
      const binding = bound.observation.body;
      assert.equal(binding.targetKind, target.targetKind);
      assert.equal(binding.targetId, target.targetId);
      assert.equal(binding.entry.content.providedBy, "pmo-atlas");
      assert.equal(binding.entry.content.provenance, "HUMAN_CONFIRMED");
      assert.deepEqual(binding.entry.content.value, {
        type: "text",
        value: target.initialState,
      });
      const policyCommand = {
          projectId,
          factType: binding.factType,
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
        },
        policy = await api(
          pmo,
          base,
          prefix + "/authority-policies",
          "POST",
          policyCommand,
          201,
          "explicit authority policy " + binding.factType,
        );
      assert.equal(policy.observation.body.event.recordedBy, "pmo-atlas");
      assert.equal(policy.observation.body.event.state, "ENABLED");
      const access = await changeSourceReaders(
        pmo,
        base,
        projectId,
        binding.entry.sourceId,
        "AVAILABLE",
        ["pm-atlas", "pmo-atlas"],
        "explicit source sharing " + binding.entry.sourceId,
      );
      bindings.push({ command: bindingCommand, response: bound.observation });
      policies.push({ command: policyCommand, response: policy.observation });
      sharing.push(access);
    }

    const checkCommand = {
        projectId,
        milestoneId: milestone.id,
        enabled: true,
        ruleRevision,
        idempotencyKey: randomUUID(),
      },
      checked = await api(
        pmo,
        base,
        prefix + "/milestone-reconciliation-checks",
        "POST",
        checkCommand,
        201,
        "PMO reconciliation check",
      );
    assert.equal(checked.observation.body.outcome, "CREATED");
    assert.equal(checked.observation.body.replayed, false);
    assert.equal(checked.observation.body.request.state, "OPEN");
    assert.equal(
      checked.observation.body.request.assignment.recipientSubject,
      "pm-atlas",
    );
    assertCompleteAndThreeOpen(checked.observation.body.assessment, targets);
    assertNoSettlementClaims(checked.observation.body);
    const requestId = checked.observation.body.request.id,
      detailSuffix = `${prefix}/reconciliation-requests/${requestId}`;
    const managementQueue = await api(
        pmo,
        base,
        prefix + "/reconciliation-requests/manage",
        "GET",
        undefined,
        200,
        "PMO metadata queue",
      ),
      recipientQueue = await api(
        pmIdentity,
        base,
        prefix + "/reconciliation-requests",
        "GET",
        undefined,
        200,
        "PM recipient queue",
      );
    assert.deepEqual(managementQueue.observation.body.requests, [
      checked.observation.body.request,
    ]);
    assert.deepEqual(recipientQueue.observation.body.requests, [
      checked.observation.body.request,
    ]);
    assertNoSettlementClaims(
      managementQueue.observation.body,
      recipientQueue.observation.body,
    );

    pmProof = await login(
      "pm-atlas",
      `/?project=${projectId}&reconciliation=${requestId}`,
      "reconciliation",
      "/api" + detailSuffix,
    );
    sessions.add(pmProof);
    assert(pmProof.initialResponse);
    const original = await observeResponse(
      pmProof,
      pmProof.initialResponse,
      "original saved-link PM proof response",
      200,
    );
    await pmProof.capture.settle(pmProof.page);
    await assertPmProofUi(pmProof);
    assert.deepEqual(
      original.observation.body.request,
      checked.observation.body.request,
    );
    assert.deepEqual(
      original.observation.body.assessment,
      checked.observation.body.assessment,
    );
    assertCompleteAndThreeOpen(original.observation.body.assessment, targets);
    assertNoSettlementClaims(original.observation.body);
    const screenshotBytes = await pmProof.page.screenshot({
      path: output + "/milestone-reconciliation-pm-proof.png",
      fullPage: true,
    });

    const withdrawal = await changeSourceReaders(
      pmo,
      base,
      projectId,
      bindings[3].response.body.entry.sourceId,
      "REVOKED",
      ["pmo-atlas"],
      "PM proof source withdrawal",
    );
    const restricted = await uiRefresh(
      pmProof,
      "/api" + detailSuffix,
      200,
      "PM proof after source withdrawal",
    );
    assert.deepEqual(
      restricted.observation.body.request,
      original.observation.body.request,
    );
    assert.equal(
      restricted.observation.body.assessment.visibility,
      "restricted",
    );
    assert.equal(
      restricted.observation.body.assessment.revalidationRequired,
      true,
    );
    assert.equal(restricted.observation.body.assessment.result, null);
    for (const key of [
      "assessmentId",
      "projectId",
      "milestoneId",
      "asOf",
      "historical",
      "replayed",
    ])
      assert.equal(
        restricted.observation.body.assessment[key],
        original.observation.body.assessment[key],
      );
    assert.deepEqual(
      Object.keys(restricted.observation.body.assessment).sort(),
      [
        "asOf",
        "assessmentId",
        "historical",
        "milestoneId",
        "projectId",
        "replayed",
        "result",
        "revalidationRequired",
        "visibility",
      ],
    );
    await expect(
      pmRegion(pmProof.page).getByText(/Proof withheld/),
    ).toBeVisible();
    await expect(pmRegion(pmProof.page).getByRole("article")).toHaveCount(0);

    const regrant = await changeSourceReaders(
      pmo,
      base,
      projectId,
      bindings[3].response.body.entry.sourceId,
      "AVAILABLE",
      ["pm-atlas", "pmo-atlas"],
      "PM proof source regrant",
    );
    const availableAgain = await uiRefresh(
      pmProof,
      "/api" + detailSuffix,
      200,
      "PM proof after source regrant",
    );
    assert.equal(Buffer.compare(availableAgain.bytes, original.bytes), 0);
    assert.deepEqual(
      availableAgain.observation.body,
      original.observation.body,
    );
    await assertPmProofUi(pmProof);

    result = {
      projectId,
      requestId,
      detailSuffix,
      receipt: {
        status: "awaiting-recreation",
        projectId,
        requestId,
        milestoneId: milestone.id,
        ruleRevision,
        identities: {
          operator: operatorMe.observation,
          creator: pmoMe.observation,
          recipient: pmMe.observation,
        },
        authorizationSetup: {
          creatorPortfolioGrant: {
            command: pmoGrantCommand,
            response: pmoGrant.observation,
          },
          recipientProjectGrant: {
            command: pmGrantCommand,
            response: pmGrant.observation,
          },
        },
        canonical: {
          command: input,
          creation: created.observation,
          detail: canonical.observation,
        },
        targets,
        bindings,
        policies,
        sharing,
        check: { command: checkCommand, response: checked.observation },
        queues: {
          management: managementQueue.observation,
          recipient: recipientQueue.observation,
        },
        originalProof: original.observation,
        sourceWithdrawal: {
          access: withdrawal,
          proof: restricted.observation,
        },
        sourceRegrant: {
          access: regrant,
          proof: availableAgain.observation,
        },
        screenshot: {
          file: "milestone-reconciliation-pm-proof.png",
          sha256: sha256(screenshotBytes),
        },
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const session of [...sessions].reverse())
      try {
        await closeCustomerBrowserSession(session, base);
      } catch (error) {
        cleanupErrors.push(error);
      }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      "Reconciliation browser cleanup failed",
      { cause: primaryError ?? cleanupErrors[0] },
    );
  if (primaryError) throw primaryError;
  return result;
}

export async function openSavedMilestoneReconciliation({
  login,
  base,
  fixture,
  output,
}) {
  const session = await login(
    "pm-atlas",
    `/?project=${fixture.projectId}&reconciliation=${fixture.requestId}`,
    "reconciliation",
    "/api" + fixture.detailSuffix,
  );
  try {
    assert(session.initialResponse);
    const recreated = await observeResponse(
      session,
      session.initialResponse,
      "saved-link PM proof response after application recreation",
      200,
    );
    await session.capture.settle(session.page);
    await assertPmProofUi(session);
    const currentPm = await api(
      session,
      base,
      "/me",
      "GET",
      undefined,
      200,
      "OIDC PM identity after application recreation",
    );
    assertIdentity(
      currentPm.observation,
      fixture.receipt.identities.recipient.body.customerId,
      "pm-atlas",
      "project_manager",
    );
    const originalBytes = Buffer.from(
      fixture.receipt.originalProof.bodyBase64,
      "base64",
    );
    assert(originalBytes.length > 0);
    assert.equal(Buffer.compare(recreated.bytes, originalBytes), 0);
    assert.deepEqual(
      recreated.observation.body,
      fixture.receipt.originalProof.body,
    );
    assertNoSettlementClaims(recreated.observation.body);
    const screenshot = await session.page.screenshot({
      path: output + "/milestone-reconciliation-pm-proof-recreated.png",
      fullPage: true,
    });
    return {
      session,
      identity: currentPm.observation,
      observation: recreated.observation,
      screenshot: {
        file: "milestone-reconciliation-pm-proof-recreated.png",
        sha256: sha256(screenshot),
      },
    };
  } catch (error) {
    try {
      await closeCustomerBrowserSession(session, base);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Reconciliation saved-link cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function verifyMilestoneReconciliationProjectWithdrawal({
  operator,
  saved,
  base,
  fixture,
  output,
}) {
  let primaryError, cleanupError, result;
  try {
    const operatorMe = await api(
      operator,
      base,
      "/me",
      "GET",
      undefined,
      200,
      "OIDC operator identity before PM-scope withdrawal",
    );
    assertIdentity(
      operatorMe.observation,
      fixture.receipt.identities.operator.body.customerId,
      "operator",
      "system_admin",
    );
    const revocationCommand = {
        subject: "pm-atlas",
        scopeType: "project",
        scopeId: fixture.projectId,
      },
      revoked = await api(
        operator,
        base,
        "/access-grants",
        "DELETE",
        revocationCommand,
        204,
        "operator withdraws PM project scope",
      );
    assert.equal(revoked.bytes.length, 0);
    const uiDenied = await uiRefresh(
      saved.session,
      "/api" + fixture.detailSuffix,
      404,
      "saved PM proof after project-scope withdrawal",
    );
    const directDenied = await api(
      saved.session,
      base,
      fixture.detailSuffix,
      "GET",
      undefined,
      404,
      "direct PM proof denial after project-scope withdrawal",
    );
    assert.equal(Buffer.compare(uiDenied.bytes, directDenied.bytes), 0);
    await expect(pmRegion(saved.session.page).getByRole("alert")).toBeVisible();
    await expect(pmRegion(saved.session.page).getByRole("article")).toHaveCount(
      0,
    );
    await expect(
      saved.session.page.getByText("Value at capture: COMPLETE (text)", {
        exact: true,
      }),
    ).toHaveCount(0);
    const deniedScreenshot = await saved.session.page.screenshot({
      path: output + "/milestone-reconciliation-pm-scope-denied.png",
      fullPage: true,
    });
    result = {
      ...fixture.receipt,
      status: "passed",
      recreatedProof: {
        identity: saved.identity,
        proof: saved.observation,
        screenshot: saved.screenshot,
      },
      projectScopeWithdrawal: {
        operator: operatorMe.observation,
        command: {
          input: revocationCommand,
          response: revoked.observation,
        },
        uiDenial: uiDenied.observation,
        directDenial: directDenied.observation,
        screenshot: {
          file: "milestone-reconciliation-pm-scope-denied.png",
          sha256: sha256(deniedScreenshot),
        },
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await closeCustomerBrowserSession(saved.session, base);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) {
    if (primaryError)
      throw new AggregateError(
        [primaryError, cleanupError],
        "Reconciliation PM withdrawal cleanup failed",
        { cause: primaryError },
      );
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return result;
}
