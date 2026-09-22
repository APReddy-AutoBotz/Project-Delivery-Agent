// FR-EVD-004/007/009/012, NFR-REL-002: independent, fail-closed host reader.
import assert from "node:assert/strict";
import { response } from "./milestone-reconciliation-workflow-receipt.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const forbidden =
  /^(?:acknowledged|acknowledgement|read|readAt|readReceipt|sent|sentAt|delivered|deliveredAt|closed|closedAt|resolved|resolvedAt|approved|approvedAt|message|messageId|token|access_token|authorization)$/i;
function noSettlement(value) {
  // The fixed denial envelope is transport metadata, not a sent message claim.
  if (
    value?.statusCode === 404 &&
    value?.message === "Resource unavailable" &&
    Object.keys(value).length === 2
  )
    return;
  if (Array.isArray(value)) value.forEach(noSettlement);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      assert(
        !forbidden.test(key),
        "Unexpected workflow settlement or credential",
      );
      noSettlement(child);
    }
}
function image(value, file) {
  assert.equal(value.file, file);
  assert.match(value.sha256, /^[a-f0-9]{64}$/);
}
function identity(observed, customerId, subject, role) {
  response(observed, 200);
  assert.equal(observed.body.customerId, customerId);
  assert.equal(observed.body.subject, subject);
  assert(observed.body.roles.includes(role));
}
function access(value, sourceId, projectId, readers) {
  response(value.before, 200);
  response(value.command, 200);
  response(value.after, 200);
  assert.equal(value.input.sourceId, sourceId);
  assert.equal(value.input.projectId, projectId);
  assert.equal(value.input.expectedRevision, value.before.body.revision);
  assert.equal(value.input.state, "AVAILABLE");
  assert.deepEqual(value.input.readers, readers);
  for (const observed of [value.before, value.command, value.after])
    assert.equal(observed.body.sourceId, sourceId);
  assert(value.command.body.revision > value.before.body.revision);
  assert.equal(value.after.body.revision, value.command.body.revision);
  assert.equal(value.after.body.state, "AVAILABLE");
  assert.deepEqual(value.after.body.readers, readers);
}
export function assertScalarWorkflowReceipt(
  value,
  { expectedCustomerId, expectedProfile, expectedRunId, expectedProjectId },
) {
  assert.equal(value.family, "scalar-browser-workflow/v1");
  assert.equal(value.status, "passed");
  assert(["bundled", "external"].includes(expectedProfile));
  assert.match(expectedRunId, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
  assert.equal(value.profile, expectedProfile);
  assert.equal(value.runId, expectedRunId);
  assert.match(expectedCustomerId, uuid);
  assert.match(expectedProjectId, uuid);
  assert.equal(value.projectId, expectedProjectId);
  for (const id of [value.projectId, value.factId]) assert.match(id, uuid);
  assert.equal(value.factType, "project.forecast");
  identity(
    value.identities.creator,
    expectedCustomerId,
    "pmo-atlas",
    "pmo_admin",
  );
  identity(
    value.identities.recipient,
    expectedCustomerId,
    "pm-atlas",
    "project_manager",
  );
  assert.equal(value.statements.length, 2);
  assert.equal(value.sharing.length, 2);
  const sources = new Set(),
    versions = new Set();
  value.statements.forEach(({ input, response: observed }, index) => {
    response(observed, 201);
    assert.equal(input.projectId, value.projectId);
    assert.equal(input.factType, value.factType);
    assert.equal(input.expectedRevision, index);
    assert.match(input.idempotencyKey, uuid);
    assert.deepEqual(input.value, {
      type: "text",
      value: "Packaged scalar forecast " + (index === 0 ? "A" : "B"),
    });
    assert.equal(input.originalStatement, input.value.value);
    assert.equal(observed.body.factId, value.factId);
    const entry = observed.body.entry;
    assert.equal(entry.revision, index + 1);
    assert.equal(
      entry.content.providedBy,
      index === 0 ? "pmo-atlas" : "pm-atlas",
    );
    assert.equal(entry.content.provenance, "HUMAN_CONFIRMED");
    assert.deepEqual(entry.content.value, input.value);
    for (const id of [entry.id, entry.evidenceId, entry.sourceId])
      assert.match(id, uuid);
    sources.add(entry.sourceId);
    versions.add(entry.id);
    access(value.sharing[index], entry.sourceId, value.projectId, [
      "pm-atlas",
      "pmo-atlas",
    ]);
  });
  assert.equal(sources.size, 2);
  assert.equal(versions.size, 2);
  response(value.policy.response, 201);
  assert.equal(value.policy.input.projectId, value.projectId);
  assert.equal(value.policy.input.factType, value.factType);
  assert.equal(value.policy.input.expectedRevision, 0);
  assert.equal(
    value.policy.input.definition.conflictBehavior,
    "REQUEST_RECONCILIATION",
  );
  assert.equal(value.policy.response.body.event.state, "ENABLED");
  assert.equal(value.policy.response.body.event.recordedBy, "pmo-atlas");
  function proof(delivery) {
    assert.equal(delivery.visibility, "available");
    assert.equal(delivery.revalidationRequired, false);
    assert.equal(delivery.historical, true);
    assert.equal(delivery.replayed, false);
    assert.equal(delivery.factId, value.factId);
    assert.match(delivery.assessmentId, uuid);
    const result = delivery.result;
    assert.equal(result.policy.revisionId, value.policy.response.body.event.id);
    assert.equal(result.asOf, delivery.asOf);
    assert.deepEqual(result.scope, {
      customerId: expectedCustomerId,
      projectId: value.projectId,
      factId: value.factId,
      factType: value.factType,
    });
    assert.equal(result.status, "CONFLICTING");
    assert.equal(result.complete, true);
    assert.equal(result.revalidationRequired, false);
    assert.equal(result.reconciliationRequired, true);
    assert.equal(result.resolvedValue, null);
    assert.equal(result.versions.length, 2);
    assert.deepEqual(new Set(result.versions.map((row) => row.id)), versions);
    for (const row of result.versions) {
      const entry = value.statements.find(
        (item) => item.response.body.entry.id === row.id,
      ).response.body.entry;
      assert.equal(row.visibility, "available");
      assert.deepEqual(row.value, entry.content.value);
      assert.deepEqual(row.evidenceIds, [entry.evidenceId]);
      assert.equal(row.provenance, "HUMAN_CONFIRMED");
      assert.equal(row.assessment.provenance, "HUMAN_CONFIRMED");
      assert.equal(row.assessment.freshness, "CURRENT");
      assert.equal(row.assessment.conflict, "CONFLICTING");
    }
  }
  const created = value.created,
    reused = value.reused;
  for (const command of [created, reused]) {
    assert.deepEqual(Object.keys(command.input).sort(), [
      "factId",
      "idempotencyKey",
    ]);
    assert.equal(command.input.factId, value.factId);
    assert.match(command.input.idempotencyKey, uuid);
    response(command.response, 201);
    assert.match(command.response.body.checkId, uuid);
    assert.equal(command.response.body.replayed, false);
    proof(command.response.body.assessment);
  }
  assert.notEqual(created.input.idempotencyKey, reused.input.idempotencyKey);
  assert.notEqual(created.response.body.checkId, reused.response.body.checkId);
  assert.notEqual(
    created.response.body.assessment.assessmentId,
    reused.response.body.assessment.assessmentId,
  );
  assert.equal(created.response.body.outcome, "CREATED");
  assert.equal(reused.response.body.outcome, "REUSED");
  const request = created.response.body.request;
  assert.match(request.id, uuid);
  assert.equal(request.projectId, value.projectId);
  assert.equal(request.factId, value.factId);
  assert.equal(request.factType, value.factType);
  assert.equal(request.state, "OPEN");
  assert.equal(request.createdAt, created.response.body.assessment.asOf);
  assert.equal(request.assignment.reason, "ASSIGNED");
  assert.equal(request.assignment.revision, 1);
  assert.equal(request.assignment.recipientSubject, "pm-atlas");
  assert.deepEqual(reused.response.body.request, request);
  response(value.replay, 201);
  assert.deepEqual(value.replay.body, {
    ...created.response.body,
    replayed: true,
    assessment: { ...created.response.body.assessment, replayed: true },
  });
  for (const queue of [value.managementQueue, value.recipientQueue]) {
    response(queue, 200);
    assert.deepEqual(queue.body.requests, [request]);
    assert.equal(queue.body.live, true);
    assert.equal(queue.body.next, null);
  }
  response(value.managerDenied, 404);
  response(value.originalProof, 200);
  assert.deepEqual(value.originalProof.body, {
    request,
    assessment: created.response.body.assessment,
  });
  const sourceId = value.statements[0].response.body.entry.sourceId;
  access(value.sourceWithdrawal.access, sourceId, value.projectId, [
    "pmo-atlas",
  ]);
  response(value.sourceWithdrawal.proof, 200);
  assert.deepEqual(value.sourceWithdrawal.proof.body, {
    request,
    assessment: {
      ...created.response.body.assessment,
      visibility: "restricted",
      revalidationRequired: true,
      result: null,
    },
  });
  access(value.sourceRegrant.access, sourceId, value.projectId, [
    "pm-atlas",
    "pmo-atlas",
  ]);
  assert.equal(
    value.sourceRegrant.access.before.body.revision,
    value.sourceWithdrawal.access.after.body.revision,
  );
  for (const observed of [
    value.sourceRegrant.proof,
    value.recreatedProof.proof,
  ]) {
    response(observed, 200);
    assert.equal(observed.bodyBase64, value.originalProof.bodyBase64);
  }
  const withdrawal = value.projectScopeWithdrawal;
  assert.deepEqual(withdrawal.command.input, {
    subject: "pm-atlas",
    scopeType: "project",
    scopeId: value.projectId,
  });
  response(withdrawal.command.response, 204);
  for (const denial of [
    value.managerDenied,
    withdrawal.uiDenial,
    withdrawal.directDenial,
  ]) {
    response(denial, 404);
    assert.deepEqual(denial.body, {
      statusCode: 404,
      message: "Resource unavailable",
    });
  }
  assert.equal(
    withdrawal.uiDenial.bodyBase64,
    withdrawal.directDenial.bodyBase64,
  );
  image(value.screenshot, "scalar-reconciliation-pm-proof.png");
  image(
    value.recreatedProof.screenshot,
    "scalar-reconciliation-pm-proof-recreated.png",
  );
  image(withdrawal.screenshot, "scalar-reconciliation-pm-scope-denied.png");
  noSettlement(value);
}
