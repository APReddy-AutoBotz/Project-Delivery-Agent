import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createRestoreDiagnostic,
  restorePhases,
} from "../packages/operations/src/restore-diagnostic.js";
import {
  restoreFailurePhase,
  restorePhases as hostPhases,
  reportRestoreFailure,
} from "../scripts/acceptance/restore-diagnostic.mjs";

it("DEP-002: restore and host use the same closed phase inventory", () => {
  expect(hostPhases).toEqual(restorePhases);
  expect(Object.isFrozen(hostPhases)).toBe(true);
  expect(Object.isFrozen(restorePhases)).toBe(true);
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
