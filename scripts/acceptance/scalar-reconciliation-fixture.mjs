// FR-EVD-007/009/012: synthetic actual-role workflow and original restore proof.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
  DatabaseScalarReconciliationRepository,
} from "../../packages/data/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import { verifyScalarReconciliationIntegrity } from "./scalar-reconciliation.mjs";
import { assertAvailableScalarOriginal } from "./scalar-reconciliation-recovery-receipt.mjs";

export async function reserveScalarFixture(
  owner,
  db,
  customerId,
  referenceProjectId,
  prefix,
  {
    configured = true,
    optedIn = true,
    pmSubject,
    values = [
      { type: "date", value: "2026-10-01" },
      { type: "date", value: "2026-10-02" },
    ],
  } = {},
) {
  reconciliationAcceptanceGuard();
  // Only the natural-expiry primary fixture may bind its existing OIDC manager.
  assert(
    pmSubject === undefined ||
      (process.env.PDAA_ACCEPTANCE === "isolated" && pmSubject === "pm-atlas"),
  );
  assert.equal(values.length, 2);
  const reference = (
    await owner.query(
      'SELECT "portfolioId" FROM "Project" WHERE "customerId"=$1 AND id=$2',
      [customerId, referenceProjectId],
    )
  ).rows[0];
  assert(reference);
  const actor = {
    customerId,
    subject: prefix + "-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  const pm = {
    customerId,
    subject: pmSubject ?? prefix + "-pm-" + randomUUID(),
    roles: ["project_manager"],
  };
  await owner.query(
    'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'portfolio\',$4,\'pmo_admin\')',
    [randomUUID(), customerId, actor.subject, reference.portfolioId],
  );
  const context = { correlationId: "scalar-fixture-" + randomUUID() };
  let projectId;
  if (configured) {
    const input = canonicalFixture(reference.portfolioId);
    input.responsibilities = [
      {
        role: "PROJECT_MANAGER",
        subject: pm.subject,
        displayName: "Synthetic scalar PM",
      },
    ];
    projectId = (
      await new DatabaseCanonicalProjectRepository(db).createProject(
        actor,
        input,
        context.correlationId,
      )
    ).id;
  } else {
    projectId = randomUUID();
    await db.project.create({
      data: {
        id: projectId,
        customerId,
        portfolioId: reference.portfolioId,
        code: "LEG-" + randomUUID(),
        name: "Synthetic legacy scalar project",
        description: "No invented canonical configuration",
        reportedStatus: "UNKNOWN",
      },
    });
  }
  const pmGrantId = randomUUID();
  await owner.query(
    'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'project\',$4,\'project_manager\')',
    [pmGrantId, customerId, pm.subject, projectId],
  );
  const facts = new DatabaseProjectFactRepository(db),
    authority = new DatabaseAuthorityRepository(db);
  const factType = "project.forecast",
    effectiveAt = new Date(Date.now() - 1000).toISOString();
  const versions = [];
  let factId;
  for (const [revision, writer] of [actor, pm].entries()) {
    const result = await facts.appendHumanStatement(
      writer,
      {
        projectId,
        factType,
        expectedRevision: revision,
        idempotencyKey: randomUUID(),
        effectiveAt,
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        originalStatement: "Synthetic disputed scalar forecast " + revision,
        value: values[revision],
      },
      context,
    );
    factId = result.factId;
    versions.push(result.entry);
    const access = await facts.getSourceAccess(actor, {
      projectId,
      sourceId: result.entry.sourceId,
    });
    await facts.setSourceAccess(
      actor,
      {
        projectId,
        sourceId: result.entry.sourceId,
        expectedRevision: access.revision,
        state: "AVAILABLE",
        readers: [actor.subject, pm.subject],
      },
      context,
    );
  }
  await authority.appendPolicy(
    actor,
    {
      projectId,
      factType,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      effectiveAt,
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
        conflictBehavior: optedIn
          ? "REQUEST_RECONCILIATION"
          : "RETAIN_CONFLICT",
      },
    },
    context,
  );
  return {
    actor,
    pm,
    pmGrantId,
    projectId,
    factId,
    factType,
    context,
    versions,
    command: { projectId, factId, idempotencyKey: randomUUID() },
  };
}

export async function seedScalarReconciliation(
  owner,
  connection,
  customerId,
  referenceProjectId,
  prefix,
) {
  reconciliationAcceptanceGuard();
  const db = createDatabase(connection);
  try {
    assert.equal(
      (await db.$queryRaw`SELECT current_user AS role`)[0].role,
      "pdaa_api",
    );
    const f = await reserveScalarFixture(
      owner,
      db,
      customerId,
      referenceProjectId,
      prefix,
    );
    const repository = new DatabaseScalarReconciliationRepository(db),
      facts = new DatabaseProjectFactRepository(db);
    const first = await repository.check(f.actor, f.command, f.context);
    assert.equal(first.outcome, "CREATED");
    assert.equal(first.request.assignment.recipientSubject, f.pm.subject);
    const reused = await repository.check(
      f.pm,
      { ...f.command, idempotencyKey: randomUUID() },
      f.context,
    );
    assert.equal(reused.outcome, "REUSED");
    assert.equal(reused.request.id, first.request.id);
    assert.notEqual(
      reused.assessment.assessmentId,
      first.assessment.assessmentId,
    );
    assert.equal(
      (await repository.check(f.actor, f.command, f.context)).replayed,
      true,
    );
    const read = { projectId: f.projectId, requestId: first.request.id };
    const original = await repository.get(f.pm, read);
    assertAvailableScalarOriginal(original.assessment, customerId, f.command);
    assert.deepEqual(
      original.assessment.result.versions.map((version) => version.id).sort(),
      f.versions.map((version) => version.id).sort(),
    );
    assert.deepEqual(
      original.assessment.result.versions
        .flatMap((version) => version.evidenceIds)
        .sort(),
      f.versions.map((version) => version.evidenceId).sort(),
    );
    assert.equal(
      original.assessment.assessmentId,
      first.assessment.assessmentId,
    );
    assert.equal(await repository.get(f.actor, read), null);
    const sourceId = f.versions[0].sourceId;
    for (const withdraw of [true, false]) {
      const access = await facts.getSourceAccess(f.actor, {
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
          readers: withdraw
            ? [f.actor.subject]
            : [f.actor.subject, f.pm.subject],
        },
        f.context,
      );
      const delivered = await repository.get(f.pm, read);
      if (withdraw) {
        assert.equal(delivered.assessment.visibility, "restricted");
        assert.equal(delivered.assessment.revalidationRequired, true);
        assert.equal(delivered.assessment.result, null);
      } else {
        assertAvailableScalarOriginal(
          delivered.assessment,
          customerId,
          f.command,
        );
        assert.deepEqual(delivered.assessment, original.assessment);
      }
    }
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
    const negative = await reserveScalarFixture(
      owner,
      db,
      customerId,
      referenceProjectId,
      prefix + "-negative",
      { optedIn: false },
    );
    const noRequest = await repository.check(
      negative.actor,
      negative.command,
      negative.context,
    );
    assert.equal(noRequest.outcome, "NO_REQUEST");
    assert.equal(noRequest.request, null);
    const legacy = await reserveScalarFixture(
      owner,
      db,
      customerId,
      referenceProjectId,
      prefix + "-legacy",
      { configured: false },
    );
    const unassigned = await repository.check(
      legacy.actor,
      legacy.command,
      legacy.context,
    );
    assert.equal(unassigned.outcome, "CREATED");
    assert.equal(unassigned.request.assignment.reason, "NO_CONFIGURED_PM");
    await owner.query(
      'DELETE FROM "AccessGrant" WHERE id=$1 AND "customerId"=$2',
      [f.pmGrantId, customerId],
    );
    assert.equal(await repository.get(f.pm, read), null);
    const pending = await repository.refreshAssignment(
      f.actor,
      {
        ...refresh,
        expectedAssignmentRevision: 2,
        idempotencyKey: randomUUID(),
      },
      f.context,
    );
    assert.equal(pending.assignment.reason, "PM_SCOPE_UNAVAILABLE");
    await verifyScalarReconciliationIntegrity(owner);
    return {
      family: "scalar-reconciliation/v1",
      runtimeRole: "pdaa_api",
      actor: f.actor,
      pm: f.pm,
      context: f.context,
      command: f.command,
      requestId: first.request.id,
      checkId: first.checkId,
      originalAssessmentId: first.assessment.assessmentId,
      originalAssessment: original.assessment,
      reusedCheckId: reused.checkId,
      noRequestCheckId: noRequest.checkId,
      unassignedRequestId: unassigned.request.id,
      pendingAssignmentId: pending.assignment.id,
      pendingRevision: pending.assignment.revision,
      sourceWithdrawalWithheld: true,
      restoredSourceDeliveredOriginal: true,
      revokedRecipientDenied: true,
      sameKeyReplayed: true,
      businessReused: true,
    };
  } finally {
    await db.$disconnect();
  }
}

export async function verifyRestoredScalarReconciliation(
  owner,
  connection,
  fixture,
  expectedAdministrator,
) {
  reconciliationAcceptanceGuard();
  assert(["fixture_admin", "postgres"].includes(expectedAdministrator));
  assert.equal(fixture.family, "scalar-reconciliation/v1");
  assertAvailableScalarOriginal(
    fixture.originalAssessment,
    fixture.actor.customerId,
    fixture.command,
  );
  const db = createDatabase(connection);
  try {
    const principal = (await db.$queryRaw`SELECT current_user AS role`)[0].role;
    // Restores stay runtime-quarantined: caller supplies the authorized restore
    // administrator, never temporarily enables API CONNECT to make this pass.
    assert.equal(principal, expectedAdministrator);
    let runtimeTransactions = 0;
    const restrictedTransaction = (callback, options) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        const role = (
          await tx.$queryRaw`SELECT current_user AS role, session_user AS login`
        )[0];
        assert.equal(role.role, "pdaa_api");
        assert.equal(role.login, expectedAdministrator);
        runtimeTransactions += 1;
        return callback(tx);
      }, options);
    const restricted = {
      $transaction: restrictedTransaction,
      // Repository error audits must not accidentally regain owner privileges.
      auditEvent: {
        create: (args) =>
          restrictedTransaction((tx) => tx.auditEvent.create(args), {
            isolationLevel: "ReadCommitted",
            maxWait: 5000,
            timeout: 10000,
          }),
      },
    };
    const repository = new DatabaseScalarReconciliationRepository(restricted);
    const result = await repository.check(
      fixture.actor,
      fixture.command,
      fixture.context,
    );
    assert.equal(result.checkId, fixture.checkId);
    assert.equal(result.replayed, true);
    assert.equal(result.request.id, fixture.requestId);
    assert.equal(result.assessment.assessmentId, fixture.originalAssessmentId);
    assert.deepEqual(result.assessment, {
      ...fixture.originalAssessment,
      replayed: true,
    });
    assert.equal(result.request.assignment.id, fixture.pendingAssignmentId);
    assert.equal(result.request.assignment.reason, "PM_SCOPE_UNAVAILABLE");
    const read = {
      projectId: fixture.command.projectId,
      requestId: fixture.requestId,
    };
    assert.equal(await repository.get(fixture.pm, read), null);
    await owner.query(
      'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'project\',$4,\'project_manager\')',
      [
        randomUUID(),
        fixture.actor.customerId,
        fixture.pm.subject,
        read.projectId,
      ],
    );
    assert.equal(await repository.get(fixture.pm, read), null);
    const refreshed = await repository.refreshAssignment(
      fixture.actor,
      {
        ...read,
        expectedAssignmentRevision: fixture.pendingRevision,
        idempotencyKey: randomUUID(),
      },
      fixture.context,
    );
    assert.equal(refreshed.assignment.reason, "ASSIGNED");
    assert.deepEqual(
      (await repository.get(fixture.pm, read)).assessment,
      fixture.originalAssessment,
    );
    await verifyScalarReconciliationIntegrity(owner);
    return {
      family: fixture.family,
      executedAs: principal,
      runtimeRole: "pdaa_api",
      runtimeTransactions,
      originalRequestId: fixture.requestId,
      originalCheckId: fixture.checkId,
      originalAssessmentId: fixture.originalAssessmentId,
      originalReplayed: true,
      revokedRecipientDenied: true,
      regrantDidNotReroute: true,
      originalProofDelivered: true,
    };
  } finally {
    await db.$disconnect();
  }
}
