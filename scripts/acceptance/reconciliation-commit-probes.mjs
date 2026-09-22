// Acceptance-only real-COMMIT probes. No production API or runtime grant changes.
// FR-EVD-004/012, NFR-REL-001/002: native COMMIT proof with all guards enabled.
// No top-level execution, no migration/role-membership changes, no cleanup DELETE.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const options = {
  isolationLevel: "ReadCommitted",
  maxWait: 5000,
  timeout: 10000,
};
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const hash = (value) => sha(JSON.stringify(value));
const wrongHash = (value) => (value[0] === "0" ? "1" : "0") + value.slice(1);
const tables = [
  "MilestoneConsistencyAssessment",
  "MilestoneConsistencyTarget",
  "MilestoneConsistencyContributorVersion",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
  "FactAuthorityConflict",
  "MilestoneReconciliationRequest",
  "MilestoneReconciliationCheck",
  "MilestoneReconciliationAssignment",
  "AuditEvent",
  "ProjectFact",
  "ProjectFactVersion",
  "FactEvidence",
];
const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pgGuard = (message) => ({ code: "P0001", message });
const pgForeignKey = (table, constraint) => ({
  code: "23503",
  constraint,
  message: `insert or update on table "${table}" violates foreign key constraint "${constraint}"`,
});
const ownedCheckErrors = [
  pgGuard("Unowned reconciliation assessment cannot commit"),
  pgGuard("Incomplete reconciliation check cannot commit"),
];
const expected = {
  "unsealed-request": [
    ...ownedCheckErrors,
    pgGuard("Incomplete reconciliation request cannot commit"),
    pgGuard("Incomplete reconciliation assignment cannot commit"),
  ],
  "orphan-owned-assessment": [
    pgGuard("Unowned reconciliation assessment cannot commit"),
    pgForeignKey(
      "MilestoneConsistencyAssessment",
      "ReconciliationAssessment_check_fk",
    ),
  ],
  "wrong-no-request-semantics": ownedCheckErrors,
  "wrong-check-hash": ownedCheckErrors,
  "wrong-check-audit": ownedCheckErrors,
  "wrong-refresh-hash": [
    pgGuard("Incomplete reconciliation assignment cannot commit"),
  ],
  "wrong-refresh-audit": [
    pgGuard("Incomplete reconciliation assignment cannot commit"),
  ],
  "wrong-reused-identity": ownedCheckErrors,
  "wrong-refresh-time": [
    pgGuard("Incomplete reconciliation assignment cannot commit"),
  ],
};

// Observe actual native transport outcomes. Never change statement bytes, values,
// results, error objects, transaction options, or the decision to COMMIT/ROLLBACK.
// The installed Prisma PG adapter uses the promise form of client.query(config).
// Callback-form COMMIT is deliberately unsupported and fails evidence validation.
export function watchCommits(pool, activeCase, observerClient) {
  pool.on("connect", (client) => {
    const query = client.query;
    client.query = function (...args) {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
      const record = activeCase();
      const watching = record && /^\s*COMMIT\s*;?\s*$/i.test(sql ?? "");
      if (!watching) return query.apply(this, args);
      record.nativeCommitAttempts += 1;
      record.nativePid = client.processID;
      record.callbackReturnedAtCommit = record.callbackReturned;
      // pg rejects on ErrorResponse, before the distinct ReadyForQuery message.
      // Arm before forwarding COMMIT so even synchronous completion is observed.
      // This observes transport only: no replacement query, retry or writer DML.
      let settleReady, readyTimer;
      const ready = new Promise((resolve) => {
        settleReady = resolve;
      });
      const onReady = (message) =>
        settleReady({ phase: "ready-status", status: message?.status });
      const onError = () => settleReady({ phase: "ready-transport-error" });
      const onEnd = () => settleReady({ phase: "ready-transport-end" });
      client.connection.on("readyForQuery", onReady);
      client.on("error", onError);
      client.on("end", onEnd);
      const cleanupReady = () => {
        clearTimeout(readyTimer);
        client.connection.removeListener("readyForQuery", onReady);
        client.removeListener("error", onError);
        client.removeListener("end", onEnd);
      };
      const attest = async () => {
        let phase = "ready-wait";
        try {
          // Bound only post-settlement transport drain, not native COMMIT work.
          // The listener was already armed, so earlier readiness is retained.
          // Native maxWait/transaction/query deadlines remain unchanged.
          readyTimer = setTimeout(
            () => settleReady({ phase: "ready-timeout" }),
            1000,
          );
          const settled = await ready;
          phase = settled.phase;
          assert.equal(
            settled.status,
            "I",
            "COMMIT did not reach ReadyForQuery idle",
          );
          cleanupReady();
          const observer = observerClient();
          phase = "observer-distinct-backend";
          assert(observer && observer.processID !== client.processID);
          phase = "observer-query";
          const rows = (
            await observer.query(
              "SELECT pid,usename,state,query FROM pg_stat_activity WHERE pid=$1",
              [client.processID],
            )
          ).rows;
          phase = "observer-row-count";
          assert.equal(rows.length, 1);
          const row = rows[0];
          phase = "observer-writer-pid";
          assert.equal(row.pid, record.pid);
          phase = "observer-session-user";
          assert.equal(row.usename, record.sessionUser);
          phase = "observer-idle";
          assert.equal(row.state, "idle");
          phase = "observer-commit-query";
          assert.match(row.query, /^\s*COMMIT\s*;?\s*$/i);
          record.commitObserver = {
            observerPid: observer.processID,
            writerPid: row.pid,
            sessionUser: row.usename,
            state: row.state,
            query: row.query,
            phase: "native-commit-settled",
          };
        } catch (error) {
          // Preserve a finite diagnostic; never serialize SQL/error payloads.
          record.commitObserverFailure = phase;
          throw error;
        } finally {
          cleanupReady();
        }
      };
      let result;
      try {
        result = query.apply(this, args);
      } catch (error) {
        cleanupReady();
        record.native = {
          code: error.code,
          message: error.message,
          constraint: error.constraint,
        };
        throw error;
      }
      if (!result || typeof result.then !== "function") {
        cleanupReady();
        record.unsupportedTransport = true;
        return result;
      }
      return result.then(
        async (value) => {
          record.nativeCommand = value.command;
          await attest();
          return value;
        },
        async (error) => {
          record.native = {
            code: error.code,
            message: error.message,
            constraint: error.constraint,
          };
          try {
            await attest();
          } catch (observerError) {
            throw new AggregateError(
              [error, observerError],
              "COMMIT observer failed",
              { cause: observerError },
            );
          }
          throw error;
        },
      );
    };
  });
}

async function fingerprint(observer, f) {
  const result = {};
  for (const table of tables) {
    const predicate =
      table === "AuditEvent"
        ? "t.\"customerId\"=$1::uuid AND t.detail->>'projectId'=$2"
        : 't."customerId"=$1::uuid AND t."projectId"=$2::uuid';
    const rows = (
      await observer.query(
        `SELECT to_jsonb(t) AS row FROM public."${table}" t WHERE ${predicate}
       ORDER BY to_jsonb(t)::text LIMIT 5001`,
        [f.actor.customerId, f.projectId],
      )
    ).rows;
    assert(
      rows.length <= 5000,
      "Reserved commit fixture exceeded reader bound",
    );
    result[table] = { count: rows.length, sha256: hash(rows) };
  }
  return result;
}

async function assertGeneratedRowsAbsent(observer, f, record) {
  // Covers every capture-created child family, including composite-key rows.
  // Factory IDs cover outer rows and capture targets, not every authority-created
  // scalar/conflict UUID. Exact full-table fingerprints cover those families.
  const counts = {};
  for (const table of tables) {
    const scope =
      table === "AuditEvent"
        ? 't."customerId"=$1::uuid'
        : 't."customerId"=$1::uuid AND t."projectId"=$2::uuid';
    const idsParameter = table === "AuditEvent" ? "$2::text[]" : "$3::text[]";
    const parameters =
      table === "AuditEvent"
        ? [f.actor.customerId, record.generated]
        : [f.actor.customerId, f.projectId, record.generated];
    const rows = (
      await observer.query(
        `SELECT count(*)::int AS n FROM public."${table}" t WHERE ${scope}
       AND (to_jsonb(t)->>'id'=ANY(${idsParameter})
         OR to_jsonb(t)->>'assessmentId'=ANY(${idsParameter})
         OR to_jsonb(t)->>'milestoneAssessmentId'=ANY(${idsParameter}))`,
        parameters,
      )
    ).rows;
    assert.equal(rows[0].n, 0, `${table}: failed probe left generated rows`);
    counts[table] = rows[0].n;
  }
  return counts;
}

async function positiveRows(observer, f, value, mode) {
  const scope = [f.actor.customerId, f.projectId];
  const assignment =
    mode === "positive-no-request"
      ? []
      : (
          await observer.query(
            `SELECT id,"customerId","projectId","requestId",revision,"previousAssignmentId",public.valid_milestone_reconciliation_assignment(id) AS valid
       FROM "MilestoneReconciliationAssignment" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND ${mode === "positive-refresh" ? "id=$3::uuid" : '"requestId"=$3::uuid AND revision=1'}`,
            [
              ...scope,
              mode === "positive-refresh" ? value.id : value.requestId,
            ],
          )
        ).rows;
  const requestId =
    mode === "positive-refresh" ? assignment[0]?.requestId : value.requestId;
  const request = requestId
    ? (
        await observer.query(
          'SELECT id,"customerId","projectId","milestoneId","originalAssessmentId","originCommandId",sealed,public.valid_milestone_reconciliation_request(id) AS valid FROM "MilestoneReconciliationRequest" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid',
          [...scope, requestId],
        )
      ).rows
    : [];
  const check = value.checkId
    ? (
        await observer.query(
          'SELECT id,"customerId","projectId","assessmentId","requestId",outcome,public.valid_milestone_reconciliation_check(id) AS valid FROM "MilestoneReconciliationCheck" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid',
          [...scope, value.checkId],
        )
      ).rows
    : [];
  assert.equal(request.length, mode === "positive-no-request" ? 0 : 1);
  assert.equal(assignment.length, mode === "positive-no-request" ? 0 : 1);
  assert.equal(check.length, mode === "positive-refresh" ? 0 : 1);
  assert(
    [...request, ...check, ...assignment].every((row) => row.valid === true),
  );
  assert(request.every((row) => row.sealed === true));
  return { request, check, assignment };
}

function checkHash(f, enabled) {
  return hash({
    projectId: f.projectId,
    milestoneId: f.milestoneId,
    ruleRevision: "milestone-required-state/v1",
    enabled,
  });
}
function refreshHash(f, requestId, previous) {
  return hash({
    projectId: f.projectId,
    requestId,
    expectedAssignmentRevision: previous,
  });
}
async function audit(tx, f, context, id, occurredAt, event, detail) {
  return tx.auditEvent.create({
    data: {
      id,
      customerId: f.actor.customerId,
      actor: f.actor.subject,
      correlationId: context.correlationId,
      occurredAt,
      event,
      detail,
    },
  });
}

async function assignment(
  tx,
  f,
  context,
  nextId,
  routing,
  requestId,
  occurredAt,
  previous = null,
  mode = "valid",
) {
  const id = nextId(),
    auditEventId = nextId();
  const revision = (previous?.revision ?? 0) + 1;
  let requestHash = previous
    ? refreshHash(f, requestId, previous.revision)
    : null;
  if (mode === "wrong-refresh-hash") requestHash = wrongHash(requestHash);
  await tx.milestoneReconciliationAssignment.create({
    data: {
      id,
      customerId: f.actor.customerId,
      projectId: f.projectId,
      requestId,
      revision,
      expectedRevision: previous?.revision ?? 0,
      previousAssignmentId: previous?.id ?? null,
      kind: previous ? "REFRESH" : "INITIAL",
      ...routing,
      actor: f.actor.subject,
      occurredAt,
      auditEventId,
      idempotencyKey: previous ? randomUUID() : null,
      requestHash,
    },
  });
  await audit(
    tx,
    f,
    context,
    auditEventId,
    occurredAt,
    mode === "wrong-refresh-audit"
      ? "milestone.reconciliation.assigned.invalid"
      : "milestone.reconciliation.assigned",
    {
      projectId: f.projectId,
      requestId,
      assignmentId: id,
      revision,
      reason: routing.reason,
    },
  );
  return { id, revision };
}

// Fixture-only append inside the same failing actual-role transaction. This is
// not a public append workflow and does not commit changed input independently.
async function advanceFixtureContributor(tx, f, nextId) {
  const link = await tx.requiredWorkItem.findFirstOrThrow({
    where: {
      customerId: f.actor.customerId,
      projectId: f.projectId,
      milestoneId: f.milestoneId,
    },
    orderBy: { id: "asc" },
    select: { workItemId: true },
  });
  const binding = await tx.canonicalStateBinding.findFirstOrThrow({
    where: {
      customerId: f.actor.customerId,
      projectId: f.projectId,
      targetKind: "WORK_ITEM",
      workItemId: link.workItemId,
      field: "state",
      sealed: true,
    },
    select: { factId: true },
  });
  const current = await tx.projectFactVersion.findFirstOrThrow({
    where: {
      customerId: f.actor.customerId,
      projectId: f.projectId,
      factId: binding.factId,
    },
    orderBy: { revision: "desc" },
    select: {
      revision: true,
      sourceId: true,
      value: true,
      effectiveAt: true,
      validUntil: true,
      evidence: { select: { providedBy: true, observedAt: true } },
    },
  });
  assert.deepEqual(current.value, { type: "text", value: "OPEN" });
  assert.equal(current.evidence.providedBy, f.actor.subject);
  assert(current.validUntil instanceof Date);
  const [time] =
    await tx.$queryRaw`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  const effectiveAt = new Date(current.effectiveAt.getTime() + 1);
  assert(effectiveAt.getTime() <= time.now.getTime());
  assert(current.evidence.observedAt.getTime() <= time.now.getTime());
  assert(time.now.getTime() < current.validUntil.getTime());
  const scope = {
    customerId: f.actor.customerId,
    projectId: f.projectId,
    factId: binding.factId,
    sourceId: current.sourceId,
  };
  const evidenceId = nextId();
  await tx.factEvidence.create({
    data: {
      ...scope,
      id: evidenceId,
      providedBy: f.actor.subject,
      observedAt: time.now,
      originalStatement: "Synthetic changed contributor native COMMIT probe",
    },
    select: { id: true },
  });
  await tx.projectFactVersion.create({
    data: {
      ...scope,
      id: nextId(),
      evidenceId,
      revision: current.revision + 1,
      value: current.value,
      provenance: "HUMAN_CONFIRMED",
      effectiveAt,
      validUntil: current.validUntil,
    },
    select: { id: true },
  });
  // The released version trigger advances ProjectFact. No direct revision
  // write, disabled guard, owner backfill or receipt/permission bypass is used.
}

async function captureCase(
  tx,
  db,
  f,
  record,
  deps,
  mode,
  reusedRequestId = null,
) {
  const nextId = () => {
    const id = randomUUID();
    record.generated.push(id);
    return id;
  };
  const context = { correlationId: "reconciliation-commit-" + randomUUID() };
  const { routing } = await deps.authorizeReconciliation(
    tx,
    f.actor,
    f.projectId,
    "manage",
  );
  let reused = null;
  if (mode === "wrong-reused-identity") {
    assert.match(reusedRequestId, ids);
    reused = await tx.milestoneReconciliationRequest.findFirstOrThrow({
      where: {
        id: reusedRequestId,
        customerId: f.actor.customerId,
        projectId: f.projectId,
      },
      select: {
        milestoneId: true,
        contributorIdentity: true,
        sealed: true,
        originCommandId: true,
        originalAssessmentId: true,
      },
    });
    assert.equal(reused.milestoneId, f.milestoneId);
    assert.equal(reused.sealed, true);
    const [original] = await tx.$queryRaw`
      SELECT public.valid_milestone_reconciliation_request(${reusedRequestId}::uuid) AS valid`;
    assert.equal(original.valid, true);
    await advanceFixtureContributor(tx, f, nextId);
  }
  const enabled = [
    "positive-birth",
    "unsealed-request",
    "wrong-no-request-semantics",
    "wrong-reused-identity",
  ].includes(mode);
  const checkId = nextId();
  const capture = new deps.DatabaseMilestoneConsistencyRepository(db, nextId);
  const proof = await capture.captureInTransaction(
    tx,
    f.actor,
    {
      projectId: f.projectId,
      milestoneId: f.milestoneId,
      ruleRevision: "milestone-required-state/v1",
      enabled,
      idempotencyKey: "rc_" + checkId.replaceAll("-", ""),
    },
    context,
    checkId,
  );
  assert.equal(proof.visibility, "available");
  assert.equal(proof.result.status, enabled ? "CONFLICTING" : "DISABLED");
  if (reused) {
    assert.notEqual(
      proof.result.contributorIdentity,
      reused.contributorIdentity,
    );
    assert.notEqual(proof.assessmentId, reused.originalAssessmentId);
    assert.notEqual(checkId, reused.originCommandId);
    // Isolate the malformed REUSED association: the original historical proof
    // must still be valid after this transaction's changed-input capture.
    const [original] = await tx.$queryRaw`
      SELECT public.valid_milestone_reconciliation_request(${reusedRequestId}::uuid) AS valid`;
    assert.equal(original.valid, true);
  }
  record.assessmentId = proof.assessmentId;
  const occurredAt = new Date(proof.asOf);
  if (mode === "orphan-owned-assessment")
    return { assessmentId: proof.assessmentId };
  let requestId = reused ? reusedRequestId : null,
    outcome = reused ? "REUSED" : "NO_REQUEST";
  if (mode === "positive-birth" || mode === "unsealed-request") {
    requestId = nextId();
    outcome = "CREATED";
    const auditEventId = nextId();
    await tx.milestoneReconciliationRequest.create({
      data: {
        id: requestId,
        customerId: f.actor.customerId,
        projectId: f.projectId,
        milestoneId: f.milestoneId,
        ruleRevision: "milestone-required-state/v1",
        originalAssessmentId: proof.assessmentId,
        originCommandId: checkId,
        contributorIdentity: proof.result.contributorIdentity,
        contributorHash: sha(proof.result.contributorIdentity),
        createdBy: f.actor.subject,
        createdAt: occurredAt,
        auditEventId,
      },
    });
    await audit(
      tx,
      f,
      context,
      auditEventId,
      occurredAt,
      "milestone.reconciliation.requested",
      {
        projectId: f.projectId,
        requestId,
        assessmentId: proof.assessmentId,
        checkId,
      },
    );
    await assignment(tx, f, context, nextId, routing, requestId, occurredAt);
  }
  const auditEventId = nextId();
  const requestHash = checkHash(f, enabled);
  await tx.milestoneReconciliationCheck.create({
    data: {
      id: checkId,
      customerId: f.actor.customerId,
      projectId: f.projectId,
      subject: f.actor.subject,
      idempotencyKey: randomUUID(),
      requestHash:
        mode === "wrong-check-hash" ? wrongHash(requestHash) : requestHash,
      assessmentId: proof.assessmentId,
      requestId,
      outcome,
      occurredAt,
      auditEventId,
    },
  });
  await audit(
    tx,
    f,
    context,
    auditEventId,
    occurredAt,
    mode === "wrong-check-audit"
      ? "milestone.reconciliation.checked.invalid"
      : "milestone.reconciliation.checked",
    {
      projectId: f.projectId,
      checkId,
      assessmentId: proof.assessmentId,
      requestId,
      outcome,
    },
  );
  if (mode === "positive-birth")
    await tx.milestoneReconciliationRequest.update({
      where: { id: requestId },
      data: { sealed: true },
    });
  return { requestId, checkId, assessmentId: proof.assessmentId };
}

async function refreshCase(tx, f, record, deps, mode, requestId) {
  const nextId = () => {
    const id = randomUUID();
    record.generated.push(id);
    return id;
  };
  const context = { correlationId: "reconciliation-commit-" + randomUUID() };
  const { routing } = await deps.authorizeReconciliation(
    tx,
    f.actor,
    f.projectId,
    "manage",
  );
  const previous = await tx.milestoneReconciliationAssignment.findFirstOrThrow({
    where: {
      customerId: f.actor.customerId,
      projectId: f.projectId,
      requestId,
    },
    orderBy: { revision: "desc" },
    select: { id: true, revision: true, occurredAt: true },
  });
  const [time] =
    await tx.$queryRaw`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  return assignment(
    tx,
    f,
    context,
    nextId,
    routing,
    requestId,
    mode === "wrong-refresh-time"
      ? new Date(previous.occurredAt.getTime() - 1)
      : time.now,
    previous,
    mode,
  );
}

/**
 * Dependencies are injected so this draft stays portable when root chooses its
 * tracked location. Supply the ACTUAL installed pg.Pool, PrismaPg, generated
 * PrismaClient, DatabaseMilestoneConsistencyRepository, authorizeReconciliation.
 * Do not replace any dependency with an assembler mock or proof/permission stub.
 *
 * Both fixtures must be explicitly reserved, different canonical projects with
 * scoped same-role actor grants and a complete, source-visible, authority-resolved
 * COMPLETE milestone / OPEN required work conflict. No Stage 3 history initially.
 * The runner owns fixture creation/backup disposition, not this helper.
 * connection is an already validated synthetic or packaged-acceptance transport.
 * allowRun() must perform the invoking runner's synthetic/acceptance-ID checks.
 */
export async function verifyReconciliationCommitGuards({
  connection,
  positiveFixture,
  negativeFixture,
  allowRun,
  ...deps
}) {
  assert.equal(typeof allowRun, "function");
  await allowRun();
  assert.notEqual(positiveFixture.projectId, negativeFixture.projectId);
  assert.equal(
    positiveFixture.actor.customerId,
    negativeFixture.actor.customerId,
  );
  for (const f of [positiveFixture, negativeFixture]) {
    for (const id of [f.projectId, f.milestoneId, f.actor.customerId])
      assert.match(id, ids);
    assert.equal(typeof f.actor.subject, "string");
    assert(f.actor.roles.length > 0);
  }
  const poolOptions = {
    ...connection,
    max: 5,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 10000,
  };
  const writerPool = new deps.Pool(poolOptions);
  const observerPool = new deps.Pool(poolOptions);
  let active = null,
    observer;
  watchCommits(
    writerPool,
    () => active,
    () => observer,
  );
  const db = new deps.PrismaClient({
    adapter: new deps.PrismaPg(writerPool, { disposeExternalPool: false }),
  });
  const receipts = [];
  const run = async (mode, f, body) => {
    const before = await fingerprint(observer, f);
    const record = {
      mode,
      generated: [],
      nativeCommitAttempts: 0,
      callbackReturned: false,
    };
    assert.equal(active, null);
    active = record;
    let value, failure;
    try {
      value = await db.$transaction(async (tx) => {
        // Quarantined restore may connect as owner, but this transaction's actual
        // DML/trigger/COMMIT role is pdaa_api; no CONNECT or membership is granted.
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        const [session] =
          await tx.$queryRaw`SELECT current_user AS role, session_user AS "sessionUser", pg_backend_pid()::int AS pid`;
        assert.equal(session.role, "pdaa_api");
        assert.notEqual(session.pid, observer.processID);
        record.pid = session.pid;
        record.sessionUser = session.sessionUser;
        value = await body(tx, record);
        record.callbackReturned = true;
        return value;
      }, options);
    } catch (error) {
      failure = error;
    } finally {
      active = null;
    }
    // A failed INSERT, assertion, timeout, permission error or callback sentinel
    // cannot masquerade as a successful deferred-guard negative.
    assert.equal(
      record.callbackReturned,
      true,
      `${mode}: did not reach COMMIT`,
    );
    assert.equal(
      record.nativeCommitAttempts,
      1,
      `${mode}: expected one actual COMMIT`,
    );
    assert.equal(record.nativePid, record.pid, `${mode}: wrong COMMIT backend`);
    assert.equal(
      record.callbackReturnedAtCommit,
      true,
      `${mode}: COMMIT preceded callback completion`,
    );
    assert(
      record.commitObserver,
      `${mode}: separate COMMIT observer is missing (${record.commitObserverFailure ?? "not-observed"})`,
    );
    assert.notEqual(
      record.unsupportedTransport,
      true,
      "Unsupported COMMIT query API",
    );
    let generatedAbsence = null,
      observedRows = null;
    const negative = Object.hasOwn(expected, mode);
    if (negative) {
      assert(failure, `${mode}: malformed transaction committed`);
      assert.equal(
        record.nativeCommand,
        undefined,
        `${mode}: native COMMIT unexpectedly succeeded`,
      );
      assert(
        expected[mode].some(
          (match) =>
            record.native?.code === match.code &&
            record.native.message === match.message &&
            (match.constraint === undefined ||
              record.native.constraint === match.constraint),
        ),
        `${mode}: native PostgreSQL denial was not its expected integrity guard`,
      );
      assert.deepEqual(
        await fingerprint(observer, f),
        before,
        `${mode}: committed footprint changed`,
      );
      generatedAbsence = await assertGeneratedRowsAbsent(observer, f, record);
    } else {
      assert.equal(failure, undefined, `${mode}: positive control failed`);
      assert.equal(record.nativeCommand, "COMMIT");
      assert.equal(record.native, undefined);
      if (value.requestId) {
        const rows = (
          await observer.query(
            'SELECT sealed,public.valid_milestone_reconciliation_request(id) AS valid FROM public."MilestoneReconciliationRequest" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid',
            [f.actor.customerId, f.projectId, value.requestId],
          )
        ).rows;
        assert.deepEqual(rows, [{ sealed: true, valid: true }]);
      }
      if (value.checkId) {
        const rows = (
          await observer.query(
            'SELECT public.valid_milestone_reconciliation_check(id) AS valid FROM public."MilestoneReconciliationCheck" WHERE id=$1::uuid',
            [value.checkId],
          )
        ).rows;
        assert.deepEqual(rows, [{ valid: true }]);
      }
      if (value.id) {
        const rows = (
          await observer.query(
            'SELECT public.valid_milestone_reconciliation_assignment(id) AS valid FROM public."MilestoneReconciliationAssignment" WHERE id=$1::uuid',
            [value.id],
          )
        ).rows;
        assert.deepEqual(rows, [{ valid: true }]);
      }
      observedRows = await positiveRows(observer, f, value, mode);
    }
    receipts.push({
      mode,
      customerId: f.actor.customerId,
      projectId: f.projectId,
      milestoneId: f.milestoneId,
      runtimeRole: "pdaa_api",
      transactionPid: record.pid,
      transactionSessionUser: record.sessionUser,
      nativePid: record.nativePid,
      callbackReturned: record.callbackReturned,
      nativeCommit: record.native ?? { command: record.nativeCommand },
      nativeCommitAttempts: record.nativeCommitAttempts,
      callbackReturnedAtCommit: record.callbackReturnedAtCommit,
      commitObserver: record.commitObserver,
      generatedIds: record.generated,
      generatedAbsence,
      result: negative ? null : value,
      positiveRows: observedRows,
      before,
      after: await fingerprint(observer, f),
    });
    return value;
  };
  let primaryError, result;
  const cleanupErrors = [];
  try {
    observer = await observerPool.connect();
    // The observer remains a separately held backend for the entire run.
    const meta = (await observer.query("SELECT pg_backend_pid()::int AS pid"))
      .rows[0];
    assert.equal(meta.pid, observer.processID);
    for (const f of [positiveFixture, negativeFixture]) {
      const initial = await fingerprint(observer, f);
      for (const table of tables.filter((name) =>
        name.startsWith("MilestoneReconciliation"),
      ))
        assert.equal(
          initial[table].count,
          0,
          "Commit probe fixture is not reserved/empty",
        );
    }
    const positive = await run(
      "positive-birth",
      positiveFixture,
      (tx, record) =>
        captureCase(tx, db, positiveFixture, record, deps, "positive-birth"),
    );
    for (const mode of [
      "unsealed-request",
      "orphan-owned-assessment",
      "wrong-no-request-semantics",
      "wrong-check-hash",
      "wrong-check-audit",
    ])
      await run(mode, negativeFixture, (tx, record) =>
        captureCase(tx, db, negativeFixture, record, deps, mode),
      );
    for (const mode of [
      "wrong-refresh-hash",
      "wrong-refresh-audit",
      "positive-refresh",
    ])
      await run(mode, positiveFixture, (tx, record) =>
        refreshCase(
          tx,
          positiveFixture,
          record,
          deps,
          mode,
          positive.requestId,
        ),
      );
    await run("positive-no-request", negativeFixture, (tx, record) =>
      captureCase(tx, db, negativeFixture, record, deps, "positive-no-request"),
    );
    // Append the two new controls without reordering the existing ten receipts.
    await run("wrong-reused-identity", positiveFixture, (tx, record) =>
      captureCase(
        tx,
        db,
        positiveFixture,
        record,
        deps,
        "wrong-reused-identity",
        positive.requestId,
      ),
    );
    await run("wrong-refresh-time", positiveFixture, (tx, record) =>
      refreshCase(
        tx,
        positiveFixture,
        record,
        deps,
        "wrong-refresh-time",
        positive.requestId,
      ),
    );
    assert.equal(receipts.length, 12);
    result = {
      schemaVersion: 1,
      customerId: positiveFixture.actor.customerId,
      positiveProjectId: positiveFixture.projectId,
      negativeProjectId: negativeFixture.projectId,
      originalRequestId: positive.requestId,
      cases: receipts,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    // No deletions: valid committed controls remain in the reserved fixture.
    // Every resource is drained, even if an earlier close fails.
    try {
      await db.$disconnect();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      observer?.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const pool of [writerPool, observerPool])
      try {
        await pool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primaryError ? [primaryError] : []), ...cleanupErrors],
      "Reconciliation commit probe cleanup failed",
      { cause: primaryError ?? cleanupErrors[0] },
    );
  if (primaryError) throw primaryError;
  return result;
}
