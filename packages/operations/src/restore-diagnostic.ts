// DEP-002 / NFR-SEC-005: only fixed restore phases may cross the private-log boundary.
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
] as const);
type RestorePhase = (typeof restorePhases)[number];
export function createRestoreDiagnostic() {
  let phase: RestorePhase | "unknown" = "preflight";
  let firstFailure: RestorePhase | "unknown" | undefined;
  return {
    enter(value: RestorePhase) {
      phase =
        typeof value === "string" &&
        (restorePhases as readonly string[]).includes(value)
          ? value
          : "unknown";
    },
    failed() {
      firstFailure ??= phase;
    },
    report() {
      console.log(
        JSON.stringify({
          event: "operations.restore.failed",
          phase: firstFailure ?? "unknown",
        }),
      );
    },
  };
}
