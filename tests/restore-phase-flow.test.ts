import { expect, it, vi } from "vitest";
import { restore } from "../packages/operations/src/restore.js";
import { restoreFailureDetails, restoreFailurePhase } from "../scripts/acceptance/restore-diagnostic.mjs";

// Failure-control tests only: no real database, archive or filesystem target.
const f = vi.hoisted(() => {
  const state = { fault: "", cleanupFault: "", sessionChecks: 0, finalGateCallAt: -1, imports: 0 };
  const fail = (phase: string) => {
    if (state.fault === phase || state.cleanupFault === phase)
      throw new Error("Private error details must not be logged");
  };
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith("DO $$")) fail("ownership");
      if (sql.includes("AS invalid")) {
        fail("integrity");
        return { rows: [{ invalid: 0 }] };
      }
      if (sql === "COMMIT") fail("commit");
      if (sql === "ROLLBACK") fail("rollback");
      return { rows: [{ allowed: false }] };
    }),
    end: vi.fn(async () => {
      fail("connection_cleanup");
    }),
  };
  return { state, fail, client, RestoreAutovacuumBusy: class extends Error {} };
});
vi.mock("node:fs", () => ({
  mkdtempSync: () => "/tmp/synthetic-restore-no-files",
  rmSync: () => {
    f.fail("plaintext_cleanup");
  },
}));
vi.mock("../packages/operations/src/config.js", () => ({
  connect: async () => f.client,
  assertPostgres17: async () => {},
  assertEmptyTarget: async () => {},
  assertNoOtherSessions: async () => { f.state.sessionChecks++; },
  RestoreAutovacuumBusy: f.RestoreAutovacuumBusy,
  assertRestoreCommitQuiescence: async (_client: unknown, report: (category: string, observation?: unknown) => void) => {
    f.state.sessionChecks++;
    f.state.finalGateCallAt = f.client.query.mock.calls.length;
    if (f.state.fault.startsWith("maintenance_") && (f.state.sessionChecks === 3 ||
        (f.state.fault === "maintenance_again" && f.state.sessionChecks === 5))) {
      report("other_sessions", { count: "one", client: "no", nonclient: "yes", null_type: "no", backend_kind: "autovacuum_worker" });
      throw new f.RestoreAutovacuumBusy("Private maintenance error");
    }
    if (f.state.fault === "maintenance_client" && f.state.sessionChecks === 4) {
      report("other_sessions", { count: "one", client: "yes", nonclient: "no", null_type: "no" });
      throw new Error("Private session-check error");
    }
    if (f.state.sessionChecks !== 3) return;
    const categories: Record<string, string> = {
      sessions_before_commit_other_sessions: "other_sessions",
      sessions_before_commit_query_failed: "query_failed",
      sessions_before_commit_invalid_result: "invalid_result",
    };
    const category = categories[f.state.fault];
    if (category) {
      report(category, category === "other_sessions" ? { count: "one", client: "yes", nonclient: "no", null_type: "no" } : undefined);
      throw new Error("Private session-check error");
    }
  },
  identifier: () => '"synthetic_target"',
}));
vi.mock("../packages/operations/src/provision.js", () => ({
  assertCustomer: async () => {},
  grants: async () => {
    f.fail("grants");
  },
  verifyRoles: async () => {},
}));
vi.mock("../packages/operations/src/migrations.js", () => ({
  history: async () => [],
  validateHistory: () => {},
}));
vi.mock("../packages/operations/src/update-engagement-issuance.js", () => ({
  // These tests isolate phase/error cleanup; native recovery separately proves
  // the real gate's disable/rotation and retained invitation epochs.
  quarantineUpdateIssuance: vi.fn(async () => ({ issuanceDisabled: true, invitationsInvalidated: true })),
}));
vi.mock("../packages/operations/src/archive.js", () => ({
  archivePath: () => "synthetic-no-file",
  requireRestoreTmpfs: () => {},
  openArchive: async () => {
    f.fail("archive_authentication");
    return {
      customerId: "synthetic",
      migrations: [],
      graphileVersion: 19,
      source: { database: "different_source", host: "same", port: 5432 },
    };
  },
}));
vi.mock("../packages/operations/src/backup.js", () => ({
  postgresTool: () => {
    f.state.imports++;
    return {
      child: { stdout: { resume: () => {} } },
      completed: Promise.resolve().then(() => f.fail("postgres_restore")),
    };
  },
}));

function restoreFixture() {
  return restore({
    customerId: "synthetic",
    database: { database: "synthetic_target", host: "same", port: 5432 },
  } as never, [], "synthetic", "archive.pdaa", Buffer.alloc(32));
}

it.each([
  ["archive_authentication", ""],
  ["postgres_restore", ""],
  ["ownership", ""],
  ["grants", ""],
  ["integrity", ""],
  ["sessions_before_commit_other_sessions", ""],
  ["sessions_before_commit_query_failed", ""],
  ["sessions_before_commit_invalid_result", ""],
  ["sessions_before_commit_other_sessions", "rollback"],
  ["commit", ""],
  ["connection_cleanup", ""],
  ["plaintext_cleanup", ""],
  ["integrity", "rollback"],
  ["integrity", "connection_cleanup"],
  ["integrity", "plaintext_cleanup"],
])(
  "DEP-002 / SEC-SECRET-001: restore still rejects and reports first failure through cleanup (%s, %s)",
  async (fault, cleanupFault) => {
    f.state.fault = fault;
    f.state.cleanupFault = cleanupFault;
    f.state.sessionChecks = 0;
    f.client.query.mockClear();
    f.client.end.mockClear();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(restoreFixture()).rejects.toThrow();
      expect(output).toHaveBeenCalledTimes(1);
      const line = output.mock.calls[0]![0];
      expect(line).not.toContain("Private error details");
      expect(restoreFailurePhase(Buffer.from(line))).toBe(fault);
      if (fault === "sessions_before_commit_other_sessions")
        expect(restoreFailureDetails(Buffer.from(line))).toEqual({ phase: fault, sessions: { count: "one", client: "yes", nonclient: "no", null_type: "no" } });
      if (["ownership", "grants", "integrity", "commit"].includes(fault) || fault.startsWith("sessions_before_commit_"))
        expect(f.client.query).toHaveBeenCalledWith("ROLLBACK");
      if (fault.startsWith("sessions_before_commit_"))
        expect(f.client.query).not.toHaveBeenCalledWith("COMMIT");
    } finally {
      output.mockRestore();
    }
  },
);

it("DEP-002: a successful final session gate is followed directly by commit and quarantine verification", async () => {
  f.state.fault = "";
  f.state.cleanupFault = "";
  f.state.sessionChecks = 0;
  f.state.finalGateCallAt = -1;
  f.client.query.mockClear();
  await expect(restoreFixture()).resolves.toMatchObject({ quarantine: true, applicationStarted: false });
  expect(f.state.sessionChecks).toBe(3);
  expect(f.client.query.mock.calls[f.state.finalGateCallAt]).toEqual(["COMMIT"]);
  expect(f.client.query).not.toHaveBeenCalledWith("ROLLBACK");
});

it.each([
  ["maintenance_settled", ["BEGIN", "ROLLBACK", "BEGIN", "COMMIT"], 5],
  ["maintenance_client", ["BEGIN", "ROLLBACK"], 4],
  ["maintenance_again", ["BEGIN", "ROLLBACK", "BEGIN", "ROLLBACK"], 5],
] as const)("DEP-002: an autovacuum timeout permits one fenced validation retry (%s)", async (fault, commands, checks) => {
  f.state.fault = fault;
  f.state.cleanupFault = "";
  f.state.sessionChecks = 0;
  f.state.imports = 0;
  f.client.query.mockClear();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    if (fault === "maintenance_settled") {
      await expect(restoreFixture()).resolves.toMatchObject({ quarantine: true, applicationStarted: false });
      expect(output).not.toHaveBeenCalled();
      expect(f.client.query.mock.calls[f.state.finalGateCallAt]).toEqual(["COMMIT"]);
    } else {
      await expect(restoreFixture()).rejects.toThrow();
      expect(restoreFailurePhase(Buffer.from(output.mock.calls[0]![0]))).toBe("sessions_before_commit_other_sessions");
    }
    expect(f.state.sessionChecks).toBe(checks);
    expect(f.state.imports).toBe(1);
    expect(f.client.query.mock.calls.map(([sql]) => sql).filter((sql) =>
      ["BEGIN", "ROLLBACK", "COMMIT"].includes(sql))).toEqual(commands);
    expect(f.client.query.mock.calls.filter(([sql]) => sql.startsWith("DO $$"))).toHaveLength(commands.filter((sql) => sql === "BEGIN").length);
  } finally { output.mockRestore(); }
});
