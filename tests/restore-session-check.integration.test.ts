import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { assertNoOtherSessions } from "../packages/operations/src/config.js";

const url = process.env.PDAA_DATABASE_URL;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname) ||
    !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || process.env.DATA_MODE !== "synthetic")
  throw new Error("Session-gate integration requires an isolated synthetic database");

it("DEP-002: real database session and rejected query remain fixed-category failures", async () => {
  const { Client } = createRequire(new URL("../packages/operations/package.json", import.meta.url))("pg");
  const gate = new Client({ connectionString: url }), other = new Client({ connectionString: url });
  const categories: string[] = [];
  try {
    await gate.connect();
    await other.connect();
    const pid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const present = async () => (await gate.query(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid=$1) AS present", [pid],
    )).rows[0]!.present;
    expect(await present()).toBe(true);
    await expect(assertNoOtherSessions(gate, (category) => categories.push(category))).rejects.toThrow("Target has another database session");
    expect(categories).toEqual(["other_sessions"]);
    expect(await present()).toBe(true);
  } finally {
    try { await other.end(); } finally { await gate.end(); }
  }
  categories.length = 0;
  await expect(assertNoOtherSessions(gate, (category) => categories.push(category))).rejects.toBeDefined();
  expect(categories).toEqual(["query_failed"]);
}, 30000);
