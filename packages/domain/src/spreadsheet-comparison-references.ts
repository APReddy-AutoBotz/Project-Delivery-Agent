// FR-CON-006/007/012: validated dictionary and reference-only rows shared by the spreadsheet formats.
export type ComparisonDictionaryEntry = readonly [
  string,
  "text" | "date" | "number" | "boolean",
];
export type ComparisonFieldReference = readonly [string, string];
export type ComparisonIdentity = readonly [
  string,
  string,
  string,
  readonly ComparisonFieldReference[],
];

export const comparisonReferenceLimits = Object.freeze({
  identities: 1000,
  fields: 32,
  projects: 100,
});

type Invalid = () => never;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const factType = /^[a-z][a-z0-9_.-]{0,95}$/;
const valueTypes = new Set(["text", "date", "number", "boolean"]);

export function comparisonToken(
  input: unknown,
  pattern: RegExp,
  invalid: Invalid,
): string {
  if (typeof input !== "string") return invalid();
  const match = pattern.exec(input);
  if (!match || match[0] !== input) return invalid();
  return input;
}

// Copy complete ordinary data arrays without invoking accessors.
export function comparisonArray(
  input: unknown,
  min: number,
  max: number,
  invalid: Invalid,
): unknown[] {
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

export function parseComparisonReferences(
  dictionaryInput: unknown,
  identityInput: unknown,
  invalid: Invalid,
) {
  const {
    fields: maxFields,
    identities: maxIdentities,
    projects: maxProjects,
  } = comparisonReferenceLimits;
  const dictionary: ComparisonDictionaryEntry[] = [];
  let previousFact = "";
  for (const value of comparisonArray(dictionaryInput, 1, maxFields, invalid)) {
    const entry = comparisonArray(value, 2, 2, invalid);
    const fact = comparisonToken(entry[0], factType, invalid);
    if (
      fact <= previousFact ||
      typeof entry[1] !== "string" ||
      !valueTypes.has(entry[1])
    )
      return invalid();
    dictionary.push(
      Object.freeze([fact, entry[1] as ComparisonDictionaryEntry[1]]),
    );
    previousFact = fact;
  }

  const identities: ComparisonIdentity[] = [];
  const records = new Set<string>();
  const projects = new Set<string>();
  let previousKey = "";
  for (const value of comparisonArray(
    identityInput,
    0,
    maxIdentities,
    invalid,
  )) {
    const row = comparisonArray(value, 4, 4, invalid);
    const key = comparisonToken(row[0], hash, invalid);
    const recordId = comparisonToken(row[1], uuid, invalid);
    const projectId = comparisonToken(row[2], uuid, invalid);
    if (key <= previousKey || records.has(recordId)) return invalid();
    records.add(recordId);
    projects.add(projectId);
    if (projects.size > maxProjects) return invalid();
    const fields: ComparisonFieldReference[] = [];
    let previousIndex = -1;
    for (const value of comparisonArray(row[3], 0, maxFields, invalid)) {
      const pair = comparisonArray(value, 2, 2, invalid);
      const index = comparisonToken(pair[0], /^(0|[1-9][0-9]?)$/, invalid);
      const fieldIndex = Number(index);
      if (fieldIndex <= previousIndex || fieldIndex >= dictionary.length)
        return invalid();
      fields.push(
        Object.freeze([index, comparisonToken(pair[1], uuid, invalid)]),
      );
      previousIndex = fieldIndex;
    }
    identities.push(
      Object.freeze([key, recordId, projectId, Object.freeze(fields)]),
    );
    previousKey = key;
  }
  return {
    dictionary: Object.freeze(dictionary),
    identities: Object.freeze(identities),
  };
}

// Both inputs have passed the same grammar. The caller rechecks the cumulative
// union and separately establishes observation acceptance and retained content.
export function overlayComparisonReferences(
  previous: readonly ComparisonIdentity[],
  accepted: readonly ComparisonIdentity[],
  invalid: Invalid,
): ComparisonIdentity[] {
  const identities = new Map(previous.map((row) => [row[0], row]));
  for (const [key, recordId, projectId, supplied] of accepted) {
    const existing = identities.get(key);
    if (existing && (existing[1] !== recordId || existing[2] !== projectId))
      return invalid();
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
  return [...identities.values()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}
