import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseMilestoneConsistencyRepository,
  DatabaseProjectFactRepository,
} from "../packages/data/dist/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import type {
  Actor,
  AuthorityDefinition,
} from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error(
    "Milestone persistence requires an isolated synthetic database",
  );
const db = createDatabase(url);
const canonical = new DatabaseCanonicalProjectRepository(db);
const milestonePersistence = new DatabaseMilestoneConsistencyRepository(db);
const authority = new DatabaseAuthorityRepository(db);
const facts = new DatabaseProjectFactRepository(db);
const customerId = process.env.CUSTOMER_ID!;
const context = { correlationId: "milestone-persistence-integration" };
const definition: AuthorityDefinition = {
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
};

afterAll(() => db.$disconnect());

async function fixture() {
  const portfolioId = randomUUID();
  const pm: Actor = {
    customerId,
    subject: "milestone-pm-" + randomUUID(),
    roles: ["project_manager"],
  };
  const pmo: Actor = {
    customerId,
    subject: "milestone-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Milestone persistence" },
  });
  for (const actor of [pm, pmo])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: actor.roles[0]!,
      },
    });
  const created = await canonical.createProject(
    pmo,
    canonicalFixture(portfolioId),
    randomUUID(),
  );
  const focal = await db.milestone.findFirstOrThrow({
    where: { customerId, projectId: created.id },
    orderBy: { key: "asc" },
  });
  const links = await db.requiredWorkItem.findMany({
    where: { customerId, projectId: created.id, milestoneId: focal.id },
    orderBy: { id: "asc" },
  });
  if (!links.length) throw new Error("Canonical fixture lacks required work");
  return { portfolioId, projectId: created.id, focal, links, pm, pmo };
}

function bindingRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  workItem = false,
) {
  return {
    projectId: f.projectId,
    targetKind: workItem ? ("WORK_ITEM" as const) : ("MILESTONE" as const),
    targetId: workItem ? f.links[0]!.workItemId : f.focal.id,
    idempotencyKey: randomUUID(),
    initialState: workItem ? ("OPEN" as const) : ("COMPLETE" as const),
    effectiveAt: "2026-09-01T00:00:00.000Z",
    validUntil: "2027-09-01T00:00:00.000Z",
    originalStatement: "Synthetic confirmed canonical state",
  };
}
function captureRequest(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    projectId: f.projectId,
    milestoneId: f.focal.id,
    ruleRevision: "milestone-required-state/v1" as const,
    enabled: true,
    idempotencyKey: randomUUID(),
  };
}
async function boundFixture() {
  const f = await fixture();
  const bindings = [];
  for (const workItem of [false, true]) {
    const request = bindingRequest(f, workItem);
    const binding = await milestonePersistence.createStateBinding(
      f.pm,
      request,
      context,
    );
    await authority.appendPolicy(
      f.pmo,
      {
        projectId: f.projectId,
        factType: binding.factType,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        effectiveAt: request.effectiveAt,
        definition,
      },
      context,
    );
    bindings.push(binding);
  }
  return { ...f, bindings };
}

it("persists a sealed contradiction, replay, exact dependencies and access-restricted delivery", async () => {
  const f = await fixture();
  const targets = [
    {
      targetKind: "MILESTONE" as const,
      targetId: f.focal.id,
      state: "COMPLETE" as const,
    },
    ...f.links.map((link) => ({
      targetKind: "WORK_ITEM" as const,
      targetId: link.workItemId,
      state: "OPEN" as const,
    })),
  ];
  const bindings = [];
  for (const target of targets) {
    const request = {
      projectId: f.projectId,
      targetKind: target.targetKind,
      targetId: target.targetId,
      idempotencyKey: "bind_" + randomUUID().replaceAll("-", ""),
      initialState: target.state,
      effectiveAt: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      originalStatement: `Confirmed ${target.targetKind} state ${target.state}`,
    };
    const binding = await milestonePersistence.createStateBinding(
      f.pm,
      request,
      context,
    );
    expect(
      await milestonePersistence.createStateBinding(f.pm, request, context),
    ).toMatchObject({ id: binding.id, replayed: true });
    expect(binding.entry).toMatchObject({
      visibility: "available",
      sourceAccessRevision: 2,
    });
    await authority.appendPolicy(
      f.pmo,
      {
        projectId: f.projectId,
        factType: binding.factType,
        expectedRevision: 0,
        idempotencyKey: "policy_" + randomUUID().replaceAll("-", ""),
        effectiveAt: "2026-09-01T00:00:00.000Z",
        definition,
      },
      context,
    );
    bindings.push(binding);
  }
  const request = {
    projectId: f.projectId,
    milestoneId: f.focal.id,
    ruleRevision: "milestone-required-state/v1" as const,
    enabled: true,
    idempotencyKey: "capture_" + randomUUID().replaceAll("-", ""),
  };
  const captured = await milestonePersistence.captureMilestoneConsistency(
    f.pm,
    request,
    context,
  );
  expect(captured).toMatchObject({
    visibility: "available",
    replayed: false,
    result: { status: "CONFLICTING" },
  });
  expect(
    await milestonePersistence.captureMilestoneConsistency(
      f.pm,
      request,
      context,
    ),
  ).toMatchObject({
    assessmentId: captured.assessmentId,
    replayed: true,
  });
  const proof = await db.milestoneConsistencyAssessment.findUniqueOrThrow({
    where: { id: captured.assessmentId },
    include: { targets: true, scalarAssessments: true, contributors: true },
  });
  expect(proof.sealed).toBe(true);
  expect(proof.targets).toHaveLength(targets.length);
  expect(proof.scalarAssessments).toHaveLength(targets.length);
  expect(proof.contributors.length).toBeGreaterThan(1);
  expect(
    (
      await db.$queryRaw<{ valid: boolean }[]>`
        SELECT public.valid_milestone_consistency_assessment(${proof.id}::uuid) AS valid`
    )[0]?.valid,
  ).toBe(true);
  await db.factSourceAccess.update({
    where: { sourceId: bindings[0]!.entry.sourceId },
    data: { state: "REVOKED", revision: { increment: 1 } },
  });
  expect(
    await milestonePersistence.getMilestoneConsistency(f.pm, {
      projectId: f.projectId,
      assessmentId: proof.id,
    }),
  ).toMatchObject({
    visibility: "restricted",
    revalidationRequired: true,
    result: null,
  });
});

it("seals a minimal UNKNOWN proof for a genuinely missing binding", async () => {
  const f = await fixture();
  const request = {
    projectId: f.projectId,
    milestoneId: f.focal.id,
    ruleRevision: "milestone-required-state/v1" as const,
    enabled: true,
    idempotencyKey: "missing_" + randomUUID().replaceAll("-", ""),
  };
  const captured = await milestonePersistence.captureMilestoneConsistency(
    f.pm,
    request,
    context,
  );
  expect(captured).toMatchObject({
    visibility: "available",
    result: { status: "UNKNOWN" },
  });
  const proof = await db.milestoneConsistencyAssessment.findUniqueOrThrow({
    where: { id: captured.assessmentId },
    include: { targets: true, scalarAssessments: true },
  });
  expect(proof.targets).toHaveLength(f.links.length + 1);
  expect(proof.targets.every((row) => row.bindingId === null)).toBe(true);
  expect(proof.scalarAssessments).toHaveLength(0);
  await milestonePersistence.createStateBinding(
    f.pm,
    bindingRequest(f),
    context,
  );
  expect(
    (
      await db.$queryRaw<{ valid: boolean }[]>`
    SELECT public.valid_milestone_consistency_assessment(${proof.id}::uuid) AS valid`
    )[0]!.valid,
  ).toBe(true);
  expect(
    await milestonePersistence.captureMilestoneConsistency(
      f.pm,
      request,
      context,
    ),
  ).toMatchObject({
    assessmentId: proof.id,
    replayed: true,
    result: { status: "UNKNOWN" },
  });
});

it("reauthorizes retries and excludes leadership from binding and capture", async () => {
  const f = await fixture();
  const leader: Actor = {
    customerId,
    subject: "milestone-leader-" + randomUUID(),
    roles: ["leadership"],
  };
  await db.accessGrant.create({
    data: {
      customerId,
      subject: leader.subject,
      scopeType: "project",
      scopeId: f.projectId,
      role: "leadership",
    },
  });
  const binding = bindingRequest(f);
  const capture = captureRequest(f);
  await milestonePersistence.createStateBinding(f.pm, binding, context);
  await milestonePersistence.captureMilestoneConsistency(
    f.pm,
    capture,
    context,
  );
  await expect(
    milestonePersistence.createStateBinding(
      f.pm,
      { ...binding, initialState: "OPEN" },
      context,
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    milestonePersistence.captureMilestoneConsistency(
      f.pm,
      { ...capture, enabled: false },
      context,
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    milestonePersistence.captureMilestoneConsistency(
      leader,
      {
        projectId: f.projectId,
        milestoneId: f.focal.id,
        ruleRevision: "milestone-required-state/v1",
        enabled: true,
        idempotencyKey: "leader_" + randomUUID().replaceAll("-", ""),
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "DENIED" });
  await db.accessGrant.deleteMany({
    where: { customerId, subject: f.pm.subject },
  });
  await expect(
    milestonePersistence.createStateBinding(f.pm, binding, context),
  ).rejects.toMatchObject({ code: "DENIED" });
  await expect(
    milestonePersistence.captureMilestoneConsistency(f.pm, capture, context),
  ).rejects.toMatchObject({ code: "DENIED" });
  await expect(
    milestonePersistence.createStateBinding(
      f.pm,
      {
        projectId: f.projectId,
        targetKind: "MILESTONE",
        targetId: f.focal.id,
        idempotencyKey: "revoked_" + randomUUID().replaceAll("-", ""),
        initialState: "OPEN",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        validUntil: null,
        originalStatement: "Revoked actor cannot bind",
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "DENIED" });
});

it("serializes concurrent identical binding and cross-proof retries without duplicate children", async () => {
  const f = await fixture();
  const binding = bindingRequest(f);
  const born = await Promise.all(
    [0, 1].map(() =>
      milestonePersistence.createStateBinding(f.pm, binding, context),
    ),
  );
  expect(new Set(born.map((row) => row.id)).size).toBe(1);
  expect(born.filter((row) => row.replayed)).toHaveLength(1);
  const request = captureRequest(f);
  const captured = await Promise.all(
    [0, 1].map(() =>
      milestonePersistence.captureMilestoneConsistency(f.pm, request, context),
    ),
  );
  expect(new Set(captured.map((row) => row.assessmentId)).size).toBe(1);
  expect(captured.filter((row) => row.replayed)).toHaveLength(1);
  expect(
    await db.factAssessment.count({
      where: { milestoneAssessmentId: captured[0]!.assessmentId },
    }),
  ).toBe(1);
});

it("rejects hidden target rows under an INCOMPLETE zero-count header", async () => {
  const f = await fixture();
  const captured = await milestonePersistence.captureMilestoneConsistency(
    f.pm,
    captureRequest(f),
    context,
  );
  const original = await db.milestoneConsistencyAssessment.findUniqueOrThrow({
    where: { id: captured.assessmentId },
  });
  const target = await db.milestoneConsistencyTarget.findFirstOrThrow({
    where: { assessmentId: original.id, targetKind: "MILESTONE" },
  });
  await expect(
    db.$transaction(async (tx) => {
      const id = randomUUID(),
        auditEventId = randomUUID();
      await tx.auditEvent.create({
        data: {
          id: auditEventId,
          customerId,
          actor: f.pm.subject,
          correlationId: context.correlationId,
          event: "milestone.consistency.captured",
          detail: {
            projectId: f.projectId,
            milestoneId: f.focal.id,
            assessmentId: id,
          },
        },
      });
      await tx.milestoneConsistencyAssessment.create({
        data: {
          ...original,
          id,
          auditEventId,
          idempotencyKey: randomUUID(),
          sealed: false,
          complete: false,
          status: "INCOMPLETE",
          targetCount: 0,
          requiredLinkCount: 0,
          result: {
            scope: {
              customerId,
              projectId: f.projectId,
              milestoneId: f.focal.id,
            },
            asOf: original.asOf.toISOString(),
            ruleRevision: original.ruleRevision,
            status: "INCOMPLETE",
          },
        },
      });
      await tx.milestoneConsistencyTarget.create({
        data: { ...target, id: randomUUID(), assessmentId: id },
      });
      await tx.milestoneConsistencyAssessment.update({
        where: { id },
        data: { sealed: true },
      });
    }),
  ).rejects.toThrow(/Invalid milestone consistency seal/);
  expect(
    await db.milestoneConsistencyAssessment.count({
      where: { projectId: f.projectId },
    }),
  ).toBe(1);
});

it("enforces bound-state vocabulary on the generic append path without poisoning the binding", async () => {
  const f = await fixture();
  const binding = await milestonePersistence.createStateBinding(
    f.pm,
    bindingRequest(f),
    context,
  );
  const request = {
    projectId: f.projectId,
    factType: binding.factType,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    effectiveAt: "2026-09-01T00:00:00.000Z",
    originalStatement: "Synthetic generic bound-state append",
  };
  await expect(
    facts.appendHumanStatement(
      f.pm,
      { ...request, value: { type: "text", value: "DONE" } },
      context,
    ),
  ).rejects.toThrow("Project fact persistence failed");
  expect(
    (await db.projectFact.findUniqueOrThrow({ where: { id: binding.factId } }))
      .revision,
  ).toBe(1);
  const saved = await facts.appendHumanStatement(
    f.pm,
    { ...request, value: { type: "text", value: "IN_PROGRESS" } },
    context,
  );
  expect(saved.entry.revision).toBe(2);
  expect(
    (
      await db.$queryRaw<
        { valid: boolean }[]
      >`SELECT public.valid_canonical_state_binding(${binding.id}::uuid) AS valid`
    )[0]!.valid,
  ).toBe(true);
});

it("never upgrades a stored restricted assessment after source access is restored", async () => {
  const f = await boundFixture();
  const sourceId = f.bindings[1]!.entry.sourceId;
  await db.factSourceAccess.update({
    where: { sourceId },
    data: { state: "REVOKED", revision: { increment: 1 } },
  });
  const request = captureRequest(f);
  const captured = await milestonePersistence.captureMilestoneConsistency(
    f.pm,
    request,
    context,
  );
  expect(captured).toMatchObject({ visibility: "restricted", result: null });
  await db.factSourceAccess.update({
    where: { sourceId },
    data: { state: "AVAILABLE", revision: { increment: 1 } },
  });
  expect(
    await milestonePersistence.captureMilestoneConsistency(
      f.pm,
      request,
      context,
    ),
  ).toMatchObject({
    assessmentId: captured.assessmentId,
    replayed: true,
    visibility: "available",
    result: { status: "REVALIDATION_REQUIRED" },
  });
});

// FR-EVD-004/012: public scalar captures must pin the real immutable prefix,
// even when the UUID-ordered bounded sample excludes its highest revision.
it("pins the true conflict prefix beyond the 1001-row scalar sample", async () => {
  const f = await boundFixture();
  const binding = f.bindings.find((row) => row.targetKind === "MILESTONE")!;
  const policy = await db.authorityPolicyRevision.findFirstOrThrow({
    where: {
      customerId,
      projectId: f.projectId,
      factType: binding.factType,
      state: "ENABLED",
    },
    orderBy: { revision: "desc" },
  });
  const prefix = randomUUID().replaceAll("-", "").slice(0, 24);
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`INSERT INTO "FactEvidence" (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
      SELECT gen_random_uuid(),${customerId}::uuid,${f.projectId}::uuid,${binding.factId}::uuid,${binding.entry.sourceId}::uuid,${f.pm.subject},date_trunc('milliseconds',clock_timestamp()),'Conflict prefix fixture'
      FROM generate_series(2,64)`;
      await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pg_temp.append_conflict_prefix_versions(fid uuid) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE item record; next_revision integer;
      BEGIN
        SELECT revision+1 INTO next_revision FROM public."ProjectFact" WHERE id=fid;
        FOR item IN SELECT e.* FROM public."FactEvidence" e WHERE e."factId"=fid
          AND NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" v WHERE v."evidenceId"=e.id) ORDER BY e.id LOOP
          INSERT INTO public."ProjectFactVersion" (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,"effectiveAt","validUntil")
          VALUES (gen_random_uuid(),item."customerId",item."projectId",item."factId",item."sourceId",item.id,next_revision,
            jsonb_build_object('type','text','value',(ARRAY['OPEN','IN_PROGRESS','COMPLETE','CANCELLED'])[((next_revision-1)%4)+1]),
            '2026-09-01'::timestamptz,'2027-09-01'::timestamptz);
          next_revision:=next_revision+1;
        END LOOP;
      END $$`);
      await tx.$executeRaw`SELECT pg_temp.append_conflict_prefix_versions(${binding.factId}::uuid)`;
      await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pg_temp.append_conflict_prefix_rows(fid uuid, policy_id uuid, id_prefix text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE item record; n integer:=0; cid uuid; detected timestamptz:=date_trunc('milliseconds',clock_timestamp());
      BEGIN
        FOR item IN SELECT l.id AS left_id,r.id AS right_id FROM public."ProjectFactVersion" l
          JOIN public."ProjectFactVersion" r ON r."factId"=l."factId" AND l.id<r.id AND l.value IS DISTINCT FROM r.value
          WHERE l."factId"=fid ORDER BY l.revision,r.revision LIMIT 1002 LOOP
          n:=n+1;
          cid := (substr(id_prefix,1,8)||'-'||substr(id_prefix,9,4)||'-'||substr(id_prefix,13,4)||'-'||substr(id_prefix,17,4)||'-'||substr(id_prefix,21,4)||lpad(to_hex(n),8,'0'))::uuid;
          INSERT INTO public."FactAuthorityConflict" (id,"customerId","projectId","factId","factType","leftVersionId","rightVersionId","policyRevisionId","detectedAt",revision)
          SELECT cid,f."customerId",f."projectId",f.id,f."factType",item.left_id,item.right_id,policy_id,detected,n
          FROM public."ProjectFact" f WHERE f.id=fid;
        END LOOP;
        IF n<>1002 THEN RAISE EXCEPTION 'fixture produced % conflicts',n; END IF;
      END $$`);
      await tx.$executeRaw`SELECT pg_temp.append_conflict_prefix_rows(${binding.factId}::uuid,${policy.id}::uuid,${prefix})`;
    },
    { timeout: 20000 },
  );

  const sampled = await db.factAuthorityConflict.findMany({
    where: { factId: binding.factId },
    orderBy: { id: "asc" },
    take: 1001,
    select: { revision: true },
  });
  expect(sampled).toHaveLength(1001);
  expect(sampled.at(-1)?.revision).toBe(1001);
  expect(sampled.some((row) => row.revision === 1002)).toBe(false);
  const before = await db.factAuthorityConflict.count({
    where: { factId: binding.factId },
  });
  expect(before).toBe(1002);
  const captured = await authority.captureAssessment(
    f.pm,
    {
      projectId: f.projectId,
      factType: binding.factType,
      idempotencyKey: "prefix_" + randomUUID().replaceAll("-", ""),
    },
    context,
  );
  expect(captured.visibility).toBe("available");
  if (captured.visibility !== "available")
    throw new Error("Expected available scalar capture");
  expect(captured.result).toMatchObject({
    status: "INCOMPLETE",
    complete: false,
    conflicts: [],
    resolvedValue: null,
  });
  const row = await db.factAssessment.findUniqueOrThrow({
    where: { id: captured.assessmentId },
  });
  expect(row).toMatchObject({
    complete: false,
    conflictCount: 0,
    conflictThroughRevision: 1002,
  });
  expect(
    await db.factAssessmentConflict.count({ where: { assessmentId: row.id } }),
  ).toBe(0);
  expect(
    await db.factAuthorityConflict.count({ where: { factId: binding.factId } }),
  ).toBe(before);
  expect(
    (
      await db.$queryRaw<
        { valid: boolean }[]
      >`SELECT public.valid_fact_assessment(${row.id}::uuid) AS valid`
    )[0]!.valid,
  ).toBe(true);
}, 30000);

it("enforces 1000/1001 versions across two facts with no scalar side effects on overflow", async () => {
  const f = await boundFixture();
  for (const binding of f.bindings) {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`
      INSERT INTO "FactEvidence" (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
      SELECT gen_random_uuid(),${customerId}::uuid,${f.projectId}::uuid,${binding.factId}::uuid,${binding.entry.sourceId}::uuid,${f.pm.subject},date_trunc('milliseconds',clock_timestamp()),'Bounded state evidence' FROM generate_series(2,500)
    `;
        await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pg_temp.append_state_fixture(fid uuid, state_value text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE item record; next_revision integer;
      BEGIN
        SELECT revision+1 INTO next_revision FROM public."ProjectFact" WHERE id=fid;
        FOR item IN SELECT e.* FROM public."FactEvidence" e WHERE e."factId"=fid AND NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" v WHERE v."evidenceId"=e.id) ORDER BY e.id LOOP
          INSERT INTO public."ProjectFactVersion" (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,"effectiveAt","validUntil")
          VALUES (gen_random_uuid(),item."customerId",item."projectId",item."factId",item."sourceId",item.id,next_revision,
            jsonb_build_object('type','text','value',state_value),'2026-09-01'::timestamptz,'2027-09-01'::timestamptz);
          next_revision:=next_revision+1;
        END LOOP;
      END $$`);
        await tx.$executeRaw`SELECT pg_temp.append_state_fixture(${binding.factId}::uuid,${binding.targetKind === "MILESTONE" ? "COMPLETE" : "OPEN"})`;
      },
      { timeout: 15000 },
    );
  }
  const bounded = await milestonePersistence.captureMilestoneConsistency(
    f.pm,
    captureRequest(f),
    context,
  );
  expect(bounded).toMatchObject({
    visibility: "available",
    result: { status: "CONFLICTING" },
  });
  expect(
    (
      await db.milestoneConsistencyAssessment.findUniqueOrThrow({
        where: { id: bounded.assessmentId },
      })
    ).versionCount,
  ).toBe(1000);
  const binding = f.bindings[0]!;
  await facts.appendHumanStatement(
    f.pm,
    {
      projectId: f.projectId,
      factType: binding.factType,
      expectedRevision: 500,
      idempotencyKey: randomUUID(),
      value: { type: "text", value: "COMPLETE" },
      effectiveAt: "2026-09-01T00:00:00.000Z",
      originalStatement: "Overflow evidence",
    },
    context,
  );
  const before = await db.factAssessment.count({
    where: { projectId: f.projectId },
  });
  const overflow = await milestonePersistence.captureMilestoneConsistency(
    f.pm,
    captureRequest(f),
    context,
  );
  expect(overflow).toMatchObject({
    visibility: "available",
    result: { status: "INCOMPLETE" },
  });
  expect(
    await db.factAssessment.count({ where: { projectId: f.projectId } }),
  ).toBe(before);
  expect(
    await db.factAuthorityConflict.count({ where: { projectId: f.projectId } }),
  ).toBe(0);
  expect(
    await db.milestoneConsistencyTarget.count({
      where: { assessmentId: overflow.assessmentId },
    }),
  ).toBe(0);
}, 30000);
