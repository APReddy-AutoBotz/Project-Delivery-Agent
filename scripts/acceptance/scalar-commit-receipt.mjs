// FR-EVD-009/012, NFR-REL-001: native COMMIT, not a callback/timeout substitute.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const modes = [
  "positive-created",
  "positive-reused",
  "positive-no-request",
  "positive-refresh",
  "orphan-owned-assessment",
  "wrong-no-request-semantics",
  "unsealed-request",
  "missing-initial-assignment",
  "wrong-check-hash",
  "wrong-check-subject",
  "wrong-check-time",
  "wrong-check-audit-event",
  "wrong-check-audit-actor",
  "wrong-check-audit-time",
  "wrong-check-audit-detail",
  "wrong-check-audit-scope",
  "wrong-refresh-hash",
  "wrong-refresh-audit",
  "wrong-refresh-time",
];
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const asTime = (value) =>
  Date.parse(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
const retained = (before, after) => {
  for (const old of before)
    assert(
      after.some((r) => JSON.stringify(r) === JSON.stringify(old)),
      "Retained COMMIT row changed",
    );
};
export function assertScalarNativeCommit(c) {
  assert(modes.includes(c.name));
  assert.equal(c.role, "pdaa_api");
  assert.equal(c.sessionUser, "pdaa_api");
  assert(Number.isInteger(c.pid) && c.pid > 0);
  assert.equal(c.nativePid, c.pid);
  assert.equal(c.callbackReturned, true);
  assert.equal(c.callbackReturnedAtCommit, true);
  assert.equal(c.nativeCommitAttempts, 1);
  assert.notEqual(c.unsupportedTransport, true);
  const o = c.commitObserver;
  assert(Number.isInteger(o.observerPid) && o.observerPid > 0);
  assert.notEqual(o.observerPid, c.pid);
  assert.equal(o.writerPid, c.pid);
  assert.equal(o.sessionUser, "pdaa_api");
  assert.equal(o.phase, "native-commit-settled");
  assert.equal(o.state, "idle");
  assert.match(o.query, /^\s*COMMIT\s*;?\s*$/i);
  const positive = c.name.startsWith("positive-");
  assert.equal(c.rejected, !positive);
  if (positive) {
    assert.equal(c.nativeCommand, "COMMIT");
    assert.equal(c.native, undefined);
  } else {
    assert.equal(c.nativeCommand, undefined);
    const messages = c.name.startsWith("wrong-refresh-")
      ? ["Incomplete scalar reconciliation assignment cannot commit"]
      : c.name === "orphan-owned-assessment"
        ? ["Unowned scalar reconciliation assessment cannot commit"]
        : [
            "Unowned scalar reconciliation assessment cannot commit",
            "Incomplete scalar reconciliation check cannot commit",
            ...(["unsealed-request", "missing-initial-assignment"].includes(
              c.name,
            )
              ? ["Incomplete scalar reconciliation request cannot commit"]
              : []),
            ...(c.name === "unsealed-request"
              ? ["Incomplete scalar reconciliation assignment cannot commit"]
              : []),
          ];
    if (c.name === "orphan-owned-assessment" && c.native?.code === "23503")
      assert.deepEqual(c.native, {
        code: "23503",
        constraint: "ScalarAssessment_check_fk",
        message:
          'insert or update on table "FactAssessment" violates foreign key constraint "ScalarAssessment_check_fk"',
      });
    else {
      assert.equal(c.native.code, "P0001");
      assert(messages.includes(c.native.message));
      assert.equal(c.native.constraint, undefined);
    }
  }
}

export function assertScalarCommitReceipt(receipt, customerId) {
  assert.equal(receipt.family, "scalar-native-commit/v1");
  assert.equal(receipt.customerId, customerId);
  assert.deepEqual(receipt.cases.map((c) => c.name).sort(), [...modes].sort());
  for (const c of receipt.cases) {
    assertScalarNativeCommit(c);
    assert.equal(c.customerId, customerId);
    assert.match(c.projectId, uuid);
    assert.match(c.factId, uuid);
    const positive = c.name.startsWith("positive-"),
      refresh = c.name.includes("refresh"),
      orphan = c.name === "orphan-owned-assessment";
    for (const state of [c.before, c.pending, c.after]) {
      assert.deepEqual(Object.keys(state).sort(), [...tables].sort());
      for (const table of tables) {
        assert(Array.isArray(state[table]) && state[table].length <= 5000);
        for (const row of state[table]) {
          assert.equal(row.customerId, customerId);
          assert.equal(
            table === "AuditEvent" ? row.detail.projectId : row.projectId,
            c.projectId,
          );
        }
      }
    }
    assert(Array.isArray(c.generatedIds) && c.generatedIds.length > 0);
    assert.equal(new Set(c.generatedIds).size, c.generatedIds.length);
    for (const id of c.generatedIds) assert.match(id, uuid);
    if (!positive) {
      assert.deepEqual(c.after, c.before);
      assert.deepEqual(c.auditAfter, []);
      assert.deepEqual(
        c.generatedAbsence,
        Object.fromEntries(tables.map((t) => [t, 0])),
      );
    } else {
      assert.deepEqual(c.after, c.pending);
      assert.deepEqual(c.auditAfter, c.attemptAudits);
      assert.deepEqual(c.generatedAbsence, {});
      assert(Object.values(c.predicates).every((p) => p === true));
    }
    const created = [
      "positive-created",
      "unsealed-request",
      "missing-initial-assignment",
    ].includes(c.name);
    const expectedDelta = {
      ScalarReconciliationRequest: created ? 1 : 0,
      ScalarReconciliationCheck: refresh || orphan ? 0 : 1,
      ScalarReconciliationAssignment:
        refresh || (created && c.name !== "missing-initial-assignment") ? 1 : 0,
      FactAssessment: refresh ? 0 : 1,
      FactAssessmentVersion: refresh ? 0 : 2,
      FactAssessmentConflict: refresh ? 0 : 1,
      FactAuthorityConflict:
        refresh || c.before.FactAuthorityConflict.length ? 0 : 1,
      AuditEvent: refresh
        ? 1
        : orphan || c.name === "wrong-check-audit-scope"
          ? 0
          : created
            ? c.name === "missing-initial-assignment"
              ? 2
              : 3
            : 1,
    };
    for (const table of tables) {
      assert.equal(
        c.pending[table].length - c.before[table].length,
        expectedDelta[table] ?? 0,
        table + " pending delta",
      );
      retained(c.before[table], c.pending[table]);
      const added = c.pending[table].filter(
        (row) =>
          !c.before[table].some(
            (old) => JSON.stringify(row) === JSON.stringify(old),
          ),
      );
      for (const row of added)
        for (const field of ["id", "assessmentId"])
          if (row[field]) assert(c.generatedIds.includes(row[field]));
      if (["ProjectFact", "ProjectFactVersion", "FactEvidence"].includes(table))
        assert.deepEqual(c.pending[table], c.before[table]);
    }
    for (const a of c.attemptAudits) {
      assert.equal(a.customerId, customerId);
      assert.equal(a.correlationId, c.correlationId);
      assert(c.generatedIds.includes(a.id));
    }
    const newRows = (table) =>
      c.pending[table].filter(
        (r) => !c.before[table].some((old) => old.id === r.id),
      );
    assert.deepEqual(
      newRows("AuditEvent").sort((a, b) => a.id.localeCompare(b.id)),
      c.attemptAudits
        .filter((a) => a.detail.projectId === c.projectId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    if (refresh) {
      assert.deepEqual(
        c.pending.ScalarReconciliationCheck,
        c.before.ScalarReconciliationCheck,
      );
      for (const t of [
        "ScalarReconciliationRequest",
        "FactAssessment",
        "FactAssessmentVersion",
        "FactAssessmentConflict",
        "FactAuthorityConflict",
      ])
        assert.deepEqual(c.pending[t], c.before[t]);
      const assignments = newRows("ScalarReconciliationAssignment");
      assert.equal(assignments.length, 1);
      const a = assignments[0];
      assert.equal(a.id, c.assignmentId);
      assert.equal(a.requestId, c.requestId);
      assert.equal(a.factId, c.factId);
      const previous = c.before.ScalarReconciliationAssignment.filter(
        (r) => r.requestId === c.requestId,
      ).sort((a, b) => b.revision - a.revision)[0];
      assert.equal(a.previousAssignmentId, previous.id);
      assert.equal(a.expectedRevision, previous.revision);
      assert.equal(a.revision, previous.revision + 1);
      assert.equal(a.kind, "REFRESH");
      const expectedHash = hash({
        projectId: c.projectId,
        requestId: c.requestId,
        expectedAssignmentRevision: previous.revision,
      });
      if (c.name === "wrong-refresh-hash")
        assert.notEqual(a.requestHash, expectedHash);
      else assert.equal(a.requestHash, expectedHash);
      assert.match(a.requestHash, /^[a-f0-9]{64}$/);
      if (c.name === "wrong-refresh-time")
        assert.equal(asTime(a.occurredAt), asTime(previous.occurredAt) - 1);
      else assert(asTime(a.occurredAt) >= asTime(previous.occurredAt));
      assert.equal(c.attemptAudits.length, 1);
      const audit = c.attemptAudits[0];
      assert.equal(audit.id, a.auditEventId);
      assert.equal(audit.actor, a.actor);
      assert.equal(a.actor, c.actor);
      assert.equal(asTime(audit.occurredAt), asTime(a.occurredAt));
      assert.equal(
        audit.event,
        c.name === "wrong-refresh-audit"
          ? "scalar.reconciliation.assigned.invalid"
          : "scalar.reconciliation.assigned",
      );
      assert.deepEqual(audit.detail, {
        projectId: c.projectId,
        factId: c.factId,
        requestId: c.requestId,
        assignmentId: a.id,
        revision: a.revision,
        reason: a.reason,
      });
      assert.equal(c.predicates.assignment, positive);
      assert.equal(c.predicates.request, true);
      continue;
    }
    const proofs = newRows("FactAssessment");
    assert.equal(proofs.length, 1);
    const proof = proofs[0];
    assert.equal(proof.id, c.assessmentId);
    assert.equal(proof.factId, c.factId);
    assert.equal(proof.scalarReconciliationCheckId, c.checkId);
    assert(c.generatedIds.includes(c.checkId));
    assert.equal(proof.captureKind, "SCALAR_REQUEST");
    assert.equal(proof.milestoneAssessmentId, null);
    assert.equal(proof.sealed, true);
    assert.equal(proof.subject, c.actor);
    assert.equal(proof.complete, true);
    assert.equal(proof.idempotencyKey, "sr_" + c.checkId.replaceAll("-", ""));
    assert.equal(c.identitySql, c.identity);
    const dependencies = c.pending.FactAssessmentVersion.filter(
      (r) => r.assessmentId === proof.id,
    );
    assert.equal(dependencies.length, 2);
    assert.equal(proof.versionCount, 2);
    for (const d of dependencies)
      assert(
        c.pending.ProjectFactVersion.some(
          (v) => v.id === d.versionId && v.factId === c.factId,
        ),
      );
    const conflicts = c.pending.FactAssessmentConflict.filter(
      (r) => r.assessmentId === proof.id,
    );
    assert.equal(conflicts.length, 1);
    assert.equal(proof.conflictCount, 1);
    for (const d of conflicts)
      assert(
        c.pending.FactAuthorityConflict.some(
          (v) => v.id === d.conflictId && v.factId === c.factId,
        ),
      );
    const checks = newRows("ScalarReconciliationCheck");
    assert.equal(checks.length, orphan ? 0 : 1);
    if (orphan) {
      assert.equal(c.predicates.check, false);
      assert.equal(c.attemptAudits.length, 0);
      assert.equal(typeof c.identity, "string");
      continue;
    }
    const check = checks[0];
    assert.equal(
      check.outcome,
      created
        ? "CREATED"
        : c.name === "positive-reused"
          ? "REUSED"
          : "NO_REQUEST",
    );
    assert.equal(check.id, c.checkId);
    assert.equal(check.assessmentId, c.assessmentId);
    assert.equal(check.factId, c.factId);
    assert.equal(check.requestId, c.requestId);
    const expectedHash = hash({ projectId: c.projectId, factId: c.factId });
    assert.equal(check.requestHash, proof.requestHash);
    assert.match(check.requestHash, /^[a-f0-9]{64}$/);
    if (c.name === "wrong-check-hash")
      assert.notEqual(check.requestHash, expectedHash);
    else assert.equal(check.requestHash, expectedHash);
    if (c.name === "wrong-check-subject")
      assert.notEqual(check.subject, proof.subject);
    else assert.equal(check.subject, proof.subject);
    assert.equal(
      asTime(check.occurredAt),
      asTime(proof.asOf) + (c.name === "wrong-check-time" ? 1 : 0),
    );
    assert.equal(c.predicates.check, positive);
    const audit = c.attemptAudits.find((a) => a.id === check.auditEventId);
    assert(audit);
    if (c.name === "wrong-check-audit-actor")
      assert.notEqual(audit.actor, check.subject);
    else assert.equal(audit.actor, check.subject);
    assert.equal(
      asTime(audit.occurredAt),
      asTime(check.occurredAt) + (c.name === "wrong-check-audit-time" ? 1 : 0),
    );
    assert.equal(
      audit.event,
      c.name === "wrong-check-audit-event"
        ? "scalar.reconciliation.checked.invalid"
        : "scalar.reconciliation.checked",
    );
    const detail = {
      projectId: c.projectId,
      factId: c.factId,
      checkId: check.id,
      assessmentId: proof.id,
      requestId: check.requestId,
      outcome: check.outcome,
    };
    if (c.name === "wrong-check-audit-detail") {
      assert.notEqual(audit.detail.factId, c.factId);
      detail.factId = audit.detail.factId;
    }
    if (c.name === "wrong-check-audit-scope") {
      assert.notEqual(audit.detail.projectId, c.projectId);
      detail.projectId = audit.detail.projectId;
    }
    assert.deepEqual(audit.detail, detail);
    if (check.outcome === "NO_REQUEST") {
      assert.equal(check.requestId, null);
      assert.equal(c.attemptAudits.length, 1);
      assert.deepEqual(
        c.pending.ScalarReconciliationRequest,
        c.before.ScalarReconciliationRequest,
      );
      assert.deepEqual(
        c.pending.ScalarReconciliationAssignment,
        c.before.ScalarReconciliationAssignment,
      );
      if (c.name === "wrong-no-request-semantics")
        assert.equal(typeof c.identity, "string");
      else assert.equal(c.identity, null);
    } else {
      assert.equal(typeof c.identity, "string");
      const request = c.pending.ScalarReconciliationRequest.find(
        (r) => r.id === c.requestId,
      );
      assert(request);
      assert.equal(request.contributorIdentity, c.identity);
      assert.equal(
        request.contributorHash,
        createHash("sha256").update(c.identity).digest("hex"),
      );
      assert.equal(request.factId, c.factId);
      assert.equal(request.state, "OPEN");
      if (c.name === "positive-reused") {
        assert.equal(check.outcome, "REUSED");
        assert.notEqual(request.originalAssessmentId, proof.id);
        assert.deepEqual(
          c.pending.ScalarReconciliationRequest,
          c.before.ScalarReconciliationRequest,
        );
        assert.deepEqual(
          c.pending.ScalarReconciliationAssignment,
          c.before.ScalarReconciliationAssignment,
        );
        assert.equal(c.attemptAudits.length, 1);
      } else {
        assert.equal(check.outcome, "CREATED");
        assert.equal(request.originalAssessmentId, proof.id);
        assert.equal(request.createdBy, c.actor);
        assert.equal(asTime(request.createdAt), asTime(proof.asOf));
        const requested = c.attemptAudits.find(
          (a) => a.id === request.auditEventId,
        );
        assert(requested);
        assert.equal(requested.actor, c.actor);
        assert.equal(asTime(requested.occurredAt), asTime(request.createdAt));
        assert.equal(requested.event, "scalar.reconciliation.requested");
        assert.deepEqual(requested.detail, {
          projectId: c.projectId,
          factId: c.factId,
          requestId: request.id,
          assessmentId: proof.id,
          checkId: check.id,
        });
        if (c.name !== "missing-initial-assignment") {
          const initial = newRows("ScalarReconciliationAssignment")[0];
          assert.equal(initial.id, c.assignmentId);
          assert.equal(initial.factId, c.factId);
          assert.equal(initial.requestId, request.id);
          assert.equal(initial.revision, 1);
          assert.equal(initial.expectedRevision, 0);
          assert.equal(initial.previousAssignmentId, null);
          assert.equal(initial.kind, "INITIAL");
          assert.equal(initial.idempotencyKey, null);
          assert.equal(initial.requestHash, null);
          assert.equal(initial.actor, c.actor);
          assert.equal(asTime(initial.occurredAt), asTime(request.createdAt));
          const assigned = c.attemptAudits.find(
            (a) => a.id === initial.auditEventId,
          );
          assert(assigned);
          assert.equal(assigned.actor, c.actor);
          assert.equal(asTime(assigned.occurredAt), asTime(initial.occurredAt));
          assert.equal(assigned.event, "scalar.reconciliation.assigned");
          assert.deepEqual(assigned.detail, {
            projectId: c.projectId,
            factId: c.factId,
            requestId: request.id,
            assignmentId: initial.id,
            revision: 1,
            reason: initial.reason,
          });
        }
        assert.equal(request.originCommandId, check.id);
        assert.equal(request.sealed, positive);
        assert.equal(newRows("ScalarReconciliationRequest").length, 1);
        assert.equal(
          newRows("ScalarReconciliationAssignment").length,
          c.name === "missing-initial-assignment" ? 0 : 1,
        );
        assert.equal(
          c.attemptAudits.length,
          c.name === "missing-initial-assignment" ? 2 : 3,
        );
        if (c.name === "missing-initial-assignment")
          assert.equal(c.predicates.request, false);
      }
    }
  }
}
