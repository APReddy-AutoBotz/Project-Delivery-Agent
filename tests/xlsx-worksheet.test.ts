import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CSV_LIMITS,
  previewSpreadsheetGrid,
} from "../packages/domain/src/spreadsheet-preview.js";
import { readXlsxWorksheet } from "../scripts/acceptance/xlsx-worksheet.mjs";
import { writeTestArchive } from "./fixtures/xlsx-test-archive.js";

const wbNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const typesNs = "http://schemas.openxmlformats.org/package/2006/content-types";
const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.";
const relationPath = "xl/_rels/workbook.xml.rels";
const sheetPath = "xl/worksheets/sheet1.xml";
const xml = '<?xml version="1.0" encoding="UTF-8"?>';
const id = (n: number) =>
  "10000000-0000-4000-8000-" + String(n).padStart(12, "0");

const matrix = [
  ["Issue ID", "Project", "Forecast"],
  ["001", id(3), "2027-03-02"],
  ["002", id(3), "2027-04-15"],
];
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

function escapeCell(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function column(index: number): string {
  const n = index + 1;
  return (
    (n > 26 ? String.fromCharCode(64 + Math.floor((n - 1) / 26)) : "") +
    String.fromCharCode(65 + ((n - 1) % 26))
  );
}

function fixtureParts(values = matrix, shared = false): Map<string, string> {
  const strings = [...new Set(values.flat())];
  const rows = values.map((row, i) => {
    const number = String(i + 1);
    const cells = row.map((value, j) => {
      const coordinate = column(j) + number;
      if (shared) {
        return (
          '<x:c r="' +
          coordinate +
          '" t="s"><x:v>' +
          strings.indexOf(value) +
          "</x:v></x:c>"
        );
      }
      return (
        '<x:c r="' +
        coordinate +
        '" t="inlineStr"><x:is><x:t xml:space="preserve">' +
        escapeCell(value) +
        "</x:t></x:is></x:c>"
      );
    });
    return '<x:row r="' + number + '">' + cells.join("") + "</x:row>";
  });
  const defaults =
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
  const formattedTypes = [
    '<Override PartName="/xl/workbook.xml" ContentType="' +
      mime +
      'sheet.main+xml"/>',
    '<Override PartName="/' +
      sheetPath +
      '" ContentType="' +
      mime +
      'worksheet+xml"/>',
    shared
      ? '<Override PartName="/xl/sharedStrings.xml" ContentType="' +
        mime +
        'sharedStrings+xml"/>'
      : "",
  ];
  const parts = new Map([
    [
      "[Content_Types].xml",
      xml +
        '<Types xmlns="' +
        typesNs +
        '">' +
        defaults +
        formattedTypes.join("") +
        "</Types>",
    ],
    [
      "_rels/.rels",
      xml +
        '<Relationships xmlns="' +
        relNs +
        '"><Relationship Id="doc" Type="' +
        officeNs +
        '/officeDocument" Target="/xl/workbook.xml"/></Relationships>',
    ],
    [
      "xl/workbook.xml",
      xml +
        '<x:workbook xmlns:x="' +
        wbNs +
        '" xmlns:r="' +
        officeNs +
        '"><x:sheets><x:sheet name="Portfolio" sheetId="1" r:id="sheet"/></x:sheets></x:workbook>',
    ],
    [
      relationPath,
      xml +
        '<Relationships xmlns="' +
        relNs +
        '"><Relationship Id="sheet" Type="' +
        officeNs +
        '/worksheet" Target="worksheets/sheet1.xml"/>' +
        (shared
          ? '<Relationship Id="strings" Type="' +
            officeNs +
            '/sharedStrings" Target="/xl/sharedStrings.xml"/>'
          : "") +
        "</Relationships>",
    ],
    [
      sheetPath,
      xml +
        '<x:worksheet xmlns:x="' +
        wbNs +
        '"><x:sheetData>' +
        rows.join("") +
        "</x:sheetData></x:worksheet>",
    ],
  ]);
  if (shared) {
    parts.set(
      "xl/sharedStrings.xml",
      xml +
        '<x:sst xmlns:x="' +
        wbNs +
        '" count="' +
        values.reduce((count, row) => count + row.length, 0) +
        '" uniqueCount="' +
        strings.length +
        '">' +
        strings
          .map((value) => "<x:si><x:t>" + escapeCell(value) + "</x:t></x:si>")
          .join("") +
        "</x:sst>",
    );
  }
  return parts;
}

function book(parts: Map<string, string>): Buffer {
  return writeTestArchive(
    [...parts].map(([name, content]) => ({
      name,
      content: Buffer.from(content),
    })),
    {
      deflate: true,
    },
  );
}

function modify(
  parts: Map<string, string>,
  part: string,
  search: string,
  replacement: string,
) {
  const before = parts.get(part)!;
  if (!before.includes(search))
    throw new Error("Fixture replacement is missing");
  parts.set(part, before.replace(search, replacement));
}

const reject = /^XLSX_WORKSHEET_REJECTED$/u;

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
