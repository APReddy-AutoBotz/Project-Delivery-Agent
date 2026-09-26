// FR-EVD-007/012, NFR-REL-001: bind restored delivery to the original scalar proof.
import assert from "node:assert/strict";

export function assertAvailableScalarOriginal(assessment, customerId, command) {
  assert.equal(assessment.visibility, "available");
  assert.equal(assessment.revalidationRequired, false);
  assert.equal(assessment.historical, true);
  assert.equal(assessment.factId, command.factId);
  const result = assessment.result;
  assert(result);
  assert.equal(result.complete, true);
  assert.equal(result.status, "CONFLICTING");
  assert.equal(result.revalidationRequired, false);
  assert.equal(result.resolvedValue, null);
  assert.equal(result.policy.conflictBehavior, "REQUEST_RECONCILIATION");
  assert.equal(result.policy.customerId, customerId);
  assert.equal(result.policy.projectId, command.projectId);
  assert.equal(result.policy.factType, result.scope.factType);
  assert.equal(result.scope.customerId, customerId);
  assert.equal(result.scope.projectId, command.projectId);
  assert.equal(result.scope.factId, command.factId);
  assert.equal(result.versions.length, 2);
  assert.deepEqual(
    result.versions
      .map((version) => version.value)
      .sort((a, b) => a.value.localeCompare(b.value)),
    [
      { type: "date", value: "2026-10-01" },
      { type: "date", value: "2026-10-02" },
    ],
  );
  assert(result.versions.every((version) => version.evidenceIds.length === 1));
  assert.deepEqual(
    [
      ...new Set(result.conflicts.flatMap((conflict) => conflict.versionIds)),
    ].sort(),
    result.versions.map((version) => version.id).sort(),
  );
  assert.deepEqual(
    [
      ...new Set(result.conflicts.flatMap((conflict) => conflict.evidenceIds)),
    ].sort(),
    result.versions.flatMap((version) => version.evidenceIds).sort(),
  );
}

export function assertScalarRecoveryReceipt(
  persistence,
  customerId,
  expectedAdministrator,
) {
  // Caller pins the profile's restore login; never learn it from the receipt.
  assert(["fixture_admin", "postgres"].includes(expectedAdministrator));
  assert.equal(persistence.businessTableCount, 63);
  assert.equal(persistence.migrationCount, 14);
  assert.deepEqual(persistence.scalarReconciliationTables, [
    "ScalarReconciliationRequest",
    "ScalarReconciliationCheck",
    "ScalarReconciliationAssignment",
  ]);
  assert.equal(persistence.scalarReconciliationWorkerDenied, true);
  const fixture = persistence.scalarReconciliationFixture;
  assertAvailableScalarOriginal(
    fixture.originalAssessment,
    customerId,
    fixture.command,
  );
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
  assert.equal(proof.executedAs, expectedAdministrator);
  assert.equal(proof.runtimeRole, "pdaa_api");
  assert.equal(proof.runtimeTransactions, 5);
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
