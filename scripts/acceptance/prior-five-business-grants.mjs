// Acceptance-only frozen grants for a genuine five-migration
// fixture BEFORE migration6. SQL inventory copied from released main
// 1c92e92dac63d677b7d7e5d3e562cd53303ea27f business-grants.ts.
// No CONNECT grant, role membership change, migration or trigger bypass.
import assert from "node:assert/strict";

export async function applyPriorFiveBusinessGrants(owner) {
  assert.equal(process.env.PDAA_ACCEPTANCE, "isolated");
  const identity = await owner.query(`
    SELECT current_user AS principal, rolsuper
    FROM pg_roles WHERE rolname = current_user
  `);
  assert.equal(identity.rows.length, 1);
  assert(
    identity.rows[0].principal === "pdaa_migrate" || identity.rows[0].rolsuper,
    "Business grants require the migration owner or fixture administrator",
  );
  const ownership = await owner.query(`
    SELECT count(*)::integer AS count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND r.rolname <> 'pdaa_migrate'
  `);
  assert.equal(ownership.rows[0].count, 0);

  // Defensive scope check, not a substitute for the upgrade runner's exact
  // migration-byte/ledger assertions. Never call this after migration6.
  const prefix = await owner.query(`
    SELECT
      (SELECT count(*)::integer FROM public._prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed,
      to_regclass('public."MilestoneConsistencyAssessment"') IS NOT NULL AS milestone,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'MilestoneConsistencyAssessment'
          AND column_name = 'reconciliationCheckId'
      ) AS reconciliation
  `);
  assert.equal(prefix.rows[0].completed, 5);
  assert.equal(prefix.rows[0].milestone, true);
  assert.equal(prefix.rows[0].reconciliation, false);

  await owner.query(`
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pdaa_api, pdaa_worker, pdaa_backup;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Customer", "Portfolio", "Project", "AccessGrant", "ConnectorCredential" TO pdaa_api;
    GRANT SELECT, INSERT ON "AuditEvent" TO pdaa_api;
    GRANT SELECT ON "ServiceHeartbeat" TO pdaa_api;
    GRANT SELECT, INSERT, UPDATE ON "ServiceHeartbeat" TO pdaa_worker;
    GRANT SELECT, INSERT ON "ProjectFact", "FactSource", "FactSourceAccess", "FactEvidence", "ProjectFactVersion", "FactAppendReceipt" TO pdaa_api;
    GRANT UPDATE (revision) ON "ProjectFact" TO pdaa_api;
    GRANT UPDATE (state, revision) ON "FactSourceAccess" TO pdaa_api;
    GRANT SELECT, INSERT, DELETE ON "FactSourceReader" TO pdaa_api;
    GRANT SELECT, INSERT ON "AuthorityPolicy", "AuthorityPolicyRevision", "AuthorityPolicyReceipt", "FactAuthorityConflict", "FactAssessment", "FactAssessmentVersion", "FactAssessmentConflict" TO pdaa_api;
    GRANT UPDATE (revision) ON "AuthorityPolicy" TO pdaa_api;
    GRANT UPDATE (sealed) ON "FactAssessment" TO pdaa_api;
    GRANT SELECT, INSERT ON "Programme", "CanonicalProject", "ProjectResponsibility", "Sprint", "Milestone", "WorkItem", "RequiredWorkItem", "RaidItem", "CanonicalSourceMapping", "CanonicalCreationReceipt" TO pdaa_api;
    GRANT UPDATE (sealed) ON "CanonicalProject" TO pdaa_api;
    GRANT SELECT, INSERT ON "CanonicalStateBinding", "CanonicalStateBindingReceipt", "MilestoneConsistencyAssessment", "MilestoneConsistencyTarget", "MilestoneConsistencyContributorVersion" TO pdaa_api;
    GRANT UPDATE (sealed) ON "CanonicalStateBinding", "MilestoneConsistencyAssessment" TO pdaa_api;
    REVOKE ALL ON FUNCTION
      public.guard_project_fact_revision(),
      public.guard_fact_version_append(),
      public.guard_authority_policy(),
      public.valid_canonical_state_binding(uuid),
      public.guard_canonical_state_binding(),
      public.guard_canonical_state_binding_receipt(),
      public.require_canonical_state_binding_sealed(),
      public.valid_milestone_consistency_assessment(uuid),
      public.guard_assessment_header(),
      public.guard_milestone_consistency_header(),
      public.guard_milestone_consistency_child(),
      public.require_milestone_consistency_sealed(),
      public.reject_direct_fact_revision(),
      public.guard_fact_source_birth()
    FROM PUBLIC, pdaa_api, pdaa_worker, pdaa_backup;
    GRANT EXECUTE ON FUNCTION
      public.valid_canonical_state_binding(uuid),
      public.valid_milestone_consistency_assessment(uuid)
    TO pdaa_api;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdaa_backup
  `);
}
