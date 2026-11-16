// FR-CON-006/007/012 / NFR-SEC-001: cumulative reference-only CSV observation overlay.
import {
  CsvComparisonStateError,
  parseCsvComparisonState,
  type CsvComparisonIdentity,
  type CsvComparisonState,
} from "./csv-comparison-state.js";

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
  const identities = new Map<string, CsvComparisonIdentity>(
    prior[5].map((row) => [row[0], row]),
  );
  for (const [key, recordId, projectId, supplied] of observations[5]) {
    const existing = identities.get(key);
    if (existing && (existing[1] !== recordId || existing[2] !== projectId))
      throw new CsvComparisonStateError();
    const fields = new Map<string, string>(existing?.[3]);
    for (const [index, projectionId] of supplied)
      fields.set(index, projectionId);
    identities.set(key, [
      key,
      recordId,
      projectId,
      [...fields].sort(([a], [b]) => Number(a) - Number(b)),
    ]);
  }
  const rows = [...identities.values()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  // Recheck the cumulative union, including cross-input record uniqueness and
  // project/identity bounds, then return an independent deeply frozen copy.
  return parseCsvComparisonState([...header, rows]);
}
