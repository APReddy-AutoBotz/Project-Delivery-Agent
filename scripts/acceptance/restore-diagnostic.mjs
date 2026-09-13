// DEP-002 / NFR-SEC-005: relay categories only, never child output or error data.
import { openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
export const restorePhases = Object.freeze([
  "preflight",
  "archive_authentication",
  "archive_identity",
  "target_connection",
  "target_validation",
  "quarantine",
  "sessions_before_restore",
  "postgres_restore",
  "sessions_after_restore",
  "ownership",
  "grants",
  "customer",
  "history",
  "integrity",
  "sessions_before_commit",
  "commit",
  "quarantine_verification",
  "connection_cleanup",
  "plaintext_cleanup",
]);
const maximum = 65536;
export function restoreFailurePhase(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximum) return "unavailable";
  const found = [];
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line.includes("operations.restore.failed")) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return "unavailable";
    }
    if (
      !value ||
      value.event !== "operations.restore.failed" ||
      ![...restorePhases, "unknown"].includes(value.phase)
    )
      return "unavailable";
    found.push(value.phase);
  }
  return found.length === 1 ? found[0] : "unavailable";
}
export function reportRestoreFailure(file, profile) {
  let phase = "unavailable";
  try {
    if (!lstatSync(file).isFile())
      throw new Error("Unavailable restore diagnostic");
    const fd = openSync(file, "r");
    try {
      const stat = fstatSync(fd);
      const size = stat.size;
      if (stat.isFile() && size <= maximum) {
        // One extra byte also rejects a file that grew after fstat.
        const bytes = Buffer.alloc(maximum + 1);
        const length = readSync(fd, bytes, 0, bytes.length, 0);
        if (length === size)
          phase = restoreFailurePhase(bytes.subarray(0, length));
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    /* Missing diagnostics never hide the restore command failure. */
  }
  const safeProfile = ["bundled", "external"].includes(profile)
    ? profile
    : "unknown";
  console.log(
    `FAIL: customer ${safeProfile} restore last entered phase: ${phase}`,
  );
}
