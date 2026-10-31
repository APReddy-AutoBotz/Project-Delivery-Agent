import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createRestoreDiagnostic,
  restorePhases,
} from "../packages/operations/src/restore-diagnostic.js";
import {
  restoreFailurePhase,
  restoreFailureDetails,
  restorePhases as hostPhases,
  reportRestoreFailure,
} from "../scripts/acceptance/restore-diagnostic.mjs";

it("DEP-002: restore and host use the same closed phase inventory", () => {
  expect(hostPhases).toEqual(restorePhases);
  expect(Object.isFrozen(hostPhases)).toBe(true);
  expect(Object.isFrozen(restorePhases)).toBe(true);
});
it("SEC-SECRET-001: session classes are fixed and restricted to the first session failure", () => {
  const canary = randomBytes(32).toString("hex"), output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const d = createRestoreDiagnostic();
    d.observeSessions({ count: "one", client: "yes", get nonclient() { throw new Error(canary); }, null_type: canary, extra: canary });
    d.enter("sessions_before_commit_other_sessions"); d.failed(); d.enter("connection_cleanup"); d.failed(); d.report();
    const line = output.mock.calls[0]![0] as string;
    expect(line).not.toContain(canary);
    expect(restoreFailureDetails(Buffer.from(line))).toEqual({ phase: "sessions_before_commit_other_sessions", sessions: {
      count: "one", client: "yes", nonclient: "unknown", null_type: "unknown",
    } });
    const other = createRestoreDiagnostic(); other.observeSessions({ count: "one", client: "yes" });
    other.enter("integrity"); other.failed(); other.report();
    expect(JSON.parse(output.mock.calls[1]![0] as string)).not.toHaveProperty("sessions");
    const injected = JSON.stringify({ event: "operations.restore.failed", phase: "sessions_before_commit_other_sessions", sessions: { count: canary, client: canary, nonclient: "no", null_type: "yes", extra: canary } });
    const details = restoreFailureDetails(Buffer.from(injected));
    expect(JSON.stringify(details)).not.toContain(canary);
    expect(details).toEqual({ phase: "sessions_before_commit_other_sessions", sessions: { count: "unknown", client: "unknown", nonclient: "no", null_type: "yes" } });
    expect(restoreFailureDetails(Buffer.from(injected + "\n" + injected))).toEqual({ phase: "unavailable" });
  } finally { output.mockRestore(); }
});
it("SEC-SECRET-001: both diagnostic layers constrain backend kinds to consistent finite classifications", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const common = { count: "one", client: "no", nonclient: "yes", null_type: "no" };
    for (const backend_kind of ["autovacuum_worker", "parallel_worker", "logical_replication_worker", "other_nonclient"]) {
      const d = createRestoreDiagnostic(); d.observeSessions({ ...common, backend_kind });
      d.enter("sessions_before_commit_other_sessions"); d.failed(); d.report();
      const details = restoreFailureDetails(Buffer.from(output.mock.calls.at(-1)![0] as string));
      expect(details.sessions.backend_kind).toBe(backend_kind);
    }
    for (const value of [
      { ...common, count: "multiple", backend_kind: "parallel_worker" },
      { ...common, client: "yes", backend_kind: "parallel_worker" },
      { ...common, nonclient: "unknown", backend_kind: "parallel_worker" },
      { ...common, backend_kind: "private-canary" },
      { ...common, get backend_kind() { throw new Error("private-canary"); } },
    ]) {
      const d = createRestoreDiagnostic(); d.observeSessions(value);
      d.enter("sessions_before_commit_other_sessions"); d.failed(); d.report();
      const line = output.mock.calls.at(-1)![0] as string;
      expect(line).not.toContain("private-canary");
      expect(restoreFailureDetails(Buffer.from(line)).sessions.backend_kind).toBe("unknown");
    }
    const spoof = JSON.stringify({ event: "operations.restore.failed", phase: "sessions_before_commit_other_sessions",
      sessions: { ...common, client: "yes", backend_kind: "autovacuum_worker" } });
    expect(restoreFailureDetails(Buffer.from(spoof)).sessions.backend_kind).toBe("unknown");
    const legacy = JSON.stringify({ event: "operations.restore.failed", phase: "sessions_before_commit_other_sessions", sessions: common });
    expect(restoreFailureDetails(Buffer.from(legacy)).sessions).not.toHaveProperty("backend_kind");
  } finally { output.mockRestore(); }
});
it.each(restorePhases)(
  "DEP-002 / SEC-SECRET-001: only a fixed first failing phase survives cleanup (%s)",
  (phase) => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const diagnostic = createRestoreDiagnostic();
      diagnostic.enter(phase);
      diagnostic.failed();
      diagnostic.enter("connection_cleanup");
      diagnostic.failed();
      diagnostic.enter("plaintext_cleanup");
      diagnostic.report();
      expect(output).toHaveBeenCalledTimes(1);
      expect(restoreFailurePhase(Buffer.from(output.mock.calls[0]![0]))).toBe(
        phase,
      );
    } finally {
      output.mockRestore();
    }
  },
);
it("SEC-SECRET-001: arbitrary runtime values, error objects and additional fields cannot cross the diagnostic boundary", () => {
  const canary = randomBytes(32).toString("hex");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const value of [
      canary,
      new Error(canary),
      {
        toString: () => {
          throw Error(canary);
        },
      },
    ]) {
      const diagnostic = createRestoreDiagnostic();
      diagnostic.enter(value as never);
      diagnostic.failed();
      diagnostic.report();
    }
    expect(JSON.stringify(output.mock.calls)).not.toContain(canary);
    expect(
      output.mock.calls.every(
        ([line]) => restoreFailurePhase(Buffer.from(line)) === "unknown",
      ),
    ).toBe(true);
    expect(
      restoreFailurePhase(
        Buffer.from(
          JSON.stringify({
            event: "operations.restore.failed",
            phase: "integrity",
            error: canary,
          }),
        ),
      ),
    ).toBe("integrity");
  } finally {
    output.mockRestore();
  }
});
it("SEC-SECRET-001: missing, malformed, duplicate, unknown and oversized restore diagnostics are unavailable", () => {
  const valid = JSON.stringify({
    event: "operations.restore.failed",
    phase: "grants",
  });
  for (const text of [
    "",
    "private unrelated output",
    "operations.restore.failed malformed",
    valid + "\n" + valid,
    JSON.stringify({
      event: "operations.restore.failed",
      phase: "not-allowed",
    }),
    JSON.stringify({ event: "operations.restore.failed" }),
    "x".repeat(65537),
    valid + "\n" + "operations.restore.failed malformed",
  ])
    expect(restoreFailurePhase(Buffer.from(text))).toBe("unavailable");
  expect(
    restoreFailurePhase(Buffer.from("private unrelated output\n" + valid)),
  ).toBe("grants");
});
it("SEC-SECRET-001: a missing private file and unknown profile expose only fixed unavailable categories", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    reportRestoreFailure(
      "tmp/absent-restore-" + randomBytes(16).toString("hex"),
      "unsafe-profile",
    );
    expect(output).toHaveBeenCalledExactlyOnceWith(
      "FAIL: customer unknown restore last entered phase: unavailable",
    );
  } finally {
    output.mockRestore();
  }
});
