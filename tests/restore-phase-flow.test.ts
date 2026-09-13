import { expect, it, vi } from "vitest";
import { restore } from "../packages/operations/src/restore.js";
import { restoreFailurePhase } from "../scripts/acceptance/restore-diagnostic.mjs";

// Failure-control tests only: no real database, archive or filesystem target.
const f = vi.hoisted(() => {
  const state = { fault: "", cleanupFault: "" };
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
  return { state, fail, client };
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
  assertNoOtherSessions: async () => {},
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
  postgresTool: () => ({
    child: { stdout: { resume: () => {} } },
    completed: Promise.resolve().then(() => f.fail("postgres_restore")),
  }),
}));
it.each([
  ["archive_authentication", ""],
  ["postgres_restore", ""],
  ["ownership", ""],
  ["grants", ""],
  ["integrity", ""],
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
    f.client.query.mockClear();
    f.client.end.mockClear();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        restore(
          {
            customerId: "synthetic",
            database: {
              database: "synthetic_target",
              host: "same",
              port: 5432,
            },
          } as never,
          [],
          "synthetic",
          "archive.pdaa",
          Buffer.alloc(32),
        ),
      ).rejects.toThrow();
      expect(output).toHaveBeenCalledTimes(1);
      const line = output.mock.calls[0]![0];
      expect(line).not.toContain("Private error details");
      expect(restoreFailurePhase(Buffer.from(line))).toBe(fault);
      if (["ownership", "grants", "integrity", "commit"].includes(fault))
        expect(f.client.query).toHaveBeenCalledWith("ROLLBACK");
    } finally {
      output.mockRestore();
    }
  },
);
