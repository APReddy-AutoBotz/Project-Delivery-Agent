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
const mcNs = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const excelNs = "http://schemas.microsoft.com/office/spreadsheetml/";
const coreNs =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const appNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const vtNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const dctermsNs = "http://purl.org/dc/terms/";
const appPart = "docProps/app.xml";
const corePart = "docProps/core.xml";

function namespace(prefix: string, suffix: string): string {
  return `xmlns:${prefix}="${excelNs}${suffix}"`;
}

// Authored from the supported package shape. All document metadata is fictional.
function excelTextParts(): Map<string, string> {
  const parts = fixtureParts(matrix, true);
  modify(
    parts,
    "_rels/.rels",
    "</Relationships>",
    `<Relationship Id="core" Type="${relNs}/metadata/core-properties" Target="${corePart}"/>
     <Relationship Id="app" Type="${officeNs}/extended-properties" Target="${appPart}"/>
     </Relationships>`,
  );
  modify(
    parts,
    "[Content_Types].xml",
    "</Types>",
    `<Override PartName="/${corePart}" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
     <Override PartName="/${appPart}" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
     </Types>`,
  );
  const revision = namespace("xr", "2014/revision");
  const revision2 = namespace("xr2", "2015/revision2");
  const mc = `xmlns:mc="${mcNs}"`;
  const sheets =
    '<x:sheets><x:sheet name="Portfolio" sheetId="1" r:id="sheet"/></x:sheets>';
  parts.set(
    "xl/workbook.xml",
    xml +
      `<x:workbook xmlns:x="${wbNs}" xmlns:r="${officeNs}" ${mc}
      ${namespace("x15", "2010/11/main")} ${revision} ${revision2}
      ${namespace("xr6", "2016/revision6")} ${namespace("xr10", "2016/revision10")}
      mc:Ignorable="x15 xr xr6 xr10 xr2">
      <x:fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="1"/>
      <x:workbookPr/>
      <mc:AlternateContent><mc:Choice Requires="x15">
        <path:absPath ${namespace("path", "2010/11/ac")} url="file:///fictional/"/>
      </mc:Choice></mc:AlternateContent>
      <xr:revisionPtr documentId="synthetic" revIDLastSave="0" xr10:uidLastSave="synthetic"
        xr6:coauthVersionLast="0" xr6:coauthVersionMax="0"/>
      <x:bookViews><x:workbookView xWindow="-1" yWindow="2" windowWidth="100"
        windowHeight="100" xr2:uid="synthetic"/></x:bookViews>
      ${sheets}<x:calcPr calcId="1"/>
    </x:workbook>`,
  );
  modify(
    parts,
    sheetPath,
    '<x:worksheet xmlns:x="' + wbNs + '">',
    `<x:worksheet xmlns:x="${wbNs}" ${mc} ${namespace("x14ac", "2009/9/ac")}
      ${revision} ${revision2} ${namespace("xr3", "2016/revision3")}
      mc:Ignorable="x14ac xr xr2 xr3" xr:uid="synthetic">
      <x:dimension ref="A1:C3"/>
      <x:sheetViews><x:sheetView tabSelected="1" workbookViewId="0"/></x:sheetViews>
      <x:sheetFormatPr defaultRowHeight="15"/>`,
  );
  parts.set(
    sheetPath,
    parts.get(sheetPath)!.replaceAll(/<x:row r="[1-3]"/gu, '$& spans="1:3"'),
  );
  modify(
    parts,
    sheetPath,
    "</x:worksheet>",
    '<x:pageMargins left="1" right="1" top="1" bottom="1" header="0" footer="0"/></x:worksheet>',
  );
  parts.set(
    corePart,
    xml +
      `<cp:coreProperties xmlns:cp="${coreNs}" xmlns:dcterms="${dctermsNs}"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <dcterms:created xsi:type="dcterms:W3CDTF">2027-01-01T00:00:00Z</dcterms:created>
      <dcterms:modified xsi:type="dcterms:W3CDTF">2027-01-01T00:00:00Z</dcterms:modified>
    </cp:coreProperties>`,
  );
  parts.set(
    appPart,
    xml +
      `<Properties xmlns="${appNs}" xmlns:vt="${vtNs}">
      <Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>
      <HeadingPairs><vt:vector size="2" baseType="variant">
        <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
        <vt:variant><vt:i4>1</vt:i4></vt:variant>
      </vt:vector></HeadingPairs>
      <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Portfolio</vt:lpstr></vt:vector></TitlesOfParts>
      <LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>
      <HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0</AppVersion>
    </Properties>`,
  );
  return parts;
}

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
