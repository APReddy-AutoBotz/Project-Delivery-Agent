// EXEC-045 native reviewed selection through the actual API database role.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseIngestionRepository,
} from "../../packages/data/dist/index.js";
import { CredentialVault } from "../../packages/platform/dist/index.js";
import {
  assertXlsxGenesisIntegrity,
  assertXlsxPreviewIntegrity,
  assertXlsxReviewedImportIntegrity,
} from "../../packages/operations/dist/xlsx-genesis-integrity.js";
import {
  xlsxReviewApiFunction,
  xlsxReviewFunctions,
} from "../../packages/operations/dist/business-grants.js";
import { proveXlsxSourceGenesis } from "./xlsx-source-genesis.mjs";

const sheet = "Portfolio Review";
const previewAuthor = "synthetic-workbook-pmo";
const reviewer = "synthetic-workbook-reviewer";

async function binding(pool) {
  const { rows } = await pool.query(
    `SELECT s."customerId",s.id AS "sourceId",p."projectId"
    FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" c
      ON c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=1
    JOIN public."IngestionConfigurationProject" p ON p."customerId"=c."customerId"
      AND p."sourceId"=c."sourceId" AND p."configRevision"=c.revision
    WHERE s."inputFamily"='XLSX' AND c.mapping->>'sheet'=$1`,
    [sheet],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function context(pool, receiptId) {
  const { rows } = await pool.query(
    'SELECT "contextSha256"::text AS hash FROM public."IngestionXlsxContext" WHERE "receiptId"=$1',
    [receiptId],
  );
  assert.equal(rows.length, 1);
  return rows[0].hash;
}

export async function verifyXlsxReviewPrivileges(pool) {
  for (const signature of xlsxReviewFunctions) {
    const { rows } = await pool.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner,
      ARRAY(SELECT a.grantee::regrole::text FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE' ORDER BY a.grantee) AS readers,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.is_grantable) AS grantable
      FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
      [signature],
    );
    assert.deepEqual(rows, [
      {
        owner: "pdaa_migrate",
        readers: signature === xlsxReviewApiFunction ? ["pdaa_api"] : [],
        grantable: false,
      },
    ]);
  }
}

async function state(pool, { customerId, sourceId }) {
  return (
    await pool.query(
      `SELECT
    (SELECT to_jsonb(h) FROM public."IngestionXlsxHead" h WHERE h."sourceId"=$1) AS head,
    (SELECT to_jsonb(s) FROM public."IngestionSource" s WHERE s.id=$1) AS source,
    ARRAY(SELECT c."contextSha256"::text FROM public."IngestionXlsxContext" c WHERE c."sourceId"=$1 ORDER BY c.revision) AS contexts,
    (SELECT count(*)::int FROM public."IngestionProposalProjection" WHERE "sourceId"=$1) AS projections,
    ARRAY(SELECT to_jsonb(f) FROM public."ProjectFact" f WHERE f."customerId"=$2 ORDER BY f.id) AS facts`,
      [sourceId, customerId],
    )
  ).rows[0];
}

export async function proveNativeXlsxReviewedImport(pool, apiConnection) {
  const customer = (
    await pool.query(
      'SELECT "customerId" FROM public."IngestionRetentionPolicy"',
    )
  ).rows[0]?.customerId;
  assert(customer);
  await proveXlsxSourceGenesis(pool, {
    retain: true,
    existingCustomer: customer,
    sheet,
    reviewer,
  });
  const source = await binding(pool);
  assert.equal(source.customerId, customer);
  const actor = (subject) => ({
    customerId: customer,
    subject,
    roles: ["pmo_admin"],
  });
  const ids = {
    sourceId: source.sourceId,
    configRevision: 1,
    mappingRevision: 1,
    sheet,
  };
  const db = createDatabase(apiConnection);
  const vault = new CredentialVault(Buffer.alloc(32, 34).toString("base64"));
  const repository = new DatabaseIngestionRepository(db, vault);
  const row = (key, text, project = source.projectId) => [
    key,
    project,
    text,
    "2027-04-01",
  ];
  const cases = [
    [row("Review-A", "Active"), row("Review-B", "Stable")],
    [
      row("Review-A", "Needs attention"),
      row("Review-B", "Stable"),
      row("Review-C", "New"),
      row("Review-D", "Unknown project", randomUUID()),
    ],
  ];
  const preview = (grid, key) =>
    new DatabaseIngestionRepository(db, vault, {
      tryAcquire: () => ({
        decode: async () => ({
          headers: ["Key", "Project", "Status", "Forecast"],
          rows: grid,
        }),
        release() {},
      }),
    }).persistXlsxPreview(
      actor(previewAuthor),
      { ...ids, commandKey: key },
      Buffer.from(key),
      randomUUID(),
    );
  const commit = (request, subject = reviewer) =>
    repository.commitXlsxReviewedImport(actor(subject), request, randomUUID());

  try {
    assert.deepEqual(await db.$queryRaw`SELECT session_user::text AS name`, [
      { name: "pdaa_api" },
    ]);
    await preview(cases[0], "fixture-review-baseline");
    const selected = await preview(cases[1], "fixture-review-preview");
    await preview(cases[1], "fixture-review-head-advance");
    const input = {
      sourceId: source.sourceId,
      previewReceiptId: selected.receiptId,
      previewContextSha256: await context(pool, selected.receiptId),
      rowOrdinals: [1, 2, 3],
      commandKey: "fixture-review-commit",
    };
    const before = await state(pool, source);
    await assert.rejects(commit({ ...input, rowOrdinals: [3, 1] }), {
      code: "INVALID_REQUEST",
    });
    await assert.rejects(commit({ ...input, rowOrdinals: [1, 4] }), {
      code: "INVALID_PREVIEW",
    });
    await assert.rejects(
      commit({ ...input, previewContextSha256: "0".repeat(64) }),
      { code: "INVALID_PREVIEW" },
    );
    await assert.rejects(commit(input, "unentitled-workbook-reviewer"), {
      code: "DENIED",
    });
    const failed = await pool.query(
      `SELECT count(*)::int AS receipts FROM public."IngestionOperationReceipt"
      WHERE "sourceId"=$1 AND kind='XLSX_REVIEWED_IMPORT'`,
      [source.sourceId],
    );
    assert.deepEqual(failed.rows, [{ receipts: 0 }]);
    const attempts = await Promise.all([commit(input), commit(input)]);
    assert.equal(attempts.filter(({ replayed }) => replayed).length, 1);
    const saved = attempts.find(({ replayed }) => !replayed);
    const replay = {
      receiptId: saved.receiptId,
      parentPreviewReceiptId: selected.receiptId,
      replayed: true,
      rowCount: 3,
    };
    assert.deepEqual(await commit(input), replay);
    await assert.rejects(commit({ ...input, rowOrdinals: [2, 3] }), {
      code: "CONFLICT",
    });
    await assert.rejects(
      commit({ ...input, commandKey: "fixture-review-another" }, previewAuthor),
      { code: "CONFLICT" },
    );
    const link = await pool.query(
      `SELECT r.subject,o.operation,l."previewOrdinal"
      FROM public."IngestionOperationReceipt" r JOIN public."IngestionRowOutcome" o ON o."receiptId"=r.id
      JOIN public."IngestionReviewedImportRow" l ON l."receiptId"=r.id AND l.ordinal=o.ordinal
      WHERE r.id=$1 ORDER BY o.ordinal`,
      [saved.receiptId],
    );
    assert.deepEqual(link.rows, [
      { subject: reviewer, operation: "UPDATE", previewOrdinal: 1 },
      { subject: reviewer, operation: "UNCHANGED", previewOrdinal: 2 },
      { subject: reviewer, operation: "CREATE", previewOrdinal: 3 },
    ]);
    const {
      rows: [grant],
    } = await pool.query(
      `SELECT id FROM public."AccessGrant"
      WHERE "customerId"=$1 AND subject=$2 AND "scopeId"=$3`,
      [customer, reviewer, source.projectId],
    );
    await pool.query(
      "UPDATE public.\"AccessGrant\" SET role='leadership' WHERE id=$1",
      [grant.id],
    );
    try {
      await assert.rejects(commit(input), { code: "DENIED" });
      await assert.rejects(commit({ ...input, rowOrdinals: [1] }), {
        code: "DENIED",
      });
    } finally {
      await pool.query(
        "UPDATE public.\"AccessGrant\" SET role='pmo_admin' WHERE id=$1",
        [grant.id],
      );
    }
    assert.deepEqual(await state(pool, source), before);
    await assertXlsxGenesisIntegrity(pool);
    await assertXlsxPreviewIntegrity(pool);
    await assertXlsxReviewedImportIntegrity(pool);
    return replay;
  } finally {
    await db.$disconnect();
  }
}

export async function proveRestoredXlsxReviewedImport(pool, apiConnection) {
  const source = await binding(pool);
  const { rows } = await pool.query(
    `SELECT r.id,link."previewReceiptId"
    FROM public."IngestionOperationReceipt" r JOIN public."IngestionReviewedImport" link ON link."receiptId"=r.id
    WHERE r."sourceId"=$1 AND r.kind='XLSX_REVIEWED_IMPORT'`,
    [source.sourceId],
  );
  assert.equal(rows.length, 1);
  const { id, previewReceiptId } = rows[0];
  const input = {
    sourceId: source.sourceId,
    previewReceiptId,
    previewContextSha256: await context(pool, previewReceiptId),
    rowOrdinals: [1, 2, 3],
    commandKey: "fixture-review-commit",
  };
  const db = createDatabase(apiConnection);
  const repository = new DatabaseIngestionRepository(
    db,
    new CredentialVault(Buffer.alloc(32, 34).toString("base64")),
  );
  const retry = () =>
    repository.commitXlsxReviewedImport(
      {
        customerId: source.customerId,
        subject: reviewer,
        roles: ["pmo_admin"],
      },
      input,
      randomUUID(),
    );
  try {
    await assertXlsxReviewedImportIntegrity(pool);
    await verifyXlsxReviewPrivileges(pool);
    assert.deepEqual(await retry(), {
      receiptId: id,
      parentPreviewReceiptId: previewReceiptId,
      replayed: true,
      rowCount: 3,
    });
    const client = await pool.connect();
    try {
      await client.query(
        'BEGIN; ALTER TABLE public."IngestionReviewedImportRow" DISABLE TRIGGER ingestion_reviewed_import_row_guard',
      );
      await client.query(
        'DELETE FROM public."IngestionReviewedImportRow" WHERE "receiptId"=$1 AND ordinal=3',
        [id],
      );
      await assert.rejects(
        assertXlsxReviewedImportIntegrity(client),
        /reviewed imports are invalid/u,
      );
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }
    await assertXlsxReviewedImportIntegrity(pool);
    return { reviewedImportProofRestored: true, missingLinkDetected: true };
  } finally {
    await db.$disconnect();
  }
}
