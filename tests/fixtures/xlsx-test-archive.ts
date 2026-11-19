import { crc32, deflateRawSync } from "node:zlib";

export type ArchivePart = {
  name: string;
  content: Buffer;
  compressedSuffix?: Buffer;
  inflatedLength?: number;
  localExtra?: Buffer;
  recordPadding?: Buffer;
  extractVersion?: number;
};

export function writeTestArchive(
  parts: ArchivePart[],
  {
    deflate = false,
    descriptor = false,
  }: { deflate?: boolean; descriptor?: boolean } = {},
): Buffer {
  const localRecords: Buffer[] = [];
  const directoryRecords: Buffer[] = [];
  let position = 0;
  const flags = descriptor ? 8 : 0;
  const method = deflate ? 8 : 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const encoded = deflate ? deflateRawSync(part.content) : part.content;
    const data = part.compressedSuffix
      ? Buffer.concat([encoded, part.compressedSuffix])
      : encoded;
    const inflatedLength = part.inflatedLength ?? part.content.length;
    const extractVersion = part.extractVersion ?? 20;
    const checksum = crc32(part.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(extractVersion, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(part.localExtra?.length ?? 0, 28);
    if (!descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(inflatedLength, 22);
    }
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(extractVersion, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(inflatedLength, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(position, 42);
    const record = [local, name];
    if (part.localExtra) record.push(part.localExtra);
    record.push(data);
    if (descriptor) {
      const trailer = Buffer.alloc(16);
      trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(checksum, 4);
      trailer.writeUInt32LE(data.length, 8);
      trailer.writeUInt32LE(inflatedLength, 12);
      record.push(trailer);
    }
    if (part.recordPadding) record.push(part.recordPadding);
    localRecords.push(...record);
    directoryRecords.push(directory, name);
    position += record.reduce((bytes, chunk) => bytes + chunk.length, 0);
  }
  const directory = Buffer.concat(directoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...localRecords, directory, end]);
}
