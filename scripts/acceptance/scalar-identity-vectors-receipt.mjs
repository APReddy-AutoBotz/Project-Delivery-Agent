// FR-EVD-007/009/012: independent native vector receipt reader; no producer import.
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
  "AuthorityPolicyRevision",
  "FactSourceAccess",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const time = (value) =>
  Date.parse(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
const one = (rows, id) => {
  const found = rows.filter((r) => r.id === id);
  assert.equal(found.length, 1);
  return found[0];
};
const key = (row) =>
  row.id ??
  row.sourceId ??
  JSON.stringify([row.assessmentId, row.versionId ?? row.conflictId]);
export function assertScalarIdentityVectorStep(step, customerId, c, index) {
  const created = index === 0 || index === 3;
  assert.equal(
    step.name,
    [
      "created",
      "recorded-reuse",
      "future-policy-reuse",
      "selected-policy-created",
    ][index],
  );
  assertScalarIdentityExecution(step);
  assert.equal(step.actor.subject, (index === 1 ? c.pm : c.actor).subject);
  assert.equal(step.command.projectId, c.projectId);
  assert.equal(step.command.factId, c.factId);
  for (const graph of [step.before, step.after]) {
    assert.deepEqual(Object.keys(graph).sort(), [...tables].sort());
    for (const table of tables) {
      assert(graph[table].length <= 100);
      assert.equal(new Set(graph[table].map(key)).size, graph[table].length);
      for (const row of graph[table]) {
        assert.equal(row.customerId, customerId);
        assert.equal(
          table === "AuditEvent" ? row.detail.projectId : row.projectId,
          c.projectId,
        );
        if (table !== "AuditEvent" && table !== "AuthorityPolicyRevision")
          assert.equal(table === "ProjectFact" ? row.id : row.factId, c.factId);
      }
    }
  }
  for (const table of tables)
    for (const old of step.before[table])
      assert.deepEqual(
        step.after[table].find((r) => key(r) === key(old)),
        old,
      );
  const added = Object.fromEntries(
    tables.map((t) => [
      t,
      step.after[t].filter(
        (r) => !step.before[t].some((old) => key(old) === key(r)),
      ),
    ]),
  );
  for (const table of [
    "ProjectFact",
    "ProjectFactVersion",
    "FactEvidence",
    "AuthorityPolicyRevision",
    "FactSourceAccess",
  ])
    assert.equal(added[table].length, 0);
  assert.equal(added.ScalarReconciliationRequest.length, created ? 1 : 0);
  assert.equal(added.ScalarReconciliationAssignment.length, created ? 1 : 0);
  assert.equal(added.ScalarReconciliationCheck.length, 1);
  assert.equal(added.FactAssessment.length, 1);
  assert.equal(added.FactAssessmentVersion.length, 2);
  assert.equal(added.FactAuthorityConflict.length, index === 0 ? 1 : 0);
  const result = step.result,
    proof = result.assessment;
  assert.equal(result.outcome, created ? "CREATED" : "REUSED");
  assert.equal(result.replayed, false);
  assert.equal(proof.visibility, "available");
  assert.equal(proof.revalidationRequired, false);
  assert.equal(proof.result.complete, true);
  assert.equal(proof.result.status, "CONFLICTING");
  assert.equal(proof.result.reconciliationRequired, true);
  assert.equal(proof.result.resolvedValue, null);
  const header = one(added.FactAssessment, proof.assessmentId);
  const commandHash = hash(
    JSON.stringify({ projectId: c.projectId, factId: c.factId }),
  );
  assert.equal(header.subject, step.actor.subject);
  assert.equal(header.requestHash, commandHash);
  assert.equal(
    header.idempotencyKey,
    "sr_" + result.checkId.replaceAll("-", ""),
  );
  assert.equal(header.captureKind, "SCALAR_REQUEST");
  assert.equal(header.milestoneAssessmentId, null);
  assert.equal(header.factId, c.factId);
  assert.equal(time(header.asOf), time(proof.asOf));
  assert.equal(header.sealed, true);
  assert.equal(header.scalarReconciliationCheckId, result.checkId);
  assert.equal(header.policyThroughRevision, index < 2 ? 1 : index);
  assert.equal(header.policyRevisionId, proof.result.policy.revisionId);
  assert.deepEqual(header.result, proof.result);
  const policy = one(
    step.after.AuthorityPolicyRevision,
    proof.result.policy.revisionId,
  );
  assert.equal(policy.revision, index === 3 ? 3 : 1);
  assert(time(policy.effectiveAt) <= time(header.asOf));
  if (index >= 2)
    assert(
      time(
        step.after.AuthorityPolicyRevision.find((r) => r.revision === 2)
          .effectiveAt,
      ) > time(header.asOf),
    );
  assert.equal(header.factRevision, 2);
  assert.equal(header.versionCount, 2);
  assert.equal(header.conflictCount, 1);
  assert.equal(header.conflictThroughRevision, 1);
  assert.equal(added.FactAssessmentConflict.length, 1);
  assert.deepEqual(added.FactAssessmentConflict[0], {
    customerId,
    projectId: c.projectId,
    factId: c.factId,
    assessmentId: header.id,
    conflictId: step.after.FactAuthorityConflict[0].id,
  });
  const versions = [...step.after.ProjectFactVersion].sort(
    (a, b) => a.revision - b.revision,
  );
  assert.equal(versions.length, 2);
  assert.deepEqual(
    versions.map((v) => v.value),
    c.values,
  );
  assert.equal(proof.result.versions.length, 2);
  for (const version of proof.result.versions) {
    const input = one(versions, version.id);
    assert.deepEqual(version.value, input.value);
    assert.equal(version.source.instanceId, input.sourceId);
    assert.deepEqual(version.evidenceIds, [input.evidenceId]);
    assert.equal(
      one(step.after.FactEvidence, input.evidenceId).sourceId,
      input.sourceId,
    );
    const dep = added.FactAssessmentVersion.find(
      (row) => row.versionId === input.id,
    );
    assert.deepEqual(dep, {
      customerId,
      projectId: c.projectId,
      factId: c.factId,
      assessmentId: header.id,
      versionId: input.id,
      sourceAccessRevision: step.before.FactSourceAccess.find(
        (row) => row.sourceId === input.sourceId,
      ).revision,
    });
  }
  const ids = [
    ...new Set(proof.result.conflicts.flatMap((g) => g.versionIds)),
  ].sort();
  assert.deepEqual(ids, versions.map((v) => v.id).sort());
  for (const group of proof.result.conflicts) {
    assert.deepEqual([...group.versionIds].sort(), ids);
    assert.deepEqual(
      [...group.evidenceIds].sort(),
      versions.map((v) => v.evidenceId).sort(),
    );
  }
  const identity = JSON.stringify([
    "scalar-authority-conflict/v1",
    customerId,
    c.projectId,
    c.factId,
    policy.id,
    ids.map((id) => {
      const v = one(versions, id);
      return [id, v.sourceId, v.value.type, [v.evidenceId]];
    }),
  ]);
  assert.match(identity, /^[\x20-\x7e]+$/);
  assert.equal(step.tsIdentity, identity);
  assert.deepEqual(step.sql, {
    identity,
    proofValid: true,
    checkValid: true,
    requestValid: true,
  });
  const request = one(
    step.after.ScalarReconciliationRequest,
    result.request.id,
  );
  assert.equal(request.contributorIdentity, identity);
  assert.equal(request.contributorHash, hash(identity));
  assert.equal(request.sealed, true);
  assert.equal(request.state, "OPEN");
  const check = one(added.ScalarReconciliationCheck, result.checkId);
  assert.equal(check.assessmentId, header.id);
  assert.equal(check.requestId, request.id);
  assert.equal(check.subject, step.actor.subject);
  assert.equal(check.idempotencyKey, step.command.idempotencyKey);
  assert.equal(check.outcome, result.outcome);
  assert.equal(check.requestHash, commandHash);
  assert.equal(time(check.occurredAt), time(header.asOf));
  assert.equal(added.AuditEvent.length, created ? 3 : 1);
  for (const event of added.AuditEvent) {
    assert.equal(event.actor, step.actor.subject);
    assert.equal(event.correlationId, step.context.correlationId);
    assert.equal(time(event.occurredAt), time(header.asOf));
  }
  const audit = one(added.AuditEvent, check.auditEventId);
  assert.equal(audit.event, "scalar.reconciliation.checked");
  assert.deepEqual(audit.detail, {
    projectId: c.projectId,
    factId: c.factId,
    requestId: request.id,
    assessmentId: header.id,
    checkId: check.id,
    outcome: result.outcome,
  });
  if (created) {
    assert.equal(request.originalAssessmentId, header.id);
    assert.equal(request.originCommandId, check.id);
    const assignment = added.ScalarReconciliationAssignment[0];
    assert.equal(assignment.requestId, request.id);
    assert.equal(assignment.kind, "INITIAL");
    assert.equal(assignment.revision, 1);
    assert.equal(assignment.recipientSubject, c.pm.subject);
    assert.equal(result.request.assignment.id, assignment.id);
    assert.equal(assignment.actor, step.actor.subject);
    assert.equal(assignment.expectedRevision, 0);
    assert.equal(assignment.previousAssignmentId, null);
    assert.equal(assignment.idempotencyKey, null);
    assert.equal(assignment.requestHash, null);
    assert.equal(time(assignment.occurredAt), time(header.asOf));
    assert.equal(request.createdBy, step.actor.subject);
    assert.equal(time(request.createdAt), time(header.asOf));
    assert.deepEqual(one(added.AuditEvent, assignment.auditEventId).detail, {
      projectId: c.projectId,
      factId: c.factId,
      requestId: request.id,
      assignmentId: assignment.id,
      revision: 1,
      reason: assignment.reason,
    });
    assert.deepEqual(one(added.AuditEvent, request.auditEventId).detail, {
      projectId: c.projectId,
      factId: c.factId,
      requestId: request.id,
      assessmentId: header.id,
      checkId: check.id,
    });
    assert.equal(
      one(added.AuditEvent, assignment.auditEventId).event,
      "scalar.reconciliation.assigned",
    );
    assert.equal(
      one(added.AuditEvent, request.auditEventId).event,
      "scalar.reconciliation.requested",
    );
  }
  return true;
}
export function assertScalarIdentityExecution(step) {
  assert.equal(step.principal.role, "pdaa_api");
  assert.equal(step.principal.login, "pdaa_api");
  assert(Number.isInteger(step.principal.pid) && step.principal.pid > 0);
  assert.equal(step.callbackReturned, true);
  assert.equal(step.settled, true);
  assert.deepEqual(step.options, {
    isolationLevel: "ReadCommitted",
    maxWait: 5000,
    timeout: 10000,
  });
  return true;
}
export function assertScalarIdentityVectors(receipt, customerId) {
  assert.equal(receipt.family, "scalar-identity-vectors/v1");
  assert.equal(receipt.customerId, customerId);
  assert.deepEqual(
    receipt.cases.map((c) => c.name),
    ["date", "number", "boolean", "text"],
  );
  assert.equal(new Set(receipt.cases.map((c) => c.projectId)).size, 4);
  assert.deepEqual(
    receipt.cases.map((c) => c.values),
    [
      [
        { type: "date", value: "2026-10-01" },
        { type: "date", value: "2026-10-02" },
      ],
      [
        { type: "number", value: 1e-100 },
        { type: "number", value: 1e100 },
      ],
      [
        { type: "boolean", value: false },
        { type: "boolean", value: true },
      ],
      [
        { type: "text", value: '非ASCII "quotes" \\ \n🚀' },
        { type: "text", value: "Distinct synthetic value" },
      ],
    ],
  );
  for (const c of receipt.cases) {
    assert.equal(c.values.length, 2);
    for (const value of c.values) assert.equal(value.type, c.name);
    assert.notDeepEqual(c.values[0], c.values[1]);
    assert.equal(c.steps.length, 4);
    for (const [index, step] of c.steps.entries()) {
      const prior = index === 0 ? c.before : c.steps[index - 1].after;
      for (const table of tables) {
        if (
          index < 2 ||
          !["AuditEvent", "AuthorityPolicyRevision"].includes(table)
        )
          assert.deepEqual(step.before[table], prior[table]);
        else {
          for (const row of prior[table])
            assert.deepEqual(one(step.before[table], row.id), row);
          const delta = step.before[table].filter(
            (r) => !prior[table].some((old) => old.id === r.id),
          );
          assert.equal(delta.length, 1);
          const policy = step.before.AuthorityPolicyRevision.find(
            (r) => r.revision === index,
          );
          assert.equal(
            policy.policyId,
            c.before.AuthorityPolicyRevision[0].policyId,
          );
          assert.deepEqual(
            policy.definition,
            c.before.AuthorityPolicyRevision[0].definition,
          );
          if (table === "AuditEvent") {
            assert.equal(delta[0].event, "authority.policy.appended");
            assert.equal(delta[0].actor, c.actor.subject);
            assert.deepEqual(delta[0].detail, {
              projectId: c.projectId,
              policyId: policy.policyId,
              revisionId: policy.id,
              revision: index,
            });
          }
        }
      }
      assertScalarIdentityVectorStep(step, customerId, c, index);
    }
    const [first, reused, future, changed] = c.steps;
    assert.equal(reused.tsIdentity, first.tsIdentity);
    assert.equal(future.tsIdentity, first.tsIdentity);
    assert.notEqual(changed.tsIdentity, first.tsIdentity);
    assert.equal(reused.result.request.id, first.result.request.id);
    assert.equal(future.result.request.id, first.result.request.id);
    assert.notEqual(changed.result.request.id, first.result.request.id);
    assert.deepEqual(c.original.assessment, first.result.assessment);
    assert.deepEqual(c.original.request, first.result.request);
    assert.deepEqual(c.replay, {
      ...first.result,
      replayed: true,
      assessment: { ...first.result.assessment, replayed: true },
    });
    assert.deepEqual(c.afterReplay, changed.after);
  }
  return true;
}
