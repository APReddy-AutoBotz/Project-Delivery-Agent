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
  "sessions_before_commit_other_sessions",
  "sessions_before_commit_query_failed",
  "sessions_before_commit_invalid_result",
  "commit",
  "quarantine_verification",
  "connection_cleanup",
  "plaintext_cleanup",
] as const);
type RestorePhase = (typeof restorePhases)[number];
type SafeSessions = { count: "one" | "multiple" | "unknown"; client: "yes" | "no" | "unknown"; nonclient: "yes" | "no" | "unknown"; null_type: "yes" | "no" | "unknown" };
function safeSessions(value: unknown): SafeSessions {
  const read = (key: keyof SafeSessions, allowed: readonly string[]) => {
    try {
      const candidate = (value as Record<string, unknown> | null)?.[key];
      return typeof candidate === "string" && allowed.includes(candidate) ? candidate : "unknown";
    } catch { return "unknown"; }
  };
  return {
    count: read("count", ["one", "multiple"]) as SafeSessions["count"],
    client: read("client", ["yes", "no"]) as SafeSessions["client"],
    nonclient: read("nonclient", ["yes", "no"]) as SafeSessions["nonclient"],
    null_type: read("null_type", ["yes", "no"]) as SafeSessions["null_type"],
  };
}
export function createRestoreDiagnostic() {
  let phase: RestorePhase | "unknown" = "preflight";
  let firstFailure: RestorePhase | "unknown" | undefined;
  let sessions: SafeSessions | undefined;
  return {
    observeSessions(value: unknown) { sessions = safeSessions(value); },
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
          ...(firstFailure === "sessions_before_commit_other_sessions" && sessions ? { sessions } : {}),
        }),
      );
    },
  };
}
