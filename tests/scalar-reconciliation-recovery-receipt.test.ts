import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { assertScalarRecoveryReceipt } from "../scripts/acceptance/scalar-reconciliation-recovery-receipt.mjs";

function receipt() {
  const customerId = randomUUID();
  const command = { projectId: randomUUID(), factId: randomUUID() };
  const versions = ["2026-10-01", "2026-10-02"].map((value) => ({
    id: randomUUID(),
    value: { type: "date", value },
    evidenceIds: [randomUUID()],
  }));
  const fixture = {
    family: "scalar-reconciliation/v1",
    runtimeRole: "pdaa_api",
    actor: { customerId },
    command,
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
        originalAssessment: {
          assessmentId: fixture.originalAssessmentId,
          factId: command.factId,
          visibility: "available",
          historical: true,
          revalidationRequired: false,
          result: {
            complete: true,
            status: "CONFLICTING",
            revalidationRequired: false,
            resolvedValue: null,
            policy: {
              conflictBehavior: "REQUEST_RECONCILIATION",
              customerId,
              projectId: command.projectId,
              factType: "project.forecast",
            },
            scope: { customerId, ...command, factType: "project.forecast" },
            versions,
            conflicts: [
              {
                versionIds: versions.map((version) => version.id),
                evidenceIds: versions.flatMap((version) => version.evidenceIds),
              },
            ],
          },
        },
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
          runtimeRole: "pdaa_api",
          runtimeTransactions: 5,
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
    ["scalarReconciliationFixture", "originalAssessment", "result"],
    ["restore", "scalarReconciliationOriginalProof", "runtimeRole"],
    ["restore", "scalarReconciliationOriginalProof", "runtimeTransactions"],
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

it("FR-EVD-012: rejects an always-restricted original and owner-role application checks", () => {
  const { persistence, customerId } = receipt();
  const restricted = structuredClone(persistence);
  restricted.scalarReconciliationFixture.originalAssessment.visibility =
    "restricted";
  expect(() => assertScalarRecoveryReceipt(restricted, customerId)).toThrow();
  const owner = structuredClone(persistence);
  owner.restore.scalarReconciliationOriginalProof.runtimeRole = "fixture_admin";
  expect(() => assertScalarRecoveryReceipt(owner, customerId)).toThrow();
});
