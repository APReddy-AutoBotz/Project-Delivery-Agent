import type { Client } from "pg";

export async function assertXlsxGenesisIntegrity(
  client: Pick<Client, "query">,
) {
  const { rows } = await client.query(`SELECT
    (SELECT count(*)::int FROM public."IngestionXlsxHead" h
      WHERE public.valid_ingestion_xlsx_genesis(h."customerId",h."sourceId") IS NOT TRUE)
    + (SELECT count(*)::int FROM public."IngestionSource" s
      WHERE s."inputFamily"='XLSX' AND NOT EXISTS (SELECT 1 FROM public."IngestionXlsxHead" h
        WHERE h."customerId"=s."customerId" AND h."sourceId"=s.id)) AS invalid`);
  if (rows[0]?.invalid !== 0)
    throw new Error("Restored workbook genesis is invalid");
}
