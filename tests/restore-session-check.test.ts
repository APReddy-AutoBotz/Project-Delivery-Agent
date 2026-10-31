import { expect, it, vi } from "vitest";
import { assertNoOtherSessions } from "../packages/operations/src/config.js";

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
it.each([1, 42])("DEP-002: any other session remains a hard failure with a fixed category (%s)", async (count) => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: count }] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", {
    count: count === 1 ? "one" : "multiple", client: "unknown", nonclient: "unknown", null_type: "unknown",
  });
});
it("DEP-002: only bounded same-query classes accompany an already-rejected gate", async () => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: 2, client: true, nonclient: false, null_type: false }] })) }, report = vi.fn();
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", { count: "multiple", client: "yes", nonclient: "no", null_type: "no" });
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
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", expected);
});
it("DEP-002: diagnostic getter and reporter failures cannot admit a session or replace the gate error", async () => {
  const client = { query: vi.fn(async () => ({ rows: [{ n: 1, get client() { throw new Error("private client"); }, nonclient: "private", null_type: false }] })) };
  const report = vi.fn(() => { throw new Error("private reporter"); });
  await expect(assertNoOtherSessions(client as never, report)).rejects.toThrow("Target has another database session");
  expect(report).toHaveBeenCalledExactlyOnceWith("other_sessions", { count: "one", client: "unknown", nonclient: "unknown", null_type: "no" });
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
