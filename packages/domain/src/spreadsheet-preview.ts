import { z } from "zod";
import {
  projectFactIdSchema,
  projectFactValueSchema,
} from "./project-facts.js";
import {
  IngestionInputError,
  ingestionArray,
  ingestionFactType,
  ingestionProposalSchema,
  ingestionText,
  parseIngestion,
} from "./connector.js";

// FR-CON-006/007, FAIL-006: pure proposals, not facts or an import commit API.
export const CSV_LIMITS = Object.freeze({
  bytes: 1_048_576,
  rows: 1000,
  columns: 64,
  cell: 4096,
});
export function parseCsvPreview(input: unknown): {
  headers: string[];
  rows: string[][];
} {
  if (typeof input !== "string" || input.length > CSV_LIMITS.bytes)
    throw new IngestionInputError("CSV_SIZE");
  if (/[\0\p{Surrogate}]/u.test(input))
    throw new IngestionInputError("CSV_ENCODING");
  if (new globalThis.TextEncoder().encode(input).length > CSV_LIMITS.bytes)
    throw new IngestionInputError("CSV_SIZE");
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    state: "START" | "PLAIN" | "QUOTED" | "CLOSED" = "START";
  let endedRow = false;
  const append = (value: string) => {
    if (cell.length + value.length > CSV_LIMITS.cell)
      throw new IngestionInputError("CSV_CELL_SIZE");
    cell += value;
  };
  const finishCell = () => {
    if (row.length === CSV_LIMITS.columns)
      throw new IngestionInputError("CSV_COLUMNS");
    row.push(cell);
    cell = "";
    state = "START";
  };
  const finishRow = () => {
    finishCell();
    if (records.length === CSV_LIMITS.rows + 1)
      throw new IngestionInputError("CSV_ROWS");
    records.push(row);
    row = [];
    endedRow = true;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    endedRow = false;
    if (state === "QUOTED") {
      if (char === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i++;
        } else state = "CLOSED";
      } else append(char);
    } else if (char === ",") finishCell();
    else if (char === "\n" || char === "\r") {
      finishRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (state === "CLOSED") throw new IngestionInputError("CSV_QUOTING");
    else if (char === '"') {
      if (state !== "START") throw new IngestionInputError("CSV_QUOTING");
      state = "QUOTED";
    } else {
      append(char);
      state = "PLAIN";
    }
  }
  if (state === "QUOTED") throw new IngestionInputError("CSV_QUOTING");
  if (!endedRow) finishRow();
  const headers = records.shift()!;
  if (
    headers.some((h) => !h.trim() || h.length > 256) ||
    new Set(headers).size !== headers.length
  )
    throw new IngestionInputError("CSV_HEADERS");
  if (records.some((r) => r.length !== headers.length))
    throw new IngestionInputError("CSV_RAGGED");
  return { headers, rows: records };
}

// This validates already-decoded, bounded data; it is not a workbook parser or
// an isolation boundary for arbitrary in-process Proxy objects. A future file
// adapter must establish physical row/column, formula and sheet semantics first.
function parseSpreadsheetGrid(input: unknown): { headers: string[]; rows: string[][] } {
  const invalid = (): never => { throw new IngestionInputError("GRID_SHAPE"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes("headers") || !keys.includes("rows")) return invalid();
  for (const key in input) if (!Object.hasOwn(input, key)) return invalid();
  const property = (object: object, key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) return invalid();
    return descriptor.value;
  };
  const dense = (value: unknown, max: number, over: string): unknown[] => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    const length = property(value, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return invalid();
    if (length > max) throw new IngestionInputError(over);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) return invalid();
    for (const key in value) if (!Object.hasOwn(value, key)) return invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) result.push(property(value, String(index)));
    return result;
  };
  const headerValues = dense(property(input, "headers"), CSV_LIMITS.columns, "GRID_COLUMNS");
  if (!headerValues.length) throw new IngestionInputError("GRID_HEADERS");
  const rowValues = dense(property(input, "rows"), CSV_LIMITS.rows, "GRID_ROWS");
  const encoder = new globalThis.TextEncoder();
  let bytes = 0;
  const cell = (value: unknown): string => {
    if (typeof value !== "string") return invalid();
    if (value.length > CSV_LIMITS.cell) throw new IngestionInputError("GRID_CELL_SIZE");
    if (/[\0\p{Surrogate}]/u.test(value)) throw new IngestionInputError("GRID_ENCODING");
    bytes += encoder.encode(value).byteLength;
    if (bytes > CSV_LIMITS.bytes) throw new IngestionInputError("GRID_SIZE");
    return value;
  };
  const headers = headerValues.map(cell);
  if (headers.some((header) => !header.trim() || header.length > 256) || new Set(headers).size !== headers.length)
    throw new IngestionInputError("GRID_HEADERS");
  const rows = rowValues.map((value) => {
    const cells = dense(value, CSV_LIMITS.columns, "GRID_COLUMNS");
    if (cells.length !== headers.length) return invalid();
    return cells.map(cell);
  });
  return { headers, rows };
}
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
const mapping = z
  .object({
    column: ingestionText(256),
    factType: ingestionFactType,
    type: z.enum(["text", "date", "number", "boolean"]),
    required: z.boolean(),
  })
  .strict();
const binding = {
  customerId: projectFactIdSchema,
  sourceId: projectFactIdSchema,
  sheet: ingestionText(256),
  mappingRevision: ingestionText(128),
};
export const spreadsheetPreviewConfigSchema = z
  .object({
    ...binding,
    fileName: ingestionText(256),
    identityColumn: ingestionText(256),
    projectColumn: ingestionText(256),
    projectIds: ingestionArray(projectFactIdSchema, 100).refine(unique),
    fields: ingestionArray(mapping, 32).refine(
      (fields) =>
        fields.length > 0 &&
        unique(fields.map((f) => f.column)) &&
        unique(fields.map((f) => f.factType)),
    ),
  })
  .strict()
  .refine((c) => c.identityColumn !== c.projectColumn);
export const spreadsheetBaselineSchema = z
  .object({
    ...binding,
    rows: ingestionArray(
      z
        .object({
          key: ingestionText(256),
          projectId: projectFactIdSchema,
          fields: ingestionArray(ingestionProposalSchema, 32).refine((fields) =>
            unique(fields.map((f) => f.factType)),
          ),
        })
        .strict(),
      1000,
    ).refine((rows) => unique(rows.map((r) => r.key))),
  })
  .strict();
type Config = z.infer<typeof spreadsheetPreviewConfigSchema>;
type Proposal = z.infer<typeof ingestionProposalSchema>;
type Mapping = z.infer<typeof mapping>;
export type SpreadsheetFieldPreview = {
  column: string;
  factType: string;
  raw: string;
} & (
  | { state: "VALUE"; value: Proposal["value"] }
  | { state: "MISSING" }
  | {
      state: "INVALID";
      code:
        | "REQUIRED_VALUE"
        | "INVALID_FORMULA"
        | "INVALID_NUMBER"
        | "INVALID_VALUE";
    }
);
export interface SpreadsheetRowPreview {
  rowNumber: number;
  key: string;
  projectId: string;
  identity: string | null;
  status: "VALID" | "INVALID" | "REVIEW_REQUIRED";
  operation: "CREATE" | "UPDATE" | "UNCHANGED" | "NONE";
  errors: string[];
  fields: SpreadsheetFieldPreview[];
  proposals: Proposal[];
}
export interface SpreadsheetPreview {
  mode: "DRY_RUN";
  comparison: "BASELINE_ABSENT" | "BASELINE_SUPPLIED";
  customerId: string;
  sourceId: string;
  sheet: string;
  fileName: string;
  mappingRevision: string;
  headers: string[];
  mappings: Config["fields"];
  missingPreviousKeys: string[];
  rows: SpreadsheetRowPreview[];
}
function fieldPreview(field: Mapping, raw: string): SpreadsheetFieldPreview {
  const base = { column: field.column, factType: field.factType, raw };
  if (raw === "")
    return field.required
      ? { ...base, state: "INVALID", code: "REQUIRED_VALUE" }
      : { ...base, state: "MISSING" };
  if (field.type === "text" && /^[\s]*[=+\-@]/u.test(raw))
    return { ...base, state: "INVALID", code: "INVALID_FORMULA" };
  let value: unknown = raw;
  if (field.type === "number") {
    const number = Number(raw);
    value =
      /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(raw) &&
      Number.isFinite(number) &&
      Math.abs(number) <= Number.MAX_SAFE_INTEGER &&
      String(number) === raw
        ? number
        : null;
  } else if (field.type === "boolean")
    value = raw === "true" ? true : raw === "false" ? false : null;
  const parsed = projectFactValueSchema.safeParse({ type: field.type, value });
  return parsed.success
    ? { ...base, state: "VALUE", value: parsed.data }
    : {
        ...base,
        state: "INVALID",
        code: field.type === "number" ? "INVALID_NUMBER" : "INVALID_VALUE",
      };
}
const scopeKey = (scope: z.infer<typeof spreadsheetBaselineSchema> | Config) =>
  JSON.stringify([
    scope.customerId,
    scope.sourceId,
    scope.sheet,
    scope.mappingRevision,
  ]);
export function previewSpreadsheetCsv(
  csv: unknown,
  configInput: unknown,
  baselineInput?: unknown,
): SpreadsheetPreview {
  return previewSpreadsheetParsed(configInput, baselineInput, () => parseCsvPreview(csv));
}

// Pure mapping for a future reviewed workbook adapter. It makes no claim about
// workbook identity, formulas, hidden content, provenance or persistence.
export function previewSpreadsheetGrid(
  grid: unknown,
  configInput: unknown,
  baselineInput?: unknown,
): SpreadsheetPreview {
  return previewSpreadsheetParsed(configInput, baselineInput, () => parseSpreadsheetGrid(grid));
}

// Interprets asserted synthetic data, not XLSX bytes. A future isolated parser
// must independently establish every declaration from the complete workbook.
// This is not a boundary against hostile in-process JavaScript Proxy traps.
export function previewSyntheticWorksheet(
  descriptor: unknown,
  configInput: unknown,
  baselineInput?: unknown,
): SpreadsheetPreview {
  return previewSpreadsheetParsed(configInput, baselineInput, (config) =>
    parseSpreadsheetGrid(syntheticWorksheetGrid(descriptor, config.sheet)));
}

function syntheticWorksheetGrid(input: unknown, selectedSheet: string): { headers: string[]; rows: string[][] } {
  const invalid = (): never => { throw new IngestionInputError("WORKSHEET_SHAPE"); };
  const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return invalid();
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || keys.some((key) => !own.includes(key))) return invalid();
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const item = Object.getOwnPropertyDescriptor(value, key);
      if (!item || !("value" in item)) return invalid();
      copy[key] = item.value;
    }
    return copy;
  };
  const array = (value: unknown, max: number): unknown[] => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > max) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return invalid();
    const copy: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item || !("value" in item)) return invalid();
      copy.push(item.value);
    }
    return copy;
  };
  const workbook = object(input, ["version", "complete", "macros", "externalRelationships", "unsupportedFeatures", "sheets"]);
  if (workbook.version !== 1 || workbook.complete !== true || workbook.macros !== false ||
      workbook.externalRelationships !== false || workbook.unsupportedFeatures !== false) return invalid();
  const sheets = array(workbook.sheets, 1);
  if (sheets.length !== 1) return invalid();
  const sheet = object(sheets[0], ["name", "visibility", "rowCount", "columnCount", "hiddenRows", "hiddenColumns", "mergedCells", "unsupportedFeatures", "cells"]);
  if (sheet.name !== selectedSheet || sheet.visibility !== "VISIBLE" || sheet.hiddenRows !== false ||
      sheet.hiddenColumns !== false || sheet.mergedCells !== false || sheet.unsupportedFeatures !== false) return invalid();
  const rowCount = sheet.rowCount, columnCount = sheet.columnCount;
  if (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > CSV_LIMITS.rows + 1 ||
      typeof columnCount !== "number" || !Number.isSafeInteger(columnCount) || columnCount < 1 || columnCount > CSV_LIMITS.columns) return invalid();
  const cells = array(sheet.cells, (CSV_LIMITS.rows + 1) * CSV_LIMITS.columns);
  if (cells.length !== rowCount * columnCount) return invalid();
  const rows: string[][] = [];
  const encoder = new globalThis.TextEncoder();
  let bytes = 0;
  for (let row = 1; row <= rowCount; row++) {
    const values: string[] = [];
    for (let column = 1; column <= columnCount; column++) {
      const cell = object(cells[(row - 1) * columnCount + column - 1], ["row", "column", "kind", "value", "formula"]);
      if (cell.row !== row || cell.column !== column || cell.kind !== "TEXT" || cell.formula !== false ||
          typeof cell.value !== "string" || cell.value.length > CSV_LIMITS.cell) return invalid();
      if (/[\0\p{Surrogate}]/u.test(cell.value)) throw new IngestionInputError("GRID_ENCODING");
      bytes += encoder.encode(cell.value).byteLength;
      if (bytes > CSV_LIMITS.bytes) throw new IngestionInputError("GRID_SIZE");
      values.push(cell.value);
    }
    rows.push(values);
  }
  return { headers: rows[0]!, rows: rows.slice(1) };
}

function previewSpreadsheetParsed(
  configInput: unknown,
  baselineInput: unknown,
  parse: (config: Config) => { headers: string[]; rows: string[][] },
): SpreadsheetPreview {
  const config = parseIngestion(spreadsheetPreviewConfigSchema, configInput);
  const baseline =
    baselineInput === undefined
      ? null
      : parseIngestion(spreadsheetBaselineSchema, baselineInput);
  if (
    baseline &&
    (scopeKey(baseline) !== scopeKey(config) ||
      baseline.rows.some(
        (row) =>
          !config.projectIds.includes(row.projectId) ||
          row.fields.some(
            (f) =>
              !config.fields.some(
                (m) => m.factType === f.factType && m.type === f.value.type,
              ),
          ) ||
          config.fields.some(
            (m) =>
              m.required && !row.fields.some((f) => f.factType === m.factType),
          ),
      ))
  )
    throw new IngestionInputError("INVALID_BASELINE");
  const parsed = parse(config);
  const columns = new Map(
    parsed.headers.map((header, index) => [header, index]),
  );
  if (
    [
      config.identityColumn,
      config.projectColumn,
      ...config.fields.map((f) => f.column),
    ].some((header) => !columns.has(header))
  )
    throw new IngestionInputError("MISSING_COLUMN");
  const keyIndex = columns.get(config.identityColumn)!;
  const projectIndex = columns.get(config.projectColumn)!;
  const keyCounts = new Map<string, number>();
  for (const row of parsed.rows)
    keyCounts.set(row[keyIndex]!, (keyCounts.get(row[keyIndex]!) ?? 0) + 1);
  const previous = new Map(baseline?.rows.map((row) => [row.key, row]) ?? []);
  const missingPreviousKeys = [...previous.keys()].filter(
    (key) => !keyCounts.has(key),
  );
  let identityUncertain = false;
  const rows: SpreadsheetRowPreview[] = parsed.rows.map((row, index) => {
    const key = row[keyIndex]!,
      projectId = row[projectIndex]!,
      errors: string[] = [];
    const validKey = ingestionText(256).safeParse(key).success;
    if (!validKey) errors.push("INVALID_KEY");
    if ((keyCounts.get(key) ?? 0) > 1) errors.push("DUPLICATE_KEY");
    if (
      !projectFactIdSchema.safeParse(projectId).success ||
      !config.projectIds.includes(projectId)
    )
      errors.push("INVALID_PROJECT");
    if (previous.has(key) && previous.get(key)!.projectId !== projectId)
      errors.push("PROJECT_CHANGED");
    if (errors.length) identityUncertain = true;
    const fields = config.fields.map((field) =>
      fieldPreview(field, row[columns.get(field.column)!]!),
    );
    if (fields.some((f) => f.state === "INVALID"))
      errors.push("INVALID_FIELDS");
    return {
      rowNumber: index + 2,
      key,
      projectId,
      identity: validKey
        ? JSON.stringify([
            config.customerId,
            config.sourceId,
            config.sheet,
            key,
          ])
        : null,
      status: errors.length ? "INVALID" : "VALID",
      operation: "NONE",
      errors,
      fields,
      proposals: [],
    };
  });
  for (const row of rows) {
    if (row.status === "INVALID") continue;
    const before = previous.get(row.key);
    if (!before && (identityUncertain || missingPreviousKeys.length > 0)) {
      row.status = "REVIEW_REQUIRED";
      row.errors.push("ROW_IDENTITY_REVIEW");
      continue;
    }
    row.proposals = row.fields.flatMap((field) =>
      field.state === "VALUE"
        ? [{ factType: field.factType, value: field.value }]
        : [],
    );
    if (!row.proposals.length) row.operation = before ? "UNCHANGED" : "NONE";
    else if (!before) row.operation = "CREATE";
    else
      row.operation = row.proposals.every((proposal) =>
        before.fields.some(
          (field) =>
            field.factType === proposal.factType &&
            field.value.type === proposal.value.type &&
            field.value.value === proposal.value.value,
        ),
      )
        ? "UNCHANGED"
        : "UPDATE";
  }
  return {
    mode: "DRY_RUN",
    comparison: baseline ? "BASELINE_SUPPLIED" : "BASELINE_ABSENT",
    customerId: config.customerId,
    sourceId: config.sourceId,
    sheet: config.sheet,
    mappingRevision: config.mappingRevision,
    fileName: config.fileName,
    headers: parsed.headers,
    mappings: config.fields,
    missingPreviousKeys,
    rows,
  };
}
