// FR-EVD-007/012, NFR-REL-001: bind restored delivery to the original scalar proof.
import assert from "node:assert/strict";

export function assertScalarRecoveryReceipt(persistence, customerId) {
  assert.equal(persistence.businessTableCount, 42);
  assert.equal(persistence.migrationCount, 7);
  assert.deepEqual(persistence.scalarReconciliationTables, [
    "ScalarReconciliationRequest",
    "ScalarReconciliationCheck",
    "ScalarReconciliationAssignment",
  ]);
  assert.equal(persistence.scalarReconciliationWorkerDenied, true);
  const fixture = persistence.scalarReconciliationFixture;
  assert.equal(fixture.family, "scalar-reconciliation/v1");
  assert.equal(fixture.runtimeRole, "pdaa_api");
  assert.equal(fixture.actor.customerId, customerId);
  assert.equal(fixture.pm.customerId, customerId);
  const ids = [
    "requestId",
    "checkId",
    "originalAssessmentId",
    "reusedCheckId",
    "noRequestCheckId",
    "unassignedRequestId",
    "pendingAssignmentId",
  ];
  for (const key of ids)
    assert.match(
      fixture[key],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  assert.equal(new Set(ids.map((key) => fixture[key])).size, ids.length);
  assert.equal(
    fixture.originalAssessment.assessmentId,
    fixture.originalAssessmentId,
  );
  assert.equal(fixture.pendingRevision, 3);
  for (const flag of [
    "sourceWithdrawalWithheld",
    "restoredSourceDeliveredOriginal",
    "revokedRecipientDenied",
    "sameKeyReplayed",
    "businessReused",
  ])
    assert.equal(fixture[flag], true);
  const restore = persistence.restore;
  assert.equal(restore.status, "passed");
  for (const flag of [
    "exactRetainedRows",
    "runtimeQuarantineChecked",
    "scalarReconciliationIntegrityChecked",
    "scalarReconciliationImmutableChecked",
  ])
    assert.equal(restore[flag], true);
  const proof = restore.scalarReconciliationOriginalProof;
  assert.equal(proof.family, fixture.family);
  assert.equal(proof.executedAs, "fixture_admin");
  assert.equal(proof.originalRequestId, fixture.requestId);
  assert.equal(proof.originalCheckId, fixture.checkId);
  assert.equal(proof.originalAssessmentId, fixture.originalAssessmentId);
  for (const flag of [
    "originalReplayed",
    "revokedRecipientDenied",
    "regrantDidNotReroute",
    "originalProofDelivered",
  ])
    assert.equal(proof[flag], true);
}
