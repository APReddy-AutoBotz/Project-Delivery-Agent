import type { Client } from "pg";

export async function assertBusinessTableOwner(client: Pick<Client, "query">) {
  const principals = (
    await client.query(
      "SELECT current_user AS name,rolsuper FROM pg_roles WHERE rolname=current_user",
    )
  ).rows;
  if (
    principals.length !== 1 ||
    (principals[0].name !== "pdaa_migrate" && !principals[0].rolsuper)
  )
    throw new Error("Migration owner required");
  const invalid = (
    await client.query(`
    SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND pg_get_userbyid(c.relowner) <> 'pdaa_migrate'
  `)
  ).rows[0].n;
  if (invalid !== 0) throw new Error("Unexpected business table owner");
}
// NFR-SEC-001, TR-STACK-005: public-table ownership only; also used by upgrades.
export async function applyBusinessTableGrants(client: Pick<Client, "query">) {
  // A read-only principal can receive GRANT/REVOKE warnings without a SQL error.
  // Check authority explicitly so a no-op is never reported as an applied ACL.
  await assertBusinessTableOwner(client);
  await client.query(`
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
    GRANT EXECUTE ON FUNCTION public.valid_canonical_state_binding(uuid),public.valid_milestone_consistency_assessment(uuid) TO pdaa_api;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO pdaa_backup
  `);
}
