// FR-EVD-009/012, NFR-SEC-001: finite guard phase and exact scoped rollback evidence.
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
const cases = [
  "borrowed-standalone",
  "cross-project-proof",
  "request-reseal",
  "late-version",
  "late-conflict",
  "request-born-sealed",
  "request-adopt-standalone",
  "check-cross-request",
  "assignment-late-initial",
  "assignment-stale-revision",
  "assignment-wrong-configuration",
  "assignment-wrong-grant",
  "assignment-wrong-routing",
  "assignment-wrong-predecessor",
  "assignment-year-range",
  "proof-wrong-kind",
  "request-wrong-digest",
  "api-update-request",
  "api-update-check",
  "api-update-assignment",
  "api-delete-request",
  "api-delete-check",
  "api-delete-assignment",
  "api-truncate-request",
  "api-truncate-check",
  "api-truncate-assignment",
  "api-trigger-request",
  "api-trigger-check",
  "api-trigger-assignment",
  "api-update-owner",
];
const guards = {
  "request-reseal": "Invalid scalar reconciliation request seal",
  "late-version": "Assessment dependencies are sealed",
  "late-conflict": "Assessment dependencies are sealed",
  "request-born-sealed": "Scalar reconciliation request must start unsealed",
  "request-adopt-standalone":
    "Scalar reconciliation requires its fresh positive proof",
  "check-cross-request": "Invalid scalar reconciliation check birth",
  "assignment-late-initial": "Invalid scalar reconciliation assignment parent",
  "assignment-stale-revision":
    "Invalid scalar reconciliation assignment revision",
  "assignment-wrong-configuration":
    "Invalid scalar reconciliation configuration snapshot",
  "assignment-wrong-grant": "Invalid scalar reconciliation grant snapshot",
  "assignment-wrong-routing": "Invalid scalar reconciliation routing",
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const asTime = (text) =>
  Date.parse(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : text + "Z");
export function assertScalarBoundaryError(c) {
  assert(cases.includes(c.name));
  assert.equal(c.role, "pdaa_api");
  assert.equal(c.sessionUser, "pdaa_api");
  assert(Number.isInteger(c.pid) && c.pid > 0);
  assert.equal(c.rollbackCommand, "ROLLBACK");
  const deferred = ["borrowed-standalone", "cross-project-proof"].includes(
    c.name,
  );
  assert.equal(c.phase, deferred ? "commit" : "statement");
  assert.equal(c.callbackReturned, deferred);
  assert.equal(c.nativeCommitAttempts, deferred ? 1 : 0);
  const error = c.error;
  if (deferred) {
    assert.equal(c.nativePid, c.pid);
    assert.equal(c.callbackReturnedAtCommit, true);
    assert.equal(c.nativeCommand, undefined);
    assert.deepEqual(c.native, error);
    assert.notEqual(c.unsupportedTransport, true);
    const observer = c.commitObserver;
    assert(Number.isInteger(observer.observerPid) && observer.observerPid > 0);
    assert.notEqual(observer.observerPid, c.pid);
    assert.equal(observer.writerPid, c.pid);
    assert.equal(observer.sessionUser, "pdaa_api");
    assert.equal(observer.phase, "native-commit-settled");
    assert.equal(observer.state, "idle");
    assert.match(observer.query, /^\s*COMMIT\s*;?\s*$/i);
    if (error.code === "23503")
      assert.deepEqual(error, {
        code: "23503",
        constraint: "ScalarCheck_assessment_fk",
        message:
          'insert or update on table "ScalarReconciliationCheck" violates foreign key constraint "ScalarCheck_assessment_fk"',
      });
    else {
      assert.equal(error.code, "P0001");
      assert.equal(
        error.message,
        "Incomplete scalar reconciliation check cannot commit",
      );
      assert.equal(error.constraint, undefined);
    }
  } else {
    assert.equal(c.native, undefined);
    assert.equal(c.nativeCommand, undefined);
    assert.equal(c.nativePid, undefined);
    assert.equal(c.callbackReturnedAtCommit, undefined);
    assert.equal(c.commitObserver, undefined);
    if (c.name.startsWith("api-")) {
      assert.equal(error.code, "42501");
      assert.equal(error.constraint, undefined);
      assert.equal(
        error.message,
        c.name.startsWith("api-trigger-")
          ? `must be owner of table ${c.attempt.table}`
          : `permission denied for table ${c.attempt.table}`,
      );
    } else if (guards[c.name]) {
      assert.equal(error.code, "P0001");
      assert.equal(error.message, guards[c.name]);
      assert.equal(error.constraint, undefined);
    } else {
      const constraint =
        c.name === "assignment-wrong-predecessor"
          ? "ScalarAssignment_previous_fk"
          : c.name === "assignment-year-range"
            ? "ScalarAssignment_shape"
            : c.name === "proof-wrong-kind"
              ? "FactAssessment_capture_shape"
              : "ScalarRequest_shape";
      const fk = c.name === "assignment-wrong-predecessor";
      assert.equal(error.code, fk ? "23503" : "23514");
      assert.equal(error.constraint, constraint);
      assert.equal(
        error.message,
        fk
          ? `insert or update on table "${c.attempt.table}" violates foreign key constraint "${constraint}"`
          : `new row for relation "${c.attempt.table}" violates check constraint "${constraint}"`,
      );
    }
  }
}

export function assertScalarBoundaryReceipt(receipt, customerId) {
  assert.equal(receipt.family, "scalar-boundaries/v1");
  assert.equal(receipt.customerId, customerId);
  assert.equal(receipt.projectIds.length, 3);
  assert.equal(new Set(receipt.projectIds).size, 3);
  assert.equal(receipt.standalone.length, 2);
  assert.equal(new Set(receipt.standalone).size, 2);
  assert.deepEqual(receipt.cases.map((c) => c.name).sort(), [...cases].sort());
  for (const c of receipt.cases) {
    assertScalarBoundaryError(c);
    assert.deepEqual(c.before, receipt.cases[0].before);
    assert.deepEqual(c.after, c.before);
    assert.deepEqual(c.auditAfter, []);
    assert.equal(new Set(c.generatedIds).size, c.generatedIds.length);
    const expectedIds = [
      ...new Set(
        [
          c.attempt?.row?.id,
          c.attempt?.row?.auditEventId,
          c.prepared?.id,
        ].filter(
          (id) =>
            id &&
            !tables.some((table) =>
              c.before[table].some((row) => row.id === id),
            ),
        ),
      ),
    ].sort();
    assert.deepEqual(c.generatedIds, expectedIds);
    for (const id of c.generatedIds)
      assert.match(
        id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    assert.deepEqual(
      c.generatedAbsence,
      Object.fromEntries(tables.map((table) => [table, 0])),
    );
    for (const state of [
      c.before,
      c.after,
      ...(c.pending ? [c.pending] : []),
    ]) {
      assert.deepEqual(Object.keys(state).sort(), [...tables].sort());
      for (const table of tables) {
        assert(Array.isArray(state[table]) && state[table].length <= 5000);
        for (const row of state[table]) {
          assert.equal(row.customerId, customerId);
          assert(
            receipt.projectIds.includes(
              table === "AuditEvent" ? row.detail.projectId : row.projectId,
            ),
          );
        }
      }
    }
    const request = c.before.ScalarReconciliationRequest.find(
      (r) => r.id === receipt.requestId,
    );
    const proof = c.before.FactAssessment.find((r) => r.id === receipt.proofId);
    assert(request && proof);
    assert.equal(request.originalAssessmentId, proof.id);
    assert.equal(request.sealed, true);
    assert.equal(proof.sealed, true);
    const assignments = c.before.ScalarReconciliationAssignment.filter(
      (a) => a.requestId === request.id,
    ).sort((a, b) => a.revision - b.revision);
    assert.deepEqual(
      assignments.map((a) => a.revision),
      [1, 2],
    );
    const [initial, head] = assignments;
    const { table, row } = c.attempt;
    assert(tables.includes(table));
    if (c.phase === "commit") {
      assert.equal(table, "ScalarReconciliationCheck");
      const borrowed = c.before.FactAssessment.find(
        (p) => p.id === c.attempt.borrowedProofId,
      );
      assert.equal(
        borrowed.id,
        receipt.standalone[c.name === "cross-project-proof" ? 1 : 0],
      );
      assert.equal(borrowed.captureKind, "SCALAR");
      assert.equal(borrowed.scalarReconciliationCheckId, null);
      assert.equal(borrowed.milestoneAssessmentId, null);
      assert.equal(borrowed.sealed, true);
      assert.equal(borrowed.result.reconciliationRequired, false);
      assert(
        !c.before.ScalarReconciliationCheck.some(
          (a) => a.assessmentId === borrowed.id,
        ),
      );
      assert.equal(row.assessmentId, borrowed.id);
      assert.equal(row.subject, borrowed.subject);
      assert.equal(row.requestHash, borrowed.requestHash);
      assert.equal(
        row.requestHash,
        hash({ projectId: row.projectId, factId: row.factId }),
      );
      assert.equal(row.occurredAt, borrowed.asOf);
      assert.equal(row.outcome, "NO_REQUEST");
      assert.equal(row.requestId, null);
      assert.equal(row.customerId, customerId);
      assert(
        c.before.ProjectFact.some(
          (f) => f.id === row.factId && f.projectId === row.projectId,
        ),
      );
      if (c.name === "cross-project-proof") {
        assert.notEqual(row.projectId, borrowed.projectId);
        assert.notEqual(row.factId, borrowed.factId);
      } else {
        assert.equal(row.projectId, borrowed.projectId);
        assert.equal(row.factId, borrowed.factId);
      }
      const audit = c.prepared;
      assert.equal(audit.id, row.auditEventId);
      assert.equal(audit.actor, row.subject);
      assert.equal(audit.occurredAt, row.occurredAt);
      assert.equal(audit.correlationId, c.correlationId);
      assert.equal(audit.event, "scalar.reconciliation.checked");
      assert.deepEqual(audit.detail, {
        projectId: row.projectId,
        factId: row.factId,
        checkId: row.id,
        assessmentId: row.assessmentId,
        requestId: null,
        outcome: "NO_REQUEST",
      });
      for (const t of tables) {
        const expected = [
          ...c.before[t],
          ...(t === table ? [row] : t === "AuditEvent" ? [audit] : []),
        ];
        // PostgreSQL serializes timestamps without redundant UTC suffix in AuditEvent.
        if (t === table || t === "AuditEvent") {
          const actual = c.pending[t].filter(
            (r) => !c.before[t].some((old) => old.id === r.id),
          );
          assert.equal(actual.length, 1);
          const candidate = { ...(t === table ? row : audit) };
          candidate.occurredAt = actual[0].occurredAt;
          assert.equal(
            asTime(actual[0].occurredAt),
            asTime((t === table ? row : audit).occurredAt),
          );
          assert.deepEqual(actual[0], candidate);
          for (const old of c.before[t])
            assert(
              c.pending[t].some(
                (a) => JSON.stringify(a) === JSON.stringify(old),
              ),
            );
          assert.equal(c.pending[t].length, expected.length);
        } else assert.deepEqual(c.pending[t], c.before[t]);
      }
      continue;
    }
    assert.equal(c.pending, undefined);
    if (c.name.startsWith("api-") || c.name === "request-reseal") {
      const [, operation, suffix] = c.name.split("-");
      const target = {
        request: "ScalarReconciliationRequest",
        check: "ScalarReconciliationCheck",
        assignment: "ScalarReconciliationAssignment",
        owner: "FactAssessment",
      }[suffix];
      if (c.name === "request-reseal") {
        assert.equal(table, "ScalarReconciliationRequest");
        assert.equal(
          c.attempt.sql,
          'UPDATE "ScalarReconciliationRequest" SET sealed=true WHERE id=$1',
        );
        assert.deepEqual(c.attempt.values, [request.id]);
      } else {
        assert.equal(table, target);
        const column =
          suffix === "owner" ? "scalarReconciliationCheckId" : "id";
        const sql =
          operation === "update"
            ? `UPDATE "${table}" SET "${column}"="${column}" WHERE id=$1`
            : operation === "delete"
              ? `DELETE FROM "${table}" WHERE id=$1`
              : operation === "truncate"
                ? `TRUNCATE "${table}"`
                : `ALTER TABLE "${table}" DISABLE TRIGGER USER`;
        assert.equal(c.attempt.sql, sql);
        if (["update", "delete"].includes(operation)) {
          assert.equal(c.attempt.values.length, 1);
          assert(
            c.before[table].some(
              (r) =>
                r.id === c.attempt.values[0] &&
                r.projectId === request.projectId,
            ),
          );
        } else assert.deepEqual(c.attempt.values, []);
      }
      assert.equal(c.prepared, null);
      continue;
    }
    assert.equal(row.customerId, customerId);
    if (c.name === "late-version" || c.name === "late-conflict") {
      assert.equal(
        table,
        c.name === "late-version"
          ? "FactAssessmentVersion"
          : "FactAssessmentConflict",
      );
      assert.equal(row.assessmentId, proof.id);
      assert(
        c.before[table].some((r) => JSON.stringify(r) === JSON.stringify(row)),
      );
    } else if (c.name.startsWith("assignment-")) {
      assert.equal(table, "ScalarReconciliationAssignment");
      assert.equal(row.requestId, request.id);
      assert.equal(row.projectId, request.projectId);
      assert.equal(row.factId, request.factId);
      const expected = {
        ...head,
        id: row.id,
        auditEventId: row.auditEventId,
        revision: 3,
        expectedRevision: 2,
        previousAssignmentId: head.id,
        idempotencyKey: row.idempotencyKey,
        requestHash: hash({
          projectId: request.projectId,
          requestId: request.id,
          expectedAssignmentRevision: 2,
        }),
        occurredAt: row.occurredAt,
      };
      assert.notEqual(row.id, head.id);
      assert.notEqual(row.auditEventId, head.auditEventId);
      if (c.name === "assignment-late-initial")
        Object.assign(expected, {
          kind: "INITIAL",
          revision: 1,
          expectedRevision: 0,
          previousAssignmentId: null,
          idempotencyKey: null,
          requestHash: null,
        });
      if (c.name === "assignment-stale-revision")
        Object.assign(expected, {
          revision: 2,
          expectedRevision: 1,
          previousAssignmentId: initial.id,
          requestHash: hash({
            projectId: request.projectId,
            requestId: request.id,
            expectedAssignmentRevision: 1,
          }),
        });
      if (c.name === "assignment-wrong-configuration") {
        assert.notEqual(head.configurationReceiptId, null);
        expected.configurationReceiptId = null;
      }
      if (c.name === "assignment-wrong-grant") {
        assert.notEqual(row.grantId, head.grantId);
        expected.grantId = row.grantId;
      }
      if (c.name === "assignment-wrong-routing") {
        expected.reason = "PM_SCOPE_UNAVAILABLE";
        for (const field of [
          "recipientSubject",
          "responsibilityId",
          "grantId",
          "grantCustomerId",
          "grantSubject",
          "grantScopeType",
          "grantScopeId",
          "grantRole",
        ])
          expected[field] = null;
      }
      if (c.name === "assignment-wrong-predecessor")
        expected.previousAssignmentId = initial.id;
      if (c.name === "assignment-year-range")
        assert.equal(row.occurredAt, "10000-01-01T00:00:00Z");
      else assert(asTime(row.occurredAt) >= asTime(head.occurredAt));
      assert.deepEqual(row, expected);
      const a = c.prepared;
      assert.equal(a.id, row.auditEventId);
      assert.equal(a.customerId, customerId);
      assert.equal(a.actor, row.actor);
      assert.equal(a.occurredAt, row.occurredAt);
      assert.equal(a.correlationId, c.correlationId);
      assert.equal(a.event, "scalar.reconciliation.assigned");
      assert.deepEqual(a.detail, {
        projectId: request.projectId,
        factId: request.factId,
        requestId: request.id,
        assignmentId: row.id,
        revision: row.revision,
        reason: row.reason,
      });
    } else if (c.name.startsWith("request-")) {
      assert.equal(table, "ScalarReconciliationRequest");
      const expected = {
        ...request,
        id: row.id,
        auditEventId: row.auditEventId,
        sealed: c.name === "request-born-sealed",
      };
      if (c.name === "request-adopt-standalone") {
        const borrowed = c.before.FactAssessment.find(
          (a) => a.id === receipt.standalone[0],
        );
        Object.assign(expected, {
          projectId: borrowed.projectId,
          factId: borrowed.factId,
          originalAssessmentId: borrowed.id,
          originCommandId: row.originCommandId,
        });
        assert.equal(borrowed.captureKind, "SCALAR");
      }
      if (c.name === "request-wrong-digest") {
        assert.notEqual(row.contributorHash, request.contributorHash);
        expected.contributorHash = row.contributorHash;
        assert.match(row.contributorHash, /^[a-f0-9]{64}$/);
      }
      assert.deepEqual(row, expected);
    } else if (c.name === "check-cross-request") {
      assert.equal(table, "ScalarReconciliationCheck");
      const original = c.before.ScalarReconciliationCheck.find(
        (a) => a.id === request.originCommandId,
      );
      assert.notEqual(row.projectId, original.projectId);
      assert.notEqual(row.factId, original.factId);
      assert(
        c.before.ProjectFact.some(
          (a) => a.id === row.factId && a.projectId === row.projectId,
        ),
      );
      assert.deepEqual(row, {
        ...original,
        id: row.id,
        projectId: row.projectId,
        factId: row.factId,
        outcome: "REUSED",
        idempotencyKey: row.idempotencyKey,
        auditEventId: row.auditEventId,
      });
    } else {
      assert.equal(c.name, "proof-wrong-kind");
      assert.equal(table, "FactAssessment");
      assert.deepEqual(row, {
        ...proof,
        id: row.id,
        captureKind: "SCALAR",
        idempotencyKey: row.idempotencyKey,
        sealed: false,
      });
    }
  }
}
