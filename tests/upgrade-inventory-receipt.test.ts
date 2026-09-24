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
  "ConnectorSyncGrant",
  "ConnectorSyncJob",
  "ConnectorWebhookReceipt",
  "ConnectorTaskReceipt",
  "IngestionSyncReceiptProjectScope",
];
const receipt = () => ({
  priorMigrationCount: 1,
  businessTableCount: 61,
  retainedPriorBusinessTables: [...old],
  retainedPriorRowCounts: Object.fromEntries(old.map((table) => [table, 1])),
  emptyAddedTablesAfterUpgrade: [...added],
});
it("NFR-REL-001: accepts the exact independent prior and added table inventories", () => {
  expect(assertUpgradeInventory(receipt(), 1)).toBe(true);
});
it("NFR-REL-001: rejects a self-consistent renamed original table", () => {
  const value = receipt();
  value.retainedPriorBusinessTables[0] = "FakeCustomer";
  delete value.retainedPriorRowCounts.Customer;
  value.retainedPriorRowCounts.FakeCustomer = 1;
  expect(() => assertUpgradeInventory(value, 1)).toThrow();
});
it("NFR-REL-001: rejects empty retained tables, missing new tables and wrong prefixes", () => {
  const empty = receipt();
  empty.retainedPriorRowCounts.Project = 0;
  expect(() => assertUpgradeInventory(empty, 1)).toThrow();
  const missing = receipt();
  missing.emptyAddedTablesAfterUpgrade.pop();
  expect(() => assertUpgradeInventory(missing, 1)).toThrow();
  expect(() => assertUpgradeInventory(receipt(), 6)).toThrow();
});
