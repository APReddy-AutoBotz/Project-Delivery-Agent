import { writeTestArchive } from "./xlsx-test-archive.ts";

export const wbNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/package/2006/relationships";
export const officeNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const typesNs = "http://schemas.openxmlformats.org/package/2006/content-types";
export const mime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.";
export const relationPath = "xl/_rels/workbook.xml.rels";
export const sheetPath = "xl/worksheets/sheet1.xml";
export const xml = '<?xml version="1.0" encoding="UTF-8"?>';
export const id = (n: number) =>
  "10000000-0000-4000-8000-" + String(n).padStart(12, "0");

export const matrix = [
  ["Issue ID", "Project", "Forecast"],
  ["001", id(3), "2027-03-02"],
  ["002", id(3), "2027-04-15"],
];
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

export function fixtureParts(
  values = matrix,
  shared = false,
): Map<string, string> {
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

export function book(parts: Map<string, string>): Buffer {
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

export function modify(
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

const mcNs = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const excelNs = "http://schemas.microsoft.com/office/spreadsheetml/";
const coreNs =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const appNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const vtNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const dctermsNs = "http://purl.org/dc/terms/";
export const appPart = "docProps/app.xml";
const corePart = "docProps/core.xml";

function namespace(prefix: string, suffix: string): string {
  return `xmlns:${prefix}="${excelNs}${suffix}"`;
}

// Authored from the supported package shape. All document metadata is fictional.
export function excelTextParts(): Map<string, string> {
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
