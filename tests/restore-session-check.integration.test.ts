import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { assertNoOtherSessions } from "../packages/operations/src/config.js";

const url = process.env.PDAA_DATABASE_URL;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname) ||
    !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || process.env.DATA_MODE !== "synthetic")
  throw new Error("Session-gate integration requires an isolated synthetic database");

it("DEP-002: real database session and rejected query remain fixed-category failures", async () => {
  const { Client } = createRequire(new URL("../packages/operations/package.json", import.meta.url))("pg");
  const gate = new Client({ connectionString: url }), other = new Client({ connectionString: url });
  const categories: string[] = [];
  const observations: unknown[] = [];
  try {
    await gate.connect();
    await other.connect();
    const pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const present = async () => (await gate.query(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid=$1) AS present", [pid],
    )).rows[0]!.present;
    expect(await present()).toBe(true);
    await expect(assertNoOtherSessions(gate, (category, observation) => { categories.push(category); observations.push(observation); })).rejects.toThrow("Target has another database session");
    expect(categories).toEqual(["other_sessions"]);
    expect(["one", "multiple"]).toContain((observations[0] as { count: string }).count);
    expect((observations[0] as { client: string }).client).toBe("yes");
    expect((observations[0] as { backend_kind: string }).backend_kind).toBe("unknown");
    expect(await present()).toBe(true);
  } finally {
    try { await other.end(); } finally { await gate.end(); }
  }
  categories.length = 0;
  await expect(assertNoOtherSessions(gate, (category) => categories.push(category))).rejects.toBeDefined();
  expect(categories).toEqual(["query_failed"]);
}, 30000);

it("DEP-002: PostgreSQL applies the finite backend CASE to synthetic value rows", async () => {
  const captured = { sql: "" };
  await assertNoOtherSessions({ query: async (sql: string) => { captured.sql = sql; return { rows: [{ n: 0 }] }; } } as never, () => {});
  const tail = "FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()";
  expect(captured.sql.split(tail)).toHaveLength(2);
  const sql = captured.sql.replace(tail, "FROM (SELECT unnest($1::text[]) AS backend_type) synthetic");
  const { Client } = createRequire(new URL("../packages/operations/package.json", import.meta.url))("pg");
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    for (const [values, expected, clientSeen, nonclientSeen, nullSeen] of [
      [["autovacuum worker"], "autovacuum_worker", false, true, false], [["parallel worker"], "parallel_worker", false, true, false],
      [["logical replication worker"], "logical_replication_worker", false, true, false], [["extension worker"], "other_nonclient", false, true, false],
      [["AUTOVACUUM WORKER"], "other_nonclient", false, true, false],
      [["client backend"], "unknown", true, false, false], [[null], "unknown", null, false, true],
      [["autovacuum worker", "parallel worker"], "unknown", false, true, false], [[], "unknown", null, null, null],
    ] as const) {
      const result = await client.query(sql, [values]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].n).toBe(values.length);
      expect(result.rows[0].backend_kind).toBe(expected);
      expect([result.rows[0].client, result.rows[0].nonclient, result.rows[0].null_type]).toEqual([clientSeen, nonclientSeen, nullSeen]);
    }
  } finally { await client.end(); }
}, 30000);

const restrictedUrl = process.env.PDAA_RESTRICTED_TEST_URL;
it.skipIf(!restrictedUrl)("DEP-002: restricted synthetic login can observe the gate without monitoring grants", async () => {
  const restricted = new URL(restrictedUrl!);
  if (restricted.hostname !== new URL(url!).hostname || restricted.port !== new URL(url!).port || restricted.pathname !== new URL(url!).pathname)
    throw new Error("Restricted session test must target the same isolated synthetic database");
  const { Client } = createRequire(new URL("../packages/operations/package.json", import.meta.url))("pg");
  const gate = new Client({ connectionString: restrictedUrl }), other = new Client({ connectionString: url });
  try {
    await gate.connect();
    const role = (await gate.query("SELECT rolsuper, pg_has_role(current_user, 'pg_read_all_stats', 'member') AS monitor FROM pg_roles WHERE rolname=current_user")).rows[0];
    expect(role).toEqual({ rolsuper: false, monitor: false });
    await other.connect();
    const pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const heldTypeIsNull = async () => (await gate.query(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid=$1 AND backend_type IS NULL) AS present", [pid],
    )).rows[0]!.present;
    expect(await heldTypeIsNull()).toBe(true);
    const report = vi.fn();
    await expect(assertNoOtherSessions(gate, report)).rejects.toThrow("Target has another database session");
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0]).toBe("other_sessions");
    expect(["one", "multiple"]).toContain(report.mock.calls[0]![1].count);
    expect(report.mock.calls[0]![1].null_type).toBe("yes");
    expect(report.mock.calls[0]![1].backend_kind).toBe("unknown");
    expect(await heldTypeIsNull()).toBe(true);
  } finally { try { await other.end(); } finally { await gate.end(); } }
}, 30000);
