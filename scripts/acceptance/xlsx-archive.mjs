import { types } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import yauzl from "yauzl";

const maxArchiveBytes = 1_048_576;
const maxPartBytes = 4_194_304;
const maxExpandedBytes = 8_388_608;
const maxParts = 64;
const maxPartNameBytes = 160;

const endRecordBytes = 22;
const centralHeaderBytes = 46;
const localHeaderBytes = 30;
const descriptorBytes = 16;
const descriptorFlag = 0x0008;
const utf8Flag = 0x0800;
const deflateOptionFlags = 0x0006;
const stored = 0;
const deflated = 8;

function requireArchive(condition) {
  if (!condition) throw new Error("XLSX_ARCHIVE_REJECTED");
}

function readEndRecord(bytes) {
  const end = bytes.length - endRecordBytes;
  requireArchive(
    bytes.readUInt32LE(end) === 0x06054b50 &&
      bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0 &&
      bytes.readUInt16LE(end + 20) === 0,
  );
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  requireArchive(
    count > 0 &&
      count <= maxParts &&
      bytes.readUInt16LE(end + 8) === count &&
      directoryStart >= localHeaderBytes &&
      directorySize >= count * centralHeaderBytes &&
      directoryStart + directorySize === end,
  );
  return { count, directoryStart, end };
}

function partName(rawName) {
  requireArchive(
    rawName.length > 0 &&
      rawName.length <= maxPartNameBytes &&
      rawName.every((byte) => byte >= 0x21 && byte <= 0x7e),
  );
  const name = rawName.toString("ascii");
  if (name === "[Content_Types].xml" || name === "_rels/.rels") return name;
  requireArchive(
    /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:xml|rels)$/u.test(
      name,
    ) && name.split("/").every((segment) => !segment.endsWith(".")),
  );
  return name;
}

function checkCentralEntry(bytes, cursor, end, entry) {
  requireArchive(cursor + centralHeaderBytes <= end);
  const rawName = entry.fileNameRaw;
  const next = cursor + centralHeaderBytes + rawName.length;
  requireArchive(
    next <= end &&
      bytes.readUInt32LE(cursor) === 0x02014b50 &&
      bytes.readUInt16LE(cursor + 28) === rawName.length &&
      bytes.readUInt16LE(cursor + 30) === 0 &&
      bytes.readUInt16LE(cursor + 32) === 0 &&
      bytes.readUInt16LE(cursor + 34) === 0 &&
      bytes.subarray(cursor + centralHeaderBytes, next).equals(rawName),
  );
  const method = entry.compressionMethod;
  const allowedFlags =
    descriptorFlag | utf8Flag | (method === deflated ? deflateOptionFlags : 0);
  const attributes = entry.externalFileAttributes;
  const unixKind = (attributes >>> 16) & 0xf000;
  requireArchive(
    (method === stored || method === deflated) &&
      (entry.generalPurposeBitFlag & ~allowedFlags) === 0 &&
      (entry.versionNeededToExtract === 20 ||
        (method === stored && entry.versionNeededToExtract === 10)) &&
      (unixKind === 0 || unixKind === 0x8000) &&
      (attributes & 0x18) === 0 &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize > 0 &&
      entry.uncompressedSize <= maxPartBytes &&
      (method !== stored || entry.compressedSize === entry.uncompressedSize),
  );
  return next;
}

async function readPartExtent(bytes, zip, entry, directoryStart) {
  const start = entry.relativeOffsetOfLocalHeader;
  requireArchive(start + localHeaderBytes <= directoryStart);
  const local = await zip.readLocalFileHeaderPromise(entry);
  const usesDescriptor = (entry.generalPurposeBitFlag & descriptorFlag) !== 0;
  requireArchive(
    local.fileDataStart ===
      start + localHeaderBytes + entry.fileNameRaw.length &&
      local.fileName.equals(entry.fileNameRaw) &&
      local.extraFieldLength === 0 &&
      local.compressionMethod === entry.compressionMethod &&
      local.versionNeededToExtract === entry.versionNeededToExtract &&
      local.generalPurposeBitFlag === entry.generalPurposeBitFlag &&
      local.lastModFileTime === entry.lastModFileTime &&
      local.lastModFileDate === entry.lastModFileDate &&
      local.crc32 === (usesDescriptor ? 0 : entry.crc32) &&
      local.compressedSize === (usesDescriptor ? 0 : entry.compressedSize) &&
      local.uncompressedSize === (usesDescriptor ? 0 : entry.uncompressedSize),
  );
  const dataEnd = local.fileDataStart + entry.compressedSize;
  const end = dataEnd + (usesDescriptor ? descriptorBytes : 0);
  requireArchive(end <= directoryStart);
  if (usesDescriptor) {
    requireArchive(
      bytes.readUInt32LE(dataEnd) === 0x08074b50 &&
        bytes.readUInt32LE(dataEnd + 4) === entry.crc32 &&
        bytes.readUInt32LE(dataEnd + 8) === entry.compressedSize &&
        bytes.readUInt32LE(dataEnd + 12) === entry.uncompressedSize,
    );
  }
  return { start, dataStart: local.fileDataStart, dataEnd, end };
}

function decodePart(bytes, record) {
  const { entry, extent } = record;
  const compressed = bytes.subarray(extent.dataStart, extent.dataEnd);
  const result =
    entry.compressionMethod === stored
      ? Buffer.from(compressed)
      : inflatePart(compressed, entry.uncompressedSize);
  requireArchive(
    result.length === entry.uncompressedSize && crc32(result) === entry.crc32,
  );
  return result;
}

function inflatePart(compressed, uncompressedSize) {
  const result = inflateRawSync(compressed, {
    info: true,
    maxOutputLength: uncompressedSize,
  });
  requireArchive(result.engine.bytesWritten === compressed.length);
  return result.buffer;
}

// Offline archive admission for FR-CON-006/007. Callers supply an owned Buffer
// in a trusted process. This does not inspect XML or authorize an import.
export async function readXlsxArchive(input) {
  try {
    requireArchive(
      Buffer.isBuffer(input) &&
        !types.isSharedArrayBuffer(input.buffer) &&
        input.length >= endRecordBytes &&
        input.length <= maxArchiveBytes,
    );
    const bytes = Buffer.from(input);
    const directory = readEndRecord(bytes);
    const zip = await yauzl.fromBufferPromise(bytes, {
      decodeStrings: false,
      validateEntrySizes: true,
    });
    try {
      requireArchive(zip.entryCount === directory.count);
      const records = new Map();
      const names = new Set();
      let cursor = directory.directoryStart;
      let expandedBytes = 0;
      for await (const entry of zip.eachEntry()) {
        cursor = checkCentralEntry(bytes, cursor, directory.end, entry);
        const name = partName(entry.fileNameRaw);
        const key = name.toLowerCase();
        requireArchive(!names.has(key));
        names.add(key);
        expandedBytes += entry.uncompressedSize;
        requireArchive(expandedBytes <= maxExpandedBytes);
        const extent = await readPartExtent(
          bytes,
          zip,
          entry,
          directory.directoryStart,
        );
        records.set(name, { entry, extent });
      }
      requireArchive(
        records.size === directory.count && cursor === directory.end,
      );
      requireArchive(
        records.has("[Content_Types].xml") &&
          records.has("_rels/.rels") &&
          records.has("xl/workbook.xml"),
      );
      for (const name of names) {
        const segments = name.split("/");
        segments.pop();
        while (segments.length > 0) {
          requireArchive(!names.has(segments.join("/")));
          segments.pop();
        }
      }
      const extents = [...records.values()].map(({ extent }) => extent);
      extents.sort((left, right) => left.start - right.start);
      let end = 0;
      for (const extent of extents) {
        requireArchive(extent.start === end);
        end = extent.end;
      }
      requireArchive(end === directory.directoryStart);
      const parts = new Map();
      for (const [name, record] of records) {
        parts.set(name, decodePart(bytes, record));
      }
      return parts;
    } finally {
      zip.close();
    }
  } catch {
    throw new Error("XLSX_ARCHIVE_REJECTED");
  }
}
