import { IngestionPersistenceError } from "@pdaa/domain";
import type { Prisma } from "./generated/prisma/client.js";

const maxProjectionIds = 33_000;
export const maxSpreadsheetComparisonContentBytes = 4 * 1024 * 1024;
const unavailable = (): never => {
  throw new IngestionPersistenceError("INVALID_PREVIEW");
};

// The caller holds sorted project/grant fences, policy SHARE, then Source UPDATE.
// Lock and bound whole unique arrays before returning any proposal plaintext.
export async function lockRetainedSpreadsheetContent(tx: Pick<Prisma.TransactionClient, "$queryRaw">, customerId: string, sourceId: string, ids: readonly string[]) {
  const projectionIds = [...new Set(ids)].sort();
  if (projectionIds.length > maxProjectionIds)
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
    if (bytes > maxSpreadsheetComparisonContentBytes) return unavailable();
  }
  return projectionIds;
}
