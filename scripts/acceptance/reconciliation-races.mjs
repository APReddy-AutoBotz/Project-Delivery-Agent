// FR-EVD-009/012, NFR-REL-001/002: actual-role authorization and assignment races.
// Inject real dependencies from milestone-reconciliation.mjs; no compiled imports,
// implicit database, CLI entry point, test transaction, or transaction-option override.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const tables = Object.freeze([
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
]);
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const context = () => ({
  correlationId: "reconciliation-race-" + randomUUID(),
});
const command = (f) => ({
  projectId: f.projectId,
  milestoneId: f.milestoneId,
  ruleRevision: "milestone-required-state/v1",
  enabled: true,
  idempotencyKey: randomUUID(),
});
const read = (f, original) => ({
  projectId: f.projectId,
  requestId: original.request.id,
});
const refresh = (f, original, expectedAssignmentRevision) => ({
  ...read(f, original),
  expectedAssignmentRevision,
  idempotencyKey: randomUUID(),
});

// Exported pure checks are unit-harness seams, NOT a substitute for running SQL.
export function assertRaceSnapshot(rows, holder, contenders, observerPid) {
  const actors = [holder, ...contenders];
  assert(Number.isInteger(observerPid) && observerPid > 0);
  assert.equal(new Set(actors.map((a) => a.pid)).size, actors.length);
  assert.equal(new Set(actors.map((a) => a.tag)).size, actors.length);
  assert.equal(rows.length, actors.length);
  for (const actor of actors) {
    assert(Number.isInteger(actor.pid) && actor.pid > 0);
    assert.equal(typeof actor.tag, "string");
    assert(actor.tag.length > 0);
    assert.notEqual(actor.pid, observerPid);
    const matches = rows.filter((row) => row.pid === actor.pid);
    assert.equal(matches.length, 1);
    const row = matches[0];
    assert.equal(row.usename, "pdaa_api");
    assert.equal(row.application_name, actor.tag);
    assert(Array.isArray(row.blockers) && row.blockers.every(Number.isInteger));
    assert.equal(
      row.state,
      actor === holder ? "idle in transaction" : "active",
    );
    if (actor !== holder) assert.equal(row.wait_event_type, "Lock");
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const reaches = (pid, seen = new Set()) => {
    if (pid === holder.pid) return true;
    if (seen.has(pid) || !byPid.has(pid)) return false;
    const next = new Set([...seen, pid]);
    return byPid.get(pid).blockers.some((blocker) => reaches(blocker, next));
  };
  for (const actor of contenders)
    assert(reaches(actor.pid), "No observed path to exact holder");
}

export function assertHistoryDelta(before, after, expected = {}) {
  assert.deepEqual(Object.keys(before).sort(), [...tables].sort());
  assert.deepEqual(Object.keys(after).sort(), [...tables].sort());
  assert(Object.keys(expected).every((key) => tables.includes(key)));
  const actual = {};
  for (const table of tables) {
    for (const state of [before, after]) {
      assert(Number.isInteger(state[table].count) && state[table].count >= 0);
      assert.match(state[table].sha256, /^[a-f0-9]{64}$/);
    }
    actual[table] = after[table].count - before[table].count;
    assert.equal(actual[table], expected[table] ?? 0, table + " row delta");
    if (actual[table] === 0)
      assert.equal(
        after[table].sha256,
        before[table].sha256,
        table + " changed",
      );
  }
  return actual;
}

export function assertProofTopology(topology, fixture) {
  assert.deepEqual(
    Object.keys(topology).sort(),
    [
      "canonicalProjectId",
      "canonicalReceiptId",
      "milestoneId",
      "requiredWorkItems",
      "targets",
    ].sort(),
  );
  assert.equal(topology.canonicalProjectId, fixture.projectId);
  assert.equal(
    topology.canonicalReceiptId,
    fixture.canonicalBefore[0].canonicalReceiptId,
  );
  assert.equal(topology.milestoneId, fixture.milestoneId);
  for (const field of [
    "canonicalProjectId",
    "canonicalReceiptId",
    "milestoneId",
  ])
    assert.match(topology[field], uuid);
  assert.equal(topology.requiredWorkItems.length, 3);
  assert.equal(topology.targets.length, 4);
  for (const field of ["id", "workItemId"])
    assert.equal(
      new Set(topology.requiredWorkItems.map((row) => row[field])).size,
      3,
    );
  for (const row of topology.requiredWorkItems) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["id", "milestoneId", "workItemId"].sort(),
    );
    for (const field of ["id", "milestoneId", "workItemId"])
      assert.match(row[field], uuid);
    assert.equal(row.milestoneId, topology.milestoneId);
  }
  const milestones = topology.targets.filter(
    (row) => row.targetKind === "MILESTONE",
  );
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].targetId, topology.milestoneId);
  assert.equal(milestones[0].requiredWorkItemId, null);
  const work = topology.targets.filter((row) => row.targetKind === "WORK_ITEM");
  assert.equal(work.length, 3);
  for (const required of topology.requiredWorkItems) {
    const matches = work.filter(
      (row) =>
        row.requiredWorkItemId === required.id &&
        row.targetId === required.workItemId,
    );
    assert.equal(matches.length, 1);
  }
  const identityFields = [
    "bindingId",
    "factId",
    "sourceId",
    "versionId",
    "evidenceId",
  ];
  const identities = [];
  for (const target of topology.targets) {
    assert.deepEqual(
      Object.keys(target).sort(),
      [
        "targetKind",
        "targetId",
        "requiredWorkItemId",
        "factType",
        ...identityFields,
      ].sort(),
    );
    assert.match(target.targetId, uuid);
    assert(
      typeof target.factType === "string" &&
        target.factType.length > 0 &&
        target.factType.length <= 96,
    );
    for (const field of identityFields) {
      assert.match(target[field], uuid);
      identities.push(target[field]);
    }
  }
  assert.equal(new Set(identities).size, identities.length);
}

// Copy only the original, finite public domain-error fields. Unknown errors,
// changed names/messages and lookalike plain objects never become pass evidence.
export function normalizeReconciliationOutcome(outcome, ProjectFactError) {
  if (outcome.status === "fulfilled") return { status: outcome.status };
  assert(outcome.status === "rejected", "Unexpected settlement status");
  const error = outcome.reason;
  assert(
    error instanceof ProjectFactError,
    "Infrastructure failure is not a domain denial",
  );
  assert(error.name === "ProjectFactError", "Unexpected domain error name");
  assert(
    ["DENIED", "REVISION_CONFLICT"].includes(error.code),
    "Unexpected domain error code",
  );
  assert(
    error.message === "Project fact operation rejected",
    "Unexpected domain error message",
  );
  return {
    status: outcome.status,
    error: { name: error.name, code: error.code, message: error.message },
  };
}

export function selectReconciliationContributor(topology, control) {
  assert.equal(control.projectId, topology.canonicalProjectId);
  const matches = topology.targets.filter(
    (target) => target.sourceId === control.sourceId,
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].factId, control.factId);
  // All topology fields are scalars; this is an exact, independent copy.
  return { ...matches[0] };
}

function fulfilled(outcome) {
  if (outcome.status !== "fulfilled") throw outcome.reason;
  return outcome.value;
}
function denied(outcome, code, ProjectFactError) {
  assert.equal(outcome.status, "rejected");
  if (outcome.observationError) throw outcome.observationError;
  assert(
    outcome.reason instanceof ProjectFactError,
    "Infrastructure failure is not a domain denial",
  );
  assert.equal(outcome.reason.code, code);
  assert.deepEqual(
    outcome.observedOutcome,
    normalizeReconciliationOutcome(outcome, ProjectFactError),
  );
}
function assessmentReceipt(value) {
  assert(value && ["available", "restricted"].includes(value.visibility));
  return {
    assessmentId: value.assessmentId,
    projectId: value.projectId,
    milestoneId: value.milestoneId,
    asOf: value.asOf,
    historical: value.historical,
    replayed: value.replayed,
    visibility: value.visibility,
    revalidationRequired: value.revalidationRequired,
    resultStatus: value.result?.status ?? null,
    resultSha256: value.result === null ? null : sha(value.result),
  };
}
function checkReceipt(value) {
  return { ...value, assessment: assessmentReceipt(value.assessment) };
}
function detailReceipt(value) {
  return value === null
    ? null
    : {
        request: value.request,
        assessment: assessmentReceipt(value.assessment),
      };
}
function available(value) {
  assert.equal(value.visibility, "available");
  assert.equal(value.revalidationRequired, false);
  assert.equal(value.result.status, "CONFLICTING");
}
function restricted(value) {
  assert.equal(value.visibility, "restricted");
  assert.equal(value.revalidationRequired, true);
  assert.equal(value.result, null);
}
function originalAvailable(value, first) {
  assert(value);
  assert.equal(value.request.id, first.request.id);
  assert.equal(value.assessment.assessmentId, first.assessment.assessmentId);
  available(value.assessment);
  assert.equal(sha(value.assessment.result), sha(first.assessment.result));
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Command did not reach its commit latch within 3 seconds",
              ),
            ),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyReconciliationRaces({
  owner,
  connection,
  customerId,
  referenceProjectId,
  prefix,
  reserveFixture,
  allowRun,
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
}) {
  // The production wrapper supplies reconciliationAcceptanceGuard. Do not replace
  // it with DATA_MODE alone: customer-composition deliberately has DATA_MODE=customer.
  allowRun();
  assert.equal(connection.user, "pdaa_api");
  assert.equal(typeof connection.host, "string");
  assert(connection.host.length);
  assert.equal(typeof connection.database, "string");
  assert(connection.database.length);
  assert.match(customerId, uuid);
  assert.match(referenceProjectId, uuid);
  assert.equal(typeof prefix, "string");
  assert(prefix.length > 0 && prefix.length < 80);
  const receipt = {
    schemaVersion: 1,
    customerId,
    referenceProjectId,
    semantics:
      "Observed production repository transactions; original committed SQL projections; not native-COMMIT wire receipts",
    observer: null,
    fixtures: [],
    cases: [],
  };
  const pending = [],
    closers = [],
    releases = new Set();
  const pool = new Pool({ ...connection, max: 1, query_timeout: 3000 });
  closers.push(() => pool.end());
  let observer;
  return runWithCleanup(
    async () => {
      observer = await pool.connect();
      // Release the separately held observer before ending its one-client pool.
      closers.unshift(() => observer.release());
      receipt.observer = (
        await observer.query(`SELECT current_user AS role,
      session_user AS "sessionUser", pg_backend_pid()::int AS pid,
      current_database() AS database`)
      ).rows[0];
      assert.equal(receipt.observer.role, "pdaa_api");
      assert.equal(receipt.observer.sessionUser, "pdaa_api");
      assert.equal(receipt.observer.database, connection.database);
      async function activity(pids) {
        return (
          await observer.query(
            `SELECT pid,usename,application_name,state,
        wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])
        ORDER BY pid`,
            [pids],
          )
        ).rows;
      }
      function peer(spec, hold = false) {
        const db = createDatabase({
          ...connection,
          application_name: "pdaa-reconciliation-race-" + randomUUID(),
        });
        let closed = false;
        const close = async () => {
          if (!closed) {
            closed = true;
            await db.$disconnect();
          }
        };
        closers.push(close);
        const ready = gate(),
          release = gate();
        if (hold) releases.add(release);
        const record = {
          name: spec.name,
          tag: null,
          pid: null,
          input: spec.input,
          actor: spec.actor,
          correlationId: spec.context?.correlationId ?? null,
          callbackReturned: false,
          beforeCommit: null,
          outcome: null,
        };
        // The application_name is read from the actual connection, not guessed
        // from a receipt string; preflight does not claim to be the transaction PID.
        const preflight = db.$queryRaw`SELECT current_user AS role, session_user AS "sessionUser",
        current_database() AS database, current_setting('application_name') AS tag`;
        const wrapped = observeTransactions(db, {
          started(pid) {
            assert.equal(
              record.pid,
              null,
              "Unexpected extra repository transaction",
            );
            record.pid = pid;
          },
          async beforeCommit(pid) {
            record.callbackReturned = true;
            const rows = await activity([pid]);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].usename, "pdaa_api");
            assert.equal(rows[0].application_name, record.tag);
            assert.equal(rows[0].state, "idle in transaction");
            record.beforeCommit = rows[0];
            if (hold) {
              ready.resolve();
              const decision = await release.promise;
              if (decision !== "commit")
                throw new Error("Aborted incomplete race observation");
            }
          },
        });
        const promise = (async () => {
          const rows = await preflight;
          assert.equal(rows.length, 1);
          const row = rows[0];
          assert.equal(row.role, "pdaa_api");
          assert.equal(row.sessionUser, "pdaa_api");
          assert.equal(row.database, connection.database);
          assert.match(row.tag, /^pdaa-reconciliation-race-/);
          record.tag = row.tag;
          record.connection = row;
          const result = await spec.run(wrapped);
          return result;
        })();
        // Normalize immediately so expected domain failures are drained, not
        // swallowed, and do not masquerade as cleanup failures.
        const observeSettlement = (outcome) => {
          try {
            record.outcome = normalizeReconciliationOutcome(
              outcome,
              ProjectFactError,
            );
            return { ...outcome, observedOutcome: record.outcome };
          } catch (observationError) {
            // Keep the original rejection for propagation/cleanup without copying
            // its arbitrary message, stack, driver metadata or credentials.
            return { ...outcome, observationError };
          }
        };
        const settled = promise.then(
          (value) => observeSettlement({ status: "fulfilled", value }),
          (reason) => observeSettlement({ status: "rejected", reason }),
        );
        pending.push(settled);
        return { record, ready, release, settled, close };
      }
      async function one(spec) {
        const p = peer(spec);
        try {
          const value = fulfilled(await p.settled);
          assert(p.record.callbackReturned && p.record.beforeCommit);
          return {
            value,
            observation: { ...p.record, completion: "repository-returned" },
          };
        } finally {
          await p.close();
        }
      }
      async function race(holderSpec, contenderSpecs) {
        const holder = peer(holderSpec, true),
          participants = [holder];
        try {
          await bounded(
            Promise.race([
              holder.ready.promise,
              holder.settled.then((outcome) => {
                fulfilled(outcome);
                throw new Error("Holder completed without a hold");
              }),
            ]),
          );
          participants.push(...contenderSpecs.map((spec) => peer(spec)));
          const contenderRecords = participants.slice(1).map((p) => p.record);
          // Never change this imported helper's 3-second deadline or its SQL.
          await waitForTransactionBlockers(
            observer,
            holder.record.pid,
            contenderRecords,
          );
          const blocked = await activity(participants.map((p) => p.record.pid));
          assertRaceSnapshot(
            blocked,
            holder.record,
            contenderRecords,
            receipt.observer.pid,
          );
          holder.release.resolve("commit");
          releases.delete(holder.release);
          const outcomes = await Promise.all(
            participants.map((p) => p.settled),
          );
          fulfilled(outcomes[0]);
          const observations = participants.map((p, i) => ({
            ...p.record,
            completion:
              outcomes[i].status === "fulfilled"
                ? "repository-returned"
                : "repository-rejected",
          }));
          return { outcomes, observations, blocked };
        } finally {
          holder.release.resolve("abort");
          releases.delete(holder.release);
          await Promise.all(participants.map((p) => p.settled));
          await drainAndClose(
            [],
            participants.map((p) => p.close),
          );
        }
      }
      async function history(f) {
        const result = {};
        for (const table of tables) {
          const scope =
            table === "AuditEvent"
              ? `detail->>'projectId'=$2`
              : `"projectId"=$2::uuid`;
          const rows = (
            await observer.query(
              `SELECT to_jsonb(t) AS row FROM "${table}" t
          WHERE "customerId"=$1::uuid AND ${scope} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 5001`,
              [customerId, f.projectId],
            )
          ).rows.map((r) => r.row);
          assert(rows.length <= 5000, table + " fingerprint overflow");
          result[table] = { count: rows.length, sha256: sha(rows) };
        }
        return result;
      }
      async function heads(f) {
        const scope = [customerId, f.projectId];
        return {
          assessments: (
            await observer.query(
              `SELECT id,"customerId","projectId","milestoneId",
          "reconciliationCheckId",status,complete,sealed,"targetCount","versionCount","contributorCount"
          FROM "MilestoneConsistencyAssessment" WHERE "customerId"=$1 AND "projectId"=$2 ORDER BY id`,
              scope,
            )
          ).rows,
          requests: (
            await observer.query(
              `SELECT id,"customerId","projectId","milestoneId",
          "originalAssessmentId","originCommandId",sealed FROM "MilestoneReconciliationRequest"
          WHERE "customerId"=$1 AND "projectId"=$2 ORDER BY id`,
              scope,
            )
          ).rows,
          checks: (
            await observer.query(
              `SELECT id,"customerId","projectId",subject,"idempotencyKey",
          "assessmentId","requestId",outcome FROM "MilestoneReconciliationCheck"
          WHERE "customerId"=$1 AND "projectId"=$2 ORDER BY id`,
              scope,
            )
          ).rows,
          assignments: (
            await observer.query(
              `SELECT id,"customerId","projectId","requestId",
          revision,"previousAssignmentId",kind,actor,"idempotencyKey",reason,"recipientSubject"
          FROM "MilestoneReconciliationAssignment" WHERE "customerId"=$1 AND "projectId"=$2 ORDER BY revision`,
              scope,
            )
          ).rows,
        };
      }
      async function audits(specs) {
        const ids = specs.flatMap((s) =>
          s.context ? [s.context.correlationId] : [],
        );
        assert.equal(new Set(ids).size, ids.length);
        if (!ids.length) return [];
        return (
          await observer.query(
            `SELECT id,"customerId",actor,event,"correlationId","occurredAt",detail
        FROM "AuditEvent" WHERE "customerId"=$1 AND "correlationId"=ANY($2::text[])
        ORDER BY "correlationId",event,id`,
            [customerId, ids],
          )
        ).rows;
      }
      function auditEvents(rows, spec, expected) {
        const own = rows.filter(
          (r) => r.correlationId === spec.context.correlationId,
        );
        assert.deepEqual(own.map((r) => r.event).sort(), [...expected].sort());
        assert(
          own.every(
            (r) =>
              r.actor === spec.actor.subject && r.customerId === customerId,
          ),
        );
      }
      async function source(f) {
        const sourceId = f.bindings[0].entry.sourceId;
        const rows = (
          await observer.query(
            `SELECT a."customerId",a."projectId",a."factId",a."sourceId",a.revision,a.state,
        ARRAY(SELECT subject FROM "FactSourceReader" r WHERE r."customerId"=a."customerId"
          AND r."projectId"=a."projectId" AND r."sourceId"=a."sourceId" ORDER BY subject) AS readers
        FROM "FactSourceAccess" a WHERE a."customerId"=$1 AND a."projectId"=$2 AND a."sourceId"=$3`,
            [customerId, f.projectId, sourceId],
          )
        ).rows;
        assert.equal(rows.length, 1);
        return rows[0];
      }
      async function immutable(f) {
        return (
          await observer.query(
            `SELECT p.id,p."customerId",p."portfolioId",c.sealed,
        r.id AS "canonicalReceiptId",(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id)
          FROM "ProjectResponsibility" x WHERE x."customerId"=p."customerId" AND x."projectId"=p.id) AS responsibilities
        FROM "Project" p JOIN "CanonicalProject" c ON c.id=p.id AND c."customerId"=p."customerId"
        JOIN "CanonicalCreationReceipt" r ON r."projectId"=p.id AND r."customerId"=p."customerId"
        WHERE p."customerId"=$1 AND p.id=$2`,
            [customerId, f.projectId],
          )
        ).rows;
      }
      async function proofTopology(f, first) {
        const scope = [customerId, f.projectId, first.assessment.assessmentId];
        const headers = (
          await observer.query(
            `SELECT c.id AS "canonicalProjectId",r.id AS "canonicalReceiptId",m.id AS "milestoneId"
        FROM "MilestoneConsistencyAssessment" a
        JOIN "CanonicalProject" c ON c."customerId"=a."customerId" AND c.id=a."projectId" AND c.sealed
        JOIN "CanonicalCreationReceipt" r ON r."customerId"=a."customerId" AND r."projectId"=a."projectId" AND r.id=a."canonicalReceiptId"
        JOIN "Milestone" m ON m."customerId"=a."customerId" AND m."projectId"=a."projectId" AND m.id=a."milestoneId"
        WHERE a."customerId"=$1 AND a."projectId"=$2 AND a.id=$3 AND a.sealed LIMIT 2`,
            scope,
          )
        ).rows;
        assert.equal(headers.length, 1);
        assert.equal(headers[0].milestoneId, f.milestoneId);
        const requiredWorkItems = (
          await observer.query(
            `SELECT r.id,r."milestoneId",r."workItemId"
        FROM "RequiredWorkItem" r
        JOIN "Milestone" m ON m."customerId"=r."customerId" AND m."projectId"=r."projectId" AND m.id=r."milestoneId"
        JOIN "WorkItem" w ON w."customerId"=r."customerId" AND w."projectId"=r."projectId" AND w.id=r."workItemId"
        WHERE r."customerId"=$1 AND r."projectId"=$2 AND r."milestoneId"=$3 ORDER BY r.id LIMIT 4`,
            [customerId, f.projectId, f.milestoneId],
          )
        ).rows;
        // The ORIGINAL assessment's concrete contributor rows, not merely the
        // fixture's returned metadata, establish that the raced source contributed.
        const targets = (
          await observer.query(
            `SELECT t."targetKind",COALESCE(t."workItemId",t."milestoneId") AS "targetId",
        t."requiredWorkItemId",b.id AS "bindingId",b."factId",b."factType",v."sourceId",v.id AS "versionId",e.id AS "evidenceId"
        FROM "MilestoneConsistencyTarget" t
        JOIN "CanonicalStateBinding" b ON b."customerId"=t."customerId" AND b."projectId"=t."projectId"
          AND b.id=t."bindingId" AND b."factId"=t."factId" AND b."factType"=t."factType" AND b.sealed
          AND b."targetKind"=t."targetKind"
          AND ((t."targetKind"='MILESTONE' AND b."milestoneId"=t."milestoneId" AND b."workItemId" IS NULL)
            OR (t."targetKind"='WORK_ITEM' AND b."workItemId"=t."workItemId" AND b."milestoneId" IS NULL))
        JOIN "CanonicalStateBindingReceipt" birth ON birth."customerId"=b."customerId" AND birth."projectId"=b."projectId"
          AND birth."bindingId"=b.id AND birth."factId"=b."factId"
        JOIN "MilestoneConsistencyContributorVersion" cv ON cv."customerId"=t."customerId" AND cv."projectId"=t."projectId"
          AND cv."assessmentId"=t."assessmentId" AND cv."targetRowId"=t.id AND cv."bindingId"=b.id AND cv."factId"=b."factId"
          AND cv."sourceId"=birth."sourceId" AND cv."versionId"=birth."versionId" AND cv."evidenceId"=birth."evidenceId"
        JOIN "ProjectFactVersion" v ON v."customerId"=cv."customerId" AND v."projectId"=cv."projectId" AND v."factId"=cv."factId"
          AND v.id=cv."versionId" AND v."sourceId"=cv."sourceId" AND v."evidenceId"=cv."evidenceId"
        JOIN "FactEvidence" e ON e."customerId"=v."customerId" AND e."projectId"=v."projectId" AND e."factId"=v."factId"
          AND e."sourceId"=v."sourceId" AND e.id=v."evidenceId"
        WHERE t."customerId"=$1 AND t."projectId"=$2 AND t."assessmentId"=$3
        ORDER BY t."targetKind",COALESCE(t."workItemId",t."milestoneId") LIMIT 5`,
            scope,
          )
        ).rows;
        return { ...headers[0], requiredWorkItems, targets };
      }
      function selectedContributor(fixture, control) {
        return selectReconciliationContributor(
          fixture.fixtureReceipt.proofTopology,
          control,
        );
      }
      const checkSpec = (f, actor, input) => ({
        name: "check",
        actor,
        input,
        context: context(),
        run(db) {
          assert.equal(input.projectId, f.projectId);
          assert.equal(input.milestoneId, f.milestoneId);
          return new DatabaseMilestoneReconciliationRepository(db).check(
            actor,
            input,
            this.context,
          );
        },
      });
      const getSpec = (f, first) => ({
        name: "PM original-proof GET",
        actor: f.pm,
        input: read(f, first),
        run(db) {
          return new DatabaseMilestoneReconciliationRepository(db).get(
            f.pm,
            this.input,
          );
        },
      });
      const refreshSpec = (f, input) => ({
        name: "assignment refresh",
        actor: f.actor,
        input,
        context: context(),
        run(db) {
          return new DatabaseMilestoneReconciliationRepository(
            db,
          ).refreshAssignment(f.actor, input, this.context);
        },
      });
      const sourceSpec = (f, before) => ({
        name: "remove PM source reader",
        actor: f.actor,
        input: {
          projectId: f.projectId,
          sourceId: before.sourceId,
          expectedRevision: before.revision,
          state: "AVAILABLE",
          readers: [f.actor.subject],
        },
        context: context(),
        run(db) {
          return new DatabaseProjectFactRepository(db).setSourceAccess(
            f.actor,
            this.input,
            this.context,
          );
        },
      });
      async function reserve(label, creatorIsPm = false) {
        const db = createDatabase(connection);
        const f = await runWithCleanup(
          () =>
            reserveFixture(
              owner,
              db,
              customerId,
              referenceProjectId,
              prefix + "-" + label + "-" + randomUUID().slice(0, 8),
              1,
            ),
          () => db.$disconnect(),
        );
        assert.match(f.projectId, uuid);
        assert.match(f.milestoneId, uuid);
        assert.notEqual(f.projectId, referenceProjectId);
        assert(!receipt.fixtures.some((row) => row.projectId === f.projectId));
        assert.equal(f.bindings.length, 4);
        assert.deepEqual(f.actor.roles, ["pmo_admin"]);
        assert.deepEqual(f.pm.roles, ["project_manager"]);
        assert.equal(f.actor.customerId, customerId);
        assert.equal(f.pm.customerId, customerId);
        assert.notEqual(f.actor.subject, f.pm.subject);
        const canonical = await immutable(f);
        assert.equal(canonical.length, 1);
        assert.equal(canonical[0].sealed, true);
        const pms = canonical[0].responsibilities.filter(
          (r) => r.role === "PROJECT_MANAGER",
        );
        assert.equal(pms.length, 1);
        assert.equal(pms[0].subject, f.pm.subject);
        const input = command(f),
          initialSpec = checkSpec(f, creatorIsPm ? f.pm : f.actor, input);
        const initial = await one(initialSpec),
          first = initial.value;
        assert.equal(first.outcome, "CREATED");
        assert.equal(first.replayed, false);
        available(first.assessment);
        assert.equal(first.request.assignment.revision, 1);
        assert.equal(first.request.assignment.recipientSubject, f.pm.subject);
        const initialSql = await heads(f),
          initialAudits = await audits([initialSpec]);
        for (const kind of ["assessments", "requests", "checks", "assignments"])
          assert.equal(initialSql[kind].length, 1);
        assert.equal(
          initialSql.assessments[0].id,
          first.assessment.assessmentId,
        );
        assert.equal(
          initialSql.assessments[0].reconciliationCheckId,
          first.checkId,
        );
        assert.equal(initialSql.assessments[0].status, "CONFLICTING");
        assert.equal(initialSql.assessments[0].sealed, true);
        assert.equal(initialSql.requests[0].id, first.request.id);
        assert.equal(
          initialSql.requests[0].originalAssessmentId,
          first.assessment.assessmentId,
        );
        assert.equal(initialSql.requests[0].originCommandId, first.checkId);
        assert.equal(initialSql.requests[0].sealed, true);
        assert.equal(initialSql.checks[0].id, first.checkId);
        assert.equal(
          initialSql.checks[0].assessmentId,
          first.assessment.assessmentId,
        );
        assert.equal(initialSql.checks[0].requestId, first.request.id);
        assert.equal(initialSql.checks[0].outcome, "CREATED");
        assert.equal(initialSql.checks[0].subject, initialSpec.actor.subject);
        assert.equal(initialSql.checks[0].idempotencyKey, input.idempotencyKey);
        assert.equal(initialSql.assignments[0].id, first.request.assignment.id);
        assert.equal(initialSql.assignments[0].requestId, first.request.id);
        assert.equal(initialSql.assignments[0].revision, 1);
        assert.equal(initialSql.assignments[0].previousAssignmentId, null);
        assert.equal(initialSql.assignments[0].kind, "INITIAL");
        auditEvents(initialAudits, initialSpec, [
          "milestone.consistency.captured",
          "milestone.reconciliation.requested",
          "milestone.reconciliation.assigned",
          "milestone.reconciliation.checked",
        ]);
        const fixtureReceipt = {
          label,
          projectId: f.projectId,
          milestoneId: f.milestoneId,
          actor: f.actor,
          pm: f.pm,
          canonicalBefore: canonical,
          canonicalAfter: null,
          proofTopology: await proofTopology(f, first),
          initial: {
            observation: initial.observation,
            result: checkReceipt(first),
            sql: initialSql,
            audits: initialAudits,
          },
        };
        assertProofTopology(fixtureReceipt.proofTopology, fixtureReceipt);
        for (const target of fixtureReceipt.proofTopology.targets) {
          const bindings = f.bindings.filter(
            (binding) => binding.id === target.bindingId,
          );
          assert.equal(bindings.length, 1);
          const binding = bindings[0];
          for (const field of ["targetKind", "targetId", "factId", "factType"])
            assert.equal(binding[field], target[field]);
          assert.equal(binding.entry.id, target.versionId);
          assert.equal(binding.entry.sourceId, target.sourceId);
          assert.equal(binding.entry.evidenceId, target.evidenceId);
          const contributors = first.assessment.result.contributors.filter(
            (contributor) => contributor.bindingId === target.bindingId,
          );
          assert.equal(contributors.length, 1);
          const contributor = contributors[0];
          for (const field of ["targetKind", "targetId", "factId", "factType"])
            assert.equal(contributor[field], target[field]);
          assert.deepEqual(contributor.supportingVersionIds, [
            target.versionId,
          ]);
          assert.deepEqual(contributor.supportingEvidenceIds, [
            target.evidenceId,
          ]);
        }
        receipt.fixtures.push(fixtureReceipt);
        return { f, first, input, fixtureReceipt };
      }
      async function finish(
        name,
        f,
        before,
        expected,
        execution,
        specs,
        values,
        controls = null,
      ) {
        const after = await history(f),
          delta = assertHistoryDelta(before, after, expected);
        const row = {
          name,
          customerId,
          projectId: f.projectId,
          milestoneId: f.milestoneId,
          before,
          after,
          delta,
          observations: execution.observations,
          blocked: execution.blocked,
          results: values,
          sql: await heads(f),
          audits: await audits(specs),
          controls,
        };
        receipt.cases.push(row);
        return row;
      }

      // Grant deletion wins before both a fresh capture and its actor's old-key replay.
      const grantFixture = await reserve("grant"),
        gf = grantFixture.f;
      const grantRows = async () =>
        (
          await observer.query(
            `SELECT id,"customerId",subject,"scopeType","scopeId",role
      FROM "AccessGrant" WHERE "customerId"=$1 AND subject=$2 ORDER BY id`,
            [customerId, gf.actor.subject],
          )
        ).rows;
      const grantBefore = await grantRows();
      assert.equal(grantBefore.length, 1);
      assert.equal(grantBefore[0].role, "pmo_admin");
      assert.equal(grantBefore[0].scopeType, "portfolio");
      assert.equal(
        grantBefore[0].scopeId,
        grantFixture.fixtureReceipt.canonicalBefore[0].portfolioId,
      );
      const revoke = {
        name: "revoke creator grant",
        actor: gf.actor,
        input: {
          subject: gf.actor.subject,
          scopeType: "portfolio",
          scopeId: grantBefore[0].scopeId,
        },
        context: context(),
        run(db) {
          return new DatabaseProjectRepository(db).revokeGrant(
            gf.actor,
            this.input,
            this.context.correlationId,
          );
        },
      };
      const grantSpecs = [
        revoke,
        checkSpec(gf, gf.actor, command(gf)),
        checkSpec(gf, gf.actor, grantFixture.input),
      ];
      let before = await history(gf),
        execution = await race(grantSpecs[0], grantSpecs.slice(1));
      assert.equal(fulfilled(execution.outcomes[0]), undefined);
      execution.outcomes
        .slice(1)
        .forEach((outcome) => denied(outcome, "DENIED", ProjectFactError));
      const grantAfter = await grantRows();
      assert.deepEqual(grantAfter, []);
      let row = await finish(
        "grant-first-fresh-and-replay",
        gf,
        before,
        { AuditEvent: 2 },
        execution,
        grantSpecs,
        [
          { returned: "undefined" },
          ...execution.outcomes
            .slice(1)
            .map((outcome) => ({
              errorCode: outcome.observedOutcome.error.code,
            })),
        ],
        { before: grantBefore, after: grantAfter },
      );
      auditEvents(row.audits, revoke, ["access.revoked"]);
      for (const spec of grantSpecs.slice(1)) {
        auditEvents(row.audits, spec, [
          "milestone.reconciliation.check.denied",
        ]);
        assert.deepEqual(
          row.audits.find((a) => a.correlationId === spec.context.correlationId)
            .detail,
          { projectId: gf.projectId, reason: "DENIED" },
        );
      }

      // Source deletion wins before PM original delivery, PM replay, and fresh PM check.
      const sourceFixture = await reserve("source", true),
        sf = sourceFixture.f;
      let sourceBefore = await source(sf);
      const sourceContributor = selectedContributor(
        sourceFixture,
        sourceBefore,
      );
      assert(sourceBefore.readers.includes(sf.pm.subject));
      const sourceSpecs = [
        sourceSpec(sf, sourceBefore),
        getSpec(sf, sourceFixture.first),
        checkSpec(sf, sf.pm, sourceFixture.input),
        checkSpec(sf, sf.pm, command(sf)),
      ];
      before = await history(sf);
      execution = await race(sourceSpecs[0], sourceSpecs.slice(1));
      const [sourceWrite, detail, replay, fresh] =
        execution.outcomes.map(fulfilled);
      assert.equal(sourceWrite.sourceId, sourceBefore.sourceId);
      assert(
        Number.isInteger(sourceWrite.revision) &&
          sourceWrite.revision > sourceBefore.revision,
      );
      for (const result of [detail, replay]) {
        assert(result);
        assert.equal(result.request.id, sourceFixture.first.request.id);
        assert.equal(
          result.assessment.assessmentId,
          sourceFixture.first.assessment.assessmentId,
        );
        restricted(result.assessment);
      }
      assert.equal(replay.checkId, sourceFixture.first.checkId);
      assert.equal(replay.replayed, true);
      assert.equal(replay.outcome, "CREATED");
      assert.equal(fresh.replayed, false);
      assert.equal(fresh.outcome, "NO_REQUEST");
      assert.equal(fresh.request, null);
      restricted(fresh.assessment);
      assert.notEqual(
        fresh.assessment.assessmentId,
        sourceFixture.first.assessment.assessmentId,
      );
      let sourceAfter = await source(sf);
      assert.deepEqual(sourceAfter, {
        ...sourceBefore,
        revision: sourceWrite.revision,
        readers: [sf.actor.subject],
      });
      row = await finish(
        "source-first-detail-replay-fresh",
        sf,
        before,
        {
          MilestoneConsistencyAssessment: 1,
          MilestoneConsistencyTarget: 4,
          FactAssessment: 4,
          FactAssessmentVersion: 4,
          MilestoneReconciliationCheck: 1,
          AuditEvent: 3,
        },
        execution,
        sourceSpecs,
        [
          sourceWrite,
          detailReceipt(detail),
          checkReceipt(replay),
          checkReceipt(fresh),
        ],
        {
          before: sourceBefore,
          after: sourceAfter,
          selectedContributor: sourceContributor,
        },
      );
      auditEvents(row.audits, sourceSpecs[0], ["fact.source_access.changed"]);
      auditEvents(row.audits, sourceSpecs[2], []);
      auditEvents(row.audits, sourceSpecs[3], [
        "milestone.consistency.captured",
        "milestone.reconciliation.checked",
      ]);
      const freshHeader = row.sql.assessments.find(
        (a) => a.id === fresh.assessment.assessmentId,
      );
      assert.equal(freshHeader.status, "REVALIDATION_REQUIRED");
      assert.equal(freshHeader.reconciliationCheckId, fresh.checkId);
      assert.equal(freshHeader.sealed, true);
      const freshCheck = row.sql.checks.find((c) => c.id === fresh.checkId);
      assert.equal(freshCheck.assessmentId, fresh.assessment.assessmentId);
      assert.equal(freshCheck.requestId, null);
      assert.equal(freshCheck.outcome, "NO_REQUEST");

      // A real PM GET holds the common Project lock while contenders reach it.
      const assignmentFixture = await reserve("assignment"),
        af = assignmentFixture.f,
        original = assignmentFixture.first;
      const distinctInputs = [
        refresh(af, original, 1),
        refresh(af, original, 1),
      ];
      const distinctSpecs = [
        getSpec(af, original),
        ...distinctInputs.map((input) => refreshSpec(af, input)),
      ];
      before = await history(af);
      execution = await race(distinctSpecs[0], distinctSpecs.slice(1));
      originalAvailable(fulfilled(execution.outcomes[0]), original);
      const winners = execution.outcomes
        .slice(1)
        .map((outcome, n) => ({ outcome, n }))
        .filter((r) => r.outcome.status === "fulfilled");
      assert.equal(winners.length, 1);
      const winnerIndex = winners[0].n,
        winner = fulfilled(winners[0].outcome);
      denied(
        execution.outcomes[2 - winnerIndex],
        "REVISION_CONFLICT",
        ProjectFactError,
      );
      assert.equal(winner.replayed, false);
      assert.equal(winner.requestId, original.request.id);
      assert.equal(winner.assignment.revision, 2);
      assert.equal(winner.assignment.recipientSubject, af.pm.subject);
      row = await finish(
        "assignment-distinct-key-CAS",
        af,
        before,
        { MilestoneReconciliationAssignment: 1, AuditEvent: 2 },
        execution,
        distinctSpecs,
        [
          detailReceipt(fulfilled(execution.outcomes[0])),
          ...execution.outcomes
            .slice(1)
            .map((o) =>
              o.status === "fulfilled"
                ? o.value
                : { errorCode: o.observedOutcome.error.code },
            ),
        ],
      );
      auditEvents(row.audits, distinctSpecs[winnerIndex + 1], [
        "milestone.reconciliation.assigned",
      ]);
      auditEvents(row.audits, distinctSpecs[2 - winnerIndex], [
        "milestone.reconciliation.assignment.denied",
      ]);
      let revisionRow = row.sql.assignments.find(
        (a) => a.id === winner.assignment.id,
      );
      assert.equal(
        revisionRow.previousAssignmentId,
        original.request.assignment.id,
      );
      assert.equal(
        revisionRow.idempotencyKey,
        distinctInputs[winnerIndex].idempotencyKey,
      );

      const sharedInput = refresh(af, original, 2);
      const sharedSpecs = [
        getSpec(af, original),
        refreshSpec(af, sharedInput),
        refreshSpec(af, sharedInput),
      ];
      before = await history(af);
      execution = await race(sharedSpecs[0], sharedSpecs.slice(1));
      originalAvailable(fulfilled(execution.outcomes[0]), original);
      const shared = execution.outcomes.slice(1).map(fulfilled);
      assert.deepEqual(shared.map((r) => r.replayed).sort(), [false, true]);
      assert.deepEqual(shared[0].assignment, shared[1].assignment);
      assert.equal(shared[0].assignment.revision, 3);
      assert.equal(shared[0].assignment.recipientSubject, af.pm.subject);
      row = await finish(
        "assignment-same-key-replay",
        af,
        before,
        { MilestoneReconciliationAssignment: 1, AuditEvent: 1 },
        execution,
        sharedSpecs,
        [detailReceipt(fulfilled(execution.outcomes[0])), ...shared],
      );
      for (let n = 0; n < 2; n++)
        auditEvents(
          row.audits,
          sharedSpecs[n + 1],
          shared[n].replayed ? [] : ["milestone.reconciliation.assigned"],
        );
      revisionRow = row.sql.assignments.find(
        (a) => a.id === shared[0].assignment.id,
      );
      assert.equal(revisionRow.previousAssignmentId, winner.assignment.id);
      assert.equal(revisionRow.idempotencyKey, sharedInput.idempotencyKey);

      before = await history(af);
      const oldSpec = refreshSpec(af, distinctInputs[winnerIndex]),
        old = await one(oldSpec);
      assert.equal(old.value.replayed, true);
      assert.deepEqual(old.value.assignment, winner.assignment);
      const pages = [],
        pageObservations = [];
      for (const [mode, actor] of [
        ["manage", af.actor],
        ["recipient", af.pm],
      ]) {
        const page = await one({
          name: mode + " live queue",
          actor,
          input: { projectId: af.projectId, limit: 20 },
          run(db) {
            return new DatabaseMilestoneReconciliationRepository(db).list(
              actor,
              this.input,
              mode,
            );
          },
        });
        assert.equal(page.value.live, true);
        assert.equal(page.value.next, null);
        assert.equal(page.value.requests.length, 1);
        assert.equal(page.value.requests[0].id, original.request.id);
        assert.deepEqual(
          page.value.requests[0].assignment,
          shared[0].assignment,
        );
        pages.push({ mode, page: page.value });
        pageObservations.push(page.observation);
      }
      row = await finish(
        "assignment-old-replay-live-head",
        af,
        before,
        {},
        { observations: [old.observation, ...pageObservations], blocked: [] },
        [oldSpec],
        [old.value, ...pages],
      );
      auditEvents(row.audits, oldSpec, []);

      // Positive ordering control: the authorized read wins before the source mutation.
      sourceBefore = await source(af);
      const readFirstContributor = selectedContributor(
        assignmentFixture,
        sourceBefore,
      );
      const readFirstSpecs = [
        getSpec(af, original),
        sourceSpec(af, sourceBefore),
      ];
      before = await history(af);
      execution = await race(readFirstSpecs[0], readFirstSpecs.slice(1));
      const winningRead = fulfilled(execution.outcomes[0]),
        changedSource = fulfilled(execution.outcomes[1]);
      originalAvailable(winningRead, original);
      const later = await one(getSpec(af, original));
      assert(later.value);
      restricted(later.value.assessment);
      assert.equal(
        later.value.assessment.assessmentId,
        original.assessment.assessmentId,
      );
      sourceAfter = await source(af);
      assert.equal(changedSource.sourceId, sourceBefore.sourceId);
      assert(
        Number.isInteger(changedSource.revision) &&
          changedSource.revision > sourceBefore.revision,
      );
      assert.deepEqual(sourceAfter, {
        ...sourceBefore,
        revision: changedSource.revision,
        readers: [af.actor.subject],
      });
      execution.observations.push(later.observation);
      row = await finish(
        "read-first-source-change-control",
        af,
        before,
        { AuditEvent: 1 },
        execution,
        readFirstSpecs,
        [detailReceipt(winningRead), changedSource, detailReceipt(later.value)],
        {
          before: sourceBefore,
          after: sourceAfter,
          selectedContributor: readFirstContributor,
        },
      );
      auditEvents(row.audits, readFirstSpecs[1], [
        "fact.source_access.changed",
      ]);

      for (const { f, first, fixtureReceipt } of [
        grantFixture,
        sourceFixture,
        assignmentFixture,
      ]) {
        fixtureReceipt.canonicalAfter = await immutable(f);
        assert.deepEqual(
          fixtureReceipt.canonicalAfter,
          fixtureReceipt.canonicalBefore,
        );
        assert.deepEqual(
          await proofTopology(f, first),
          fixtureReceipt.proofTopology,
        );
      }
      return receipt;
    },
    async () => {
      for (const release of releases) release.resolve("abort");
      await drainAndClose(pending, closers);
    },
  );
}
