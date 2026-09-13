// AC-EVD-004 / NFR-REL-002: pure host-side receipt validator; no browser/package/database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
// Exact keys only: resolvedValue and approvalStateAsOf are proof semantics and
// must remain valid; only workflow settlement/delivery claims are forbidden.
const forbiddenClaimKey =
  /^(?:acknowledged|acknowledgement|read|readAt|readReceipt|sent|sentAt|delivered|deliveredAt|closed|closedAt|resolved|resolvedAt|approved|approvedAt|message|messageId)$/i;

function response(value, status) {
  assert.equal(value.status, status);
  assert(Number.isInteger(value.bytes) && value.bytes >= 0);
  assert.match(value.sha256, digest);
  assert.equal(typeof value.bodyBase64, "string");
  const bytes = Buffer.from(value.bodyBase64, "base64");
  assert.equal(bytes.toString("base64"), value.bodyBase64);
  assert.equal(bytes.length, value.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), value.sha256);
  if (status === 204) {
    assert.equal(bytes.length, 0);
    assert.equal(value.body, null);
  } else {
    assert(value.body && typeof value.body === "object");
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), value.body);
  }
}

function forbidden(value, path = "$", found = []) {
  if (Array.isArray(value))
    value.forEach((child, index) =>
      forbidden(child, `${path}[${index}]`, found),
    );
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenClaimKey.test(key)) found.push(path + "." + key);
      forbidden(child, path + "." + key, found);
    }
  return found;
}

function targetKey(row) {
  return row.targetKind + ":" + row.targetId;
}

function one(rows, predicate) {
  const matches = rows.filter(predicate);
  assert.equal(matches.length, 1);
  return matches[0];
}

function proof(delivery, targets, bindings, scope) {
  assert.equal(delivery.visibility, "available");
  assert.equal(delivery.revalidationRequired, false);
  assert.equal(delivery.historical, true);
  assert.equal(delivery.replayed, false);
  assert.equal(delivery.projectId, scope.projectId);
  assert.equal(delivery.milestoneId, scope.milestoneId);
  assert.equal(delivery.result.status, "CONFLICTING");
  assert.equal(delivery.result.ruleRevision, "milestone-required-state/v1");
  assert.deepEqual(delivery.result.scope, scope);
  assert.equal(delivery.result.asOf, delivery.asOf);
  assert.equal(delivery.result.evaluations.length, 4);
  assert.equal(delivery.result.contributors.length, 4);
  assert.equal(delivery.result.dependencies.length, 4);
  const expected = new Map(
      targets.map((target, index) => [
        targetKey(target),
        { target, binding: bindings[index], state: target.initialState },
      ]),
    ),
    seen = new Set();
  assert.equal(expected.size, 4);
  for (const evaluation of delivery.result.evaluations) {
    const key = targetKey(evaluation),
      expectedTarget = expected.get(key);
    assert(expectedTarget);
    assert(!seen.has(key));
    seen.add(key);
    assert(evaluation.binding);
    assert(evaluation.assessment);
    const bound = expectedTarget.binding.response.body,
      versionId = bound.entry.id,
      evidenceId = bound.entry.evidenceId,
      contributor = one(
        delivery.result.contributors,
        (row) => targetKey(row) === key,
      ),
      dependency = one(
        delivery.result.dependencies,
        (row) => row.bindingId === bound.id,
      );
    assert.deepEqual(evaluation.binding, {
      id: bound.id,
      customerId: scope.customerId,
      projectId: scope.projectId,
      targetKind: expectedTarget.target.targetKind,
      targetId: expectedTarget.target.targetId,
      field: "state",
      factId: bound.factId,
      factType: bound.factType,
    });
    assert.deepEqual(evaluation.assessment.scope, {
      customerId: scope.customerId,
      projectId: scope.projectId,
      factId: bound.factId,
      factType: bound.factType,
    });
    assert.equal(evaluation.assessment.status, "RESOLVED");
    assert.deepEqual(evaluation.assessment.resolvedValue, {
      type: "text",
      value: expectedTarget.state,
    });
    assert.deepEqual(evaluation.assessment.supportingVersionIds, [versionId]);
    assert.deepEqual(evaluation.assessment.supportingEvidenceIds, [evidenceId]);
    assert.equal(evaluation.assessment.versions.length, 1);
    const version = evaluation.assessment.versions[0];
    assert.equal(version.id, versionId);
    assert.deepEqual(version.evidenceIds, [evidenceId]);
    assert.equal(version.visibility, "available");
    assert.equal(version.provenance, "HUMAN_CONFIRMED");
    assert.equal(version.assessment.provenance, "HUMAN_CONFIRMED");
    assert.equal(version.assessment.freshness, "CURRENT");
    assert.equal(version.assessment.conflict, "NONE");
    assert.deepEqual(contributor, {
      targetKind: expectedTarget.target.targetKind,
      targetId: expectedTarget.target.targetId,
      bindingId: bound.id,
      factId: bound.factId,
      factType: bound.factType,
      supportingVersionIds: [versionId],
      supportingEvidenceIds: [evidenceId],
    });
    assert.deepEqual(dependency, {
      bindingId: bound.id,
      factId: bound.factId,
      versionIds: [versionId],
      evidenceIds: [evidenceId],
    });
  }
  assert.deepEqual(seen, new Set(expected.keys()));
  assert.deepEqual(
    new Set(delivery.result.contributors.map(targetKey)),
    new Set(expected.keys()),
  );
}

function access(
  receipt,
  projectId,
  sourceId,
  beforeState,
  beforeReaders,
  state,
  readers,
) {
  response(receipt.before, 200);
  response(receipt.command, 200);
  response(receipt.after, 200);
  assert.equal(receipt.before.body.sourceId, sourceId);
  assert.equal(receipt.before.body.state, beforeState);
  assert.deepEqual(receipt.before.body.readers, beforeReaders);
  assert.deepEqual(receipt.input, {
    projectId,
    sourceId,
    expectedRevision: receipt.before.body.revision,
    state,
    readers,
  });
  assert.equal(receipt.command.body.sourceId, sourceId);
  assert.equal(receipt.after.body.sourceId, sourceId);
  assert(receipt.command.body.revision > receipt.before.body.revision);
  assert.equal(receipt.after.body.revision, receipt.command.body.revision);
  assert.equal(receipt.after.body.state, state);
  assert.deepEqual(receipt.after.body.readers, readers);
}

export function assertMilestoneReconciliationWorkflowReceipt(
  value,
  { expectedCustomerId } = {},
) {
  assert.equal(value.status, "passed");
  assert.match(value.projectId, uuid);
  assert.match(value.requestId, uuid);
  assert.match(value.milestoneId, uuid);
  assert.equal(value.ruleRevision, "milestone-required-state/v1");
  for (const [name, subject, role] of [
    ["operator", "operator", "system_admin"],
    ["creator", "pmo-atlas", "pmo_admin"],
    ["recipient", "pm-atlas", "project_manager"],
  ]) {
    response(value.identities[name], 200);
    assert.equal(value.identities[name].body.subject, subject);
    assert(value.identities[name].body.roles.includes(role));
  }
  assert.notEqual(
    value.identities.creator.body.subject,
    value.identities.recipient.body.subject,
  );
  const customerId = value.identities.creator.body.customerId;
  assert.match(customerId, uuid);
  if (expectedCustomerId !== undefined) {
    assert.match(expectedCustomerId, uuid);
    assert.equal(customerId, expectedCustomerId);
  }
  assert.equal(value.identities.operator.body.customerId, customerId);
  assert.equal(value.identities.recipient.body.customerId, customerId);
  assert.deepEqual(value.authorizationSetup.creatorPortfolioGrant.command, {
    subject: "pmo-atlas",
    scopeType: "portfolio",
    scopeId: value.canonical.command.portfolioId,
    role: "pmo_admin",
  });
  response(value.authorizationSetup.creatorPortfolioGrant.response, 204);
  assert.deepEqual(value.authorizationSetup.recipientProjectGrant.command, {
    subject: "pm-atlas",
    scopeType: "project",
    scopeId: value.projectId,
    role: "project_manager",
  });
  response(value.authorizationSetup.recipientProjectGrant.response, 204);
  response(value.canonical.creation, 201);
  response(value.canonical.detail, 200);
  assert.equal(value.canonical.creation.body.id, value.projectId);
  assert.equal(value.canonical.detail.body.id, value.projectId);
  assert.equal(value.canonical.detail.body.creation.by, "pmo-atlas");
  assert.deepEqual(
    value.canonical.detail.body.responsibilities.map(({ role, subject }) => ({
      role,
      subject,
    })),
    [{ role: "PROJECT_MANAGER", subject: "pm-atlas" }],
  );
  const canonicalMilestone = one(
      value.canonical.detail.body.milestones,
      (row) => row.id === value.milestoneId,
    ),
    requiredLinks = value.canonical.detail.body.requiredWorkItems.filter(
      (row) => row.milestoneKey === canonicalMilestone.key,
    );
  assert.equal(requiredLinks.length, 3);
  const expectedTargets = [
    {
      targetKind: "MILESTONE",
      targetId: canonicalMilestone.id,
      initialState: "COMPLETE",
    },
    ...requiredLinks.map((link) => ({
      targetKind: "WORK_ITEM",
      targetId: one(
        value.canonical.detail.body.workItems,
        (row) => row.key === link.workItemKey,
      ).id,
      initialState: "OPEN",
    })),
  ];
  assert.deepEqual(value.targets, expectedTargets);
  assert.equal(value.bindings.length, 4);
  assert.equal(value.policies.length, 4);
  assert.equal(value.sharing.length, 4);
  const bindingIds = new Set(),
    factIds = new Set(),
    versionIds = new Set(),
    evidenceIds = new Set();
  for (let index = 0; index < 4; index++) {
    const binding = value.bindings[index],
      policy = value.policies[index],
      target = value.targets[index];
    response(binding.response, 201);
    response(policy.response, 201);
    assert.equal(binding.command.projectId, value.projectId);
    assert.equal(binding.command.targetKind, target.targetKind);
    assert.equal(binding.command.targetId, target.targetId);
    assert.equal(binding.command.initialState, target.initialState);
    assert.equal(binding.response.body.targetKind, target.targetKind);
    assert.equal(binding.response.body.targetId, target.targetId);
    assert.equal(binding.response.body.projectId, value.projectId);
    assert.match(binding.response.body.id, uuid);
    assert.match(binding.response.body.factId, uuid);
    assert.match(binding.response.body.entry.id, uuid);
    assert.match(binding.response.body.entry.evidenceId, uuid);
    bindingIds.add(binding.response.body.id);
    factIds.add(binding.response.body.factId);
    versionIds.add(binding.response.body.entry.id);
    evidenceIds.add(binding.response.body.entry.evidenceId);
    assert.deepEqual(binding.response.body.entry.content.evidenceIds, [
      binding.response.body.entry.evidenceId,
    ]);
    assert.equal(binding.response.body.entry.content.providedBy, "pmo-atlas");
    assert.equal(
      binding.response.body.entry.content.provenance,
      "HUMAN_CONFIRMED",
    );
    assert.deepEqual(binding.response.body.entry.content.value, {
      type: "text",
      value: target.initialState,
    });
    assert.equal(policy.command.projectId, value.projectId);
    assert.equal(policy.command.factType, binding.response.body.factType);
    assert.equal(policy.command.expectedRevision, 0);
    assert.equal(policy.response.body.event.recordedBy, "pmo-atlas");
    assert.equal(policy.response.body.event.state, "ENABLED");
    assert.deepEqual(
      policy.response.body.event.definition,
      policy.command.definition,
    );
    access(
      value.sharing[index],
      value.projectId,
      binding.response.body.entry.sourceId,
      "AVAILABLE",
      ["pmo-atlas"],
      "AVAILABLE",
      ["pm-atlas", "pmo-atlas"],
    );
  }
  assert.equal(bindingIds.size, 4);
  assert.equal(factIds.size, 4);
  assert.equal(versionIds.size, 4);
  assert.equal(evidenceIds.size, 4);
  response(value.check.response, 201);
  assert.deepEqual(
    {
      projectId: value.check.command.projectId,
      milestoneId: value.check.command.milestoneId,
      enabled: value.check.command.enabled,
      ruleRevision: value.check.command.ruleRevision,
    },
    {
      projectId: value.projectId,
      milestoneId: value.milestoneId,
      enabled: true,
      ruleRevision: value.ruleRevision,
    },
  );
  assert.equal(value.check.response.body.outcome, "CREATED");
  assert.match(value.check.response.body.assessment.assessmentId, uuid);
  assert.equal(value.check.response.body.assessment.projectId, value.projectId);
  assert.equal(
    value.check.response.body.assessment.milestoneId,
    value.milestoneId,
  );
  assert.equal(value.check.response.body.request.id, value.requestId);
  assert.equal(value.check.response.body.request.projectId, value.projectId);
  assert.equal(
    value.check.response.body.request.milestoneId,
    value.milestoneId,
  );
  assert.equal(value.check.response.body.request.state, "OPEN");
  assert.equal(
    value.check.response.body.request.assignment.recipientSubject,
    "pm-atlas",
  );
  assert.equal(
    value.check.response.body.assessment.result.status,
    "CONFLICTING",
  );
  assert.equal(
    value.check.response.body.assessment.result.evaluations.length,
    4,
  );
  assert.equal(
    value.check.response.body.assessment.result.contributors.length,
    4,
  );
  const reconciliationScope = {
    customerId,
    projectId: value.projectId,
    milestoneId: value.milestoneId,
  };
  assert.equal(value.check.response.body.replayed, false);
  proof(
    value.check.response.body.assessment,
    value.targets,
    value.bindings,
    reconciliationScope,
  );
  response(value.queues.management, 200);
  response(value.queues.recipient, 200);
  assert.deepEqual(value.queues.management.body.requests, [
    value.check.response.body.request,
  ]);
  assert.deepEqual(value.queues.recipient.body.requests, [
    value.check.response.body.request,
  ]);
  response(value.originalProof, 200);
  assert.deepEqual(Object.keys(value.originalProof.body).sort(), [
    "assessment",
    "request",
  ]);
  assert.deepEqual(
    value.originalProof.body.request,
    value.check.response.body.request,
  );
  assert.deepEqual(
    value.originalProof.body.assessment,
    value.check.response.body.assessment,
  );
  proof(
    value.originalProof.body.assessment,
    value.targets,
    value.bindings,
    reconciliationScope,
  );
  response(value.sourceWithdrawal.proof, 200);
  access(
    value.sourceWithdrawal.access,
    value.projectId,
    value.bindings[3].response.body.entry.sourceId,
    "AVAILABLE",
    ["pm-atlas", "pmo-atlas"],
    "REVOKED",
    ["pmo-atlas"],
  );
  assert.deepEqual(
    value.sourceWithdrawal.proof.body.request,
    value.originalProof.body.request,
  );
  assert.deepEqual(Object.keys(value.sourceWithdrawal.proof.body).sort(), [
    "assessment",
    "request",
  ]);
  assert.equal(
    value.sourceWithdrawal.proof.body.assessment.visibility,
    "restricted",
  );
  assert.equal(
    value.sourceWithdrawal.proof.body.assessment.revalidationRequired,
    true,
  );
  assert.equal(value.sourceWithdrawal.proof.body.assessment.result, null);
  for (const key of [
    "assessmentId",
    "projectId",
    "milestoneId",
    "asOf",
    "historical",
    "replayed",
  ])
    assert.equal(
      value.sourceWithdrawal.proof.body.assessment[key],
      value.originalProof.body.assessment[key],
    );
  assert.deepEqual(
    Object.keys(value.sourceWithdrawal.proof.body.assessment).sort(),
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
  response(value.sourceRegrant.proof, 200);
  access(
    value.sourceRegrant.access,
    value.projectId,
    value.bindings[3].response.body.entry.sourceId,
    "REVOKED",
    ["pmo-atlas"],
    "AVAILABLE",
    ["pm-atlas", "pmo-atlas"],
  );
  assert.deepEqual(value.sourceRegrant.proof.body, value.originalProof.body);
  assert.equal(value.sourceRegrant.proof.bytes, value.originalProof.bytes);
  assert.equal(value.sourceRegrant.proof.sha256, value.originalProof.sha256);
  assert.equal(
    value.sourceRegrant.proof.bodyBase64,
    value.originalProof.bodyBase64,
  );
  proof(
    value.sourceRegrant.proof.body.assessment,
    value.targets,
    value.bindings,
    reconciliationScope,
  );
  response(value.recreatedProof.identity, 200);
  assert.deepEqual(
    value.recreatedProof.identity.body,
    value.identities.recipient.body,
  );
  response(value.recreatedProof.proof, 200);
  assert.deepEqual(value.recreatedProof.proof.body, value.originalProof.body);
  assert.equal(value.recreatedProof.proof.bytes, value.originalProof.bytes);
  assert.equal(value.recreatedProof.proof.sha256, value.originalProof.sha256);
  assert.equal(
    value.recreatedProof.proof.bodyBase64,
    value.originalProof.bodyBase64,
  );
  proof(
    value.recreatedProof.proof.body.assessment,
    value.targets,
    value.bindings,
    reconciliationScope,
  );
  for (const screenshot of [
    value.screenshot,
    value.recreatedProof.screenshot,
  ]) {
    assert.match(screenshot.sha256, digest);
    assert.match(
      screenshot.file,
      /^milestone-reconciliation-pm-proof(?:-recreated)?\.png$/,
    );
  }
  assert.equal(value.screenshot.file, "milestone-reconciliation-pm-proof.png");
  assert.equal(
    value.recreatedProof.screenshot.file,
    "milestone-reconciliation-pm-proof-recreated.png",
  );
  response(value.projectScopeWithdrawal.operator, 200);
  assert.deepEqual(value.projectScopeWithdrawal.command.input, {
    subject: "pm-atlas",
    scopeType: "project",
    scopeId: value.projectId,
  });
  response(value.projectScopeWithdrawal.command.response, 204);
  response(value.projectScopeWithdrawal.uiDenial, 404);
  response(value.projectScopeWithdrawal.directDenial, 404);
  const denial = { statusCode: 404, message: "Resource unavailable" };
  assert.deepEqual(value.projectScopeWithdrawal.uiDenial.body, denial);
  assert.deepEqual(value.projectScopeWithdrawal.directDenial.body, denial);
  assert.equal(
    value.projectScopeWithdrawal.uiDenial.bodyBase64,
    value.projectScopeWithdrawal.directDenial.bodyBase64,
  );
  assert.match(value.projectScopeWithdrawal.screenshot.sha256, digest);
  assert.equal(
    value.projectScopeWithdrawal.screenshot.file,
    "milestone-reconciliation-pm-scope-denied.png",
  );
  assert.equal(
    value.projectScopeWithdrawal.operator.body.subject,
    value.identities.operator.body.subject,
  );
  assert.deepEqual(
    value.projectScopeWithdrawal.operator.body,
    value.identities.operator.body,
  );
  assert.deepEqual(forbidden(value.check.response.body), []);
  assert.deepEqual(forbidden(value.queues.management.body), []);
  assert.deepEqual(forbidden(value.queues.recipient.body), []);
  assert.deepEqual(forbidden(value.originalProof.body), []);
  assert.deepEqual(forbidden(value.sourceWithdrawal.proof.body), []);
  assert.deepEqual(forbidden(value.recreatedProof.proof.body), []);
}
