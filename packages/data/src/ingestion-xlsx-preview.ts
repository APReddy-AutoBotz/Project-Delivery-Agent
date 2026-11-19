import { createHash } from "node:crypto";
import {
  IngestionPersistenceError,
  persistedSpreadsheetConfigSchema,
  previewSpreadsheetGridHashedBaseline,
} from "@pdaa/domain";
import { z } from "zod";
import type { captureXlsxPreviewRequest } from "./ingestion-xlsx-binding.js";

type BoundRequest = ReturnType<typeof captureXlsxPreviewRequest>["request"];
export type XlsxPreviewDecoder = {
  tryAcquire(): {
    decode(request: BoundRequest, bytes: Buffer): Promise<unknown>;
    release(): void;
  } | null;
};
const mappingSnapshot = z.strictObject({
  configRevision: z.number().int().min(1).max(2_147_483_647),
  config: persistedSpreadsheetConfigSchema,
});

function xlsxRowKey(sheet: string, key: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["pdaa.xlsx.row-key.v1", sheet, key]))
    .digest("hex");
}

// The revision identifies normalized row content independently of its ordinal
// and the original workbook byte digest.
export function xlsxSourceRowDigest(
  request: Pick<BoundRequest, "sheet" | "parserContract">,
  headers: readonly string[],
  row: readonly string[],
) {
  const cells = headers.map((header, index) => [header, row[index]!] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256")
    .update(JSON.stringify(["pdaa.xlsx.source-row.v1", request.sheet, request.parserContract, cells]))
    .digest("hex");
}

// The repository supplies the mapping snapshot and the complete trusted
// comparison baseline. The adapter must bind the decoded grid to this request
// before mapping it. The returned values are transient proposal preview data.
export function mapBoundXlsxPreviewGrid(
  request: BoundRequest,
  decodedGrid: unknown,
  authorizedMapping: unknown,
  retainedBaseline: unknown,
) {
  const snapshot = mappingSnapshot.safeParse(authorizedMapping);
  if (!snapshot.success) throw new IngestionPersistenceError("INVALID_REQUEST");
  const { config, configRevision } = snapshot.data;
  if (
    configRevision !== request.configRevision ||
    config.mappingRevision !== String(request.mappingRevision) ||
    config.customerId !== request.customerId ||
    config.sourceId !== request.sourceId ||
    config.sheet !== request.sheet
  ) {
    throw new IngestionPersistenceError("STALE_CONFIGURATION");
  }
  return previewSpreadsheetGridHashedBaseline(
    decodedGrid,
    config,
    retainedBaseline,
    xlsxRowKey,
  );
}
