import { z } from "zod";
import { IngestionInputError, ingestionText, parseIngestion } from "./connector.js";
import { spreadsheetBaselineSchema } from "./spreadsheet-preview.js";

// Experimental ordered-input identity only. It does not prove config
// compatibility, workbook contents, authorization, provenance or a receipt.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const binding = z.object({ customerId: uuid, sourceId: uuid, sheet: ingestionText(256),
  mappingRevision: z.number().int().min(1).max(2_147_483_647) }).strict();
const maximum = 1_048_576;
const invalid = (): never => { throw new IngestionInputError("INVALID_INPUT"); };

// Reject ordinary getters, inherited objects, symbols, extra properties and
// sparse arrays. Arbitrary Proxy traps and already-allocated input are outside
// this synthetic seam's protection.
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key))) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function array(input: unknown, limit: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) return invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== length + 1 || !own.includes("length")) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    result.push(descriptor.value);
  }
  return result;
}

// Count the exact encoded JSON, including escaped text and punctuation, before
// joining the bounded output. No numeric or Unicode normalization is applied.
function writer() {
  const encoder = new TextEncoder(), chunks: Uint8Array[] = []; let length = 0;
  return {
    add(text: string) {
      const bytes = encoder.encode(text);
      length += bytes.length;
      if (length > maximum) return invalid();
      chunks.push(bytes);
    },
    finish() {
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    },
  };
}
function scalar(input: unknown): string {
  if (typeof input === "string") {
    if (input.length > 4096 || /[\0\p{Surrogate}]/u.test(input)) return invalid();
  } else if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) return invalid();
  } else if (typeof input !== "boolean" && input !== null) return invalid();
  return JSON.stringify(input);
}

// The input baseline is caller-asserted. PRESENT preserves exact row/field
// ordering and permits an empty list; ABSENT is distinct. Mapping revision is
// bridged to the existing schema as the exact canonical decimal integer string.
export function syntheticXlsxBaselineBytes(input: unknown): Uint8Array {
  const root = object(input, ["customerId", "sourceId", "sheet", "mappingRevision", "baseline"]);
  const scope = parseIngestion(binding, { customerId: root.customerId, sourceId: root.sourceId,
    sheet: root.sheet, mappingRevision: root.mappingRevision });
  if (!root.baseline || typeof root.baseline !== "object") return invalid();
  const kind = Object.getOwnPropertyDescriptor(root.baseline, "kind");
  if (!kind || !("value" in kind)) return invalid();
  const value = object(root.baseline, kind.value === "ABSENT" ? ["kind"] : ["kind", "rows"]);
  if (value.kind !== "ABSENT" && value.kind !== "PRESENT") return invalid();
  const out = writer();
  out.add("[");
  for (const part of ["pdaa.synthetic.xlsx.baseline.v1", scope.customerId, scope.sourceId, scope.sheet, scope.mappingRevision]) {
    out.add(scalar(part)); out.add(",");
  }
  out.add(value.kind === "ABSENT" ? '["ABSENT"]]' : '["PRESENT",[');
  if (value.kind === "PRESENT") {
    const copiedRows: unknown[] = [];
    const rows = array(value.rows, 1000);
    for (const [rowIndex, rowValue] of rows.entries()) {
      const row = object(rowValue, ["key", "projectId", "fields"]);
      const fields = array(row.fields, 32), copiedFields: unknown[] = [];
      if (rowIndex) out.add(",");
      out.add("["); out.add(scalar(row.key)); out.add(","); out.add(scalar(row.projectId)); out.add(",[");
      for (const [fieldIndex, fieldValue] of fields.entries()) {
        const field = object(fieldValue, ["factType", "value"]), fact = object(field.value, ["type", "value"]);
        if (fieldIndex) out.add(",");
        out.add("["); out.add(scalar(field.factType)); out.add(",["); out.add(scalar(fact.type)); out.add(","); out.add(scalar(fact.value)); out.add("]]");
        copiedFields.push({ factType: field.factType, value: { type: fact.type, value: fact.value } });
      }
      out.add("]]"); copiedRows.push({ key: row.key, projectId: row.projectId, fields: copiedFields });
    }
    out.add("]]]");
    parseIngestion(spreadsheetBaselineSchema, { customerId: scope.customerId, sourceId: scope.sourceId,
      sheet: scope.sheet, mappingRevision: String(scope.mappingRevision), rows: copiedRows });
  }
  return out.finish();
}
