import { expect, it } from "vitest";
import {
  milestoneConsistencyDeliverySchema,
  reconciliationCheckResultSchema,
  reconciliationDeliverySchema,
  reconciliationAssignmentRefreshSchema,
  reconciliationAssignmentSchema,
  reconciliationListSchema,
  reconciliationPageSchema,
} from "../packages/domain/src/index.js";
import {
  reconciliationContractFixture,
  refreshInput,
} from "./fixtures/reconciliation-contract.js";

// FR-EVD-009 / NFR-SEC-001 / NFR-REL-002: the wire contract cannot assert a
// recipient or delivery receipt, or expose a partial restricted proof.
it("accepts all six assessment status shapes and rejects mixed restricted proofs", () => {
  const f = reconciliationContractFixture(),
    base = f.checked.assessment;
  for (const status of [
    "INCOMPLETE",
    "DISABLED",
    "REVALIDATION_REQUIRED",
    "UNKNOWN",
    "NOT_DETECTED",
  ] as const) {
    const result = {
      ...base.result,
      status,
      ...(["UNKNOWN", "NOT_DETECTED"].includes(status)
        ? { evaluations: [], dependencies: [] }
        : {}),
    };
    expect(
      milestoneConsistencyDeliverySchema.safeParse({ ...base, result }).success,
    ).toBe(true);
  }
  expect(
    milestoneConsistencyDeliverySchema.safeParse(f.restricted).success,
  ).toBe(true);
  for (const bad of [
    { ...f.restricted, result: base.result },
    { ...base, result: null },
    { ...base, revalidationRequired: true },
    { ...base, projectId: refreshInput.requestId },
    { ...base, asOf: "2026-09-12T00:00:00.000Z" },
  ])
    expect(milestoneConsistencyDeliverySchema.safeParse(bad).success).toBe(
      false,
    );
});
it("keeps pending request, check outcome and proof scope coherent", () => {
  const f = reconciliationContractFixture();
  expect(reconciliationCheckResultSchema.safeParse(f.checked).success).toBe(
    true,
  );
  expect(
    reconciliationDeliverySchema.safeParse({
      request: f.request,
      assessment: f.restricted,
    }).success,
  ).toBe(true);
  for (const outcome of ["CREATED", "REUSED"] as const) {
    expect(
      reconciliationCheckResultSchema.safeParse({
        ...f.checked,
        outcome,
        assessment: f.restricted,
        request: f.request,
      }).success,
    ).toBe(true);
    expect(
      reconciliationCheckResultSchema.safeParse({
        ...f.checked,
        outcome,
        request: f.request,
      }).success,
    ).toBe(false);
    expect(
      reconciliationCheckResultSchema.safeParse({ ...f.checked, outcome })
        .success,
    ).toBe(false);
  }
  for (const request of [
    { ...f.request, state: "CLOSED" },
    { ...f.request, projectId: refreshInput.requestId },
    {
      ...f.request,
      assignment: { ...f.request.assignment, recipientSubject: null },
    },
    { ...f.request, sentAt: f.request.createdAt },
  ])
    expect(
      reconciliationDeliverySchema.safeParse({
        request,
        assessment: f.restricted,
      }).success,
    ).toBe(false);
});
it("separates assigned from unassigned states and bounds refresh/cursor input", () => {
  const f = reconciliationContractFixture();
  for (const reason of [
    "NO_CONFIGURED_PM",
    "AMBIGUOUS_CONFIGURED_PM",
    "PM_SCOPE_UNAVAILABLE",
  ]) {
    expect(
      reconciliationAssignmentSchema.safeParse({
        ...f.request.assignment,
        reason,
        recipientSubject: null,
      }).success,
    ).toBe(true);
    expect(
      reconciliationAssignmentSchema.safeParse({
        ...f.request.assignment,
        reason,
      }).success,
    ).toBe(false);
  }
  expect(
    reconciliationAssignmentRefreshSchema.safeParse(refreshInput).success,
  ).toBe(true);
  for (const bad of [
    { ...refreshInput, recipientSubject: "arbitrary-pm" },
    { ...refreshInput, expectedAssignmentRevision: 0 },
    { ...refreshInput, expectedAssignmentRevision: 2147483647 },
    { ...refreshInput, idempotencyKey: "" },
    { ...refreshInput, actor: "operator" },
  ])
    expect(reconciliationAssignmentRefreshSchema.safeParse(bad).success).toBe(
      false,
    );
  expect(
    reconciliationListSchema.parse({ projectId: refreshInput.projectId }),
  ).toEqual({ projectId: refreshInput.projectId, after: null, limit: 20 });
  for (const bad of [
    { limit: 21 },
    { limit: 0 },
    { limit: 1.5 },
    { mode: "manage" },
    { after: { id: refreshInput.requestId } },
    { after: refreshInput.requestId },
  ])
    expect(
      reconciliationListSchema.safeParse({
        projectId: refreshInput.projectId,
        ...bad,
      }).success,
    ).toBe(false);
  expect(
    reconciliationPageSchema.safeParse({
      requests: [],
      next: null,
      live: false,
    }).success,
  ).toBe(false);
});
