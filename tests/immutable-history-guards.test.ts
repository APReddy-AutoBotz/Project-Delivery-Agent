import { expect, it, vi } from "vitest";
import { verifyImmutableHistoryMutation } from "../scripts/acceptance/immutable-history.mjs";

function guardError(message = "Fact history is immutable", code = "P0001") {
  return Object.assign(new Error("Prisma raw query failed"), {
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: {
          kind: "postgres",
          originalCode: code,
          code,
          originalMessage: message,
          message,
        },
      },
    },
  });
}
function database(sqlError?: Error) {
  const execute = vi.fn(async () => {
    if (sqlError) throw sqlError;
    return 1;
  });
  const rollback = vi.fn();
  const commit = vi.fn();
  return {
    execute,
    rollback,
    commit,
    $transaction: async (body: (tx: unknown) => Promise<unknown>) => {
      try {
        const result = await body({ $executeRawUnsafe: execute });
        commit();
        return result;
      } catch (error) {
        rollback();
        throw error;
      }
    },
  };
}

it.each(["UPDATE", "DELETE", "TRUNCATE"])(
  "NFR-REL-002: accepts only the verified PostgreSQL history guard for %s",
  async (operation) => {
    const db = database(guardError());
    await verifyImmutableHistoryMutation(db, "FactEvidence", operation);
    expect(db.execute).toHaveBeenCalledOnce();
    expect(db.rollback).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
  },
);
it.each([
  guardError("unrelated PL/pgSQL failure"),
  guardError("Fact history is immutable", "23503"),
  Object.assign(new Error("Transaction timed out"), { code: "P2028" }),
  Object.assign(new Error("Connection lost"), { code: "ECONNRESET" }),
  Object.assign(new Error("Fact history is immutable"), { code: "P0001" }),
  Object.assign(new Error("legacy/unsupported wrapper"), {
    code: "P2010",
    meta: { code: "P0001", message: "Fact history is immutable" },
  }),
])(
  "NFR-REL-002: refuses unrelated or unsupported errors (%s)",
  async (error) => {
    const db = database(error);
    await expect(
      verifyImmutableHistoryMutation(db, "FactEvidence", "UPDATE"),
    ).rejects.toThrow("must fail at its verified history guard");
    expect(db.commit).not.toHaveBeenCalled();
  },
);
it("NFR-REL-002: rolls back a successful mutation and fails the rehearsal", async () => {
  const db = database();
  await expect(
    verifyImmutableHistoryMutation(db, "AuditEvent", "DELETE"),
  ).rejects.toThrow("must fail at its verified history guard");
  expect(db.rollback).toHaveBeenCalledOnce();
  expect(db.commit).not.toHaveBeenCalled();
});
it("FR-EVD-004: distinguishes sealed-header guards from ordinary immutable rows", async () => {
  await verifyImmutableHistoryMutation(
    database(guardError("Invalid state binding seal")),
    "CanonicalStateBinding",
    "UPDATE",
  );
  await expect(
    verifyImmutableHistoryMutation(
      database(guardError("Invalid state binding seal")),
      "FactEvidence",
      "UPDATE",
    ),
  ).rejects.toThrow("must fail at its verified history guard");
});
it.each([
  ["MilestoneReconciliationRequest", "Reconciliation request is immutable"],
  ["MilestoneReconciliationCheck", "Reconciliation check is immutable"],
  [
    "MilestoneReconciliationAssignment",
    "Reconciliation assignment is immutable",
  ],
])("FR-EVD-012: accepts only the exact %s guard", async (table, message) => {
  for (const operation of ["UPDATE", "DELETE"])
    await verifyImmutableHistoryMutation(
      database(
        guardError(
          table === "MilestoneReconciliationRequest" && operation === "UPDATE"
            ? "Invalid reconciliation request seal"
            : message,
        ),
      ),
      table,
      operation,
    );
  await expect(
    verifyImmutableHistoryMutation(
      database(guardError("Invalid reconciliation request seal")),
      table,
      "DELETE",
    ),
  ).rejects.toThrow("must fail at its verified history guard");
  await expect(
    verifyImmutableHistoryMutation(
      database(guardError("State binding is immutable")),
      table,
      "UPDATE",
    ),
  ).rejects.toThrow("must fail at its verified history guard");
});
it("FR-EVD-012: recognizes the request seal guard without widening other table errors", async () => {
  await verifyImmutableHistoryMutation(
    database(guardError("Invalid reconciliation request seal")),
    "MilestoneReconciliationRequest",
    "UPDATE",
  );
  await expect(
    verifyImmutableHistoryMutation(
      database(guardError("Invalid reconciliation request seal")),
      "MilestoneReconciliationCheck",
      "UPDATE",
    ),
  ).rejects.toThrow("must fail at its verified history guard");
});
