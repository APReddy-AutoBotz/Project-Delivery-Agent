import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  connect,
  assertPostgres17,
  assertEmptyTarget,
  assertNoOtherSessions,
  identifier,
  type OperationsConfig,
} from "./config.js";
import { assertCustomer, grants, verifyRoles } from "./provision.js";
import { history, validateHistory, type Migration } from "./migrations.js";
import { archivePath, openArchive, requireRestoreTmpfs } from "./archive.js";
import { postgresTool } from "./backup.js";
import { createRestoreDiagnostic } from "./restore-diagnostic.js";

async function restoreOwners(client: Awaited<ReturnType<typeof connect>>) {
  // Extension objects retain extension ownership. All first-party objects receive
  // their reviewed owner; --no-owner must not collapse the worker/migration boundary.
  await client.query(`DO $$ DECLARE item record; owner_name text; BEGIN
    FOR item IN SELECT c.relname,n.nspname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','graphile_worker') AND c.relkind IN ('r','p','v','m','S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      ORDER BY (c.relkind='S'),n.nspname,c.relname
    LOOP
      owner_name := CASE WHEN item.nspname='public' THEN 'pdaa_migrate' ELSE 'pdaa_worker' END;
      EXECUTE format('ALTER %s %I.%I OWNER TO %I',CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,item.nspname,item.relname,owner_name);
    END LOOP;
    FOR item IN SELECT t.typname,n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid
      WHERE n.nspname IN ('public','graphile_worker') AND (t.typtype IN ('e','d') OR (t.typtype='c' AND c.relkind='c'))
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
    LOOP
      owner_name := CASE WHEN item.nspname='public' THEN 'pdaa_migrate' ELSE 'pdaa_worker' END;
      EXECUTE format('ALTER TYPE %I.%I OWNER TO %I',item.nspname,item.typname,owner_name);
    END LOOP;
    FOR item IN SELECT p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','graphile_worker') AND p.prokind='f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    LOOP
      owner_name := CASE WHEN item.nspname='public' THEN 'pdaa_migrate' ELSE 'pdaa_worker' END;
      EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO %I',item.nspname,item.proname,item.args,owner_name);
    END LOOP;
  END $$;
  ALTER SCHEMA public OWNER TO pdaa_migrate; ALTER SCHEMA graphile_worker OWNER TO pdaa_worker`);
}
async function purgeExpiredIngestionContent(
  client: Awaited<ReturnType<typeof connect>>,
  customerId: string,
) {
  const expired = (
    await client.query(`SELECT count(*)::int AS n FROM "IngestionProposalContent" c
      JOIN "IngestionProposalProjection" p ON p.id=c."projectionId" AND p."customerId"=c."customerId"
      JOIN "IngestionSourceRevision" r ON r.id=p."sourceRevisionId" AND r."customerId"=p."customerId"
      JOIN "IngestionRetentionPolicy" policy ON policy."customerId"=c."customerId"
      WHERE c."customerId"=$1 AND c.proposals IS NOT NULL AND c."redactedAt" IS NULL
        AND r."receivedAt"+make_interval(hours=>policy."retentionHours")<=CURRENT_TIMESTAMP`,
    [customerId],
  )).rows[0]!.n as number;
  if (expired === 0) return 0;
  const auditEventId = randomUUID();
  await client.query(
    `INSERT INTO "AuditEvent" (id,"customerId",actor,event,"correlationId",detail)
      VALUES ($1,$2,'restore:quarantine','ingestion.content.purged','ingestion.restore.quarantine',$3::jsonb)`,
    [auditEventId, customerId, JSON.stringify({ redactedCount: expired })],
  );
  const redacted = await client.query(`UPDATE "IngestionProposalContent" c
    SET proposals=NULL,"redactedAt"=CURRENT_TIMESTAMP,"redactionAuditEventId"=$1
    FROM "IngestionProposalProjection" p,"IngestionSourceRevision" r,"IngestionRetentionPolicy" policy
    WHERE p.id=c."projectionId" AND p."customerId"=c."customerId"
      AND r.id=p."sourceRevisionId" AND r."customerId"=p."customerId"
      AND policy."customerId"=c."customerId"
      AND c."customerId"=$2 AND c.proposals IS NOT NULL AND c."redactedAt" IS NULL
      AND r."receivedAt"+make_interval(hours=>policy."retentionHours")<=CURRENT_TIMESTAMP`,
    [auditEventId, customerId],
  );
  if (redacted.rowCount !== expired)
    throw new Error("Expired ingestion content changed during restore");
  return redacted.rowCount;
}
export async function restore(
  config: OperationsConfig,
  migrations: Migration[],
  directory: string,
  name: string,
  key: Buffer,
) {
  const diagnostic = createRestoreDiagnostic();
  try {
    return await restoreArchive(
      config,
      migrations,
      directory,
      name,
      key,
      diagnostic,
    );
  } catch (error) {
    diagnostic.failed();
    try {
      diagnostic.report();
    } catch {
      // Diagnostic output must never replace the original restore failure.
    }
    throw error;
  }
}
async function restoreArchive(
  config: OperationsConfig,
  migrations: Migration[],
  directory: string,
  name: string,
  key: Buffer,
  diagnostic: ReturnType<typeof createRestoreDiagnostic>,
) {
  requireRestoreTmpfs();
  const source = archivePath(directory, name);
  const temporary = mkdtempSync("/tmp/pdaa-restore-");
  const plaintext = join(temporary, "archive.dump");
  try {
    // Authentication must finish before any target connection or SQL execution.
    diagnostic.enter("archive_authentication");
    const metadata = await openArchive(source, plaintext, key);
    diagnostic.enter("archive_identity");
    if (
      metadata.customerId !== config.customerId ||
      JSON.stringify(metadata.migrations) !==
        JSON.stringify(
          migrations.map(({ name, checksum }) => ({ name, checksum })),
        ) ||
      metadata.graphileVersion !== 19
    )
      throw new Error("Backup customer or release mismatch");
    if (
      metadata.source.database === config.database.database &&
      metadata.source.host === config.database.host &&
      metadata.source.port === config.database.port
    )
      throw new Error("Source cannot be the restore target");
    diagnostic.enter("target_connection");
    const client = await connect(config.database);
    const db = identifier(config.database.database);
    try {
      diagnostic.enter("target_validation");
      await assertPostgres17(client);
      await verifyRoles(client);
      await client.query("SELECT pg_advisory_lock(72707370)");
      await assertEmptyTarget(client);
      diagnostic.enter("quarantine");
      await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC,pdaa_api,pdaa_worker;
        COMMENT ON DATABASE ${db} IS 'pdaa.restore.quarantine.v1:${config.customerId}'`);
      // CONNECT is checked only during login: commit denial first, then reject
      // sessions that raced that boundary. Never terminate unrelated clients.
      diagnostic.enter("sessions_before_restore");
      await assertNoOtherSessions(client);
      diagnostic.enter("postgres_restore");
      const { child, completed } = postgresTool(
        "pg_restore",
        [
          "--single-transaction",
          "--exit-on-error",
          "--no-owner",
          "--no-acl",
          "--dbname",
          config.database.database,
          plaintext,
        ],
        config,
        temporary,
      );
      child.stdout.resume();
      await completed;
      diagnostic.enter("sessions_after_restore");
      await assertNoOtherSessions(client);
      await client.query("BEGIN");
      try {
        diagnostic.enter("ownership");
        await restoreOwners(client);
        diagnostic.enter("grants");
        await grants(client, config, true);
        diagnostic.enter("customer");
        await assertCustomer(client, config);
        diagnostic.enter("history");
        const applied = await history(client);
        validateHistory(applied, migrations);
        if (applied.length !== migrations.length)
          throw new Error("Restored migration set incomplete");
        diagnostic.enter("integrity");
        await purgeExpiredIngestionContent(client, config.customerId);
        const authorityIntegrity = (
          await client.query(`SELECT
          (SELECT count(*)::int FROM "AuthorityPolicy" WHERE NOT public.valid_authority_history(id)) +
          (SELECT count(*)::int FROM "FactAuthorityConflict" WHERE NOT public.valid_authority_conflict(id)) +
          (SELECT count(*)::int FROM (SELECT "factId" FROM "FactAuthorityConflict" GROUP BY "factId" HAVING count(*)<>max(revision)) drift) +
          (SELECT count(*)::int FROM "FactAssessment" WHERE NOT sealed OR NOT public.valid_fact_assessment(id)) +
          (SELECT count(*)::int FROM "Programme" WHERE NOT public.valid_canonical_programme(id)) +
          (SELECT count(*)::int FROM "CanonicalProject" WHERE NOT sealed OR NOT public.valid_canonical_project(id)) +
          (SELECT count(*)::int FROM "CanonicalStateBinding" WHERE NOT sealed OR NOT public.valid_canonical_state_binding(id)) +
          (SELECT count(*)::int FROM "MilestoneConsistencyAssessment" WHERE NOT sealed OR NOT public.valid_milestone_consistency_assessment(id)) +
          (SELECT count(*)::int FROM "MilestoneReconciliationRequest" WHERE sealed IS NOT TRUE OR public.valid_milestone_reconciliation_request(id) IS NOT TRUE) +
          (SELECT count(*)::int FROM "MilestoneReconciliationCheck" WHERE public.valid_milestone_reconciliation_check(id) IS NOT TRUE) +
          (SELECT count(*)::int FROM "MilestoneReconciliationAssignment" WHERE public.valid_milestone_reconciliation_assignment(id) IS NOT TRUE) +
          (SELECT count(*)::int FROM "ScalarReconciliationRequest" WHERE sealed IS NOT TRUE OR public.valid_scalar_reconciliation_request(id) IS NOT TRUE) +
          (SELECT count(*)::int FROM "ScalarReconciliationCheck" WHERE public.valid_scalar_reconciliation_check(id) IS NOT TRUE) +
          (SELECT count(*)::int FROM "ScalarReconciliationAssignment" WHERE public.valid_scalar_reconciliation_assignment(id) IS NOT TRUE) +
          (SELECT count(*)::int FROM "IngestionOperationReceipt" WHERE public.valid_ingestion_receipt(id) IS NOT TRUE) +
          (SELECT count(*)::int FROM "IngestionProposalContent" WHERE proposals IS NOT NULL AND public.valid_ingestion_proposals("projectionId",proposals) IS NOT TRUE) +
          (SELECT count(*)::int FROM "IngestionExternalRecord" r WHERE NOT EXISTS (SELECT 1 FROM "IngestionSourceRevision" v WHERE v."customerId"=r."customerId" AND v."sourceId"=r."sourceId" AND v."recordId"=r.id)) +
          (SELECT count(*)::int FROM "IngestionSourceRevision" r WHERE NOT EXISTS (SELECT 1 FROM "IngestionProposalProjection" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."recordId"=r."recordId" AND p."sourceRevisionId"=r.id)) +
          (SELECT count(*)::int FROM "IngestionProposalProjection" p WHERE NOT EXISTS (SELECT 1 FROM "IngestionProposalContent" c WHERE c."customerId"=p."customerId" AND c."projectionId"=p.id) OR NOT EXISTS (SELECT 1 FROM "IngestionRowOutcome" o WHERE o."customerId"=p."customerId" AND o."sourceId"=p."sourceId" AND o."projectionId"=p.id AND o.state='ACCEPTED')) +
          (SELECT count(*)::int FROM (SELECT p.id,facts.value FROM "IngestionProposalProjection" p CROSS JOIN LATERAL unnest(p."factTypes") AS facts(value) WHERE NOT EXISTS (SELECT 1 FROM "IngestionFactStream" s WHERE s."customerId"=p."customerId" AND s."sourceId"=p."sourceId" AND s."recordId"=p."recordId" AND s."factType"=facts.value)) missing_streams) +
          (SELECT count(*)::int FROM "IngestionFactStream" s WHERE NOT EXISTS (SELECT 1 FROM "IngestionProposalProjection" p WHERE p."customerId"=s."customerId" AND p."sourceId"=s."sourceId" AND p."recordId"=s."recordId" AND p."factTypes" @> ARRAY[s."factType"]::text[])) +
          (SELECT count(*)::int FROM "FactAssessment" a WHERE a."scalarReconciliationCheckId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "ScalarReconciliationCheck" c WHERE c.id=a."scalarReconciliationCheckId" AND c."assessmentId"=a.id AND c."customerId"=a."customerId" AND c."projectId"=a."projectId" AND c."factId"=a."factId"
          )) +
          (SELECT count(*)::int FROM "MilestoneConsistencyAssessment" a WHERE a."reconciliationCheckId" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "MilestoneReconciliationCheck" c WHERE c.id=a."reconciliationCheckId" AND c."assessmentId"=a.id AND c."customerId"=a."customerId" AND c."projectId"=a."projectId"
          )) AS invalid`)
        ).rows[0].invalid;
        if (authorityIntegrity !== 0)
          throw new Error("Restored authority integrity failed");
        diagnostic.enter("sessions_before_commit");
        await assertNoOtherSessions(client);
        diagnostic.enter("commit");
        await client.query("COMMIT");
      } catch {
        diagnostic.failed();
        await client.query("ROLLBACK");
        throw new Error(
          "Restored ownership or integrity validation failed; target remains quarantined",
        );
      }
      diagnostic.enter("quarantine_verification");
      for (const role of ["pdaa_api", "pdaa_worker"]) {
        if (
          (
            await client.query(
              "SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",
              [role],
            )
          ).rows[0].allowed
        )
          throw new Error("Restore quarantine not enforced");
      }
      return {
        customerId: config.customerId,
        quarantine: true,
        applicationStarted: false,
      };
    } catch (error) {
      diagnostic.failed();
      throw error;
    } finally {
      diagnostic.enter("connection_cleanup");
      await client.end();
    }
  } catch (error) {
    diagnostic.failed();
    throw error;
  } finally {
    diagnostic.enter("plaintext_cleanup");
    rmSync(temporary, { recursive: true, force: true });
  }
}

