import type { Client } from "pg";

export async function assertXlsxGenesisIntegrity(
  client: Pick<Client, "query">,
) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::int FROM public."IngestionXlsxHead" h
      WHERE public.valid_ingestion_xlsx_genesis(h."customerId",h."sourceId") IS NOT TRUE)
    + (SELECT count(*)::int FROM public."IngestionSource" s
      WHERE s."inputFamily"='XLSX' AND NOT EXISTS (SELECT 1 FROM public."IngestionXlsxHead" h
        WHERE h."customerId"=s."customerId" AND h."sourceId"=s.id))
    + (SELECT count(*)::int FROM public."IngestionConfigurationRevision" c
      JOIN public."IngestionSource" s ON s."customerId"=c."customerId" AND s.id=c."sourceId"
      WHERE c.sealed AND (s."inputFamily"='XLSX') <> coalesce(c.mapping->>'kind'='XLSX',false)) AS invalid`);
  if (rows[0]?.invalid !== 0)
    throw new Error("Restored workbook genesis is invalid");
}

export async function assertXlsxPreviewIntegrity(client: Pick<Client, "query">) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::int FROM public."IngestionXlsxHead" h
      WHERE public.valid_ingestion_xlsx_head(h."customerId",h."sourceId") IS NOT TRUE)
    + (SELECT count(*)::int FROM public."IngestionXlsxContext" c
      WHERE public.valid_ingestion_xlsx_context(c."receiptId") IS NOT TRUE)
    + (SELECT count(*)::int FROM public."IngestionOperationReceipt" r WHERE r.kind='XLSX_PREVIEW'
      AND NOT EXISTS (SELECT 1 FROM public."IngestionXlsxContext" c WHERE c."customerId"=r."customerId"
        AND c."sourceId"=r."sourceId" AND c."receiptId"=r.id)) AS invalid`);
  if (rows[0]?.invalid !== 0) throw new Error("Restored workbook previews are invalid");
}

export async function assertXlsxReviewedImportIntegrity(client: Pick<Client, "query">) {
  const { rows } = await client.query(`SELECT count(*)::int AS invalid
    FROM public."IngestionOperationReceipt" r WHERE r.kind='XLSX_REVIEWED_IMPORT'
      AND public.valid_ingestion_xlsx_reviewed_import(r.id) IS NOT TRUE`);
  if (rows[0]?.invalid !== 0) throw new Error("Restored workbook reviewed imports are invalid");
}
