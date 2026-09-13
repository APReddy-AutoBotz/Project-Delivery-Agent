import { afterAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaClient } from "../packages/data/dist/generated/prisma/client.js";
import { watchCommits } from "../scripts/acceptance/reconciliation-commit-probes.mjs";
import {
  runWithCleanup,
  drainAndClose,
} from "../scripts/acceptance/fixture-cleanup.mjs";
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
import { verifyImmutableHistoryMutation } from "../scripts/acceptance/immutable-history.mjs";

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

it("NFR-REL-005: UTC audit linkage survives a non-UTC validation session", async () => {
  const f = await fixture(),
    checked = await reconciliation.check(f.pmo, f.input, context);
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kolkata'");
    return tx.$queryRaw<
      { request: boolean; check: boolean; assignment: boolean }[]
    >`
      SELECT public.valid_scalar_reconciliation_request(${checked.request!.id}::uuid) AS request,
        public.valid_scalar_reconciliation_check(${checked.checkId}::uuid) AS check,
        public.valid_scalar_reconciliation_assignment(${checked.request!.assignment.id}::uuid) AS assignment`;
  });
  expect(result).toEqual([{ request: true, check: true, assignment: true }]);
});

it("NFR-REL-005: a non-UTC session commits new checks and assignment refreshes", async () => {
  const f = await fixture();
  const zonedUrl = new URL(url);
  zonedUrl.searchParams.set("options", "-c timezone=Asia/Kolkata");
  const zoned = createDatabase(zonedUrl.toString());
  try {
    expect(await zoned.$queryRawUnsafe("SHOW TIME ZONE")).toEqual([
      { TimeZone: "Asia/Kolkata" },
    ]);
    const repository = new DatabaseScalarReconciliationRepository(zoned);
    const checked = await repository.check(f.pmo, f.input, context);
    expect(checked.outcome).toBe("CREATED");
    const refreshed = await repository.refreshAssignment(
      f.pmo,
      {
        projectId: f.projectId,
        requestId: checked.request!.id,
        expectedAssignmentRevision: 1,
        idempotencyKey: randomUUID(),
      },
      context,
    );
    expect(refreshed.assignment.revision).toBe(2);
    expect(
      await reconciliation.get(f.pm, {
        projectId: f.projectId,
        requestId: checked.request!.id,
      }),
    ).toMatchObject({ request: { assignment: refreshed.assignment } });
    expect(await zoned.$queryRawUnsafe("SHOW TIME ZONE")).toEqual([
      { TimeZone: "Asia/Kolkata" },
    ]);
  } finally {
    await zoned.$disconnect();
  }
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
  const requireData = createRequire(
    new URL("../packages/data/package.json", import.meta.url),
  );
  const { Pool } = requireData("pg");
  const { PrismaPg } = requireData("@prisma/adapter-pg");
  const poolOptions = {
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 10000,
  };
  const writerPool = new Pool(poolOptions);
  const observerPool = new Pool(poolOptions);
  let observer: Awaited<ReturnType<typeof observerPool.connect>>;
  let writer: PrismaClient | undefined;
  const record = {
    nativeCommitAttempts: 0,
    callbackReturned: false,
    pid: 0,
    sessionUser: "",
    callbackReturnedAtCommit: false,
    native: undefined as
      | undefined
      | { code: string; message: string; constraint?: string },
    commitObserver: undefined as undefined | { phase: string },
  };
  watchCommits(
    writerPool,
    () => record,
    () => observer,
  );
  let reachedCommit = false;
  await runWithCleanup(
    async () => {
      observer = await observerPool.connect();
      writer = new PrismaClient({
        adapter: new PrismaPg(writerPool, { disposeExternalPool: false }),
      });
      await expect(
        writer.$transaction(async (tx) => {
          const principal = (
            await tx.$queryRaw<{ pid: number; sessionUser: string }[]>`
        SELECT pg_backend_pid() AS pid,session_user AS "sessionUser"`
          )[0]!;
          record.pid = principal.pid;
          record.sessionUser = principal.sessionUser;
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
          record.callbackReturned = true;
        }),
      ).rejects.toThrow();
      expect(reachedCommit).toBe(true);
      // A Prisma timeout/connection error alone is never evidence of this guard.
      // The observer records the actual unchanged native COMMIT transport result.
      expect(record.nativeCommitAttempts).toBe(1);
      expect(record.callbackReturnedAtCommit).toBe(true);
      expect(record.commitObserver?.phase).toBe("native-commit-settled");
      expect([
        {
          code: "P0001",
          message: "Unowned scalar reconciliation assessment cannot commit",
          constraint: undefined,
        },
        {
          code: "23503",
          message:
            'insert or update on table "FactAssessment" violates foreign key constraint "ScalarAssessment_check_fk"',
          constraint: "ScalarAssessment_check_fk",
        },
      ]).toContainEqual(record.native);
      expect(await projection()).toEqual(before);
    },
    () =>
      drainAndClose(
        [],
        [
          () => writer?.$disconnect(),
          async () => {
            observer?.release();
            await observerPool.end();
          },
          () => writerPool.end(),
        ],
      ),
  );
});

it("NFR-REL-001: committed scalar history cannot be adopted, mutated, deleted or truncated", async () => {
  const f = await fixture(),
    result = await reconciliation.check(f.pmo, f.input, context);
  await expect(
    db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE public."FactAssessment"
        SET "scalarReconciliationCheckId"=${randomUUID()}::uuid
        WHERE id=${result.assessment.assessmentId}::uuid`;
      throw new Error("Assessment ownership mutation unexpectedly succeeded");
    }),
  ).rejects.toMatchObject({
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: {
          kind: "postgres",
          code: "P0001",
          originalCode: "P0001",
          message: "Invalid assessment seal",
          originalMessage: "Invalid assessment seal",
        },
      },
    },
  });
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
    for (const operation of ["UPDATE", "DELETE", "TRUNCATE"])
      await verifyImmutableHistoryMutation(db, table, operation);
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

it("NFR-REL-005: the year-range constraint rejects a coherently dated refresh and audit", async () => {
  const f = await fixture(false);
  const checked = await reconciliation.check(f.pmo, f.input, context);
  const request = checked.request!,
    previous = request.assignment;
  const id = randomUUID(),
    auditEventId = randomUUID();
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: f.projectId,
        requestId: request.id,
        expectedAssignmentRevision: 1,
      }),
    )
    .digest("hex");
  const overrides = JSON.stringify({
    id,
    auditEventId,
    kind: "REFRESH",
    revision: 2,
    expectedRevision: 1,
    previousAssignmentId: previous.id,
    idempotencyKey: randomUUID(),
    requestHash,
    occurredAt: "10000-01-01T00:00:00Z",
  });
  let auditInserted = false;
  await expect(
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public."Project" WHERE id=${f.projectId}::uuid FOR UPDATE`;
      await tx.$executeRaw`INSERT INTO public."AuditEvent" (id,"customerId",actor,"correlationId","occurredAt",event,detail)
      VALUES (${auditEventId}::uuid,${f.pmo.customerId}::uuid,${f.pmo.subject},${context.correlationId},
        TIMESTAMP '10000-01-01 00:00:00','scalar.reconciliation.assigned',
        jsonb_build_object('projectId',${f.projectId}::text,'factId',${f.input.factId}::text,
          'requestId',${request.id}::text,'assignmentId',${id}::text,'revision',2,'reason','NO_CONFIGURED_PM'))`;
      auditInserted = true;
      await tx.$executeRaw`INSERT INTO public."ScalarReconciliationAssignment"
      SELECT (jsonb_populate_record(NULL::public."ScalarReconciliationAssignment",to_jsonb(a) || ${overrides}::jsonb)).*
      FROM public."ScalarReconciliationAssignment" a WHERE id=${previous.id}::uuid`;
      throw new Error("Out-of-range refresh unexpectedly succeeded");
    }),
  ).rejects.toMatchObject({
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: "23514",
          originalMessage:
            'new row for relation "ScalarReconciliationAssignment" violates check constraint "ScalarAssignment_shape"',
        },
      },
    },
  });
  expect(auditInserted).toBe(true);
  expect(await db.auditEvent.count({ where: { id: auditEventId } })).toBe(0);
  expect(
    await db.scalarReconciliationAssignment.findMany({
      where: { requestId: request.id },
      select: { id: true },
    }),
  ).toEqual([{ id: previous.id }]);
});
