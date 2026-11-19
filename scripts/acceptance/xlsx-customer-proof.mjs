// EXEC-045 disposable database owner fixture and independent receipt verification.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { loadDatabaseConfig } from "../../packages/platform/dist/index.js";
import { assertXlsxPreviewIntegrity } from "../../packages/operations/dist/xlsx-genesis-integrity.js";
import { Pool, secret } from "./common.mjs";
import { proveXlsxSourceGenesis } from "./xlsx-source-genesis.mjs";

const env = process.env;
const customerId = "10000000-0000-4000-8000-000000000002";
const profiles = ["portable-v1", "excel-text-v1"];
const command = "fixture-packaged-xlsx-preview";
const profile = env.PDAA_CUSTOMER_PROFILE;
assert(["bundled", "external"].includes(profile));
assert.equal(env.PDAA_ACCEPTANCE, "customer-composition");
assert.equal(env.NODE_ENV, "production");
assert.equal(env.DEPLOYMENT_MODE, "customer");
assert.equal(env.DATA_MODE, "customer");
assert.match(env.PDAA_ACCEPTANCE_RUN_ID, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/u);
assert.equal(env.CUSTOMER_ID, customerId);
assert.equal(env.PDAA_DB_NAME, "pdaa");
assert.equal(
  env.PDAA_DB_HOST,
  profile === "bundled" ? "database" : "external-database",
);
assert.equal(env.PDAA_DB_USER, "postgres");
assert.equal(env.PDAA_DB_PASSWORD_FILE, "/run/secrets/admin-password");
assert.equal(secret("customer-ready"), "isolated customer composition\n");
const pool = new Pool(loadDatabaseConfig(env));
const phase = process.argv[2];

async function cases() {
  const { rows } = await pool.query(
    `SELECT h."sourceId",r."projectId",r.subject,c.mapping->>'parserContract' AS profile
     FROM public."IngestionXlsxHead" h JOIN public."IngestionConfigurationReader" r
       ON r."customerId"=h."customerId" AND r."sourceId"=h."sourceId" AND r."configRevision"=1
     JOIN public."IngestionConfigurationRevision" c
       ON c."customerId"=h."customerId" AND c."sourceId"=h."sourceId" AND c.revision=1
     WHERE h."customerId"=$1 AND c.mapping->>'sheet'='Portfolio'
     ORDER BY c.mapping->>'parserContract'`,
    [customerId],
  );
  assert.deepEqual(rows.map((row) => row.profile).sort(), [...profiles].sort());
  return rows;
}

async function canonicalDigest() {
  const {
    rows: [row],
  } = await pool.query(
    `SELECT jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM public."ProjectFact" f WHERE f."customerId"=$1),
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public."ProjectFactVersion" v WHERE v."customerId"=$1))::text AS state`,
    [customerId],
  );
  return createHash("sha256").update(row.state).digest("hex");
}

async function prepare() {
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM public."Customer"'))
      .rows[0].n,
    0,
  );
  await pool.query('INSERT INTO public."Customer" (id,name) VALUES ($1,$2)', [
    customerId,
    env.CUSTOMER_NAME,
  ]);
  for (const parserContract of profiles)
    await proveXlsxSourceGenesis(pool, {
      retain: true,
      existingCustomer: customerId,
      sheet: "Portfolio",
      parserContract,
    });
  const bindings = await cases();
  const { projectId } = bindings[0];
  const actor = "synthetic-workbook-retention";
  const audit = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL ROLE pdaa_migrate");
    await client.query(
      `INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role)
      VALUES ($1,$2,$3,'project',$4,'system_admin')`,
      [randomUUID(), customerId, actor, projectId],
    );
    const at = new Date();
    await client.query(
      `INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
      VALUES ($1,$2,$3,'ingestion.retention.changed',$4,$5,$6)`,
      [
        audit,
        customerId,
        actor,
        randomUUID(),
        at,
        { retentionHours: 24, revision: 1 },
      ],
    );
    await client.query(
      `INSERT INTO public."IngestionRetentionPolicy" ("customerId","retentionHours",revision,"changedBy","auditEventId","changedAt")
      VALUES ($1,24,1,$2,$3,$4)`,
      [customerId, actor, audit, at],
    );
    await client.query("COMMIT");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
  return { bindings, canonicalSha256: await canonicalDigest() };
}

async function verify(expected) {
  assert.match(expected.canonicalSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    expected.results.map((result) => result.profile).sort(),
    [...profiles].sort(),
  );
  await assertXlsxPreviewIntegrity(pool);
  assert.equal(await canonicalDigest(), expected.canonicalSha256);
  for (const { profile, sourceId } of await cases()) {
    const wanted = expected.results.find(
      (result) => result.profile === profile,
    );
    const { rows } = await pool.query(
      `SELECT r.id::text AS "receiptId",x."workbookSha256",x.revision,o.operation,p."factTypes"
       FROM public."IngestionOperationReceipt" r JOIN public."IngestionXlsxContext" x ON x."receiptId"=r.id
       JOIN public."IngestionRowOutcome" o ON o."receiptId"=r.id
       JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
       WHERE r."customerId"=$1 AND r."sourceId"=$2 AND r."commandKey"=$3 ORDER BY o.ordinal`,
      [customerId, sourceId, command],
    );
    assert.deepEqual(
      rows,
      Array.from({ length: 2 }, () => ({
        receiptId: wanted.receiptId,
        workbookSha256: wanted.workbookSha256,
        revision: 1,
        operation: "CREATE",
        factTypes: ["project.forecast", "project.status"],
      })),
    );
  }
  return {
    proposalsOnly: true,
    canonicalStateUnchanged: true,
    verifiedContexts: 2,
  };
}

try {
  assert(["prepare", "verify"].includes(phase));
  const result =
    phase === "prepare"
      ? await prepare()
      : await verify(JSON.parse(process.argv[3]));
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  await pool.end();
}
