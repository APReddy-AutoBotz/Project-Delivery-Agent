// NFR-REL-001/002: independent host inventory; never derive expected names from
// the producer receipt or its mutable exported table lists.
import assert from "node:assert/strict";
const releases = [
  [
    "Customer",
    "Portfolio",
    "Project",
    "AccessGrant",
    "AuditEvent",
    "ConnectorCredential",
    "ServiceHeartbeat",
  ],
  [
    "ProjectFact",
    "FactSource",
    "FactSourceAccess",
    "FactSourceReader",
    "FactEvidence",
    "ProjectFactVersion",
    "FactAppendReceipt",
  ],
  [
    "AuthorityPolicy",
    "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt",
    "FactAuthorityConflict",
    "FactAssessment",
    "FactAssessmentVersion",
    "FactAssessmentConflict",
  ],
  [
    "Programme",
    "CanonicalProject",
    "ProjectResponsibility",
    "Sprint",
    "Milestone",
    "WorkItem",
    "RequiredWorkItem",
    "RaidItem",
    "CanonicalSourceMapping",
    "CanonicalCreationReceipt",
  ],
  [
    "CanonicalStateBinding",
    "CanonicalStateBindingReceipt",
    "MilestoneConsistencyAssessment",
    "MilestoneConsistencyTarget",
    "MilestoneConsistencyContributorVersion",
  ],
  [
    "MilestoneReconciliationRequest",
    "MilestoneReconciliationCheck",
    "MilestoneReconciliationAssignment",
  ],
  [
    "ScalarReconciliationRequest",
    "ScalarReconciliationCheck",
    "ScalarReconciliationAssignment",
  ],
  [
    "IngestionSource",
    "IngestionConfigurationRevision",
    "IngestionConfigurationProject",
    "IngestionConfigurationReader",
    "IngestionRetentionPolicy",
    "IngestionExternalRecord",
    "IngestionFactStream",
    "IngestionSourceRevision",
    "IngestionProposalProjection",
    "IngestionProposalContent",
    "IngestionOperationReceipt",
    "IngestionReceiptProjectScope",
    "IngestionCursorTransition",
    "IngestionRowOutcome",
    "IngestionReviewedImport",
    "IngestionReviewedImportRow",
  ],
  [
    "ConnectorSyncGrant",
    "ConnectorSyncJob",
    "ConnectorWebhookReceipt",
    "ConnectorTaskReceipt",
    "IngestionSyncReceiptProjectScope",
  ],
];
export function assertUpgradeInventory(receipt, prefix) {
  assert([1, 2, 3, 4, 5, 6].includes(prefix));
  assert.equal(receipt.priorMigrationCount, prefix);
  const oldTables = releases.slice(0, prefix).flat().sort();
  const addedTables = releases.slice(prefix).flat().sort();
  assert.equal(receipt.businessTableCount, 63);
  assert.deepEqual([...receipt.retainedPriorBusinessTables].sort(), oldTables);
  assert.deepEqual(
    Object.keys(receipt.retainedPriorRowCounts).sort(),
    oldTables,
  );
  assert(
    Object.values(receipt.retainedPriorRowCounts).every(
      (count) => Number.isInteger(count) && count > 0,
    ),
  );
  assert.deepEqual(
    [...receipt.emptyAddedTablesAfterUpgrade].sort(),
    addedTables,
  );
  return true;
}
