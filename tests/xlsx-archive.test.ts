import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readXlsxArchive } from "../scripts/acceptance/xlsx-archive.mjs";

const fixture = readFileSync(
  new URL("./fixtures/xlsx-archive-portfolio.xlsx", import.meta.url),
);
const names = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"];
const stablePartHashes = new Map([
  [
    "xl/workbook.xml",
    "0ed99110fa20ecd70565f197a746bd20bd3de41a74e8338f2f17ebea1e9bbcf2",
  ],
  [
    "xl/styles.xml",
    "9711629af3c521aa84019962ac1289a4744f61c422f46bff0ee6cb6789b3ca1f",
  ],
  [
    "xl/theme/theme1.xml",
    "9e968b92413c2476890e4b0bd8d26b65f2062b211bde8ebb628ffdaafc6607b9",
  ],
  [
    "xl/sharedStrings.xml",
    "188ef751ff00440752511a2b19781b8f4c4f53a52560765fc3c0cbef1fb25e4f",
  ],
  [
    "xl/worksheets/sheet1.xml",
    "afada5a90114061a8c54cd99e9bbbbf163726d8b6414ca0ec00d9a4b70d50300",
  ],
  [
    "_rels/.rels",
    "4af549dce105d8f90fef0ed60e8c9044e52977ca8e7eff658cf069d49c234f95",
  ],
  [
    "xl/_rels/workbook.xml.rels",
    "bbdee9963b6b900e2654723f4007933d5a7517b79ee76f4793695af23f1aed5a",
  ],
  [
    "[Content_Types].xml",
    "3075df9f387d734283477155c9d4b0d9512b92c7e13b8e93ee95d72f235e5326",
  ],
]);

type Part = {
  name: string;
  content: Buffer;
  compressedSuffix?: Buffer;
  inflatedLength?: number;
  recordPadding?: Buffer;
  extractVersion?: number;
};
const minimal = (): Part[] =>
  names.map((name) => ({ name, content: Buffer.from("<part/>") }));

function writeTestArchive(
  parts: Part[],
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
    const record = [local, name, data];
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

describe("FR-CON-006/007 offline XLSX archive admission", () => {
  it("returns the original bytes of every part in a real synthetic workbook", async () => {
    const parts = await readXlsxArchive(fixture);
    const actual = new Map(
      [...parts].map(([name, bytes]) => [
        name,
        createHash("sha256").update(bytes).digest("hex"),
      ]),
    );
    expect(actual).toEqual(stablePartHashes);
  });

  it.each([
    { deflate: false, descriptor: false },
    { deflate: false, descriptor: true },
    { deflate: true, descriptor: false },
    { deflate: true, descriptor: true },
  ])("validates supported ZIP record combinations %j", async (options) => {
    const parts = minimal();
    const archive = writeTestArchive(parts, options);
    const read = readXlsxArchive(archive);
    archive.fill(0);
    expect(await read).toEqual(
      new Map(parts.map(({ name, content }) => [name, content])),
    );
  });

  it("rejects damaged payloads, invalid directory bytes and incomplete archives uniformly", async () => {
    const corruptPayload = writeTestArchive(minimal());
    const firstDataByte = 30 + Buffer.byteLength(names[0]!);
    corruptPayload[firstDataByte] = 0;
    const corruptLocalName = writeTestArchive(minimal());
    corruptLocalName[30] = "X".charCodeAt(0);
    const corruptDescriptor = writeTestArchive(minimal(), { descriptor: true });
    corruptDescriptor[firstDataByte + minimal()[0]!.content.length] = 0;
    const corruptEntryCount = writeTestArchive(minimal());
    corruptEntryCount.writeUInt16LE(1, corruptEntryCount.length - 22 + 10);
    for (const archive of [
      corruptPayload,
      corruptLocalName,
      corruptDescriptor,
      corruptEntryCount,
      fixture.subarray(0, fixture.length - 1),
      Buffer.concat([fixture, Buffer.of(0)]),
    ]) {
      await expect(readXlsxArchive(archive)).rejects.toThrow(
        /^XLSX_ARCHIVE_REJECTED$/u,
      );
    }
  });

  it("rejects duplicate package names, unsupported members and missing markers", async () => {
    for (const parts of [
      [...minimal(), { name: "XL/Workbook.xml", content: Buffer.of(65) }],
      [...minimal(), { name: "xl/vbaProject.bin", content: Buffer.of(65) }],
      [
        ...minimal(),
        { name: "xl/workbook.xml/part.xml", content: Buffer.of(65) },
      ],
      minimal().slice(0, 2),
    ]) {
      await expect(readXlsxArchive(writeTestArchive(parts))).rejects.toThrow(
        /^XLSX_ARCHIVE_REJECTED$/u,
      );
    }
  });

  it.each([
    { compressedSuffix: Buffer.of(0) },
    { inflatedLength: 6 },
    { inflatedLength: 8 },
    { recordPadding: Buffer.of(0) },
    { extractVersion: 10 },
  ])(
    "rejects a part when compressed bytes, length, layout or version disagree %j",
    async (change) => {
      const parts = minimal();
      parts[0] = { ...parts[0]!, ...change };
      const archive = writeTestArchive(parts, { deflate: true });
      await expect(readXlsxArchive(archive)).rejects.toThrow(
        /^XLSX_ARCHIVE_REJECTED$/u,
      );
    },
  );

  it("does not accept a workbook backed by shared memory", async () => {
    const shared = Buffer.from(new SharedArrayBuffer(fixture.length));
    fixture.copy(shared);
    await expect(readXlsxArchive(shared)).rejects.toThrow(
      /^XLSX_ARCHIVE_REJECTED$/u,
    );
  });

  it("accepts the exact part/count/expanded bounds and rejects one byte or part above", async () => {
    const partLimit = 4_194_304;
    const parts = minimal();
    parts[0]!.content = Buffer.alloc(partLimit, 65);
    parts[1]!.content = Buffer.alloc(partLimit - parts[2]!.content.length, 66);
    const options = { deflate: true };
    const exact = await readXlsxArchive(writeTestArchive(parts, options));
    expect(exact.get(names[0]!)?.length).toBe(partLimit);
    expect(exact.get(names[1]!)?.length).toBe(
      partLimit - parts[2]!.content.length,
    );

    parts[1]!.content = Buffer.alloc(parts[1]!.content.length + 1, 66);
    await expect(
      readXlsxArchive(writeTestArchive(parts, options)),
    ).rejects.toThrow(/^XLSX_ARCHIVE_REJECTED$/u);
    const individuallyTooLarge = minimal();
    individuallyTooLarge[0]!.content = Buffer.alloc(partLimit + 1, 65);
    await expect(
      readXlsxArchive(writeTestArchive(individuallyTooLarge, options)),
    ).rejects.toThrow(/^XLSX_ARCHIVE_REJECTED$/u);

    const manyParts = minimal();
    for (let i = manyParts.length; i < 64; i += 1) {
      manyParts.push({
        name: "xl/worksheets/sheet" + i + ".xml",
        content: Buffer.of(65),
      });
    }
    expect((await readXlsxArchive(writeTestArchive(manyParts))).size).toBe(64);
    manyParts.push({
      name: "xl/worksheets/another.xml",
      content: Buffer.of(65),
    });
    await expect(readXlsxArchive(writeTestArchive(manyParts))).rejects.toThrow(
      /^XLSX_ARCHIVE_REJECTED$/u,
    );
  });

  it("enforces the input size before copying or opening the archive", async () => {
    const limit = 1_048_576;
    const parts = minimal();
    const initialBytes = writeTestArchive(parts).length;
    parts[0]!.content = Buffer.alloc(
      parts[0]!.content.length + limit - initialBytes,
      65,
    );
    const exact = writeTestArchive(parts);
    expect(exact.length).toBe(limit);
    await expect(readXlsxArchive(exact)).resolves.toEqual(
      new Map(parts.map(({ name, content }) => [name, content])),
    );
    await expect(
      readXlsxArchive(Buffer.concat([exact, Buffer.of(0)])),
    ).rejects.toThrow(/^XLSX_ARCHIVE_REJECTED$/u);
  });
});
