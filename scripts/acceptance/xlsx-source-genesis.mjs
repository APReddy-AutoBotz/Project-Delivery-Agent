// FR-CON-006/007: exercise real dormant workbook activation on a synthetic database.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { xlsxGenesisFunctions } from "../../packages/operations/dist/business-grants.js";
import { assertXlsxGenesisIntegrity } from "../../packages/operations/dist/xlsx-genesis-integrity.js";
import { serializeXlsxComparisonState } from "../../packages/domain/dist/xlsx-comparison-state.js";

export async function verifyXlsxGenesisPrivileges(
  pool,
  roles,
  { owner, backupRead = false } = {},
) {
  const functions = (
    await pool.query(
      `SELECT p.oid,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
    NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.grantee<>p.proowner AND acl.privilege_type='EXECUTE') AS owner_only
    FROM unnest($1::text[]) signature(name) JOIN pg_proc p ON p.oid=to_regprocedure(name)`,
      [xlsxGenesisFunctions],
    )
  ).rows;
  assert.equal(functions.length, xlsxGenesisFunctions.length);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, false);
    assert.deepEqual(fn.proconfig, ["search_path=pg_catalog"]);
    assert.equal(fn.owner_only, true);
    if (owner !== undefined) assert.equal(fn.owner, owner);
  }
  const effective = (
    await pool.query(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) AS r(role),
    unnest($2::oid[]) AS f(id) WHERE has_function_privilege(role,id,'EXECUTE')`,
      [roles, functions.map((fn) => fn.oid)],
    )
  ).rows[0];
  assert.equal(effective.n, 0);
  const head = (
    await pool.query(`SELECT pg_get_userbyid(c.relowner) AS owner,
    EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access
    FROM pg_class c WHERE c.oid='public."IngestionXlsxHead"'::regclass`)
  ).rows[0];
  assert.equal(head.public_access, false);
  if (owner !== undefined) assert.equal(head.owner, owner);
  for (const role of roles) {
    const expected = role === "pdaa_backup" && backupRead;
    const { rows } = await pool.query(
      `SELECT has_table_privilege($1,'public."IngestionXlsxHead"','SELECT') AS readable,
      has_table_privilege($1,'public."IngestionXlsxHead"','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS writable`,
      [role],
    );
    assert.deepEqual(rows, [{ readable: expected, writable: false }]);
  }
  return { privateFunctions: functions.length, backupRead };
}

export async function proveXlsxSourceGenesis(
  pool,
  { retain = false, existingCustomer } = {},
) {
  const client = await pool.connect();
  const [fixtureCustomer, source, portfolio, project, auditId] = Array.from(
    { length: 5 },
    () => randomUUID(),
  );
  const customer = existingCustomer ?? fixtureCustomer;
  const subject = "synthetic-workbook-pmo";
  const mapping = {
    kind: "XLSX",
    sheet: 'Portfolio 🧪 "1"',
    parserContract: "excel-text-v1",
    identityColumn: "Key",
    projectColumn: "Project",
    fields: [
      {
        column: "Status",
        factType: "project.status",
        type: "text",
        required: false,
      },
      {
        column: "Forecast",
        factType: "project.forecast",
        type: "date",
        required: true,
      },
    ],
  };
  let started = false;
  const denied = async (sql, params, message) => {
    await client.query("SAVEPOINT workbook_negative");
    try {
      await assert.rejects(client.query(sql, params), message);
    } finally {
      await client.query(
        "ROLLBACK TO SAVEPOINT workbook_negative; RELEASE SAVEPOINT workbook_negative",
      );
    }
  };
  try {
    await client.query("BEGIN");
    started = true;
    await client.query("SET LOCAL ROLE pdaa_migrate");
    if (!existingCustomer) {
      await client.query(
        "INSERT INTO public.\"Customer\" (id,name) VALUES ($1,'Synthetic workbook customer')",
        [customer],
      );
    }
    await client.query(
      'INSERT INTO public."Portfolio" (id,"customerId",name) VALUES ($1,$2,\'Synthetic workbook portfolio\')',
      [portfolio, customer],
    );
    await client.query(
      `INSERT INTO public."Project" (id,"customerId","portfolioId",code,name,description,"reportedStatus")
      VALUES ($1,$2,$3,$4,'Synthetic workbook project','Genesis fixture','UNKNOWN')`,
      [project, customer, portfolio, project],
    );
    await client.query(
      `INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role)
      VALUES ($1,$2,$3,'project',$4,'pmo_admin')`,
      [randomUUID(), customer, subject, project],
    );

    const birth = `INSERT INTO public."IngestionSource" (id,"customerId","sourceType",origin,"inputFamily")
      VALUES ($1,$2,'xlsx','https://worksheet.invalid','XLSX')`;
    await client.query("SET LOCAL ROLE pdaa_api");
    await denied(birth, [source, customer], /Workbook source owner required/u);
    await client.query("SET LOCAL ROLE pdaa_migrate");
    await client.query(birth, [source, customer]);
    const createdAt = new Date();
    await client.query(
      `INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
      VALUES ($1,$2,$3,'ingestion.configuration.changed',$4,$5,$6)`,
      [
        auditId,
        customer,
        subject,
        randomUUID(),
        createdAt,
        { sourceId: source, configRevision: 1, mappingRevision: 1 },
      ],
    );
    const config = `INSERT INTO public."IngestionConfigurationRevision"
      ("customerId","sourceId",revision,"mappingRevision",mapping,"changedBy","auditEventId","createdAt")
      VALUES ($1,$2,1,1,$3,$4,$5,$6)`;
    const configParams = [
      customer,
      source,
      mapping,
      subject,
      auditId,
      createdAt,
    ];
    await denied(
      config,
      [
        customer,
        source,
        { ...mapping, kind: "CSV" },
        subject,
        auditId,
        createdAt,
      ],
      /mapping family mismatch/u,
    );
    await denied(
      config,
      [
        customer,
        source,
        { ...mapping, parserContract: "unknown" },
        subject,
        auditId,
        createdAt,
      ],
      /Invalid workbook mapping/u,
    );
    await client.query(config, configParams);
    await client.query(
      `INSERT INTO public."IngestionConfigurationProject" VALUES ($1,$2,1,$3)`,
      [customer, source, project],
    );
    await client.query(
      `INSERT INTO public."IngestionConfigurationReader" VALUES ($1,$2,1,$3,$4)`,
      [customer, source, project, subject],
    );
    await client.query(
      `UPDATE public."IngestionConfigurationRevision" SET sealed=true WHERE "customerId"=$1 AND "sourceId"=$2`,
      [customer, source],
    );
    await client.query("SET CONSTRAINTS ingestion_xlsx_head_commit IMMEDIATE");
    await client.query(
      `UPDATE public."IngestionSource" SET "currentConfigRevision"=1,"mappingRevision"=1,"cursorState"='RESET_REQUIRED'
      WHERE "customerId"=$1 AND id=$2`,
      [customer, source],
    );
    const base = [
      "pdaa.xlsx.comparison-state.v1",
      customer,
      source,
      1,
      mapping.sheet,
      mapping.parserContract,
      [
        ["project.forecast", "date"],
        ["project.status", "text"],
      ],
      [],
    ];
    const serialize = `SELECT public.ingestion_xlsx_v1_state_text($1::uuid,$2::uuid,$3::integer,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) AS text`;
    const parameters = (state) => [
      ...state.slice(1, 4),
      ...state.slice(4).map((item) => JSON.stringify(item)),
    ];
    const encoded = serializeXlsxComparisonState(base);
    assert.deepEqual((await client.query(serialize, parameters(base))).rows, [
      { text: encoded.text },
    ]);
    const retained = base.with(7, [
      ["a".repeat(64), randomUUID(), project, [["0", randomUUID()]]],
    ]);
    assert.deepEqual(
      (await client.query(serialize, parameters(retained))).rows,
      [{ text: serializeXlsxComparisonState(retained).text }],
    );
    assert.deepEqual(
      (await client.query(serialize, parameters(base.with(4, "A_x0001_"))))
        .rows,
      [{ text: null }],
    );
    const digest = createHash("sha256").update(encoded.text).digest("hex");
    assert.deepEqual(
      (
        await client.query(
          `SELECT h.dictionary,h."genesisSha256",
      public.valid_ingestion_xlsx_genesis($1,$2) AS valid,
      EXISTS(SELECT 1 FROM public."IngestionCsvHead" c WHERE c."customerId"=$1 AND c."sourceId"=$2) AS csv_head
      FROM public."IngestionXlsxHead" h WHERE h."customerId"=$1 AND h."sourceId"=$2`,
          [customer, source],
        )
      ).rows,
      [
        {
          dictionary: base[6],
          genesisSha256: digest,
          valid: true,
          csv_head: false,
        },
      ],
    );
    await denied(
      `UPDATE public."IngestionXlsxHead" SET "genesisSha256"=repeat('a',64) WHERE "sourceId"=$1`,
      [source],
      /history is immutable/u,
    );
    await denied(
      `UPDATE public."IngestionSource" SET "inputFamily"='LEGACY' WHERE id=$1`,
      [source],
      /input family is immutable/u,
    );
    await client.query("SET LOCAL ROLE pdaa_api");
    await denied(
      `UPDATE public."IngestionSource" SET "mappingRevision"="mappingRevision" WHERE id=$1`,
      [source],
      /Workbook source owner required/u,
    );
    await denied(
      `INSERT INTO public."ConnectorSyncGrant" ("customerId","sourceId") VALUES ($1,$2)`,
      [customer, source],
      /Legacy ingestion is unavailable/u,
    );
    await client.query(
      "SET LOCAL ROLE pdaa_migrate; SET CONSTRAINTS ALL IMMEDIATE",
    );
    if (retain) {
      await client.query("COMMIT");
      started = false;
    }
    return {
      canonicalParity: true,
      ownerActivation: true,
      atomicGenesis: true,
      publicAndApiDenied: true,
    };
  } finally {
    try {
      if (started) await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

export async function verifyXlsxGenesisRestoreDenials(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inventory = `SELECT "customerId","sourceId","genesisSha256" FROM public."IngestionXlsxHead"`;
    const { rows } = await client.query(inventory);
    assert.equal(
      rows.length,
      1,
      "Expected the single retained synthetic workbook head",
    );
    const head = rows[0];
    await assertXlsxGenesisIntegrity(client);
    await client.query(
      'ALTER TABLE public."IngestionXlsxHead" DISABLE TRIGGER ingestion_xlsx_head_immutable',
    );
    const params = [head.customerId, head.sourceId];
    await client.query("SAVEPOINT workbook_restored_head");
    await client.query(
      `UPDATE public."IngestionXlsxHead" SET "genesisSha256"=repeat('0',64)
      WHERE "customerId"=$1 AND "sourceId"=$2`,
      params,
    );
    await assert.rejects(
      assertXlsxGenesisIntegrity(client),
      /Restored workbook genesis is invalid/u,
    );
    await client.query("ROLLBACK TO SAVEPOINT workbook_restored_head");
    await client.query(
      `DELETE FROM public."IngestionXlsxHead" WHERE "customerId"=$1 AND "sourceId"=$2`,
      params,
    );
    await assert.rejects(
      assertXlsxGenesisIntegrity(client),
      /Restored workbook genesis is invalid/u,
    );
    await client.query("ROLLBACK");
    assert.deepEqual((await client.query(inventory)).rows, rows);
    await assertXlsxGenesisIntegrity(client);
    return {
      tamperedHeadDenied: true,
      missingHeadDenied: true,
      retainedHeadVerified: true,
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}
