export const xlsxIngestionPath = "/api/ingestion/xlsx";
export const xlsxIngestionRoutes = {
  sources: "sources",
  previews: "sources/:sourceId/previews",
  preview: "sources/:sourceId/previews/:previewReceiptId",
  details: "sources/:sourceId/previews/:previewReceiptId/review-details",
  review: "sources/:sourceId/reviewed-imports",
} as const;

export function xlsxContractPath(route: keyof typeof xlsxIngestionRoutes) {
  return xlsxIngestionPath + "/" +
    xlsxIngestionRoutes[route].replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}
