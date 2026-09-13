import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
  DatabaseScalarReconciliationRepository,
} from "../packages/data/dist/index.js";
import {
  scalarReconciliationIdentity,
  type Actor,
} from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname))
  throw new Error("Scalar integration requires an isolated synthetic database");
const db = createDatabase(url),
  customerId = process.env.CUSTOMER_ID!;
const facts = new DatabaseProjectFactRepository(db),
  authority = new DatabaseAuthorityRepository(db),
  reconciliation = new DatabaseScalarReconciliationRepository(db),
  canonical = new DatabaseCanonicalProjectRepository(db);
const context = { correlationId: "scalar-reconciliation-integration" };
afterAll(async () => db.$disconnect());
async function fixture(configured = true, optedIn = true) {
  const portfolioId = randomUUID();
  const pmo: Actor = {
    customerId,
    subject: "scalar-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  const pm: Actor = {
    customerId,
    subject: "scalar-pm-" + randomUUID(),
    roles: ["project_manager"],
  };
  const leader: Actor = {
    customerId,
    subject: "scalar-leader-" + randomUUID(),
    roles: ["leadership"],
  };
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Synthetic scalar requests" },
  });
  for (const actor of [pmo, pm, leader])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: actor.roles[0]!,
      },
    });
  let projectId: string;
  if (configured) {
    const input = canonicalFixture(portfolioId);
    input.responsibilities = [
      {
        role: "PROJECT_MANAGER",
        subject: pm.subject,
        displayName: "Scalar PM",
      },
    ];
    projectId = (
      await canonical.createProject(pmo, input, context.correlationId)
    ).id;
  } else {
    projectId = randomUUID();
    await db.project.create({
      data: {
        id: projectId,
        customerId,
        portfolioId,
        code: randomUUID(),
        name: "Legacy scalar project",
        description: "Synthetic",
        reportedStatus: "UNKNOWN",
      },
    });
  }
  const factType = "project.forecast",
    effectiveAt = new Date(Date.now() - 1000).toISOString();
  const versions = [];
  for (const [index, actor] of [pmo, pm].entries()) {
    const result = await facts.appendHumanStatement(
      actor,
      {
        projectId,
        factType,
        expectedRevision: index,
        idempotencyKey: randomUUID(),
        effectiveAt,
        validUntil: new Date(Date.now() + 3600000).toISOString(),
        originalStatement: "Synthetic disputed forecast",
        value: {
          type: "date",
          value: index === 0 ? "2026-10-01" : "2026-10-02",
        },
      },
      context,
    );
    versions.push(result.entry);
    const access = await facts.getSourceAccess(pmo, {
      projectId,
      sourceId: result.entry.sourceId,
    });
    await facts.setSourceAccess(
      pmo,
      {
        projectId,
        sourceId: result.entry.sourceId,
        expectedRevision: access!.revision,
        state: "AVAILABLE",
        readers: [pmo.subject, pm.subject, leader.subject],
      },
      context,
    );
  }
  await authority.appendPolicy(
    pmo,
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
  const fact = await db.projectFact.findFirstOrThrow({
    where: { customerId, projectId, factType },
  });
  const input = { projectId, factId: fact.id, idempotencyKey: randomUUID() };
  return { pmo, pm, leader, projectId, factType, input, versions };
}
it("FR-EVD-007/012: commits owned scalar proof, byte-identical SQL identity and distinct retry/business reuse", async () => {
  const f = await fixture();
  const first = await reconciliation.check(f.pmo, f.input, context);
  expect(first.outcome).toBe("CREATED");
  expect(first.request?.assignment.reason).toBe("ASSIGNED");
  const proof = await db.factAssessment.findUniqueOrThrow({
    where: { id: first.assessment.assessmentId },
  });
  expect(proof.captureKind).toBe("SCALAR_REQUEST");
  expect(proof.scalarReconciliationCheckId).toBe(first.checkId);
  const sql = await db.$queryRaw<
    { identity: string; valid: boolean }[]
  >`SELECT public.scalar_reconciliation_identity(${proof.id}::uuid) AS identity,public.valid_scalar_reconciliation_check(${first.checkId}::uuid) AS valid`;
  expect(sql[0]?.valid).toBe(true);
  expect(sql[0]?.identity).toBe(scalarReconciliationIdentity(proof.result));
  const replay = await reconciliation.check(f.pmo, f.input, context);
  expect(replay.checkId).toBe(first.checkId);
  expect(replay.replayed).toBe(true);
  const reused = await reconciliation.check(
    f.pmo,
    { ...f.input, idempotencyKey: randomUUID() },
    context,
  );
  expect(reused.outcome).toBe("REUSED");
  expect(reused.request?.id).toBe(first.request?.id);
  expect(reused.assessment.assessmentId).not.toBe(proof.id);
  expect(reused.request?.assignment).toEqual(first.request?.assignment);
  expect(
    await reconciliation.check(
      f.pm,
      { ...f.input, idempotencyKey: randomUUID() },
      context,
    ),
  ).toMatchObject({ outcome: "REUSED" });
  const detail = await reconciliation.get(f.pm, {
    projectId: f.projectId,
    requestId: first.request!.id,
  });
  expect(detail?.assessment.assessmentId).toBe(proof.id);
  expect(
    await reconciliation.get(f.pmo, {
      projectId: f.projectId,
      requestId: first.request!.id,
    }),
  ).toBeNull();
});
it("FR-ADM-005: persists an owned negative check for explicit policy opt-out", async () => {
  const f = await fixture(true, false),
    result = await reconciliation.check(f.pmo, f.input, context);
  expect(result.outcome).toBe("NO_REQUEST");
  expect(result.request).toBeNull();
  const valid = await db.$queryRaw<
    { valid: boolean }[]
  >`SELECT public.valid_scalar_reconciliation_check(${result.checkId}::uuid) AS valid`;
  expect(valid[0]?.valid).toBe(true);
});
it("FR-EVD-009: preserves legacy unassigned requests and append-only assignment CAS/retry", async () => {
  const f = await fixture(false),
    first = await reconciliation.check(f.pmo, f.input, context);
  expect(first.outcome).toBe("CREATED");
  expect(first.request?.assignment.reason).toBe("NO_CONFIGURED_PM");
  const input = {
    projectId: f.projectId,
    requestId: first.request!.id,
    expectedAssignmentRevision: 1,
    idempotencyKey: randomUUID(),
  };
  const refreshed = await reconciliation.refreshAssignment(
    f.pmo,
    input,
    context,
  );
  expect(refreshed.assignment.revision).toBe(2);
  expect(refreshed.assignment.reason).toBe("NO_CONFIGURED_PM");
  expect(await reconciliation.refreshAssignment(f.pmo, input, context)).toEqual(
    { ...refreshed, replayed: true },
  );
  await expect(
    reconciliation.refreshAssignment(
      f.pmo,
      { ...input, idempotencyKey: randomUUID() },
      context,
    ),
  ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  expect(
    await reconciliation.get(f.pm, {
      projectId: f.projectId,
      requestId: first.request!.id,
    }),
  ).toBeNull();
});
it("NFR-SEC-001: ordinary leadership capture cannot create requests; current source loss withholds old proof and replay", async () => {
  const f = await fixture(),
    first = await reconciliation.check(f.pmo, f.input, context);
  await expect(
    reconciliation.check(
      f.leader,
      { ...f.input, idempotencyKey: randomUUID() },
      context,
    ),
  ).rejects.toMatchObject({ code: "DENIED" });
  expect(
    await authority.getAssessment(f.leader, {
      projectId: f.projectId,
      assessmentId: first.assessment.assessmentId,
    }),
  ).toMatchObject({ visibility: "available" });
  const sourceId = f.versions[0]!.sourceId,
    access = await facts.getSourceAccess(f.pmo, {
      projectId: f.projectId,
      sourceId,
    });
  await facts.setSourceAccess(
    f.pmo,
    {
      projectId: f.projectId,
      sourceId,
      expectedRevision: access!.revision,
      state: "AVAILABLE",
      readers: [f.leader.subject],
    },
    context,
  );
  expect(
    await reconciliation.get(f.pm, {
      projectId: f.projectId,
      requestId: first.request!.id,
    }),
  ).toMatchObject({ assessment: { visibility: "restricted", result: null } });
  expect(await reconciliation.check(f.pmo, f.input, context)).toMatchObject({
    checkId: first.checkId,
    replayed: true,
    outcome: "CREATED",
    assessment: { visibility: "restricted", result: null },
  });
  expect(
    await reconciliation.check(
      f.pmo,
      { ...f.input, idempotencyKey: randomUUID() },
      context,
    ),
  ).toMatchObject({ outcome: "NO_REQUEST", request: null });
});
it("NFR-REL-002: changed fact under the same key conflicts before capture", async () => {
  const f = await fixture();
  await reconciliation.check(f.pmo, f.input, context);
  await expect(
    reconciliation.check(f.pmo, { ...f.input, factId: randomUUID() }, context),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("NFR-REL-001: native COMMIT rejects orphan owned proof and rolls back conflicts and dependencies", async () => {
  const f = await fixture();
  const projection = async () => ({
    fact: await db.projectFact.findMany({ where: { projectId: f.projectId } }),
    assessments: await db.factAssessment.findMany({
      where: { projectId: f.projectId },
    }),
    versions: await db.factAssessmentVersion.findMany({
      where: { projectId: f.projectId },
    }),
    conflicts: await db.factAuthorityConflict.findMany({
      where: { projectId: f.projectId },
    }),
    dependencies: await db.factAssessmentConflict.findMany({
      where: { projectId: f.projectId },
    }),
    checks: await db.scalarReconciliationCheck.findMany({
      where: { projectId: f.projectId },
    }),
    requests: await db.scalarReconciliationRequest.findMany({
      where: { projectId: f.projectId },
    }),
    assignments: await db.scalarReconciliationAssignment.findMany({
      where: { projectId: f.projectId },
    }),
  });
  const before = await projection();
  let reachedCommit = false;
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public."Project" WHERE id=${f.projectId}::uuid FOR UPDATE`;
      const fact = (
        await tx.$queryRaw<
          { id: string; factType: string; revision: number }[]
        >`SELECT id,"factType",revision FROM public."ProjectFact" WHERE id=${f.input.factId}::uuid FOR UPDATE`
      )[0]!;
      const asOf = (
        await tx.$queryRaw<
          { now: Date }[]
        >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`
      )[0]!.now;
      const prepared = await authority.prepareAssessmentInTransaction(
        tx,
        f.pmo,
        { projectId: f.projectId, fact, asOf },
      );
      await authority.persistPreparedAssessmentInTransaction(tx, f.pmo, {
        prepared,
        subject: f.pmo.subject,
        idempotencyKey: randomUUID(),
        requestHash: "0".repeat(64),
        captureKind: "SCALAR_REQUEST",
        milestoneAssessmentId: null,
        scalarReconciliationCheckId: randomUUID(),
      });
      reachedCommit = true;
    }),
  ).rejects.toThrow();
  expect(reachedCommit).toBe(true);
  expect(await projection()).toEqual(before);
});

it("NFR-REL-001: committed scalar history cannot be adopted, mutated, deleted or truncated", async () => {
  const f = await fixture(),
    result = await reconciliation.check(f.pmo, f.input, context);
  await expect(
    db.factAssessment.update({
      where: { id: result.assessment.assessmentId },
      data: { scalarReconciliationCheckId: randomUUID() },
    }),
  ).rejects.toThrow();
  for (const table of [
    "ScalarReconciliationRequest",
    "ScalarReconciliationCheck",
    "ScalarReconciliationAssignment",
  ]) {
    const before = await db.$queryRawUnsafe(
      'SELECT to_jsonb(t) AS row FROM public."' +
        table +
        '" t WHERE "projectId"=$1::uuid ORDER BY id',
      f.projectId,
    );
    for (const sql of [
      'UPDATE public."' + table + '" SET id=id WHERE "projectId"=$1::uuid',
      'DELETE FROM public."' + table + '" WHERE "projectId"=$1::uuid',
    ])
      await expect(db.$executeRawUnsafe(sql, f.projectId)).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe('TRUNCATE public."' + table + '" CASCADE'),
    ).rejects.toThrow();
    expect(
      await db.$queryRawUnsafe(
        'SELECT to_jsonb(t) AS row FROM public."' +
          table +
          '" t WHERE "projectId"=$1::uuid ORDER BY id',
        f.projectId,
      ),
    ).toEqual(before);
  }
});
