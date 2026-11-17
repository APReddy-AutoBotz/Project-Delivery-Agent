// FR-CON-006/007 / NFR-REL-001: frozen released-27 ACL for genuine upgrade seeding.
// Original first-party file at5fafdaec059f187f5bbd8472760484cf8c4110f1 SHA256 841261ad5d07dd82b997066579400eb5ad5ef4abd955dacb21725d2d304e8fc3
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {assertBusinessTableOwner} from "../../packages/operations/dist/business-grants.js";
// Template-literal line endings are LF, including on a Windows checkout.
const sql=String.raw`
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pdaa_api,pdaa_worker,pdaa_backup;
    GRANT SELECT,INSERT,UPDATE,DELETE ON "Customer","Portfolio","Project","AccessGrant" TO pdaa_api;
    GRANT SELECT,INSERT ON "ConnectorCredential" TO pdaa_api;
    GRANT UPDATE (envelope,"keyId",revision,state,"rotationOperationId","rotationDeadline","auditEventId","changedBy") ON "ConnectorCredential" TO pdaa_api;
    GRANT SELECT,INSERT ON "AuditEvent" TO pdaa_api;
    GRANT SELECT ON "ServiceHeartbeat" TO pdaa_api;
    GRANT SELECT,INSERT,UPDATE ON "ServiceHeartbeat" TO pdaa_worker;
    GRANT SELECT,INSERT ON "ProjectFact","FactSource","FactSourceAccess","FactEvidence","ProjectFactVersion","FactAppendReceipt" TO pdaa_api;
    GRANT UPDATE (revision) ON "ProjectFact" TO pdaa_api;
    GRANT UPDATE (state,revision) ON "FactSourceAccess" TO pdaa_api;
    GRANT SELECT,INSERT,DELETE ON "FactSourceReader" TO pdaa_api;
    GRANT SELECT,INSERT ON "AuthorityPolicy","AuthorityPolicyRevision","AuthorityPolicyReceipt","FactAuthorityConflict","FactAssessment","FactAssessmentVersion","FactAssessmentConflict" TO pdaa_api;
    GRANT UPDATE (revision) ON "AuthorityPolicy" TO pdaa_api;
    GRANT UPDATE (sealed) ON "FactAssessment" TO pdaa_api;
    GRANT SELECT,INSERT ON "Programme","CanonicalProject","ProjectResponsibility","Sprint","Milestone","WorkItem","RequiredWorkItem","RaidItem","CanonicalSourceMapping","CanonicalCreationReceipt" TO pdaa_api;
    GRANT UPDATE (sealed) ON "CanonicalProject" TO pdaa_api;
    GRANT SELECT,INSERT ON "CanonicalStateBinding","CanonicalStateBindingReceipt","MilestoneConsistencyAssessment","MilestoneConsistencyTarget","MilestoneConsistencyContributorVersion" TO pdaa_api;
    GRANT UPDATE (sealed) ON "CanonicalStateBinding","MilestoneConsistencyAssessment" TO pdaa_api;
    GRANT SELECT,INSERT ON "MilestoneReconciliationRequest","MilestoneReconciliationCheck","MilestoneReconciliationAssignment" TO pdaa_api;
    GRANT UPDATE (sealed) ON "MilestoneReconciliationRequest" TO pdaa_api;
    GRANT SELECT,INSERT ON "ScalarReconciliationRequest","ScalarReconciliationCheck","ScalarReconciliationAssignment" TO pdaa_api;
    GRANT UPDATE (sealed) ON "ScalarReconciliationRequest" TO pdaa_api;
    GRANT SELECT,INSERT ON "IngestionSource","IngestionConfigurationRevision","IngestionConfigurationProject","IngestionConfigurationReader","IngestionRetentionPolicy","IngestionExternalRecord","IngestionFactStream","IngestionSourceRevision","IngestionProposalProjection","IngestionProposalContent","IngestionOperationReceipt","IngestionReceiptProjectScope","IngestionCursorTransition","IngestionRowOutcome","IngestionReviewedImport","IngestionReviewedImportRow" TO pdaa_api;
    GRANT SELECT,INSERT ON "ConnectorSyncGrant" TO pdaa_api;
    GRANT UPDATE ("configRevision",revision,active,"changedBy","auditEventId","changedAt") ON "ConnectorSyncGrant" TO pdaa_api;
    GRANT SELECT,INSERT ON "ConnectorSyncJob" TO pdaa_api;
    GRANT UPDATE (state,"resetRequested","resetCompleted",attempts,"availableAt","leaseUntil","completedAt") ON "ConnectorSyncJob" TO pdaa_api;
    GRANT SELECT,INSERT ON "ConnectorWebhookReceipt","IngestionSyncReceiptProjectScope" TO pdaa_api;
    GRANT SELECT,INSERT ON "IngestionProjectReassessment" TO pdaa_api;
    GRANT UPDATE (state,"attemptCount","totalAttempts","recoveryRevision","availableAt","lastReason","claimedGeneration","assessmentId","obligationId","previewId","completedAt","auditEventId") ON "IngestionProjectReassessment" TO pdaa_api;
    REVOKE ALL ON FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment"),public.valid_ingestion_project_reassessment(uuid),public.guard_ingestion_project_reassessment(),public.require_ingestion_reassessment_complete(),public.lock_ingestion_reassessment_preview(),public.reject_ingestion_reassessment_history() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment"),public.valid_ingestion_project_reassessment(uuid) TO pdaa_api;
    GRANT SELECT,INSERT ON "HealthAssessment","HealthAssessmentCommandReceipt" TO pdaa_api;
    GRANT SELECT,INSERT,UPDATE ON "HealthAssessmentRetentionPolicy" TO pdaa_api;
    GRANT SELECT,INSERT,UPDATE ON "BlockerAgeThresholdPolicy" TO pdaa_api;
    GRANT SELECT,INSERT,DELETE ON "ConnectorTaskReceipt" TO pdaa_api;
    GRANT UPDATE ("currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthState","healthCode","healthCheckedAt","lastSuccessReceiptId") ON "IngestionSource" TO pdaa_api;
    GRANT UPDATE (sealed) ON "IngestionConfigurationRevision" TO pdaa_api;
    GRANT UPDATE ("retentionHours",revision,"changedBy","auditEventId","changedAt") ON "IngestionRetentionPolicy" TO pdaa_api;
    GRANT UPDATE (proposals,"redactedAt","redactionAuditEventId") ON "IngestionProposalContent" TO pdaa_api;
    REVOKE ALL ON FUNCTION public.scalar_reconciliation_identity(uuid),public.valid_scalar_reconciliation_assignment(uuid),public.valid_scalar_reconciliation_request(uuid),public.valid_scalar_reconciliation_check(uuid),public.guard_scalar_reconciliation_request(),public.guard_scalar_reconciliation_check(),public.guard_scalar_reconciliation_assignment(),public.require_scalar_reconciliation_complete() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.scalar_reconciliation_identity(uuid),public.valid_scalar_reconciliation_assignment(uuid),public.valid_scalar_reconciliation_request(uuid),public.valid_scalar_reconciliation_check(uuid) TO pdaa_api;
    REVOKE ALL ON FUNCTION public.valid_ingestion_mapping(jsonb),public.valid_ingestion_receipt(uuid),public.valid_ingestion_proposals(jsonb),public.valid_ingestion_projection_content(uuid,jsonb),public.guard_connector_credential(),public.guard_connector_sync_grant(),public.guard_connector_sync_job(),public.guard_connector_webhook_receipt(),public.guard_ingestion_sync_receipt_scope(),public.guard_connector_task_receipt() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    REVOKE ALL ON FUNCTION public.guard_ingestion_reconfiguration_scope(),public.guard_ingestion_retention() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.valid_ingestion_mapping(jsonb),public.valid_ingestion_receipt(uuid),public.valid_ingestion_proposals(jsonb),public.valid_ingestion_projection_content(uuid,jsonb) TO pdaa_api;
    REVOKE ALL ON FUNCTION public.valid_milestone_reconciliation_assignment(uuid),public.valid_milestone_reconciliation_request(uuid),public.valid_milestone_reconciliation_check(uuid),public.guard_milestone_reconciliation_request(),public.guard_milestone_reconciliation_check(),public.guard_milestone_reconciliation_assignment(),public.require_milestone_reconciliation_complete() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.valid_milestone_reconciliation_assignment(uuid),public.valid_milestone_reconciliation_request(uuid),public.valid_milestone_reconciliation_check(uuid) TO pdaa_api;
    -- pg_restore --no-acl recreates the default PUBLIC function EXECUTE grant.
    -- Rebuild migration 5's finite function boundary before its two API grants.
    REVOKE ALL ON FUNCTION public.guard_project_fact_revision(),public.guard_fact_version_append(),public.guard_authority_policy(),public.valid_canonical_state_binding(uuid),public.guard_canonical_state_binding(),public.guard_canonical_state_binding_receipt(),public.require_canonical_state_binding_sealed(),public.valid_milestone_consistency_assessment(uuid),public.guard_assessment_header(),public.guard_milestone_consistency_header(),public.guard_milestone_consistency_child(),public.require_milestone_consistency_sealed(),public.reject_direct_fact_revision(),public.guard_fact_source_birth() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.valid_canonical_state_binding(uuid),public.valid_milestone_consistency_assessment(uuid) TO pdaa_api;
    -- EXEC-015: rebuild the existing update boundary after upgrade/restore.
    GRANT SELECT,INSERT,UPDATE ON "ProjectUpdatePolicy" TO pdaa_api;
    GRANT SELECT,INSERT ON "ProjectUpdatePolicyRevision","ProjectUpdateAssessment","ProjectUpdateObligation","ProjectUpdatePreview","ScheduleHealthPolicyRevision" TO pdaa_api;
    GRANT UPDATE (state,"supersededAt") ON "ProjectUpdateObligation" TO pdaa_api;
    GRANT UPDATE (state) ON "ProjectUpdatePreview" TO pdaa_api;
    REVOKE ALL ON FUNCTION public.valid_project_update_facts(jsonb),public.project_update_json_has_values(jsonb),public.valid_project_update_cadence_offsets(smallint[]),public.prevent_project_update_immutable_rewrite(),public.guard_project_update_preview(),public.guard_project_update_obligation() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.valid_project_update_facts(jsonb),public.project_update_json_has_values(jsonb),public.valid_project_update_cadence_offsets(smallint[]) TO pdaa_api;
    GRANT SELECT,INSERT ON "ProjectUpdateEngagement","ProjectUpdateStage","ProjectUpdateOutbox","ProjectUpdateDispatchAttempt" TO pdaa_api;
    GRANT UPDATE ("ownerSubject",generation,state,"auditEventId","changedAt","sourceSatisfiedFactTypes","sourceAssessmentId","sourceAssessedAt") ON "ProjectUpdateEngagement" TO pdaa_api;
    GRANT UPDATE (state,"claimGeneration","availableAt","leaseUntil","handoffAt","completedAt",reason,"auditEventId") ON "ProjectUpdateOutbox" TO pdaa_api;
    -- Trigger guards remain private; the worker has no business-table access.
    REVOKE ALL ON FUNCTION public.guard_update_engagement_storage(),public.reject_update_engagement_history(),public.guard_update_stage_snapshot(),public.guard_update_outbox(),public.guard_update_attempt_insert(),public.require_update_stage_outbox(),public.record_update_dispatch_attempt() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT SELECT ON "ProjectUpdateIssuanceGate" TO pdaa_api;
    GRANT SELECT,INSERT ON "ProjectUpdateCapturedRequest","ProjectUpdateInvitation","ProjectUpdateResponse","ProjectUpdateRequestContent","ProjectUpdateResponseContent" TO pdaa_api;
    REVOKE ALL ON FUNCTION public.guard_update_issuance_gate(),public.guard_update_capture_birth(),public.guard_update_invitation_birth(),public.guard_update_response_birth(),public.guard_update_capture_content(),public.require_update_capture_complete(),public.lock_update_issuance_gate(uuid),public.purge_update_capture_content(uuid) FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.lock_update_issuance_gate(uuid),public.purge_update_capture_content(uuid) TO pdaa_api;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdaa_backup
`;
export async function applyReleased27BusinessGrants(client) {
  const ledger=(await client.query('SELECT migration_name FROM public."_prisma_migrations" ORDER BY migration_name')).rows;
  assert.equal(ledger.length,27); assert.equal(ledger[26].migration_name,"202611150001_ingestion_retention_audit");
  assert.equal(createHash("sha256").update(sql).digest("hex"),"20f6d9d3448344645b4597176ba15d1583d5d80a1d20190b22f1f95e796fb423");
  await assertBusinessTableOwner(client);
  await client.query(sql);
}
