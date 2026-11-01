import { z } from "zod";
import { IngestionInputError, ingestionProposalSchema, ingestionText, parseIngestion } from "./connector.js";
import { ingestionSafeErrorSchema } from "./ingestion-persistence.js";

// An unconnected simulation over caller assertions. It is not a receipt,
// authorization decision, workbook validation, retained-content check or proof
// of origin. Proxy traps and already-allocated inputs are outside its boundary.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().min(1).max(2_147_483_647);
const parser = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const scopeSchema = z.object({ customerId: uuid, sourceId: uuid, sheet: ingestionText(256),
  configRevision: revision, mappingRevision: revision, parserContract: parser, parentId: uuid }).strict();
const outcomeSchema = z.object({ ordinal: z.number().int().min(1).max(1000),
  state: z.enum(["ACCEPTED", "INVALID", "REVIEW_REQUIRED"]),
  operation: z.enum(["CREATE", "UPDATE", "UNCHANGED", "NONE"]),
  projectId: uuid.nullable(), recordKey: ingestionText(256).nullable(),
  errors: z.array(ingestionSafeErrorSchema).max(16), contentAvailable: z.boolean(),
  proposals: z.array(ingestionProposalSchema).max(32) }).strict();
type Outcome = z.infer<typeof outcomeSchema>;
const invalid = (): never => { throw new IngestionInputError("INVALID_INPUT"); };
const maximum = 1_048_576;

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
function array(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return invalid();
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

function writer() {
  const encoder = new TextEncoder(), chunks: Uint8Array[] = []; let length = 0;
  return {
    add(text: string) {
      const bytes = encoder.encode(text); length += bytes.length;
      if (length > maximum) return invalid();
      chunks.push(bytes);
    },
    finish() {
      const result = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    },
  };
}
function scalar(value: unknown): string {
  if (typeof value === "string") {
    if (value.length > 4096 || /[\0\p{Surrogate}]/u.test(value)) return invalid();
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) return invalid();
  } else if (typeof value !== "boolean" && value !== null) return invalid();
  return JSON.stringify(value);
}

const scopeKeys = ["customerId", "sourceId", "sheet", "configRevision", "mappingRevision", "parserContract", "parentId"] as const;
function scope(input: Record<string, unknown>) {
  return parseIngestion(scopeSchema, Object.fromEntries(scopeKeys.map((key) => [key, input[key]])));
}
function snapshot(input: unknown) {
  const root = object(input, [...scopeKeys, "workbookDigest", "baseline", "projects", "outcomes"]);
  const bound = scope(root), workbookDigest = parseIngestion(digest, root.workbookDigest);
  if (!root.baseline || typeof root.baseline !== "object") return invalid();
  const kind = Object.getOwnPropertyDescriptor(root.baseline, "kind");
  if (!kind || !("value" in kind)) return invalid();
  const baseline = object(root.baseline, kind.value === "ABSENT" ? ["kind"] : ["kind", "digest"]);
  if (baseline.kind !== "ABSENT" && baseline.kind !== "PRESENT") return invalid();
  const baselineDigest = baseline.kind === "PRESENT" ? parseIngestion(digest, baseline.digest) : null;
  const projects = array(root.projects, 100).map((item) => parseIngestion(uuid, item));
  if (!projects.length || new Set(projects).size !== projects.length) return invalid();
  const values = array(root.outcomes, 1000), copied: Outcome[] = [], seen = new Set<string>();
  const out = writer();
  out.add("[");
  for (const part of ["pdaa.synthetic.xlsx.manifest.v1", ...scopeKeys.map((key) => bound[key]), workbookDigest]) {
    out.add(scalar(part)); out.add(",");
  }
  out.add(baseline.kind === "ABSENT" ? '["ABSENT"],' : '["PRESENT",');
  if (baseline.kind === "PRESENT") { out.add(scalar(baselineDigest)); out.add("],"); }
  out.add("[");
  for (const [index, project] of projects.entries()) { if (index) out.add(","); out.add(scalar(project)); }
  out.add("],[");
  for (const [index, item] of values.entries()) {
    const row = object(item, ["ordinal", "state", "operation", "projectId", "recordKey", "errors", "contentAvailable", "proposals"]);
    const errors = array(row.errors, 16).map((value) => parseIngestion(ingestionSafeErrorSchema, value));
    const values = array(row.proposals, 32), proposals: z.infer<typeof ingestionProposalSchema>[] = [];
    if (index) out.add(",");
    out.add("[");
    for (const part of [row.ordinal, row.state, row.operation, row.projectId, row.recordKey]) { out.add(scalar(part)); out.add(","); }
    out.add("[");
    for (const [errorIndex, error] of errors.entries()) { if (errorIndex) out.add(","); out.add(scalar(error)); }
    out.add("],"); out.add(scalar(row.contentAvailable)); out.add(",[");
    for (const [fieldIndex, item] of values.entries()) {
      const proposal = object(item, ["factType", "value"]), value = object(proposal.value, ["type", "value"]);
      if (fieldIndex) out.add(",");
      out.add("["); out.add(scalar(proposal.factType)); out.add(",["); out.add(scalar(value.type)); out.add(","); out.add(scalar(value.value)); out.add("]]");
      proposals.push(parseIngestion(ingestionProposalSchema, { factType: proposal.factType, value: { type: value.type, value: value.value } }));
    }
    out.add("]]");
    const parsed = parseIngestion(outcomeSchema, { ...row, errors, proposals });
    if (parsed.ordinal !== index + 1 || new Set(parsed.proposals.map((field) => field.factType)).size !== parsed.proposals.length ||
        (parsed.projectId !== null && !projects.includes(parsed.projectId))) return invalid();
    if (parsed.state === "ACCEPTED") {
      if (parsed.operation === "NONE" || parsed.errors.length || !parsed.projectId || !parsed.recordKey || seen.has(parsed.recordKey) ||
          (!parsed.contentAvailable && parsed.proposals.length)) return invalid();
      seen.add(parsed.recordKey);
    } else if (parsed.operation !== "NONE" || !parsed.errors.length || parsed.contentAvailable || parsed.proposals.length) return invalid();
    copied.push(parsed);
  }
  out.add("]]");
  return { bound, rows: copied, bytes: out.finish() };
}

// Full-manifest digest is a distinct domain from #146's request identity.
// The returned bytes describe assertions only; no digest proves a real parent.
export function syntheticXlsxManifestBytes(input: unknown): Uint8Array {
  return snapshot(input).bytes;
}

export async function simulateSyntheticXlsxSelection(manifest: unknown, selection: unknown) {
  const copied = snapshot(manifest);
  const request = object(selection, [...scopeKeys, "manifestDigest", "ordinals"]);
  const expected = scope(request), manifestDigest = parseIngestion(digest, request.manifestDigest);
  const ordinals = array(request.ordinals, 1000).map((value) => parseIngestion(z.number().int().min(1).max(1000), value));
  if (!ordinals.length || ordinals.some((value, index) => index > 0 && ordinals[index - 1]! >= value) ||
      scopeKeys.some((key) => copied.bound[key] !== expected[key])) return invalid();
  let hashed: ArrayBuffer;
  try { hashed = await globalThis.crypto.subtle.digest("SHA-256", copied.bytes); }
  catch { return invalid(); }
  const actual = Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== manifestDigest) return invalid();
  return ordinals.map((ordinal) => {
    const row = copied.rows[ordinal - 1];
    if (!row || row.state !== "ACCEPTED" || row.operation === "NONE" || row.errors.length ||
        !row.contentAvailable || !row.projectId || !row.recordKey) return invalid();
    return { ordinal, projectId: row.projectId, recordKey: row.recordKey, operation: row.operation,
      proposals: row.proposals.map((field) => ({ factType: field.factType, value: { ...field.value } })) };
  });
}
