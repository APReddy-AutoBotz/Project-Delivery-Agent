// FR-EVD-007/012, NFR-SEC-001: frozen release-6 ACL for genuine pre-7 fixtures.
// SQL copied from released main 2bc8c93; no CONNECT or role-membership changes.
import assert from "node:assert/strict";
import { assertBusinessTableOwner } from "../../packages/operations/dist/business-grants.js";
export async function applyPriorSixBusinessGrants(owner) {
  assert.equal(process.env.PDAA_ACCEPTANCE, "isolated");
  await assertBusinessTableOwner(owner);
  const { rows } = await owner.query(`
    SELECT
      (SELECT count(*)::integer FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed,
      to_regclass('public."MilestoneReconciliationRequest"') IS NOT NULL
        AND to_regclass('public."MilestoneReconciliationCheck"') IS NOT NULL
        AND to_regclass('public."MilestoneReconciliationAssignment"') IS NOT NULL AS reconciliation,
      to_regclass('public."ScalarReconciliationRequest"') IS NOT NULL
        OR to_regclass('public."ScalarReconciliationCheck"') IS NOT NULL
        OR to_regclass('public."ScalarReconciliationAssignment"') IS NOT NULL
        OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='FactAssessment' AND column_name='scalarReconciliationCheckId') AS scalar
  `);
  assert.deepEqual(rows, [
    { completed: 6, reconciliation: true, scalar: false },
  ]);
  await owner.query(`
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pdaa_api,pdaa_worker,pdaa_backup;
    GRANT SELECT,INSERT,UPDATE,DELETE ON "Customer","Portfolio","Project","AccessGrant","ConnectorCredential" TO pdaa_api;
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
    REVOKE ALL ON FUNCTION public.valid_milestone_reconciliation_assignment(uuid),public.valid_milestone_reconciliation_request(uuid),public.valid_milestone_reconciliation_check(uuid),public.guard_milestone_reconciliation_request(),public.guard_milestone_reconciliation_check(),public.guard_milestone_reconciliation_assignment(),public.require_milestone_reconciliation_complete() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.valid_milestone_reconciliation_assignment(uuid),public.valid_milestone_reconciliation_request(uuid),public.valid_milestone_reconciliation_check(uuid) TO pdaa_api;
    -- pg_restore --no-acl recreates the default PUBLIC function EXECUTE grant.
    -- Rebuild migration 5's finite function boundary before its two API grants.
    REVOKE ALL ON FUNCTION public.guard_project_fact_revision(),public.guard_fact_version_append(),public.guard_authority_policy(),public.valid_canonical_state_binding(uuid),public.guard_canonical_state_binding(),public.guard_canonical_state_binding_receipt(),public.require_canonical_state_binding_sealed(),public.valid_milestone_consistency_assessment(uuid),public.guard_assessment_header(),public.guard_milestone_consistency_header(),public.guard_milestone_consistency_child(),public.require_milestone_consistency_sealed(),public.reject_direct_fact_revision(),public.guard_fact_source_birth() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
    GRANT EXECUTE ON FUNCTION public.valid_canonical_state_binding(uuid),public.valid_milestone_consistency_assessment(uuid) TO pdaa_api;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdaa_backup
  `);
}
