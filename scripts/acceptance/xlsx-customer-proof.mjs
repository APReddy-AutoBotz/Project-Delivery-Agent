// EXEC-045 disposable database owner fixture and independent receipt verification.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { loadDatabaseConfig } from "../../packages/platform/dist/index.js";
import {
  assertXlsxPreviewIntegrity,
  assertXlsxReviewedImportIntegrity,
} from "../../packages/operations/dist/xlsx-genesis-integrity.js";
import { xlsxReceiptReadApi, xlsxReviewDetailsApi } from "../../packages/operations/dist/business-grants.js";
import { Pool, secret } from "./common.mjs";
import { proveXlsxSourceGenesis } from "./xlsx-source-genesis.mjs";

const env = process.env;
const customerId = "10000000-0000-4000-8000-000000000002";
const customerName = "Controlled customer installation";
const profiles = ["portable-v1", "excel-text-v1"];
const command = "fixture-packaged-xlsx-preview";
const bridgeSubject = "synthetic-workbook-pmo";
const browserSubject = "pmo-atlas";
const restoreDatabase = "pdaa_xlsx_restore";
const phase = process.argv[2];
let pool;
let step = "environment";

async function cases() {
  const { rows } = await pool.query(
    `SELECT h."sourceId",r."projectId",r.subject,c.mapping->>'parserContract' AS profile
     FROM public."IngestionXlsxHead" h JOIN public."IngestionConfigurationReader" r
       ON r."customerId"=h."customerId" AND r."sourceId"=h."sourceId" AND r."configRevision"=1
     JOIN public."IngestionConfigurationRevision" c
       ON c."customerId"=h."customerId" AND c."sourceId"=h."sourceId" AND c.revision=1
     WHERE h."customerId"=$1 AND r.subject=$2 AND c.mapping->>'sheet'='Portfolio'
     ORDER BY c.mapping->>'parserContract'`,
    [customerId, bridgeSubject],
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
  step = "provisioned-customer";
  const { rows: databases } = await pool.query(
    `SELECT shobj_description(oid,'pg_database') AS marker
     FROM pg_database WHERE datname=current_database()`,
  );
  assert.deepEqual(databases, [{ marker: `pdaa.foundation.v1:${customerId}` }]);
  const { rows: customers } = await pool.query(
    'SELECT id::text AS id,name FROM public."Customer"',
  );
  assert.deepEqual(customers, [{ id: customerId, name: customerName }]);
  const { rows: projectState } = await pool.query(
    `SELECT NOT EXISTS (SELECT 1 FROM public."Portfolio")
      AND NOT EXISTS (SELECT 1 FROM public."Project")
      AND NOT EXISTS (SELECT 1 FROM public."IngestionSource") AS empty`,
  );
  assert.deepEqual(projectState, [{ empty: true }]);

  step = "source-genesis";
  for (const parserContract of profiles)
    await proveXlsxSourceGenesis(pool, {
      retain: true,
      existingCustomer: customerId,
      sheet: "Portfolio",
      parserContract,
      reviewer: browserSubject,
    });
  const bindings = await cases();
  step = "retention-fixture";
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
  step = "receipt-verification";
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
    const { rows: state } = await pool.query(
      `SELECT h.revision,h."currentReceiptId"::text AS "receiptId",
         (SELECT count(*)::int FROM public."IngestionXlsxContext" x
          WHERE x."customerId"=h."customerId" AND x."sourceId"=h."sourceId") AS contexts,
         (SELECT count(*)::int FROM public."IngestionOperationReceipt" r
          WHERE r."customerId"=h."customerId" AND r."sourceId"=h."sourceId"
            AND r.kind='XLSX_PREVIEW') AS receipts
       FROM public."IngestionXlsxHead" h WHERE h."customerId"=$1 AND h."sourceId"=$2`,
      [customerId, sourceId],
    );
    assert.deepEqual(state, [
      { revision: 1, receiptId: wanted.receiptId, contexts: 1, receipts: 1 },
    ]);
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

async function verifyBrowser(expected) {
  step = "browser-receipt-verification";
  assert.match(expected.canonicalSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(expected.results.map(({ profile }) => profile).sort(), [...profiles].sort());
  assert.deepEqual(expected.bridge.map(({ profile }) => profile).sort(), [...profiles].sort());
  await assertXlsxPreviewIntegrity(pool);
  await assertXlsxReviewedImportIntegrity(pool);
  assert.equal(await canonicalDigest(), expected.canonicalSha256);
  for (const { profile, sourceId, projectId } of await cases()) {
    const wanted = expected.results.find((result) => result.profile === profile);
    const predecessor = expected.bridge.find((result) => result.profile === profile);
    assert.equal(wanted.sourceId, sourceId);
    assert.match(wanted.workbookSha256, /^[a-f0-9]{64}$/u);
    assert.match(wanted.previewContextSha256, /^[a-f0-9]{64}$/u);
    const { rows: contexts } = await pool.query(
      `SELECT x."receiptId",x."predecessorReceiptId",x."workbookSha256",x."contextSha256",
         x.revision,r.subject,r."outcomeCount",r."executionMode",
         (SELECT count(*)::int FROM public."IngestionXlsxContext" c
          WHERE c."customerId"=h."customerId" AND c."sourceId"=h."sourceId") AS contexts,
         (SELECT count(*)::int FROM public."IngestionOperationReceipt" p
          WHERE p."customerId"=h."customerId" AND p."sourceId"=h."sourceId"
            AND p.kind='XLSX_PREVIEW') AS previews
       FROM public."IngestionXlsxHead" h
       JOIN public."IngestionXlsxContext" x ON x."customerId"=h."customerId"
         AND x."sourceId"=h."sourceId" AND x."receiptId"=h."currentReceiptId" AND x.revision=h.revision
       JOIN public."IngestionOperationReceipt" r ON r."customerId"=x."customerId"
         AND r."sourceId"=x."sourceId" AND r.id=x."receiptId" AND r.kind='XLSX_PREVIEW'
       WHERE h."customerId"=$1 AND h."sourceId"=$2`,
      [customerId, sourceId],
    );
    assert.deepEqual(contexts, [{
      receiptId: wanted.previewReceiptId,
      predecessorReceiptId: predecessor.receiptId,
      workbookSha256: wanted.workbookSha256,
      contextSha256: wanted.previewContextSha256,
      revision: 2,
      subject: browserSubject,
      outcomeCount: 52,
      executionMode: "HUMAN",
      contexts: 2,
      previews: 2,
    }]);
    const { rows: reviews } = await pool.query(
      `SELECT i."receiptId",i."previewReceiptId",r.subject,r."outcomeCount",r."executionMode",
         (SELECT array_agg(s."previewOrdinal" ORDER BY s.ordinal) FROM public."IngestionReviewedImportRow" s
          WHERE s."customerId"=i."customerId" AND s."sourceId"=i."sourceId"
            AND s."receiptId"=i."receiptId" AND s."previewReceiptId"=i."previewReceiptId") AS selected,
         (SELECT array_agg(o."projectId" ORDER BY o.ordinal) FROM public."IngestionRowOutcome" o
          WHERE o."customerId"=i."customerId" AND o."sourceId"=i."sourceId"
            AND o."receiptId"=i."receiptId" AND o.state='ACCEPTED' AND o."projectionId" IS NOT NULL) AS projects,
         (SELECT count(*)::int FROM public."IngestionRowOutcome" o
          JOIN public."IngestionProposalContent" c ON c."customerId"=o."customerId" AND c."projectionId"=o."projectionId"
          WHERE o."customerId"=i."customerId" AND o."sourceId"=i."sourceId"
            AND o."receiptId"=i."receiptId" AND c.proposals IS NOT NULL) AS retained
       FROM public."IngestionOperationReceipt" r
       JOIN public."IngestionReviewedImport" i ON i."customerId"=r."customerId"
         AND i."sourceId"=r."sourceId" AND i."receiptId"=r.id
       WHERE r."customerId"=$1 AND r."sourceId"=$2 AND r.kind='XLSX_REVIEWED_IMPORT'`,
      [customerId, sourceId],
    );
    assert.deepEqual(reviews, [{
      receiptId: wanted.reviewedReceiptId,
      previewReceiptId: wanted.previewReceiptId,
      subject: browserSubject,
      outcomeCount: 2,
      executionMode: "HUMAN",
      selected: [1, 51],
      projects: [projectId, projectId],
      retained: 2,
    }]);
  }
  return { canonicalStateUnchanged: true, verifiedReviewedImports: profiles.length };
}

async function verifyRestoredBrowser(expected) {
  step = "restore-quarantine";
  const { rows } = await pool.query(
    `SELECT current_database() AS database, shobj_description(oid,'pg_database') AS marker,
       has_database_privilege('pdaa_api',oid,'CONNECT') AS api,
       has_database_privilege('pdaa_worker',oid,'CONNECT') AS worker,
       has_database_privilege('pdaa_backup',oid,'CONNECT') AS backup
     FROM pg_database WHERE datname=current_database()`,
  );
  assert.deepEqual(rows, [{
    database: restoreDatabase, marker: "pdaa.restore.quarantine.v1:" + customerId,
    api: false, worker: false, backup: true,
  }]);
  const { rows: readers } = await pool.query(
    `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
       ARRAY(SELECT a.grantee::regrole::text FROM aclexplode(p.proacl) a
         WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE' ORDER BY a.grantee) AS executors,
       EXISTS(SELECT 1 FROM aclexplode(p.proacl) a
         WHERE a.grantee<>p.proowner AND a.is_grantable) AS grantable
     FROM unnest($1::text[]) AS wanted(signature)
     JOIN pg_proc p ON p.oid=to_regprocedure(wanted.signature)`,
    [[xlsxReceiptReadApi, xlsxReviewDetailsApi]],
  );
  assert.deepEqual(readers, Array.from({ length: 2 }, () => ({
    owner: "pdaa_migrate", definer: true, executors: ["pdaa_api"], grantable: false,
  })));
  return { ...await verifyBrowser(expected), quarantined: true, finiteReceiptReadGrants: true };
}

try {
  const profile = env.PDAA_CUSTOMER_PROFILE;
  assert(["prepare", "verify", "verify-browser", "create-restore-target", "verify-restored-browser"].includes(phase));
  assert(["bundled", "external"].includes(profile));
  assert.equal(env.PDAA_ACCEPTANCE, "customer-composition");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.DEPLOYMENT_MODE, "customer");
  assert.equal(env.DATA_MODE, "customer");
  assert.match(env.PDAA_ACCEPTANCE_RUN_ID, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/u);
  assert.equal(env.CUSTOMER_ID, customerId);
  assert.equal(env.CUSTOMER_NAME, customerName);
  assert.equal(env.PDAA_DB_NAME, "pdaa");
  assert.equal(
    env.PDAA_DB_HOST,
    profile === "bundled" ? "database" : "external-database",
  );
  assert.equal(env.PDAA_DB_USER, "postgres");
  assert.equal(env.PDAA_DB_PASSWORD_FILE, "/run/secrets/admin-password");
  assert.equal(secret("customer-ready"), "isolated customer composition\n");
  const database = loadDatabaseConfig(env).database;
  pool = new Pool(phase === "verify-restored-browser" ? { ...database, database: restoreDatabase } : database);
  let result;
  if (phase === "create-restore-target") {
    step = "restore-target";
    await pool.query("CREATE DATABASE pdaa_xlsx_restore TEMPLATE template0");
    result = { restoreTargetCreated: true };
  } else if (phase === "prepare") {
    result = await prepare();
  } else {
    const check = { verify, "verify-browser": verifyBrowser, "verify-restored-browser": verifyRestoredBrowser }[phase];
    result = await check(JSON.parse(process.argv[3]));
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("XLSX_CUSTOMER_PROOF_FAILED " + step + "\n");
  process.exitCode = 1;
} finally {
  await pool?.end();
}
