import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  IngestionPersistenceError,
  xlsxSourceProvisionSchema,
} from "@pdaa/domain";
import { assertBusinessTableOwner } from "./business-grants.js";
import { assertPostgres17, connect, type OperationsConfig } from "./config.js";
import { assertCustomer } from "./provision.js";

export async function readXlsxSourceProvision(path: string) {
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of createReadStream(path)) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, length),
    );
    return xlsxSourceProvisionSchema.parse(JSON.parse(text));
  } catch {
    throw new Error("Invalid XLSX source manifest");
  }
}

export async function provisionXlsxSource(
  config: OperationsConfig,
  value: unknown,
) {
  const parsed = xlsxSourceProvisionSchema.safeParse(value);
  if (!parsed.success || parsed.data.binding.customerId !== config.customerId)
    throw new IngestionPersistenceError("INVALID_REQUEST");
  const {
    binding: { customerId, sourceId, origin },
    changedBy,
    mapping,
  } = parsed.data;
  const projects = parsed.data.projects
    .map(({ projectId, readers }) => ({
      projectId,
      readers: [...readers].sort(),
    }))
    .sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
  const projectIds = projects.map(({ projectId }) => projectId);
  const mappingJson = JSON.stringify(mapping);
  const base = { sourceId, configRevision: 1, mappingRevision: 1 };
  const client = await connect(config.database);
  try {
    await assertPostgres17(client);
    const owner = await client.query(
      "SELECT session_user='pdaa_migrate' AND current_user='pdaa_migrate' AS valid",
    );
    if (owner.rows[0]?.valid !== true)
      throw new IngestionPersistenceError("DENIED");
    await assertBusinessTableOwner(client);
    await client.query("BEGIN");
    try {
      // Use the same maintenance lock as release, provision and restore.
      await client.query("SELECT pg_advisory_xact_lock(72707370)");
      await assertCustomer(client, config);
      const {
        rows: [database],
      } = await client.query(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
      );
      if (database?.marker !== `pdaa.foundation.v1:${customerId}`)
        throw new IngestionPersistenceError("DENIED");
      const lockedProjects = await client.query(
        'SELECT id FROM public."Project" WHERE "customerId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
        [customerId, projectIds],
      );
      if (lockedProjects.rowCount !== projectIds.length)
        throw new IngestionPersistenceError("DENIED");
      const { rows: grants } = await client.query<{ id: string }>(
        `SELECT g.id FROM public."AccessGrant" g WHERE g."customerId"=$1
           AND g.subject=$3 AND g.role='pmo_admin' AND EXISTS (
             SELECT 1 FROM public."Project" p WHERE p."customerId"=$1 AND p.id=ANY($2::uuid[])
               AND ((g."scopeType"='project' AND g."scopeId"=p.id)
                 OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
         ORDER BY g.id FOR SHARE OF g`,
        [customerId, projectIds, changedBy],
      );
      const {
        rows: [authorized],
      } = await client.query(
        `SELECT NOT EXISTS (
           SELECT 1 FROM public."Project" p WHERE p."customerId"=$1 AND p.id=ANY($2::uuid[])
           AND NOT EXISTS (SELECT 1 FROM public."AccessGrant" g WHERE g."customerId"=$1
             AND g.id=ANY($3::uuid[]) AND g.subject=$4 AND g.role='pmo_admin'
             AND ((g."scopeType"='project' AND g."scopeId"=p.id)
               OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))) AS allowed`,
        [customerId, projectIds, grants.map(({ id }) => id), changedBy],
      );
      if (authorized?.allowed !== true)
        throw new IngestionPersistenceError("DENIED");
      const {
        rows: [existing],
      } = await client.query(
        `SELECT s."customerId",s."inputFamily",s.origin FROM public."IngestionSource" s
         WHERE s.id=$1 FOR UPDATE`,
        [sourceId],
      );
      if (existing) {
        if (
          existing.customerId !== customerId ||
          existing.inputFamily !== "XLSX" ||
          existing.origin !== origin
        )
          throw new IngestionPersistenceError("CONFLICT");
        const {
          rows: [original],
        } = await client.query(
          `SELECT c.mapping=$3::jsonb AND c."changedBy"=$4 AS exact
           FROM public."IngestionConfigurationRevision" c WHERE c."customerId"=$1 AND c."sourceId"=$2
             AND c.revision=1 AND c."mappingRevision"=1 AND c.sealed`,
          [customerId, sourceId, mappingJson, changedBy],
        );
        const { rows: archived } = await client.query<{
          projectId: string;
          readers: string[];
        }>(
          `SELECT p."projectId",coalesce(array_agg(r.subject) FILTER(WHERE r.subject IS NOT NULL),'{}') AS readers
           FROM public."IngestionConfigurationProject" p LEFT JOIN public."IngestionConfigurationReader" r
             USING ("customerId","sourceId","configRevision","projectId")
           WHERE p."customerId"=$1 AND p."sourceId"=$2 AND p."configRevision"=1
           GROUP BY p."projectId" ORDER BY p."projectId"`,
          [customerId, sourceId],
        );
        const exactScope =
          archived.length === projects.length &&
          archived.every(
            ({ projectId, readers }, index) =>
              projectId === projects[index]!.projectId &&
              JSON.stringify(readers.sort()) ===
                JSON.stringify(projects[index]!.readers),
          );
        if (original?.exact !== true || !exactScope)
          throw new IngestionPersistenceError("CONFLICT");
        const {
          rows: [head],
        } = await client.query(
          "SELECT public.valid_ingestion_xlsx_head($1,$2) AS valid",
          [customerId, sourceId],
        );
        if (head?.valid !== true)
          throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
        await client.query("COMMIT");
        return { ...base, replayed: true };
      }

      const auditId = randomUUID();
      await client.query(
        `INSERT INTO public."IngestionSource" (id,"customerId","sourceType",origin,"inputFamily")
         VALUES ($1,$2,'xlsx',$3,'XLSX')`,
        [sourceId, customerId, origin],
      );
      await client.query(
        `INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail)
         VALUES ($1,$2,$3,'ingestion.configuration.changed',$4,
           jsonb_build_object('sourceId',$5::uuid,'configRevision',1,'mappingRevision',1))`,
        [auditId, customerId, changedBy, randomUUID(), sourceId],
      );
      await client.query(
        `INSERT INTO public."IngestionConfigurationRevision"
           ("customerId","sourceId",revision,"mappingRevision",mapping,"changedBy","auditEventId","createdAt")
         SELECT $1::uuid,$2::uuid,1,1,$3::jsonb,$4,id,"occurredAt" FROM public."AuditEvent" WHERE id=$5`,
        [customerId, sourceId, mappingJson, changedBy, auditId],
      );
      await client.query(
        `INSERT INTO public."IngestionConfigurationProject" ("customerId","sourceId","configRevision","projectId")
         SELECT $1::uuid,$2::uuid,1,p FROM unnest($3::uuid[]) p`,
        [customerId, sourceId, projectIds],
      );
      await client.query(
        `INSERT INTO public."IngestionConfigurationReader" ("customerId","sourceId","configRevision","projectId",subject)
         SELECT $1::uuid,$2::uuid,1,p."projectId",r FROM jsonb_to_recordset($3::jsonb) p("projectId" uuid,readers jsonb)
           CROSS JOIN LATERAL jsonb_array_elements_text(p.readers) r`,
        [customerId, sourceId, JSON.stringify(projects)],
      );
      await client.query(
        'UPDATE public."IngestionConfigurationRevision" SET sealed=true WHERE "customerId"=$1 AND "sourceId"=$2 AND revision=1',
        [customerId, sourceId],
      );
      await client.query(
        `UPDATE public."IngestionSource" SET "currentConfigRevision"=1,"mappingRevision"=1,"cursorState"='RESET_REQUIRED'
         WHERE "customerId"=$1 AND id=$2`,
        [customerId, sourceId],
      );
      await client.query("COMMIT");
      return { ...base, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof IngestionPersistenceError) throw error;
      throw new IngestionPersistenceError("PERSISTENCE_FAILED");
    }
  } finally {
    await client.end();
  }
}
