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
  MilestoneReconciliationRequest: "Reconciliation request is immutable",
  MilestoneReconciliationCheck: "Reconciliation check is immutable",
  MilestoneReconciliationAssignment: "Reconciliation assignment is immutable",
  ScalarReconciliationRequest: "Scalar reconciliation request is immutable",
  ScalarReconciliationCheck: "Scalar reconciliation check is immutable",
  ScalarReconciliationAssignment: "Scalar reconciliation assignment is immutable",
  IngestionConfigurationRevision: "Invalid ingestion configuration seal",
  IngestionConfigurationProject: "Ingestion configuration scope is immutable",
  IngestionConfigurationReader: "Ingestion configuration scope is immutable",
  IngestionExternalRecord: "External record identity is immutable",
  IngestionFactStream: "Ingestion history is immutable",
  IngestionSourceRevision: "Ingestion source revision is immutable",
  IngestionProposalProjection: "Ingestion proposal projection is immutable",
  IngestionProposalContent: "Ingestion content permits one-way expiry redaction only",
  IngestionOperationReceipt: "Ingestion operation receipt is immutable",
  IngestionReceiptProjectScope: "Ingestion receipt scope is immutable",
  IngestionSyncReceiptProjectScope: "Ingestion sync receipt scope is immutable",
  ConnectorWebhookReceipt: "Connector webhook receipts are immutable",
  IngestionCursorTransition: "Ingestion cursor transition is immutable",
  IngestionRowOutcome: "Ingestion row outcome is immutable",
  IngestionReviewedImport: "Reviewed import header is immutable",
  IngestionReviewedImportRow: "Reviewed import row linkage is immutable",
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
  MilestoneReconciliationRequest: "Invalid reconciliation request seal",
  ScalarReconciliationRequest: "Invalid scalar reconciliation request seal",
  CanonicalProject: "Canonical seal unavailable",
  IngestionConfigurationRevision: "Invalid ingestion configuration seal",
};
// CASCADE can visit a dependent table's statement trigger first. Only the
// exact history guards used by these tables are eligible, never arbitrary P0001.
const truncateMessages = new Set([
  "Audit records are immutable",
  "Fact history is immutable",
  "Canonical creation history is immutable",
  "Ingestion history is immutable",
  "Connector webhook receipts are immutable",
]);

export async function verifyImmutableHistoryMutation(
  database,
  table,
  operation,
) {
  assert(Object.hasOwn(immutableMessages, table), "Unknown history table");
  assert(["UPDATE", "DELETE", "TRUNCATE"].includes(operation));
  const identity = {
    MilestoneConsistencyContributorVersion: "assessmentId",
    IngestionConfigurationRevision: "revision",
    IngestionConfigurationProject: "projectId",
    IngestionConfigurationReader: "subject",
    IngestionProposalContent: "projectionId",
    IngestionReceiptProjectScope: "receiptId",
    IngestionSyncReceiptProjectScope: "receiptId",
    IngestionCursorTransition: "receiptId",
    IngestionRowOutcome: "receiptId",
    IngestionReviewedImport: "receiptId",
    IngestionReviewedImportRow: "receiptId",
  }[table] ?? "id";
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
