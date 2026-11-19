// FR-CON-006/007/012 / NFR-SEC-001: applied migration-29 serializer proof.
// Keep the existing guarded entry point; missing definitions fail with no DDL fallback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { assertBusinessTableInventory } from "./upgrade-inventory-receipt.mjs";
import { csvComparisonFunctions, csvComparisonApiFunctions } from "./csv-comparison-privileges.mjs";
import {
  csvPositiveVectors,
  csvNativeCorruptions,
  csvNativeCastDenials,
  csvStateVector,
} from "./csv-comparison-vectors.mjs";

const migrationUrl = new URL(
  "../../packages/data/prisma/migrations/",
  import.meta.url,
);
const signatures = [
  "public.valid_ingestion_csv_state(uuid,uuid,integer,jsonb,jsonb)",
  "public.ingestion_csv_state_text(uuid,uuid,integer,jsonb,jsonb)",
];
const privateCsvFunctions = csvComparisonFunctions.filter((signature) => !csvComparisonApiFunctions.includes(signature));
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function assertCsvPrototypeTarget(
  databaseUrl,
  environment = process.env,
) {
  let url;
  try {
    if (typeof databaseUrl !== "string") throw new Error();
    url = new URL(databaseUrl);
  } catch {
    throw new Error("CSV_PROTOTYPE_TARGET_REFUSED");
  }
  if (
    environment.DATA_MODE !== "synthetic" ||
    environment.NODE_ENV === "production" ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/pdaa_test_[0-9]{1,53}$/.test(url.pathname) ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error("CSV_PROTOTYPE_TARGET_REFUSED");
  return url.pathname.slice(1);
}
function realPool(options) {
  const { Pool } = createRequire(
    new URL("../../packages/data/package.json", import.meta.url),
  )("pg");
  return new Pool(options);
}
function safeFailure(stage, error) {
  return Object.freeze({
    stage,
    ...(typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
      ? { sqlstate: error.code }
      : {}),
    ...(typeof error?.position === "string" &&
    /^[1-9][0-9]{0,6}$/.test(error.position)
      ? { position: Number(error.position) }
      : {}),
  });
}
async function endPool(pool) {
  let timer;
  try {
    await Promise.race([
      pool.end(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("POOL_END_TIMEOUT")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function snapshot(client) {
  const ledger = (
    await client.query(`SELECT id,migration_name,checksum,finished_at,
    rolled_back_at,applied_steps_count,started_at,logs FROM public._prisma_migrations
    ORDER BY migration_name,id`)
  ).rows;
  const tables = (
    await client.query(`SELECT c.oid::text AS oid,c.relname,c.relkind,c.relowner::text AS owner,
    c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text AS acl,
    (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,
      a.attidentity,a.attgenerated,a.attcollation::text,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE "C"`)
  ).rows;
  return { ledger, tables };
}
async function assertApplied(client) {
  const result = await client.query(
    "SELECT to_regprocedure($1)::text AS a,to_regprocedure($2)::text AS b",
    signatures,
  );
  assert.equal(result.rows.length,1);
  assert.equal(typeof result.rows[0].a,"string","Applied CSV validator missing");
  assert.equal(typeof result.rows[0].b,"string","Applied CSV serializer missing");
}
function assertReleasedSnapshot(before) {
  const names = readdirSync(migrationUrl, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.equal(names.length, 34);
  assert.equal(names[28], "202611180001_csv_comparison_validation_cost");
  assert.equal(before.ledger.length, names.length);
  for (const [i, name] of names.entries()) {
    assert.match(name, /^[0-9]{12}(?:[0-9]{2})?_[a-z0-9_]+$/);
    const row = before.ledger[i];
    assert.equal(row.migration_name, name);
    assert.equal(
      row.checksum,
      digest(readFileSync(new URL(name + "/migration.sql", migrationUrl))),
    );
    assert(
      row.finished_at && !row.rolled_back_at && row.applied_steps_count === 1,
    );
  }
  assert.equal(before.tables.length, 90);
  assert(before.tables.some((t) => t.relname === "_prisma_migrations"));
  assertBusinessTableInventory(
    before.tables
      .filter((t) => t.relname !== "_prisma_migrations")
      .map((t) => t.relname),
  );
}
const nativeQuery = `SELECT public.valid_ingestion_csv_state($1::uuid,$2::uuid,$3::integer,$4::jsonb,$5::jsonb) AS valid,
  public.ingestion_csv_state_text($1::uuid,$2::uuid,$3::integer,$4::jsonb,$5::jsonb) AS text`;
const parameters = (state) => [
  state[1],
  state[2],
  state[3],
  JSON.stringify(state[4]) ?? null,
  JSON.stringify(state[5]) ?? null,
];
async function deniedStatement(client, query, values, expected) {
  await client.query("SAVEPOINT csv_prototype_denial");
  let sqlstate;
  try {
    await client.query(query, values);
  } catch (error) {
    sqlstate = error?.code;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT csv_prototype_denial");
    await client.query("RELEASE SAVEPOINT csv_prototype_denial");
  }
  assert.equal(sqlstate, expected);
}
async function checkMetadata(client) {
  const rows = (
    await client.query(
      `SELECT p.proname,pg_get_userbyid(p.proowner)=current_user AS owner,
    p.prosecdef,p.provolatile,p.proconfig,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
    has_function_privilege('pdaa_api',p.oid,'EXECUTE') AS api_execute,
    has_function_privilege('pdaa_worker',p.oid,'EXECUTE') AS worker_execute,
    has_function_privilege('pdaa_backup',p.oid,'EXECUTE') AS backup_execute
    FROM pg_proc p WHERE p.oid IN (to_regprocedure($1),to_regprocedure($2)) ORDER BY p.proname`,
      signatures,
    )
  ).rows;
  assert.equal(rows.length, 2);
  for (const [i, row] of rows.entries()) {
    assert.equal(
      row.proname,
      i === 0 ? "ingestion_csv_state_text" : "valid_ingestion_csv_state",
    );
    assert.equal(row.owner, true);
    assert.equal(row.prosecdef, false);
    assert.equal(row.provolatile, "i");
    assert.deepEqual(
      row.proconfig?.map((s) => s.replaceAll(" ", "")),
      ["search_path=pg_catalog,public"],
    );
    for (const key of [
      "public_execute",
      "worker_execute",
      "backup_execute",
    ])
      assert.equal(row[key], false);
    assert.equal(row.api_execute,true);
  }
  await client.query("SAVEPOINT csv_prototype_role");
  try {
    await client.query("SET LOCAL ROLE pdaa_api");
    const controls = (
      await client.query(`SELECT current_user AS role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
      has_schema_privilege(current_user,'public','USAGE') AS usage`)
    ).rows[0];
    assert.deepEqual(controls, {
      role: "pdaa_api",
      superuser: false,
      usage: true,
    });
    const {serializeCsvComparisonState} = await import("../../packages/domain/dist/csv-comparison-state.js");
    assert.deepEqual((await client.query(nativeQuery,parameters(csvStateVector()))).rows,
      [{valid:true,text:serializeCsvComparisonState(csvStateVector()).text}]);
    for (const signature of privateCsvFunctions)
      await deniedStatement(client,"SELECT public."+signature,[],"42501");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT csv_prototype_role");
    await client.query("RELEASE SAVEPOINT csv_prototype_role");
  }
}

export async function verifyCsvComparisonPrototype(
  databaseUrl,
  { environment = process.env, poolFactory = realPool } = {},
) {
  // No pool, URL-bearing driver error or DDL is reachable before this guard.
  const databaseName = assertCsvPrototypeTarget(databaseUrl, environment);
  let stage = "pool",
    pool,
    client,
    before,
    receipt,
    primary,
    clientFailure;
  let beginAttempted = false,
    idleFailure = false;
  const cleanup = [];
  try {
    stage = "pool";
    pool = poolFactory({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 20000,
      idleTimeoutMillis: 5000,
      options:
        "-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000",
    });
    pool.on("error", () => {
      idleFailure = true;
    });
    stage = "connect";
    client = await pool.connect();
    // pg-pool removes its idle error handler when handing out a client. Keep
    // checked-out socket errors inside the same finite, non-logging boundary.
    client.on("error", (error) => {
      clientFailure ??= safeFailure("owned-client-error", error);
    });
    stage = "actual-target";
    assert.equal(
      (await client.query("SELECT current_database() AS name")).rows[0]?.name,
      databaseName,
    );
    stage = "applied-schema";
    before = await snapshot(client);
    assertReleasedSnapshot(before);
    await assertApplied(client);
    stage = "begin";
    beginAttempted = true;
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='15s'");
    stage = "applied-definitions";
    await checkMetadata(client);
    const { serializeCsvComparisonState } = await import(
      "../../packages/domain/dist/csv-comparison-state.js"
    );
    const positives = csvPositiveVectors();
    const vectorReceipts = [];
    for (const vector of positives) {
      stage = "positive-" + vector.name;
      const result = (await client.query(nativeQuery, parameters(vector.state)))
        .rows[0];
      const canonical = serializeCsvComparisonState(vector.state);
      assert.equal(result.valid, true);
      assert.equal(result.text, canonical.text);
      const bytes = Buffer.byteLength(result.text, "utf8");
      const hash = digest(result.text);
      if (vector.bytes !== undefined) assert.equal(bytes, vector.bytes);
      if (vector.digest !== undefined) assert.equal(hash, vector.digest);
      vectorReceipts.push({ name: vector.name, bytes, digest: hash });
    }
    const corruptions = csvNativeCorruptions();
    for (const { name, state } of corruptions) {
      stage = "denial-" + name;
      // Deliberately bypass the TypeScript validator: PostgreSQL must reject.
      assert.deepEqual(
        (await client.query(nativeQuery, parameters(state))).rows,
        [{ valid: false, text: null }],
      );
    }
    stage = "typed-normalization";
    const normalized = csvStateVector();
    normalized[1] = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    const spelling = globalThis.structuredClone(normalized);
    spelling[1] = "{ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF}";
    spelling[3] = "0001";
    assert.deepEqual(
      (await client.query(nativeQuery, parameters(spelling))).rows,
      [{ valid: true, text: serializeCsvComparisonState(normalized).text }],
    );
    const casts = csvNativeCastDenials();
    for (const { name, state, sqlstate } of casts) {
      stage = "cast-" + name;
      await deniedStatement(client, nativeQuery, parameters(state), sqlstate);
    }
    receipt = {
      scope: "APPLIED_MIGRATION_29",
      migrationChecksum: before.ledger[28].checksum,
      vectors: vectorReceipts,
      nativeGrammarDenials: corruptions.length,
      nativeCastDenials: casts.length,
      typedNormalizationChecks: 1,
      canonicalParity: true,
      maximumBytes: 1614668,
      canonicalByteLimit: 2097152,
      structuralMaximumBelowByteLimit: true,
      invokerImmutableFixedPath: true,
      ownerIsMigrationSession: true,
      publicWorkerBackupExecuteDenied: true,
      actualApiRolePositive: true,
      privateApiGuardDenials: privateCsvFunctions.length,
      migrations: before.ledger.length,
      businessTables: 89,
    };
  } catch (error) {
    primary = safeFailure(stage, error);
  } finally {
    if (client) {
      try {
        if (beginAttempted) {
          try {
            await client.query("ROLLBACK");
          } catch (error) {
            cleanup.push(safeFailure("rollback", error));
          }
        }
        if (before) {
          try {
            await assertApplied(client);
            assert.deepEqual(await snapshot(client), before);
          } catch (error) {
            cleanup.push(safeFailure("rollback-verification", error));
          }
        }
      } finally {
        try {
          client.release(
            Boolean(primary || cleanup.length || clientFailure || idleFailure),
          );
        } catch (error) {
          cleanup.push(safeFailure("release", error));
        }
      }
    }
    if (pool) {
      try {
        await endPool(pool);
      } catch (error) {
        cleanup.push(safeFailure("pool-end", error));
      }
    }
    if (idleFailure) cleanup.push(safeFailure("pool-idle-error"));
    if (clientFailure) cleanup.push(clientFailure);
  }
  if (primary || cleanup.length) {
    const error = new Error("CSV_PROTOTYPE_VALIDATION_FAILED");
    error.name = "CsvPrototypeValidationError";
    error.failure = Object.freeze({
      ...(primary ? { primary } : {}),
      cleanup: Object.freeze(cleanup),
    });
    throw error;
  }
  return Object.freeze({
    ...receipt,
    rolledBack: true,
    appliedFunctionsRetained: true,
    ledgerAndTableMetadataUnchanged: true,
  });
}
