// FR-EVD-009/012, NFR-REL-001/002: genuine scalar command contention.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "./common.mjs";
import {
  createDatabase,
  DatabaseScalarReconciliationRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
} from "../../packages/data/dist/index.js";
import { ProjectFactError } from "../../packages/domain/dist/index.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import {
  observeTransactions,
  waitForTransactionBlockers,
} from "./transaction-latch.mjs";
import { assertRaceSnapshot } from "./reconciliation-races.mjs";
import { assertScalarCommandRaces } from "./scalar-command-races-receipt.mjs";
import { runWithCleanup, drainAndClose } from "./fixture-cleanup.mjs";

export const scalarRaceCases = Object.freeze([
  "same-command",
  "same-business",
  "changed-fact-key",
  "refresh-cas",
  "refresh-retry",
]);
const tables = [
  "ScalarReconciliationRequest",
  "ScalarReconciliationCheck",
  "ScalarReconciliationAssignment",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
  "FactAuthorityConflict",
  "AuditEvent",
  "ProjectFact",
  "ProjectFactVersion",
  "FactEvidence",
];
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Scalar holder did not reach its latch")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyScalarCommandRaces(
  owner,
  connection,
  customerId,
  referenceProjectId,
) {
  reconciliationAcceptanceGuard();
  assert.equal(connection.user, "pdaa_api");
  const observerPool = new Pool({
    ...connection,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 3000,
  });
  const setup = createDatabase(connection);
  let observer;
  const pending = [],
    closers = [() => setup.$disconnect(), () => observerPool.end()],
    releases = [];
  return runWithCleanup(
    async () => {
      observer = await observerPool.connect();
      closers.unshift(() => observer.release());
      const principal = (
        await observer.query(
          "SELECT current_user AS role, pg_backend_pid() AS pid",
        )
      ).rows[0];
      assert.equal(principal.role, "pdaa_api");
      const receipt = {
        family: "scalar-command-races/v1",
        customerId,
        observer: principal,
        cases: [],
      };
      const activity = async (pids) =>
        (
          await observer.query(
            "SELECT pid,usename,application_name,state,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[]) ORDER BY pid",
            [pids],
          )
        ).rows;
      async function snapshot(projectId) {
        const rows = {};
        for (const table of tables) {
          const scope =
            table === "AuditEvent"
              ? "detail->>'projectId'=$2"
              : '"projectId"=$2::uuid';
          rows[table] = (
            await observer.query(
              `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${scope} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 5001`,
              [customerId, projectId],
            )
          ).rows.map((r) => r.row);
          assert(rows[table].length <= 5000, "Scalar snapshot overflow");
        }
        return rows;
      }
      function peer(actor, command, operation, hold = false) {
        const tag = "pdaa-scalar-race-" + randomUUID();
        const db = createDatabase({ ...connection, application_name: tag });
        const ready = gate(),
          release = gate();
        releases.push(release);
        const record = {
          pid: null,
          tag,
          actor: actor.subject,
          command,
          operation,
          correlationId: randomUUID(),
          callbackReturned: false,
        };
        const wrapped = observeTransactions(db, {
          started(pid) {
            assert.equal(record.pid, null);
            record.pid = pid;
          },
          async beforeCommit() {
            record.callbackReturned = true;
            if (hold) {
              ready.resolve();
              assert.equal(
                await release.promise,
                "commit",
                "Aborted incomplete scalar race",
              );
            }
          },
        });
        const repository = new DatabaseScalarReconciliationRepository(wrapped);
        const running = (async () => {
          const actual = (
            await db.$queryRaw`SELECT current_user AS role, current_setting('application_name') AS tag`
          )[0];
          assert.equal(actual.role, "pdaa_api");
          assert.equal(actual.tag, tag);
          return operation === "list"
            ? repository.list(actor, command, "recipient")
            : operation === "get"
              ? repository.get(actor, command)
              : repository[operation](actor, command, {
                  correlationId: record.correlationId,
                });
        })();
        const settled = running.then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        );
        pending.push(settled);
        closers.push(() => db.$disconnect());
        return { record, ready, release, settled };
      }
      for (const name of scalarRaceCases) {
        const f = await reserveScalarFixture(
          owner,
          setup,
          customerId,
          referenceProjectId,
          "scalar-race-" + name,
        );
        const repository = new DatabaseScalarReconciliationRepository(setup);
        const changedFact = name === "changed-fact-key";
        let otherFactId;
        if (changedFact) {
          const facts = new DatabaseProjectFactRepository(setup);
          const factType = "project.alternate_forecast";
          for (const [revision, actor] of [f.actor, f.pm].entries()) {
            const appended = await facts.appendHumanStatement(
              actor,
              {
                projectId: f.projectId,
                factType,
                expectedRevision: revision,
                idempotencyKey: randomUUID(),
                effectiveAt: new Date(Date.now() - 1000).toISOString(),
                validUntil: new Date(Date.now() + 86400000).toISOString(),
                originalStatement: "Synthetic alternate scalar forecast",
                value: {
                  type: "date",
                  value: revision === 0 ? "2026-11-01" : "2026-11-02",
                },
              },
              f.context,
            );
            otherFactId = appended.factId;
            const access = await facts.getSourceAccess(f.actor, {
              projectId: f.projectId,
              sourceId: appended.entry.sourceId,
            });
            await facts.setSourceAccess(
              f.actor,
              {
                projectId: f.projectId,
                sourceId: appended.entry.sourceId,
                expectedRevision: access.revision,
                state: "AVAILABLE",
                readers: [f.actor.subject, f.pm.subject],
              },
              f.context,
            );
          }
          const policy = await setup.authorityPolicyRevision.findFirstOrThrow({
            where: { customerId, projectId: f.projectId, factType: f.factType },
          });
          await new DatabaseAuthorityRepository(setup).appendPolicy(
            f.actor,
            {
              projectId: f.projectId,
              factType,
              expectedRevision: 0,
              idempotencyKey: randomUUID(),
              effectiveAt: new Date(Date.now() - 1000).toISOString(),
              definition: policy.definition,
            },
            f.context,
          );
          assert.notEqual(otherFactId, f.factId);
        }
        const refresh = name.startsWith("refresh");
        const original = refresh
          ? await repository.check(f.actor, f.command, f.context)
          : null;
        const before = await snapshot(f.projectId);
        const input = refresh
          ? {
              projectId: f.projectId,
              requestId: original.request.id,
              expectedAssignmentRevision: 1,
              idempotencyKey: randomUUID(),
            }
          : f.command;
        const other = changedFact
          ? { ...input, factId: otherFactId }
          : name === "same-business" || name === "refresh-cas"
            ? { ...input, idempotencyKey: randomUUID() }
            : input;
        // A real recipient queue read holds the Project coordination lock and
        // successfully returns an empty queue before initial request creation.
        const holder = peer(
          f.pm,
          {
            projectId: f.projectId,
            limit: 20,
          },
          "list",
          true,
        );
        let participants = [holder];
        try {
          await bounded(
            Promise.race([
              holder.ready.promise,
              holder.settled.then(() => {
                throw new Error("Scalar holder completed without latch");
              }),
            ]),
          );
          participants.push(
            peer(f.actor, input, refresh ? "refreshAssignment" : "check"),
            peer(
              name === "same-business" ? f.pm : f.actor,
              other,
              refresh ? "refreshAssignment" : "check",
            ),
          );
          await waitForTransactionBlockers(
            observer,
            holder.record.pid,
            participants.slice(1).map((p) => p.record),
          );
          const blocked = await activity(participants.map((p) => p.record.pid));
          assertRaceSnapshot(
            blocked,
            holder.record,
            participants.slice(1).map((p) => p.record),
            principal.pid,
          );
          holder.release.resolve("commit");
          const outcomes = await Promise.all(
            participants.map((p) => p.settled),
          );
          assert.equal(outcomes[0].status, "fulfilled");
          const contenders = outcomes.slice(1),
            successes = contenders
              .filter((o) => o.status === "fulfilled")
              .map((o) => o.value);
          if (name === "refresh-cas" || changedFact) {
            assert.equal(successes.length, 1);
            const error = contenders.find(
              (o) => o.status === "rejected",
            ).reason;
            assert(error instanceof ProjectFactError);
            assert.equal(
              error.code,
              changedFact ? "IDEMPOTENCY_CONFLICT" : "REVISION_CONFLICT",
            );
            assert.equal(error.message, "Project fact operation rejected");
          } else assert.equal(successes.length, 2);
          const checkedFactId = changedFact
            ? successes[0].assessment.factId
            : f.factId;
          if (changedFact) {
            assert.equal(successes[0].outcome, "CREATED");
            assert.equal(successes[0].replayed, false);
            assert([f.factId, otherFactId].includes(checkedFactId));
          }
          if (name === "same-command") {
            assert.deepEqual(successes.map((v) => v.replayed).sort(), [
              false,
              true,
            ]);
            assert.equal(successes[0].checkId, successes[1].checkId);
            assert.equal(
              successes[0].assessment.assessmentId,
              successes[1].assessment.assessmentId,
            );
          }
          if (name === "same-business") {
            assert.deepEqual(successes.map((v) => v.outcome).sort(), [
              "CREATED",
              "REUSED",
            ]);
            assert.notEqual(successes[0].checkId, successes[1].checkId);
            assert.notEqual(
              successes[0].assessment.assessmentId,
              successes[1].assessment.assessmentId,
            );
            assert.equal(successes[0].request.id, successes[1].request.id);
          }
          if (name === "refresh-retry") {
            assert.deepEqual(successes.map((v) => v.replayed).sort(), [
              false,
              true,
            ]);
            assert.equal(
              successes[0].assignment.id,
              successes[1].assignment.id,
            );
          }
          if (refresh) {
            assert(successes.every((v) => v.assignment.revision === 2));
            assert(successes.every((v) => v.requestId === original.request.id));
          }
          const after = await snapshot(f.projectId);
          const delta = Object.fromEntries(
            tables.map((table) => [
              table,
              after[table].length - before[table].length,
            ]),
          );
          const checks = name === "same-business" ? 2 : refresh ? 0 : 1;
          assert.equal(delta.ScalarReconciliationRequest, refresh ? 0 : 1);
          assert.equal(delta.ScalarReconciliationCheck, checks);
          assert.equal(delta.FactAssessment, checks);
          assert.equal(delta.FactAssessmentVersion, checks * 2);
          assert.equal(delta.FactAssessmentConflict, checks);
          assert.equal(delta.FactAuthorityConflict, refresh ? 0 : 1);
          assert.equal(delta.ScalarReconciliationAssignment, 1);
          for (const table of [
            "ProjectFact",
            "ProjectFactVersion",
            "FactEvidence",
          ])
            assert.equal(delta[table], 0);
          if (refresh) {
            const assignment = after.ScalarReconciliationAssignment.find(
              (row) => row.revision === 2,
            );
            assert.equal(assignment.id, successes[0].assignment.id);
            assert.equal(assignment.requestId, original.request.id);
            assert.equal(
              assignment.previousAssignmentId,
              original.request.assignment.id,
            );
            assert.equal(assignment.expectedRevision, 1);
          }
          assert.equal(
            delta.AuditEvent,
            name === "same-business"
              ? 4
              : changedFact
                ? 4
                : name === "same-command"
                  ? 3
                  : name === "refresh-cas"
                    ? 2
                    : 1,
          );
          for (const table of tables) {
            for (const old of before[table])
              assert(
                after[table].some(
                  (row) => JSON.stringify(row) === JSON.stringify(old),
                ),
                "Retained scalar row changed: " + table,
              );
            if (delta[table] === 0)
              assert.deepEqual(after[table], before[table]);
          }
          const newAudits = after.AuditEvent.filter(
            (row) => !before.AuditEvent.some((old) => old.id === row.id),
          );
          const expectedEvents = refresh
            ? [
                "scalar.reconciliation.assigned",
                ...(name === "refresh-cas"
                  ? ["scalar.reconciliation.assignment.denied"]
                  : []),
              ]
            : [
                "scalar.reconciliation.requested",
                "scalar.reconciliation.assigned",
                ...Array(checks).fill("scalar.reconciliation.checked"),
                ...(changedFact ? ["scalar.reconciliation.check.denied"] : []),
              ];
          assert.deepEqual(
            newAudits.map((row) => row.event).sort(),
            expectedEvents.sort(),
          );
          for (const row of after.ScalarReconciliationCheck) {
            const proof = after.FactAssessment.find(
              (p) => p.id === row.assessmentId,
            );
            assert.equal(proof.scalarReconciliationCheckId, row.id);
            assert.equal(proof.factId, row.factId);
          }
          for (const [index, outcome] of contenders.entries()) {
            const participant = participants[index + 1].record;
            const audits = newAudits.filter(
              (row) => row.correlationId === participant.correlationId,
            );
            if (outcome.status === "rejected") {
              assert.equal(audits.length, 1);
              assert.equal(audits[0].actor, participant.actor);
              assert.deepEqual(audits[0].detail, {
                projectId: f.projectId,
                reason: changedFact
                  ? "IDEMPOTENCY_CONFLICT"
                  : "REVISION_CONFLICT",
              });
              continue;
            }
            const value = outcome.value;
            assert.equal(
              audits.length,
              value.replayed
                ? 0
                : refresh
                  ? 1
                  : value.outcome === "CREATED"
                    ? 3
                    : 1,
            );
            assert(audits.every((row) => row.actor === participant.actor));
            if (refresh) {
              const row = after.ScalarReconciliationAssignment.find(
                (a) => a.id === value.assignment.id,
              );
              assert.equal(row.requestId, value.requestId);
              assert.equal(row.actor, participant.actor);
              assert.equal(
                row.idempotencyKey,
                participant.command.idempotencyKey,
              );
              if (!value.replayed)
                assert.deepEqual(audits[0].detail, {
                  projectId: f.projectId,
                  factId: f.factId,
                  requestId: row.requestId,
                  assignmentId: row.id,
                  revision: row.revision,
                  reason: row.reason,
                });
            } else {
              const row = after.ScalarReconciliationCheck.find(
                (c) => c.id === value.checkId,
              );
              assert(row);
              assert.equal(row.assessmentId, value.assessment.assessmentId);
              assert.equal(row.requestId, value.request.id);
              assert.equal(row.outcome, value.outcome);
              assert.equal(row.subject, participant.actor);
              assert.equal(
                row.idempotencyKey,
                participant.command.idempotencyKey,
              );
              const storedRequest = after.ScalarReconciliationRequest.find(
                (r) => r.id === row.requestId,
              );
              assert(storedRequest);
              assert.equal(storedRequest.factId, checkedFactId);
              assert.equal(
                after.ScalarReconciliationAssignment.find(
                  (a) => a.id === value.request.assignment.id,
                ).requestId,
                storedRequest.id,
              );
              if (row.outcome === "CREATED") {
                assert.equal(
                  storedRequest.originalAssessmentId,
                  row.assessmentId,
                );
                assert.equal(storedRequest.originCommandId, row.id);
              }
              if (!value.replayed) {
                const audit = audits.find((a) => a.id === row.auditEventId);
                assert.equal(audit.event, "scalar.reconciliation.checked");
                assert.deepEqual(audit.detail, {
                  projectId: f.projectId,
                  factId: checkedFactId,
                  checkId: row.id,
                  assessmentId: row.assessmentId,
                  requestId: row.requestId,
                  outcome: row.outcome,
                });
              }
            }
          }
          receipt.cases.push({
            name,
            projectId: f.projectId,
            factId: checkedFactId,
            ...(changedFact
              ? {
                  attemptedFactIds: [f.factId, otherFactId],
                  fullBefore: before,
                  fullAfter: after,
                }
              : {}),
            blocked,
            participants: participants.map((p) => p.record),
            delta,
            committed: {
              checks: after.ScalarReconciliationCheck,
              requests: after.ScalarReconciliationRequest,
              assignments: after.ScalarReconciliationAssignment,
              audits: newAudits,
              assessments: after.FactAssessment.map((a) => ({
                id: a.id,
                factId: a.factId,
                scalarReconciliationCheckId: a.scalarReconciliationCheckId,
              })),
            },
            before: Object.fromEntries(
              tables.map((table) => [
                table,
                { count: before[table].length, sha256: sha(before[table]) },
              ]),
            ),
            after: Object.fromEntries(
              tables.map((table) => [
                table,
                { count: after[table].length, sha256: sha(after[table]) },
              ]),
            ),
            outcomes: contenders.map((o) =>
              o.status === "fulfilled"
                ? {
                    status: o.status,
                    replayed: o.value.replayed,
                    outcome: o.value.outcome ?? null,
                    checkId: o.value.checkId ?? null,
                    assessmentId: o.value.assessment?.assessmentId ?? null,
                    requestId: refresh ? o.value.requestId : o.value.request.id,
                    assignmentId:
                      o.value.assignment?.id ?? o.value.request.assignment.id,
                  }
                : { status: o.status, code: o.reason.code },
            ),
          });
        } finally {
          holder.release.resolve("abort");
          await Promise.all(participants.map((p) => p.settled));
        }
      }
      assertScalarCommandRaces(receipt, customerId);
      return receipt;
    },
    async () => {
      releases.forEach((r) => r.resolve("abort"));
      await drainAndClose(pending, closers);
    },
  );
}
