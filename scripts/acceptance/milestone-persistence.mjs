import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const milestonePersistenceTables = [
  "CanonicalStateBinding",
  "CanonicalStateBindingReceipt",
  "MilestoneConsistencyAssessment",
  "MilestoneConsistencyTarget",
  "MilestoneConsistencyContributorVersion",
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
async function rejected(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      () => client.query(sql),
      (error) => error.code === "P0001",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
export async function milestonePersistenceProjection(pool) {
  const rows = {};
  for (const table of milestonePersistenceTables)
    rows[table] = (
      await pool.query(
        `SELECT * FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
  return rows;
}
export async function verifyMilestonePersistenceIntegrity(pool) {
  guard();
  assert.equal(
    (
      await pool.query(`SELECT
        (SELECT count(*)::int FROM "CanonicalStateBinding" WHERE NOT sealed OR NOT public.valid_canonical_state_binding(id))+
        (SELECT count(*)::int FROM "MilestoneConsistencyAssessment" WHERE NOT sealed OR NOT public.valid_milestone_consistency_assessment(id)) AS invalid`)
    ).rows[0].invalid,
    0,
  );
  return true;
}
export async function verifyMilestonePersistencePrivileges(pool) {
  guard();
  for (const table of milestonePersistenceTables) {
    assert.equal(
      (
        await pool.query(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass",
          ['"' + table + '"'],
        )
      ).rows[0].owner,
      "pdaa_migrate",
    );
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"])
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
        const allowed =
          role === "pdaa_backup"
            ? privilege === "SELECT"
            : role === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege);
        assert.equal(
          (
            await pool.query(
              "SELECT has_table_privilege($1,$2,$3) AS allowed",
              [role, '"' + table + '"', privilege],
            )
          ).rows[0].allowed,
          allowed,
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
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"])
      for (const { column_name } of columns)
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          const allowed =
            role === "pdaa_backup"
              ? privilege === "SELECT"
              : role === "pdaa_api" &&
                (["SELECT", "INSERT"].includes(privilege) ||
                  (privilege === "UPDATE" &&
                    [
                      "CanonicalStateBinding",
                      "MilestoneConsistencyAssessment",
                    ].includes(table) &&
                    column_name === "sealed"));
          assert.equal(
            (
              await pool.query(
                "SELECT has_column_privilege($1,$2,$3,$4) AS allowed",
                [role, '"' + table + '"', column_name, privilege],
              )
            ).rows[0].allowed,
            allowed,
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
  for (const name of [
    "valid_canonical_state_binding",
    "valid_milestone_consistency_assessment",
  ])
    assert.equal(
      (
        await pool.query(
          "SELECT has_function_privilege('pdaa_api',$1,'EXECUTE') AS allowed",
          [`public.${name}(uuid)`],
        )
      ).rows[0].allowed,
      true,
    );
  const protectedFunctions = [
    "guard_project_fact_revision",
    "guard_fact_version_append",
    "guard_authority_policy",
    "reject_direct_fact_revision",
    "guard_fact_source_birth",
    "valid_canonical_state_binding",
    "guard_canonical_state_binding",
    "guard_canonical_state_binding_receipt",
    "require_canonical_state_binding_sealed",
    "valid_milestone_consistency_assessment",
    "guard_assessment_header",
    "guard_milestone_consistency_header",
    "guard_milestone_consistency_child",
    "require_milestone_consistency_sealed",
  ];
  const functions = (
    await pool.query(
      "SELECT proname,prosecdef,proconfig,pg_get_userbyid(proowner) AS owner,EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname=ANY($1)",
      [protectedFunctions],
    )
  ).rows;
  assert.equal(functions.length, protectedFunctions.length);
  assert(
    functions.every(
      (row) =>
        !row.prosecdef && row.owner === "pdaa_migrate" && !row.public_execute,
    ),
  );
  assert(
    functions.every((row) =>
      row.proconfig.includes("search_path=pg_catalog, public"),
    ),
  );
  return true;
}
export async function verifyMilestonePersistenceImmutable(pool) {
  guard();
  for (const table of milestonePersistenceTables) {
    assert(
      (await pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]
        .n > 0,
    );
    const identity =
      table === "MilestoneConsistencyContributorVersion"
        ? "assessmentId"
        : "id";
    await rejected(pool, `UPDATE "${table}" SET "${identity}"="${identity}"`);
    await rejected(pool, `DELETE FROM "${table}"`);
    await rejected(pool, `TRUNCATE "${table}" CASCADE`);
  }
  return true;
}
export async function verifyMilestonePersistenceWorkerDenials(connection) {
  guard();
  const { Pool } = await import("./common.mjs");
  const pool = new Pool(connection);
  try {
    assert.equal(
      (await pool.query("SELECT current_user AS role")).rows[0].role,
      "pdaa_worker",
    );
    for (const table of milestonePersistenceTables)
      await assert.rejects(
        () => pool.query(`SELECT count(*) FROM "${table}"`),
        (error) => error.code === "42501",
      );
    return true;
  } finally {
    await pool.end();
  }
}

// Real SQL transactions as pdaa_api, also repeated under restore quarantine.
// A successful clone must COMMIT before we count any rejection probes as useful.
export async function verifyMilestonePersistenceCommitGuards(
  pool,
  { assessmentId },
) {
  guard();
  assert.equal(typeof assessmentId, "string");
  const original = (
    await pool.query(
      `SELECT * FROM "MilestoneConsistencyAssessment"
    WHERE id=$1 AND sealed AND status='CONFLICTING'`,
      [assessmentId],
    )
  ).rows[0];
  assert(original, "A positive cross-proof fixture is required");
  const targets = (
    await pool.query(
      'SELECT * FROM "MilestoneConsistencyTarget" WHERE "assessmentId"=$1 ORDER BY id',
      [original.id],
    )
  ).rows;
  const contributors = (
    await pool.query(
      'SELECT * FROM "MilestoneConsistencyContributorVersion" WHERE "assessmentId"=$1 ORDER BY "targetRowId","versionId"',
      [original.id],
    )
  ).rows;
  const children = (
    await pool.query(
      'SELECT * FROM "FactAssessment" WHERE "milestoneAssessmentId"=$1 ORDER BY "factId"',
      [original.id],
    )
  ).rows;
  const insert = async (client, table, row) => {
    assert(
      [
        "MilestoneConsistencyAssessment",
        "MilestoneConsistencyTarget",
        "MilestoneConsistencyContributorVersion",
        "FactAssessment",
      ].includes(table),
    );
    await client.query(
      `INSERT INTO "${table}" SELECT (jsonb_populate_record(NULL::"${table}",$1::jsonb)).*`,
      [JSON.stringify(row)],
    );
  };
  const assemble = async (client, mode) => {
    const id = randomUUID(),
      auditEventId = randomUUID();
    const header = {
      ...original,
      id,
      auditEventId,
      idempotencyKey: randomUUID(),
      sealed: false,
      result: globalThis.structuredClone(original.result),
    };
    const disabled = ["disabled", "wrong-binding", "incomplete-child"].includes(
      mode,
    );
    const minimalIncomplete = ["incomplete", "hidden-scalar"].includes(mode);
    const incompleteChild = mode === "incomplete-child" ? children[0] : null;
    if (mode === "incomplete-child") assert(incompleteChild);
    if (disabled || minimalIncomplete) {
      header.status = disabled ? "DISABLED" : "INCOMPLETE";
      header.enabled = disabled ? false : original.enabled;
      header.complete = !minimalIncomplete;
      header.contributorCount = 0;
      header.result = {
        scope: original.result.scope,
        asOf: original.result.asOf,
        ruleRevision: original.ruleRevision,
        status: header.status,
      };
    }
    if (minimalIncomplete) {
      for (const count of [
        "targetCount",
        "requiredLinkCount",
        "versionCount",
        "evidenceCount",
        "conflictCount",
      ])
        header[count] = 0;
    }
    if (incompleteChild) {
      header.versionCount -= incompleteChild.versionCount;
      header.evidenceCount -= incompleteChild.versionCount;
      header.conflictCount -= incompleteChild.conflictCount;
    }
    if (mode.startsWith("null-")) header.result[mode.slice(5)] = null;
    await insert(client, "MilestoneConsistencyAssessment", header);
    await client.query(
      'INSERT INTO "AuditEvent" (id,"customerId",actor,event,"correlationId",detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        auditEventId,
        header.customerId,
        header.subject,
        "milestone.consistency.captured",
        "milestone-commit-probe",
        {
          projectId: header.projectId,
          assessmentId: id,
          milestoneId: header.milestoneId,
        },
      ],
    );
    if (mode === "unsealed") return id;
    const childIds = new Map();
    const clonedChildren = minimalIncomplete
      ? mode === "hidden-scalar"
        ? children.slice(0, 1)
        : []
      : children;
    if (mode === "hidden-scalar") assert.equal(clonedChildren.length, 1);
    for (const child of clonedChildren) {
      const childId = randomUUID();
      childIds.set(child.id, childId);
      const scalar = {
        ...child,
        id: childId,
        milestoneAssessmentId: id,
        idempotencyKey: randomUUID(),
        sealed: false,
      };
      if (child.id === incompleteChild?.id) {
        scalar.complete = false;
        scalar.versionCount = 0;
        scalar.conflictCount = 0;
        scalar.result = {
          ...child.result,
          complete: false,
          status: "INCOMPLETE",
          revalidationRequired: false,
          selectedTier: null,
          resolvedValue: null,
          candidateVersionIds: [],
          supportingVersionIds: [],
          supportingEvidenceIds: [],
          conflict: "NONE",
          conflicts: [],
          reconciliationRequired: false,
          versions: [],
        };
      }
      await insert(client, "FactAssessment", scalar);
      if (scalar.complete) {
        await client.query(
          `INSERT INTO "FactAssessmentVersion" SELECT av."customerId",av."projectId",av."factId",$1,av."versionId",sa.revision
        FROM "FactAssessmentVersion" av JOIN "ProjectFactVersion" v ON v.id=av."versionId" JOIN "FactSourceAccess" sa ON sa."sourceId"=v."sourceId" WHERE av."assessmentId"=$2`,
          [childId, child.id],
        );
        await client.query(
          'INSERT INTO "FactAssessmentConflict" SELECT "customerId","projectId","factId",$1,"conflictId" FROM "FactAssessmentConflict" WHERE "assessmentId"=$2',
          [childId, child.id],
        );
      }
      await client.query(
        'UPDATE "FactAssessment" SET sealed=true WHERE id=$1',
        [childId],
      );
      assert.equal(
        (
          await client.query(
            "SELECT public.valid_fact_assessment($1) AS valid",
            [childId],
          )
        ).rows[0].valid,
        true,
      );
    }
    const targetIds = new Map();
    const references = new Map(targets.map((target) => [target.id, target]));
    if (mode === "wrong-binding") {
      const milestone = targets.find(
        (target) => target.targetKind === "MILESTONE",
      );
      const work = targets.find((target) => target.targetKind === "WORK_ITEM");
      assert(milestone?.bindingId && work?.bindingId);
      references.set(milestone.id, work);
      references.set(work.id, milestone);
    }
    for (const target of minimalIncomplete ? [] : targets) {
      const targetId = randomUUID();
      targetIds.set(target.id, targetId);
      const reference = references.get(target.id);
      await insert(client, "MilestoneConsistencyTarget", {
        ...target,
        id: targetId,
        assessmentId: id,
        bindingId: reference.bindingId,
        factId: reference.factId,
        factType: reference.factType,
        scalarAssessmentId: childIds.get(reference.scalarAssessmentId),
      });
    }
    for (const [index, contributor] of (disabled || minimalIncomplete
      ? []
      : contributors
    ).entries()) {
      if (mode === "missing-contributor" && index === 0) continue;
      await insert(client, "MilestoneConsistencyContributorVersion", {
        ...contributor,
        assessmentId: id,
        targetRowId: targetIds.get(contributor.targetRowId),
      });
    }
    await client.query(
      'UPDATE "MilestoneConsistencyAssessment" SET sealed=true WHERE id=$1',
      [id],
    );
    return id;
  };
  const client = await pool.connect();
  const beginApi = async () => {
    await client.query("BEGIN");
    // Restored fixture owners are superusers; switch this transaction only.
    // Do not grant runtime CONNECT or change role membership under quarantine.
    await client.query("SET LOCAL ROLE pdaa_api");
    assert.equal(
      (await client.query("SELECT current_user AS role")).rows[0].role,
      "pdaa_api",
    );
  };
  try {
    let id;
    for (const mode of ["valid", "disabled", "incomplete"]) {
      await beginApi();
      const committedId = await assemble(client, mode);
      await client.query("COMMIT");
      if (mode === "valid") id = committedId;
      assert.equal(
        (
          await pool.query(
            'SELECT sealed AND public.valid_milestone_consistency_assessment(id) AS valid FROM "MilestoneConsistencyAssessment" WHERE id=$1',
            [committedId],
          )
        ).rows[0].valid,
        true,
      );
    }
    await beginApi();
    await assemble(client, "unsealed");
    await assert.rejects(
      () => client.query("COMMIT"),
      (error) =>
        error.code === "P0001" &&
        /Unsealed milestone consistency proof cannot commit/.test(
          error.message,
        ),
    );
    await client.query("ROLLBACK");
    for (const mode of [
      "null-status",
      "null-scope",
      "null-asOf",
      "null-ruleRevision",
      "missing-contributor",
      "wrong-binding",
      "incomplete-child",
      "hidden-scalar",
    ]) {
      await beginApi();
      await assert.rejects(
        () => assemble(client, mode),
        (error) =>
          error.code === "P0001" &&
          /Invalid milestone consistency seal/.test(error.message),
      );
      await client.query("ROLLBACK");
    }
    await beginApi();
    await assert.rejects(
      () =>
        insert(client, "MilestoneConsistencyTarget", {
          ...targets[0],
          id: randomUUID(),
          assessmentId: id,
        }),
      (error) =>
        error.code === "P0001" &&
        /Milestone consistency dependencies are sealed/.test(error.message),
    );
    await client.query("ROLLBACK");
    return {
      actualCommit: true,
      executedAs: "pdaa_api",
      sourceAssessmentId: original.id,
      completeCommitPassed: true,
      disabledCommitPassed: true,
      incompleteCommitPassed: true,
      unsealedCommitDenied: true,
      nullMetadataDenied: true,
      missingContributorDenied: true,
      typedBindingDenied: true,
      incompleteScalarDenied: true,
      hiddenScalarDenied: true,
      postSealInsertDenied: true,
      assessmentId: id,
    };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
export async function seedMilestonePersistence(
  owner,
  connection,
  customerId,
  projectId,
  prefix,
) {
  guard();
  const {
    createDatabase,
    DatabaseAuthorityRepository,
    DatabaseMilestoneConsistencyRepository,
    DatabaseProjectFactRepository,
  } = await import("../../packages/data/dist/index.js");
  const actor = {
    customerId,
    subject: prefix + "-milestone-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await owner.query(
    'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,$4,$5,$6)',
    [
      randomUUID(),
      customerId,
      actor.subject,
      "project",
      projectId,
      "pmo_admin",
    ],
  );
  const focal = (
    await owner.query(
      'SELECT id FROM "Milestone" WHERE "customerId"=$1 AND "projectId"=$2 ORDER BY id LIMIT 1',
      [customerId, projectId],
    )
  ).rows[0];
  const required = (
    await owner.query(
      'SELECT "workItemId" FROM "RequiredWorkItem" WHERE "customerId"=$1 AND "projectId"=$2 AND "milestoneId"=$3 ORDER BY id',
      [customerId, projectId, focal.id],
    )
  ).rows;
  assert(focal && required.length > 0);
  const db = createDatabase(connection);
  try {
    assert.equal(
      (await db.$queryRaw`SELECT current_user AS role`)[0].role,
      "pdaa_api",
    );
    const repository = new DatabaseMilestoneConsistencyRepository(db);
    const authority = new DatabaseAuthorityRepository(db);
    const facts = new DatabaseProjectFactRepository(db);
    const context = { correlationId: prefix + "-milestone" };
    const targets = [
      { targetKind: "MILESTONE", targetId: focal.id, initialState: "COMPLETE" },
      ...required.map((row) => ({
        targetKind: "WORK_ITEM",
        targetId: row.workItemId,
        initialState: "OPEN",
      })),
    ];
    const bindings = [];
    for (const target of targets) {
      const request = {
        projectId,
        ...target,
        idempotencyKey: randomUUID(),
        effectiveAt: "2026-09-01T00:00:00.000Z",
        validUntil: "2027-09-01T00:00:00.000Z",
        originalStatement: "Synthetic canonical state evidence",
      };
      const binding = await repository.createStateBinding(
        actor,
        request,
        context,
      );
      assert.equal(
        (await repository.createStateBinding(actor, request, context)).replayed,
        true,
      );
      await authority.appendPolicy(
        actor,
        {
          projectId,
          factType: binding.factType,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
          effectiveAt: "2026-09-01T00:00:00.000Z",
          definition: {
            tiers: [
              {
                selectors: [
                  {
                    sourceType: "human_statement",
                    instanceId: null,
                    requiredApproval: "NOT_REQUIRED",
                    validity: null,
                  },
                ],
              },
            ],
            conflictBehavior: "REQUEST_RECONCILIATION",
          },
        },
        context,
      );
      bindings.push(binding);
    }
    const capture = {
      projectId,
      milestoneId: focal.id,
      ruleRevision: "milestone-required-state/v1",
      enabled: true,
      idempotencyKey: randomUUID(),
    };
    const saved = await repository.captureMilestoneConsistency(
      actor,
      capture,
      context,
    );
    assert.equal(saved.result.status, "CONFLICTING");
    assert.equal(
      (await repository.captureMilestoneConsistency(actor, capture, context))
        .replayed,
      true,
    );
    const first = bindings[0];
    await facts.setSourceAccess(
      actor,
      {
        projectId,
        sourceId: first.entry.sourceId,
        expectedRevision: first.entry.sourceAccessRevision,
        state: "REVOKED",
        readers: [actor.subject],
      },
      context,
    );
    assert.equal(
      (
        await repository.getMilestoneConsistency(actor, {
          projectId,
          assessmentId: saved.assessmentId,
        })
      ).visibility,
      "restricted",
    );
    const access = await facts.getSourceAccess(actor, {
      projectId,
      sourceId: first.entry.sourceId,
    });
    await facts.setSourceAccess(
      actor,
      {
        projectId,
        sourceId: first.entry.sourceId,
        expectedRevision: access.revision,
        state: "AVAILABLE",
        readers: [actor.subject],
      },
      context,
    );
    const { Pool } = await import("./common.mjs");
    const runtime = new Pool(connection);
    let commitGuards;
    try {
      commitGuards = await verifyMilestonePersistenceCommitGuards(runtime, {
        assessmentId: saved.assessmentId,
      });
    } finally {
      await runtime.end();
    }
    return {
      runtimeRole: "pdaa_api",
      assessmentId: saved.assessmentId,
      bindings: bindings.length,
      status: "CONFLICTING",
      replayed: true,
      revokedDeliveryRestricted: true,
      commitGuards,
    };
  } finally {
    await db.$disconnect();
  }
}
