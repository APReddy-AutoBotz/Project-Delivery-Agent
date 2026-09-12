import assert from "node:assert/strict";
import { canonicalTables } from "./canonical-projects.mjs";

// FR-EVD-004/012, NFR-REL-002: a SQL failure alone does not prove immutability.
// Match the installed Prisma PG adapter's structured server error, not its
// formatted top-level message (which can include SQL and source information).
const immutableMessages = {
  AuditEvent: "Audit records are immutable",
  FactSource: "Fact history is immutable",
  FactEvidence: "Fact history is immutable",
  ProjectFactVersion: "Fact history is immutable",
  FactAppendReceipt: "Fact history is immutable",
  AuthorityPolicyRevision: "Fact history is immutable",
  AuthorityPolicyReceipt: "Fact history is immutable",
  FactAuthorityConflict: "Fact history is immutable",
  FactAssessment: "Assessment is immutable",
  CanonicalStateBinding: "State binding is immutable",
  CanonicalStateBindingReceipt: "State binding receipt is immutable",
  MilestoneConsistencyAssessment: "Milestone consistency history is immutable",
  MilestoneConsistencyTarget: "Milestone consistency dependency is immutable",
  MilestoneConsistencyContributorVersion:
    "Milestone consistency dependency is immutable",
  ...Object.fromEntries(
    canonicalTables.map((table) => [
      table,
      "Canonical creation history is immutable",
    ]),
  ),
};
const sealMessages = {
  FactAssessment: "Invalid assessment seal",
  CanonicalStateBinding: "Invalid state binding seal",
  MilestoneConsistencyAssessment: "Invalid milestone consistency seal",
  CanonicalProject: "Canonical seal unavailable",
};
// CASCADE can visit a dependent table's statement trigger first. Only the
// exact history guards used by these tables are eligible, never arbitrary P0001.
const truncateMessages = new Set([
  "Audit records are immutable",
  "Fact history is immutable",
  "Canonical creation history is immutable",
]);

export async function verifyImmutableHistoryMutation(
  database,
  table,
  operation,
) {
  assert(Object.hasOwn(immutableMessages, table), "Unknown history table");
  assert(["UPDATE", "DELETE", "TRUNCATE"].includes(operation));
  const identity =
    table === "MilestoneConsistencyContributorVersion" ? "assessmentId" : "id";
  const sql =
    operation === "UPDATE"
      ? `UPDATE "${table}" SET "${identity}"="${identity}"`
      : operation === "DELETE"
        ? `DELETE FROM "${table}"`
        : `TRUNCATE "${table}" CASCADE`;
  const expected =
    operation === "TRUNCATE"
      ? truncateMessages
      : new Set([
          (operation === "UPDATE" && sealMessages[table]) ||
            immutableMessages[table],
        ]);
  await assert.rejects(
    () =>
      database.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql);
        // Even a regressed/missing trigger must not let this probe commit.
        throw new Error("History mutation unexpectedly succeeded");
      }),
    (error) => {
      const cause = error?.meta?.driverAdapterError?.cause;
      return (
        error?.code === "P2010" &&
        cause?.kind === "postgres" &&
        cause.originalCode === "P0001" &&
        cause.code === "P0001" &&
        expected.has(cause.originalMessage) &&
        cause.message === cause.originalMessage
      );
    },
    `${table} ${operation} must fail at its verified history guard`,
  );
}
