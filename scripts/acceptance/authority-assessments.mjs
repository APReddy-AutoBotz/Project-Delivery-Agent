// Synthetic fixtures for FR-ADM-005 and FR-EVD-003/004/006/007/009/010/012.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseProjectFactRepository,
} from "../../packages/data/dist/index.js";
import { Pool } from "./common.mjs";
export const authorityTables = [
  "AuthorityPolicy",
  "AuthorityPolicyRevision",
  "AuthorityPolicyReceipt",
  "FactAuthorityConflict",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
];
function guard() {
  assert(
    ["isolated", "customer-composition"].includes(process.env.PDAA_ACCEPTANCE),
  );
  assert.match(
    process.env.PDAA_ACCEPTANCE_RUN_ID,
    /^pdaa-acceptance-\d+-[a-f0-9]{8}$/,
  );
}
export async function authorityProjection(pool) {
  const result = {};
  for (const table of authorityTables)
    result[table] = (
      await pool.query(
        `SELECT * FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
  return result;
}
export async function verifyAuthorityIntegrity(pool) {
  guard();
  const invalid = (
    await pool.query(`SELECT
    (SELECT count(*)::int FROM "AuthorityPolicy" WHERE NOT public.valid_authority_history(id)) +
    (SELECT count(*)::int FROM "FactAuthorityConflict" WHERE NOT public.valid_authority_conflict(id)) +
    (SELECT count(*)::int FROM (SELECT "factId" FROM "FactAuthorityConflict" GROUP BY "factId" HAVING count(*)<>max(revision)) drift) +
    (SELECT count(*)::int FROM "FactAssessment" WHERE NOT sealed OR NOT public.valid_fact_assessment(id)) AS invalid`)
  ).rows[0].invalid;
  assert.equal(invalid, 0);
  return true;
}
export async function verifyAuthorityPrivileges(pool) {
  guard();
  for (const table of authorityTables) {
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"]) {
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ]) {
        const allowed = (
          await pool.query("SELECT has_table_privilege($1,$2,$3) AS allowed", [
            role,
            '"' + table + '"',
            privilege,
          ])
        ).rows[0].allowed;
        assert.equal(
          allowed,
          role === "pdaa_backup"
            ? privilege === "SELECT"
            : role === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege),
          role + "/" + table + "/" + privilege,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT has_table_privilege($1,$2,$3) AS allowed",
              [role, '"' + table + '"', privilege + " WITH GRANT OPTION"],
            )
          ).rows[0].allowed,
          false,
        );
      }
      const columns = (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
          [table],
        )
      ).rows;
      for (const { column_name } of columns)
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          const allowed = (
            await pool.query(
              "SELECT has_column_privilege($1,$2,$3,$4) AS allowed",
              [role, '"' + table + '"', column_name, privilege],
            )
          ).rows[0].allowed;
          const expected =
            role === "pdaa_backup"
              ? privilege === "SELECT"
              : role === "pdaa_api" &&
                (["SELECT", "INSERT"].includes(privilege) ||
                  (privilege === "UPDATE" &&
                    ((table === "AuthorityPolicy" &&
                      column_name === "revision") ||
                      (table === "FactAssessment" &&
                        column_name === "sealed"))));
          assert.equal(
            allowed,
            expected,
            role + "/" + table + "/" + column_name + "/" + privilege,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT has_column_privilege($1,$2,$3,$4) AS allowed",
                [
                  role,
                  '"' + table + '"',
                  column_name,
                  privilege + " WITH GRANT OPTION",
                ],
              )
            ).rows[0].allowed,
            false,
          );
        }
    }
    assert.equal(
      (
        await pool.query(
          "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename=$1",
          [table],
        )
      ).rows[0].tableowner,
      "pdaa_migrate",
    );
  }
  const names = [
    "valid_authority_definition",
    "valid_authority_sources",
    "guard_authority_policy",
    "guard_authority_revision",
    "advance_authority_revision",
    "valid_authority_history",
    "require_authority_published",
    "authority_instant",
    "valid_authority_conflict",
    "guard_authority_conflict",
    "valid_fact_assessment",
    "guard_assessment_header",
    "guard_assessment_dependency",
    "require_assessment_sealed",
  ];
  const functions = (
    await pool.query(
      "SELECT p.proname,p.prosecdef,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1)",
      [names],
    )
  ).rows;
  assert.equal(functions.length, names.length);
  assert(
    functions.every((row) => !row.prosecdef && row.owner === "pdaa_migrate"),
  );
  return true;
}
async function deniedSql(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(() => client.query(sql));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
export async function verifyAuthorityImmutable(pool) {
  guard();
  for (const table of authorityTables) {
    const key =
      table === "FactAssessmentVersion"
        ? "versionId"
        : table === "FactAssessmentConflict"
          ? "conflictId"
          : "id";
    await deniedSql(pool, `UPDATE "${table}" SET "${key}"="${key}"`);
    await deniedSql(pool, `DELETE FROM "${table}"`);
    await deniedSql(pool, `TRUNCATE "${table}" CASCADE`);
  }
  return true;
}
// Exercise real COMMIT behavior after restore. Existing frozen rows are checked
// before these synthetic probes append anything, so exact restoration stays auditable.
export async function verifyAssessmentCommitGuards(pool) {
  guard();
  const original = (
    await pool.query(`SELECT a.* FROM "FactAssessment" a JOIN "ProjectFact" f ON f.id=a."factId"
    LEFT JOIN "AuthorityPolicy" p ON p."customerId"=a."customerId" AND p."projectId"=a."projectId" AND p."factType"=a."factType"
    WHERE a.sealed AND a.complete AND a."factRevision"=f.revision AND a."policyId" IS NOT DISTINCT FROM p.id AND a."policyThroughRevision" IS NOT DISTINCT FROM p.revision
      AND a."conflictThroughRevision" IS NOT DISTINCT FROM (SELECT max(revision) FROM "FactAuthorityConflict" WHERE "factId"=a."factId")
    ORDER BY a."asOf" DESC LIMIT 1`)
  ).rows[0];
  assert(original, "A fully populated capture fixture is required");
  const columns = [
    "id",
    "customerId",
    "projectId",
    "factId",
    "factType",
    "factRevision",
    "policyId",
    "policyThroughRevision",
    "policyRevisionId",
    "asOf",
    "subject",
    "idempotencyKey",
    "requestHash",
    "evaluatorVersion",
    "complete",
    "versionCount",
    "conflictCount",
    "conflictThroughRevision",
    "result",
    "sealed",
  ];
  const insert = async (client, id) => {
    const data = {
      ...original,
      id,
      idempotencyKey: randomUUID(),
      sealed: false,
    };
    const result = await client.query(
      `INSERT INTO "FactAssessment" (${columns.map((key) => '"' + key + '"').join(",")}) VALUES (${columns.map((_, i) => "$" + (i + 1)).join(",")})`,
      columns.map((key) => data[key]),
    );
    assert.equal(result.rowCount, 1);
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insert(client, randomUUID());
    await assert.rejects(
      () => client.query("COMMIT"),
      /Unsealed assessment cannot commit/,
    );
    await client.query("ROLLBACK");
    const id = randomUUID();
    await client.query("BEGIN");
    await insert(client, id);
    await client.query(
      `INSERT INTO "FactAssessmentVersion" SELECT av."customerId",av."projectId",av."factId",$1,av."versionId",COALESCE(sa.revision,0)
      FROM "FactAssessmentVersion" av JOIN "ProjectFactVersion" v ON v.id=av."versionId" LEFT JOIN "FactSourceAccess" sa ON sa."sourceId"=v."sourceId" WHERE av."assessmentId"=$2`,
      [id, original.id],
    );
    await client.query(
      `INSERT INTO "FactAssessmentConflict" SELECT "customerId","projectId","factId",$1,"conflictId" FROM "FactAssessmentConflict" WHERE "assessmentId"=$2`,
      [id, original.id],
    );
    await client.query('UPDATE "FactAssessment" SET sealed=true WHERE id=$1', [
      id,
    ]);
    await client.query("COMMIT");
    assert.equal(
      (
        await pool.query(
          'SELECT sealed AND public.valid_fact_assessment(id) AS valid FROM "FactAssessment" WHERE id=$1',
          [id],
        )
      ).rows[0].valid,
      true,
    );
    return {
      unsealedCommitDenied: true,
      completeCommitPassed: true,
      assessmentId: id,
    };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
export async function verifyAuthorityWorkerDenials(connection) {
  guard();
  const worker = new Pool(connection);
  try {
    assert.equal(
      (await worker.query("SELECT current_user AS name")).rows[0].name,
      "pdaa_worker",
    );
    for (const table of authorityTables)
      await assert.rejects(
        () => worker.query(`SELECT * FROM "${table}"`),
        (error) => error.code === "42501",
      );
    return true;
  } finally {
    await worker.end();
  }
}
export async function seedAuthorityHistory(
  owner,
  connection,
  customerId,
  projectId,
  prefix,
  databaseFactory = createDatabase,
) {
  guard();
  const pmo = {
    customerId,
    subject: prefix + "-policy-admin",
    roles: ["pmo_admin"],
  };
  const human = {
    customerId,
    subject: prefix + "-policy-human",
    roles: ["project_manager"],
  };
  for (const actor of [pmo, human])
    await owner.query(
      'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        customerId,
        actor.subject,
        "project",
        projectId,
        actor.roles[0],
      ],
    );
  const database = databaseFactory(connection);
  try {
    const authority = new DatabaseAuthorityRepository(database),
      facts = new DatabaseProjectFactRepository(database);
    const factType = "authority.forecast",
      context = { correlationId: prefix + "-authority" };
    const definition = {
      tiers: [
        {
          selectors: [
            {
              sourceType: "human_statement",
              instanceId: null,
              requiredApproval: "NOT_REQUIRED",
              validity: { basis: "observedAt", durationMs: 86400000 },
            },
          ],
        },
      ],
      conflictBehavior: "REQUEST_RECONCILIATION",
    };
    const policyRequest = {
      projectId,
      factType,
      expectedRevision: 0,
      idempotencyKey: "policy",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      definition,
    };
    const policy = await authority.appendPolicy(pmo, policyRequest, context);
    assert.equal(
      (await authority.appendPolicy(pmo, policyRequest, context)).replayed,
      true,
    );
    await assert.rejects(() =>
      authority.appendPolicy(human, policyRequest, context),
    );
    const request = {
      projectId,
      factType,
      expectedRevision: 0,
      idempotencyKey: "human",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      value: { type: "date", value: "2026-10-01" },
      originalStatement: "Synthetic authority forecast",
    };
    const first = await facts.appendHumanStatement(human, request, context);
    const grant = await facts.setSourceAccess(
      pmo,
      {
        projectId,
        sourceId: first.entry.sourceId,
        expectedRevision: first.entry.sourceAccessRevision,
        state: "AVAILABLE",
        readers: [human.subject, pmo.subject],
      },
      context,
    );
    const firstCapture = await authority.captureAssessment(
      pmo,
      { projectId, factType, idempotencyKey: "first" },
      context,
    );
    assert.equal(firstCapture.visibility, "available");
    assert.equal(firstCapture.result.status, "RESOLVED");
    await facts.appendHumanStatement(
      pmo,
      {
        ...request,
        expectedRevision: 1,
        idempotencyKey: "alternative",
        value: { type: "date", value: "2026-11-01" },
      },
      context,
    );
    const conflicted = await authority.captureAssessment(
      pmo,
      { projectId, factType, idempotencyKey: "conflict" },
      context,
    );
    assert.equal(conflicted.visibility, "available");
    assert.equal(conflicted.result.status, "CONFLICTING");
    assert(
      conflicted.result.conflicts.some((item) => item.kind === "RECORDED"),
    );
    assert.deepEqual(
      (
        await authority.captureAssessment(
          pmo,
          { projectId, factType, idempotencyKey: "first" },
          context,
        )
      ).result,
      firstCapture.result,
    );
    await authority.appendPolicy(
      pmo,
      {
        ...policyRequest,
        expectedRevision: 1,
        idempotencyKey: "disabled",
        definition: null,
      },
      context,
    );
    await facts.setSourceAccess(
      pmo,
      {
        projectId,
        sourceId: first.entry.sourceId,
        expectedRevision: grant.revision,
        state: "REVOKED",
        readers: [human.subject, pmo.subject],
      },
      context,
    );
    const redacted = await authority.getAssessment(pmo, {
      projectId,
      assessmentId: firstCapture.assessmentId,
    });
    assert.equal(redacted.visibility, "restricted");
    assert.equal(redacted.result, null);
    const final = await authority.captureAssessment(
      pmo,
      { projectId, factType, idempotencyKey: "final" },
      context,
    );
    assert.equal(final.visibility, "restricted");
    await verifyAuthorityIntegrity(owner);
    return {
      factId: first.factId,
      policyId: policy.event.policyId,
      assessments: [
        firstCapture.assessmentId,
        conflicted.assessmentId,
        final.assessmentId,
      ],
      runtimeRole: (await database.$queryRaw`SELECT current_user AS name`)[0]
        .name,
      retainedConflict: true,
      originalFrozenResultRetained: true,
      revokedCopiedValueRedacted: true,
      unauthorizedPolicyWriteDenied: true,
    };
  } finally {
    await database.$disconnect();
  }
}
