import { expect, it } from "vitest";
import { assertUpgradeInventory } from "../scripts/acceptance/upgrade-inventory-receipt.mjs";
const old = [
  "Customer",
  "Portfolio",
  "Project",
  "AccessGrant",
  "AuditEvent",
  "ConnectorCredential",
  "ServiceHeartbeat",
];
const added = [
  "ProjectFact",
  "FactSource",
  "FactSourceAccess",
  "FactSourceReader",
  "FactEvidence",
  "ProjectFactVersion",
  "FactAppendReceipt",
  "AuthorityPolicy",
  "AuthorityPolicyRevision",
  "AuthorityPolicyReceipt",
  "FactAuthorityConflict",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
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
  "CanonicalStateBinding",
  "CanonicalStateBindingReceipt",
  "MilestoneConsistencyAssessment",
  "MilestoneConsistencyTarget",
  "MilestoneConsistencyContributorVersion",
  "MilestoneReconciliationRequest",
  "MilestoneReconciliationCheck",
  "MilestoneReconciliationAssignment",
  "ScalarReconciliationRequest",
  "ScalarReconciliationCheck",
  "ScalarReconciliationAssignment",
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
  "ConnectorSyncGrant",
  "ConnectorSyncJob",
  "ConnectorWebhookReceipt",
  "ConnectorTaskReceipt",
  "IngestionSyncReceiptProjectScope",
  "HealthAssessmentRetentionPolicy",
  "HealthAssessment",
  "HealthAssessmentCommandReceipt",
  "RaidReopenReceipt",
  "BlockerAgeThresholdPolicy",
  "ProjectUpdatePolicy",
  "ProjectUpdatePolicyRevision",
  "ProjectUpdateAssessment",
  "ProjectUpdateObligation",
  "ProjectUpdatePreview",
];
const receipt = () => ({
  priorMigrationCount: 1,
  businessTableCount: 68,
  retainedPriorBusinessTables: [...old],
  retainedPriorRowCounts: Object.fromEntries(old.map((table) => [table, 1])),
  emptyAddedTablesAfterUpgrade: [...added],
});
it("NFR-REL-001: accepts the exact independent prior and added table inventories", () => {
  expect(assertUpgradeInventory(receipt(), 1)).toBe(true);
});
it("NFR-REL-001: keeps feature-added RAID receipts out of retained prefix-four history", () => {
  const retainedPriorTables = [
    ...old,
    "ProjectFact",
    "FactSource",
    "FactSourceAccess",
    "FactSourceReader",
    "FactEvidence",
    "ProjectFactVersion",
    "FactAppendReceipt",
    "AuthorityPolicy",
    "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt",
    "FactAuthorityConflict",
    "FactAssessment",
    "FactAssessmentVersion",
    "FactAssessmentConflict",
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
  ];
  const value = receipt();
  value.priorMigrationCount = 4;
  value.retainedPriorBusinessTables = retainedPriorTables;
  value.retainedPriorRowCounts = Object.fromEntries(
    retainedPriorTables.map((table) => [table, 1]),
  );
  value.emptyAddedTablesAfterUpgrade = added.filter(
    (table) => !retainedPriorTables.includes(table),
  );
  expect(value.emptyAddedTablesAfterUpgrade).toContain("RaidReopenReceipt");
  expect(assertUpgradeInventory(value, 4)).toBe(true);
});
it("NFR-REL-001: accepts project update tables as migration seven additions", () => {
  const prior = [...old, ...added.slice(0, added.indexOf("ProjectUpdatePolicy"))];
  const value = receipt();
  value.priorMigrationCount = 6;
  value.retainedPriorBusinessTables = prior;
  value.retainedPriorRowCounts = Object.fromEntries(prior.map((table) => [table, 1]));
  value.emptyAddedTablesAfterUpgrade = added.filter((table) => !prior.includes(table));
  expect(value.emptyAddedTablesAfterUpgrade).toEqual([
    "ProjectUpdatePolicy",
    "ProjectUpdatePolicyRevision",
    "ProjectUpdateAssessment",
    "ProjectUpdateObligation",
    "ProjectUpdatePreview",
  ]);
  expect(assertUpgradeInventory(value, 6)).toBe(true);
});
