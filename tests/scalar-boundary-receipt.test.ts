// FR-EVD-009, NFR-SEC-001/REL-001: explicit phase/error and rollback controls.
import { expect, it, vi } from "vitest";
import { assertScalarBoundaryError } from "../scripts/acceptance/scalar-boundary-receipt.mjs";
import { rollbackProbe } from "../scripts/acceptance/fixture-cleanup.mjs";

const immediate = () => ({
  name: "request-reseal",
  phase: "statement",
  role: "pdaa_api",
  sessionUser: "pdaa_api",
  pid: 31,
  callbackReturned: false,
  nativeCommitAttempts: 0,
  rollbackCommand: "ROLLBACK",
  attempt: { table: "ScalarReconciliationRequest" },
  error: {
    code: "P0001",
    message: "Invalid scalar reconciliation request seal",
  },
});
const deferred = () => ({
  ...immediate(),
  name: "borrowed-standalone",
  phase: "commit",
  callbackReturned: true,
  callbackReturnedAtCommit: true,
  nativeCommitAttempts: 1,
  nativePid: 31,
  error: {
    code: "23503",
    constraint: "ScalarCheck_assessment_fk",
    message:
      'insert or update on table "ScalarReconciliationCheck" violates foreign key constraint "ScalarCheck_assessment_fk"',
  },
  native: {
    code: "23503",
    constraint: "ScalarCheck_assessment_fk",
    message:
      'insert or update on table "ScalarReconciliationCheck" violates foreign key constraint "ScalarCheck_assessment_fk"',
  },
  commitObserver: {
    observerPid: 42,
    writerPid: 31,
    sessionUser: "pdaa_api",
    phase: "native-commit-settled",
    state: "idle",
    query: "COMMIT",
  },
});

it("distinguishes immediate seal rejection from deferred owner rejection", () => {
  expect(() => assertScalarBoundaryError(immediate())).not.toThrow();
  expect(() => assertScalarBoundaryError(deferred())).not.toThrow();
  for (const patch of [
    { phase: "commit" },
    { callbackReturned: true },
    { nativeCommitAttempts: 1 },
    { rollbackCommand: "COMMIT" },
    { role: "fixture_admin" },
  ])
    expect(() =>
      assertScalarBoundaryError({ ...immediate(), ...patch }),
    ).toThrow();
  for (const patch of [
    { phase: "statement" },
    { callbackReturned: false },
    { callbackReturnedAtCommit: false },
    { nativePid: 32 },
    { nativeCommitAttempts: 0 },
  ])
    expect(() =>
      assertScalarBoundaryError({ ...deferred(), ...patch }),
    ).toThrow();
  expect(() =>
    assertScalarBoundaryError({
      ...deferred(),
      commitObserver: { ...deferred().commitObserver, observerPid: 31 },
    }),
  ).toThrow();
});

it("requires exact API privilege, native FK and check-constraint errors", () => {
  const denied = {
    ...immediate(),
    name: "api-delete-request",
    error: {
      code: "42501",
      message: "permission denied for table ScalarReconciliationRequest",
    },
  };
  expect(() => assertScalarBoundaryError(denied)).not.toThrow();
  for (const error of [
    { code: "P2028", message: "Transaction expired" },
    { code: "42501", message: "permission denied for table Other" },
    { code: "P0001", message: "Scalar reconciliation request is immutable" },
  ])
    expect(() => assertScalarBoundaryError({ ...denied, error })).toThrow();
  expect(() =>
    assertScalarBoundaryError({
      ...deferred(),
      native: { ...deferred().native, constraint: "other_fk" },
    }),
  ).toThrow();
  expect(() =>
    assertScalarBoundaryError({
      ...immediate(),
      name: "assignment-year-range",
      attempt: { table: "ScalarReconciliationAssignment" },
      error: {
        code: "23514",
        constraint: "ScalarAssignment_shape",
        message:
          'new row for relation "ScalarReconciliationAssignment" violates check constraint "ScalarAssignment_shape"',
      },
    }),
  ).not.toThrow();
});

it("preserves the original SQL failure when rollback also fails", async () => {
  const primary = new Error("native rejection"),
    cleanup = new Error("rollback failed");
  const client = { query: vi.fn().mockRejectedValue(cleanup) };
  await expect(rollbackProbe(client, primary)).rejects.toMatchObject({
    errors: [primary, cleanup],
    cause: cleanup,
  });
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  await expect(rollbackProbe(client, undefined)).rejects.toBe(cleanup);
});

it("returns a successful rollback for subsequent expected-error classification", async () => {
  const client = { query: vi.fn().mockResolvedValue({ command: "ROLLBACK" }) };
  expect(await rollbackProbe(client, new Error("expected denial"))).toEqual({
    command: "ROLLBACK",
  });
  expect(client.query).toHaveBeenCalledExactlyOnceWith("ROLLBACK");
});
