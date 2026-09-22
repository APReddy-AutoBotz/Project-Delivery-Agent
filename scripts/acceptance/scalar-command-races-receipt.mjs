// FR-EVD-012/NFR-REL-001: independent finite scalar race evidence reader.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertRaceSnapshot } from "./reconciliation-races.mjs";
import { assertScalarAccessRaces } from "./scalar-access-races-receipt.mjs";
import { assertScalarCommitReceipt } from "./scalar-commit-receipt.mjs";
import { assertScalarBoundaryReceipt } from "./scalar-boundary-receipt.mjs";
import { assertScalarSealReceipt } from "./scalar-seal-receipt.mjs";
import { assertScalarIdentityVectors } from "./scalar-identity-vectors-receipt.mjs";
import { assertScalarTemporalVectors } from "./scalar-temporal-vectors-receipt.mjs";
import { assertScalarConflictPrefix } from "./scalar-conflict-prefix-receipt.mjs";
import { assertScalarLoadMeasurement } from "./scalar-load-diagnostics.mjs";
export function assertScalarConcurrencyAndLoad(persistence, customerId) {
  assertScalarCommandRaces(persistence.scalarCommandRaces, customerId);
  assertScalarAccessRaces(persistence.scalarAccessRaces, customerId);
  assertScalarCommitReceipt(persistence.scalarCommitGuards, customerId);
  assertScalarBoundaryReceipt(persistence.scalarBoundaries, customerId);
  assertScalarSealReceipt(persistence.scalarSeals, customerId);
  assertScalarIdentityVectors(persistence.scalarIdentityVectors, customerId);
  assertScalarTemporalVectors(persistence.scalarTemporalVectors, customerId);
  assertScalarConflictPrefix(persistence.scalarConflictPrefix, customerId);
  assertScalarVersionBoundary(persistence.scalarVersionBoundary, customerId);
}
export function assertScalarCommandRaces(receipt, customerId) {
  assert.equal(receipt.family, "scalar-command-races/v1");
  assert.equal(receipt.customerId, customerId);
  assert.equal(receipt.observer.role, "pdaa_api");
  assert.deepEqual(receipt.cases.map((c) => c.name).sort(), [
    "changed-fact-key",
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
    const changedFact = c.name === "changed-fact-key";
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
      else if (!changedFact) assert.equal(p.command.factId, c.factId);
    }
    if (c.name === "same-command" || c.name === "refresh-retry")
      assert.deepEqual(commands[0], commands[1]);
    else if (changedFact) {
      assert.equal(commands[0].idempotencyKey, commands[1].idempotencyKey);
      assert.notEqual(commands[0].factId, commands[1].factId);
      assert.deepEqual(
        c.attemptedFactIds,
        commands.map((command) => command.factId),
      );
    } else
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
        c.name === "same-business" || changedFact
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
          changedFact
            ? "scalar.reconciliation.check.denied"
            : "scalar.reconciliation.assignment.denied",
        );
        assert.deepEqual(audits[0].detail, {
          projectId: c.projectId,
          reason: changedFact ? "IDEMPOTENCY_CONFLICT" : "REVISION_CONFLICT",
        });
      } else {
        if (changedFact) {
          assert.equal(participant.command.factId, c.factId);
          assert.equal(outcome.outcome, "CREATED");
          assert.equal(outcome.replayed, false);
        }
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
    assert.equal(good.length, c.name === "refresh-cas" || changedFact ? 1 : 2);
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
    if (changedFact) assertChangedFactHistory(c, customerId, tables);
    if (c.name === "refresh-cas" || changedFact)
      assert.deepEqual(
        c.outcomes.find((o) => o.status !== "fulfilled"),
        {
          status: "rejected",
          code: changedFact ? "IDEMPOTENCY_CONFLICT" : "REVISION_CONFLICT",
        },
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

function assertChangedFactHistory(c, customerId, tables) {
  const hash = (rows) =>
    createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const graphs = tables.filter(
    (table) =>
      ![
        "AuditEvent",
        "ProjectFact",
        "ProjectFactVersion",
        "FactEvidence",
      ].includes(table),
  );
  for (const [full, summary] of [
    [c.fullBefore, c.before],
    [c.fullAfter, c.after],
  ]) {
    assert.deepEqual(Object.keys(full).sort(), tables);
    for (const table of tables) {
      assert(Array.isArray(full[table]) && full[table].length <= 5000);
      assert.equal(summary[table].count, full[table].length);
      assert.equal(summary[table].sha256, hash(full[table]));
      for (const row of full[table]) {
        assert.equal(row.customerId, customerId);
        assert.equal(
          table === "AuditEvent" ? row.detail.projectId : row.projectId,
          c.projectId,
        );
      }
      for (const old of c.fullBefore[table])
        assert(
          full[table].some(
            (row) => JSON.stringify(row) === JSON.stringify(old),
          ),
        );
    }
  }
  for (const factId of c.attemptedFactIds) {
    assert.equal(
      c.fullBefore.ProjectFact.filter((row) => row.id === factId).length,
      1,
    );
    assert.equal(
      c.fullBefore.ProjectFactVersion.filter((row) => row.factId === factId)
        .length,
      2,
    );
  }
  // Both candidates were real facts, but only the winner may own any new graph.
  for (const table of graphs) {
    assert.equal(c.fullBefore[table].length, 0);
    assert(c.fullAfter[table].every((row) => row.factId === c.factId));
  }
  const check = c.fullAfter.ScalarReconciliationCheck[0];
  const proof = c.fullAfter.FactAssessment[0];
  const request = c.fullAfter.ScalarReconciliationRequest[0];
  const assignment = c.fullAfter.ScalarReconciliationAssignment[0];
  const instant = (value) => {
    const ms = Date.parse(
      /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z",
    );
    assert(Number.isFinite(ms));
    return ms;
  };
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ projectId: c.projectId, factId: c.factId }))
    .digest("hex");
  assert.equal(check.requestHash, requestHash);
  assert.equal(proof.requestHash, requestHash);
  assert.equal(proof.idempotencyKey, "sr_" + check.id.replaceAll("-", ""));
  assert.equal(proof.subject, check.subject);
  assert.equal(proof.captureKind, "SCALAR_REQUEST");
  assert.equal(proof.milestoneAssessmentId, null);
  for (const value of [
    check.occurredAt,
    request.createdAt,
    assignment.occurredAt,
  ])
    assert.equal(instant(value), instant(proof.asOf));
  for (const audit of c.committed.audits.filter(
    (row) => row.event !== "scalar.reconciliation.check.denied",
  ))
    assert.equal(instant(audit.occurredAt), instant(proof.asOf));
  assert.equal(proof.sealed, true);
  assert.equal(request.sealed, true);
  assert.equal(request.originCommandId, check.id);
  assert.equal(request.originalAssessmentId, proof.id);
  assert.equal(assignment.kind, "INITIAL");
  assert.equal(assignment.revision, 1);
  assert.equal(assignment.expectedRevision, 0);
  assert.equal(assignment.previousAssignmentId, null);
  const versions = c.fullBefore.ProjectFactVersion.filter(
    (row) => row.factId === c.factId,
  );
  assert.equal(proof.complete, true);
  assert.equal(proof.versionCount, versions.length);
  assert.equal(proof.result.complete, true);
  assert.equal(proof.result.status, "CONFLICTING");
  assert.equal(proof.result.reconciliationRequired, true);
  assert.equal(proof.result.revalidationRequired, false);
  assert.equal(proof.result.scope.factId, c.factId);
  assert.equal(proof.result.scope.projectId, c.projectId);
  assert.equal(proof.result.scope.customerId, customerId);
  assert.equal(instant(proof.result.asOf), instant(proof.asOf));
  assert.deepEqual(
    proof.result.versions.map((row) => row.id).sort(),
    versions.map((row) => row.id).sort(),
  );
  for (const version of versions) {
    const frozen = proof.result.versions.find((row) => row.id === version.id);
    assert.deepEqual(frozen.value, version.value);
    assert.deepEqual(frozen.evidenceIds, [version.evidenceId]);
    assert.equal(frozen.source.instanceId, version.sourceId);
    assert.equal(frozen.visibility, "available");
    assert.equal(frozen.revalidationRequired, false);
    assert.equal(
      c.fullBefore.FactEvidence.filter(
        (row) =>
          row.id === version.evidenceId &&
          row.factId === c.factId &&
          row.sourceId === version.sourceId,
      ).length,
      1,
    );
  }
  assert.deepEqual(
    c.fullAfter.FactAssessmentVersion.map((row) => row.versionId).sort(),
    versions.map((row) => row.id).sort(),
  );
  for (const table of ["FactAssessmentVersion", "FactAssessmentConflict"])
    assert(c.fullAfter[table].every((row) => row.assessmentId === proof.id));
  assert.deepEqual(
    c.fullAfter.FactAssessmentConflict.map((row) => row.conflictId).sort(),
    c.fullAfter.FactAuthorityConflict.map((row) => row.id).sort(),
  );
  for (const [key, table] of [
    ["checks", "ScalarReconciliationCheck"],
    ["requests", "ScalarReconciliationRequest"],
    ["assignments", "ScalarReconciliationAssignment"],
  ])
    assert.deepEqual(c.committed[key], c.fullAfter[table]);
  assert.deepEqual(
    c.committed.assessments,
    c.fullAfter.FactAssessment.map((a) => ({
      id: a.id,
      factId: a.factId,
      scalarReconciliationCheckId: a.scalarReconciliationCheckId,
    })),
  );
  assert.deepEqual(
    c.committed.audits,
    c.fullAfter.AuditEvent.filter(
      (a) => !c.fullBefore.AuditEvent.some((old) => old.id === a.id),
    ),
  );
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
  assertScalarLoadMeasurement(receipt.measurement);
  assert.equal(receipt.measurement.durationMs, receipt.durationMs);
  assert.equal(receipt.measurement.commandState, "returned");
  assert.equal(receipt.measurement.deadlineExceeded, false);
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
