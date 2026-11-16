// FR-CON-006/007/012 / NFR-SEC-001: guard/failure plumbing, never native acceptance.
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import {
  assertCsvPrototypeTarget,
  verifyCsvComparisonPrototype,
} from "../scripts/acceptance/csv-comparison-prototype.mjs";
import {
  csvNativeCorruptions,
  csvPositiveVectors,
} from "../scripts/acceptance/csv-comparison-vectors.mjs";
import { serializeCsvComparisonState } from "../packages/domain/src/csv-comparison-state.js";

const target =
  "postgresql://owner:private@127.0.0.1:5432/pdaa_test_1794800000000";
const environment = { DATA_MODE: "synthetic", NODE_ENV: "test" };
const refused = [
  "postgresql://owner:private@127.0.0.1/pdaa",
  "postgresql://owner:private@127.0.0.1/postgres",
  "postgresql://owner:private@remote.example/pdaa_test_1",
  "postgresql://owner:private@127.0.0.1.example/pdaa_test_1",
  "postgresql://127.0.0.1@remote.example/pdaa_test_1",
  "postgresql://owner:private@[::1]/pdaa_test_1",
  target + "?host=remote.example",
  target + "?dbname=pdaa",
  target + "?options=-c%20search_path=private",
  target + "?",
  target + "#",
  target + "#private",
  "postgresql://localhost/pdaa_test_",
  "postgresql://localhost/pdaa_test_1abc",
  "postgresql://localhost/pdaa_test_1/",
  "postgresql://localhost/%70daa_test_1",
  "postgresql://localhost/pdaa_test_" + "1".repeat(54),
  "http://localhost/pdaa_test_1",
  "not a connection URL",
  "",
];
it.each(refused.map((url, i) => [i, url]))(
  "refuses unsafe target %i before pool construction",
  async (_i, url) => {
    const factory = vi.fn(() => {
      throw new Error("must not connect");
    });
    await expect(
      verifyCsvComparisonPrototype(url, { environment, poolFactory: factory }),
    ).rejects.toThrow("CSV_PROTOTYPE_TARGET_REFUSED");
    expect(factory).not.toHaveBeenCalled();
  },
);
it.each([
  { DATA_MODE: "synthetic", NODE_ENV: "production" },
  { DATA_MODE: "real", NODE_ENV: "test" },
  { NODE_ENV: "test" },
  {},
])(
  "refuses non-synthetic or production configuration before pool construction",
  async (env) => {
    const factory = vi.fn();
    await expect(
      verifyCsvComparisonPrototype(target, {
        environment: env,
        poolFactory: factory,
      }),
    ).rejects.toThrow("CSV_PROTOTYPE_TARGET_REFUSED");
    expect(factory).not.toHaveBeenCalled();
  },
);
it.each([target, "postgres://owner:private@localhost/pdaa_test_1"])(
  "accepts only the isolated target name",
  (url) => {
    expect(assertCsvPrototypeTarget(url, environment)).toMatch(
      /^pdaa_test_[0-9]+$/,
    );
  },
);
it("bounds driver timeouts and replaces URL-bearing pool errors with finite categories", async () => {
  let actual: any;
  const error: any = await verifyCsvComparisonPrototype(target, {
    environment,
    poolFactory: (options: any) => {
      actual = options;
      throw new Error(target);
    },
  }).catch((e: any) => e);
  expect(error.message).toBe("CSV_PROTOTYPE_VALIDATION_FAILED");
  expect(error.failure).toEqual({ primary: { stage: "pool" }, cleanup: [] });
  expect(JSON.stringify(error)).not.toContain("private");
  expect(error.stack).not.toContain(target);
  expect(actual).toMatchObject({
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 20000,
    idleTimeoutMillis: 5000,
    options:
      "-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000",
  });
});

// Construct only enough synthetic metadata to reach a deliberately failed DDL.
// No fake returns a successful native vector, role result or acceptance receipt.
function failingPool(mode = "ddl") {
  const directory = new URL(
    "../packages/data/prisma/migrations/",
    import.meta.url,
  );
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const tableNames = new Set(["_prisma_migrations"]);
  const ledger = migrations.map((name) => {
    const sql = readFileSync(new URL(name + "/migration.sql", directory));
    for (const match of sql
      .toString()
      .matchAll(/CREATE TABLE (?:public\.)?"([A-Za-z0-9_]+)"/g))
      tableNames.add(match[1]!);
    return {
      migration_name: name,
      checksum: createHash("sha256").update(sql).digest("hex"),
      finished_at: new Date(0),
      rolled_back_at: null,
      applied_steps_count: 1,
    };
  });
  const tables = [...tableNames].sort().map((relname) => ({ relname }));
  const events: string[] = [];
  let absenceReads = 0;
  const injected = () =>
    Object.assign(new Error("private " + target), {
      code: "42601",
      position: "17",
    });
  const client = {
    on: (event: string, listener: (...args: any[]) => void) =>
      emitter.on(event, listener),
    query: async (sql: string) => {
      if (sql.includes("SELECT current_database()")) {
        events.push("target");
        return {
          rows: [
            { name: mode === "target" ? "pdaa" : "pdaa_test_1794800000000" },
          ],
        };
      }
      if (sql.includes("FROM public._prisma_migrations")) {
        events.push("ledger");
        return { rows: ledger };
      }
      if (sql.includes("FROM pg_class c JOIN pg_namespace")) {
        events.push("tables");
        return { rows: tables };
      }
      if (sql.startsWith("SELECT to_regprocedure")) {
        events.push("absence");
        absenceReads++;
        return {
          rows: [
            {
              a:
                mode === "verification" && absenceReads > 1 ? "leftover" : null,
              b: null,
            },
          ],
        };
      }
      if (sql === "BEGIN") {
        events.push("begin");
        if (mode === "begin") throw injected();
        return {};
      }
      if (sql.startsWith("SET LOCAL statement_timeout")) {
        events.push("timeout");
        return {};
      }
      if (sql.includes("CREATE FUNCTION public.valid_ingestion_csv_state")) {
        events.push("ddl");
        if (mode === "owned-error") emitter.emit("error", injected());
        throw injected();
      }
      if (sql === "ROLLBACK") {
        events.push("rollback");
        if (mode === "rollback") throw injected();
        return {};
      }
      throw new Error("Unexpected query in failure-only fixture");
    },
    release: (destroy: boolean) => {
      events.push("release:" + destroy);
      if (mode === "release") throw injected();
    },
  };
  const emitter = new EventEmitter();
  const pool = {
    on: vi.fn(),
    connect: async () => {
      events.push("connect");
      if (mode === "connect") throw injected();
      return client;
    },
    end: async () => {
      events.push("end");
      if (mode === "end") throw injected();
    },
  };
  return { events, pool };
}
async function fail(mode: string) {
  const { events, pool } = failingPool(mode);
  const error: any = await verifyCsvComparisonPrototype(target, {
    environment,
    poolFactory: () => pool,
  }).catch((e: any) => e);
  expect(error.message).toBe("CSV_PROTOTYPE_VALIDATION_FAILED");
  expect(JSON.stringify(error)).not.toContain("private");
  expect(JSON.stringify(error)).not.toContain(target);
  return { error, events };
}
it("checks the actual database before DDL and still finalizes the client and pool", async () => {
  const { error, events } = await fail("target");
  expect(error.failure).toEqual({
    primary: { stage: "actual-target" },
    cleanup: [],
  });
  expect(events).toEqual(["connect", "target", "release:true", "end"]);
});
it("ends the pool after a failed connection", async () => {
  const { error, events } = await fail("connect");
  expect(error.failure.primary).toEqual({
    stage: "connect",
    sqlstate: "42601",
    position: 17,
  });
  expect(events).toEqual(["connect", "end"]);
});
it.each(["ddl", "begin"])(
  "rolls back an uncertain %s result and verifies absence/metadata before release",
  async (mode) => {
    const { error, events } = await fail(mode);
    expect(error.failure.primary).toEqual({
      stage: mode === "ddl" ? "prototype-ddl" : "begin",
      sqlstate: "42601",
      position: 17,
    });
    expect(events.slice(-6)).toEqual([
      "rollback",
      "absence",
      "ledger",
      "tables",
      "release:true",
      "end",
    ]);
    expect(error.failure.cleanup).toEqual([]);
  },
);
it.each(["rollback", "verification", "release", "end"])(
  "retains original and %s cleanup failure and attempts all finalizers",
  async (mode) => {
    const { error, events } = await fail(mode);
    expect(error.failure.primary.stage).toBe("prototype-ddl");
    expect(error.failure.cleanup.map((e: any) => e.stage)).toEqual([
      {
        rollback: "rollback",
        verification: "rollback-verification",
        release: "release",
        end: "pool-end",
      }[mode],
    ]);
    expect(events).toContain("release:true");
    expect(events.at(-1)).toBe("end");
  },
);
it("contains checked-out client socket errors without raw logging or escaping finalizers", async () => {
  const { error, events } = await fail("owned-error");
  expect(error.failure).toEqual({
    primary: { stage: "prototype-ddl", sqlstate: "42601", position: 17 },
    cleanup: [{ stage: "owned-client-error", sqlstate: "42601", position: 17 }],
  });
  expect(events.slice(-6)).toEqual([
    "rollback",
    "absence",
    "ledger",
    "tables",
    "release:true",
    "end",
  ]);
});
it("independently pins the positive bytes and confirms corruption fixtures are invalid transport states", () => {
  for (const vector of csvPositiveVectors()) {
    const result = serializeCsvComparisonState(vector.state);
    if (vector.bytes !== undefined) expect(result.bytes).toBe(vector.bytes);
    if (vector.digest !== undefined)
      expect(createHash("sha256").update(result.text).digest("hex")).toBe(
        vector.digest,
      );
  }
  const negatives = csvNativeCorruptions();
  expect(new Set(negatives.map((v: any) => v.name)).size).toBe(
    negatives.length,
  );
  for (const { state } of negatives)
    expect(() => serializeCsvComparisonState(state)).toThrow(
      "INVALID_CSV_COMPARISON_STATE",
    );
});
