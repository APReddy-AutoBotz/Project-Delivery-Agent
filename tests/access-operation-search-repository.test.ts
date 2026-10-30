import { expect, it, vi } from "vitest";
import { DatabaseAccessOperationSearchRepository } from "../packages/data/src/access-operation-search.js";
import { createAccessOperationAdmission } from "../packages/data/src/access-operation-admission.js";

const actor = { subject: "operator", roles: ["system_admin" as const], customerId: "10000000-0000-4000-8000-000000000001" };
const filters = { actor: "synthetic'; SELECT 'ignored", action: "access.granted" as const,
  from: "2026-10-01T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" };
const position = { occurredAt: "2026-10-15T00:00:00.123Z", id: "20000000-0000-4000-8000-000000000002" };
function fixture(rows: unknown[]) {
  const execute = vi.fn(async (..._args: unknown[]) => 0), query = vi.fn(async (...args: unknown[]) =>
    String(args[0]).includes("pg_try_advisory_xact_lock") ? [{ locked: true }] : rows);
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown, _options?: unknown) => fn({ $executeRawUnsafe: execute, $queryRawUnsafe: query }));
  const admission = createAccessOperationAdmission();
  return { repository: new DatabaseAccessOperationSearchRepository({ $transaction: transaction } as never, admission), execute, query, transaction, admission };
}
it("uses bounded server-side timeouts and parameterized wall-time keyset filters", async () => {
  const f = fixture([{ id: "20000000-0000-4000-8000-000000000001", actor: filters.actor,
    event: "access.granted", occurredAt: position.occurredAt }]);
  const rows = await f.repository.search(actor, filters, position);
  expect(rows[0]?.occurredAt.toISOString()).toBe(position.occurredAt);
  expect(f.execute.mock.calls.map((call) => call[0])).toEqual(["SET LOCAL statement_timeout='3s'", "SET LOCAL lock_timeout='2s'",
    "SET LOCAL idle_in_transaction_session_timeout='5s'"]);
  expect(f.query.mock.calls.slice(0, 2).map((call) => call[1])).toEqual([actor.customerId, 0]);
  const call = f.query.mock.calls.at(-1) as unknown as unknown[];
  expect(String(call[0])).toContain("event COLLATE \"C\" IN ('access.granted','access.revoked')");
  expect(String(call[0])).toContain('ORDER BY "occurredAt" DESC, id DESC LIMIT 31');
  expect(String(call[0])).toContain('actor COLLATE "C"=$5::text COLLATE "C"');
  expect(String(call[0])).not.toContain(filters.actor);
  expect(call.slice(1)).toEqual([actor.customerId, "2026-10-01T00:00:00.000", "2026-11-01T00:00:00.000",
    filters.action, filters.actor, "2026-10-15T00:00:00.123", position.id]);
  expect(f.transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: "ReadCommitted", maxWait: 2000, timeout: 6000 });
});
it("rejects every row that violates the filter, cursor, range or strict order", async () => {
  const row = { id: "20000000-0000-4000-8000-000000000001", actor: filters.actor,
    event: "access.granted", occurredAt: position.occurredAt };
  const invalidPages = [[{ ...row, actor: "other" }], [{ ...row, event: "access.revoked" }],
    [{ ...row, occurredAt: "2026-09-30T23:59:59.999Z" }],
    [{ ...row, occurredAt: filters.until }], [{ ...row, id: position.id }], [row, row],
    [row, { ...row, id: "20000000-0000-4000-8000-000000000002" }],
    [...Array.from({ length: 30 }, (_, i) => ({ ...row, id: `20000000-0000-4000-8000-${(i + 10).toString(16).padStart(12, "0")}`,
      occurredAt: `2026-10-14T00:00:${String(59 - i).padStart(2, "0")}.000Z` })),
      { ...row, actor: "other", occurredAt: "2026-10-14T00:00:00.000Z" }]];
  for (const rows of invalidPages) {
    const f = fixture(rows);
    await expect(f.repository.search(actor, filters, position)).rejects.toThrow("Access operation search unavailable");
  }
});
it("rejects unauthorized or invalid requests before opening a transaction", async () => {
  const f = fixture([]);
  await expect(f.repository.search({ ...actor, roles: ["pmo_admin"] }, filters, null)).rejects.toThrow("denied");
  await expect(f.repository.search(actor, { ...filters, actor: "\u0000" }, null)).rejects.toThrow("unavailable");
  await expect(f.repository.search(actor, filters, { ...position, occurredAt: filters.until })).rejects.toThrow("unavailable");
  expect(f.transaction).not.toHaveBeenCalled();
});
it("fails closed on anomalous, oversized or unavailable database results", async () => {
  for (const rows of [[{ id: position.id, actor: "synthetic", event: "other", occurredAt: position.occurredAt }],
    Array.from({ length: 32 }, () => ({ id: position.id, actor: "synthetic", event: "access.granted", occurredAt: position.occurredAt }))]) {
    const f = fixture(rows);
    await expect(f.repository.search(actor, filters, null)).rejects.toThrow("Access operation search unavailable");
  }
  const f = fixture([]); f.query.mockRejectedValueOnce(new Error("private details"));
  await expect(f.repository.search(actor, filters, null)).rejects.toThrow("Access operation search unavailable");
  expect(f.admission.status()).toEqual({ used: 1, poisoned: 1, limit: 4 });
});
it("stops before data access when tenant or global slots are busy and releases after commit", async () => {
  const tenantBusy = fixture([]); tenantBusy.query.mockResolvedValueOnce([{ locked: false }]);
  await expect(tenantBusy.repository.search(actor, filters, null)).rejects.toThrow("unavailable");
  expect(tenantBusy.query).toHaveBeenCalledTimes(1);
  expect(tenantBusy.admission.status()).toEqual({ used: 0, poisoned: 0, limit: 4 });
  const globalBusy = fixture([]);
  for (let i = 0; i < 4; i++) globalBusy.query.mockResolvedValueOnce(i === 0 ? [{ locked: true }] : [{ locked: false }]);
  globalBusy.query.mockResolvedValueOnce([{ locked: false }]);
  await expect(globalBusy.repository.search(actor, filters, null)).rejects.toThrow("unavailable");
  expect(globalBusy.query).toHaveBeenCalledTimes(5);
  expect(globalBusy.admission.status()).toEqual({ used: 0, poisoned: 0, limit: 4 });
});
it("tries the next global slot without acquiring multiple slots", async () => {
  const f = fixture([]);
  f.query.mockResolvedValueOnce([{ locked: true }]);
  f.query.mockResolvedValueOnce([{ locked: false }]);
  f.query.mockResolvedValueOnce([{ locked: true }]);
  await expect(f.repository.search(actor, filters, null)).resolves.toEqual([]);
  expect(f.query.mock.calls.slice(0, 3).map((call) => call[1])).toEqual([actor.customerId, 0, 1]);
  expect(f.query).toHaveBeenCalledTimes(4);
  expect(f.admission.status()).toEqual({ used: 0, poisoned: 0, limit: 4 });
});
it("poisons admission on malformed lock replies rather than treating them as a normal busy commit", async () => {
  const f = fixture([]); f.query.mockResolvedValueOnce([{}]);
  await expect(f.repository.search(actor, filters, null)).rejects.toThrow("unavailable");
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.admission.status()).toEqual({ used: 1, poisoned: 1, limit: 4 });
});
it("shares a no-queue process limit while transactions are unresolved", async () => {
  const admission = createAccessOperationAdmission();
  const releases: Array<(value: unknown[]) => void> = [];
  const transaction = vi.fn(() => new Promise<unknown[]>((resolve) => { releases.push(resolve); }));
  const db = { $transaction: transaction } as never;
  const one = new DatabaseAccessOperationSearchRepository(db, admission), two = new DatabaseAccessOperationSearchRepository(db, admission);
  const requests = [one.search(actor, filters, null), two.search(actor, filters, null),
    one.search(actor, filters, null), two.search(actor, filters, null)];
  await expect(one.search(actor, filters, null)).rejects.toThrow("unavailable");
  expect(transaction).toHaveBeenCalledTimes(4); expect(admission.status().used).toBe(4);
  for (const release of releases) release([]);
  await expect(Promise.all(requests)).resolves.toEqual([[], [], [], []]);
  expect(admission.status()).toEqual({ used: 0, poisoned: 0, limit: 4 });
});
