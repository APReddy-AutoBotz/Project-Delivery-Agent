import { z } from "zod";
import { ingestionText } from "./connector.js";
import { projectFactIdSchema } from "./project-facts.js";
import { IngestionPersistenceError } from "./ingestion-persistence-error.js";
import {
  comparisonArray,
  overlayComparisonReferences,
  parseComparisonReferences,
  type ComparisonDictionaryEntry,
  type ComparisonIdentity,
} from "./spreadsheet-comparison-references.js";

export const xlsxSheetSchema = ingestionText(31).refine(
  (value) => !/[\\/*?:[\]]|_x[0-9a-f]{4}_/iu.test(value),
);
export const xlsxParserContractSchema = z.enum([
  "portable-v1",
  "excel-text-v1",
]);
export const xlsxMappingRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647);
const stateHeader = z.tuple([
  z.literal("pdaa.xlsx.comparison-state.v1"),
  projectFactIdSchema,
  projectFactIdSchema,
  xlsxMappingRevisionSchema,
  xlsxSheetSchema,
  xlsxParserContractSchema,
]);
type Header = z.infer<typeof stateHeader>;
type State = readonly [
  ...Header,
  readonly ComparisonDictionaryEntry[],
  readonly ComparisonIdentity[],
];
// The bounded dictionary and row grammar has a structural maximum below 2 MiB.
const maxCanonicalBytes = 2 * 1024 * 1024;
const invalid = (): never => {
  throw new IngestionPersistenceError("INVALID_PREVIEW");
};

/** The state contains immutable projection references. The repository verifies
 * current project scope, native lineage and live content before using it. */
export function serializeXlsxComparisonState(input: unknown) {
  const tuple = comparisonArray(input, 8, 8, invalid);
  const header = stateHeader.safeParse(tuple.slice(0, 6));
  if (!header.success) return invalid();
  const { dictionary, identities } = parseComparisonReferences(
    tuple[6],
    tuple[7],
    invalid,
  );
  const state: State = Object.freeze([...header.data, dictionary, identities]);
  const text = JSON.stringify(state);
  const bytes = new globalThis.TextEncoder().encode(text).byteLength;
  if (bytes > maxCanonicalBytes) return invalid();
  return Object.freeze({ state, text, bytes });
}

export function applyXlsxComparisonObservations(
  previous: unknown,
  acceptedRows: unknown,
) {
  const { state: prior } = serializeXlsxComparisonState(previous);
  const header = prior.slice(0, 7);
  const { identities } = parseComparisonReferences(
    prior[6],
    acceptedRows,
    invalid,
  );
  const successor = overlayComparisonReferences(prior[7], identities, invalid);
  // Recheck cumulative identities and scope after carrying untouched rows forward.
  return serializeXlsxComparisonState([...header, successor]);
}
