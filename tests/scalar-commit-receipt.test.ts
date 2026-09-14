// NFR-REL-001/002: these unit controls cannot substitute for actual native SQL.
import { expect, it } from "vitest";
import { assertScalarNativeCommit } from "../scripts/acceptance/scalar-commit-receipt.mjs";
import { assertScalarSourceAccessTransition } from "../scripts/acceptance/scalar-access-races-receipt.mjs";

const native = () => ({
  name: "wrong-check-hash",
  role: "pdaa_api",
  sessionUser: "pdaa_api",
  pid: 31,
  nativePid: 31,
  callbackReturned: true,
  callbackReturnedAtCommit: true,
  nativeCommitAttempts: 1,
  rejected: true,
  native: {
    code: "P0001",
    message: "Incomplete scalar reconciliation check cannot commit",
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

it("requires actual callback completion, native COMMIT and an independent settled observer", () => {
  expect(() => assertScalarNativeCommit(native())).not.toThrow();
  for (const patch of [
    { callbackReturned: false },
    { callbackReturnedAtCommit: false },
    { nativeCommitAttempts: 0 },
    { nativeCommitAttempts: 2 },
    { nativePid: 999 },
    { rejected: false },
    { role: "fixture_admin" },
    { sessionUser: "fixture_admin" },
    { unsupportedTransport: true },
    { nativeCommand: "COMMIT" },
  ])
    expect(() => assertScalarNativeCommit({ ...native(), ...patch })).toThrow();
  for (const patch of [
    { observerPid: 31 },
    { writerPid: 33 },
    { phase: "callback-returned" },
    { state: "active" },
    { query: "INSERT INTO anything" },
  ])
    expect(() =>
      assertScalarNativeCommit({
        ...native(),
        commitObserver: { ...native().commitObserver, ...patch },
      }),
    ).toThrow();
});

it("rejects timeouts, arbitrary constraints and integrity errors from a different case", () => {
  for (const error of [
    { code: "P2028", message: "Transaction expired" },
    { code: "42501", message: "permission denied" },
    { code: "23503", constraint: "other_fk", message: "foreign key violation" },
    {
      code: "P0001",
      message: "Incomplete scalar reconciliation assignment cannot commit",
    },
    {
      code: "P0001",
      message: "Incomplete scalar reconciliation check cannot commit",
      constraint: "unexpected",
    },
  ])
    expect(() =>
      assertScalarNativeCommit({ ...native(), native: error }),
    ).toThrow();
});

it("admits only the orphan's exact reciprocal-owner FK and the refresh's exact guard", () => {
  const orphan = {
    ...native(),
    name: "orphan-owned-assessment",
    native: {
      code: "23503",
      constraint: "ScalarAssessment_check_fk",
      message:
        'insert or update on table "FactAssessment" violates foreign key constraint "ScalarAssessment_check_fk"',
    },
  };
  expect(() => assertScalarNativeCommit(orphan)).not.toThrow();
  expect(() =>
    assertScalarNativeCommit({
      ...orphan,
      native: { ...orphan.native, constraint: "ScalarCheck_assessment_fk" },
    }),
  ).toThrow();
  expect(() =>
    assertScalarNativeCommit({ ...native(), name: "wrong-refresh-time" }),
  ).toThrow();
  expect(() =>
    assertScalarNativeCommit({
      ...native(),
      name: "wrong-refresh-time",
      native: {
        code: "P0001",
        message: "Incomplete scalar reconciliation assignment cannot commit",
      },
    }),
  ).not.toThrow();
});

it("distinguishes positive native COMMIT from a falsely labeled rejected transaction", () => {
  const positive = {
    ...native(),
    name: "positive-created",
    rejected: false,
    native: undefined,
    nativeCommand: "COMMIT",
  };
  expect(() => assertScalarNativeCommit(positive)).not.toThrow();
  expect(() =>
    assertScalarNativeCommit({ ...positive, nativeCommand: "ROLLBACK" }),
  ).toThrow();
  expect(() =>
    assertScalarNativeCommit({ ...positive, rejected: true }),
  ).toThrow();
});

it("compares source changes by stable identity when revision changes reorder SQL rows", () => {
  const before = [
    { sourceId: "a", revision: 6, state: "AVAILABLE" },
    { sourceId: "b", revision: 6, state: "AVAILABLE" },
  ];
  const after = [{ ...before[1]!, revision: 10 }, before[0]!];
  expect(() =>
    assertScalarSourceAccessTransition(before, after, "b", 10),
  ).not.toThrow();
  expect(() =>
    assertScalarSourceAccessTransition(before, [...after].reverse(), "b", 10),
  ).not.toThrow();
  expect(() =>
    assertScalarSourceAccessTransition(
      before,
      [{ ...after[0]!, state: "WITHDRAWN" }, after[1]!],
      "b",
      10,
    ),
  ).toThrow();
  expect(() =>
    assertScalarSourceAccessTransition(before, before, "b", 10),
  ).toThrow();
  expect(() =>
    assertScalarSourceAccessTransition(before, [after[0]!], "b", 10),
  ).toThrow();
});
