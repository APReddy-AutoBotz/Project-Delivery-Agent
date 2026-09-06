import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  appendFileSync,
  linkSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { readSecretFile } from "@pdaa/platform";

const magic = Buffer.from("PDAABK01");
export type BackupMetadata = {
  format: "pdaa-backup-v1";
  customerId: string;
  source: { host: string; port: number; database: string };
  postgresVersion: number;
  createdAt: string;
  migrations: { name: string; checksum: string }[];
  graphileVersion: number;
};
export function backupKey(file: string) {
  const value = readSecretFile(file, "PDAA_BACKUP_KEY_FILE");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new Error("Invalid backup key");
  return Buffer.from(value, "base64");
}
export function archivePath(directory: string, name: string) {
  if (
    !isAbsolute(directory) ||
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink() ||
    !/^backup-[a-zA-Z0-9-]+\.pdaa$/.test(name)
  )
    throw new Error("Invalid backup location");
  return join(realpathSync(directory), name);
}
export async function sealArchive(
  source: Readable,
  destination: string,
  key: Buffer,
  metadata: BackupMetadata,
  producer = Promise.resolve(),
) {
  const data = Buffer.from(JSON.stringify(metadata));
  if (data.length > 8192) throw new Error("Backup metadata limit exceeded");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const nonce = randomBytes(12);
  const header = Buffer.concat([magic, size, data, nonce]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const temporary = destination + ".partial";
  const fd = openSync(temporary, "wx", 0o600);
  const output = createWriteStream(temporary, { fd, autoClose: true });
  try {
    output.write(header);
    const outcomes = await Promise.allSettled([
      pipeline(source, cipher, output),
      producer,
    ]);
    if (outcomes.some((result) => result.status === "rejected"))
      throw new Error("Backup producer or encryption failed");
    appendFileSync(temporary, cipher.getAuthTag());
    // Atomic publication without replacing another backup, even on a name collision.
    linkSync(temporary, destination);
  } finally {
    if (!output.closed) output.destroy();
    try {
      unlinkSync(temporary);
    } catch {
      /* No partial artifact is reported as success. */
    }
  }
}
export async function openArchive(
  source: string,
  destination: string,
  key: Buffer,
): Promise<BackupMetadata> {
  if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink())
    throw new Error("Backup must be a regular file");
  const file = openSync(source, "r");
  let header: Buffer;
  let tag: Buffer;
  let metadata: BackupMetadata;
  const length = statSync(source).size;
  try {
    const prefix = Buffer.alloc(12);
    if (
      readSync(file, prefix, 0, 12, 0) !== 12 ||
      !prefix.subarray(0, 8).equals(magic)
    )
      throw new Error("Invalid backup header");
    const size = prefix.readUInt32BE(8);
    if (size > 8192 || size < 2 || length <= 12 + size + 12 + 16)
      throw new Error("Invalid backup length");
    header = Buffer.alloc(12 + size + 12);
    if (readSync(file, header, 0, header.length, 0) !== header.length)
      throw new Error("Incomplete backup");
    tag = Buffer.alloc(16);
    if (readSync(file, tag, 0, 16, length - 16) !== 16)
      throw new Error("Incomplete backup tag");
    metadata = JSON.parse(header.subarray(12, 12 + size).toString("utf8"));
  } finally {
    closeSync(file);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(-12));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  let created = false;
  output.once("open", () => {
    created = true;
  });
  try {
    await pipeline(
      createReadStream(source, { start: header.length, end: length - 17 }),
      decipher,
      output,
    );
    if (
      metadata?.format !== "pdaa-backup-v1" ||
      !Array.isArray(metadata.migrations) ||
      !metadata.source ||
      !Number.isInteger(metadata.postgresVersion) ||
      !Number.isInteger(metadata.graphileVersion)
    )
      throw new Error("Invalid backup metadata");
    return metadata;
  } catch {
    if (created) {
      try {
        unlinkSync(destination);
      } catch {
        /* Protected tmpfs is removed by the caller. */
      }
    }
    throw new Error("Backup authentication or format validation failed");
  }
}
export function requireRestoreTmpfs() {
  if (
    process.platform !== "linux" ||
    !readFileSync("/proc/mounts", "utf8")
      .split("\n")
      .some((line) => {
        const fields = line.split(" ");
        return fields[1] === "/tmp" && fields[2] === "tmpfs";
      })
  )
    throw new Error("Restore requires a private /tmp tmpfs mount");
}
