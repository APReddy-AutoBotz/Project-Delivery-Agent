import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { guard } from "./common.mjs";
import { createPriorReleaseDatabase } from "./prior-schema.mjs";
import { seedCanonicalHistory } from "./canonical-projects.mjs";
import {
  createDatabase,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
  DatabaseMilestoneConsistencyRepository,
} from "../../packages/data/dist/index.js";

const key = (id) => "canonical.state." + id.replaceAll("-", "");
async function legacyProjection(owner, fixture) {
  const rows = {};
  for (const table of [
    "ProjectFact",
    "FactSource",
    "FactSourceAccess",
    "FactSourceReader",
    "FactEvidence",
    "ProjectFactVersion",
    "FactAppendReceipt",
    "AuthorityPolicy",
    "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt",
    "AuditEvent",
  ])
    rows[table] = (
      await owner.query(
        `SELECT to_jsonb(t)-'bindingBirthId' AS row FROM "${table}" t WHERE ${table === "AuditEvent" ? '"correlationId"=$1' : table === "ProjectFact" || table.startsWith("Authority") ? '"projectId"=$1::uuid AND "factType"=ANY($2::varchar[])' : '"factId"=$1::uuid'} ORDER BY (to_jsonb(t)-'bindingBirthId')::text COLLATE "C"`,
        table === "AuditEvent"
          ? [fixture.context.correlationId]
          : table === "ProjectFact" || table.startsWith("Authority")
            ? [fixture.projectId, fixture.candidates.map(key)]
            : [fixture.factId],
      )
    ).rows;
  return rows;
}

// FR-EVD-004/012: only a genuine v4 database can legally contain these unbound
// reserved keys. Never fabricate them by disabling current birth guards.
export async function seedLegacyBindingCollision(
  owner,
  connection,
  customerId,
  existingProjectId,
) {
  guard();
  const canonical = await seedCanonicalHistory(
    owner,
    connection,
    customerId,
    existingProjectId,
    "prior-binding-collision",
  );
  const actor = {
    customerId,
    subject: "legacy-collision-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await owner.query(
    'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'project\',$4,\'pmo_admin\')',
    [randomUUID(), customerId, actor.subject, canonical.projectId],
  );
  const f = {
    actor,
    projectId: canonical.projectId,
    candidates: [randomUUID(), randomUUID()],
    context: { correlationId: "legacy-collision-" + randomUUID() },
  };
  const targets = (
    await owner.query(
      'SELECT id FROM "Milestone" WHERE "customerId"=$1 AND "projectId"=$2 AND key=\'MS-1\'',
      [customerId, f.projectId],
    )
  ).rows;
  assert.equal(targets.length, 1);
  f.milestoneId = targets[0].id;
  const db = createPriorReleaseDatabase(connection);
  try {
    assert.equal(
      (await db.$queryRaw`SELECT current_user AS role`)[0].role,
      "pdaa_api",
    );
    const fact = await new DatabaseProjectFactRepository(
      db,
    ).appendHumanStatement(
      actor,
      {
        projectId: f.projectId,
        factType: key(f.candidates[0]),
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        value: { type: "text", value: "OPEN" },
        effectiveAt: "2026-09-01T00:00:00.000Z",
        validUntil: "2027-09-01T00:00:00.000Z",
        originalStatement: "Genuine prior-release reserved fact",
      },
      f.context,
    );
    f.factId = fact.factId;
    await new DatabaseAuthorityRepository(db).appendPolicy(
      actor,
      {
        projectId: f.projectId,
        factType: key(f.candidates[1]),
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        effectiveAt: "2026-09-01T00:00:00.000Z",
        definition: null,
      },
      f.context,
    );
    f.before = await legacyProjection(owner, f);
    for (const [table, rows] of Object.entries(f.before))
      assert.equal(
        rows.length,
        table === "AuditEvent" ? 2 : 1,
        table + " complete legacy fixture",
      );
    assert.equal(f.before.ProjectFact[0].row.factType, key(f.candidates[0]));
    assert.equal(
      f.before.AuthorityPolicy[0].row.factType,
      key(f.candidates[1]),
    );
    return f;
  } finally {
    await db.$disconnect();
  }
}

export async function verifyLegacyBindingCollision(owner, connection, f) {
  guard();
  assert.deepEqual(await legacyProjection(owner, f), f.before);
  assert.equal(
    (
      await owner.query(
        'SELECT "bindingBirthId" FROM "ProjectFact" WHERE id=$1',
        [f.factId],
      )
    ).rows[0].bindingBirthId,
    null,
  );
  const db = createDatabase(connection);
  const ids = [
    randomUUID(),
    ...f.candidates,
    randomUUID(),
    ...Array.from({ length: 6 }, () => randomUUID()),
  ];
  let consumed = 0;
  try {
    assert.equal(
      (await db.$queryRaw`SELECT current_user AS role`)[0].role,
      "pdaa_api",
    );
    const repository = new DatabaseMilestoneConsistencyRepository(db, () => {
      assert(consumed < ids.length, "Unexpected binding ID allocation");
      return ids[consumed++];
    });
    const request = {
      projectId: f.projectId,
      targetKind: "MILESTONE",
      targetId: f.milestoneId,
      initialState: "COMPLETE",
      idempotencyKey: randomUUID(),
      effectiveAt: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      originalStatement: "Fresh post-upgrade binding",
    };
    const context = { correlationId: "post-upgrade-binding-" + randomUUID() };
    const created = await repository.createStateBinding(
      f.actor,
      request,
      context,
    );
    assert.equal(consumed, 10);
    assert.equal(created.id, ids[0]);
    assert.equal(created.factType, key(ids[3]));
    assert.equal(created.factId, ids[4]);
    assert.equal(created.replayed, false);
    assert.deepEqual(
      await repository.createStateBinding(f.actor, request, context),
      { ...created, replayed: true },
    );
    assert.equal(consumed, 10, "Replay must not allocate another identity");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          projectId: request.projectId,
          targetKind: request.targetKind,
          targetId: request.targetId,
          initialState: request.initialState,
          effectiveAt: request.effectiveAt,
          validUntil: request.validUntil,
          originalStatement: request.originalStatement,
        }),
      )
      .digest("hex");
    const proof = (
      await owner.query(
        'SELECT b.sealed,public.valid_canonical_state_binding(b.id) AS valid,r.id AS "receiptId",r."factId",r."sourceId",r."evidenceId",r."versionId",r."auditEventId",r.subject,r."idempotencyKey",r."requestHash",r."initialSourceAccessRevision",r."initialSourceAccessState",r."initialReaderSubject" FROM "CanonicalStateBinding" b JOIN "CanonicalStateBindingReceipt" r ON r."bindingId"=b.id WHERE b.id=$1',
        [created.id],
      )
    ).rows[0];
    assert.deepEqual(proof, {
      sealed: true,
      valid: true,
      receiptId: ids[9],
      factId: ids[4],
      sourceId: ids[5],
      evidenceId: ids[6],
      versionId: ids[7],
      auditEventId: ids[8],
      subject: f.actor.subject,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      initialSourceAccessRevision: 2,
      initialSourceAccessState: "AVAILABLE",
      initialReaderSubject: f.actor.subject,
    });
    assert.deepEqual(await legacyProjection(owner, f), f.before);
    assert.equal(
      (
        await owner.query(
          'SELECT "bindingBirthId" FROM "ProjectFact" WHERE id=$1',
          [f.factId],
        )
      ).rows[0].bindingBirthId,
      null,
    );
    const state = (
      await owner.query(
        `SELECT
        (SELECT count(*)::int FROM "CanonicalStateBinding" WHERE "projectId"=$1) AS bindings,
        (SELECT count(*)::int FROM "CanonicalStateBinding" WHERE "projectId"=$1 AND "factType"=ANY($2::varchar[])) AS adopted,
        (SELECT count(*)::int FROM "ProjectFact" WHERE "projectId"=$1 AND "factType"=$3) AS "policyKeyFacts",
        (SELECT count(*)::int FROM "AuthorityPolicy" WHERE "projectId"=$1 AND "factType"=ANY($4::varchar[])) AS "implicitPolicies"`,
        [
          f.projectId,
          f.candidates.map(key),
          key(f.candidates[1]),
          [key(f.candidates[0]), created.factType],
        ],
      )
    ).rows[0];
    assert.deepEqual(state, {
      bindings: 1,
      adopted: 0,
      policyKeyFacts: 0,
      implicitPolicies: 0,
    });
    return {
      executedAs: "pdaa_api",
      skippedCandidates: 2,
      bindingId: created.id,
      snapshotRetained: true,
      noAdoptionOrPolicy: true,
      replayAllocatedNothing: true,
    };
  } finally {
    await db.$disconnect();
  }
}
