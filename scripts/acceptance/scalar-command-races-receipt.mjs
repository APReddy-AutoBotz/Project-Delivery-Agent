// FR-EVD-012/NFR-REL-001: independent finite scalar race evidence reader.
import assert from "node:assert/strict";
import { assertRaceSnapshot } from "./reconciliation-races.mjs";
import { assertScalarAccessRaces } from "./scalar-access-races-receipt.mjs";
import { assertScalarCommitReceipt } from "./scalar-commit-receipt.mjs";
import { assertScalarBoundaryReceipt } from "./scalar-boundary-receipt.mjs";
export function assertScalarConcurrencyAndLoad(persistence, customerId) {
  assertScalarCommandRaces(persistence.scalarCommandRaces, customerId);
  assertScalarAccessRaces(persistence.scalarAccessRaces, customerId);
  assertScalarCommitReceipt(persistence.scalarCommitGuards, customerId);
  assertScalarBoundaryReceipt(persistence.scalarBoundaries, customerId);
  assertScalarVersionBoundary(persistence.scalarVersionBoundary, customerId);
}
export function assertScalarCommandRaces(receipt, customerId) {
  assert.equal(receipt.family, "scalar-command-races/v1");
  assert.equal(receipt.customerId, customerId);
  assert.equal(receipt.observer.role, "pdaa_api");
  assert.deepEqual(receipt.cases.map((c) => c.name).sort(), [
    "refresh-cas",
    "refresh-retry",
    "same-business",
    "same-command",
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
  ].sort();
  for (const c of receipt.cases) {
    assert.equal(c.participants.length, 3);
    assertRaceSnapshot(
      c.blocked,
      c.participants[0],
      c.participants.slice(1),
      receipt.observer.pid,
    );
    const refresh = c.name.startsWith("refresh"),
      checks = c.name === "same-business" ? 2 : refresh ? 0 : 1;
    assert.equal(c.participants[0].operation, "list");
    const commands = c.participants.slice(1).map((p) => p.command);
    if (refresh) assert.equal(commands[0].requestId, commands[1].requestId);
    for (const p of c.participants.slice(1)) {
      assert.equal(p.operation, refresh ? "refreshAssignment" : "check");
      assert.equal(p.command.projectId, c.projectId);
      assert.equal(typeof p.command.idempotencyKey, "string");
      if (refresh) assert.equal(p.command.expectedAssignmentRevision, 1);
      else assert.equal(p.command.factId, c.factId);
    }
    if (c.name === "same-command" || c.name === "refresh-retry")
      assert.deepEqual(commands[0], commands[1]);
    else
      assert.notEqual(commands[0].idempotencyKey, commands[1].idempotencyKey);
    if (c.name !== "same-business")
      assert.equal(c.participants[1].actor, c.participants[2].actor);
    const expected = {
      ScalarReconciliationRequest: refresh ? 0 : 1,
      ScalarReconciliationCheck: checks,
      ScalarReconciliationAssignment: 1,
      FactAssessment: checks,
      FactAssessmentVersion: checks * 2,
      FactAssessmentConflict: checks,
      FactAuthorityConflict: refresh ? 0 : 1,
      AuditEvent:
        c.name === "same-business"
          ? 4
          : c.name === "same-command"
            ? 3
            : c.name === "refresh-cas"
              ? 2
              : 1,
      ProjectFact: 0,
      ProjectFactVersion: 0,
      FactEvidence: 0,
    };
    assert.deepEqual(c.delta, expected);
    for (const state of [c.before, c.after]) {
      assert.deepEqual(Object.keys(state).sort(), tables);
      for (const row of Object.values(state)) {
        assert(Number.isSafeInteger(row.count) && row.count >= 0);
        assert.match(row.sha256, /^[a-f0-9]{64}$/);
      }
    }
    for (const table of tables) {
      assert.equal(
        c.after[table].count - c.before[table].count,
        expected[table],
      );
      if (expected[table] === 0)
        assert.equal(c.after[table].sha256, c.before[table].sha256);
    }
    assert.equal(c.outcomes.length, 2);
    assert.equal(c.committed.audits.length, expected.AuditEvent);
    for (const [index, outcome] of c.outcomes.entries()) {
      const participant = c.participants[index + 1];
      const audits = c.committed.audits.filter(
        (a) => a.correlationId === participant.correlationId,
      );
      assert.equal(
        audits.length,
        outcome.status === "rejected"
          ? 1
          : outcome.replayed
            ? 0
            : refresh
              ? 1
              : outcome.outcome === "CREATED"
                ? 3
                : 1,
      );
      assert(audits.every((a) => a.actor === participant.actor));
      if (outcome.status === "rejected") {
        assert.equal(
          audits[0].event,
          "scalar.reconciliation.assignment.denied",
        );
        assert.deepEqual(audits[0].detail, {
          projectId: c.projectId,
          reason: "REVISION_CONFLICT",
        });
      } else {
        const assignment = c.committed.assignments.find(
          (a) => a.id === outcome.assignmentId,
        );
        const requireAudit = (id, event, detail) => {
          const audit = audits.find((a) => a.id === id);
          assert(audit);
          assert.equal(audit.event, event);
          assert.deepEqual(audit.detail, detail);
        };
        const assignedDetail = {
          projectId: c.projectId,
          factId: c.factId,
          requestId: outcome.requestId,
          assignmentId: assignment.id,
          revision: assignment.revision,
          reason: assignment.reason,
        };
        if (refresh) {
          assert.equal(participant.command.requestId, outcome.requestId);
          assert.equal(assignment.actor, participant.actor);
          assert.equal(
            assignment.idempotencyKey,
            participant.command.idempotencyKey,
          );
          if (!outcome.replayed)
            requireAudit(
              assignment.auditEventId,
              "scalar.reconciliation.assigned",
              assignedDetail,
            );
        } else {
          const check = c.committed.checks.find(
            (row) => row.id === outcome.checkId,
          );
          assert.equal(check.subject, participant.actor);
          assert.equal(
            check.idempotencyKey,
            participant.command.idempotencyKey,
          );
          if (!outcome.replayed) {
            requireAudit(check.auditEventId, "scalar.reconciliation.checked", {
              projectId: c.projectId,
              factId: c.factId,
              checkId: check.id,
              assessmentId: check.assessmentId,
              requestId: check.requestId,
              outcome: check.outcome,
            });
            if (outcome.outcome === "CREATED") {
              const request = c.committed.requests.find(
                (r) => r.id === outcome.requestId,
              );
              requireAudit(
                request.auditEventId,
                "scalar.reconciliation.requested",
                {
                  projectId: c.projectId,
                  factId: c.factId,
                  requestId: request.id,
                  assessmentId: check.assessmentId,
                  checkId: check.id,
                },
              );
              requireAudit(
                assignment.auditEventId,
                "scalar.reconciliation.assigned",
                assignedDetail,
              );
            }
          }
        }
      }
    }
    const good = c.outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(good.length, c.name === "refresh-cas" ? 1 : 2);
    for (const o of good) {
      assert.match(o.requestId, /^[a-f0-9-]{36}$/);
      assert.match(o.assignmentId, /^[a-f0-9-]{36}$/);
      assert.equal(
        c.committed.requests.filter((r) => r.id === o.requestId).length,
        1,
      );
      const assignment = c.committed.assignments.find(
        (a) => a.id === o.assignmentId,
      );
      assert.equal(assignment.requestId, o.requestId);
      if (!refresh) {
        const check = c.committed.checks.find((row) => row.id === o.checkId);
        assert.equal(check.requestId, o.requestId);
        assert.equal(check.assessmentId, o.assessmentId);
        assert.equal(check.outcome, o.outcome);
        const proof = c.committed.assessments.find(
          (a) => a.id === o.assessmentId,
        );
        assert.equal(proof.scalarReconciliationCheckId, o.checkId);
        assert.equal(proof.factId, c.factId);
      } else {
        assert.equal(assignment.revision, 2);
        assert.equal(assignment.expectedRevision, 1);
        assert.equal(
          c.committed.assignments.find(
            (a) => a.id === assignment.previousAssignmentId,
          ).revision,
          1,
        );
      }
    }
    if (c.name === "refresh-cas")
      assert.deepEqual(
        c.outcomes.find((o) => o.status !== "fulfilled"),
        { status: "rejected", code: "REVISION_CONFLICT" },
      );
    else {
      assert.equal(good[0].requestId, good[1].requestId);
      assert.equal(good[0].assignmentId, good[1].assignmentId);
      if (c.name !== "same-business")
        assert.deepEqual(good.map((o) => o.replayed).sort(), [false, true]);
      if (c.name === "same-command") {
        assert.equal(good[0].checkId, good[1].checkId);
        assert.equal(good[0].assessmentId, good[1].assessmentId);
      }
      if (c.name === "same-business") {
        assert.notEqual(good[0].checkId, good[1].checkId);
        assert.notEqual(good[0].assessmentId, good[1].assessmentId);
        assert.notEqual(c.participants[1].actor, c.participants[2].actor);
      }
    }
  }
  return true;
}

export function assertScalarVersionBoundary(receipt, customerId) {
  assert.equal(receipt.family, "scalar-version-boundary/v1");
  assert.equal(receipt.customerId, customerId);
  assert.equal(receipt.runtimeRole, "pdaa_api");
  for (const key of [
    "projectId",
    "factId",
    "originalCheckId",
    "originalRequestId",
    "originalAssessmentId",
    "overflowCheckId",
    "overflowAssessmentId",
  ])
    assert.match(
      receipt[key],
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
  assert(
    Number.isFinite(receipt.durationMs) &&
      receipt.durationMs > 0 &&
      receipt.durationMs < 10000,
  );
  assert.equal(receipt.completeVersionCount, 1000);
  assert.equal(receipt.incompletePrefix, 1001);
  for (const flag of [
    "exactSqlIdentity",
    "ownedNegativeCheck",
    "originalOpenRequestPreserved",
    "originalReplayPreserved",
  ])
    assert.equal(receipt[flag], true);
  assert.notEqual(receipt.originalCheckId, receipt.overflowCheckId);
  assert.notEqual(receipt.originalAssessmentId, receipt.overflowAssessmentId);
  return true;
}
