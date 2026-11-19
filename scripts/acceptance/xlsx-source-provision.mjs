import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CredentialVault } from "../../packages/platform/dist/index.js";
import {
  createDatabase,
  DatabaseIngestionRepository,
} from "../../packages/data/dist/index.js";
import { provisionXlsxSource } from "../../packages/operations/dist/index.js";
import { xlsxSourceCatalogueApi } from "../../packages/operations/dist/business-grants.js";

const ownerSubject = "synthetic-xlsx-provision-pmo";
const reader = "synthetic-xlsx-catalogue-reader";
const partialReader = "synthetic-xlsx-partial-reader";
const sheet = "Operator Workbook";

export async function verifyXlsxCataloguePrivileges(
  pool,
  roles = ["pdaa_api", "pdaa_worker", "pdaa_backup"],
  { owner = "pdaa_migrate", apiExecute = true } = {},
) {
  const { rows } = await pool.query(
    `SELECT pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.provolatile,p.proconfig,
      ARRAY(SELECT a.grantee::regrole::text FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE' ORDER BY a.grantee) AS readers,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.is_grantable) AS grantable
     FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,
    [xlsxSourceCatalogueApi],
  );
  assert.deepEqual(rows, [
    {
      owner,
      prosecdef: true,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog, pg_temp"],
      readers: apiExecute ? ["pdaa_api"] : [],
      grantable: false,
    },
  ]);
  for (const role of roles) {
    const result = await pool.query(
      "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
      [role, xlsxSourceCatalogueApi],
    );
    assert.equal(result.rows[0].allowed, apiExecute && role === "pdaa_api");
  }
}

async function evidence(pool, sourceId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM public."IngestionSource" WHERE id=$1) AS sources,
       (SELECT count(*)::int FROM public."IngestionConfigurationRevision" WHERE "sourceId"=$1 AND sealed) AS configurations,
       (SELECT count(*)::int FROM public."IngestionXlsxHead" WHERE "sourceId"=$1 AND revision=0) AS heads,
       (SELECT count(*)::int FROM public."AuditEvent" WHERE event='ingestion.configuration.changed'
          AND detail->>'sourceId'=$1::text) AS audits,
       (SELECT count(*)::int FROM public."IngestionOperationReceipt" WHERE "sourceId"=$1) AS receipts`,
    [sourceId],
  );
  return rows[0];
}

export async function proveXlsxSourceProvisioning(
  pool,
  operator,
  apiConnection,
) {
  const { customerId } = operator;
  const portfolio = randomUUID(),
    sourceId = randomUUID();
  const firstProject = randomUUID(),
    secondProject = randomUUID();
  await pool.query(
    'INSERT INTO public."Portfolio" (id,"customerId",name) VALUES ($1,$2,$3)',
    [portfolio, customerId, "Synthetic XLSX operator portfolio"],
  );
  for (const project of [firstProject, secondProject]) {
    await pool.query(
      `INSERT INTO public."Project" (id,"customerId","portfolioId",code,name,description,"reportedStatus")
       VALUES ($1,$2,$3,$1::text,'Synthetic XLSX operator project','Provisioning fixture','UNKNOWN')`,
      [project, customerId, portfolio],
    );
  }
  const grant = async (subject, role, type, scope) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO public."AccessGrant" (id,"customerId",subject,role,"scopeType","scopeId")
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, customerId, subject, role, type, scope],
    );
    return id;
  };
  const ownerGrant = await grant(
    ownerSubject,
    "pmo_admin",
    "portfolio",
    portfolio,
  );
  await grant(reader, "project_manager", "project", firstProject);
  const lastReaderGrant = await grant(
    reader,
    "project_manager",
    "project",
    secondProject,
  );
  await grant(partialReader, "portfolio_manager", "portfolio", portfolio);
  const input = {
    binding: {
      customerId,
      sourceId,
      sourceType: "xlsx",
      origin: "https://operator.invalid",
    },
    changedBy: ownerSubject,
    projects: [
      {
        projectId: firstProject,
        readers: [reader, ownerSubject, partialReader],
      },
      { projectId: secondProject, readers: [ownerSubject, reader] },
    ],
    mapping: {
      kind: "XLSX",
      sheet,
      parserContract: "portable-v1",
      identityColumn: "Key",
      projectColumn: "Project",
      fields: [
        {
          column: "Status",
          factType: "project.status",
          type: "text",
          required: false,
        },
      ],
    },
  };
  const empty = {
    sources: 0,
    configurations: 0,
    heads: 0,
    audits: 0,
    receipts: 0,
  };
  const once = {
    sources: 1,
    configurations: 1,
    heads: 1,
    audits: 1,
    receipts: 0,
  };
  await verifyXlsxCataloguePrivileges(pool);
  await assert.rejects(
    provisionXlsxSource({ ...operator, database: apiConnection }, input),
    { code: "DENIED" },
  );
  await assert.rejects(
    provisionXlsxSource(operator, { ...input, changedBy: partialReader }),
    { code: "DENIED" },
  );
  await assert.rejects(
    provisionXlsxSource(operator, {
      ...input,
      binding: { ...input.binding, customerId: randomUUID() },
    }),
    { code: "INVALID_REQUEST" },
  );
  await assert.rejects(
    provisionXlsxSource(operator, {
      ...input,
      projects: [{ projectId: randomUUID(), readers: [ownerSubject] }],
    }),
    { code: "DENIED" },
  );
  assert.deepEqual(await evidence(pool, sourceId), empty);

  const repeated = {
    ...input,
    projects: input.projects.toReversed().map((project) => ({
      ...project,
      readers: project.readers.toReversed(),
    })),
  };
  const results = await Promise.all([
    provisionXlsxSource(operator, input),
    provisionXlsxSource(operator, repeated),
  ]);
  assert.deepEqual(results.map(({ replayed }) => replayed).sort(), [
    false,
    true,
  ]);
  assert.deepEqual(await provisionXlsxSource(operator, input), {
    sourceId,
    configRevision: 1,
    mappingRevision: 1,
    replayed: true,
  });
  await assert.rejects(
    provisionXlsxSource(operator, {
      ...input,
      mapping: { ...input.mapping, parserContract: "excel-text-v1" },
    }),
    { code: "CONFLICT" },
  );
  await pool.query(
    "UPDATE public.\"AccessGrant\" SET role='leadership' WHERE id=$1",
    [ownerGrant],
  );
  try {
    await assert.rejects(provisionXlsxSource(operator, input), {
      code: "DENIED",
    });
  } finally {
    await pool.query(
      "UPDATE public.\"AccessGrant\" SET role='pmo_admin' WHERE id=$1",
      [ownerGrant],
    );
  }
  assert.deepEqual(await evidence(pool, sourceId), once);
  const db = createDatabase(apiConnection);
  try {
    assert.deepEqual(await db.$queryRaw`SELECT session_user::text AS name`, [
      { name: "pdaa_api" },
    ]);
    const repository = new DatabaseIngestionRepository(
      db,
      new CredentialVault(Buffer.alloc(32, 37).toString("base64")),
    );
    const catalogue = (subject, roles, afterSourceId = null) =>
      repository.listXlsxSources(
        { customerId, subject, roles },
        { afterSourceId },
      );
    const visible = {
      sources: [{ sourceId, configRevision: 1, mappingRevision: 1, sheet }],
      nextSourceId: null,
    };
    const emptyPage = { sources: [], nextSourceId: null };
    assert.deepEqual(await catalogue(reader, ["project_manager"]), visible);
    assert.deepEqual(await catalogue(ownerSubject, ["pmo_admin"]), visible);
    assert.deepEqual(
      await catalogue(reader, ["project_manager"], sourceId),
      emptyPage,
    );
    assert.deepEqual(
      await catalogue(partialReader, ["portfolio_manager"]),
      emptyPage,
    );
    assert.deepEqual(await catalogue(reader, ["pmo_admin"]), emptyPage);
    await assert.rejects(catalogue(reader, ["leadership"]), { code: "DENIED" });
    await pool.query(
      "UPDATE public.\"AccessGrant\" SET role='leadership' WHERE id=$1",
      [lastReaderGrant],
    );
    try {
      assert.deepEqual(await catalogue(reader, ["project_manager"]), emptyPage);
    } finally {
      await pool.query(
        "UPDATE public.\"AccessGrant\" SET role='project_manager' WHERE id=$1",
        [lastReaderGrant],
      );
    }
    assert.deepEqual(await catalogue(reader, ["project_manager"]), visible);
    assert.deepEqual(await evidence(pool, sourceId), once);
    return {
      sourceId,
      operatorGenesis: true,
      exactConcurrentReplay: true,
      fullScopeCatalogue: true,
    };
  } finally {
    await db.$disconnect();
  }
}

export async function verifyRestoredXlsxSourceProvision(pool, apiConnection) {
  await verifyXlsxCataloguePrivileges(pool);
  const { rows } = await pool.query(
    `SELECT h."sourceId",h."customerId",public.valid_ingestion_xlsx_head(h."customerId",h."sourceId") AS valid
     FROM public."IngestionXlsxHead" h JOIN public."IngestionConfigurationRevision" c
       ON c."customerId"=h."customerId" AND c."sourceId"=h."sourceId" AND c.revision=h."activationConfigRevision"
     WHERE c.mapping->>'sheet'=$1`,
    [sheet],
  );
  assert.equal(rows.length, 1);
  const { sourceId, customerId, valid } = rows[0];
  assert.equal(valid, true);
  assert.deepEqual(await evidence(pool, sourceId), {
    sources: 1,
    configurations: 1,
    heads: 1,
    audits: 1,
    receipts: 0,
  });
  if (apiConnection) {
    const db = createDatabase(apiConnection);
    try {
      const repository = new DatabaseIngestionRepository(
        db,
        new CredentialVault(Buffer.alloc(32, 37).toString("base64")),
      );
      assert.deepEqual(
        await repository.listXlsxSources(
          { customerId, subject: reader, roles: ["project_manager"] },
          { afterSourceId: null },
        ),
        {
          sources: [{ sourceId, configRevision: 1, mappingRevision: 1, sheet }],
          nextSourceId: null,
        },
      );
    } finally {
      await db.$disconnect();
    }
  }
  return { operatorGenesisRestored: true, finiteCatalogueGrantRestored: true };
}
