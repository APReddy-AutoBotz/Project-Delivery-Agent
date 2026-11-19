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

export async function verifyXlsxReviewPrivileges(
  pool,
  roles = ["pdaa_api", "pdaa_worker", "pdaa_backup"],
  { owner = "pdaa_migrate", apiExecute = true } = {},
) {
  for (const signature of xlsxReviewFunctions) {
    const { rows } = await pool.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,
      ARRAY(SELECT a.grantee::regrole::text FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE' ORDER BY a.grantee) AS readers,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.is_grantable) AS grantable
      FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
      [signature],
    );
    const exposed = signature === xlsxReviewApiFunction;
    const granted = exposed && apiExecute;
    assert.deepEqual(rows, [
      {
        owner,
        prosecdef:
          exposed ||
          signature ===
            "public.require_ingestion_xlsx_reviewed_import_complete()",
        proconfig: [
          signature === "public.verified_ingestion_xlsx_context(uuid)"
            ? "search_path=pg_catalog"
            : "search_path=pg_catalog, pg_temp",
        ],
        readers: granted ? ["pdaa_api"] : [],
        grantable: false,
      },
    ]);
    for (const role of roles) {
      const { rows: permissions } = await pool.query(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [role, signature],
      );
      assert.equal(permissions[0].allowed, granted && role === "pdaa_api");
    }
  }
  return { finiteReviewedImportGrant: true };
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

async function withFixtureOwner(pool, action) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL ROLE pdaa_migrate");
    await action(client);
    await client.query("COMMIT");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function reviewWriteCounts(pool, { sourceId, customerId }) {
  const { rows } = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM public."IngestionOperationReceipt" WHERE "sourceId"=$1 AND kind='XLSX_REVIEWED_IMPORT') AS receipts,
      (SELECT count(*)::int FROM public."IngestionReviewedImport" WHERE "sourceId"=$1) AS reviews,
      (SELECT count(*)::int FROM public."IngestionReviewedImportRow" WHERE "sourceId"=$1) AS links,
      (SELECT count(*)::int FROM public."AuditEvent" WHERE "customerId"=$2
        AND event='ingestion.xlsx_reviewed_import.persisted' AND detail->>'sourceId'=$1::text) AS audits`,
    [sourceId, customerId],
  );
  return rows[0];
}

export async function proveNativeXlsxReviewedImport(
  pool,
  apiConnection,
  customer,
) {
  assert(customer);
  await proveXlsxSourceGenesis(pool, {
    retain: true,
    existingCustomer: customer,
    sheet,
    reviewer,
    forecastRequired: false,
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
  const row = (key, text, forecast = "2027-04-01") => [
    key,
    source.projectId,
    text,
    forecast,
  ];
  const cases = [
    [row("Review-A", "Active"), ["Review-B", source.projectId, "", ""]],
    [
      row("Review-A", "Needs attention"),
      ["Review-B", source.projectId, "", ""],
      row("Review-C", "New"),
      row("Review-D", "Malformed date", "invalid-date"),
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
    const advanced = await preview(cases[1], "fixture-review-head-advance");
    const input = {
      sourceId: source.sourceId,
      previewReceiptId: selected.receiptId,
      previewContextSha256: await context(pool, selected.receiptId),
      rowOrdinals: [1, 2, 3],
      commandKey: "fixture-review-commit",
    };
    const before = await state(pool, source);
    await assert.rejects(commit({ ...input, rowOrdinals: [3, 1] }), {
      code: "INVALID_INPUT",
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
      `SELECT r.subject,o.operation,l."previewOrdinal",cardinality(p."factTypes") AS fields, o."sourceRevisionId",o."projectionId"
      FROM public."IngestionOperationReceipt" r JOIN public."IngestionRowOutcome" o ON o."receiptId"=r.id
      JOIN public."IngestionReviewedImportRow" l ON l."receiptId"=r.id AND l.ordinal=o.ordinal
      JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
      WHERE r.id=$1 ORDER BY o.ordinal`,
      [saved.receiptId],
    );
    assert.deepEqual(
      link.rows.map(({ subject, operation, previewOrdinal, fields }) => ({
        subject,
        operation,
        previewOrdinal,
        fields,
      })),
      [
        {
          subject: reviewer,
          operation: "UPDATE",
          previewOrdinal: 1,
          fields: 2,
        },
        {
          subject: reviewer,
          operation: "UNCHANGED",
          previewOrdinal: 2,
          fields: 0,
        },
        {
          subject: reviewer,
          operation: "CREATE",
          previewOrdinal: 3,
          fields: 2,
        },
      ],
    );
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

    // Model elapsed retention time for one synthetic revision. The real API
    // lookup, row-link guard, and one-way purge then run with normal guards.
    const aged = link.rows[0];
    await withFixtureOwner(pool, async (client) => {
      await client.query(
        'ALTER TABLE public."IngestionSourceRevision" DISABLE TRIGGER ingestion_revision_guard',
      );
      assert.equal(
        (
          await client.query(
            `UPDATE public."IngestionSourceRevision" r
          SET "receivedAt"=clock_timestamp()-make_interval(hours=>p."retentionHours"+1)
          FROM public."IngestionRetentionPolicy" p
          WHERE r."customerId"=$1 AND r."sourceId"=$2 AND r.id=$3 AND p."customerId"=r."customerId"`,
            [customer, source.sourceId, aged.sourceRevisionId],
          )
        ).rowCount,
        1,
      );
      await client.query(
        'ALTER TABLE public."IngestionSourceRevision" ENABLE TRIGGER ingestion_revision_guard',
      );
    });
    const unused = {
      ...input,
      previewReceiptId: advanced.receiptId,
      previewContextSha256: await context(pool, advanced.receiptId),
      rowOrdinals: [1],
      commandKey: "fixture-review-expired",
    };
    const counts = await reviewWriteCounts(pool, source);
    assert.deepEqual(counts, { receipts: 1, reviews: 1, links: 3, audits: 1 });
    await assert.rejects(commit(unused), { code: "INVALID_PREVIEW" });
    assert.deepEqual(await reviewWriteCounts(pool, source), counts);

    await withFixtureOwner(pool, async (client) => {
      const purger = reviewer + "-retention";
      const audit = randomUUID();
      const now = new Date();
      await client.query(
        `INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role)
         VALUES ($1,$2,$3,'project',$4,'system_admin')`,
        [randomUUID(), customer, purger, source.projectId],
      );
      await client.query(
        `INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
         VALUES ($1,$2,$3,'ingestion.content.purged',$4,$5,'{"redactedCount":1}')`,
        [audit, customer, purger, randomUUID(), now],
      );
      assert.equal(
        (
          await client.query(
            `UPDATE public."IngestionProposalContent" SET proposals=NULL,"redactedAt"=$4,"redactionAuditEventId"=$5
         WHERE "customerId"=$1 AND "sourceId"=$2 AND "projectionId"=$3`,
            [customer, source.sourceId, aged.projectionId, now, audit],
          )
        ).rowCount,
        1,
      );
    });
    await assert.rejects(commit(unused), { code: "INVALID_PREVIEW" });
    assert.deepEqual(await commit(input), replay);
    assert.deepEqual(await reviewWriteCounts(pool, source), counts);
    assert.deepEqual(await state(pool, source), before);

    await withFixtureOwner(pool, async (client) => {
      const id = randomUUID();
      const now = new Date();
      const params = [customer, source.sourceId];
      await client.query(
        `INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
         VALUES ($1,$2,$3,'ingestion.configuration.changed',$4,$5,$6)`,
        [
          id,
          customer,
          previewAuthor,
          randomUUID(),
          now,
          { sourceId: source.sourceId, configRevision: 2, mappingRevision: 1 },
        ],
      );
      await client.query(
        `INSERT INTO public."IngestionConfigurationRevision"
          ("customerId","sourceId",revision,"mappingRevision",mapping,"changedBy","auditEventId","createdAt")
         SELECT "customerId","sourceId",2,"mappingRevision",mapping,"changedBy",$3,$4
         FROM public."IngestionConfigurationRevision" WHERE "customerId"=$1 AND "sourceId"=$2 AND revision=1`,
        [...params, id, now],
      );
      await client.query(
        `INSERT INTO public."IngestionConfigurationProject"
         SELECT "customerId","sourceId",2,"projectId" FROM public."IngestionConfigurationProject"
         WHERE "customerId"=$1 AND "sourceId"=$2 AND "configRevision"=1`,
        params,
      );
      await client.query(
        `INSERT INTO public."IngestionConfigurationReader"
         SELECT "customerId","sourceId",2,"projectId",subject FROM public."IngestionConfigurationReader"
         WHERE "customerId"=$1 AND "sourceId"=$2 AND "configRevision"=1`,
        params,
      );
      await client.query(
        `UPDATE public."IngestionConfigurationRevision" SET sealed=true
         WHERE "customerId"=$1 AND "sourceId"=$2 AND revision=2`,
        params,
      );
      await client.query(
        `UPDATE public."IngestionSource" SET "currentConfigRevision"=2,"cursorState"='RESET_REQUIRED'
         WHERE "customerId"=$1 AND id=$2`,
        params,
      );
    });
    await assert.rejects(commit(unused), { code: "STALE_CONFIGURATION" });
    assert.deepEqual(await commit(input), replay);
    assert.deepEqual(await reviewWriteCounts(pool, source), counts);
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
  await assertXlsxReviewedImportIntegrity(pool);
  await verifyXlsxReviewPrivileges(pool);
  // Customer restore remains quarantined. Exercise a real API login only in
  // the disposable native upgrade and no-ACL restore fixture.
  if (apiConnection) {
    const db = createDatabase(apiConnection);
    try {
      const repository = new DatabaseIngestionRepository(
        db,
        new CredentialVault(Buffer.alloc(32, 34).toString("base64")),
      );
      assert.deepEqual(
        await repository.commitXlsxReviewedImport(
          {
            customerId: source.customerId,
            subject: reviewer,
            roles: ["pmo_admin"],
          },
          input,
          randomUUID(),
        ),
        {
          receiptId: id,
          parentPreviewReceiptId: previewReceiptId,
          replayed: true,
          rowCount: 3,
        },
      );
    } finally {
      await db.$disconnect();
    }
  }
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
}
