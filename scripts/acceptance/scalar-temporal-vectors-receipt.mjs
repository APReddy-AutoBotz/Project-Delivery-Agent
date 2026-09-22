// FR-EVD-004/006/007/012: independently bind native inputs, dimensions and ownership.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertScalarIdentityExecution } from "./scalar-identity-vectors-receipt.mjs";
const names = [
  "recorded-stale",
  "recorded-superseded",
  "higher-stale-contradiction",
  "higher-stale-agreement",
  "recorded-at-equal",
  "recorded-at-after",
];
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
  "AuthorityPolicy",
  "AuthorityPolicyReceipt",
];
const time = (value) =>
  Date.parse(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const key = (row) =>
  row.id ??
  row.sourceId ??
  JSON.stringify([row.assessmentId, row.versionId ?? row.conflictId]);
const one = (rows, id) => {
  const found = rows.filter((r) => r.id === id);
  assert.equal(found.length, 1);
  return found[0];
};
export function assertScalarTemporalDimensions(c) {
  assert(names.includes(c.name));
  const i = names.indexOf(c.name),
    result = c.result.assessment.result;
  const inputs = [...c.after.ProjectFactVersion].sort(
    (a, b) => a.revision - b.revision,
  );
  assert.equal(inputs.length, i === 1 ? 4 : 2);
  assert.equal(result.versions.length, inputs.length);
  const originalIds = inputs
    .slice(0, 2)
    .map((v) => v.id)
    .sort();
  assert.deepEqual(
    result.conflicts.map((g) => g.kind).sort(),
    i < 2
      ? ["RECORDED"]
      : i === 2
        ? ["HIGHER_AUTHORITY_CONTRADICTION", "RECORDED"]
        : i === 3
          ? []
          : ["AUTHORITY_DISAGREEMENT", "RECORDED"],
  );
  for (const group of result.conflicts) {
    assert.deepEqual([...group.versionIds].sort(), originalIds);
    assert.deepEqual(
      [...group.evidenceIds].sort(),
      inputs
        .slice(0, 2)
        .map((v) => v.evidenceId)
        .sort(),
    );
  }
  assert.equal(result.selectedTier, i < 2 ? null : i < 4 ? 1 : 0);
  const candidates = i < 2 ? [] : i < 4 ? [inputs[1].id] : originalIds;
  assert.deepEqual([...result.candidateVersionIds].sort(), candidates);
  assert.equal(result.status, i === 3 ? "RESOLVED" : "CONFLICTING");
  assert.equal(result.conflict, i === 3 ? "NONE" : "CONFLICTING");
  assert.equal(result.reconciliationRequired, ![3, 5].includes(i));
  assert.deepEqual(result.resolvedValue, i === 3 ? inputs[1].value : null);
  assert.deepEqual(result.supportingVersionIds, i === 3 ? [inputs[1].id] : []);
  assert.deepEqual(
    result.supportingEvidenceIds,
    i === 3 ? [inputs[1].evidenceId] : [],
  );
  for (const [index, input] of inputs.entries()) {
    const version = one(result.versions, input.id);
    assert.deepEqual(version.value, input.value);
    assert.deepEqual(version.evidenceIds, [input.evidenceId]);
    assert.equal(version.source.instanceId, input.sourceId);
    assert.equal(version.provenance, "HUMAN_CONFIRMED");
    assert.equal(version.visibility, "available");
    assert.equal(version.revalidationRequired, false);
    assert.equal(
      version.temporalApplicability,
      i === 1 && index < 2 ? "SUPERSEDED" : "APPLICABLE",
    );
    const stale = i < 2 || (i < 4 && index === 0);
    assert.equal(version.assessment.freshness, stale ? "STALE" : "CURRENT");
    assert.equal(version.assessment.provenance, "HUMAN_CONFIRMED");
    assert.equal(
      version.assessment.conflict,
      i === 3 || index >= 2 ? "NONE" : "CONFLICTING",
    );
    assert.deepEqual(
      version.eligibilityReasons,
      i === 1 && index < 2
        ? ["NOT_APPLICABLE", "STALE"]
        : stale
          ? ["STALE"]
          : [],
    );
    if (stale) {
      assert.equal(
        time(version.assessedValidUntil),
        time(input.effectiveAt) + 1,
      );
      assert(time(input.effectiveAt) + 1 <= time(c.result.assessment.asOf));
    }
  }
  if (i === 3) assert.deepEqual(inputs[0].value, inputs[1].value);
  else assert.notDeepEqual(inputs[0].value, inputs[1].value);
  if (i === 1)
    for (const index of [0, 1]) {
      assert.equal(inputs[index].sourceId, inputs[index + 2].sourceId);
      assert(
        time(inputs[index].effectiveAt) < time(inputs[index + 2].effectiveAt),
      );
      assert.deepEqual(inputs[index + 2].value, inputs[0].value);
    }
  return true;
}
export function assertScalarTemporalPolicy(c, header) {
  const i = names.indexOf(c.name);
  const policies = c.after.AuthorityPolicyRevision;
  assert.equal(header.policyThroughRevision, 2);
  assert.equal(policies.length, 2);
  const applicable = policies
    .filter(
      (p) =>
        p.revision <= header.policyThroughRevision &&
        time(p.recordedAt) <= time(header.asOf) &&
        time(p.effectiveAt) <= time(header.asOf),
    )
    .sort((a, b) => b.revision - a.revision);
  assert.equal(applicable[0].revision, i === 5 ? 1 : 2);
  assert.equal(header.policyRevisionId, applicable[0].id);
  const selected = applicable[0];
  assert.equal(header.policyId, selected.policyId);
  assert.deepEqual(c.result.assessment.result.policy, {
    ...selected.definition,
    revisionId: selected.id,
    customerId: selected.customerId,
    projectId: selected.projectId,
    factType: selected.factType,
    recordedAt: new Date(time(selected.recordedAt)).toISOString(),
    effectiveAt: new Date(time(selected.effectiveAt)).toISOString(),
  });
  const second = policies.find((p) => p.revision === 2);
  assert.equal(second.state, "ENABLED");
  assert.equal(second.definition.conflictBehavior, "REQUEST_RECONCILIATION");
  const sources = [...c.after.ProjectFactVersion]
    .sort((a, b) => a.revision - b.revision)
    .slice(0, 2);
  assert.deepEqual(
    second.definition.tiers,
    (i === 2 || i === 3 ? sources : [null]).map((v, index) => ({
      selectors: [
        {
          sourceType: "human_statement",
          instanceId: v?.sourceId ?? null,
          requiredApproval: "NOT_REQUIRED",
          validity:
            i < 2 || ((i === 2 || i === 3) && index === 0)
              ? { basis: "effectiveAt", durationMs: 1 }
              : null,
        },
      ],
    })),
  );
  if (i >= 4) {
    const p = c.publication;
    assert.equal(p.kind, "synthetic-same-transaction-publication");
    assert.equal(p.clockCalls, 1);
    assert.equal(p.offsetMs, i - 4);
    assert.equal(time(p.serverTime), time(header.asOf));
    assert.equal(time(second.recordedAt) - time(header.asOf), i - 4);
    assert(time(second.effectiveAt) < time(header.asOf));
    assert.equal(second.id, p.revisionId);
    assert.equal(p.input.expectedRevision, 1);
    assert.equal(p.input.projectId, c.projectId);
    assert.equal(p.input.factType, "project.forecast");
    assert.equal(time(p.input.effectiveAt), time(second.effectiveAt));
    assert.deepEqual(p.input.definition, second.definition);
    const receipt = one(c.after.AuthorityPolicyReceipt, p.receiptId);
    assert.equal(receipt.revisionId, second.id);
    assert.equal(receipt.subject, c.actor.subject);
    assert.equal(receipt.requestHash, hash(JSON.stringify(p.input)));
    const audit = one(c.after.AuditEvent, p.auditId);
    assert.equal(audit.event, "authority.policy.appended");
    assert.equal(audit.actor, c.actor.subject);
    assert.match(audit.correlationId, /^scalar-temporal-publication-/);
    assert.deepEqual(audit.detail, {
      projectId: c.projectId,
      policyId: second.policyId,
      revisionId: second.id,
      revision: 2,
    });
  } else assert.equal(c.publication, null);
  return true;
}
export function assertScalarTemporalVectors(receipt, customerId) {
  assert.equal(receipt.family, "scalar-temporal-vectors/v1");
  assert.equal(receipt.customerId, customerId);
  assert.deepEqual(
    receipt.cases.map((c) => c.name),
    names,
  );
  assert.equal(new Set(receipt.cases.map((c) => c.projectId)).size, 5);
  for (const [i, c] of receipt.cases.entries()) {
    assertScalarIdentityExecution(c);
    assert.equal(c.actor.customerId, customerId);
    assert.equal(c.pm.customerId, customerId);
    assert.equal(c.command.projectId, c.projectId);
    assert.equal(c.command.factId, c.factId);
    for (const graph of [c.setupBefore, c.before, c.after, c.afterReplay]) {
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
          if (
            ![
              "AuditEvent",
              "AuthorityPolicy",
              "AuthorityPolicyRevision",
              "AuthorityPolicyReceipt",
            ].includes(table)
          )
            assert.equal(
              table === "ProjectFact" ? row.id : row.factId,
              c.factId,
            );
        }
      }
    }
    const delta = {};
    for (const table of tables) {
      for (const old of c.before[table]) {
        const current = c.after[table].find((r) => key(r) === key(old));
        assert.deepEqual(
          current,
          i >= 4 && table === "AuthorityPolicy" ? { ...old, revision: 2 } : old,
        );
      }
      delta[table] = c.after[table].filter(
        (r) => !c.before[table].some((old) => key(old) === key(r)),
      );
    }
    const created = [0, 2, 4].includes(i),
      negative = [3, 5].includes(i);
    const counts = {
      ScalarReconciliationRequest: created ? 1 : 0,
      ScalarReconciliationCheck: 1,
      ScalarReconciliationAssignment: created ? 1 : 0,
      FactAssessment: 1,
      FactAssessmentVersion: i === 1 ? 4 : 2,
      FactAssessmentConflict: i === 3 ? 0 : 1,
      FactAuthorityConflict: i >= 2 && i !== 3 ? 1 : 0,
      AuditEvent: (created ? 3 : 1) + (i >= 4 ? 1 : 0),
      ProjectFact: 0,
      ProjectFactVersion: 0,
      FactEvidence: 0,
      AuthorityPolicyRevision: i >= 4 ? 1 : 0,
      FactSourceAccess: 0,
      AuthorityPolicy: 0,
      AuthorityPolicyReceipt: i >= 4 ? 1 : 0,
    };
    for (const table of tables)
      assert.equal(delta[table].length, counts[table], c.name + " " + table);
    if (i !== 1)
      for (const table of [
        "ScalarReconciliationRequest",
        "ScalarReconciliationCheck",
        "ScalarReconciliationAssignment",
        "FactAssessment",
        "FactAuthorityConflict",
      ])
        assert.equal(c.setupBefore[table].length, 0);
    if (i === 0) {
      assert.equal(c.before.FactAssessment.length, 1);
      assert.equal(c.before.FactAssessment[0].captureKind, "SCALAR");
      assert.equal(
        c.before.FactAssessment[0].scalarReconciliationCheckId,
        null,
      );
      assert.equal(c.before.FactAuthorityConflict.length, 1);
    } else if (i >= 2) assert.equal(c.before.FactAuthorityConflict.length, 0);
    const result = c.result,
      proof = result.assessment,
      header = one(delta.FactAssessment, proof.assessmentId),
      check = one(delta.ScalarReconciliationCheck, result.checkId);
    assert.equal(
      result.outcome,
      negative ? "NO_REQUEST" : created ? "CREATED" : "REUSED",
    );
    assert.equal(result.replayed, false);
    assert.equal(proof.visibility, "available");
    assert.equal(proof.historical, true);
    assert.equal(proof.revalidationRequired, false);
    assert.equal(proof.result.complete, true);
    assert.equal(proof.result.revalidationRequired, false);
    assert.equal(header.captureKind, "SCALAR_REQUEST");
    assert.equal(header.scalarReconciliationCheckId, check.id);
    assert.equal(header.sealed, true);
    assert.equal(header.complete, true);
    assert.equal(header.evaluatorVersion, 1);
    assert.deepEqual(proof.result.scope, {
      customerId,
      projectId: c.projectId,
      factId: c.factId,
      factType: "project.forecast",
    });
    assert.equal(proof.result.asOf, proof.asOf);
    assert.equal(proof.result.mode, "HISTORICAL");
    assert.equal(header.subject, c.actor.subject);
    assert.equal(
      header.requestHash,
      hash(JSON.stringify({ projectId: c.projectId, factId: c.factId })),
    );
    assert.equal(header.idempotencyKey, "sr_" + check.id.replaceAll("-", ""));
    assert.equal(header.milestoneAssessmentId, null);
    assert.equal(time(header.asOf), time(proof.asOf));
    assert.equal(header.factRevision, i === 1 ? 4 : 2);
    assert.equal(header.versionCount, i === 1 ? 4 : 2);
    assert.equal(header.conflictCount, i === 3 ? 0 : 1);
    assert.equal(header.conflictThroughRevision, i === 3 ? null : 1);
    assert.deepEqual(header.result, proof.result);
    assertScalarTemporalPolicy(c, header);
    assertScalarTemporalDimensions(c);
    for (const input of c.after.ProjectFactVersion) {
      assert.deepEqual(
        delta.FactAssessmentVersion.find((r) => r.versionId === input.id),
        {
          customerId,
          projectId: c.projectId,
          factId: c.factId,
          assessmentId: header.id,
          versionId: input.id,
          sourceAccessRevision: c.before.FactSourceAccess.find(
            (r) => r.sourceId === input.sourceId,
          ).revision,
        },
      );
      assert.equal(
        one(c.after.FactEvidence, input.evidenceId).sourceId,
        input.sourceId,
      );
    }
    if (i !== 3) {
      const conflict = c.after.FactAuthorityConflict[0];
      assert.equal(conflict.revision, 1);
      for (const group of proof.result.conflicts)
        assert.equal(
          group.recordedConflictId,
          group.kind === "RECORDED" ? conflict.id : null,
        );
      const originals = [...c.after.ProjectFactVersion]
        .sort((a, b) => a.revision - b.revision)
        .slice(0, 2);
      assert.deepEqual(
        [conflict.leftVersionId, conflict.rightVersionId].sort(),
        originals.map((v) => v.id).sort(),
      );
      assert.deepEqual(delta.FactAssessmentConflict, [
        {
          customerId,
          projectId: c.projectId,
          factId: c.factId,
          assessmentId: header.id,
          conflictId: conflict.id,
        },
      ]);
      if (i >= 2) {
        assert.equal(time(conflict.detectedAt), time(header.asOf));
        assert.equal(conflict.policyRevisionId, header.policyRevisionId);
      }
    }
    const ids = [
      ...new Set(proof.result.conflicts.flatMap((g) => g.versionIds)),
    ].sort();
    const identity = negative
      ? null
      : JSON.stringify([
          "scalar-authority-conflict/v1",
          customerId,
          c.projectId,
          c.factId,
          header.policyRevisionId,
          ids.map((id) => {
            const v = one(c.after.ProjectFactVersion, id);
            return [id, v.sourceId, v.value.type, [v.evidenceId]];
          }),
        ]);
    assert.equal(c.tsIdentity, identity);
    assert.deepEqual(c.sql, { identity, proofValid: true, checkValid: true });
    assert.equal(check.assessmentId, header.id);
    assert.equal(check.requestId, result.request?.id ?? null);
    assert.equal(check.subject, c.actor.subject);
    assert.equal(check.idempotencyKey, c.command.idempotencyKey);
    assert.equal(check.requestHash, header.requestHash);
    assert.equal(check.outcome, result.outcome);
    assert.equal(time(check.occurredAt), time(header.asOf));
    const audit = one(delta.AuditEvent, check.auditEventId);
    assert.equal(audit.event, "scalar.reconciliation.checked");
    assert.deepEqual(audit.detail, {
      projectId: c.projectId,
      factId: c.factId,
      requestId: check.requestId,
      assessmentId: header.id,
      checkId: check.id,
      outcome: result.outcome,
    });
    for (const event of delta.AuditEvent.filter(
      (r) => r.id !== c.publication?.auditId,
    )) {
      assert.equal(event.actor, c.actor.subject);
      assert.equal(event.correlationId, c.context.correlationId);
      assert.equal(time(event.occurredAt), time(header.asOf));
    }
    if (negative) {
      assert.equal(result.request, null);
      assert.equal(c.original, null);
    } else {
      const request = one(
        c.after.ScalarReconciliationRequest,
        result.request.id,
      );
      assert.equal(request.contributorIdentity, identity);
      assert.equal(request.contributorHash, hash(identity));
      assert.equal(request.sealed, true);
      assert.equal(request.state, "OPEN");
      assert.equal(request.ruleRevision, "scalar-authority-conflict/v1");
      const assigned = c.after.ScalarReconciliationAssignment.find(
        (row) => row.requestId === request.id,
      );
      assert.deepEqual(result.request, {
        id: request.id,
        projectId: c.projectId,
        factId: c.factId,
        factType: "project.forecast",
        createdAt: new Date(time(request.createdAt)).toISOString(),
        state: "OPEN",
        assignment: {
          id: assigned.id,
          revision: 1,
          occurredAt: new Date(time(assigned.occurredAt)).toISOString(),
          reason: "ASSIGNED",
          recipientSubject: c.pm.subject,
        },
      });
      if (created) {
        assert.equal(request.originalAssessmentId, header.id);
        assert.equal(request.originCommandId, check.id);
        assert.equal(request.createdBy, c.actor.subject);
        assert.equal(time(request.createdAt), time(header.asOf));
        const assignment = delta.ScalarReconciliationAssignment[0];
        assert.equal(assignment.requestId, request.id);
        assert.equal(assignment.kind, "INITIAL");
        assert.equal(assignment.revision, 1);
        assert.equal(assignment.expectedRevision, 0);
        assert.equal(assignment.previousAssignmentId, null);
        assert.equal(assignment.reason, "ASSIGNED");
        assert.equal(assignment.recipientSubject, c.pm.subject);
        assert.equal(assignment.id, result.request.assignment.id);
        assert.equal(assignment.actor, c.actor.subject);
        assert.equal(assignment.idempotencyKey, null);
        assert.equal(assignment.requestHash, null);
        assert.equal(time(assignment.occurredAt), time(header.asOf));
        assert.equal(
          one(delta.AuditEvent, assignment.auditEventId).event,
          "scalar.reconciliation.assigned",
        );
        assert.deepEqual(
          one(delta.AuditEvent, assignment.auditEventId).detail,
          {
            projectId: c.projectId,
            factId: c.factId,
            requestId: request.id,
            assignmentId: assignment.id,
            revision: 1,
            reason: "ASSIGNED",
          },
        );
        assert.equal(
          one(delta.AuditEvent, request.auditEventId).event,
          "scalar.reconciliation.requested",
        );
        assert.deepEqual(one(delta.AuditEvent, request.auditEventId).detail, {
          projectId: c.projectId,
          factId: c.factId,
          requestId: request.id,
          assessmentId: header.id,
          checkId: check.id,
        });
      }
      assert.deepEqual(c.original, {
        request: result.request,
        assessment: i === 1 ? receipt.cases[0].result.assessment : proof,
      });
    }
    assert.deepEqual(c.replay, {
      ...result,
      replayed: true,
      assessment: { ...proof, replayed: true },
    });
    assert.deepEqual(c.afterReplay, c.after);
  }
  const [stale, superseded] = receipt.cases;
  assert.equal(stale.projectId, superseded.projectId);
  assert.deepEqual(superseded.setupBefore, stale.after);
  assert.equal(stale.tsIdentity, superseded.tsIdentity);
  assert.equal(stale.result.request.id, superseded.result.request.id);
  assert.notEqual(
    stale.result.assessment.assessmentId,
    superseded.result.assessment.assessmentId,
  );
  return true;
}
