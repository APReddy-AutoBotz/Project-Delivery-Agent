import { describe, expect, it } from "vitest";
import { previewSpreadsheetGrid, previewSyntheticWorksheet } from "../packages/domain/src/spreadsheet-preview.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const config = { customerId: id(1), sourceId: id(2), sheet: "portfolio", mappingRevision: "1", fileName: "synthetic",
  identityColumn: "key", projectColumn: "project", projectIds: [id(3)],
  fields: [{ column: "status", factType: "status", type: "text", required: true }] };
const matrix = [["key", "project", "status"], ["a", id(3), "Open"], ["b", id(3), "Closed"]];
const descriptor = (values = matrix) => ({ version: 1, complete: true, macros: false, externalRelationships: false,
  unsupportedFeatures: false, sheets: [{ name: "portfolio", visibility: "VISIBLE", rowCount: values.length,
    columnCount: values[0]!.length, hiddenRows: false, hiddenColumns: false, mergedCells: false, unsupportedFeatures: false,
    cells: values.flatMap((row, rowIndex) => row.map((value, columnIndex) => ({
      row: rowIndex + 1, column: columnIndex + 1, kind: "TEXT", value, formula: false,
    }))) }] });

describe("synthetic worksheet declaration", () => {
  it("maps exact physical rows through the existing grid without aliasing", () => {
    const input = descriptor(), copy = structuredClone(input);
    const output = previewSyntheticWorksheet(input, config);
    expect(output).toEqual(previewSpreadsheetGrid({ headers: matrix[0], rows: matrix.slice(1) }, config));
    expect(output.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(input).toEqual(copy);
    input.sheets[0]!.cells[5]!.value = "changed";
    expect(output.rows[0]!.fields[0]!.raw).toBe("Open");
  });

  it("preserves baseline scope and mapping validation before interpreting the descriptor", () => {
    expect(() => previewSyntheticWorksheet({}, {}, {})).toThrow("INVALID_INPUT");
    const baseline = { customerId: id(1), sourceId: id(99), sheet: "portfolio", mappingRevision: "1", rows: [] };
    expect(() => previewSyntheticWorksheet({}, config, baseline)).toThrow("INVALID_BASELINE");
  });

  it("retains baseline updates and reports missing keys without manufacturing removals", () => {
    const baseline = { customerId: id(1), sourceId: id(2), sheet: "portfolio", mappingRevision: "1", rows: [
      { key: "a", projectId: id(3), fields: [{ factType: "status", value: { type: "text", value: "Earlier" } }] },
      { key: "missing", projectId: id(3), fields: [{ factType: "status", value: { type: "text", value: "Open" } }] },
    ] };
    const result = previewSyntheticWorksheet(descriptor(), config, baseline);
    expect(result.rows[0]!.operation).toBe("UPDATE");
    expect(result.missingPreviousKeys).toEqual(["missing"]);
    expect(result).toEqual(previewSpreadsheetGrid({ headers: matrix[0], rows: matrix.slice(1) }, config, baseline));
  });

  it("rejects missing, unknown, true and mismatched workbook or sheet declarations", () => {
    for (const change of [
      (v: any) => { delete v.complete; }, (v: any) => { v.complete = false; },
      (v: any) => { delete v.macros; }, (v: any) => { delete v.externalRelationships; },
      (v: any) => { delete v.unsupportedFeatures; }, (v: any) => { delete v.sheets; },
      (v: any) => { v.version = 2; }, (v: any) => { v.macros = true; },
      (v: any) => { v.externalRelationships = true; }, (v: any) => { v.unsupportedFeatures = true; },
      (v: any) => { v.extra = false; }, (v: any) => { v.sheets = []; },
      (v: any) => { v.sheets.push(structuredClone(v.sheets[0])); },
      (v: any) => { v.sheets[0].name = "Portfolio"; }, (v: any) => { v.sheets[0].visibility = "HIDDEN"; },
      (v: any) => { v.sheets[0].hiddenRows = true; }, (v: any) => { v.sheets[0].hiddenColumns = true; },
      (v: any) => { v.sheets[0].mergedCells = true; }, (v: any) => { v.sheets[0].unsupportedFeatures = true; },
      (v: any) => { delete v.sheets[0].hiddenColumns; }, (v: any) => { v.sheets[0].extra = false; },
      (v: any) => { delete v.sheets[0].hiddenRows; }, (v: any) => { delete v.sheets[0].mergedCells; },
      (v: any) => { delete v.sheets[0].unsupportedFeatures; }, (v: any) => { delete v.sheets[0].visibility; },
    ]) {
      const input = descriptor(); change(input);
      expect(() => previewSyntheticWorksheet(input, config)).toThrow("WORKSHEET_SHAPE");
    }
  });

  it("requires ordered contiguous physical coordinates and literal cells", () => {
    for (const change of [
      (v: any) => { v.sheets[0].cells[0].row = 2; }, (v: any) => { v.sheets[0].cells[0].column = 2; },
      (v: any) => { v.sheets[0].cells[1].column = 1; }, (v: any) => { v.sheets[0].cells.pop(); },
      (v: any) => { v.sheets[0].cells.reverse(); }, (v: any) => { v.sheets[0].rowCount++; },
      (v: any) => { v.sheets[0].columnCount++; }, (v: any) => { v.sheets[0].cells[5].formula = true; },
      (v: any) => { delete v.sheets[0].cells[5].formula; }, (v: any) => { v.sheets[0].cells[5].kind = "NUMBER"; },
      (v: any) => { v.sheets[0].cells[5].value = null; }, (v: any) => { v.sheets[0].cells[5].cached = "Open"; },
      (v: any) => { v.sheets[0].cells[5].value = "x".repeat(4097); },
    ]) {
      const input = descriptor(); change(input);
      expect(() => previewSyntheticWorksheet(input, config)).toThrow("WORKSHEET_SHAPE");
    }
    const empty = descriptor([["key", "project", "status"], ["a", id(3), ""]]);
    expect(previewSyntheticWorksheet(empty, config).rows[0]!.fields[0]).toMatchObject({ state: "INVALID", code: "REQUIRED_VALUE" });
  });

  it("rejects accessors, symbols, sparse arrays and inherited properties without invoking getters", () => {
    let calls = 0;
    const accessor = descriptor(); Object.defineProperty(accessor.sheets[0]!.cells[0]!, "value", { get() { calls++; return "key"; } });
    const sparse = descriptor(); delete (sparse.sheets[0]!.cells as any)[0];
    const symbol = descriptor(); Object.defineProperty(symbol, Symbol("extra"), { value: true });
    const nestedSymbol = descriptor(); Object.defineProperty(nestedSymbol.sheets[0]!.cells, Symbol("extra"), { value: true });
    const nestedAccessor = descriptor(); Object.defineProperty(nestedAccessor.sheets[0]!.cells, "0", { get() { calls++; return {}; } });
    const inherited = Object.assign(Object.create({ extra: true }), descriptor());
    for (const input of [accessor, sparse, symbol, nestedSymbol, nestedAccessor, inherited]) expect(() => previewSyntheticWorksheet(input, config)).toThrow("WORKSHEET_SHAPE");
    expect(calls).toBe(0);
  });

  it("checks dimensions before mapping and inherits grid encoding and aggregate bounds", () => {
    const tooManyRows = descriptor(); tooManyRows.sheets[0]!.rowCount = 1002;
    const tooManyColumns = descriptor(); tooManyColumns.sheets[0]!.columnCount = 65;
    expect(() => previewSyntheticWorksheet(tooManyRows, config)).toThrow("WORKSHEET_SHAPE");
    expect(() => previewSyntheticWorksheet(tooManyColumns, config)).toThrow("WORKSHEET_SHAPE");
    const invalidUnicode = descriptor(); invalidUnicode.sheets[0]!.cells[5]!.value = "\ud800";
    expect(() => previewSyntheticWorksheet(invalidUnicode, config)).toThrow("GRID_ENCODING");
    const large = descriptor([["key", "project", "status"], ...Array.from({ length: 257 }, (_, i) => [String(i), id(3), "x".repeat(4096)])]);
    expect(() => previewSyntheticWorksheet(large, config)).toThrow("GRID_SIZE");
  });

  it("accepts the exact row, column, cell and decoded-byte bounds without truncation", () => {
    const headers = ["key", "project", "status", ...Array.from({ length: 61 }, (_, i) => `h${i}`)];
    const row = ["a", id(3), "x".repeat(4096), ...Array(61).fill("")];
    expect(previewSyntheticWorksheet(descriptor([headers, row]), config).headers).toHaveLength(64);
    expect(previewSyntheticWorksheet(descriptor([matrix[0]!]), config).rows).toHaveLength(0);
    const manyRows = descriptor([headers, ...Array.from({ length: 1000 }, (_, i) => [String(i), id(3), "Open", ...Array(61).fill("")])]);
    expect(previewSyntheticWorksheet(manyRows, config).rows).toHaveLength(1000);
    const rows = Array.from({ length: 253 }, () => ["k", id(3), "x".repeat(4096)]);
    const used = matrix[0]!.join("").length + rows.length * (1 + id(3).length + 4096);
    rows.push(["k", id(3), "x".repeat(1_048_576 - used - 1 - id(3).length)]);
    const exact = descriptor([matrix[0]!, ...rows]);
    expect(previewSyntheticWorksheet(exact, config).rows).toHaveLength(254);
    exact.sheets[0]!.cells[exact.sheets[0]!.cells.length - 1]!.value += "x";
    expect(() => previewSyntheticWorksheet(exact, config)).toThrow("GRID_SIZE");
  });
});
