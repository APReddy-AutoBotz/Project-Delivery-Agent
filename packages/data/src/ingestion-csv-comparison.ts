// FR-CON-006/007/012 / NFR-SEC-001: server-owned, reference-only CSV history.
import { createHash } from "node:crypto";
import {
  applyCsvComparisonObservations,
  CSV_COMPARISON_LIMITS,
  IngestionPersistenceError,
  ingestionProposalSchema,
  parseCsvComparisonState,
  parseIngestion,
  serializeCsvComparisonState,
  type CsvComparisonState,
  type CsvComparisonIdentity,
  type IngestionConfiguration,
  type SpreadsheetHashedBaseline,
} from "@pdaa/domain";
import type { Prisma } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
type Head = {
  activationConfigRevision: number;
  mappingRevision: number;
  dictionary: unknown;
  readiness: string;
  revision: bigint;
  currentReceiptId: string | null;
  stateHash: string | null;
  canonicalHistoryBytes: bigint;
};
type Prior = {
  customerId: string;
  sourceId: string;
  head: Head;
  state: CsvComparisonState;
  projectionIds: string[];
  baseline: SpreadsheetHashedBaseline;
};
const unavailable = (): never => {
  throw new IngestionPersistenceError("INVALID_PREVIEW");
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// The caller holds sorted project/grant fences, policy SHARE, then Source UPDATE.
// Lock and bound whole unique arrays before returning any proposal plaintext.
async function retainedContent(tx: Tx, customerId: string, sourceId: string, ids: readonly string[]) {
  const projectionIds = [...new Set(ids)].sort();
  if (projectionIds.length > CSV_COMPARISON_LIMITS.identities * (CSV_COMPARISON_LIMITS.fields + 1))
    return unavailable();
  const content = await tx.$queryRaw<{ projectionId: string; bytes: number | null; live: boolean }[]>`
    SELECT c."projectionId",octet_length(c.proposals::text) AS bytes,
      (c.proposals IS NOT NULL AND c."redactedAt" IS NULL
        AND v."receivedAt"+make_interval(hours=>policy."retentionHours")>clock_timestamp()
        AND public.valid_ingestion_projection_content(c."projectionId",c.proposals) IS TRUE) AS live
    FROM public."IngestionProposalContent" c
    JOIN public."IngestionProposalProjection" p ON p.id=c."projectionId" AND p."customerId"=c."customerId"
      AND p."sourceId"=c."sourceId" AND p."recordId"=c."recordId"
    JOIN public."IngestionSourceRevision" v ON v.id=p."sourceRevisionId" AND v."customerId"=p."customerId"
      AND v."sourceId"=p."sourceId" AND v."recordId"=p."recordId"
    JOIN public."IngestionRetentionPolicy" policy ON policy."customerId"=c."customerId"
    WHERE c."customerId"=${customerId}::uuid AND c."sourceId"=${sourceId}::uuid
      AND c."projectionId"=ANY(${projectionIds}::uuid[])
    ORDER BY c."projectionId" FOR SHARE OF c`;
  if (content.length !== projectionIds.length) return unavailable();
  let bytes = 0;
  for (const row of content) {
    if (!row.live || row.bytes === null || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
      return unavailable();
    bytes += row.bytes;
    if (bytes > CSV_COMPARISON_LIMITS.contentUnionBytes) return unavailable();
  }
  return projectionIds;
}

export async function loadCsvComparison(
  tx: Tx,
  customerId: string,
  sourceId: string,
  configRevision: number,
  mappingRevision: number,
  configuration: IngestionConfiguration,
): Promise<Prior> {
  if (configuration.mapping.kind !== "CSV") return unavailable();
  const heads = await tx.$queryRaw<Head[]>`
    SELECT "activationConfigRevision","mappingRevision",dictionary,readiness,revision,"currentReceiptId","stateHash","canonicalHistoryBytes"
    FROM public."IngestionCsvHead"
    WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid FOR UPDATE`;
  const head = heads[0];
  if (!head || head.readiness !== "READY" || head.mappingRevision !== mappingRevision || head.stateHash === null ||
    head.revision < 0n || head.revision >= BigInt(CSV_COMPARISON_LIMITS.contexts) ||
    head.canonicalHistoryBytes < 0n || head.canonicalHistoryBytes >= BigInt(CSV_COMPARISON_LIMITS.canonicalHistoryBytes))
    return unavailable();
  const validity = await tx.$queryRaw<{ valid: boolean; compatible: boolean }[]>`
    SELECT public.valid_ingestion_csv_head(${customerId}::uuid,${sourceId}::uuid) AS valid,
      EXISTS (SELECT 1 FROM public."IngestionConfigurationRevision" activation
        JOIN public."IngestionConfigurationRevision" current_config ON current_config."customerId"=activation."customerId"
          AND current_config."sourceId"=activation."sourceId" AND current_config.revision=${configRevision}
          AND current_config."mappingRevision"=activation."mappingRevision" AND current_config.sealed
        WHERE activation."customerId"=${customerId}::uuid AND activation."sourceId"=${sourceId}::uuid
          AND activation.revision=${head.activationConfigRevision} AND activation.sealed
          AND current_config.mapping=activation.mapping) AS compatible`;
  if (!validity[0]?.valid || !validity[0].compatible) return unavailable();
  let rows: unknown = [];
  let priorConfigRevision = head.activationConfigRevision;
  if (head.revision > 0n) {
    const contexts = await tx.$queryRaw<{ rows: unknown; configRevision: number }[]>`
      SELECT rows,"configRevision" FROM public."IngestionCsvContext"
      WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid
        AND "receiptId"=${head.currentReceiptId}::uuid AND revision=${head.revision}
        AND "canonicalBytes" BETWEEN 1 AND ${CSV_COMPARISON_LIMITS.canonicalBytes}`;
    if (!contexts[0]) return unavailable();
    rows = contexts[0].rows;
    priorConfigRevision = contexts[0].configRevision;
  }
  let state: CsvComparisonState;
  try {
    state = parseCsvComparisonState(["pdaa.csv.state.v1",customerId,sourceId,String(mappingRevision),head.dictionary,rows]);
  } catch { return unavailable(); }
  const projectIds = new Set(configuration.projects.map((project) => project.projectId));
  const previousScope = await tx.$queryRaw<{ projectId: string }[]>`
    SELECT "projectId" FROM public."IngestionConfigurationProject"
    WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid AND "configRevision"=${priorConfigRevision}
    ORDER BY "projectId" LIMIT 101`;
  if (!previousScope.length || previousScope.length > 100 || previousScope.some((row) => !projectIds.has(row.projectId)))
    return unavailable();
  if (state[5].some((row) => !projectIds.has(row[2])) || digest(JSON.stringify(state)) !== head.stateHash)
    return unavailable();
  const projectionIds = await retainedContent(tx, customerId, sourceId, state[5].flatMap((row) => row[3].map((ref) => ref[1])));
  const contents = await tx.$queryRaw<{ projectionId: string; proposals: unknown }[]>`
    SELECT "projectionId",proposals FROM public."IngestionProposalContent"
    WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid
      AND "projectionId"=ANY(${projectionIds}::uuid[]) ORDER BY "projectionId"`;
  const proposalsByProjection = new Map(contents.map((row) => [row.projectionId,
    parseIngestion(ingestionProposalSchema.array().max(CSV_COMPARISON_LIMITS.fields),row.proposals)]));
  const baseline: SpreadsheetHashedBaseline = {
    customerId,sourceId,sheet:configuration.mapping.sheet,mappingRevision:String(mappingRevision),
    rows: state[5].map(([keyHash,,projectId,refs]) => ({
      keyHash,projectId,fields: refs.map(([index,projectionId]) => {
        const [factType,valueType] = state[4][Number(index)]!;
        const proposal = proposalsByProjection.get(projectionId)?.find((field) => field.factType === factType);
        if (!proposal || proposal.value.type !== valueType) return unavailable();
        return proposal;
      }),
    })),
  };
  return { customerId,sourceId,head,state,projectionIds,baseline };
}

export async function saveCsvComparison(
  tx: Tx,
  prior: Prior,
  receiptId: string,
  configRevision: number,
  accepted: readonly { recordKey: string; recordId: string; projectId: string; projectionId: string; proposals: readonly { factType: string }[] }[],
) {
  await retainedContent(tx,prior.customerId,prior.sourceId,[...prior.projectionIds,...accepted.map((row) => row.projectionId)]);
  const dictionary = new Map(prior.state[4].map(([factType],index) => [factType,String(index)]));
  const observations: CsvComparisonIdentity[] = accepted.map((row): CsvComparisonIdentity => [row.recordKey,row.recordId,row.projectId,
    row.proposals.map((proposal) => {
      const index = dictionary.get(proposal.factType);
      if (index === undefined) return unavailable();
      return [index,row.projectionId] as const;
    }).sort(([a],[b]) => Number(a)-Number(b)),
  ]).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
  let encoded: ReturnType<typeof serializeCsvComparisonState>;
  try { encoded = serializeCsvComparisonState(applyCsvComparisonObservations(prior.state,observations)); }
  catch { return unavailable(); }
  const historyBytes = prior.head.canonicalHistoryBytes+BigInt(encoded.bytes);
  if (historyBytes > BigInt(CSV_COMPARISON_LIMITS.canonicalHistoryBytes)) return unavailable();
  const stateHash = digest(encoded.text);
  const revision = prior.head.revision+1n;
  await tx.$executeRaw`
    INSERT INTO public."IngestionCsvContext" ("customerId","sourceId","receiptId","configRevision","mappingRevision",revision,"predecessorReceiptId","predecessorRevision","predecessorHash",rows,"canonicalBytes","stateHash")
    VALUES (${prior.customerId}::uuid,${prior.sourceId}::uuid,${receiptId}::uuid,${configRevision},${prior.head.mappingRevision},${revision},
      ${prior.head.currentReceiptId}::uuid,${prior.head.revision},${prior.head.stateHash},${JSON.stringify(encoded.state[5])}::jsonb,${encoded.bytes},${stateHash})`;
  const advanced = await tx.$executeRaw`
    UPDATE public."IngestionCsvHead" SET revision=${revision},"currentReceiptId"=${receiptId}::uuid,"stateHash"=${stateHash},"canonicalHistoryBytes"=${historyBytes}
    WHERE "customerId"=${prior.customerId}::uuid AND "sourceId"=${prior.sourceId}::uuid
      AND revision=${prior.head.revision} AND "currentReceiptId" IS NOT DISTINCT FROM ${prior.head.currentReceiptId}::uuid
      AND "stateHash"=${prior.head.stateHash} AND "canonicalHistoryBytes"=${prior.head.canonicalHistoryBytes}`;
  if (advanced !== 1) throw new IngestionPersistenceError("CONFLICT");
  const validity = await tx.$queryRaw<{ valid: boolean }[]>`
    SELECT public.valid_ingestion_csv_context(${receiptId}::uuid)
      AND public.valid_ingestion_csv_head(${prior.customerId}::uuid,${prior.sourceId}::uuid)
      AND public.valid_ingestion_receipt(${receiptId}::uuid) AS valid`;
  if (!validity[0]?.valid) throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
}
