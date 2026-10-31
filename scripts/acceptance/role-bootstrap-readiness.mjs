import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

// Only the read-only startup probe is retried. The caller starts the actual
// role/migration checks after this function returns and must not retry them.
export async function waitForRoleBootstrapReadiness(probe, options = {}) {
  const { timeoutMs = 60_000, intervalMs = 500, now = () => performance.now(), pause = sleep } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0)
    throw new Error("Invalid role bootstrap readiness bounds");
  const deadline = now() + timeoutMs;
  for (;;) {
    const budget = deadline - now();
    if (budget <= 0) throw new Error("Fresh isolated PostgreSQL TCP readiness deadline");
    const result = await probe(Math.min(2500, budget));
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Fresh isolated PostgreSQL TCP readiness deadline");
    if (result === "ready") return;
    if (result === "mismatch") throw new Error("Fresh isolated PostgreSQL identity mismatch");
    if (result !== "unavailable") throw new Error("Fresh isolated PostgreSQL readiness check failed");
    await pause(Math.min(intervalMs, remaining));
    if (now() >= deadline) throw new Error("Fresh isolated PostgreSQL TCP readiness deadline");
  }
}

// Each attempt owns a fresh client. On timeout the owned socket is destroyed;
// promise failures and EventEmitter errors are consumed without logging secrets.
export async function probeRoleBootstrapEndpoint(Client, connectionString, timeoutMs) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 1000, query_timeout: 1000 });
  let mismatch = false;
  let failure = false;
  let emittedError = false;
  client.on("error", () => { emittedError = true; });
  const work = (async () => {
    let result = "unavailable";
    try {
      await client.connect();
      const rows = (await client.query("SELECT current_database() AS database, current_user AS username")).rows;
      mismatch = rows.length !== 1 || rows[0].database !== "postgres" || rows[0].username !== "pdaa";
      result = mismatch ? "mismatch" : emittedError ? "unavailable" : "ready";
    } catch (error) {
      const code = error?.code;
      const message = error?.message;
      result = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "57P01", "57P03"].includes(code)
        || ["Connection terminated unexpectedly", "Connection terminated due to connection timeout", "timeout expired", "Query read timeout"].includes(message)
        ? "unavailable" : "failure";
      failure = result === "failure";
    }
    try { await client.end(); } catch { if (!mismatch) { result = "failure"; failure = true; } }
    if (mismatch) return "mismatch";
    return emittedError && result === "ready" ? "unavailable" : result;
  })();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      let destroyFailed = false;
      try { client.connection.stream.destroy(); } catch { destroyFailed = true; }
      resolve(mismatch ? "mismatch" : failure || destroyFailed ? "failure" : "unavailable");
    }, timeoutMs);
  });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); }
}

export async function runRoleBootstrapWhenReady(probe, acceptance, options = {}) {
  await waitForRoleBootstrapReadiness(probe, options);
  return acceptance();
}

export async function runWithOwnedCleanup(run, cleanup, reportCleanupFailure) {
  let primaryFailed = false;
  try { return await run(); }
  catch (error) { primaryFailed = true; throw error; }
  finally {
    try { await cleanup(); }
    catch (error) {
      if (!primaryFailed) throw error;
      try { reportCleanupFailure(); } catch { /* Preserve the original failure. */ }
    }
  }
}
