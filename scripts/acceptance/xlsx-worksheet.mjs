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

const maxRows = 1001;
const maxColumns = 64;
const maxCells = maxRows * maxColumns;
const maxCellLength = 4096;
const maxGridBytes = 1_048_576;
const maxXmlElements = 1 + 1 + maxRows + maxCells * 3;
const qualifiedName =
  /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/u;

function insist(condition) {
  if (!condition) throw new Error("XLSX_WORKSHEET_REJECTED");
}

function rejectXml() {
  insist(false);
}

function parseXml(bytes) {
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
      attributeCount <= 8 &&
        name.length <= 64 &&
        qualifiedName.test(name) &&
        value.length <= 256,
    );
    if (name === "xmlns" || name.startsWith("xmlns:")) {
      insist([workbookNs, relNs, officeRelNs, typeNs, xmlNs].includes(value));
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

function workbookSheet(parts, requestedSheet) {
  const root = element(
    parseXml(parts.get(workbookPart)),
    workbookNs,
    "workbook",
  );
  const sheets = onlyChild(root, workbookNs, "sheets");
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

function parseSheet(parts, sheetPath, shared) {
  const sheet = element(
    parseXml(parts.get(sheetPath)),
    workbookNs,
    "worksheet",
  );
  const data = onlyChild(sheet, workbookNs, "sheetData");
  const rowNodes = structural(data);
  insist(rowNodes.length > 0 && rowNodes.length <= maxRows);
  const rows = [];
  let expandedBytes = 0;
  let totalStrings = 0;
  for (const [rowIndex, rawRow] of rowNodes.entries()) {
    const row = element(rawRow, workbookNs, "row", ["r"]);
    const rowNumber = rowIndex + 1;
    insist(attr(row, "r") === String(rowNumber));
    const cells = structural(row);
    const width = rows[0]?.length ?? cells.length;
    insist(cells.length === width && width >= 1 && width <= maxColumns);
    const values = [];
    for (const [columnIndex, rawCell] of cells.entries()) {
      const cell = element(rawCell, workbookNs, "c", ["r", "t"]);
      insist(attr(cell, "r") === columnName(columnIndex) + rowNumber);
      const type = attr(cell, "t");
      let value;
      if (type === "inlineStr") {
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
  return { headers: rows[0], rows: rows.slice(1) };
}

// Offline decoder for the restricted one-sheet profile in EXEC-045. It returns
// only a string grid for the existing mapper and has no live service binding.
export async function readXlsxWorksheet(input, requestedSheet) {
  try {
    insist(typeof requestedSheet === "string" && requestedSheet.length <= 31);
    const parts = await readXlsxArchive(input);
    const root = relationships(parts, "_rels/.rels", "");
    insist(root.size === 1);
    const office = root.values().next().value;
    insist(
      office.type === officeRelNs + "/officeDocument" &&
        office.target === workbookPart,
    );
    const sheetId = workbookSheet(parts, requestedSheet);
    const workbook = relationships(parts, workbookRelations, workbookPart);
    const sheet = workbook.get(sheetId);
    insist(
      sheet?.type === officeRelNs + "/worksheet" &&
        /^xl\/worksheets\/sheet[1-9][0-9]{0,3}\.xml$/u.test(sheet.target),
    );
    workbook.delete(sheetId);
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
    contentTypes(parts, expected);

    return parseSheet(
      parts,
      sheet.target,
      shared ? parseStringTable(parts) : undefined,
    );
  } catch {
    throw new Error("XLSX_WORKSHEET_REJECTED");
  }
}
