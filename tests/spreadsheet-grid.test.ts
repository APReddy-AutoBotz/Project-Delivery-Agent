import { describe, expect, it } from "vitest";
import { previewSpreadsheetCsv, previewSpreadsheetGrid } from "../packages/domain/src/spreadsheet-preview.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const config = { customerId: id(1), sourceId: id(2), sheet: "portfolio", mappingRevision: "1", fileName: "synthetic",
  identityColumn: "key", projectColumn: "project", projectIds: [id(3)],
  fields: [{ column: "status", factType: "status", type: "text", required: true }] };
const grid = () => ({ headers: ["key", "project", "status"], rows: [["a", id(3), "Open"]] });
const baseline = { customerId: id(1), sourceId: id(2), sheet: "portfolio", mappingRevision: "1",
  rows: [{ key: "a", projectId: id(3), fields: [{ factType: "status", value: { type: "text", value: "Open" } }] }] };

describe("bounded decoded spreadsheet grid", () => {
  it("matches CSV mapping for quoted values, missing values, formulas and duplicate identities", () => {
    const csv = `key,project,status\n"a",${id(3)},"Open, \"\"quoted\"\"\nnext"\n"b",${id(3)},"=1+1"\n"b",${id(3)},`;
    const input = { headers: ["key", "project", "status"], rows: [
      ["a", id(3), 'Open, "quoted"\nnext'], ["b", id(3), "=1+1"], ["b", id(3), ""],
    ] };
    expect(previewSpreadsheetGrid(input, config, baseline)).toEqual(previewSpreadsheetCsv(csv, config, baseline));
  });

  it("preserves typed literals and rejects ambiguous values exactly like CSV", () => {
    const typed = { ...config, fields: [
      { column: "count", factType: "count", type: "number", required: true },
      { column: "date", factType: "date", type: "date", required: true },
      { column: "flag", factType: "flag", type: "boolean", required: true },
      { column: "note", factType: "note", type: "text", required: false },
    ] };
    const headers = ["key", "project", "count", "date", "flag", "note"];
    const rows = [["a", id(3), "0", "2026-10-31", "false", ""], ["b", id(3), "01", "2026-02-30", "TRUE", "=1+1"]];
    const matrix = previewSpreadsheetGrid({ headers, rows }, typed);
    expect(matrix).toEqual(previewSpreadsheetCsv([headers.join(","), ...rows.map((row) => row.join(","))].join("\n"), typed));
    expect(matrix.rows[0]!.proposals).toEqual([
      { factType: "count", value: { type: "number", value: 0 } },
      { factType: "date", value: { type: "date", value: "2026-10-31" } },
      { factType: "flag", value: { type: "boolean", value: false } },
    ]);
    expect(matrix.rows[1]!.fields.map((field) => field.state)).toEqual(["INVALID", "INVALID", "INVALID", "INVALID"]);
  });

  it("preserves baseline updates, missing-key review and immutable project identity", () => {
    const twoProjects = { ...config, projectIds: [id(3), id(4)] };
    const previous = { ...baseline, rows: [...baseline.rows, { key: "b", projectId: id(3),
      fields: [{ factType: "status", value: { type: "text", value: "Open" } }] }] };
    const headers = ["key", "project", "status"];
    const rows = [["a", id(3), "Closed"], ["c", id(3), "Open"]];
    const changed = previewSpreadsheetGrid({ headers, rows }, twoProjects, previous);
    expect(changed).toEqual(previewSpreadsheetCsv([headers.join(","), ...rows.map((row) => row.join(","))].join("\n"), twoProjects, previous));
    expect(changed.missingPreviousKeys).toEqual(["b"]);
    expect(changed.rows.map((row) => row.operation)).toEqual(["UPDATE", "NONE"]);
    expect(changed.rows[1]!.status).toBe("REVIEW_REQUIRED");
    const moved = previewSpreadsheetGrid({ headers, rows: [["a", id(4), "Open"]] }, twoProjects, previous);
    expect(moved.rows[0]).toMatchObject({ status: "INVALID", errors: ["PROJECT_CHANGED"] });
    expect(previewSpreadsheetGrid({ headers, rows: [["a", id(99), "Open"]] }, twoProjects, previous).rows[0]!.errors).toContain("INVALID_PROJECT");
  });

  it("copies caller data and permits an empty data section", () => {
    const input = grid(), before = structuredClone(input);
    const result = previewSpreadsheetGrid(input, config);
    expect(input).toEqual(before);
    input.headers[0] = "changed"; input.rows[0]![2] = "changed";
    expect(result.headers).toEqual(before.headers);
    expect(result.rows[0]!.fields[0]!.raw).toBe("Open");
    expect(previewSpreadsheetGrid({ headers: ["key", "project", "status"], rows: [] }, config).rows).toEqual([]);
  });

  it("retains configuration and baseline validation precedence", () => {
    expect(() => previewSpreadsheetCsv('"open', {}, {})).toThrow("INVALID_INPUT");
    expect(() => previewSpreadsheetGrid({}, {}, {})).toThrow("INVALID_INPUT");
    const wrongScope = { ...baseline, sourceId: id(99) };
    expect(() => previewSpreadsheetCsv('"open', config, wrongScope)).toThrow("INVALID_BASELINE");
    expect(() => previewSpreadsheetGrid({}, config, wrongScope)).toThrow("INVALID_BASELINE");
  });

  it("rejects accessors without invoking them, holes, prototypes and extra properties", () => {
    let calls = 0;
    const root = { get headers() { calls++; return ["key"]; }, rows: [] };
    const array = ["key", "project", "status"];
    Object.defineProperty(array, "0", { get() { calls++; return "key"; }, enumerable: true });
    const sparse = new Array(3); sparse[1] = id(3); sparse[2] = "Open";
    const extra = grid(); Object.defineProperty(extra.rows[0]!, "note", { value: "private" });
    const symbol = grid(); Object.defineProperty(symbol, Symbol("extra"), { value: true });
    const arraySymbol = grid(); Object.defineProperty(arraySymbol.rows, Symbol("extra"), { value: true });
    const rowAccessor = grid(); Object.defineProperty(rowAccessor.rows[0]!, "1", { get() { calls++; return id(3); } });
    const inherited = Object.assign(Object.create({ private: true }), grid());
    for (const input of [root, { headers: array, rows: [] }, { headers: grid().headers, rows: [sparse] }, extra, symbol, arraySymbol, rowAccessor, inherited,
      { ...grid(), extra: true }, { headers: ["key", "project", "status"], rows: [["a", id(3)]] },
      { headers: ["key", "project", "status"], rows: [["a", id(3), 1]] }])
      expect(() => previewSpreadsheetGrid(input, config)).toThrow("GRID_SHAPE");
    expect(calls).toBe(0);
    const nullPrototype = Object.assign(Object.create(null), grid());
    expect(previewSpreadsheetGrid(nullPrototype, config).rows).toHaveLength(1);
  });

  it("enforces row, column, cell, header and Unicode limits without clipping", () => {
    expect(() => previewSpreadsheetGrid({ headers: [], rows: [] }, config)).toThrow("GRID_HEADERS");
    expect(() => previewSpreadsheetGrid({ headers: ["key", "key"], rows: [] }, config)).toThrow("GRID_HEADERS");
    expect(() => previewSpreadsheetGrid({ headers: Array.from({ length: 65 }, (_, i) => `h${i}`), rows: [] }, config)).toThrow("GRID_COLUMNS");
    expect(() => previewSpreadsheetGrid({ headers: grid().headers, rows: Array.from({ length: 1001 }, () => grid().rows[0]) }, config)).toThrow("GRID_ROWS");
    expect(() => previewSpreadsheetGrid({ headers: grid().headers, rows: [["a", id(3), "x".repeat(4097)]] }, config)).toThrow("GRID_CELL_SIZE");
    for (const invalid of ["\0", "\ud800", "\udfff"])
      expect(() => previewSpreadsheetGrid({ headers: grid().headers, rows: [["a", id(3), invalid]] }, config)).toThrow("GRID_ENCODING");
    expect(previewSpreadsheetGrid({ headers: grid().headers, rows: [["a", id(3), "😀"]] }, config).rows[0]!.fields[0]!.raw).toBe("😀");
    const headers = ["key", "project", "status", ...Array.from({ length: 61 }, (_, i) => `h${i}`)];
    const one = ["a", id(3), "x".repeat(4096), ...Array(61).fill("")];
    expect(previewSpreadsheetGrid({ headers, rows: [one] }, config).rows).toHaveLength(1);
    expect(previewSpreadsheetGrid({ headers: grid().headers, rows: Array.from({ length: 1000 }, () => ["a", id(3), "Open"]) }, config).rows).toHaveLength(1000);
    const header256 = "h".repeat(256);
    expect(previewSpreadsheetGrid({ headers: [...grid().headers, header256], rows: [] }, config).headers).toContain(header256);
    expect(() => previewSpreadsheetGrid({ headers: [...grid().headers, header256 + "h"], rows: [] }, config)).toThrow("GRID_HEADERS");
  });

  it("enforces the aggregate UTF-8 byte boundary independently of cell count", () => {
    const headers = ["key", "project", "status"];
    const rows = Array.from({ length: 253 }, () => ["k", id(3), "x".repeat(4096)]);
    const used = headers.join("").length + rows.length * (1 + id(3).length + 4096);
    const finalSize = 1_048_576 - used - 1 - id(3).length;
    rows.push(["k", id(3), "x".repeat(finalSize)]);
    expect(previewSpreadsheetGrid({ headers, rows }, config).rows).toHaveLength(254);
    rows[rows.length - 1]![2] += "x";
    expect(() => previewSpreadsheetGrid({ headers, rows }, config)).toThrow("GRID_SIZE");
    const unicode = Array.from({ length: 128 }, () => ["k", id(3), "😀".repeat(2048)]);
    expect(() => previewSpreadsheetGrid({ headers, rows: unicode }, config)).toThrow("GRID_SIZE");
  });
});
