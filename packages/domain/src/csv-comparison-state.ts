// FR-CON-006/007/012 / NFR-SEC-001: reference-only, canonical CSV comparison state.
import {
  comparisonArray,
  comparisonReferenceLimits,
  comparisonToken,
  parseComparisonReferences,
  type ComparisonDictionaryEntry,
  type ComparisonFieldReference,
  type ComparisonIdentity,
} from "./spreadsheet-comparison-references.js";

export const CSV_COMPARISON_LIMITS = Object.freeze({
  ...comparisonReferenceLimits,
  canonicalBytes: 2 * 1024 * 1024,
  contexts: 4096,
  canonicalHistoryBytes: 256 * 1024 * 1024,
  contentUnionBytes: 4 * 1024 * 1024,
});

export type CsvComparisonDictionaryEntry = ComparisonDictionaryEntry;
export type CsvComparisonFieldReference = ComparisonFieldReference;
export type CsvComparisonIdentity = ComparisonIdentity;
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
const invalid = (): never => {
  throw new CsvComparisonStateError();
};

/**
 * Validate and copy the versioned ASCII grammar. This is structural validation;
 * native guards must still bind references, permissions, transitions and live
 * retained content. Values, raw keys and arbitrary JSON are never accepted.
 */
export function parseCsvComparisonState(input: unknown): CsvComparisonState {
  const state = comparisonArray(input, 6, 6, invalid);
  if (state[0] !== "pdaa.csv.state.v1") return invalid();
  const customerId = comparisonToken(state[1], uuid, invalid);
  const sourceId = comparisonToken(state[2], uuid, invalid);
  const mappingRevision = comparisonToken(state[3], /^[1-9][0-9]{0,9}$/, invalid);
  if (Number(mappingRevision) > 2147483647) return invalid();
  const { dictionary, identities } = parseComparisonReferences(state[4], state[5], invalid);
  const parsed = Object.freeze([
    "pdaa.csv.state.v1",
    customerId,
    sourceId,
    mappingRevision,
    dictionary,
    identities,
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
