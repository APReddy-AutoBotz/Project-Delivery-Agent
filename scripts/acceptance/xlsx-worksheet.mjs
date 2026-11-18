import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { SaxesParser } from "saxes";
import { readXlsxArchive } from "./xlsx-archive.mjs";

const workbookNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeRelNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const typeNs = "http://schemas.openxmlformats.org/package/2006/content-types";
const xmlNs = "http://www.w3.org/XML/1998/namespace";
const xmlnsNs = "http://www.w3.org/2000/xmlns/";
const mimePrefix =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.";
const relMime = "application/vnd.openxmlformats-package.relationships+xml";
const workbookPart = "xl/workbook.xml";
const workbookRelations = "xl/_rels/workbook.xml.rels";
const stringPart = "xl/sharedStrings.xml";
const coreProperties = "docProps/core.xml";
const extendedProperties = "docProps/app.xml";
const stylePart = "xl/styles.xml";
const themePart = "xl/theme/theme1.xml";
const compatibilityNs =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";
const x15Ns = "http://schemas.microsoft.com/office/spreadsheetml/2010/11/main";
const x15AlternateNs =
  "http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac";
const x14AlternateNs =
  "http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac";
const revisionNs =
  "http://schemas.microsoft.com/office/spreadsheetml/2014/revision";
const revision2Ns =
  "http://schemas.microsoft.com/office/spreadsheetml/2015/revision2";
const revision3Ns =
  "http://schemas.microsoft.com/office/spreadsheetml/2016/revision3";
const revision6Ns =
  "http://schemas.microsoft.com/office/spreadsheetml/2016/revision6";
const revision10Ns =
  "http://schemas.microsoft.com/office/spreadsheetml/2016/revision10";
const coreNs =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const extendedNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const valueTypeNs =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const dublinElementNs = "http://purl.org/dc/elements/1.1/";
const dublinTermNs = "http://purl.org/dc/terms/";
const xsiNs = "http://www.w3.org/2001/XMLSchema-instance";
const ignorableAttr = "{" + compatibilityNs + "}Ignorable";
const xsiType = "{" + xsiNs + "}type";
const portableNamespaces = [workbookNs, relNs, officeRelNs, typeNs, xmlNs];
const excelNamespaces = [
  ...portableNamespaces,
  compatibilityNs,
  x15Ns,
  x15AlternateNs,
  x14AlternateNs,
  revisionNs,
  revision2Ns,
  revision3Ns,
  revision6Ns,
  revision10Ns,
  coreNs,
  extendedNs,
  valueTypeNs,
  dublinElementNs,
  dublinTermNs,
  "http://purl.org/dc/dcmitype/",
  xsiNs,
];
const excelPresentationHashes = new Map([
  [
    stylePart,
    "16d34b16516441904382dc87305bc7165145c5ea26f4b0db60a2117f5e2b286e",
  ],
  [
    themePart,
    "6467cd8adf5c5cdb4f1ed32e23259c168ea23e45b75e2e0f57635b80952d664c",
  ],
]);

const maxRows = 1001;
const maxColumns = 64;
const maxCells = maxRows * maxColumns;
const maxCellLength = 4096;
const maxGridBytes = 1_048_576;
const maxXmlElements = 1 + 1 + maxRows + maxCells * 3;
const qualifiedName =
  /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/u;
const namespacePrefix = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

function insist(condition) {
  if (!condition) throw new Error("XLSX_WORKSHEET_REJECTED");
}

function rejectXml() {
  insist(false);
}

function parseXml(bytes, excel = false) {
  insist(Buffer.isBuffer(bytes) && bytes.length > 0);
  // Let the XML parser account for the optional leading BOM exactly once.
  const input = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  // Disallow comments, CDATA and DTD declarations before the parser sees them.
  insist(!input.includes("<!"));
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0" });
  const stack = [];
  let root;
  let elementCount = 0;
  let attributeCount = 0;
  parser.on("error", rejectXml);
  parser.on("doctype", rejectXml);
  parser.on("processinginstruction", rejectXml);
  parser.on("xmldecl", ({ version, encoding }) => {
    insist(
      version === "1.0" &&
        (encoding === undefined || /^utf-8$/iu.test(encoding)),
    );
  });
  parser.on("opentagstart", ({ name }) => {
    elementCount += 1;
    insist(
      stack.length < 8 &&
        elementCount <= maxXmlElements &&
        name.length <= 64 &&
        qualifiedName.test(name),
    );
    attributeCount = 0;
  });
  parser.on("attribute", ({ name, value }) => {
    attributeCount += 1;
    insist(
      attributeCount <= (excel && stack.length === 0 ? 9 : 8) &&
        name.length <= 64 &&
        qualifiedName.test(name) &&
        value.length <= 256,
    );
    if (name === "xmlns" || name.startsWith("xmlns:")) {
      insist((excel ? excelNamespaces : portableNamespaces).includes(value));
    }
  });
  parser.on("opentag", (tag) => {
    const node = {
      uri: tag.uri,
      local: tag.local,
      attrs: new Map(),
      children: [],
      text: "",
    };
    for (const { uri, local, value } of Object.values(tag.attributes)) {
      if (uri === xmlnsNs) continue;
      const key = uri === "" ? local : "{" + uri + "}" + local;
      insist(!node.attrs.has(key));
      node.attrs.set(key, value);
    }
    if (excel) {
      const ignorable = node.attrs.get(ignorableAttr);
      if (ignorable !== undefined) {
        const prefixes = ignorable.split(" ");
        insist(prefixes.every((prefix) => namespacePrefix.test(prefix)));
        node.ignorableNamespaces = prefixes.map((prefix) =>
          parser.resolve(prefix),
        );
      }
      if (tag.uri === compatibilityNs && tag.local === "Choice") {
        const prefix = attr(node, "Requires");
        insist(namespacePrefix.test(prefix));
        node.requiredNamespace = parser.resolve(prefix);
      }
      const schemaType = node.attrs.get(xsiType);
      if (schemaType !== undefined) {
        const [prefix, name, remainder] = schemaType.split(":");
        if (prefix && name && remainder === undefined) {
          node.resolvedType = [parser.resolve(prefix), name];
        }
      }
    }
    const parent = stack.at(-1);
    if (parent) {
      parent.children.push(node);
    } else {
      insist(root === undefined);
      root = node;
    }
    stack.push(node);
  });
  parser.on("text", (text) => {
    const node = stack.at(-1);
    if (node) {
      // Only a cell's leaf text can be meaningful. Bound any other text too.
      insist(node.text.length + text.length <= maxCellLength);
      node.text += text;
    } else {
      insist(xmlWhitespace(text));
    }
  });
  parser.on("closetag", () => stack.pop());
  parser.write(input).close();
  insist(root !== undefined && stack.length === 0);
  return root;
}

// Only the four whitespace characters defined by XML may surround structure.
function xmlWhitespace(text) {
  return /^[\t\n\r ]*$/u.test(text);
}

function element(node, uri, local, attributes = []) {
  insist(
    node?.uri === uri &&
      node.local === local &&
      [...node.attrs.keys()].every((key) => attributes.includes(key)),
  );
  return node;
}

function structural(node) {
  insist(xmlWhitespace(node.text));
  return node.children;
}

function onlyChild(node, uri, local, attributes) {
  const children = structural(node);
  insist(children.length === 1);
  return element(children[0], uri, local, attributes);
}

function attr(node, name) {
  const value = node.attrs.get(name);
  insist(value !== undefined);
  return value;
}

function leaf(node) {
  insist(structural(node).length === 0);
}

function literalText(node) {
  const space = node.attrs.get("{" + xmlNs + "}space");
  insist(
    node.children.length === 0 &&
      (space === undefined || space === "preserve") &&
      !/_x[0-9a-f]{4}_/iu.test(node.text),
  );
  return node.text;
}

function relationshipTarget(source, target) {
  // This profile supports only ordinary internal part targets. Recognize both
  // OPC root-relative form and names relative to the relationship source part.
  insist(
    /^\/?(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.xml$/u.test(
      target,
    ),
  );
  if (target.startsWith("/")) return target.slice(1);
  return source.slice(0, source.lastIndexOf("/") + 1) + target;
}

function relationships(parts, partName, source) {
  const root = element(parseXml(parts.get(partName)), relNs, "Relationships");
  const result = new Map();
  const types = new Set();
  for (const child of structural(root)) {
    const node = element(child, relNs, "Relationship", [
      "Id",
      "Type",
      "Target",
      "TargetMode",
    ]);
    leaf(node);
    const id = attr(node, "Id");
    const type = attr(node, "Type");
    const mode = node.attrs.get("TargetMode");
    insist(
      /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(id) &&
        (mode === undefined || mode === "Internal") &&
        !result.has(id) &&
        !types.has(type),
    );
    result.set(id, {
      type,
      target: relationshipTarget(source, attr(node, "Target")),
    });
    types.add(type);
  }
  return result;
}

function contentTypes(parts, expected) {
  const root = element(
    parseXml(parts.get("[Content_Types].xml")),
    typeNs,
    "Types",
  );
  const defaults = new Map();
  const overrides = new Map();
  for (const child of structural(root)) {
    if (child.local === "Default") {
      const node = element(child, typeNs, "Default", [
        "Extension",
        "ContentType",
      ]);
      leaf(node);
      const extension = attr(node, "Extension");
      const type = attr(node, "ContentType");
      insist(!defaults.has(extension));
      insist(
        (extension === "rels" && type === relMime) ||
          (extension === "xml" && type === "application/xml"),
      );
      defaults.set(extension, type);
    } else {
      const node = element(child, typeNs, "Override", [
        "PartName",
        "ContentType",
      ]);
      leaf(node);
      const path = attr(node, "PartName");
      const type = attr(node, "ContentType");
      insist(path.startsWith("/") && !overrides.has(path.slice(1)));
      const partName = path.slice(1);
      insist(expected.has(partName) && expected.get(partName) === type);
      overrides.set(partName, type);
    }
  }
  insist(parts.size === expected.size + 1);
  for (const [name, type] of expected) {
    const extension = name.slice(name.lastIndexOf(".") + 1);
    insist(
      parts.has(name) &&
        (overrides.get(name) ?? defaults.get(extension)) === type,
    );
  }
}

function requireRelationship(entries, type, target) {
  for (const [id, relation] of entries) {
    if (relation.type === type && relation.target === target) {
      entries.delete(id);
      return;
    }
  }
  rejectXml();
}

function metadataLeaf(node, uri, name, attributes) {
  leaf(element(node, uri, name, attributes));
  insist(node.attrs.size === attributes.length);
  return node;
}

function validateIgnorable(node, namespaces) {
  const actual = node.ignorableNamespaces;
  insist(
    actual?.length === namespaces.length &&
      actual.every((namespace, index) => namespace === namespaces[index]),
  );
}

function excelWorkbookSheets(root) {
  validateIgnorable(root, [
    x15Ns,
    revisionNs,
    revision6Ns,
    revision10Ns,
    revision2Ns,
  ]);
  const children = structural(root);
  insist(children.length === 7);
  const [
    fileVersion,
    properties,
    alternate,
    revision,
    views,
    sheets,
    calculation,
  ] = children;
  const version = metadataLeaf(fileVersion, workbookNs, "fileVersion", [
    "appName",
    "lastEdited",
    "lowestEdited",
    "rupBuild",
  ]);
  insist(attr(version, "appName") === "xl");
  for (const key of ["lastEdited", "lowestEdited", "rupBuild"]) {
    nonnegativeInteger(attr(version, key), 4_294_967_295);
  }
  metadataLeaf(properties, workbookNs, "workbookPr", []);

  // Excel writes a local path hint in this exact compatibility branch. Its
  // text has no role in relationship resolution or the returned worksheet.
  const choice = onlyChild(
    element(alternate, compatibilityNs, "AlternateContent"),
    compatibilityNs,
    "Choice",
    ["Requires"],
  );
  insist(choice.requiredNamespace === x15Ns);
  const path = onlyChild(choice, x15AlternateNs, "absPath", ["url"]);
  leaf(path);
  insist(attr(path, "url").length > 0);

  metadataLeaf(revision, revisionNs, "revisionPtr", [
    "documentId",
    "revIDLastSave",
    "{" + revision10Ns + "}uidLastSave",
    "{" + revision6Ns + "}coauthVersionLast",
    "{" + revision6Ns + "}coauthVersionMax",
  ]);
  const window = onlyChild(
    element(views, workbookNs, "bookViews"),
    workbookNs,
    "workbookView",
    [
      "xWindow",
      "yWindow",
      "windowWidth",
      "windowHeight",
      "{" + revision2Ns + "}uid",
    ],
  );
  leaf(window);
  insist(window.attrs.size === 5);
  for (const key of ["xWindow", "yWindow"]) {
    insist(/^-?(?:0|[1-9][0-9]{0,8})$/u.test(attr(window, key)));
  }
  for (const key of ["windowWidth", "windowHeight"]) {
    nonnegativeInteger(attr(window, key), 4_294_967_295);
  }
  metadataLeaf(calculation, workbookNs, "calcPr", ["calcId"]);
  nonnegativeInteger(attr(calculation, "calcId"), 4_294_967_295);
  return element(sheets, workbookNs, "sheets");
}

function excelProperties(parts, requestedSheet) {
  const core = element(
    parseXml(parts.get(coreProperties), true),
    coreNs,
    "coreProperties",
  );
  const usedCoreNames = new Set();
  for (const child of structural(core)) {
    insist(!usedCoreNames.has(child.local));
    usedCoreNames.add(child.local);
    if (child.local === "created" || child.local === "modified") {
      const timestamp = element(child, dublinTermNs, child.local, [xsiType]);
      insist(
        timestamp.resolvedType?.[0] === dublinTermNs &&
          timestamp.resolvedType[1] === "W3CDTF" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(
            literalText(timestamp),
          ),
      );
    } else {
      const name = child.local;
      insist(name === "creator" || name === "lastModifiedBy");
      insist(
        literalText(
          element(child, name === "creator" ? dublinElementNs : coreNs, name),
        ).length <= 256,
      );
    }
  }
  insist(usedCoreNames.has("created") && usedCoreNames.has("modified"));

  const app = element(
    parseXml(parts.get(extendedProperties), true),
    extendedNs,
    "Properties",
  );
  const children = structural(app);
  insist(children.length === 9);
  const [
    application,
    security,
    crop,
    headings,
    titles,
    links,
    sharing,
    hyperlinks,
    version,
  ] = children;
  for (const [node, name, value] of [
    [application, "Application", "Microsoft Excel"],
    [security, "DocSecurity", "0"],
    [crop, "ScaleCrop", "false"],
    [links, "LinksUpToDate", "false"],
    [sharing, "SharedDoc", "false"],
    [hyperlinks, "HyperlinksChanged", "false"],
  ]) {
    insist(literalText(element(node, extendedNs, name)) === value);
  }
  insist(
    /^16\.[0-9]{1,5}$/u.test(
      literalText(element(version, extendedNs, "AppVersion")),
    ),
  );
  const pair = onlyChild(
    element(headings, extendedNs, "HeadingPairs"),
    valueTypeNs,
    "vector",
    ["size", "baseType"],
  );
  const variants = structural(pair);
  insist(
    attr(pair, "size") === "2" &&
      attr(pair, "baseType") === "variant" &&
      variants.length === 2,
  );
  const label = onlyChild(
    element(variants[0], valueTypeNs, "variant"),
    valueTypeNs,
    "lpstr",
  );
  const count = onlyChild(
    element(variants[1], valueTypeNs, "variant"),
    valueTypeNs,
    "i4",
  );
  insist(literalText(label) === "Worksheets" && literalText(count) === "1");
  const sheets = onlyChild(
    element(titles, extendedNs, "TitlesOfParts"),
    valueTypeNs,
    "vector",
    ["size", "baseType"],
  );
  insist(
    attr(sheets, "size") === "1" &&
      attr(sheets, "baseType") === "lpstr" &&
      literalText(onlyChild(sheets, valueTypeNs, "lpstr")) === requestedSheet,
  );
}

function workbookSheet(parts, requestedSheet, excel) {
  const root = element(
    parseXml(parts.get(workbookPart), excel),
    workbookNs,
    "workbook",
    excel ? [ignorableAttr] : [],
  );
  const sheets = excel
    ? excelWorkbookSheets(root)
    : onlyChild(root, workbookNs, "sheets");
  const relationAttr = "{" + officeRelNs + "}id";
  const sheet = onlyChild(sheets, workbookNs, "sheet", [
    "name",
    "sheetId",
    "state",
    relationAttr,
  ]);
  leaf(sheet);
  const sheetName = attr(sheet, "name");
  positiveInteger(attr(sheet, "sheetId"), 4_294_967_295);
  const state = sheet.attrs.get("state");
  insist(
    sheetName === requestedSheet &&
      sheetName.length > 0 &&
      sheetName.length <= 31 &&
      !/[\\/*?:[\]]|_x[0-9a-f]{4}_/iu.test(sheetName) &&
      (state === undefined || state === "visible"),
  );
  return attr(sheet, relationAttr);
}

function positiveInteger(text, maximum) {
  insist(/^[1-9][0-9]{0,9}$/u.test(text));
  const value = Number(text);
  insist(value <= maximum);
  return value;
}

function nonnegativeInteger(text, maximum) {
  return text === "0" ? 0 : positiveInteger(text, maximum);
}

function parseStringTable(parts) {
  const root = element(parseXml(parts.get(stringPart)), workbookNs, "sst", [
    "count",
    "uniqueCount",
  ]);
  const children = structural(root);
  insist(children.length >= 1 && children.length <= maxCells);
  const result = [];
  const seen = new Set();
  let bytes = 0;
  for (const child of children) {
    const entry = element(child, workbookNs, "si");
    const text = onlyChild(entry, workbookNs, "t", ["{" + xmlNs + "}space"]);
    const value = literalText(text);
    bytes += Buffer.byteLength(value);
    insist(bytes <= maxGridBytes && !seen.has(value));
    seen.add(value);
    result.push(value);
  }
  const unique = root.attrs.get("uniqueCount");
  const declared = root.attrs.get("count");
  insist((unique === undefined) === (declared === undefined));
  if (unique !== undefined)
    insist(positiveInteger(unique, maxCells) === result.length);
  return {
    values: result,
    totalStrings:
      declared === undefined ? undefined : positiveInteger(declared, maxCells),
  };
}

function columnName(index) {
  if (index < 26) return String.fromCharCode(65 + index);
  return String.fromCharCode(
    65 + Math.floor(index / 26) - 1,
    65 + (index % 26),
  );
}

function excelWorksheetData(sheet) {
  validateIgnorable(sheet, [
    x14AlternateNs,
    revisionNs,
    revision2Ns,
    revision3Ns,
  ]);
  insist(attr(sheet, "{" + revisionNs + "}uid").length > 0);
  const children = structural(sheet);
  insist(children.length === 5);
  const [dimension, views, format, data, margins] = children;
  metadataLeaf(dimension, workbookNs, "dimension", ["ref"]);
  const view = onlyChild(
    element(views, workbookNs, "sheetViews"),
    workbookNs,
    "sheetView",
    ["tabSelected", "workbookViewId"],
  );
  leaf(view);
  insist(
    attr(view, "tabSelected") === "1" && attr(view, "workbookViewId") === "0",
  );
  metadataLeaf(format, workbookNs, "sheetFormatPr", ["defaultRowHeight"]);
  const marginNames = ["left", "right", "top", "bottom", "header", "footer"];
  metadataLeaf(margins, workbookNs, "pageMargins", marginNames);
  for (const [node, names] of [
    [format, ["defaultRowHeight"]],
    [margins, marginNames],
  ]) {
    for (const name of names) {
      insist(
        /^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,10})?$/u.test(attr(node, name)),
      );
    }
  }
  return {
    data: element(data, workbookNs, "sheetData"),
    dimension: attr(dimension, "ref"),
  };
}

function parseSheet(parts, sheetPath, shared, excel) {
  const sheet = element(
    parseXml(parts.get(sheetPath), excel),
    workbookNs,
    "worksheet",
    excel ? [ignorableAttr, "{" + revisionNs + "}uid"] : [],
  );
  const { data, dimension } = excel
    ? excelWorksheetData(sheet)
    : { data: onlyChild(sheet, workbookNs, "sheetData") };
  const rowNodes = structural(data);
  insist(rowNodes.length > 0 && rowNodes.length <= maxRows);
  const rows = [];
  let expandedBytes = 0;
  let totalStrings = 0;
  for (const [rowIndex, rawRow] of rowNodes.entries()) {
    const row = element(
      rawRow,
      workbookNs,
      "row",
      excel ? ["r", "spans"] : ["r"],
    );
    const rowNumber = rowIndex + 1;
    insist(attr(row, "r") === String(rowNumber));
    const cells = structural(row);
    const width = rows[0]?.length ?? cells.length;
    insist(cells.length === width && width >= 1 && width <= maxColumns);
    if (excel) insist(attr(row, "spans") === "1:" + width);
    const values = [];
    for (const [columnIndex, rawCell] of cells.entries()) {
      const cell = element(rawCell, workbookNs, "c", ["r", "t"]);
      insist(attr(cell, "r") === columnName(columnIndex) + rowNumber);
      const type = attr(cell, "t");
      let value;
      if (type === "inlineStr" && !excel) {
        const inline = onlyChild(cell, workbookNs, "is");
        value = literalText(
          onlyChild(inline, workbookNs, "t", ["{" + xmlNs + "}space"]),
        );
      } else {
        insist(type === "s" && shared !== undefined);
        const index = onlyChild(cell, workbookNs, "v");
        insist(index.children.length === 0);
        value =
          shared.values[
            nonnegativeInteger(index.text, shared.values.length - 1)
          ];
        insist(value !== undefined);
      }
      totalStrings += 1;
      expandedBytes += Buffer.byteLength(value);
      insist(expandedBytes <= maxGridBytes);
      values.push(value);
    }
    rows.push(values);
  }
  if (shared?.totalStrings !== undefined)
    insist(totalStrings === shared.totalStrings);
  if (excel) {
    const lastCoordinate = columnName(rows[0].length - 1) + rows.length;
    insist(
      dimension === (lastCoordinate === "A1" ? "A1" : "A1:" + lastCoordinate),
    );
  }
  return { headers: rows[0], rows: rows.slice(1) };
}

// Offline decoder for the restricted one-sheet profile in EXEC-045. It returns
// only a string grid for the existing mapper and has no live service binding.
export async function readXlsxWorksheet(
  input,
  requestedSheet,
  profile = "portable",
) {
  try {
    insist(typeof requestedSheet === "string" && requestedSheet.length <= 31);
    const parts = await readXlsxArchive(input, profile);
    const excel = profile === "excel-text-v1";
    const root = relationships(parts, "_rels/.rels", "");
    if (excel) {
      requireRelationship(
        root,
        relNs + "/metadata/core-properties",
        coreProperties,
      );
      requireRelationship(
        root,
        officeRelNs + "/extended-properties",
        extendedProperties,
      );
    }
    insist(root.size === 1);
    const office = root.values().next().value;
    insist(
      office.type === officeRelNs + "/officeDocument" &&
        office.target === workbookPart,
    );
    const sheetId = workbookSheet(parts, requestedSheet, excel);
    const workbook = relationships(parts, workbookRelations, workbookPart);
    const sheet = workbook.get(sheetId);
    insist(
      sheet?.type === officeRelNs + "/worksheet" &&
        /^xl\/worksheets\/sheet[1-9][0-9]{0,3}\.xml$/u.test(sheet.target),
    );
    workbook.delete(sheetId);
    // Excel-text packages carry either both pinned presentation parts or none.
    const hasExcelPresentation = excel && workbook.size > 1;
    if (hasExcelPresentation) {
      requireRelationship(workbook, officeRelNs + "/styles", stylePart);
      requireRelationship(workbook, officeRelNs + "/theme", themePart);
    }
    if (excel) insist(workbook.size === 1);
    const shared = workbook.values().next().value;
    insist(
      workbook.size === 0 ||
        (workbook.size === 1 &&
          shared.type === officeRelNs + "/sharedStrings" &&
          shared.target === stringPart),
    );

    const expected = new Map([
      ["_rels/.rels", relMime],
      [workbookRelations, relMime],
      [workbookPart, mimePrefix + "sheet.main+xml"],
      [sheet.target, mimePrefix + "worksheet+xml"],
    ]);
    if (shared) expected.set(stringPart, mimePrefix + "sharedStrings+xml");
    if (excel) {
      expected.set(
        coreProperties,
        "application/vnd.openxmlformats-package.core-properties+xml",
      );
      expected.set(
        extendedProperties,
        "application/vnd.openxmlformats-officedocument.extended-properties+xml",
      );
    }
    if (hasExcelPresentation) {
      expected.set(stylePart, mimePrefix + "styles+xml");
      expected.set(
        themePart,
        "application/vnd.openxmlformats-officedocument.theme+xml",
      );
    }
    contentTypes(parts, expected);
    if (excel) excelProperties(parts, requestedSheet);
    if (hasExcelPresentation) {
      for (const [name, hash] of excelPresentationHashes) {
        insist(
          createHash("sha256").update(parts.get(name)).digest("hex") === hash,
        );
      }
    }

    return parseSheet(
      parts,
      sheet.target,
      shared ? parseStringTable(parts) : undefined,
      excel,
    );
  } catch {
    throw new Error("XLSX_WORKSHEET_REJECTED");
  }
}
