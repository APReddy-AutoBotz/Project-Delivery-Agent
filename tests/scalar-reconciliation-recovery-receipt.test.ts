import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { assertScalarRecoveryReceipt } from "../scripts/acceptance/scalar-reconciliation-recovery-receipt.mjs";

function receipt() {
  const customerId = randomUUID();
  const fixture = {
    family: "scalar-reconciliation/v1",
    runtimeRole: "pdaa_api",
    actor: { customerId },
    pm: { customerId },
    requestId: randomUUID(),
    checkId: randomUUID(),
    originalAssessmentId: randomUUID(),
    reusedCheckId: randomUUID(),
    noRequestCheckId: randomUUID(),
    unassignedRequestId: randomUUID(),
    pendingAssignmentId: randomUUID(),
    pendingRevision: 3,
    sourceWithdrawalWithheld: true,
    restoredSourceDeliveredOriginal: true,
    revokedRecipientDenied: true,
    sameKeyReplayed: true,
    businessReused: true,
  };
  return {
    customerId,
    persistence: {
      businessTableCount: 42,
      migrationCount: 7,
      scalarReconciliationTables: [
        "ScalarReconciliationRequest",
        "ScalarReconciliationCheck",
        "ScalarReconciliationAssignment",
      ],
      scalarReconciliationWorkerDenied: true,
      scalarReconciliationFixture: {
        ...fixture,
        originalAssessment: { assessmentId: fixture.originalAssessmentId },
      },
      restore: {
        status: "passed",
        exactRetainedRows: true,
        runtimeQuarantineChecked: true,
        scalarReconciliationIntegrityChecked: true,
        scalarReconciliationImmutableChecked: true,
        scalarReconciliationOriginalProof: {
          family: fixture.family,
          executedAs: "fixture_admin",
          originalRequestId: fixture.requestId,
          originalCheckId: fixture.checkId,
          originalAssessmentId: fixture.originalAssessmentId,
          originalReplayed: true,
          revokedRecipientDenied: true,
          regrantDidNotReroute: true,
          originalProofDelivered: true,
        },
      },
    },
  };
}
it("FR-EVD-012: binds recovery to the original scalar request/check/proof", () => {
  const { persistence, customerId } = receipt();
  expect(() =>
    assertScalarRecoveryReceipt(persistence, customerId),
  ).not.toThrow();
  for (const key of [
    "originalRequestId",
    "originalCheckId",
    "originalAssessmentId",
  ] as const) {
    const changed = structuredClone(persistence);
    changed.restore.scalarReconciliationOriginalProof[key] = randomUUID();
    expect(() => assertScalarRecoveryReceipt(changed, customerId)).toThrow();
  }
});
it("NFR-REL-001: rejects omitted population, privileges, quarantine and delivery evidence", () => {
  const { persistence, customerId } = receipt();
  for (const path of [
    ["scalarReconciliationTables"],
    ["scalarReconciliationWorkerDenied"],
    ["restore", "runtimeQuarantineChecked"],
    ["restore", "scalarReconciliationIntegrityChecked"],
    ["restore", "scalarReconciliationImmutableChecked"],
    ["restore", "scalarReconciliationOriginalProof", "originalProofDelivered"],
    ["restore", "scalarReconciliationOriginalProof", "regrantDidNotReroute"],
    ["scalarReconciliationFixture", "sourceWithdrawalWithheld"],
  ]) {
    const changed = structuredClone(persistence);
    let parent: Record<string, unknown> = changed;
    for (const key of path.slice(0, -1))
      parent = parent[key] as Record<string, unknown>;
    delete parent[path.at(-1)!];
    expect(() => assertScalarRecoveryReceipt(changed, customerId)).toThrow();
  }
  expect(() =>
    assertScalarRecoveryReceipt(persistence, randomUUID()),
  ).toThrow();
});
