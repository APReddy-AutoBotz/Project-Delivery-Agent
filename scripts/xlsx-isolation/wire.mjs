// Synthetic packaged fixture protocol. It carries no application identities.
import { TextDecoder } from "node:util";

const requestKind = 1;
const resultKind = 2;
const rejectedKind = 3;
const version = 1;
const profiles = ["portable", "excel-text-v1"];
const commonBytes = 22;
const successBytes = 25;
const workbookBytes = 1_048_576;
const maxRows = 1_001;
const maxColumns = 64;
const maxCellUnits = 4_096;
const maxCellBytes = maxCellUnits * 3;
const maxSheetUnits = 31;
const maxSheetBytes = maxSheetUnits * 3;
const gridBytes = 1_048_576;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const requestLimit = successBytes + maxSheetBytes + workbookBytes;
export const responseLimit =
  successBytes + maxRows * maxColumns * 2 + gridBytes;

function requireWire(condition) {
  if (!condition) throw new Error("XLSX_WIRE_REJECTED");
}

function header(kind, job, size) {
  requireWire(Buffer.isBuffer(job) && job.length === 16);
  const frame = Buffer.alloc(size);
  frame.writeUInt32BE(size - 4, 0);
  frame[4] = version;
  frame[5] = kind;
  job.copy(frame, 6);
  return frame;
}

function inspect(frame, maximum) {
  requireWire(
    Buffer.isBuffer(frame) &&
      frame.length >= commonBytes &&
      frame.length <= maximum,
  );
  requireWire(
    frame.readUInt32BE(0) === frame.length - 4 && frame[4] === version,
  );
  return { kind: frame[5], job: frame.subarray(6, commonBytes) };
}

function checkText(value, maxUnits) {
  requireWire(typeof value === "string" && value.length <= maxUnits);
  requireWire(!/[\0\p{Surrogate}]/u.test(value));
  return value;
}

function decodeText(bytes, maxUnits) {
  try {
    return checkText(utf8.decode(bytes), maxUnits);
  } catch {
    throw new Error("XLSX_WIRE_REJECTED");
  }
}

export async function readOneFrame(stream, maximum) {
  const prefix = Buffer.alloc(4);
  let read = 0;
  let frame;
  let chunks = 0;
  for await (const chunk of stream) {
    requireWire(Buffer.isBuffer(chunk) && ++chunks <= 65_536);
    let offset = 0;
    if (!frame) {
      offset = Math.min(4 - read, chunk.length);
      chunk.copy(prefix, read, 0, offset);
      read += offset;
      if (read < 4) continue;
      const size = prefix.readUInt32BE(0) + 4;
      requireWire(size >= commonBytes && size <= maximum);
      frame = Buffer.alloc(size);
      prefix.copy(frame);
    }
    const remaining = chunk.length - offset;
    requireWire(read + remaining <= frame.length);
    chunk.copy(frame, read, offset);
    read += remaining;
  }
  requireWire(frame && read === frame.length);
  return frame;
}

export function encodeRequest(job, sheet, workbook, profile) {
  const profileIndex = profiles.indexOf(profile);
  requireWire(profileIndex >= 0);
  const sheetData = Buffer.from(checkText(sheet, maxSheetUnits), "utf8");
  requireWire(
    sheetData.length > 0 &&
      Buffer.isBuffer(workbook) &&
      workbook.length > 0 &&
      workbook.length <= workbookBytes,
  );
  const frame = header(
    requestKind,
    job,
    successBytes + sheetData.length + workbook.length,
  );
  frame[22] = profileIndex + 1;
  frame.writeUInt16BE(sheetData.length, 23);
  sheetData.copy(frame, successBytes);
  workbook.copy(frame, successBytes + sheetData.length);
  return frame;
}

export function decodeRequest(frame) {
  const { kind, job } = inspect(frame, requestLimit);
  requireWire(kind === requestKind && frame.length > successBytes);
  const profile = profiles[frame[22] - 1];
  requireWire(profile !== undefined);
  const sheetLength = frame.readUInt16BE(23);
  const workbookLength = frame.length - successBytes - sheetLength;
  requireWire(
    sheetLength > 0 &&
      sheetLength <= maxSheetBytes &&
      workbookLength > 0 &&
      workbookLength <= workbookBytes,
  );
  const sheet = decodeText(
    frame.subarray(successBytes, successBytes + sheetLength),
    maxSheetUnits,
  );
  return {
    job,
    sheet,
    workbook: frame.subarray(successBytes + sheetLength),
    profile,
  };
}

export function encodeRejected(job) {
  return header(rejectedKind, job, commonBytes);
}

export function encodeResult(job, { headers, rows }) {
  const grid = [headers, ...rows];
  const width = headers.length;
  requireWire(
    grid.length >= 1 &&
      grid.length <= maxRows &&
      width >= 1 &&
      width <= maxColumns,
  );
  const cells = [];
  let bytes = 0;
  for (const row of grid) {
    requireWire(Array.isArray(row) && row.length === width);
    for (const value of row) {
      const text = checkText(value, maxCellUnits);
      const size = Buffer.byteLength(text, "utf8");
      bytes += size;
      requireWire(bytes <= gridBytes);
      cells.push({ text, size });
    }
  }
  const frame = header(
    resultKind,
    job,
    successBytes + cells.length * 2 + bytes,
  );
  frame.writeUInt16BE(grid.length, 22);
  frame[24] = width;
  let offset = successBytes;
  for (const { text, size } of cells) {
    frame.writeUInt16BE(size, offset);
    offset += 2;
    requireWire(frame.write(text, offset, size, "utf8") === size);
    offset += size;
  }
  return frame;
}

export function decodeResult(frame, expectedJob) {
  const { kind, job } = inspect(frame, responseLimit);
  requireWire(Buffer.isBuffer(expectedJob) && job.equals(expectedJob));
  if (kind === rejectedKind) {
    requireWire(frame.length === commonBytes);
    return null;
  }
  requireWire(kind === resultKind && frame.length >= successBytes);
  const height = frame.readUInt16BE(22);
  const width = frame[24];
  requireWire(
    height >= 1 && height <= maxRows && width >= 1 && width <= maxColumns,
  );
  let offset = successBytes;
  let bytes = 0;
  const grid = [];
  for (let row = 0; row < height; row++) {
    const cells = [];
    for (let column = 0; column < width; column++) {
      requireWire(offset + 2 <= frame.length);
      const size = frame.readUInt16BE(offset);
      offset += 2;
      bytes += size;
      requireWire(
        size <= maxCellBytes &&
          bytes <= gridBytes &&
          offset + size <= frame.length,
      );
      cells.push(
        decodeText(frame.subarray(offset, offset + size), maxCellUnits),
      );
      offset += size;
    }
    grid.push(cells);
  }
  requireWire(offset === frame.length);
  return { headers: grid[0], rows: grid.slice(1) };
}
