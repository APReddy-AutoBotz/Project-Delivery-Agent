// FR-EVD-009/012, NFR-REL-001: synthetic reader controls, not native evidence.
import { describe, expect, it } from "vitest";
import { assertScalarSealPhase } from "../scripts/acceptance/scalar-seal-receipt.mjs";
const base = () => ({
  name: "coherent-missing-evidence",
  assessmentId: "proof",
  requestId: "request",
  role: "pdaa_api",
  sessionUser: "pdaa_api",
  pid: 123,
  forcedConstraints: 0,
  callbackReturned: false,
  rejected: true,
  transactionRejected: true,
  nativeCommitAttempts: 0,
  options: { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 },
  rollbackCommand: "ROLLBACK",
  sealStatements: [
    {
      table: "FactAssessment",
      pid: 123,
      sql: 'UPDATE "public"."FactAssessment" SET "sealed" = $1 WHERE "id"=$2',
      values: [true, "proof"],
      error: { code: "P0001", message: "Invalid assessment seal" },
    },
  ],
});
describe("closed scalar seal statement phase", () => {
  it("accepts only exact seal errors with actual role and no COMMIT", () => {
    expect(() => assertScalarSealPhase(base())).not.toThrow();
    for (const change of [
      { name: "unknown" },
      { role: "postgres" },
      { sessionUser: "postgres" },
      { callbackReturned: true },
      { nativeCommitAttempts: 1 },
      { forcedConstraints: 1 },
      { rollbackCommand: undefined },
      { nativeCommand: "COMMIT" },
      { pending: {} },
      { rollbackError: { code: "08006" } },
    ])
      expect(() => assertScalarSealPhase({ ...base(), ...change })).toThrow();
  });
  it("rejects generic Prisma, FK, timeout and wrong seal-stage errors", () => {
    for (const error of [
      { code: "P2028", message: "Invalid assessment seal" },
      { code: "23503", message: "Invalid assessment seal" },
      { code: "P0001", message: "Invalid scalar reconciliation request seal" },
      { code: "P0001", message: "Invalid assessment seal", constraint: "fake" },
    ]) {
      const c = base();
      c.sealStatements[0]!.error = error;
      expect(() => assertScalarSealPhase(c)).toThrow();
    }
  });
  it("requires request failures to follow a successful real proof seal", () => {
    const c = {
      ...base(),
      name: "coherent-wrong-identity",
      sealStatements: [
        {
          table: "FactAssessment",
          pid: 123,
          sql: 'UPDATE "public"."FactAssessment" SET "sealed"=$1 WHERE "id"=$2',
          values: [true, "proof"],
          command: "UPDATE",
        },
        {
          table: "ScalarReconciliationRequest",
          pid: 123,
          sql: 'UPDATE "public"."ScalarReconciliationRequest" SET "sealed"=$1 WHERE "id"=$2',
          values: [true, "request"],
          error: {
            code: "P0001",
            message: "Invalid scalar reconciliation request seal",
          },
        },
      ],
    };
    expect(() => assertScalarSealPhase(c)).not.toThrow();
    expect(() =>
      assertScalarSealPhase({
        ...c,
        sealStatements: c.sealStatements.slice(1),
      }),
    ).toThrow();
    expect(() =>
      assertScalarSealPhase({
        ...c,
        sealStatements: c.sealStatements.map((entry) => ({
          ...entry,
          pid: 999,
        })),
      }),
    ).toThrow();
  });
});
