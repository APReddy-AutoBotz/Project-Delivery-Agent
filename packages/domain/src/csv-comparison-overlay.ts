// FR-CON-006/007/012 / NFR-SEC-001: cumulative reference-only CSV observation overlay.
import {
  CsvComparisonStateError,
  parseCsvComparisonState,
  type CsvComparisonState,
} from "./csv-comparison-state.js";
import { overlayComparisonReferences } from "./spreadsheet-comparison-references.js";

/**
 * Apply structurally valid accepted observation references. The caller must
 * establish acceptance, complete coverage, native binding, current access and
 * live retention independently. This helper classifies no row and writes no data.
 */
export function applyCsvComparisonObservations(
  previous: unknown,
  acceptedRows: unknown,
): CsvComparisonState {
  const prior = parseCsvComparisonState(previous);
  const header = prior.slice(0, 5);
  const observations = parseCsvComparisonState([...header, acceptedRows]);
  const rows = overlayComparisonReferences(prior[5], observations[5], () => {
    throw new CsvComparisonStateError();
  });
  // Recheck the cumulative union, including cross-input record uniqueness and
  // project/identity bounds, then return an independent deeply frozen copy.
  return parseCsvComparisonState([...header, rows]);
}
