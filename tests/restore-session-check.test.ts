import { expect, it, vi } from "vitest";
import {
  assertNoOtherSessions,
  assertRestoreCommitQuiescence,
} from "../packages/operations/src/config.js";

it("DEP-002: the session gate accepts only zero and reports no success diagnostic", async () => {
  const client = { query: vi.fn(async (_query: string) => ({ rows: [{ n: 0 }] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).resolves.toBeUndefined();
  expect(report).not.toHaveBeenCalled();
  expect(client.query).toHaveBeenCalledOnce();
  expect(client.query.mock.calls[0]![0]).toContain("FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
});
it("DEP-002: calls without diagnostic reporting retain the original count query", async () => {
  const client = { query: vi.fn(async (_query: string) => ({ rows: [{ n: 0 }] })) };
  await expect(assertNoOtherSessions(client as never)).resolves.toBeUndefined();
  expect(client.query).toHaveBeenCalledExactlyOnceWith("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
});
it.each(["autovacuum_worker", "parallel_worker", "logical_replication_worker", "other_nonclient"])(
  "DEP-002: a consistent single non-client backend reports only the fixed %s category", async (backend_kind) => {
    const client = { query: vi.fn(async (_query: string) => ({ rows: [{ n: 1, client: false, nonclient: true, null_type: false, backend_kind }] })) }, report = vi.fn();
    await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
    expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", { count: "one", client: "no", nonclient: "yes", null_type: "no", backend_kind });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query.mock.calls[0]![0]).toContain("CASE WHEN count(*) = 1");
  },
);
it.each([
  { n: 2, client: false, nonclient: true, null_type: false, backend_kind: "parallel_worker" },
  { n: 1, client: true, nonclient: false, null_type: false, backend_kind: "parallel_worker" },
  { n: 1, client: false, nonclient: true, null_type: true, backend_kind: "parallel_worker" },
  { n: 1, client: false, nonclient: true, null_type: false, backend_kind: "private-canary" },
  { n: 1, client: false, nonclient: true, null_type: false, get backend_kind() { throw new Error("private-canary"); } },
])("DEP-002: inconsistent or invalid backend kind remains unknown", async (row) => {
  const client = { query: vi.fn(async () => ({ rows: [row] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report.mock.calls[0]![1].backend_kind).toBe("unknown");
  expect(JSON.stringify(report.mock.calls)).not.toContain("private-canary");
});
it("DEP-002: success never reads the backend-kind diagnostic", async () => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: 0, get backend_kind() { throw new Error("private-canary"); } }] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).resolves.toBeUndefined();
  expect(report).not.toHaveBeenCalled();
});
it.each([1, 42])("DEP-002: any other session remains a hard failure with a fixed category (%s)", async (count) => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: count }] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", {
    count: count === 1 ? "one" : "multiple", client: "unknown", nonclient: "unknown", null_type: "unknown", backend_kind: "unknown",
  });
});
it("DEP-002: only bounded same-query classes accompany an already-rejected gate", async () => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: 2, client: true, nonclient: false, null_type: false }] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", { count: "multiple", client: "yes", nonclient: "no", null_type: "no", backend_kind: "unknown" });
});
it.each([
  [{ n: 1, client: null, nonclient: false, null_type: true }, { count: "one", client: "unknown", nonclient: "unknown", null_type: "yes" }],
  [{ n: 2, client: true, nonclient: false, null_type: true }, { count: "multiple", client: "yes", nonclient: "unknown", null_type: "yes" }],
  [{ n: 2, client: false, nonclient: true, null_type: true }, { count: "multiple", client: "unknown", nonclient: "yes", null_type: "yes" }],
  [{ n: 1, client: true, nonclient: true, null_type: false }, { count: "one", client: "unknown", nonclient: "unknown", null_type: "unknown" }],
  [{ n: 2, client: false, nonclient: false, null_type: false }, { count: "multiple", client: "unknown", nonclient: "unknown", null_type: "unknown" }],
])("DEP-002: null_type and contradictory type flags never assert absence", async (row, expected) => {
  const client = { query: vi.fn(async () => ({ rows: [row] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", { ...expected, backend_kind: "unknown" });
});
it("DEP-002: diagnostic getter and reporter failures cannot admit a session or replace the gate error", async () => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: 1, get client() { throw new Error("private client"); }, nonclient: "private", null_type: false }] })) };
  const report = vi.fn(() => { throw new Error("private reporter"); });
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", { count: "one", client: "unknown", nonclient: "unknown", null_type: "no", backend_kind: "unknown" });
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});
it.each([undefined, null, -1, "0", NaN])("DEP-002: malformed session counts fail closed (%s)", async (count) => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: count }] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("invalid_result");
});
it.each([[], [{ n: 0 }, { n: 1 }], null])("DEP-002: malformed result rows fail closed", async (rows) => {
  const client = { query: vi.fn(async () => ({ rows })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("invalid_result");
});
it("SEC-SECRET-001: hostile result getters report only the fixed invalid-result category", async () => {
  for (const result of [{ get rows() { throw new Error("private rows"); } },
    { rows: [{ get n() { throw new Error("private count"); } }] }]) {
    const client = { query: vi.fn(async () => result) }, report = vi.fn();
    await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
    expect(report).toHaveBeenCalledExactlyOnceWith("invalid_result");
    expect(JSON.stringify(report.mock.calls)).not.toContain("private");
  }
});
it("SEC-SECRET-001: query and diagnostic failures retain the original error without reporting its contents", async () => {
  const privateError = new Error("synthetic private connection details"), report = vi.fn(() => { throw new Error("private reporter"); });
  const client = { query: vi.fn(async () => { throw privateError; }) };
  await expect(assertNoOtherSessions(client as never, report)).rejects.toBe(privateError);
  expect(report).toHaveBeenCalledExactlyOnceWith("query_failed");
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

const clearActivity = "SELECT pg_catalog.pg_stat_clear_snapshot()";
const maintenance = {
  n: 1,
  client: false,
  nonclient: true,
  null_type: false,
  backend_kind: "autovacuum_worker",
};
const otherClient = {
  n: 1,
  client: true,
  nonclient: false,
  null_type: false,
  backend_kind: "unknown",
};

function commitGateClient(...probes: (object | Error)[]) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql === clearActivity) return {};
      expect(sql).toContain(
        "FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()",
      );
      const probe = probes.shift();
      if (probe instanceof Error) throw probe;
      return { rows: [probe] };
    }),
  };
}

it("DEP-002: commit observes fresh zero once when the database is already clear", async () => {
  const client = commitGateClient({ n: 0 });
  const report = vi.fn();
  await assertRestoreCommitQuiescence(client as never, report);
  expect(client.query).toHaveBeenCalledTimes(2);
  expect(client.query).toHaveBeenNthCalledWith(1, clearActivity);
  expect(report).not.toHaveBeenCalled();
});

it("DEP-002: one maintenance worker must exit before a fresh unfiltered zero can admit commit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  try {
    const client = commitGateClient(maintenance, { n: 0 });
    const report = vi.fn();
    const result = assertRestoreCommitQuiescence(client as never, report);
    await vi.runAllTimersAsync();
    await result;
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query).toHaveBeenNthCalledWith(1, clearActivity);
    expect(client.query).toHaveBeenNthCalledWith(3, clearActivity);
    expect(report).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("DEP-002: a persistent worker consumes only the finite settlement window", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  try {
    const client = commitGateClient(...Array.from({ length: 7 }, () => maintenance));
    const report = vi.fn();
    const start = performance.now();
    const result = expect(
      assertRestoreCommitQuiescence(client as never, report),
    ).rejects.toThrow("Target has another database session");
    await vi.runAllTimersAsync();
    await result;
    expect(client.query).toHaveBeenCalledTimes(14);
    expect(performance.now() - start).toBe(1500);
    expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", {
      count: "one",
      client: "no",
      nonclient: "yes",
      null_type: "no",
      backend_kind: "autovacuum_worker",
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  otherClient,
  { ...maintenance, n: 2 },
  { ...maintenance, backend_kind: "parallel_worker" },
  { ...maintenance, client: null, null_type: true },
  { ...maintenance, n: "0" },
  new Error("private activity query details"),
])("DEP-002: every other observation fails on the first probe", async (observation) => {
  const client = commitGateClient(observation, { n: 0 });
  const report = vi.fn();
  await expect(assertRestoreCommitQuiescence(client as never, report)).rejects.toBeDefined();
  expect(client.query).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledOnce();
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

it.each([
  ["client", otherClient, "other_sessions"],
  ["unknown", { ...maintenance, backend_kind: "unknown" }, "other_sessions"],
  ["mixed", { ...maintenance, n: 2, client: true }, "other_sessions"],
  ["error", new Error("private activity row"), "query_failed"],
] as const)("DEP-002: %s after a settling worker prevents commit immediately", async (_name, observation, category) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  try {
    const client = commitGateClient(maintenance, observation, { n: 0 });
    const report = vi.fn();
    const result = expect(
      assertRestoreCommitQuiescence(client as never, report),
    ).rejects.toBeDefined();
    await vi.runAllTimersAsync();
    await result;
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toBe(category);
  } finally {
    vi.useRealTimers();
  }
});

it("DEP-002: exhausts the wait budget when a refresh completes after its deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  try {
    const client = commitGateClient(maintenance, { n: 0 });
    let clears = 0;
    const query = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql) => {
      if (sql === clearActivity && ++clears === 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1501));
      }
      return query(sql);
    });
    const report = vi.fn(() => { throw new Error("private reporter"); });
    const result = expect(
      assertRestoreCommitQuiescence(client as never, report),
    ).rejects.toThrow("Target has another database session");
    await vi.runAllTimersAsync();
    await result;
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toBe("other_sessions");
  } finally {
    vi.useRealTimers();
  }
});

it("DEP-002: a failed activity refresh never proceeds to count", async () => {
  const privateError = new Error("private snapshot refresh");
  const client = { query: vi.fn(async () => { throw privateError; }) };
  const report = vi.fn();
  await expect(assertRestoreCommitQuiescence(client as never, report)).rejects.toBe(privateError);
  expect(client.query).toHaveBeenCalledExactlyOnceWith(clearActivity);
  expect(report).toHaveBeenCalledExactlyOnceWith("query_failed");
});
