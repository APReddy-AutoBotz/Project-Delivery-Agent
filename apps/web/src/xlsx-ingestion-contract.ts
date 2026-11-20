import type {
  ingestionReviewedImportResultSchema,
  xlsxCataloguePageSchema,
  xlsxPreviewPageSchema,
  xlsxPreviewReviewDetailsSchema,
  xlsxReviewedImportRequestSchema,
} from "@pdaa/domain";
import { uuid } from "./evidence-state.js";

export type Catalogue = ReturnType<typeof xlsxCataloguePageSchema.parse>;
export type XlsxSource = Catalogue["sources"][number];
export type PreviewPage = ReturnType<typeof xlsxPreviewPageSchema.parse>;
export type ReviewDetails = ReturnType<typeof xlsxPreviewReviewDetailsSchema.parse>;
export type ReviewResult = ReturnType<typeof ingestionReviewedImportResultSchema.parse>;
export type ReviewCommand = Omit<ReturnType<typeof xlsxReviewedImportRequestSchema.parse>, "sourceId">;
export type PreviewResult = { receiptId: string; replayed: boolean; rowCount: number };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const revision = (value: unknown) => integer(value, 1, 2_147_483_647);
const instant = (value: unknown) => text(value, 40) && Number.isFinite(Date.parse(value));
const factType = (value: unknown) => text(value, 96) && /^[a-z][a-z0-9_.-]*$/.test(value);
const valueTypes = ["text", "date", "number", "boolean"];
const rowStates = ["ACCEPTED", "INVALID", "REVIEW_REQUIRED"];
const operations = ["CREATE", "UPDATE", "UNCHANGED", "NONE"];
const selectionStates = ["OPEN", "REVIEWED", "STALE"];
const errors = new Set([
  "INVALID_INPUT", "INVALID_KEY", "DUPLICATE_KEY", "INVALID_PROJECT", "PROJECT_CHANGED",
  "INVALID_FIELDS", "ROW_IDENTITY_REVIEW", "REQUIRED_VALUE", "INVALID_FORMULA",
  "INVALID_NUMBER", "INVALID_VALUE",
]);

function requireValid<T>(valid: boolean, value: unknown): T {
  if (!valid) throw new Error("Unexpected Excel import response.");
  return value as T;
}

export function readCatalogue(value: unknown, after: string | null): Catalogue {
  return requireValid(object(value) && Array.isArray(value.sources) && value.sources.length <= 50 &&
    value.sources.every((source, index, sources) => object(source) && id(source.sourceId) &&
      source.sourceId > (sources[index - 1]?.sourceId ?? after ?? "") &&
      revision(source.configRevision) && revision(source.mappingRevision) && text(source.sheet, 31)) &&
    (value.nextSourceId === null || (value.sources.length === 50 &&
      value.nextSourceId === value.sources.at(-1)?.sourceId)), value);
}

function proposal(value: unknown): boolean {
  if (!object(value) || !factType(value.factType) || !object(value.value)) return false;
  const { type, value: scalar } = value.value;
  switch (type) {
    case "text": return typeof scalar === "string" && scalar.length <= 4096;
    case "date": return typeof scalar === "string" && /^\d{4}-\d{2}-\d{2}$/.test(scalar);
    case "number": return typeof scalar === "number" && Number.isFinite(scalar);
    case "boolean": return typeof scalar === "boolean";
    case "empty": return scalar === null;
    default: return false;
  }
}

function row(value: unknown, ordinal: number, open: boolean) {
  return object(value) && value.ordinal === ordinal && typeof value.state === "string" &&
    rowStates.includes(value.state) && typeof value.operation === "string" && operations.includes(value.operation) &&
    Array.isArray(value.errorCodes) && value.errorCodes.length <= 16 && value.errorCodes.every((code) => errors.has(code)) &&
    (value.projectId === null || id(value.projectId)) && typeof value.contentAvailable === "boolean" &&
    value.contentAvailable === (value.proposals !== null) &&
    value.selectable === (open && value.contentAvailable && value.operation !== "NONE") &&
    (!value.contentAvailable || (value.state === "ACCEPTED" && value.projectId !== null && value.errorCodes.length === 0)) &&
    (value.proposals === null || (Array.isArray(value.proposals) && value.proposals.length <= 32 &&
      value.proposals.every(proposal)));
}

export function readPreviewPage(value: unknown, sourceId: string, receiptId: string, after: number): PreviewPage {
  if (!object(value) || value.sourceId !== sourceId || value.previewReceiptId !== receiptId ||
    !revision(value.configRevision) || !revision(value.mappingRevision) || !instant(value.createdAt) ||
    !integer(value.rowCount, after, 1000) || typeof value.previewContextSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.previewContextSha256) ||
    typeof value.selectionState !== "string" || !selectionStates.includes(value.selectionState) ||
    !Array.isArray(value.outcomes) || value.outcomes.length > 50 ||
    !value.outcomes.every((item, index) => row(item, after + index + 1, value.selectionState === "OPEN")))
    throw new Error("Unexpected Excel preview page.");
  const last = after + value.outcomes.length;
  const next = last < value.rowCount ? last : null;
  return requireValid(last <= value.rowCount && (last > after || after === value.rowCount) &&
    value.nextOrdinal === next, value);
}

export function readReviewDetails(value: unknown, page: PreviewPage): ReviewDetails {
  return requireValid(object(value) && value.sourceId === page.sourceId &&
    value.previewReceiptId === page.previewReceiptId && value.configRevision === page.configRevision &&
    value.mappingRevision === page.mappingRevision && object(value.mapping) && text(value.mapping.sheet, 31) &&
    text(value.mapping.identityColumn, 256) && text(value.mapping.projectColumn, 256) &&
    Array.isArray(value.mapping.fields) && value.mapping.fields.length > 0 && value.mapping.fields.length <= 32 &&
    value.mapping.fields.every((field) => object(field) && text(field.column, 256) && factType(field.factType) &&
      typeof field.type === "string" && valueTypes.includes(field.type) && typeof field.required === "boolean") &&
    (value.reviewedImport === null || (object(value.reviewedImport) && id(value.reviewedImport.receiptId) &&
      value.reviewedImport.receiptId !== page.previewReceiptId && instant(value.reviewedImport.createdAt) &&
      integer(value.reviewedImport.rowCount, 1, page.rowCount))), value);
}

export function readPreviewResult(value: unknown): PreviewResult {
  return requireValid(object(value) && id(value.receiptId) && typeof value.replayed === "boolean" &&
    integer(value.rowCount, 0, 1000), value);
}

export function readReviewResult(value: unknown, command: ReviewCommand): ReviewResult {
  return requireValid(object(value) && id(value.receiptId) && value.receiptId !== command.previewReceiptId &&
    value.parentPreviewReceiptId === command.previewReceiptId && typeof value.replayed === "boolean" &&
    value.rowCount === command.rowOrdinals.length, value);
}

export function encodeSheet(sheet: string) {
  const bytes = new TextEncoder().encode(sheet);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
