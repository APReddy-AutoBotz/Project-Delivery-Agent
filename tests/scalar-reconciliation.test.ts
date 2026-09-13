import { expect, it } from "vitest";
import {
  scalarReconciliationCheckSchema,
  scalarReconciliationCheckResultSchema,
  scalarReconciliationDeliverySchema,
  scalarReconciliationListSchema,
  scalarReconciliationPageSchema,
  scalarReconciliationAssignmentRefreshSchema,
  resolveSourceAuthority,
} from "../packages/domain/src/index.js";
import {
  scalarContractFixture,
  scalarId as id,
  scalarSnapshot,
  scalarScope,
} from "./fixtures/scalar-reconciliation.js";

// FR-EVD-009 / NFR-SEC-001 / NFR-REL-002: strict scalar envelopes.
it("accepts positive/reused checks and restricted replays without exposing proof", () => {
  const f = scalarContractFixture();
  for (const outcome of ["CREATED", "REUSED"] as const) {
    expect(
      scalarReconciliationCheckResultSchema.safeParse({ ...f.checked, outcome })
        .success,
    ).toBe(true);
    expect(
      scalarReconciliationCheckResultSchema.safeParse({
        ...f.checked,
        outcome,
        replayed: true,
        assessment: { ...f.restricted, replayed: true },
      }).success,
    ).toBe(true);
  }
  expect(
    scalarReconciliationDeliverySchema.safeParse({
      request: f.request,
      assessment: f.restricted,
    }).success,
  ).toBe(true);
  expect(
    scalarReconciliationDeliverySchema.safeParse({
      request: f.request,
      assessment: f.assessment,
    }).success,
  ).toBe(true);
});
it("keeps policy opt-out conflicting assessments as NO_REQUEST", () => {
  const f = scalarContractFixture(),
    input = scalarSnapshot();
  input.policy!.conflictBehavior = "RETAIN_CONFLICT";
  const assessment = { ...f.assessment, result: resolveSourceAuthority(input) };
  expect(
    scalarReconciliationCheckResultSchema.safeParse({
      ...f.checked,
      outcome: "NO_REQUEST",
      request: null,
      assessment,
    }).success,
  ).toBe(true);
  expect(
    scalarReconciliationCheckResultSchema.safeParse({
      ...f.checked,
      assessment,
    }).success,
  ).toBe(false);
  expect(
    scalarReconciliationDeliverySchema.safeParse({
      request: f.request,
      assessment,
    }).success,
  ).toBe(false);
});
it("rejects scope, outcome, replay and restricted-content inconsistencies", () => {
  const f = scalarContractFixture();
  for (const patch of [
    { outcome: "NO_REQUEST" },
    { request: null },
    { replayed: true },
    { request: { ...f.request, factId: id(99) } },
    { request: { ...f.request, projectId: id(99) } },
    { request: { ...f.request, factType: "other.fact" } },
    { request: { ...f.request, contributorIdentity: "private" } },
    { assessment: { ...f.restricted, result: f.assessment.result } },
  ])
    expect(
      scalarReconciliationCheckResultSchema.safeParse({
        ...f.checked,
        ...patch,
      }).success,
    ).toBe(false);
});
it("retains unassigned check metadata but never calls it PM proof delivery", () => {
  const f = scalarContractFixture();
  for (const reason of [
    "NO_CONFIGURED_PM",
    "AMBIGUOUS_CONFIGURED_PM",
    "PM_SCOPE_UNAVAILABLE",
  ]) {
    const request = {
      ...f.request,
      assignment: { ...f.request.assignment, reason, recipientSubject: null },
    };
    expect(
      scalarReconciliationCheckResultSchema.safeParse({ ...f.checked, request })
        .success,
    ).toBe(true);
    expect(
      scalarReconciliationDeliverySchema.safeParse({
        request,
        assessment: f.assessment,
      }).success,
    ).toBe(false);
  }
});
it("accepts only target and retry input, never client policy, owner or routing", () => {
  const input = {
    projectId: scalarScope.projectId,
    factId: scalarScope.factId,
    idempotencyKey: "scalar-check",
  };
  expect(scalarReconciliationCheckSchema.parse(input)).toEqual(input);
  for (const patch of [
    { enabled: true },
    { asOf: "now" },
    { recipientSubject: "pm" },
    { policyId: id(9) },
    { factId: "bad" },
    { idempotencyKey: "contains space" },
  ])
    expect(
      scalarReconciliationCheckSchema.safeParse({ ...input, ...patch }).success,
    ).toBe(false);
  expect(
    scalarReconciliationAssignmentRefreshSchema.safeParse({
      projectId: scalarScope.projectId,
      requestId: id(7),
      expectedAssignmentRevision: 2147483647,
      idempotencyKey: "refresh",
    }).success,
  ).toBe(false);
});
it("bounds live keyset queues with strict metadata-only summaries", () => {
  const f = scalarContractFixture();
  expect(
    scalarReconciliationListSchema.parse({ projectId: scalarScope.projectId }),
  ).toMatchObject({ limit: 20, after: null });
  expect(
    scalarReconciliationPageSchema.safeParse({
      requests: [f.request],
      next: null,
      live: true,
    }).success,
  ).toBe(true);
  for (const limit of [0, 21, 1.5])
    expect(
      scalarReconciliationListSchema.safeParse({
        projectId: scalarScope.projectId,
        limit,
      }).success,
    ).toBe(false);
  expect(
    scalarReconciliationPageSchema.safeParse({
      requests: Array(21).fill(f.request),
      next: null,
      live: true,
    }).success,
  ).toBe(false);
});
