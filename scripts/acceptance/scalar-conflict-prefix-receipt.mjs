// FR-EVD-004/007/009/012, NFR-REL-001/002: closed original-prefix evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertAvailableScalarOriginal } from "./scalar-reconciliation-recovery-receipt.mjs";
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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const names = [
  "original-check",
  "baseline-get",
  "overflow-check",
  "original-replay",
  "original-get",
];
const key = (r) => r.id ?? r.assessmentId + ":" + (r.versionId ?? r.conflictId);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function closed(value, keys) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function one(rows) {
  assert.equal(rows.length, 1);
  return rows[0];
}
function retained(before, after) {
  for (const row of before)
    assert.deepEqual(one(after.filter((r) => key(r) === key(row))), row);
}
function pid(value) {
  assert(Number.isInteger(value) && value > 0);
}
function time(value) {
  const utc = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z";
  assert(Number.isFinite(Date.parse(utc)));
  return Date.parse(utc);
}
export function assertScalarConflictPrefix(r, customerId) {
  closed(r, [
    "family",
    "customerId",
    "projectId",
    "factId",
    "actor",
    "pm",
    "command",
    "observer",
    "setup",
    "retained",
    "before",
    "after",
    "prefix",
    "sample",
    "commands",
    "baseline",
    "integrity",
  ]);
  assert.equal(r.family, "scalar-conflict-prefix/v1");
  assert.equal(r.customerId, customerId);
  for (const id of [customerId, r.projectId, r.factId]) assert.match(id, uuid);
  for (const actor of [r.actor, r.pm])
    assert.equal(actor.customerId, customerId);
  assert.deepEqual(r.actor.roles, ["pmo_admin"]);
  assert.deepEqual(r.pm.roles, ["project_manager"]);
  assert.notEqual(r.actor.subject, r.pm.subject);
  closed(r.observer, ["role", "sessionUser", "pid"]);
  assert.equal(r.observer.role, "pdaa_api");
  assert.equal(r.observer.sessionUser, "pdaa_api");
  pid(r.observer.pid);
  closed(r.setup, ["method", "principal", "highestId"]);
  assert.equal(r.setup.method, "guarded-owner-append");
  closed(r.setup.principal, ["role", "sessionUser", "pid"]);
  assert.equal(typeof r.setup.principal.role, "string");
  assert(r.setup.principal.role.length > 0);
  assert.equal(typeof r.setup.principal.sessionUser, "string");
  assert(r.setup.principal.sessionUser.length > 0);
  pid(r.setup.principal.pid);
  assert.match(r.setup.highestId, uuid);
  closed(r.command, ["projectId", "factId", "idempotencyKey"]);
  assert.equal(r.command.projectId, r.projectId);
  assert.equal(r.command.factId, r.factId);
  assert.match(r.command.idempotencyKey, uuid);
  assert.deepEqual(
    r.commands.map((c) => c.name),
    names,
  );
  assert.equal(
    new Set(r.commands.map((c) => c.correlationId)).size,
    names.length,
  );
  for (const [i, c] of r.commands.entries()) {
    closed(c, [
      "name",
      "operation",
      "actor",
      "command",
      "correlationId",
      "nativeCommitAttempts",
      "callbackReturned",
      "options",
      "role",
      "sessionUser",
      "pid",
      "nativePid",
      "callbackReturnedAtCommit",
      "nativeCommand",
      "commitObserver",
      "result",
    ]);
    assert.equal(c.operation, [1, 4].includes(i) ? "get" : "check");
    assert.deepEqual(c.actor, r.pm);
    assert.match(c.correlationId, uuid);
    assert.deepEqual(c.options, {
      isolationLevel: "ReadCommitted",
      maxWait: 5000,
      timeout: 10000,
    });
    assert.equal(c.role, "pdaa_api");
    assert.equal(c.sessionUser, "pdaa_api");
    pid(c.pid);
    assert.equal(c.nativePid, c.pid);
    assert.notEqual(c.pid, r.observer.pid);
    assert.equal(c.nativeCommitAttempts, 1);
    assert.equal(c.callbackReturned, true);
    assert.equal(c.callbackReturnedAtCommit, true);
    assert.equal(c.nativeCommand, "COMMIT");
    assert.deepEqual(c.commitObserver, {
      observerPid: r.observer.pid,
      writerPid: c.pid,
      sessionUser: "pdaa_api",
      state: "idle",
      query: "COMMIT",
      phase: "native-commit-settled",
    });
  }
  const original = r.commands[0].result,
    overflow = r.commands[2].result;
  assert.equal(original.outcome, "CREATED");
  assert.equal(original.replayed, false);
  assertAvailableScalarOriginal(original.assessment, customerId, r.command);
  assertAvailableScalarOriginal(r.baseline.assessment, customerId, r.command);
  assert.deepEqual(r.baseline, r.commands[1].result);
  assert.deepEqual(r.baseline.request, original.request);
  assert.deepEqual(r.baseline.assessment, original.assessment);
  const read = { projectId: r.projectId, requestId: original.request.id };
  assert.deepEqual(r.commands[0].command, r.command);
  assert.deepEqual(r.commands[3].command, r.command);
  for (const i of [1, 4]) assert.deepEqual(r.commands[i].command, read);
  assert.deepEqual(r.commands[2].command, {
    ...r.command,
    idempotencyKey: r.commands[2].command.idempotencyKey,
  });
  assert.match(r.commands[2].command.idempotencyKey, uuid);
  assert.notEqual(
    r.commands[2].command.idempotencyKey,
    r.command.idempotencyKey,
  );
  assert.deepEqual(r.commands[3].result, {
    ...original,
    replayed: true,
    assessment: { ...original.assessment, replayed: true },
  });
  assert.deepEqual(r.commands[4].result, r.baseline);
  for (const state of [r.retained, r.before, r.after]) {
    closed(state, tables);
    for (const table of tables) {
      assert(Array.isArray(state[table]) && state[table].length <= 5000);
      assert.equal(new Set(state[table].map(key)).size, state[table].length);
      for (const row of state[table]) {
        assert.equal(row.customerId, customerId);
        assert.equal(
          table === "AuditEvent" ? row.detail.projectId : row.projectId,
          r.projectId,
        );
        if (table !== "AuditEvent")
          assert.equal(table === "ProjectFact" ? row.id : row.factId, r.factId);
      }
    }
  }
  const beforeCounts = {
    ScalarReconciliationRequest: 1,
    ScalarReconciliationCheck: 1,
    ScalarReconciliationAssignment: 1,
    FactAssessment: 1,
    FactAssessmentVersion: 2,
    FactAssessmentConflict: 1,
    FactAuthorityConflict: 1,
    ProjectFact: 1,
    ProjectFactVersion: 2,
    FactEvidence: 2,
  };
  for (const [table, count] of Object.entries(beforeCounts))
    assert.equal(r.retained[table].length, count);
  const oldCheck = one(r.retained.ScalarReconciliationCheck);
  const oldProof = one(r.retained.FactAssessment);
  const oldRequest = one(r.retained.ScalarReconciliationRequest);
  const oldAssignment = one(r.retained.ScalarReconciliationAssignment);
  assert.equal(oldRequest.id, original.request.id);
  assert.equal(oldRequest.state, "OPEN");
  assert.equal(oldRequest.sealed, true);
  assert.equal(oldRequest.originalAssessmentId, oldProof.id);
  assert.equal(oldRequest.originCommandId, oldCheck.id);
  assert.equal(oldProof.id, original.assessment.assessmentId);
  assert.deepEqual(oldProof.result, original.assessment.result);
  assert.equal(oldProof.scalarReconciliationCheckId, oldCheck.id);
  assert.equal(oldProof.captureKind, "SCALAR_REQUEST");
  assert.equal(oldProof.sealed, true);
  assert.equal(oldProof.factRevision, 2);
  assert.equal(oldProof.conflictThroughRevision, 1);
  assert.equal(oldCheck.id, original.checkId);
  assert.equal(oldCheck.assessmentId, oldProof.id);
  assert.equal(oldCheck.requestId, oldRequest.id);
  assert.equal(oldCheck.subject, r.pm.subject);
  assert.equal(oldCheck.idempotencyKey, r.command.idempotencyKey);
  assert.equal(oldCheck.outcome, "CREATED");
  assert.equal(oldAssignment.id, original.request.assignment.id);
  assert.equal(oldAssignment.requestId, oldRequest.id);
  assert.equal(oldAssignment.kind, "INITIAL");
  assert.equal(oldAssignment.revision, 1);
  assert.equal(oldAssignment.recipientSubject, r.pm.subject);
  assert.equal(oldAssignment.reason, "ASSIGNED");
  assert.equal(oldProof.complete, true);
  assert.equal(oldProof.versionCount, 2);
  assert.equal(oldProof.conflictCount, 1);
  assert.equal(oldProof.policyRevisionId, oldProof.result.policy.revisionId);
  const originalVersionIds = r.retained.ProjectFactVersion.map(
    (v) => v.id,
  ).sort();
  assert.deepEqual(
    r.retained.FactAssessmentVersion.map((d) => d.versionId).sort(),
    originalVersionIds,
  );
  assert.deepEqual(
    oldProof.result.versions.map((v) => v.id).sort(),
    originalVersionIds,
  );
  for (const d of r.retained.FactAssessmentVersion) {
    assert.equal(d.assessmentId, oldProof.id);
    assert(
      Number.isInteger(d.sourceAccessRevision) && d.sourceAccessRevision > 0,
    );
    const v = one(
      r.retained.ProjectFactVersion.filter((row) => row.id === d.versionId),
    );
    const frozen = one(
      oldProof.result.versions.filter((row) => row.id === v.id),
    );
    assert.deepEqual(frozen.value, v.value);
    assert.deepEqual(frozen.evidenceIds, [v.evidenceId]);
    assert.equal(frozen.source.instanceId, v.sourceId);
  }
  assert.deepEqual(r.retained.FactAssessmentConflict, [
    {
      customerId,
      projectId: r.projectId,
      factId: r.factId,
      assessmentId: oldProof.id,
      conflictId: r.retained.FactAuthorityConflict[0].id,
    },
  ]);
  const originalAudits = r.retained.AuditEvent.filter(
    (a) => a.correlationId === r.commands[0].correlationId,
  );
  assert.equal(originalAudits.length, 3);
  const auditSpecs = [
    [
      "scalar.reconciliation.checked",
      oldCheck.auditEventId,
      {
        projectId: r.projectId,
        factId: r.factId,
        checkId: oldCheck.id,
        assessmentId: oldProof.id,
        requestId: oldRequest.id,
        outcome: "CREATED",
      },
    ],
    [
      "scalar.reconciliation.requested",
      oldRequest.auditEventId,
      {
        projectId: r.projectId,
        factId: r.factId,
        requestId: oldRequest.id,
        assessmentId: oldProof.id,
        checkId: oldCheck.id,
      },
    ],
    [
      "scalar.reconciliation.assigned",
      oldAssignment.auditEventId,
      {
        projectId: r.projectId,
        factId: r.factId,
        requestId: oldRequest.id,
        assignmentId: oldAssignment.id,
        revision: 1,
        reason: "ASSIGNED",
      },
    ],
  ];
  for (const [event, eventId, detail] of auditSpecs) {
    assert.match(eventId, uuid);
    const audit = one(originalAudits.filter((a) => a.event === event));
    assert.equal(audit.id, eventId);
    assert.equal(audit.actor, r.pm.subject);
    assert.equal(time(audit.occurredAt), time(oldProof.asOf));
    assert.deepEqual(audit.detail, detail);
  }
  for (const table of tables) {
    const setupDelta =
      { ProjectFactVersion: 62, FactEvidence: 62, FactAuthorityConflict: 1001 }[
        table
      ] ?? 0;
    assert.equal(r.before[table].length - r.retained[table].length, setupDelta);
    if (table === "ProjectFact")
      assert.deepEqual(r.before[table], [
        { ...r.retained[table][0], revision: 64 },
      ]);
    else retained(r.retained[table], r.before[table]);
    const delta = [
      "ScalarReconciliationCheck",
      "FactAssessment",
      "AuditEvent",
    ].includes(table)
      ? 1
      : 0;
    assert.equal(r.after[table].length - r.before[table].length, delta);
    retained(r.before[table], r.after[table]);
  }
  assert.deepEqual(
    r.before.ProjectFactVersion.map((v) => v.revision).sort((a, b) => a - b),
    Array.from({ length: 64 }, (_, i) => i + 1),
  );
  for (const v of r.before.ProjectFactVersion) {
    assert.match(v.id, uuid);
    assert.match(v.evidenceId, uuid);
    const e = one(
      r.before.FactEvidence.filter((row) => row.id === v.evidenceId),
    );
    assert.equal(e.sourceId, v.sourceId);
    assert.equal(v.value.type, "date");
  }
  const conflicts = r.before.FactAuthorityConflict;
  assert.equal(conflicts.length, 1002);
  assert.deepEqual(
    conflicts.map((c) => c.revision).sort((a, b) => a - b),
    Array.from({ length: 1002 }, (_, i) => i + 1),
  );
  const pairs = new Set();
  for (const c of conflicts) {
    assert.match(c.id, uuid);
    assert(c.leftVersionId < c.rightVersionId);
    const left = one(
      r.before.ProjectFactVersion.filter((v) => v.id === c.leftVersionId),
    );
    const right = one(
      r.before.ProjectFactVersion.filter((v) => v.id === c.rightVersionId),
    );
    assert.notDeepEqual(left.value, right.value);
    assert.equal(c.policyRevisionId, oldProof.policyRevisionId);
    assert.equal(c.factType, oldProof.factType);
    assert(!pairs.has(c.leftVersionId + c.rightVersionId));
    pairs.add(c.leftVersionId + c.rightVersionId);
  }
  assert.deepEqual(r.prefix, { count: 1002, throughRevision: 1002 });
  const sorted = [...conflicts].sort(byId);
  assert.equal(sorted.at(-1).id, r.setup.highestId);
  assert.equal(sorted.at(-1).revision, 1002);
  assert.deepEqual(
    r.sample,
    sorted.slice(0, 1001).map(({ id, revision }) => ({ id, revision })),
  );
  assert.equal(Math.max(...r.sample.map((c) => c.revision)), 1001);
  assert(!r.sample.some((c) => c.revision === 1002));
  assert.equal(overflow.outcome, "NO_REQUEST");
  assert.equal(overflow.replayed, false);
  assert.equal(overflow.request, null);
  assert.notEqual(overflow.checkId, original.checkId);
  assert.notEqual(overflow.assessment.assessmentId, oldProof.id);
  const check = one(
    r.after.ScalarReconciliationCheck.filter((c) => c.id !== oldCheck.id),
  );
  const proof = one(r.after.FactAssessment.filter((p) => p.id !== oldProof.id));
  const audit = one(
    r.after.AuditEvent.filter(
      (a) => !r.before.AuditEvent.some((b) => a.id === b.id),
    ),
  );
  assert.equal(check.id, overflow.checkId);
  assert.equal(check.assessmentId, proof.id);
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ projectId: r.projectId, factId: r.factId }))
    .digest("hex");
  assert.deepEqual(check, {
    id: check.id,
    customerId,
    projectId: r.projectId,
    factId: r.factId,
    subject: r.pm.subject,
    idempotencyKey: r.commands[2].command.idempotencyKey,
    requestHash,
    assessmentId: proof.id,
    requestId: null,
    outcome: "NO_REQUEST",
    occurredAt: proof.asOf,
    auditEventId: audit.id,
  });
  assert.equal(proof.id, overflow.assessment.assessmentId);
  assert.equal(proof.scalarReconciliationCheckId, check.id);
  assert.equal(proof.subject, r.pm.subject);
  assert.equal(proof.captureKind, "SCALAR_REQUEST");
  assert.equal(proof.milestoneAssessmentId, null);
  assert.equal(proof.idempotencyKey, "sr_" + check.id.replaceAll("-", ""));
  assert.equal(proof.requestHash, requestHash);
  assert.equal(proof.sealed, true);
  assert.equal(proof.complete, false);
  assert.equal(proof.factRevision, 64);
  assert.equal(proof.versionCount, 0);
  assert.equal(proof.conflictCount, 0);
  assert.equal(proof.conflictThroughRevision, 1002);
  assert.equal(proof.policyRevisionId, oldProof.policyRevisionId);
  assert.equal(proof.policyId, oldProof.policyId);
  assert.equal(proof.policyThroughRevision, oldProof.policyThroughRevision);
  const result = proof.result;
  assert.deepEqual(result.scope, oldProof.result.scope);
  assert.deepEqual(result.policy, oldProof.result.policy);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.complete, false);
  assert.equal(result.revalidationRequired, false);
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.resolvedValue, null);
  for (const field of [
    "versions",
    "conflicts",
    "candidateVersionIds",
    "supportingVersionIds",
    "supportingEvidenceIds",
  ])
    assert.deepEqual(result[field], []);
  assert.equal(time(result.asOf), time(proof.asOf));
  assert(time(proof.asOf) >= time(oldProof.asOf));
  for (const c of conflicts) assert(time(c.detectedAt) <= time(proof.asOf));
  assert.deepEqual(overflow.assessment, {
    assessmentId: proof.id,
    factId: r.factId,
    asOf: new Date(proof.asOf).toISOString(),
    historical: true,
    replayed: false,
    visibility: "available",
    revalidationRequired: false,
    result,
  });
  assert.equal(audit.customerId, customerId);
  assert.equal(audit.actor, r.pm.subject);
  assert.equal(audit.correlationId, r.commands[2].correlationId);
  assert.equal(audit.event, "scalar.reconciliation.checked");
  assert.equal(time(audit.occurredAt), time(proof.asOf));
  assert.deepEqual(audit.detail, {
    projectId: r.projectId,
    factId: r.factId,
    checkId: check.id,
    assessmentId: proof.id,
    requestId: null,
    outcome: "NO_REQUEST",
  });
  assert.deepEqual(r.integrity, {
    originalRequestId: oldRequest.id,
    originalProofId: oldProof.id,
    overflowCheckId: check.id,
    overflowProofId: proof.id,
    originalRequestValid: true,
    originalProofValid: true,
    overflowCheckValid: true,
    overflowProofValid: true,
  });
}
