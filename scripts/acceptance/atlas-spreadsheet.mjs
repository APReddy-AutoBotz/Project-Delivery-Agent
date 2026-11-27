import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { atlasSpreadsheetOrigin, atlasSpreadsheetRow, parseCsvPreview } from "../../packages/domain/dist/index.js";

const atlasSpreadsheet = `Key,Project,Baseline,Forecast\n${atlasSpreadsheetRow},{project},2026-10-15,2026-10-29\n`;
const fields = [
  { column: "Baseline", factType: "project.baseline", type: "date", required: true },
  { column: "Forecast", factType: "project.forecast", type: "date", required: true },
];

export function atlasSpreadsheetDates() {
  const { headers, rows } = parseCsvPreview(atlasSpreadsheet);
  assert.deepEqual(headers, ["Key", "Project", ...fields.map(({ column }) => column)]);
  assert.equal(rows.length, 1);
  const [, , baselineEnd, forecastEnd] = rows[0];
  return { baselineEnd, forecastEnd };
}

export async function reviewAtlasSpreadsheet(ingestion, actor, projectId, readers) {
  const { sourceId, configRevision, mappingRevision } = await ingestion.configure(actor, {
    binding: { customerId: actor.customerId, sourceId: randomUUID(), sourceType: "csv",
      origin: atlasSpreadsheetOrigin },
    projects: [{ projectId, readers }],
    mapping: { kind: "CSV", sheet: "Portfolio", identityColumn: "Key", projectColumn: "Project", fields },
  }, randomUUID());
  const preview = await ingestion.persistCsvPreview(actor, {
    sourceId, configRevision, mappingRevision, commandKey: randomUUID(), fileName: "atlas-portfolio.csv",
    csv: atlasSpreadsheet.replace("{project}", projectId),
  }, randomUUID());
  assert.equal(preview.rowCount, 1);
  const reviewed = await ingestion.commitCsvReviewedImport(actor, {
    sourceId, previewReceiptId: preview.receiptId, rowOrdinals: [1], commandKey: randomUUID(),
  }, randomUUID());
  assert.equal(reviewed.rowCount, 1);
  return { sourceId, receiptId: reviewed.receiptId, previewReceiptId: preview.receiptId };
}
