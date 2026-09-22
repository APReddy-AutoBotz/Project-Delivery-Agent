import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createDatabase,
  DatabaseProjectRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
  DatabaseMilestoneConsistencyRepository,
  DatabaseMilestoneReconciliationRepository,
} from "../../packages/data/dist/index.js";
import { ProjectFactError } from "../../packages/domain/dist/index.js";
import { PrismaClient } from "../../packages/data/dist/generated/prisma/client.js";
import { authorizeReconciliation } from "../../packages/data/dist/reconciliation-authorization.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { verifyReconciliationCommitGuards } from "./reconciliation-commit-probes.mjs";
import { verifyReconciliationRaces } from "./reconciliation-races.mjs";
import {
  observeTransactions,
  waitForTransactionBlockers,
} from "./transaction-latch.mjs";
import { runWithCleanup, drainAndClose } from "./fixture-cleanup.mjs";
import { createPriorReleaseDatabase } from "./prior-schema.mjs";
import { guard as isolatedGuard, secret } from "./common.mjs";
const require = createRequire(
  new URL("../../packages/data/package.json", import.meta.url),
);
const { Pool } = require("pg"),
  { PrismaPg } = require("@prisma/adapter-pg");
export const milestoneReconciliationTables = [
  "MilestoneReconciliationRequest",
  "MilestoneReconciliationCheck",
  "MilestoneReconciliationAssignment",
];
export function reconciliationAcceptanceGuard() {
  assert(
    ["isolated", "customer-composition"].includes(process.env.PDAA_ACCEPTANCE),
  );
  assert.match(
    process.env.PDAA_ACCEPTANCE_RUN_ID,
    /^pdaa-acceptance-\d+-[a-f0-9]{8}$/,
  );
  if (process.env.PDAA_ACCEPTANCE === "isolated") {
    isolatedGuard();
  } else {
    // Customer-mode tests use synthetic fixture content without enabling demo
    // seeding. Authenticate the generated composition, not DATA_MODE alone.
    const env = process.env;
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.DEPLOYMENT_MODE, "customer");
    assert.equal(env.DATA_MODE, "customer");
    assert.equal(env.CUSTOMER_ID, "10000000-0000-4000-8000-000000000002");
    assert.equal(env.CUSTOMER_NAME, "Controlled customer installation");
    assert.equal(env.PDAA_DB_NAME, "pdaa");
    assert(["bundled", "external"].includes(env.PDAA_CUSTOMER_PROFILE));
    assert.equal(
      env.PDAA_DB_HOST,
      env.PDAA_CUSTOMER_PROFILE === "bundled"
        ? "database"
        : "external-database",
    );
    assert.equal(
      env.PDAA_ARTIFACT_DIR,
      `/workspace/artifacts/${env.PDAA_ACCEPTANCE_RUN_ID}/customer-${env.PDAA_CUSTOMER_PROFILE}`,
    );
    assert.equal(secret("customer-ready"), "isolated customer composition\n");
  }
}
export async function milestoneReconciliationProjection(pool) {
  reconciliationAcceptanceGuard();
  const rows = {};
  for (const table of milestoneReconciliationTables)
    rows[table] = (
      await pool.query(
        `SELECT * FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
  return rows;
}
export async function verifyMilestoneReconciliationIntegrity(pool) {
  reconciliationAcceptanceGuard();
  assert.equal(
    (
      await pool.query(`SELECT
    (SELECT count(*)::int FROM "MilestoneReconciliationRequest" WHERE sealed IS NOT TRUE OR public.valid_milestone_reconciliation_request(id) IS NOT TRUE) +
    (SELECT count(*)::int FROM "MilestoneReconciliationCheck" WHERE public.valid_milestone_reconciliation_check(id) IS NOT TRUE) +
    (SELECT count(*)::int FROM "MilestoneReconciliationAssignment" WHERE public.valid_milestone_reconciliation_assignment(id) IS NOT TRUE) +
    (SELECT count(*)::int FROM "MilestoneConsistencyAssessment" a WHERE a."reconciliationCheckId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "MilestoneReconciliationCheck" c WHERE c.id=a."reconciliationCheckId" AND c."assessmentId"=a.id AND c."customerId"=a."customerId" AND c."projectId"=a."projectId"
    )) AS invalid`)
    ).rows[0].invalid,
    0,
  );
  return true;
}
export async function verifyMilestoneReconciliationPrivileges(pool) {
  reconciliationAcceptanceGuard();
  for (const table of milestoneReconciliationTables) {
    assert.equal(
      (
        await pool.query(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass",
          ['"' + table + '"'],
        )
      ).rows[0].owner,
      "pdaa_migrate",
    );
    const columns = (
      await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [table],
      )
    ).rows;
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
        const allowed =
          role === "pdaa_backup"
            ? privilege === "SELECT"
            : role === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege);
        for (const grantOption of [false, true])
          assert.equal(
            (
              await pool.query(
                "SELECT has_table_privilege($1,$2,$3) AS allowed",
                [
                  role,
                  '"' + table + '"',
                  privilege + (grantOption ? " WITH GRANT OPTION" : ""),
                ],
              )
            ).rows[0].allowed,
            grantOption ? false : allowed,
          );
      }
      for (const { column_name } of columns)
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          const allowed =
            role === "pdaa_backup"
              ? privilege === "SELECT"
              : role === "pdaa_api" &&
                (["SELECT", "INSERT"].includes(privilege) ||
                  (privilege === "UPDATE" &&
                    table === "MilestoneReconciliationRequest" &&
                    column_name === "sealed"));
          for (const grantOption of [false, true])
            assert.equal(
              (
                await pool.query(
                  "SELECT has_column_privilege($1,$2,$3,$4) AS allowed",
                  [
                    role,
                    '"' + table + '"',
                    column_name,
                    privilege + (grantOption ? " WITH GRANT OPTION" : ""),
                  ],
                )
              ).rows[0].allowed,
              grantOption ? false : allowed,
            );
        }
    }
  }
  const functions = [
    "valid_milestone_reconciliation_assignment(uuid)",
    "valid_milestone_reconciliation_request(uuid)",
    "valid_milestone_reconciliation_check(uuid)",
    "guard_milestone_reconciliation_request()",
    "guard_milestone_reconciliation_check()",
    "guard_milestone_reconciliation_assignment()",
    "require_milestone_reconciliation_complete()",
  ];
  for (const signature of functions) {
    const row = (
      await pool.query(
        "SELECT pg_get_userbyid(proowner) AS owner,prosecdef,proconfig,EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc WHERE oid=$1::regprocedure",
        ["public." + signature],
      )
    ).rows[0];
    assert.equal(row.owner, "pdaa_migrate");
    assert.equal(row.prosecdef, false);
    assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public"]);
    assert.equal(row.public_execute, false);
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"])
      for (const grantOption of [false, true])
        assert.equal(
          (
            await pool.query(
              "SELECT has_function_privilege($1,$2,$3) AS allowed",
              [
                role,
                "public." + signature,
                "EXECUTE" + (grantOption ? " WITH GRANT OPTION" : ""),
              ],
            )
          ).rows[0].allowed,
          !grantOption && role === "pdaa_api" && signature.startsWith("valid_"),
        );
  }
  for (const role of ["pdaa_api", "pdaa_worker"])
    assert.equal(
      (
        await pool.query(
          "SELECT has_column_privilege($1,'\"MilestoneConsistencyAssessment\"','reconciliationCheckId','UPDATE') AS allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
  return true;
}
export async function verifyMilestoneReconciliationImmutable(pool) {
  reconciliationAcceptanceGuard();
  const messages = {
    MilestoneReconciliationRequest: "Reconciliation request is immutable",
    MilestoneReconciliationCheck: "Reconciliation check is immutable",
    MilestoneReconciliationAssignment: "Reconciliation assignment is immutable",
  };
  const client = await pool.connect();
  try {
    for (const table of milestoneReconciliationTables) {
      assert(
        (await client.query(`SELECT count(*)::int AS n FROM "${table}"`))
          .rows[0].n > 0,
      );
      for (const operation of ["UPDATE", "DELETE", "TRUNCATE"]) {
        await client.query("BEGIN");
        try {
          const sql =
            operation === "UPDATE"
              ? `UPDATE "${table}" SET id=id`
              : operation === "DELETE"
                ? `DELETE FROM "${table}"`
                : `TRUNCATE "${table}" CASCADE`;
          await assert.rejects(
            () => client.query(sql),
            (error) =>
              error.code === "P0001" &&
              error.message ===
                (operation === "TRUNCATE"
                  ? "Fact history is immutable"
                  : operation === "UPDATE" &&
                      table === "MilestoneReconciliationRequest"
                    ? "Invalid reconciliation request seal"
                    : messages[table]),
          );
        } finally {
          await client.query("ROLLBACK");
        }
      }
    }
  } finally {
    client.release();
  }
  return true;
}
export async function verifyMilestoneReconciliationWorkerDenials(connection) {
  reconciliationAcceptanceGuard();
  const pool = new Pool(connection);
  try {
    assert.equal(
      (await pool.query("SELECT current_user AS role")).rows[0].role,
      "pdaa_worker",
    );
    for (const table of milestoneReconciliationTables)
      await assert.rejects(
        () => pool.query(`SELECT * FROM "${table}" LIMIT 1`),
        (error) => error.code === "42501",
      );
    return true;
  } finally {
    await pool.end();
  }
}
// FR-EVD-004/012 / GOLDEN-003: genuine synthetic human evidence; no Jira claim.
async function reserveFixture(
  owner,
  db,
  customerId,
  referenceProjectId,
  prefix,
  pmCount = 1,
) {
  const actor = {
      customerId,
      subject: prefix + "-pmo-" + randomUUID(),
      roles: ["pmo_admin"],
    },
    pm = {
      customerId,
      subject: prefix + "-pm-" + randomUUID(),
      roles: ["project_manager"],
    };
  const reference = (
    await owner.query(
      'SELECT "portfolioId" FROM "Project" WHERE "customerId"=$1 AND id=$2',
      [customerId, referenceProjectId],
    )
  ).rows[0];
  assert(reference);
  await owner.query(
    'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'portfolio\',$4,\'pmo_admin\')',
    [randomUUID(), customerId, actor.subject, reference.portfolioId],
  );
  const input = canonicalFixture(reference.portfolioId);
  input.responsibilities = Array.from({ length: pmCount }, (_, n) => ({
    role: "PROJECT_MANAGER",
    subject: n === 0 ? pm.subject : prefix + "-other-" + randomUUID(),
    displayName: "Synthetic configured PM",
  }));
  input.workItems = [1, 2, 3].map((n) => ({
    ...input.workItems[0],
    key: "WI-" + n,
  }));
  input.requiredWorkItems = [1, 2, 3].map((n) => ({
    milestoneKey: "MS-1",
    workItemKey: "WI-" + n,
  }));
  input.raidItems = [];
  input.sourceMappings = [];
  const context = { correlationId: "reconciliation-" + randomUUID() };
  const { id: projectId } = await new DatabaseCanonicalProjectRepository(
    db,
  ).createProject(actor, input, context.correlationId);
  await owner.query(
    'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'project\',$4,\'project_manager\')',
    [randomUUID(), customerId, pm.subject, projectId],
  );
  const milestone = await db.milestone.findFirstOrThrow({
    where: { customerId, projectId, key: "MS-1" },
  });
  const links = await db.requiredWorkItem.findMany({
    where: { customerId, projectId, milestoneId: milestone.id },
    orderBy: { id: "asc" },
  });
  assert.equal(links.length, 3);
  const repository = new DatabaseMilestoneReconciliationRepository(db),
    facts = new DatabaseProjectFactRepository(db),
    authority = new DatabaseAuthorityRepository(db),
    bindings = [];
  for (const target of [
    {
      targetKind: "MILESTONE",
      targetId: milestone.id,
      initialState: "COMPLETE",
    },
    ...links.map((link) => ({
      targetKind: "WORK_ITEM",
      targetId: link.workItemId,
      initialState: "OPEN",
    })),
  ]) {
    const binding = await repository.createStateBinding(
      actor,
      {
        projectId,
        ...target,
        idempotencyKey: randomUUID(),
        effectiveAt: "2026-09-01T00:00:00.000Z",
        validUntil: "2027-09-01T00:00:00.000Z",
        originalStatement: "Synthetic confirmed " + target.initialState,
      },
      context,
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
    await facts.setSourceAccess(
      actor,
      {
        projectId,
        sourceId: binding.entry.sourceId,
        expectedRevision: binding.entry.sourceAccessRevision,
        state: "AVAILABLE",
        readers: [actor.subject, pm.subject],
      },
      context,
    );
    bindings.push(binding);
  }
  return { actor, pm, projectId, milestoneId: milestone.id, bindings, context };
}
export async function runMilestoneReconciliationCommitProbes(
  connection,
  fixtures,
) {
  return verifyReconciliationCommitGuards({
    connection,
    ...fixtures,
    allowRun: reconciliationAcceptanceGuard,
    Pool,
    PrismaPg,
    PrismaClient,
    DatabaseMilestoneConsistencyRepository,
    authorizeReconciliation,
  });
}
export async function runMilestoneReconciliationRaces(
  owner,
  connection,
  customerId,
  referenceProjectId,
  prefix,
) {
  return verifyReconciliationRaces({
    owner,
    connection,
    customerId,
    referenceProjectId,
    prefix,
    reserveFixture,
    allowRun: reconciliationAcceptanceGuard,
    createDatabase,
    Pool,
    ProjectFactError,
    DatabaseMilestoneReconciliationRepository,
    DatabaseProjectFactRepository,
    DatabaseProjectRepository,
    observeTransactions,
    waitForTransactionBlockers,
    runWithCleanup,
    drainAndClose,
  });
}
async function seedReconciliationWorkflow(
  owner,
  connection,
  customerId,
  referenceProjectId,
  prefix,
  { reserveForRestore = false, priorSix = false } = {},
) {
  reconciliationAcceptanceGuard();
  const db = priorSix
    ? createPriorReleaseDatabase(connection, 6)
    : createDatabase(connection);
  try {
    if (priorSix) {
      const prefix = await owner.query(`SELECT
        (SELECT count(*)::int FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS completed,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='FactAssessment' AND column_name='scalarReconciliationCheckId') AS forward_owner`);
      assert.deepEqual(prefix.rows, [{ completed: 6, forward_owner: false }]);
    }
    assert.equal(
      (await db.$queryRaw`SELECT current_user AS role`)[0].role,
      "pdaa_api",
    );
    const f = await reserveFixture(
        owner,
        db,
        customerId,
        referenceProjectId,
        prefix,
      ),
      repository = new DatabaseMilestoneReconciliationRepository(db),
      facts = new DatabaseProjectFactRepository(db);
    const command = {
      projectId: f.projectId,
      milestoneId: f.milestoneId,
      ruleRevision: "milestone-required-state/v1",
      enabled: true,
      idempotencyKey: randomUUID(),
    };
    const first = await repository.check(f.actor, command, f.context);
    assert.equal(first.outcome, "CREATED");
    assert.equal(first.request.assignment.recipientSubject, f.pm.subject);
    const reused = await repository.check(
      f.pm,
      { ...command, idempotencyKey: randomUUID() },
      f.context,
    );
    assert.equal(reused.outcome, "REUSED");
    assert.equal(reused.request.id, first.request.id);
    assert.notEqual(
      reused.assessment.assessmentId,
      first.assessment.assessmentId,
    );
    assert.equal(
      (await repository.check(f.actor, command, f.context)).replayed,
      true,
    );
    const read = { projectId: f.projectId, requestId: first.request.id };
    const original = await repository.get(f.pm, read);
    assert.equal(
      original.assessment.assessmentId,
      first.assessment.assessmentId,
    );
    assert.equal(original.assessment.result.contributors.length, 4);
    assert.equal(await repository.get(f.actor, read), null);
    const sourceId = f.bindings[3].entry.sourceId;
    let access = await facts.getSourceAccess(f.actor, {
      projectId: f.projectId,
      sourceId,
    });
    await facts.setSourceAccess(
      f.actor,
      {
        projectId: f.projectId,
        sourceId,
        expectedRevision: access.revision,
        state: "AVAILABLE",
        readers: [f.actor.subject],
      },
      f.context,
    );
    assert.equal((await repository.get(f.pm, read)).assessment.result, null);
    access = await facts.getSourceAccess(f.actor, {
      projectId: f.projectId,
      sourceId,
    });
    await facts.setSourceAccess(
      f.actor,
      {
        projectId: f.projectId,
        sourceId,
        expectedRevision: access.revision,
        state: "AVAILABLE",
        readers: [f.actor.subject, f.pm.subject],
      },
      f.context,
    );
    assert.deepEqual(
      (await repository.get(f.pm, read)).assessment,
      original.assessment,
    );
    const refresh = {
      ...read,
      expectedAssignmentRevision: 1,
      idempotencyKey: randomUUID(),
    };
    assert.equal(
      (await repository.refreshAssignment(f.actor, refresh, f.context))
        .assignment.revision,
      2,
    );
    assert.equal(
      (await repository.refreshAssignment(f.actor, refresh, f.context))
        .replayed,
      true,
    );
    const disabled = await repository.check(
      f.actor,
      { ...command, enabled: false, idempotencyKey: randomUUID() },
      f.context,
    );
    assert.equal(disabled.outcome, "NO_REQUEST");
    const unassigned = await reserveFixture(
      owner,
      db,
      customerId,
      referenceProjectId,
      prefix + "-unassigned",
      0,
    );
    const pending = await repository.check(
      unassigned.actor,
      {
        ...command,
        projectId: unassigned.projectId,
        milestoneId: unassigned.milestoneId,
        idempotencyKey: randomUUID(),
      },
      unassigned.context,
    );
    assert.equal(pending.request.assignment.reason, "NO_CONFIGURED_PM");
    // Remove a once-valid recipient grant: historical integrity must not depend on it.
    await owner.query(
      'DELETE FROM "AccessGrant" WHERE "customerId"=$1 AND subject=$2 AND "scopeType"=\'project\' AND "scopeId"=$3',
      [customerId, f.pm.subject, f.projectId],
    );
    assert.equal(await repository.get(f.pm, read), null);
    assert.equal(
      (
        await repository.refreshAssignment(
          f.actor,
          {
            ...refresh,
            expectedAssignmentRevision: 2,
            idempotencyKey: randomUUID(),
          },
          f.context,
        )
      ).assignment.reason,
      "PM_SCOPE_UNAVAILABLE",
    );
    if (priorSix) {
      // Genuine released data only. Current-client adversarial probes must run
      // after upgrade, never against a prefix missing their generated columns.
      await verifyMilestoneReconciliationIntegrity(owner);
      return {
        purpose: "retained-release-six-history",
        runtimeRole: "pdaa_api",
        actor: f.actor,
        pm: f.pm,
        context: f.context,
        command,
        refresh,
        checkId: first.checkId,
        requestId: first.request.id,
        originalAssessmentId: first.assessment.assessmentId,
        originalAssessment: original.assessment,
        reusedCheckId: reused.checkId,
        disabledCheckId: disabled.checkId,
        unassignedRequestId: pending.request.id,
        nativeProbesExecuted: false,
      };
    }
    const positiveFixture = await reserveFixture(
        owner,
        db,
        customerId,
        referenceProjectId,
        prefix + "-positive",
      ),
      negativeFixture = await reserveFixture(
        owner,
        db,
        customerId,
        referenceProjectId,
        prefix + "-negative",
      );
    const commitGuards = await runMilestoneReconciliationCommitProbes(
      connection,
      { positiveFixture, negativeFixture },
    );
    const restoreProbes = reserveForRestore
      ? {
          positiveFixture: await reserveFixture(
            owner,
            db,
            customerId,
            referenceProjectId,
            prefix + "-restore-positive",
          ),
          negativeFixture: await reserveFixture(
            owner,
            db,
            customerId,
            referenceProjectId,
            prefix + "-restore-negative",
          ),
        }
      : null;
    const raceGuards = await runMilestoneReconciliationRaces(
      owner,
      connection,
      customerId,
      referenceProjectId,
      prefix + "-races",
    );
    await verifyMilestoneReconciliationIntegrity(owner);
    return {
      runtimeRole: "pdaa_api",
      requestId: first.request.id,
      originalAssessmentId: first.assessment.assessmentId,
      reusedCheckId: reused.checkId,
      disabledCheckId: disabled.checkId,
      unassignedRequestId: pending.request.id,
      commitGuards,
      raceGuards,
      restoreProbes,
    };
  } finally {
    await db.$disconnect();
  }
}

export function seedMilestoneReconciliation(
  owner,
  connection,
  customerId,
  referenceProjectId,
  prefix,
  { reserveForRestore = false } = {},
) {
  return seedReconciliationWorkflow(
    owner,
    connection,
    customerId,
    referenceProjectId,
    prefix,
    { reserveForRestore },
  );
}

// FR-EVD-004/007/012: explicit prior-data producer, not a probe-skipping option
// on the current acceptance workflow. Its output is not a native-probe receipt.
export function seedPriorSixMilestoneReconciliation(
  owner,
  connection,
  customerId,
  referenceProjectId,
  prefix,
) {
  return seedReconciliationWorkflow(
    owner,
    connection,
    customerId,
    referenceProjectId,
    prefix,
    { priorSix: true },
  );
}

export async function verifyRetainedPriorSixReconciliation(
  owner,
  connection,
  retained,
) {
  reconciliationAcceptanceGuard();
  assert.equal(retained.purpose, "retained-release-six-history");
  assert.equal(retained.nativeProbesExecuted, false);
  const db = createDatabase(connection);
  try {
    assert.equal(
      (await db.$queryRaw`SELECT current_user AS role`)[0].role,
      "pdaa_api",
    );
    const repository = new DatabaseMilestoneReconciliationRepository(db);
    const read = {
      projectId: retained.command.projectId,
      requestId: retained.requestId,
    };
    const replay = await repository.check(
      retained.actor,
      retained.command,
      retained.context,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.checkId, retained.checkId);
    assert.equal(replay.request.id, retained.requestId);
    assert.equal(replay.assessment.assessmentId, retained.originalAssessmentId);
    assert.equal(replay.request.assignment.reason, "PM_SCOPE_UNAVAILABLE");
    assert.equal(await repository.get(retained.pm, read), null);
    await owner.query(
      'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'project\',$4,\'project_manager\')',
      [
        randomUUID(),
        retained.actor.customerId,
        retained.pm.subject,
        read.projectId,
      ],
    );
    // A restored grant alone cannot silently replace historical assignment.
    assert.equal(await repository.get(retained.pm, read), null);
    const refreshed = await repository.refreshAssignment(
      retained.actor,
      {
        ...read,
        expectedAssignmentRevision: replay.request.assignment.revision,
        idempotencyKey: randomUUID(),
      },
      retained.context,
    );
    assert.equal(refreshed.assignment.reason, "ASSIGNED");
    const delivered = await repository.get(retained.pm, read);
    assert.deepEqual(delivered.assessment, retained.originalAssessment);
    await verifyMilestoneReconciliationIntegrity(owner);
    return {
      originalCheckId: retained.checkId,
      originalRequestId: retained.requestId,
      originalAssessmentId: retained.originalAssessmentId,
      originalReplayed: true,
      revokedRecipientDenied: true,
      regrantDidNotReroute: true,
      originalProofDelivered: true,
    };
  } finally {
    await db.$disconnect();
  }
}
