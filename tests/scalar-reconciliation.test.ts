import { expect, it } from "vitest";
import {
  scalarReconciliationContextSchema,
  scalarReconciliationCheckResultSchema,
  scalarReconciliationDeliverySchema,
  scalarReconciliationAssignmentRefreshSchema,
  scalarReconciliationResolveSchema,
  scalarReconciliationPageSchema,
} from "../packages/domain/src/index.js";
import {
  scalarReconciliationContractFixture,
  scalarRefreshInput,
  scalarResolveInput,
  scalarRequestId,
} from "./fixtures/scalar-reconciliation-contract.js";

// FR-EVD-004 / STORY-012 / AC-EVD-004: generic scalar conflict reconciliation schema tests
it("validates scalar reconciliation context schema", () => {
  const f = scalarReconciliationContractFixture();
  const valid = {
    projectId: f.request.projectId,
    factType: "project.forecast",
    canAppend: true,
    canConfigure: false,
    factId: f.request.factId,
  };
  expect(scalarReconciliationContextSchema.safeParse(valid).success).toBe(true);

  expect(
    scalarReconciliationContextSchema.safeParse({ ...valid, canAppend: "yes" }).success,
  ).toBe(false);
  expect(
    scalarReconciliationContextSchema.safeParse({ ...valid, factId: "not-a-uuid" }).success,
  ).toBe(false);
});

it("keeps pending scalar request, check outcome, and assessment factId coherent", () => {
  const f = scalarReconciliationContractFixture();

  // Valid CREATED outcome with matching factId
  expect(scalarReconciliationCheckResultSchema.safeParse(f.checked).success).toBe(true);

  // NO_REQUEST must have request === null
  const noRequest = {
    ...f.checked,
    outcome: "NO_REQUEST" as const,
    request: null,
  };
  expect(scalarReconciliationCheckResultSchema.safeParse(noRequest).success).toBe(true);

  // NO_REQUEST with a non-null request must be rejected
  expect(
    scalarReconciliationCheckResultSchema.safeParse({
      ...f.checked,
      outcome: "NO_REQUEST",
      request: f.request,
    }).success,
  ).toBe(false);

  // CREATED with request === null must be rejected
  expect(
    scalarReconciliationCheckResultSchema.safeParse({
      ...f.checked,
      outcome: "CREATED",
      request: null,
    }).success,
  ).toBe(false);

  // REUSED with request === null must be rejected
  expect(
    scalarReconciliationCheckResultSchema.safeParse({
      ...f.checked,
      outcome: "REUSED",
      request: null,
    }).success,
  ).toBe(false);

  // Mismatched factId between assessment and request must be rejected
  expect(
    scalarReconciliationCheckResultSchema.safeParse({
      ...f.checked,
      request: {
        ...f.request,
        factId: "11111111-1111-4000-8000-111111111111",
      },
    }).success,
  ).toBe(false);
});

it("validates scalar reconciliation delivery schema", () => {
  const f = scalarReconciliationContractFixture();
  const delivery = {
    request: f.request,
    assessment: f.assessment,
  };
  expect(scalarReconciliationDeliverySchema.safeParse(delivery).success).toBe(true);

  // Mismatched factId must be rejected
  expect(
    scalarReconciliationDeliverySchema.safeParse({
      ...delivery,
      request: {
        ...f.request,
        factId: "22222222-2222-4000-8000-222222222222",
      },
    }).success,
  ).toBe(false);

  // Invalid state rejected
  expect(
    scalarReconciliationDeliverySchema.safeParse({
      ...delivery,
      request: {
        ...f.request,
        state: "INVALID_STATE",
      },
    }).success,
  ).toBe(false);
});

it("validates refresh assignment and resolve schemas", () => {
  expect(
    scalarReconciliationAssignmentRefreshSchema.safeParse(scalarRefreshInput).success,
  ).toBe(true);

  // Zero revision invalid
  expect(
    scalarReconciliationAssignmentRefreshSchema.safeParse({
      ...scalarRefreshInput,
      expectedAssignmentRevision: 0,
    }).success,
  ).toBe(false);

  expect(
    scalarReconciliationResolveSchema.safeParse(scalarResolveInput).success,
  ).toBe(true);

  // Bad idempotency key invalid
  expect(
    scalarReconciliationResolveSchema.safeParse({
      ...scalarResolveInput,
      idempotencyKey: "",
    }).success,
  ).toBe(false);
});

it("validates scalar reconciliation page schema", () => {
  const f = scalarReconciliationContractFixture();
  const page = {
    requests: [f.request],
    next: null,
    live: true as const,
  };
  expect(scalarReconciliationPageSchema.safeParse(page).success).toBe(true);

  // Cursor pagination
  const pagedWithCursor = {
    requests: [f.request],
    next: {
      createdAt: f.request.createdAt,
      id: f.request.id,
    },
    live: true as const,
  };
  expect(scalarReconciliationPageSchema.safeParse(pagedWithCursor).success).toBe(true);
});
