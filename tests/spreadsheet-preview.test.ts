import { describe, expect, it } from "vitest";
import {
  parseCsvPreview,
  previewSpreadsheetCsv,
} from "../packages/domain/src/spreadsheet-preview.js";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const config = {
  customerId: id(1),
  sourceId: id(2),
  sheet: "portfolio",
  mappingRevision: "1",
  fileName: "plan.csv",
  identityColumn: "key",
  projectColumn: "project",
  projectIds: [id(3), id(4)],
  fields: [
    { column: "status", factType: "status", type: "text", required: true },
  ],
};
const csv = (rows: string[], header = "key,project,status") =>
  [header, ...rows].join("\n");
const row = (key: string, value = "Open", project = id(3)) =>
  `${key},${project},${value}`;
const baseline = (keys = ["a"]) => ({
  customerId: config.customerId,
  sourceId: config.sourceId,
  sheet: config.sheet,
  mappingRevision: config.mappingRevision,
  rows: keys.map((key) => ({
    key,
    projectId: id(3),
    fields: [{ factType: "status", value: { type: "text", value: "Open" } }],
  })),
});

describe("bounded CSV parser (FR-CON-006/007)", () => {
  it("round-trips deterministic quoted Unicode/delimiter/newline fixtures", () => {
    const cells = [
      "plain",
      "a,b",
      'say "yes"',
      "a\nb",
      "a\rb",
      "a\r\nb",
      "😀",
      "",
      "  exact  ",
    ];
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const rows = Array.from({ length: 81 }, (_, i) => [
      cells[i % cells.length]!,
      cells[Math.floor(i / cells.length)]!,
    ]);
    const input =
      "a,b\r\n" +
      rows.map((values) => values.map(quote).join(",")).join("\r\n");
    expect(parseCsvPreview(input).rows).toEqual(rows);
  });
  it("accepts exact byte, cell and column boundaries", () => {
    const prefix = "h\n" + ("x".repeat(4096) + "\n").repeat(255);
    const input = prefix + "x".repeat(1_048_576 - prefix.length);
    expect(parseCsvPreview(input).rows).toHaveLength(256);
    expect(() => parseCsvPreview(input + "x")).toThrow("CSV_SIZE");
    const headers = Array.from({ length: 64 }, (_, i) => `h${i}`);
    expect(
      parseCsvPreview(headers.join(",") + "\n" + headers.join(",")).rows[0],
    ).toHaveLength(64);
  });
  it("supports BOM, quoted delimiters/newlines/double quotes and every record terminator", () => {
    expect(
      parseCsvPreview('\uFEFFkey,text\r\na,"b,c"\rb,"line\nnext"\nc,"a""b"\n'),
    ).toEqual({
      headers: ["key", "text"],
      rows: [
        ["a", "b,c"],
        ["b", "line\nnext"],
        ["c", 'a"b'],
      ],
    });
  });
  it.each(['a\nb"c', 'a\n"open', 'a\n"x"junk', 'a\n"x" '])(
    "rejects malformed quoting %j",
    (input) => {
      expect(() => parseCsvPreview(input)).toThrow("CSV_QUOTING");
    },
  );
  it.each(["", "a,a\nx,y", "a, \nx,y"])(
    "rejects blank/duplicate headers %j",
    (input) => {
      expect(() => parseCsvPreview(input)).toThrow("CSV_HEADERS");
    },
  );
  it("rejects ragged rows rather than truncating them", () =>
    expect(() => parseCsvPreview("a,b\nx")).toThrow("CSV_RAGGED"));
  it.each(["\0", "\ud800", "\udfff"])(
    "rejects invalid storage characters %j",
    (input) => {
      expect(() => parseCsvPreview("a\n" + input)).toThrow("CSV_ENCODING");
    },
  );
  it("retains valid supplementary Unicode and exact header whitespace", () => {
    expect(parseCsvPreview(" a \n😀")).toEqual({
      headers: [" a "],
      rows: [["😀"]],
    });
  });
  it("checks bytes, cell size, columns and rows", () => {
    expect(() => parseCsvPreview("a".repeat(1_048_577))).toThrow("CSV_SIZE");
    expect(() => parseCsvPreview("é".repeat(524_289))).toThrow("CSV_SIZE");
    expect(() => parseCsvPreview("a\n" + "x".repeat(4097))).toThrow(
      "CSV_CELL_SIZE",
    );
    expect(() =>
      parseCsvPreview(Array.from({ length: 65 }, (_, i) => "h" + i).join(",")),
    ).toThrow("CSV_COLUMNS");
    expect(() =>
      parseCsvPreview("a\n" + Array(1001).fill("x").join("\n")),
    ).toThrow("CSV_ROWS");
    expect(
      parseCsvPreview("a\n" + Array(1000).fill("x").join("\n")).rows,
    ).toHaveLength(1000);
  });
});
describe("mapped dry-run proposals (FR-CON-007, FAIL-006)", () => {
  it("produces explicit unapproved baseline-free CREATE proposals without mutating inputs", () => {
    const before = structuredClone(config),
      result = previewSpreadsheetCsv(csv([row("a")]), config);
    expect(config).toEqual(before);
    expect(result.mode).toBe("DRY_RUN");
    expect(result.comparison).toBe("BASELINE_ABSENT");
    expect(result.rows[0]).toMatchObject({
      status: "VALID",
      operation: "CREATE",
      rowNumber: 2,
    });
    expect(result.rows[0]!.proposals[0]).toEqual({
      factType: "status",
      value: { type: "text", value: "Open" },
    });
    expect(result).not.toHaveProperty("provenance");
    expect(result).not.toHaveProperty("committed");
  });
  it("keeps identity stable across reorder, columns and display filename", () => {
    const first = previewSpreadsheetCsv(
      csv([row("a"), row("b")]),
      config,
      baseline(["a", "b"]),
    );
    const second = previewSpreadsheetCsv(
      `status,key,project\nOpen,b,${id(3)}\nOpen,a,${id(3)}`,
      { ...config, fileName: "renamed.csv" },
      baseline(["a", "b"]),
    );
    expect(first.rows.map((r) => r.identity).sort()).toEqual(
      second.rows.map((r) => r.identity).sort(),
    );
    expect(second.rows.map((r) => r.operation)).toEqual([
      "UNCHANGED",
      "UNCHANGED",
    ]);
  });
  it("distinguishes changed, unchanged and true-new rows", () => {
    const result = previewSpreadsheetCsv(
      csv([row("a", "Done"), row("b"), row("c")]),
      config,
      baseline(["a", "b"]),
    );
    expect(result.rows.map((r) => r.operation)).toEqual([
      "UPDATE",
      "UNCHANGED",
      "CREATE",
    ]);
  });
  it("flags a possibly renamed key instead of silently creating a duplicate", () => {
    const result = previewSpreadsheetCsv(
      csv([row("renamed")]),
      config,
      baseline(),
    );
    expect(result.rows[0]).toMatchObject({
      status: "REVIEW_REQUIRED",
      operation: "NONE",
      proposals: [],
      errors: ["ROW_IDENTITY_REVIEW"],
    });
    expect(result.missingPreviousKeys).toEqual(["a"]);
  });
  it("never turns omitted rows into deletion proposals", () => {
    const result = previewSpreadsheetCsv(csv([]), config, baseline());
    expect(result.rows).toEqual([]);
    expect(result.missingPreviousKeys).toEqual(["a"]);
  });
  it("invalidates every duplicate and project move and blocks unmatched rows when identity is uncertain", () => {
    for (const input of [
      csv([row("a"), row("a"), row("c")]),
      csv([row("a", "Open", id(4)), row("c")]),
      csv([row(""), row("c")]),
    ]) {
      const result = previewSpreadsheetCsv(input, config, baseline());
      expect(result.rows[0]!.status).toBe("INVALID");
      expect(result.rows.at(-1)).toMatchObject({
        status: "REVIEW_REQUIRED",
        operation: "NONE",
        proposals: [],
      });
    }
  });
  it("rejects unscoped projects with no normal operation", () => {
    expect(
      previewSpreadsheetCsv(csv([row("a", "Open", id(9))]), config).rows[0],
    ).toMatchObject({ status: "INVALID", operation: "NONE", proposals: [] });
  });
  it.each(["=SUM(1)", "+cmd", "-cmd", "@formula", "  =SUM(1)"])(
    "rejects formula-like mapped text %s",
    (text) => {
      const result = previewSpreadsheetCsv(csv([row("a", text)]), config);
      expect(result.rows[0]).toMatchObject({
        status: "INVALID",
        operation: "NONE",
        proposals: [],
      });
      expect(result.rows[0]!.fields[0]).toMatchObject({
        state: "INVALID",
        code: "INVALID_FORMULA",
        raw: text,
      });
    },
  );
  it("does not clear prior facts for an optional blank", () => {
    const optional = {
      ...config,
      fields: [{ ...config.fields[0]!, required: false }],
    };
    const result = previewSpreadsheetCsv(
      csv([row("a", "")]),
      optional,
      baseline(),
    );
    expect(result.rows[0]).toMatchObject({
      status: "VALID",
      operation: "UNCHANGED",
      proposals: [],
    });
    expect(result.rows[0]!.fields[0]).toMatchObject({
      state: "MISSING",
      raw: "",
    });
    expect(
      previewSpreadsheetCsv(csv([row("b", "")]), optional).rows[0]!.operation,
    ).toBe("NONE");
    expect(
      previewSpreadsheetCsv(csv([row("a", "")]), config).rows[0]!.status,
    ).toBe("INVALID");
  });
  it.each([
    ["number", "0", 0],
    ["number", "-1.25", -1.25],
    ["number", "0.1", 0.1],
    ["number", "-0.1", -0.1],
    ["boolean", "false", false],
    ["boolean", "true", true],
    ["date", "2024-02-29", "2024-02-29"],
  ])("preserves mapped %s literal %s", (type, raw, value) => {
    const result = previewSpreadsheetCsv(csv([row("a", String(raw))]), {
      ...config,
      fields: [{ ...config.fields[0], type }],
    });
    expect(result.rows[0]!.proposals[0]!.value).toEqual({ type, value });
  });
  it.each([
    ["number", "9007199254740993"],
    ["number", "0.10000000000000001"],
    ["number", "1e3"],
    ["number", "01"],
    ["number", "1.0"],
    ["number", "-0"],
    ["number", "+1"],
    ["number", " 1"],
    ["number", "NaN"],
    ["number", "Infinity"],
    ["date", "2026-02-29"],
    ["date", "0000-01-01"],
    ["boolean", "FALSE"],
    ["boolean", "0"],
  ])("rejects lossy or noncanonical %s literal %s", (type, raw) => {
    const output = previewSpreadsheetCsv(csv([row("a", raw)]), {
      ...config,
      fields: [{ ...config.fields[0], type }],
    }).rows[0]!;
    expect(output).toMatchObject({
      status: "INVALID",
      operation: "NONE",
      proposals: [],
    });
    expect(output.fields[0]).toMatchObject({
      state: "INVALID",
      code: type === "number" ? "INVALID_NUMBER" : "INVALID_VALUE",
    });
  });
  it("handles prototype-like columns and keys as ordinary data", () => {
    const result = previewSpreadsheetCsv(
      `__proto__,constructor,status\n__proto__,${id(3)},Open`,
      { ...config, identityColumn: "__proto__", projectColumn: "constructor" },
    );
    expect(result.rows[0]).toMatchObject({
      key: "__proto__",
      status: "VALID",
      operation: "CREATE",
    });
  });
  it("rejects missing columns and duplicate mapped columns or fact types", () => {
    expect(() =>
      previewSpreadsheetCsv("key,project\na," + id(3), config),
    ).toThrow("MISSING_COLUMN");
    expect(() =>
      previewSpreadsheetCsv(csv([]), {
        ...config,
        fields: [config.fields[0], config.fields[0]],
      }),
    ).toThrow("INVALID_INPUT");
  });
  it("rejects baseline identity/revision/scope/type drift without modifying it", () => {
    const before = baseline(),
      saved = structuredClone(before);
    for (const change of [
      { customerId: id(8) },
      { sourceId: id(8) },
      { sheet: "other" },
      { mappingRevision: "2" },
      { rows: [{ ...before.rows[0], projectId: id(8) }] },
      {
        rows: [
          {
            ...before.rows[0],
            fields: [
              { factType: "status", value: { type: "boolean", value: true } },
            ],
          },
        ],
      },
    ])
      expect(() =>
        previewSpreadsheetCsv(csv([row("a")]), config, {
          ...before,
          ...change,
        }),
      ).toThrow("INVALID_BASELINE");
    expect(before).toEqual(saved);
  });
  it("rejects oversized baseline before reading entries", () => {
    const rows = Array(1001);
    Object.defineProperty(rows, 0, {
      get() {
        throw new Error("ENTRY_TOUCHED");
      },
    });
    expect(() =>
      previewSpreadsheetCsv(csv([]), config, { ...baseline(), rows }),
    ).toThrow("INVALID_INPUT");
  });
});
