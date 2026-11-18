import { expect, it, vi } from "vitest";
import { verifyRestoredCsvContextRows, verifyRestoredProofIntegrity, verifyRequiredCsvHeads } from "../scripts/acceptance/restored-proof-integrity.mjs";

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

const csvRows = Array.from({ length: 9 }, (_, n) => ({
  id: id(n),
  row: JSON.stringify({ receiptId: id(n), rows: [[`literal-${n}`, ["0", id(n)]]] }),
}));

function csvRowsFixture(rows = csvRows, count = rows.length) {
  return {
    $queryRawUnsafe: vi.fn(async (sql: string, cursor: string | null, size: number) => {
      if (sql.startsWith("SELECT count")) return [{ count }];
      expect(sql).toContain('ORDER BY t."receiptId" LIMIT $2::int');
      expect(sql).toContain("to_jsonb(t)::text AS row");
      return rows.filter((row) => cursor === null || row.id > cursor).slice(0, size);
    }),
  };
}

it("compares every exact CSV context row in bounded receipt ID pages", async () => {
  const original = csvRowsFixture();
  const restored = csvRowsFixture();
  await expect(verifyRestoredCsvContextRows(original, restored)).resolves.toBe(9);
  for (const db of [original, restored])
    expect(db.$queryRawUnsafe.mock.calls.slice(1).map(([, cursor, size]) => [cursor, size]))
      .toEqual([[null, 4], [id(3), 4], [id(7), 4], [id(8), 4]]);
});

it("rejects changed row bytes or an incomplete restored CSV context scan", async () => {
  const changed = csvRows.map((row, index) => index === 8 ? { ...row, row: row.row + " " } : row);
  await expect(verifyRestoredCsvContextRows(csvRowsFixture(), csvRowsFixture(changed)))
    .rejects.toThrow("Restored CSV context row differs");
  await expect(verifyRestoredCsvContextRows(csvRowsFixture(), csvRowsFixture(csvRows.slice(0, -1), 9)))
    .rejects.toThrow("Restored CSV context page length differs");
  await expect(verifyRestoredCsvContextRows(csvRowsFixture(csvRows, 10), csvRowsFixture(csvRows, 10)))
    .rejects.toThrow("Incomplete restored CSV context comparison");
});

function fixture(
  mutation?: (rows: any[], table: string, cursor: string | null) => any[],
) {
  return {
    $queryRawUnsafe: vi.fn(
      async (sql: string, cursor: string | null, size: number) => {
        if (sql.includes("AS missing_csv_heads")) return [{missing_csv_heads:0}];
        if (sql.includes("HAVING count(*)<>max(revision)"))
          return [{ invalid: 0 }];
        const table = /FROM public\."([^"]+)"/.exec(sql)![1]!;
        const count = table === "FactAuthorityConflict" ? 65 : 2;
        if (sql.startsWith("SELECT count")) return [{ count }];
        const rows = Array.from({ length: count }, (_, n) => ({
          id: id(n + 1),
          valid: true,
        }))
          .filter((row) => cursor === null || row.id > cursor)
          .slice(0, size);
        return mutation ? mutation(rows, table, cursor) : rows;
      },
    ),
  };
}

it("NFR-REL-001: checks every restored proof across complete bounded keyset pages", async () => {
  const db = fixture();
  const counts = await verifyRestoredProofIntegrity(db);
  expect(Object.keys(counts)).toHaveLength(16);
  expect(counts.IngestionCsvHead).toBe(2);
  expect(counts.IngestionCsvContext).toBe(2);
  expect(counts.IngestionProjectReassessment).toBe(2);
  expect(counts.FactAuthorityConflict).toBe(65);
  expect(Object.values(counts).reduce((a: number, b: any) => a + b, 0)).toBe(
    95,
  );
  const pages = db.$queryRawUnsafe.mock.calls.filter(([sql]) =>
    sql.includes("WITH page"),
  );
  expect(
    pages.every(
      ([sql]) =>
        sql.includes("AS MATERIALIZED") &&
        /ORDER BY (id|"receiptId"|"sourceId") LIMIT \$2::int/.test(sql),
    ),
  ).toBe(true);
  expect(
    pages.some(([, cursor, size]) => cursor === id(64) && size === 32),
  ).toBe(true);
  const allSql = pages.map(([sql]) => sql).join("\n");
  for (const marker of [
    "captureKind",
    "scalarReconciliationCheckId",
    "reconciliationCheckId",
    'c."assessmentId"=a.id',
    'c."customerId"=a."customerId"',
    'c."projectId"=a."projectId"',
    'c."factId"=a."factId"',
  ])
    expect(allSql).toContain(marker);
});

it.each([false, null, undefined, "true"])(
  "rejects non-true native proof result %s",
  async (valid) => {
    await expect(
      verifyRestoredProofIntegrity(
        fixture((rows) => rows.map((row) => ({ ...row, valid }))),
      ),
    ).rejects.toThrow();
  },
);
it("rejects a skipped row even when the page's proofs are valid", async () => {
  await expect(
    verifyRestoredProofIntegrity(
      fixture((rows, table, cursor) =>
        table === "FactAuthorityConflict" && cursor === id(32)
          ? rows.slice(1)
          : rows,
      ),
    ),
  ).rejects.toThrow("Incomplete");
});
it("rejects an early empty page", async () => {
  await expect(
    verifyRestoredProofIntegrity(
      fixture((rows, _, cursor) => (cursor ? [] : rows)),
    ),
  ).rejects.toThrow("Incomplete");
});
it("rejects a repeated page rather than looping or counting a duplicate", async () => {
  await expect(
    verifyRestoredProofIntegrity(
      fixture((rows, _, cursor) =>
        cursor ? [{ id: cursor, valid: true }] : rows,
      ),
    ),
  ).rejects.toThrow("did not advance");
});
it("rejects a reordered page", async () => {
  await expect(
    verifyRestoredProofIntegrity(
      fixture((rows, table) =>
        table === "FactAuthorityConflict" ? rows.toReversed() : rows,
      ),
    ),
  ).rejects.toThrow("did not advance");
});
it("rejects a malformed ID", async () => {
  await expect(
    verifyRestoredProofIntegrity(
      fixture((rows) => rows.map((row) => ({ ...row, id: "invalid" }))),
    ),
  ).rejects.toThrow();
});
it("rejects conflict revision gaps after every row predicate passed", async () => {
  const db = fixture();
  const query = db.$queryRawUnsafe;
  await expect(
    verifyRestoredProofIntegrity({
      $queryRawUnsafe: (sql: string, ...args: any[]) =>
        sql.includes("HAVING count(*)<>max(revision)")
          ? Promise.resolve([{ invalid: 1 }])
          : query(sql, ...(args as [string | null, number])),
    }),
  ).rejects.toThrow("revision gaps");
});
it.each([[{missing_csv_heads:1}],[{missing_csv_heads:null}],[],[{missing_csv_heads:0},{missing_csv_heads:0}]].map((rows)=>({rows})))(
  "rejects a missing required head or malformed native coverage result",async({rows})=>{
    await expect(verifyRequiredCsvHeads({$queryRawUnsafe:async()=>rows})).rejects.toThrow("missing its required comparison head");
  });
