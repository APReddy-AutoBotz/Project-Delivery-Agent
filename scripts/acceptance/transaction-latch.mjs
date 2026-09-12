import assert from "node:assert/strict";

// FR-EVD-012 / NFR-REL-001: observe the repository's own transaction. Never nest
// it in a test transaction or replace its production timeout/isolation options.
export function observeTransactions(database, { started, beforeCommit } = {}) {
  return new Proxy(database, {
    get(target, property) {
      if (property === "$transaction")
        return (callback, options) =>
          target.$transaction(async (tx) => {
            const [session] =
              await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid, current_user AS role`;
            assert.equal(session.role, "pdaa_api");
            started?.(session.pid);
            const result = await callback(tx);
            await beforeCommit?.(session.pid);
            return result;
          }, options);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function waitForTransactionBlockers(
  observer,
  holderPid,
  contenders,
) {
  const deadline = Date.now() + 3000;
  const query = async (text, values) => {
    const remaining = Math.max(1, deadline - Date.now());
    let timer;
    try {
      return await Promise.race([
        observer.query({ text, values, query_timeout: remaining }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Lock observer exceeded the latch budget")),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt += 1) {
    const pids = contenders.map((item) => item.pid);
    if (pids.every(Number.isInteger) && new Set(pids).size === pids.length) {
      const rows = (
        await query(
          `WITH RECURSIVE chain(start,pid,path) AS (
          SELECT p,p,ARRAY[p] FROM unnest($1::int[]) p
          UNION ALL
          SELECT chain.start,b.pid,chain.path||b.pid FROM chain
          CROSS JOIN LATERAL unnest(pg_blocking_pids(chain.pid)) b(pid)
          WHERE b.pid=ANY($2::int[]) AND NOT b.pid=ANY(chain.path)
            AND cardinality(chain.path)<4
        )
        SELECT a.pid,a.application_name AS tag FROM pg_stat_activity a
        WHERE a.datname=current_database() AND a.usename='pdaa_api'
          AND a.pid=ANY($1::int[]) AND a.state='active' AND a.wait_event_type='Lock'
          AND EXISTS (SELECT 1 FROM chain WHERE chain.start=a.pid AND chain.pid=$3)`,
          [pids, [holderPid, ...pids], holderPid],
        )
      ).rows;
      if (
        rows.length === contenders.length &&
        contenders.every((item) =>
          rows.some((row) => row.pid === item.pid && row.tag === item.tag),
        )
      )
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Expected exact API transactions did not reach the lock holder",
  );
}
