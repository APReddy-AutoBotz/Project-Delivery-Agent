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
  const parsed = parseCsvPreview(csv);
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
