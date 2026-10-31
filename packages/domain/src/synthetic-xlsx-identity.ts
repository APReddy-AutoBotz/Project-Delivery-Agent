import { z } from "zod";
import { IngestionInputError, ingestionArray, ingestionText, parseIngestion } from "./connector.js";

// Synthetic identity experiment only: every digest and identifier is a caller
// assertion. These bytes do not create a receipt, prove workbook contents,
// authorize a user, or define a production baseline canonicalization.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().min(1).max(2_147_483_647);
const parserContract = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const baseline = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ABSENT") }).strict(),
  z.object({ kind: z.literal("PRESENT"), digest }).strict(),
]);
const preview = z.object({
  customerId: uuid, sourceId: uuid, workbookDigest: digest, sheet: ingestionText(256),
  parserContract, configRevision: revision, mappingRevision: revision, baseline,
}).strict();
const selection = z.object({
  customerId: uuid, sourceId: uuid, parentReceiptId: uuid, previewDigest: digest,
  rowOrdinals: ingestionArray(z.number().int().min(1).max(1000), 1000)
    .refine((rows) => rows.length > 0 && rows.every((row, index) => index === 0 || rows[index - 1]! < row)),
}).strict();

// The synthetic seam rejects ordinary accessors and inherited/extra properties;
// arbitrary in-process Proxy traps are not an isolation boundary.
function ownObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const invalid = (): never => { throw new IngestionInputError("INVALID_INPUT"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function ownOrdinals(input: unknown): unknown[] {
  const invalid = (): never => { throw new IngestionInputError("INVALID_INPUT"); };
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 1000) return invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== length + 1 || !own.includes("length")) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) return invalid();
    result.push(descriptor.value);
  }
  return result;
}

// Fixed ordered JSON arrays, serialized by ECMAScript JSON.stringify and encoded
// as UTF-8 without Unicode normalization. The data-row ordinals in selection are
// one-based receipt ordinals, not independently verified physical coordinates.
export function syntheticXlsxPreviewIdentity(input: unknown): Uint8Array {
  const candidate = ownObject(input, ["customerId", "sourceId", "workbookDigest", "sheet", "parserContract", "configRevision", "mappingRevision", "baseline"]);
  const baselineInput = candidate.baseline;
  if (!baselineInput || typeof baselineInput !== "object") throw new IngestionInputError("INVALID_INPUT");
  const kind = Object.getOwnPropertyDescriptor(baselineInput, "kind");
  if (!kind || !("value" in kind)) throw new IngestionInputError("INVALID_INPUT");
  candidate.baseline = ownObject(baselineInput, kind.value === "ABSENT" ? ["kind"] : ["kind", "digest"]);
  const value = parseIngestion(preview, candidate);
  const baselineValue = value.baseline.kind === "ABSENT" ? ["ABSENT"] : ["PRESENT", value.baseline.digest];
  return new TextEncoder().encode(JSON.stringify(["pdaa.synthetic.xlsx.preview.v1", value.customerId,
    value.sourceId, value.workbookDigest, value.sheet, value.parserContract,
    value.configRevision, value.mappingRevision, baselineValue]));
}

export function syntheticXlsxSelectionIdentity(input: unknown): Uint8Array {
  const candidate = ownObject(input, ["customerId", "sourceId", "parentReceiptId", "previewDigest", "rowOrdinals"]);
  candidate.rowOrdinals = ownOrdinals(candidate.rowOrdinals);
  const value = parseIngestion(selection, candidate);
  return new TextEncoder().encode(JSON.stringify(["pdaa.synthetic.xlsx.selection.v1", value.customerId,
    value.sourceId, value.parentReceiptId, value.previewDigest, value.rowOrdinals]));
}
