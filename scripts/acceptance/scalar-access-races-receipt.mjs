// FR-EVD-009/012, NFR-SEC-001: closed, independently enumerated evidence contract.
import assert from "node:assert/strict";
import { assertRaceSnapshot } from "./reconciliation-races.mjs";
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
const controls = [
  "FactSourceAccess",
  "FactSourceReader",
  "AuthorityPolicy",
  "AuthorityPolicyRevision",
  "AuthorityPolicyReceipt",
  "AccessGrant",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function assertScalarSourceAccessTransition(
  before,
  after,
  sourceId,
  revision,
) {
  const selected = before.filter((a) => a.sourceId === sourceId);
  assert.equal(selected.length, 1);
  assert(Number.isSafeInteger(revision) && revision > selected[0].revision);
  const sort = (rows) =>
    [...rows].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  assert.deepEqual(
    sort(after),
    sort(before.map((a) => (a.sourceId === sourceId ? { ...a, revision } : a))),
  );
}
const value = (o) => {
  assert.equal(o.status, "fulfilled");
  return o.value;
};
const denied = (o) =>
  assert.deepEqual(o, { status: "rejected", code: "DENIED" });
const restricted = (a) => {
  assert.equal(a.visibility, "restricted");
  assert.equal(a.revalidationRequired, true);
  assert.equal(a.result, null);
};
function retained(before, after) {
  for (const row of before)
    assert(
      after.some((r) => JSON.stringify(r) === JSON.stringify(row)),
      "Retained row changed",
    );
}

export function assertScalarAccessRaces(receipt, customerId) {
  assert.equal(receipt.family, "scalar-access-races/v1");
  assert.equal(receipt.customerId, customerId);
  assert.equal(receipt.observer.role, "pdaa_api");
  assert.deepEqual(receipt.cases.map((c) => c.name).sort(), [
    "current-role-loss",
    "grant-first",
    "policy-first",
    "read-first",
    "source-first",
  ]);
  assert.equal(new Set(receipt.cases.map((c) => c.projectId)).size, 5);
  for (const c of receipt.cases)
    assertScalarAccessCase(c, customerId, receipt.observer.pid);
}

export function assertScalarAccessCase(c, customerId, observerPid) {
  const source = c.name === "source-first" || c.name === "read-first";
  const freshCase = c.name === "source-first" || c.name === "policy-first";
  const role = c.name === "current-role-loss";
  assert(
    [
      "source-first",
      "read-first",
      "grant-first",
      "policy-first",
      "current-role-loss",
    ].includes(c.name),
  );
  assert.match(c.projectId, uuid);
  assert.match(c.factId, uuid);
  assert.equal(c.actor.customerId, customerId);
  assert.equal(c.pm.customerId, customerId);
  assert.deepEqual(c.actor.roles, ["pmo_admin"]);
  assert.deepEqual(c.pm.roles, ["project_manager"]);
  assert.notEqual(c.actor.subject, c.pm.subject);
  assert.equal(c.command.projectId, c.projectId);
  assert.equal(c.command.factId, c.factId);
  const original = c.original,
    proofId = original.assessment.assessmentId,
    requestId = original.request.id;
  assert.equal(original.outcome, "CREATED");
  assert.equal(original.replayed, false);
  assertAvailableScalarOriginal(original.assessment, customerId, c.command);
  assertAvailableScalarOriginal(c.baseline.assessment, customerId, c.command);
  assert.equal(c.baseline.request.id, requestId);
  assert.equal(c.baseline.assessment.assessmentId, proofId);
  assert.deepEqual(c.baseline.assessment.result, original.assessment.result);
  for (const state of [c.before, c.after]) {
    assert.deepEqual(Object.keys(state).sort(), [...tables].sort());
    for (const table of tables) {
      assert(Array.isArray(state[table]) && state[table].length <= 5000);
      for (const r of state[table]) {
        assert.equal(r.customerId, customerId);
        assert.equal(
          table === "AuditEvent" ? r.detail.projectId : r.projectId,
          c.projectId,
        );
      }
    }
  }
  for (const state of [c.controlBefore, c.controlAfter]) {
    assert.deepEqual(Object.keys(state).sort(), [...controls].sort());
    for (const table of controls) {
      assert(Array.isArray(state[table]) && state[table].length <= 5000);
      for (const r of state[table]) {
        assert.equal(r.customerId, customerId);
        if (table !== "AccessGrant") assert.equal(r.projectId, c.projectId);
        else assert([c.actor.subject, c.pm.subject].includes(r.subject));
      }
    }
  }
  assert.equal(c.before.ScalarReconciliationRequest.length, 1);
  assert.equal(c.before.ScalarReconciliationCheck.length, 1);
  assert.equal(c.before.ScalarReconciliationAssignment.length, 1);
  assert.equal(c.before.FactAssessment.length, 1);
  assert.equal(c.before.FactAssessmentVersion.length, 2);
  assert.equal(c.before.FactAssessmentConflict.length, 1);
  assert.equal(c.before.FactAuthorityConflict.length, 1);
  const initial = c.before.ScalarReconciliationCheck[0],
    request = c.before.ScalarReconciliationRequest[0];
  assert.equal(initial.id, original.checkId);
  for (const row of [
    initial,
    request,
    c.before.ScalarReconciliationAssignment[0],
    c.before.FactAssessment[0],
  ])
    assert.equal(row.factId, c.factId);
  assert.equal(original.request.factId, c.factId);
  assert.equal(original.request.projectId, c.projectId);
  assert.equal(c.before.ScalarReconciliationAssignment[0].requestId, requestId);
  assert.equal(c.before.ScalarReconciliationAssignment[0].revision, 1);
  assert.equal(c.before.ScalarReconciliationAssignment[0].kind, "INITIAL");
  assert.equal(initial.assessmentId, proofId);
  assert.equal(initial.requestId, requestId);
  assert.equal(initial.subject, c.pm.subject);
  assert.equal(initial.idempotencyKey, c.command.idempotencyKey);
  assert.equal(request.id, requestId);
  assert.equal(request.originalAssessmentId, proofId);
  assert.equal(request.originCommandId, initial.id);
  assert.equal(request.state, "OPEN");
  assert.equal(request.sealed, true);
  assert.equal(
    c.before.ScalarReconciliationAssignment[0].id,
    original.request.assignment.id,
  );
  assert.equal(
    c.before.ScalarReconciliationAssignment[0].recipientSubject,
    c.pm.subject,
  );
  assert.equal(c.before.FactAssessment[0].id, proofId);
  assert.equal(
    c.before.FactAssessment[0].scalarReconciliationCheckId,
    initial.id,
  );
  assert.equal(c.before.FactAssessment[0].sealed, true);
  assert.deepEqual(
    c.before.FactAssessment[0].result,
    original.assessment.result,
  );
  assert.equal(c.dependencies.length, 2);
  assert.equal(new Set(c.dependencies.map((d) => d.versionId)).size, 2);
  for (const d of c.dependencies) {
    assert(
      c.before.FactAssessmentVersion.some(
        (v) => v.assessmentId === proofId && v.versionId === d.versionId,
      ),
    );
    const version = c.before.ProjectFactVersion.find(
      (v) => v.id === d.versionId,
    );
    assert.equal(version.factId, c.factId);
    assert.equal(version.sourceId, d.sourceId);
    assert.equal(version.evidenceId, d.evidenceId);
    assert(
      c.before.FactEvidence.some(
        (e) =>
          e.id === d.evidenceId &&
          e.sourceId === d.sourceId &&
          e.factId === c.factId,
      ),
    );
  }
  assert(
    c.dependencies.some(
      (d) => JSON.stringify(d) === JSON.stringify(c.selected),
    ),
  );
  const expected = {
    ScalarReconciliationCheck: freshCase ? 1 : 0,
    FactAssessment: freshCase ? 1 : 0,
    FactAssessmentVersion: freshCase ? 2 : 0,
    FactAssessmentConflict: freshCase ? 1 : 0,
    AuditEvent: c.name === "read-first" ? 1 : 2,
  };
  for (const table of tables) {
    assert.equal(
      c.after[table].length - c.before[table].length,
      expected[table] ?? 0,
      table,
    );
    retained(c.before[table], c.after[table]);
    if (!expected[table]) assert.deepEqual(c.after[table], c.before[table]);
  }
  const count = role ? 3 : c.name === "read-first" ? 2 : 4;
  assert.equal(c.participants.length, count);
  assert.equal(c.outcomes.length, count);
  assert.equal(new Set(c.participants.map((p) => p.correlationId)).size, count);
  if (!role)
    assertRaceSnapshot(
      c.blocked,
      c.participants[0],
      c.participants.slice(1),
      observerPid,
    );
  else assert.deepEqual(c.blocked, []);
  for (const p of c.participants) {
    assert.equal(p.actor.customerId, customerId);
    assert(Number.isInteger(p.pid) && p.pid > 0);
    assert.equal(typeof p.callbackReturned, "boolean");
    if (p.operation !== "revokeGrant")
      assert.equal(p.command.projectId, c.projectId);
  }
  const operations = role
    ? ["get", "check", "check"]
    : c.name === "read-first"
      ? ["get", "setSourceAccess"]
      : c.name === "grant-first"
        ? ["revokeGrant", "check", "check", "get"]
        : [
            c.name === "source-first" ? "setSourceAccess" : "appendPolicy",
            "get",
            "check",
            "check",
          ];
  assert.deepEqual(
    c.participants.map((p) => p.operation),
    operations,
  );
  const replayIndex = role || c.name === "grant-first" ? 1 : 2;
  const freshIndex = role || c.name === "grant-first" ? 2 : 3;
  if (c.name !== "read-first") {
    assert.deepEqual(c.participants[replayIndex].command, c.command);
    assert.deepEqual(c.participants[freshIndex].command, {
      ...c.command,
      idempotencyKey: c.participants[freshIndex].command.idempotencyKey,
    });
    assert.notEqual(
      c.participants[freshIndex].command.idempotencyKey,
      c.command.idempotencyKey,
    );
  }
  for (const p of c.participants.filter((p) =>
    ["check", "get"].includes(p.operation),
  )) {
    assert.deepEqual(p.actor, role ? { ...c.pm, roles: ["leadership"] } : c.pm);
    if (p.operation === "get")
      assert.deepEqual(p.command, { projectId: c.projectId, requestId });
  }
  function historical(v, hidden) {
    assert.equal(v.request.id, requestId);
    assert.equal(v.assessment.assessmentId, proofId);
    if (hidden) restricted(v.assessment);
    else {
      assertAvailableScalarOriginal(v.assessment, customerId, c.command);
      assert.deepEqual(v.assessment.result, original.assessment.result);
    }
  }
  if (freshCase) {
    historical(value(c.outcomes[1]), source);
    const replay = value(c.outcomes[2]),
      fresh = value(c.outcomes[3]);
    historical(replay, source);
    assert.equal(replay.replayed, true);
    assert.equal(replay.checkId, original.checkId);
    assert.equal(replay.outcome, "CREATED");
    assert.equal(fresh.outcome, "NO_REQUEST");
    assert.equal(fresh.request, null);
    assert.equal(fresh.replayed, false);
    assert.notEqual(fresh.checkId, original.checkId);
    assert.notEqual(fresh.assessment.assessmentId, proofId);
    const check = c.after.ScalarReconciliationCheck.find(
      (r) => r.id === fresh.checkId,
    );
    const proof = c.after.FactAssessment.find(
      (r) => r.id === fresh.assessment.assessmentId,
    );
    assert(check && proof);
    assert.equal(check.subject, c.pm.subject);
    assert.equal(
      check.idempotencyKey,
      c.participants[3].command.idempotencyKey,
    );
    assert.equal(check.assessmentId, proof.id);
    assert.equal(check.outcome, "NO_REQUEST");
    assert.equal(check.requestId, null);
    assert.equal(check.factId, c.factId);
    assert.equal(proof.factId, c.factId);
    assert.equal(proof.scalarReconciliationCheckId, check.id);
    assert.equal(proof.sealed, true);
    for (const table of ["FactAssessmentVersion", "FactAssessmentConflict"]) {
      const added = c.after[table].filter((r) => r.assessmentId !== proofId);
      const wanted = c.before[table].map((r) => {
        const next = { ...r, assessmentId: proof.id };
        if (table === "FactAssessmentVersion") {
          const dependency = c.dependencies.find(
            (d) => d.versionId === r.versionId,
          );
          next.sourceAccessRevision = c.controlAfter.FactSourceAccess.find(
            (a) => a.sourceId === dependency.sourceId,
          ).revision;
        }
        return next;
      });
      assert.equal(added.length, wanted.length);
      for (const row of wanted)
        assert(
          added.some((r) => JSON.stringify(r) === JSON.stringify(row)),
          "Wrong fresh proof dependency",
        );
    }
    assert.equal(proof.complete, true);
    assert.equal(proof.versionCount, 2);
    assert.equal(proof.conflictCount, 1);
    assert.equal(
      proof.result.status,
      source ? "REVALIDATION_REQUIRED" : "CONFLICTING",
    );
    if (source) restricted(fresh.assessment);
    else {
      assert.equal(fresh.assessment.visibility, "available");
      assert.equal(fresh.assessment.revalidationRequired, false);
      assert.deepEqual(fresh.assessment.result, proof.result);
      assert.equal(proof.result.reconciliationRequired, false);
      assert.equal(proof.policyRevisionId, value(c.outcomes[0]).event.id);
      assert.equal(proof.result.policy.conflictBehavior, "RETAIN_CONFLICT");
    }
  } else if (c.name === "read-first") historical(value(c.outcomes[0]), false);
  else {
    denied(c.outcomes[1]);
    denied(c.outcomes[2]);
    assert.equal(value(c.outcomes[role ? 0 : 3]), null);
  }
  if (c.name === "grant-first") assert.equal(c.finalDetail, null);
  else historical(c.finalDetail, source);

  for (const table of controls) {
    if (source && ["FactSourceAccess", "FactSourceReader"].includes(table))
      continue;
    if (c.name === "grant-first" && table === "AccessGrant") continue;
    if (c.name === "policy-first" && table.startsWith("AuthorityPolicy"))
      continue;
    assert.deepEqual(c.controlAfter[table], c.controlBefore[table]);
  }
  if (source) {
    const index = c.name === "read-first" ? 1 : 0,
      p = c.participants[index];
    assert.deepEqual(p.actor, c.actor);
    const old = c.controlBefore.FactSourceAccess.find(
      (a) => a.sourceId === c.selected.sourceId,
    );
    const write = value(c.outcomes[index]);
    assert.deepEqual(p.command, {
      projectId: c.projectId,
      sourceId: old.sourceId,
      expectedRevision: old.revision,
      state: "AVAILABLE",
      readers: [c.actor.subject],
    });
    assert.equal(write.sourceId, old.sourceId);
    assert(write.revision > old.revision);
    assertScalarSourceAccessTransition(
      c.controlBefore.FactSourceAccess,
      c.controlAfter.FactSourceAccess,
      old.sourceId,
      write.revision,
    );
    const readers = c.controlBefore.FactSourceReader.filter(
      (r) => r.sourceId === old.sourceId,
    );
    assert.deepEqual(
      readers.map((r) => r.subject).sort(),
      [c.actor.subject, c.pm.subject].sort(),
    );
    assert.deepEqual(
      c.controlAfter.FactSourceReader,
      c.controlBefore.FactSourceReader.filter(
        (r) => !(r.sourceId === old.sourceId && r.subject === c.pm.subject),
      ),
    );
  }
  if (c.name === "grant-first") {
    const p = c.participants[0];
    assert.deepEqual(p.actor, c.actor);
    assert.deepEqual(p.command, {
      subject: c.pm.subject,
      scopeType: "project",
      scopeId: c.projectId,
    });
    assert.equal(value(c.outcomes[0]), null);
    const grants = c.controlBefore.AccessGrant.filter(
      (g) => g.subject === c.pm.subject,
    );
    assert.equal(grants.length, 1);
    assert.equal(grants[0].role, "project_manager");
    assert.equal(grants[0].scopeType, "project");
    assert.equal(grants[0].scopeId, c.projectId);
    assert.deepEqual(
      c.controlAfter.AccessGrant,
      c.controlBefore.AccessGrant.filter((g) => g.subject !== c.pm.subject),
    );
  }
  if (c.name === "policy-first") {
    const p = c.participants[0],
      event = value(c.outcomes[0]).event;
    assert.deepEqual(p.actor, c.actor);
    assert.equal(p.command.expectedRevision, 1);
    assert.equal(p.command.factType, c.before.ProjectFact[0].factType);
    assert.equal(p.command.definition.conflictBehavior, "RETAIN_CONFLICT");
    assert.equal(c.controlBefore.AuthorityPolicy.length, 1);
    assert.deepEqual(
      c.controlAfter.AuthorityPolicy,
      c.controlBefore.AuthorityPolicy.map((r) => ({ ...r, revision: 2 })),
    );
    for (const table of ["AuthorityPolicyRevision", "AuthorityPolicyReceipt"]) {
      assert.equal(
        c.controlAfter[table].length,
        c.controlBefore[table].length + 1,
      );
      retained(c.controlBefore[table], c.controlAfter[table]);
    }
    const stored = c.controlAfter.AuthorityPolicyRevision.find(
      (r) => r.id === event.id,
    );
    assert.equal(stored.revision, 2);
    assert.equal(stored.state, "ENABLED");
    assert.deepEqual(stored.definition, p.command.definition);
    assert(
      c.controlAfter.AuthorityPolicyReceipt.some(
        (r) =>
          r.revisionId === event.id &&
          r.idempotencyKey === p.command.idempotencyKey &&
          r.subject === c.actor.subject,
      ),
    );
  }
  const expectedEvents = operations.map((op) =>
    op === "get"
      ? []
      : op === "setSourceAccess"
        ? ["fact.source_access.changed"]
        : op === "revokeGrant"
          ? ["access.revoked"]
          : op === "appendPolicy"
            ? ["authority.policy.appended"]
            : role || c.name === "grant-first"
              ? ["scalar.reconciliation.check.denied"]
              : [],
  );
  if (freshCase) expectedEvents[3] = ["scalar.reconciliation.checked"];
  assert.equal(c.audits.length, expectedEvents.flat().length);
  for (const [index, p] of c.participants.entries()) {
    const audits = c.audits.filter((a) => a.correlationId === p.correlationId);
    assert.deepEqual(
      audits.map((a) => a.event),
      expectedEvents[index],
    );
    for (const a of audits) {
      assert.equal(a.customerId, customerId);
      assert.equal(a.actor, p.actor.subject);
      if (a.event.endsWith("check.denied"))
        assert.deepEqual(a.detail, {
          projectId: c.projectId,
          reason: "DENIED",
        });
      else if (a.event === "access.revoked")
        assert.deepEqual(a.detail, p.command);
      else if (a.event === "scalar.reconciliation.checked") {
        const check = c.after.ScalarReconciliationCheck.find(
          (r) => r.id === value(c.outcomes[index]).checkId,
        );
        assert.equal(a.id, check.auditEventId);
        assert.deepEqual(a.detail, {
          projectId: c.projectId,
          factId: c.factId,
          checkId: check.id,
          assessmentId: check.assessmentId,
          requestId: null,
          outcome: "NO_REQUEST",
        });
      } else if (a.event === "fact.source_access.changed") {
        const old = c.controlBefore.FactSourceAccess.find(
          (r) => r.sourceId === p.command.sourceId,
        );
        assert.deepEqual(a.detail, {
          projectId: c.projectId,
          sourceId: old.sourceId,
          previousRevision: old.revision,
          revision: value(c.outcomes[index]).revision,
          previousState: old.state,
          state: p.command.state,
          previousReaders: c.controlBefore.FactSourceReader.filter(
            (r) => r.sourceId === old.sourceId,
          )
            .map((r) => r.subject)
            .sort(),
          readers: [...p.command.readers].sort(),
        });
      } else if (a.event === "authority.policy.appended") {
        const event = value(c.outcomes[index]).event;
        const stored = c.controlAfter.AuthorityPolicyRevision.find(
          (r) => r.id === event.id,
        );
        assert.deepEqual(a.detail, {
          projectId: c.projectId,
          policyId: stored.policyId,
          revisionId: stored.id,
          revision: stored.revision,
        });
      } else assert.fail("Unexpected scalar access audit");
    }
  }
  const newAudits = c.after.AuditEvent.filter(
    (a) => !c.before.AuditEvent.some((b) => b.id === a.id),
  );
  assert.deepEqual(
    newAudits.sort((a, b) => a.id.localeCompare(b.id)),
    c.audits
      .filter((a) => a.detail.projectId === c.projectId)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
