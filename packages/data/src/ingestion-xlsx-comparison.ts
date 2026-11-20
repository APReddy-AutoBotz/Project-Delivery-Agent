// FR-CON-006/007: transaction-local comparison for native workbook proposals.
import { createHash } from "node:crypto";
import {
  IngestionPersistenceError,
  ingestionArray,
  ingestionProposalSchema,
  projectFactIdSchema,
  serializeXlsxComparisonState,
  xlsxMappingRevisionSchema,
  xlsxParserContractSchema,
  xlsxSheetSchema,
  type Actor,
  type SpreadsheetHashedBaseline,
} from "@pdaa/domain";
import { z } from "zod";
import { actorInput } from "./fact-authorization.js";
import type { Prisma } from "./generated/prisma/client.js";
import { authorizeIngestionProjects, ingestionWriteRoles } from "./ingestion-project-authorization.js";
import {
  lockRetainedSpreadsheetContent,
  maxSpreadsheetComparisonContentBytes,
} from "./ingestion-spreadsheet-content.js";

type Tx = Pick<Prisma.TransactionClient, "$queryRaw"> & { $transaction?: never };
const request = z.strictObject({
  sourceId: projectFactIdSchema,
  configRevision: xlsxMappingRevisionSchema,
  mappingRevision: xlsxMappingRevisionSchema,
  sheet: xlsxSheetSchema,
  parserContract: xlsxParserContractSchema,
});
type Expected = z.infer<typeof request>;
type WorkbookState = ReturnType<typeof serializeXlsxComparisonState>["state"];
type WorkbookComparison = Readonly<{
  scope: Readonly<Expected & { customerId: string; subject: string; projectIds: readonly string[] }>;
  predecessor: Readonly<
    { kind: "GENESIS"; stateSha256: string } |
    { kind: "RETAINED"; stateSha256: string; receiptId: string; revision: number }
  >;
  canonicalHistoryBytes: bigint;
  state: WorkbookState;
  baseline: Readonly<SpreadsheetHashedBaseline>;
}>;
type Head = {
  activationConfigRevision: number;
  mappingRevision: number;
  genesisSha256: string;
  dictionary: unknown;
  revision: number;
  currentReceiptId: string | null;
  stateSha256: string | null;
  canonicalHistoryBytes: bigint;
};
const proposalsSchema = ingestionArray(ingestionProposalSchema, 32);
const maxProjects = 100;
const maxContexts = 4096;
const maxHistoryBytes = 256n * 1024n * 1024n;
const maxStateBytes = 2 * 1024 * 1024;

function unavailable(): never {
  throw new IngestionPersistenceError("INVALID_PREVIEW");
}

async function lockWorkbookScope(tx: Tx, actor: Actor, expected: Expected) {
  const { customerId, subject } = actor;
  const { sourceId, configRevision, mappingRevision, sheet, parserContract } = expected;
  const roles = actor.roles.filter((role) => ingestionWriteRoles.includes(role));
  if (!roles.length) throw new IngestionPersistenceError("DENIED");

  // Plan from the current source. Establish preliminary entitlement before
  // locks so a denied caller receives no contention or configuration detail.
  const planned = await tx.$queryRaw<{ projectId: string; revision: number; entitled: boolean }[]>`
    SELECT cp."projectId",s."currentConfigRevision" AS revision,
      EXISTS (
        SELECT 1 FROM public."IngestionConfigurationReader" r
        WHERE r."customerId"=cp."customerId" AND r."sourceId"=cp."sourceId"
          AND r."configRevision"=cp."configRevision" AND r."projectId"=cp."projectId" AND r.subject=${subject}
      ) AND EXISTS (
        SELECT 1 FROM public."AccessGrant" g WHERE g."customerId"=p."customerId" AND g.subject=${subject}
          AND g.role=ANY(${roles}::text[]) AND (("scopeType"='project' AND "scopeId"=p.id)
            OR ("scopeType"='portfolio' AND "scopeId"=p."portfolioId"))
      ) AS entitled
    FROM public."IngestionSource" s
    JOIN public."IngestionConfigurationProject" cp ON cp."customerId"=s."customerId" AND cp."sourceId"=s.id
      AND cp."configRevision"=s."currentConfigRevision"
    JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
    WHERE s."customerId"=${customerId}::uuid AND s.id=${sourceId}::uuid AND s."inputFamily"='XLSX'
    ORDER BY cp."projectId" LIMIT ${maxProjects + 1}`;
  if (!planned.length || planned.length > maxProjects || planned.some(({ entitled }) => !entitled))
    throw new IngestionPersistenceError("DENIED");
  const projectIds = planned.map(({ projectId }) => projectId);
  await authorizeIngestionProjects(tx, actor, projectIds, "write");
  const policy = await tx.$queryRaw<{ revision: number }[]>`
    SELECT revision FROM public."IngestionRetentionPolicy"
    WHERE "customerId"=${customerId}::uuid FOR SHARE`;
  if (policy.length !== 1) return unavailable();

  const [source] = await tx.$queryRaw<{ configRevision: number; mappingRevision: number }[]>`
    SELECT "currentConfigRevision" AS "configRevision","mappingRevision"
    FROM public."IngestionSource" WHERE "customerId"=${customerId}::uuid AND id=${sourceId}::uuid
      AND "inputFamily"='XLSX' FOR UPDATE`;
  if (source?.configRevision !== planned[0]!.revision)
    throw new IngestionPersistenceError("STALE_CONFIGURATION");

  const [scope] = await tx.$queryRaw<{ projects: string[]; readers: string[]; exact: boolean }[]>`
    SELECT ARRAY(SELECT cp."projectId" FROM public."IngestionConfigurationProject" cp
        WHERE cp."customerId"=c."customerId" AND cp."sourceId"=c."sourceId" AND cp."configRevision"=c.revision
        ORDER BY cp."projectId" LIMIT ${maxProjects + 1}) AS projects,
      ARRAY(SELECT r."projectId" FROM public."IngestionConfigurationReader" r
        WHERE r."customerId"=c."customerId" AND r."sourceId"=c."sourceId" AND r."configRevision"=c.revision
          AND r.subject=${subject} ORDER BY r."projectId" LIMIT ${maxProjects + 1}) AS readers,
      (c.revision=${configRevision}::integer AND c."mappingRevision"=${mappingRevision}::integer
        AND c.mapping->>'sheet'=${sheet}::text AND c.mapping->>'parserContract'=${parserContract}::text) AS exact
    FROM public."IngestionConfigurationRevision" c
    WHERE c."customerId"=${customerId}::uuid AND c."sourceId"=${sourceId}::uuid
      AND c.revision=${source.configRevision}::integer AND c."mappingRevision"=${source.mappingRevision}::integer
      AND c.sealed AND c.mapping->>'kind'='XLSX'`;
  if (!scope || scope.projects.length !== projectIds.length || scope.readers.length !== projectIds.length ||
      projectIds.some((id, index) => scope.projects[index] !== id || scope.readers[index] !== id))
    throw new IngestionPersistenceError("DENIED");
  if (!scope.exact) throw new IngestionPersistenceError("STALE_CONFIGURATION");
  return Object.freeze(projectIds);
}

async function loadWorkbookState(tx: Tx, customerId: string, expected: Expected, projectIds: readonly string[]) {
  const { sourceId, mappingRevision, sheet, parserContract } = expected;
  const [head] = await tx.$queryRaw<Head[]>`
    SELECT "activationConfigRevision","mappingRevision","genesisSha256",dictionary,revision,
      "currentReceiptId","stateSha256","canonicalHistoryBytes"
    FROM public."IngestionXlsxHead"
    WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid FOR UPDATE`;
  if (!head || head.mappingRevision !== mappingRevision || head.revision < 0 || head.revision >= maxContexts ||
      head.canonicalHistoryBytes < 0n || head.canonicalHistoryBytes >= maxHistoryBytes)
    return unavailable();
  const [check] = await tx.$queryRaw<{ valid: boolean }[]>`
    SELECT public.valid_ingestion_xlsx_head(${customerId}::uuid,${sourceId}::uuid) AS valid`;
  if (!check?.valid) return unavailable();

  const [receipt] = head.currentReceiptId === null ? [] : await tx.$queryRaw<{ configRevision: number }[]>`
    SELECT "configRevision" FROM public."IngestionOperationReceipt"
    WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid
      AND id=${head.currentReceiptId}::uuid AND kind='XLSX_PREVIEW'`;
  if (head.revision > 0 && (!receipt || !head.currentReceiptId || !head.stateSha256)) return unavailable();
  const priorScope = await tx.$queryRaw<{ projectId: string }[]>`
    SELECT "projectId" FROM public."IngestionConfigurationProject"
    WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid
      AND "configRevision"=${receipt?.configRevision ?? head.activationConfigRevision}::integer
    ORDER BY "projectId" LIMIT ${maxProjects + 1}`;
  const authorized = new Set(projectIds);
  if (!priorScope.length || priorScope.length > maxProjects || priorScope.some(({ projectId }) => !authorized.has(projectId)))
    return unavailable();

  let rows: unknown = [];
  let canonicalBytes: number | undefined;
  if (head.currentReceiptId !== null) {
    const [proof] = await tx.$queryRaw<{ valid: boolean }[]>`
      SELECT public.valid_ingestion_xlsx_context(${head.currentReceiptId}::uuid) AS valid`;
    if (!proof?.valid) return unavailable();
    const [context] = await tx.$queryRaw<{ rows: unknown; canonicalBytes: number }[]>`
      SELECT rows,"canonicalBytes" FROM public."IngestionXlsxContext"
      WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid
        AND "receiptId"=${head.currentReceiptId}::uuid AND revision=${head.revision}::integer
        AND "stateSha256"=${head.stateSha256}::text AND "canonicalBytes" BETWEEN 1 AND ${maxStateBytes}`;
    if (!context) return unavailable();
    rows = context.rows;
    canonicalBytes = context.canonicalBytes;
  }
  const encoded = serializeXlsxComparisonState([
    "pdaa.xlsx.comparison-state.v1", customerId, sourceId, mappingRevision, sheet, parserContract, head.dictionary, rows,
  ]);
  const stateSha256 = createHash("sha256").update(encoded.text).digest("hex");
  if (stateSha256 !== (head.stateSha256 ?? head.genesisSha256) ||
      (canonicalBytes !== undefined && encoded.bytes !== canonicalBytes) ||
      encoded.state[7].some((row) => !authorized.has(row[2])))
    return unavailable();
  const predecessor = head.currentReceiptId === null
    ? Object.freeze({ kind: "GENESIS" as const, stateSha256 })
    : Object.freeze({ kind: "RETAINED" as const, receiptId: head.currentReceiptId, revision: head.revision, stateSha256 });
  return { predecessor, state: encoded.state, canonicalHistoryBytes: head.canonicalHistoryBytes };
}

async function materializeWorkbookBaseline(
  tx: Tx,
  state: WorkbookState,
) {
  const [, customerId, sourceId, mappingRevision, sheet, , dictionary, identities] = state;
  const lineage = new Map<string, { keyHash: string; recordId: string; projectId: string }>();
  for (const [keyHash, recordId, projectId, refs] of identities) {
    for (const [, projectionId] of refs) {
      const previous = lineage.get(projectionId);
      if (previous && previous.keyHash !== keyHash) return unavailable();
      lineage.set(projectionId, { keyHash, recordId, projectId });
    }
  }
  const projectionIds = await lockRetainedSpreadsheetContent(
    tx, customerId, sourceId, [...lineage.keys()],
  );
  const anchors = projectionIds.map((id) => lineage.get(id)!);
  // Match the authenticated head's exact retained record and project in SQL
  // before any proposal plaintext is returned to the transaction caller.
  const contents = await tx.$queryRaw<{ projectionId: string; recordId: string; projectId: string; proposals: unknown }[]>`
    SELECT c."projectionId",p."recordId",e."projectId",c.proposals
    FROM public."IngestionProposalContent" c
    JOIN public."IngestionProposalProjection" p ON p."customerId"=c."customerId" AND p."sourceId"=c."sourceId"
      AND p."recordId"=c."recordId" AND p.id=c."projectionId"
    JOIN public."IngestionExternalRecord" e ON e."customerId"=p."customerId" AND e."sourceId"=p."sourceId"
      AND e.id=p."recordId"
    JOIN unnest(${projectionIds}::uuid[],${anchors.map(({ recordId }) => recordId)}::uuid[],
      ${anchors.map(({ projectId }) => projectId)}::uuid[],${anchors.map(({ keyHash }) => keyHash)}::text[])
      AS ref(projection_id,record_id,project_id,key_hash)
      ON ref.projection_id=p.id AND ref.record_id=p."recordId" AND ref.project_id=e."projectId"
        AND ref.key_hash COLLATE "C"=e."recordKey" COLLATE "C"
    JOIN public."IngestionSourceRevision" v ON v."customerId"=p."customerId" AND v."sourceId"=p."sourceId"
      AND v."recordId"=p."recordId" AND v.id=p."sourceRevisionId"
    JOIN public."IngestionRetentionPolicy" policy ON policy."customerId"=c."customerId"
    WHERE c."customerId"=${customerId}::uuid AND c."sourceId"=${sourceId}::uuid
      AND p."mappingRevision"=${mappingRevision}::integer AND e."recordType"=${`xlsx:${sheet}`}::text
      AND c.proposals IS NOT NULL AND c."redactedAt" IS NULL
      AND v."receivedAt"+make_interval(hours=>policy."retentionHours")>clock_timestamp()
    ORDER BY c."projectionId"`;
  if (contents.length !== projectionIds.length) return unavailable();
  const types = new Map(dictionary);
  const byProjection = new Map(contents.map(({ projectionId, recordId, projectId, proposals }) => {
    const parsed = proposalsSchema.safeParse(proposals);
    if (!parsed.success) return unavailable();
    const fields = new Map(parsed.data.map((proposal) => {
      const { value } = proposal;
      if (types.get(proposal.factType) !== value.type ||
          (value.type === "text" && (!value.value || /^[=+\-@]/u.test(value.value.trimStart()))) ||
          (value.type === "number" && Math.abs(value.value) > Number.MAX_SAFE_INTEGER))
        return unavailable();
      Object.freeze(value);
      return [proposal.factType, Object.freeze(proposal)] as const;
    }));
    return [projectionId, { recordId, projectId, fields }] as const;
  }));
  const baseline: SpreadsheetHashedBaseline = {
    customerId, sourceId, sheet, mappingRevision: String(mappingRevision),
    rows: identities.map(([keyHash, recordId, projectId, refs]) => {
      const fields = refs.map(([index, projectionId]) => {
        const projection = byProjection.get(projectionId);
        const proposal = projection?.fields.get(dictionary[Number(index)]![0]);
        if (!proposal || projection?.recordId !== recordId || projection.projectId !== projectId) return unavailable();
        return proposal;
      });
      Object.freeze(fields);
      return Object.freeze({ keyHash, projectId, fields });
    }),
  };
  if (Buffer.byteLength(JSON.stringify(baseline), "utf8") > maxSpreadsheetComparisonContentBytes)
    return unavailable();
  Object.freeze(baseline.rows);
  return Object.freeze(baseline);
}

// The result is for the same owner transaction. It cannot authorize a later write.
export async function loadXlsxComparison(tx: Tx, actorValue: Actor, input: unknown): Promise<WorkbookComparison> {
  const [role] = await tx.$queryRaw<{ owner: boolean }[]>`SELECT current_user='pdaa_migrate' AS owner`;
  if (!role?.owner) throw new IngestionPersistenceError("DENIED");
  const expected = request.safeParse(input);
  if (!expected.success) throw new IngestionPersistenceError("INVALID_REQUEST");
  let actor: Actor;
  try { actor = actorInput(actorValue); }
  catch { throw new IngestionPersistenceError("INVALID_REQUEST"); }
  const projectIds = await lockWorkbookScope(tx, actor, expected.data);
  const current = await loadWorkbookState(tx, actor.customerId, expected.data, projectIds);
  const baseline = await materializeWorkbookBaseline(tx, current.state);
  return Object.freeze({
    scope: Object.freeze({ customerId: actor.customerId, subject: actor.subject, ...expected.data, projectIds }),
    ...current,
    baseline,
  });
}
