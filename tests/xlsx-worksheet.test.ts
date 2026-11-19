import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CSV_LIMITS,
  previewSpreadsheetGrid,
} from "../packages/domain/src/spreadsheet-preview.js";
import { readXlsxWorksheet } from "../scripts/acceptance/xlsx-worksheet.mjs";
import { writeTestArchive } from "./fixtures/xlsx-test-archive.js";

import {
  appPart,
  book,
  excelTextParts,
  fixtureParts,
  id,
  matrix,
  mime,
  modify,
  officeNs,
  relationPath,
  sheetPath,
  wbNs,
  xml,
} from "./fixtures/xlsx-test-worksheet.js";

const config = {
  customerId: id(1),
  sourceId: id(2),
  sheet: "Portfolio",
  mappingRevision: "1",
  fileName: "synthetic",
  identityColumn: "Issue ID",
  projectColumn: "Project",
  projectIds: [id(3)],
  fields: [
    {
      column: "Forecast",
      factType: "project.forecast",
      type: "date",
      required: true,
    },
  ],
};

const reject = /^XLSX_WORKSHEET_REJECTED$/u;
describe("FR-CON-006/007 explicit offline Excel text profile", () => {
  const profile = "excel-text-v1";

  it("maps a normalized package into two date proposals and preserves the text keys", async () => {
    const archive = book(excelTextParts());
    const grid = await readXlsxWorksheet(archive, config.sheet, profile);
    expect(grid).toEqual({ headers: matrix[0], rows: matrix.slice(1) });
    const preview = previewSpreadsheetGrid(grid, config);
    expect(
      preview.rows.map(({ rowNumber, key, operation, proposals }) => [
        rowNumber,
        key,
        operation,
        proposals[0]!.value.value,
      ]),
    ).toEqual([
      [2, "001", "CREATE", "2027-03-02"],
      [3, "002", "CREATE", "2027-04-15"],
    ]);
    await expect(readXlsxWorksheet(archive, config.sheet)).rejects.toThrow(
      reject,
    );
    await expect(
      readXlsxWorksheet(
        book(fixtureParts(matrix, true)),
        config.sheet,
        profile,
      ),
    ).rejects.toThrow(reject);
  });

  it.each([
    [
      "compatibility branch",
      "xl/workbook.xml",
      'Requires="x15"',
      'Requires="xr2"',
    ],
    [
      "unbound compatibility prefix",
      "xl/workbook.xml",
      'Requires="x15"',
      'Requires="unknown"',
    ],
    [
      "alternate fallback",
      "xl/workbook.xml",
      "</mc:AlternateContent>",
      "<mc:Fallback/></mc:AlternateContent>",
    ],
    [
      "invalid window size",
      "xl/workbook.xml",
      'windowWidth="100"',
      'windowWidth="-1"',
    ],
    [
      "hidden worksheet",
      "xl/workbook.xml",
      'sheetId="1"',
      'sheetId="1" state="hidden"',
    ],
    [
      "external worksheet",
      relationPath,
      'Target="worksheets/sheet1.xml"',
      'Target="worksheets/sheet1.xml" TargetMode="External"',
    ],
    [
      "different metadata sheet",
      appPart,
      "<vt:lpstr>Portfolio",
      "<vt:lpstr>Other",
    ],
    ["ambiguous dimensions", sheetPath, 'ref="A1:C3"', 'ref="A1:D3"'],
    ["ambiguous spans", sheetPath, 'spans="1:3"', 'spans="1:4"'],
    ["hidden row", sheetPath, '<x:row r="2"', '<x:row r="2" hidden="1"'],
    ["cached string", sheetPath, 't="s"', 't="str"'],
    ["formula", sheetPath, "<x:v>0</x:v>", "<x:f>1</x:f><x:v>0</x:v>"],
    ["style reference", sheetPath, 'r="A1" t="s"', 'r="A1" t="s" s="0"'],
    [
      "shared-string count mismatch",
      "xl/sharedStrings.xml",
      'count="9"',
      'count="8"',
    ],
  ])("rejects %s", async (_label, part, before, after) => {
    const parts = excelTextParts();
    modify(parts, part, before, after);
    await expect(
      readXlsxWorksheet(book(parts), config.sheet, profile),
    ).rejects.toThrow(reject);
  });

  it.each(["orphan", "override", "partial", "wrong bytes"])(
    "rejects %s presentation parts",
    async (variant) => {
      const parts = excelTextParts();
      const styleType = mime + "styles+xml";
      const themeType =
        "application/vnd.openxmlformats-officedocument.theme+xml";
      if (variant !== "override")
        parts.set("xl/styles.xml", `<styleSheet xmlns="${wbNs}"/>`);
      if (variant !== "orphan") {
        modify(
          parts,
          "[Content_Types].xml",
          "</Types>",
          `<Override PartName="/xl/styles.xml" ContentType="${styleType}"/></Types>`,
        );
      }
      if (variant === "partial" || variant === "wrong bytes") {
        modify(
          parts,
          relationPath,
          "</Relationships>",
          `<Relationship Id="styles" Type="${officeNs}/styles" Target="styles.xml"/></Relationships>`,
        );
      }
      if (variant === "wrong bytes") {
        parts.set(
          "xl/theme/theme1.xml",
          '<theme xmlns="http://schemas.openxmlformats.org/drawingml/2006/main"/>',
        );
        modify(
          parts,
          relationPath,
          "</Relationships>",
          `<Relationship Id="theme" Type="${officeNs}/theme" Target="theme/theme1.xml"/></Relationships>`,
        );
        modify(
          parts,
          "[Content_Types].xml",
          "</Types>",
          `<Override PartName="/xl/theme/theme1.xml" ContentType="${themeType}"/></Types>`,
        );
      }
      await expect(
        readXlsxWorksheet(book(parts), config.sheet, profile),
      ).rejects.toThrow(reject);
    },
  );
});

describe("FR-CON-006/007 offline worksheet decoding", () => {
  it.each([false, true])(
    "previews the same real ZIP workbook rows for inline and shared text (%s)",
    async (shared) => {
      const grid = await readXlsxWorksheet(
        book(fixtureParts(matrix, shared)),
        config.sheet,
      );
      expect(grid).toEqual({ headers: matrix[0], rows: matrix.slice(1) });
      const preview = previewSpreadsheetGrid(grid, config);
      expect(
        preview.rows.map((row) => [row.rowNumber, row.key, row.operation]),
      ).toEqual([
        [2, "001", "CREATE"],
        [3, "002", "CREATE"],
      ]);
      expect(preview.rows[0]!.fields[0]!.raw).toBe("2027-03-02");
    },
  );

  it("preserves leading zeroes, Unicode, XML text and whitespace in the grid", async () => {
    const literal = [["key"], ["  000 Δ<&>  "]];
    expect(
      await readXlsxWorksheet(book(fixtureParts(literal)), "Portfolio"),
    ).toEqual({
      headers: ["key"],
      rows: [["  000 Δ<&>  "]],
    });
  });

  it("looks up the exact visible sheet bound by the workbook relationship", async () => {
    const parts = fixtureParts();
    const archive = book(parts);
    await expect(readXlsxWorksheet(archive, "portfolio")).rejects.toThrow(
      reject,
    );
    modify(
      parts,
      "xl/workbook.xml",
      'sheetId="1"',
      'sheetId="1" state="veryHidden"',
    );
    await expect(readXlsxWorksheet(book(parts), "Portfolio")).rejects.toThrow(
      reject,
    );
  });

  it.each([
    [relationPath, 'Id="sheet"', 'Id="other"'],
    [relationPath, 'Id="sheet"', 'Id="sheet" TargetMode="External"'],
    [
      relationPath,
      'Target="worksheets/sheet1.xml"',
      'Target="worksheets/other.xml"',
    ],
    ["[Content_Types].xml", "worksheet+xml", "sheet.main+xml"],
    [sheetPath, 'r="2"', 'r="3"'],
    [sheetPath, 'r="A2"', 'r="C2"'],
    [sheetPath, '<x:row r="2">', '<x:row r="2" hidden="1">'],
    [sheetPath, "<x:sheetData>", "<x:cols/><x:sheetData>"],
    [sheetPath, "</x:sheetData>", "</x:sheetData><x:mergeCells/>"],
    [sheetPath, 't="inlineStr"', 't="str"'],
    [
      sheetPath,
      '<x:is><x:t xml:space="preserve">',
      '<x:f>1</x:f><x:is><x:t xml:space="preserve">',
    ],
    [sheetPath, "Issue ID", "Issue_x0020_ID"],
    [sheetPath, "Issue ID", "Issue &unknown; ID"],
    [sheetPath, wbNs, "urn:unrecognized-spreadsheet"],
  ])(
    "rejects an incompatible workbook part %s",
    async (part, before, after) => {
      const parts = fixtureParts();
      modify(parts, part, before, after);
      await expect(readXlsxWorksheet(book(parts), "Portfolio")).rejects.toThrow(
        reject,
      );
    },
  );

  it("rejects unknown parts, document declarations and processing instructions", async () => {
    const extra = fixtureParts();
    extra.set("xl/unrelated.xml", "<unknown/>");
    await expect(readXlsxWorksheet(book(extra), "Portfolio")).rejects.toThrow(
      reject,
    );
    for (const insertion of [
      "<!DOCTYPE worksheet>",
      "<?synthetic processing?>",
      "<!-- comment -->",
    ]) {
      const parts = fixtureParts();
      modify(parts, sheetPath, xml, xml + insertion);
      await expect(readXlsxWorksheet(book(parts), "Portfolio")).rejects.toThrow(
        reject,
      );
    }
  });

  it("rejects malformed UTF-8 and XML outside the strict namespace profile", async () => {
    const parts = fixtureParts();
    const records = [...parts].map(([name, content]) => ({
      name,
      content: Buffer.from(content),
    }));
    const sheet = records.find(({ name }) => name === sheetPath)!;
    sheet.content[sheet.content.indexOf("Issue ID")] = 0xff;
    await expect(
      readXlsxWorksheet(writeTestArchive(records), "Portfolio"),
    ).rejects.toThrow(reject);

    const newerXml = fixtureParts();
    modify(newerXml, sheetPath, 'version="1.0"', 'version="1.1"');
    await expect(
      readXlsxWorksheet(book(newerXml), "Portfolio"),
    ).rejects.toThrow(reject);

    const duplicate = fixtureParts();
    modify(
      duplicate,
      "xl/workbook.xml",
      'r:id="sheet"',
      'r:id="sheet" xmlns:other="' + officeNs + '" other:id="sheet"',
    );
    await expect(
      readXlsxWorksheet(book(duplicate), "Portfolio"),
    ).rejects.toThrow(reject);

    const badPrefix = fixtureParts();
    modify(
      badPrefix,
      "xl/workbook.xml",
      'r:id="sheet"',
      'r:id="sheet" xmlns:0alias="' + officeNs + '"',
    );
    await expect(
      readXlsxWorksheet(book(badPrefix), "Portfolio"),
    ).rejects.toThrow(reject);
  });

  it("accepts at most one leading UTF-8 byte-order mark in an XML part", async () => {
    const parts = fixtureParts();
    modify(parts, sheetPath, xml, "\uFEFF" + xml);
    expect(await readXlsxWorksheet(book(parts), "Portfolio")).toEqual({
      headers: matrix[0],
      rows: matrix.slice(1),
    });
    modify(parts, sheetPath, xml, "\uFEFF" + xml);
    await expect(readXlsxWorksheet(book(parts), "Portfolio")).rejects.toThrow(
      reject,
    );
  });

  it("rejects noncanonical/out-of-range shared indices and inaccurate counts", async () => {
    for (const [part, search, replacement] of [
      [sheetPath, "<x:v>0</x:v>", "<x:v>00</x:v>"],
      [sheetPath, "<x:v>0</x:v>", "<x:v>9</x:v>"],
      ["xl/sharedStrings.xml", 'count="9"', 'count="8"'],
      ["xl/sharedStrings.xml", ' count="9"', ""],
      ["xl/sharedStrings.xml", ' uniqueCount="8"', ""],
    ]) {
      const parts = fixtureParts(matrix, true);
      modify(parts, part!, search!, replacement!);
      await expect(readXlsxWorksheet(book(parts), "Portfolio")).rejects.toThrow(
        reject,
      );
    }
  });

  it("checks the total across mixed inline and shared cells when counts are present", async () => {
    const parts = fixtureParts(matrix, true);
    modify(
      parts,
      sheetPath,
      '<x:c r="B2" t="s"><x:v>4</x:v></x:c>',
      '<x:c r="B2" t="inlineStr"><x:is><x:t>' + id(3) + "</x:t></x:is></x:c>",
    );
    const expected = { headers: matrix[0], rows: matrix.slice(1) };
    expect(await readXlsxWorksheet(book(parts), "Portfolio")).toEqual(expected);
    modify(parts, "xl/sharedStrings.xml", ' count="9" uniqueCount="8"', "");
    expect(await readXlsxWorksheet(book(parts), "Portfolio")).toEqual(expected);
  });

  it("charges each shared-string occurrence to the decoded byte budget", async () => {
    const string = "a".repeat(CSV_LIMITS.cell);
    const exact = Array.from(
      { length: CSV_LIMITS.bytes / CSV_LIMITS.cell },
      () => [string],
    );
    const result = await readXlsxWorksheet(
      book(fixtureParts(exact, true)),
      "Portfolio",
    );
    expect(result.rows.length + 1).toBe(exact.length);
    const oversized = [...exact, [string]];
    await expect(
      readXlsxWorksheet(book(fixtureParts(oversized, true)), "Portfolio"),
    ).rejects.toThrow(reject);
  });

  it("preserves all physical coordinates within the combined row and column limit", async () => {
    const sized = Array.from({ length: CSV_LIMITS.rows + 1 }, () =>
      Array.from({ length: CSV_LIMITS.columns }, () => ""),
    );
    sized[CSV_LIMITS.rows]![CSV_LIMITS.columns - 1] = "last";
    const result = await readXlsxWorksheet(
      book(fixtureParts(sized, true)),
      "Portfolio",
    );
    expect(result.headers.length).toBe(CSV_LIMITS.columns);
    expect(result.rows.length).toBe(CSV_LIMITS.rows);
    expect(result.rows.at(-1)?.at(-1)).toBe("last");
    await expect(
      readXlsxWorksheet(
        book(fixtureParts([...sized, sized[0]!], true)),
        "Portfolio",
      ),
    ).rejects.toThrow(reject);
  }, 20_000);

  it("keeps the broader archive fixture out of this strict worksheet profile", async () => {
    const externalFixture = readFileSync(
      new URL("./fixtures/xlsx-archive-portfolio.xlsx", import.meta.url),
    );
    await expect(
      readXlsxWorksheet(externalFixture, "Portfolio"),
    ).rejects.toThrow(reject);
  });
});
