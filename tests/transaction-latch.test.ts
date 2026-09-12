import { expect, it, vi } from "vitest";
import {
  observeTransactions,
  waitForTransactionBlockers,
} from "../scripts/acceptance/transaction-latch.mjs";

it("FR-EVD-012: observes the operation transaction without changing its options", async () => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ pid: 7, role: "pdaa_api" }]),
  };
  const started = vi.fn(),
    beforeCommit = vi.fn(),
    callback = vi.fn().mockResolvedValue("saved");
  const options = { timeout: 10000, isolationLevel: "ReadCommitted" };
  const db = {
    $transaction: vi.fn(async (body: (tx: unknown) => Promise<unknown>) =>
      body(tx),
    ),
  };
  const observed = observeTransactions(db, { started, beforeCommit });
  expect(await observed.$transaction(callback, options)).toBe("saved");
  expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), options);
  expect(callback).toHaveBeenCalledWith(tx);
  expect(started).toHaveBeenCalledWith(7);
  expect(beforeCommit).toHaveBeenCalledWith(7);
  expect(started.mock.invocationCallOrder[0]).toBeLessThan(
    callback.mock.invocationCallOrder[0]!,
  );
  expect(callback.mock.invocationCallOrder[0]).toBeLessThan(
    beforeCommit.mock.invocationCallOrder[0]!,
  );
});
it("NFR-SEC-001: rejects owner-backed transactions before invoking the command", async () => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ pid: 7, role: "fixture_admin" }]),
  };
  const callback = vi.fn();
  const db = {
    $transaction: async (body: (tx: unknown) => Promise<unknown>) => body(tx),
  };
  await expect(observeTransactions(db).$transaction(callback)).rejects.toThrow(
    "pdaa_api",
  );
  expect(callback).not.toHaveBeenCalled();
});
it("NFR-REL-001: scopes lock observation to exact transaction PIDs and application tags", async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [
      { pid: 2, tag: "a" },
      { pid: 3, tag: "b" },
    ],
  });
  await waitForTransactionBlockers({ query }, 1, [
    { pid: 2, tag: "a" },
    { pid: 3, tag: "b" },
  ]);
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      text: expect.stringContaining("pg_blocking_pids"),
      values: [[2, 3], [1, 2, 3], 1],
    }),
  );
  expect(query.mock.calls[0]![0].text).toContain("a.usename='pdaa_api'");
  expect(query.mock.calls[0]![0].text).toContain("current_database()");
  expect(query.mock.calls[0]![0].query_timeout).toBeGreaterThan(0);
  expect(query.mock.calls[0]![0].query_timeout).toBeLessThanOrEqual(3000);
});
it("NFR-REL-001: a stalled observer cannot outlive the three-second latch", async () => {
  vi.useFakeTimers();
  try {
    const query = vi.fn(() => new Promise(() => {}));
    const check = expect(
      waitForTransactionBlockers({ query }, 1, [{ pid: 2, tag: "a" }]),
    ).rejects.toThrow("Lock observer exceeded the latch budget");
    await vi.advanceTimersByTimeAsync(3000);
    await check;
  } finally {
    vi.useRealTimers();
  }
});
