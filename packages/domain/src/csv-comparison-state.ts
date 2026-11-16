// FR-CON-006/007/012 / NFR-SEC-001: reference-only, canonical CSV comparison state.
export const CSV_COMPARISON_LIMITS = Object.freeze({
  identities: 1000,
  fields: 32,
  projects: 100,
  canonicalBytes: 2 * 1024 * 1024,
  contexts: 4096,
  canonicalHistoryBytes: 256 * 1024 * 1024,
  contentUnionBytes: 4 * 1024 * 1024,
});

type ValueType = "text" | "date" | "number" | "boolean";
export type CsvComparisonDictionaryEntry = readonly [string, ValueType];
export type CsvComparisonFieldReference = readonly [string, string];
export type CsvComparisonIdentity = readonly [
  string,
  string,
  string,
  readonly CsvComparisonFieldReference[],
];
export type CsvComparisonState = readonly [
  "pdaa.csv.state.v1",
  string,
  string,
  string,
  readonly CsvComparisonDictionaryEntry[],
  readonly CsvComparisonIdentity[],
];

export class CsvComparisonStateError extends Error {
  constructor() {
    super("INVALID_CSV_COMPARISON_STATE");
    this.name = "CsvComparisonStateError";
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const factType = /^[a-z][a-z0-9_.-]{0,95}$/;
const valueTypes = new Set(["text", "date", "number", "boolean"]);
const invalid = (): never => {
  throw new CsvComparisonStateError();
};

function token(input: unknown, pattern: RegExp): string {
  if (typeof input !== "string") return invalid();
  const match = pattern.exec(input);
  if (!match || match[0] !== input) return invalid();
  return input;
}

// Copy only complete ordinary data arrays. No accessor, sparse cell, symbol or
// extra property participates in the canonical form. Proxy traps are outside
// the JSON-data boundary, as with the existing synthetic worksheet primitive.
function array(input: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    return invalid();
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max)
    return invalid();
  if (Reflect.ownKeys(input).length !== length + 1) return invalid();
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const cell = Object.getOwnPropertyDescriptor(input, String(index));
    if (!cell || !("value" in cell)) return invalid();
    copy.push(cell.value);
  }
  return copy;
}

/**
 * Validate and copy the versioned ASCII grammar. This is structural validation;
 * native guards must still bind references, permissions, transitions and live
 * retained content. Values, raw keys and arbitrary JSON are never accepted.
 */
export function parseCsvComparisonState(input: unknown): CsvComparisonState {
  const state = array(input, 6, 6);
  if (state[0] !== "pdaa.csv.state.v1") return invalid();
  const customerId = token(state[1], uuid);
  const sourceId = token(state[2], uuid);
  const mappingRevision = token(state[3], /^[1-9][0-9]{0,9}$/);
  if (Number(mappingRevision) > 2147483647) return invalid();
  const dictionary: CsvComparisonDictionaryEntry[] = [];
  let previousFact = "";
  for (const value of array(state[4], 1, CSV_COMPARISON_LIMITS.fields)) {
    const entry = array(value, 2, 2);
    const fact = token(entry[0], factType);
    if (
      fact <= previousFact ||
      typeof entry[1] !== "string" ||
      !valueTypes.has(entry[1])
    )
      return invalid();
    dictionary.push(Object.freeze([fact, entry[1] as ValueType]));
    previousFact = fact;
  }
  const identities: CsvComparisonIdentity[] = [];
  const records = new Set<string>();
  const projects = new Set<string>();
  let previousKey = "";
  for (const value of array(state[5], 0, CSV_COMPARISON_LIMITS.identities)) {
    const row = array(value, 4, 4);
    const key = token(row[0], hash);
    const recordId = token(row[1], uuid);
    const projectId = token(row[2], uuid);
    if (key <= previousKey || records.has(recordId)) return invalid();
    records.add(recordId);
    projects.add(projectId);
    if (projects.size > CSV_COMPARISON_LIMITS.projects) return invalid();
    const fields: CsvComparisonFieldReference[] = [];
    let previousIndex = -1;
    for (const value of array(row[3], 0, CSV_COMPARISON_LIMITS.fields)) {
      const pair = array(value, 2, 2);
      const index = token(pair[0], /^(0|[1-9][0-9]?)$/);
      const fieldIndex = Number(index);
      if (fieldIndex <= previousIndex || fieldIndex >= dictionary.length)
        return invalid();
      fields.push(Object.freeze([index, token(pair[1], uuid)]));
      previousIndex = fieldIndex;
    }
    identities.push(
      Object.freeze([key, recordId, projectId, Object.freeze(fields)]),
    );
    previousKey = key;
  }
  const parsed = Object.freeze([
    "pdaa.csv.state.v1",
    customerId,
    sourceId,
    mappingRevision,
    Object.freeze(dictionary),
    Object.freeze(identities),
  ] as const);
  // Every permitted token is ASCII; character length equals UTF-8 byte length.
  if (JSON.stringify(parsed).length > CSV_COMPARISON_LIMITS.canonicalBytes)
    return invalid();
  return parsed;
}

export function serializeCsvComparisonState(input: unknown) {
  const state = parseCsvComparisonState(input);
  const text = JSON.stringify(state);
  return Object.freeze({ state, text, bytes: text.length });
}
