// FR-EVD-009/012, NFR-REL-001: independent closed scalar seal evidence reader.
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
  "positive-full-seal",
  "coherent-wrong-identity",
  "missing-initial-assignment-seal",
  "missing-version-dependency",
  "coherent-missing-version",
  "coherent-missing-evidence",
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const sorted = (rows) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const asTime = (value) =>
  Date.parse(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
export function assertScalarSealPhase(c) {
  assert(modes.includes(c.name));
  const positive = c.name === "positive-full-seal";
  assert.equal(c.role, "pdaa_api");
  assert.equal(c.sessionUser, "pdaa_api");
  assert(Number.isInteger(c.pid) && c.pid > 0);
  assert.equal(c.forcedConstraints, 0);
  assert.equal(c.callbackReturned, positive);
  assert.equal(c.rejected, !positive);
  assert.equal(c.transactionRejected, !positive);
  assert.equal(c.nativeCommitAttempts, positive ? 1 : 0);
  assert.notEqual(c.unsupportedTransport, true);
  assert.deepEqual(c.options, {
    isolationLevel: "ReadCommitted",
    maxWait: 5000,
    timeout: 10000,
  });
  const request =
    positive ||
    ["coherent-wrong-identity", "missing-initial-assignment-seal"].includes(
      c.name,
    );
  assert.deepEqual(
    c.sealStatements.map((row) => row.table),
    request
      ? ["FactAssessment", "ScalarReconciliationRequest"]
      : ["FactAssessment"],
  );
  for (const [index, entry] of c.sealStatements.entries()) {
    assert.equal(entry.pid, c.pid);
    assert.match(
      entry.sql,
      new RegExp(
        '^\\s*UPDATE\\s+(?:"public"\\.)?"' +
          entry.table +
          '"\\s+SET\\s+"sealed"\\s*=',
        "i",
      ),
    );
    assert.match(entry.sql, /SET\s+"sealed"\s*=\s*\$1\s+WHERE\b/i);
    assert.deepEqual(entry.values, [
      true,
      entry.table === "FactAssessment" ? c.assessmentId : c.requestId,
    ]);
    if (positive || index < c.sealStatements.length - 1) {
      assert.equal(entry.command, "UPDATE");
      assert.equal(entry.error, undefined);
    } else {
      assert.equal(entry.command, undefined);
      assert.deepEqual(entry.error, {
        code: "P0001",
        message: request
          ? "Invalid scalar reconciliation request seal"
          : "Invalid assessment seal",
      });
    }
  }
  assert.equal(c.rollbackError, undefined);
  if (positive) {
    assert.equal(c.returnedOutcome, "CREATED");
    assert.equal(c.nativeCommand, "COMMIT");
    assert.equal(c.nativePid, c.pid);
    assert.equal(c.callbackReturnedAtCommit, true);
    assert.equal(c.native, undefined);
    assert.equal(c.rollbackCommand, undefined);
    const o = c.commitObserver;
    assert(
      Number.isInteger(o.observerPid) &&
        o.observerPid > 0 &&
        o.observerPid !== c.pid,
    );
    assert.equal(o.writerPid, c.pid);
    assert.equal(o.sessionUser, "pdaa_api");
    assert.equal(o.state, "idle");
    assert.equal(o.phase, "native-commit-settled");
    assert.match(o.query, /^\s*COMMIT\s*;?\s*$/i);
  } else {
    assert.equal(c.rollbackCommand, "ROLLBACK");
    assert.equal(c.returnedOutcome, undefined);
    for (const field of [
      "native",
      "nativeCommand",
      "nativePid",
      "callbackReturnedAtCommit",
      "commitObserver",
      "pending",
    ])
      assert.equal(c[field], undefined);
  }
}
function identityOf(proof) {
  const result = proof.result;
  const ids = [
    ...new Set(result.conflicts.flatMap((group) => group.versionIds)),
  ].sort();
  assert(ids.length > 1);
  return JSON.stringify([
    "scalar-authority-conflict/v1",
    proof.customerId,
    proof.projectId,
    proof.factId,
    proof.policyRevisionId,
    ids.map((id) => {
      const version = result.versions.find((row) => row.id === id);
      assert(version && version.visibility === "available");
      return [
        id,
        version.source.instanceId,
        version.value.type,
        [...new Set(version.evidenceIds)].sort(),
      ];
    }),
  ]);
}
export function assertScalarSealReceipt(receipt, customerId) {
  assert.equal(receipt.family, "scalar-seals/v1");
  assert.equal(receipt.customerId, customerId);
  assert.deepEqual(
    receipt.cases.map((c) => c.name),
    modes,
  );
  assert.equal(
    new Set(receipt.cases.map((c) => c.projectId)).size,
    modes.length,
  );
  for (const c of receipt.cases) {
    assertScalarSealPhase(c);
    assert.equal(c.customerId, customerId);
    assert.match(c.projectId, uuid);
    assert.match(c.factId, uuid);
    const positive = c.name === "positive-full-seal";
    const snapshots = [
      c.before,
      c.after,
      ...c.preSeals.map((seal) => seal.state),
      ...(positive ? [c.pending] : []),
    ];
    for (const seal of c.preSeals) {
      const requestStage = seal.table === "ScalarReconciliationRequest";
      const counts = {
        ScalarReconciliationRequest: requestStage ? 1 : 0,
        ScalarReconciliationCheck: requestStage ? 1 : 0,
        ScalarReconciliationAssignment:
          requestStage && c.name !== "missing-initial-assignment-seal" ? 1 : 0,
        FactAssessment: 1,
        FactAssessmentVersion: [
          "missing-version-dependency",
          "coherent-missing-version",
        ].includes(c.name)
          ? 1
          : 2,
        FactAssessmentConflict: 1,
        FactAuthorityConflict: 1,
        AuditEvent: requestStage ? 3 : 0,
        ProjectFact: 0,
        ProjectFactVersion: 0,
        FactEvidence: 0,
      };
      for (const table of tables) {
        assert.equal(
          seal.state[table].length - c.before[table].length,
          counts[table],
        );
        for (const old of c.before[table])
          assert(
            seal.state[table].some(
              (row) => JSON.stringify(row) === JSON.stringify(old),
            ),
          );
        if (counts[table] === 0)
          assert.deepEqual(seal.state[table], c.before[table]);
      }
    }
    for (const state of snapshots) {
      assert.deepEqual(Object.keys(state).sort(), [...tables].sort());
      for (const table of tables) {
        assert(state[table].length <= 5000);
        for (const row of state[table]) {
          assert.equal(row.customerId, customerId);
          assert.equal(
            table === "AuditEvent" ? row.detail.projectId : row.projectId,
            c.projectId,
          );
        }
      }
    }
    assert.deepEqual(
      c.preSeals.map((s) => s.table),
      c.sealStatements.map((s) => s.table),
    );
    const pre = c.preSeals[0].state;
    const proof = pre.FactAssessment.find((row) => row.id === c.assessmentId);
    assert(
      proof && proof.sealed === false && proof.captureKind === "SCALAR_REQUEST",
    );
    assert.equal(c.preSeals[0].id, c.assessmentId);
    assert.equal(proof.factId, c.factId);
    const original = c.originalHeader;
    assert.equal(original.id, proof.id);
    assert.equal(original.subject, c.actor);
    assert.equal(original.customerId, customerId);
    assert.equal(original.projectId, c.projectId);
    assert.equal(original.factId, c.factId);
    assert.equal(original.captureKind, "SCALAR_REQUEST");
    assert.equal(original.milestoneAssessmentId, null);
    assert.match(original.scalarReconciliationCheckId, uuid);
    assert.deepEqual(c.command, {
      projectId: c.projectId,
      factId: c.factId,
      idempotencyKey: c.command.idempotencyKey,
    });
    assert.match(c.command.idempotencyKey, uuid);
    const commandHash = digest(
      JSON.stringify({ projectId: c.projectId, factId: c.factId }),
    );
    assert.equal(original.requestHash, commandHash);
    assert.equal(
      original.idempotencyKey,
      "sr_" + original.scalarReconciliationCheckId.replaceAll("-", ""),
    );
    for (const field of [
      "subject",
      "idempotencyKey",
      "requestHash",
      "captureKind",
      "scalarReconciliationCheckId",
      "milestoneAssessmentId",
      "factRevision",
      "policyId",
      "policyThroughRevision",
      "policyRevisionId",
      "complete",
      "conflictCount",
      "conflictThroughRevision",
    ])
      assert.deepEqual(proof[field], original[field]);
    assert.equal(asTime(proof.asOf), asTime(original.asOf));
    const originals = c.before.ProjectFactVersion.filter(
      (row) => row.factId === c.factId && row.revision <= original.factRevision,
    );
    assert.equal(original.versionCount, originals.length);
    assert(originals.length >= 2);
    assert.deepEqual(
      original.result.versions.map((row) => row.id).sort(),
      originals.map((row) => row.id).sort(),
    );
    for (const version of original.result.versions) {
      const stored = originals.find((row) => row.id === version.id);
      assert.deepEqual(version.source, {
        instanceId: stored.sourceId,
        recordType: "human_statement",
        recordId: stored.sourceId,
        revision: stored.evidenceId,
      });
      assert.deepEqual(version.value, stored.value);
      assert.deepEqual(version.evidenceIds, [stored.evidenceId]);
      assert(
        c.before.FactEvidence.some(
          (row) =>
            row.id === stored.evidenceId && row.sourceId === stored.sourceId,
        ),
      );
    }
    assert.equal(original.result.complete, true);
    assert.equal(original.result.status, "CONFLICTING");
    assert.equal(original.result.reconciliationRequired, true);
    assert.equal(original.result.revalidationRequired, false);
    for (const group of original.result.conflicts)
      assert.deepEqual(
        group.evidenceIds,
        [
          ...new Set(
            group.versionIds.flatMap(
              (id) =>
                original.result.versions.find((row) => row.id === id)
                  .evidenceIds,
            ),
          ),
        ].sort(),
      );
    const expectedResult = clone(original.result);
    let expectedCount = original.versionCount;
    if (c.name === "coherent-missing-version") {
      expectedResult.versions = expectedResult.versions.filter(
        (row) => row.id !== c.omittedVersionId,
      );
      expectedCount--;
    }
    if (c.name === "coherent-missing-evidence") {
      const version = expectedResult.versions.find(
        (row) => row.id === c.omittedVersionId,
      );
      assert(version && version.evidenceIds.length);
      assert.deepEqual(c.omittedEvidenceIds, version.evidenceIds);
      version.evidenceIds = [];
      for (const group of expectedResult.conflicts)
        group.evidenceIds = [
          ...new Set(
            group.versionIds.flatMap(
              (id) =>
                expectedResult.versions.find((row) => row.id === id)
                  .evidenceIds,
            ),
          ),
        ].sort();
    }
    assert.deepEqual(proof.result, expectedResult);
    assert.equal(proof.versionCount, expectedCount);
    assert.deepEqual(
      { ...proof, asOf: asTime(proof.asOf) },
      {
        ...original,
        evaluatorVersion: 1,
        sealed: false,
        asOf: asTime(original.asOf),
        result: expectedResult,
        versionCount: expectedCount,
      },
    );
    assert.deepEqual(
      c.originalDependencies.map((row) => row.versionId).sort(),
      originals.map((row) => row.id).sort(),
    );
    const omitted = [
      "missing-version-dependency",
      "coherent-missing-version",
    ].includes(c.name);
    if (omitted) assert(originals.some((row) => row.id === c.omittedVersionId));
    const expectedDependencies = c.originalDependencies.filter(
      (row) => !omitted || row.versionId !== c.omittedVersionId,
    );
    assert.deepEqual(
      sorted(
        pre.FactAssessmentVersion.filter(
          (row) => row.assessmentId === proof.id,
        ),
      ),
      sorted(expectedDependencies),
    );
    for (const dep of c.originalDependencies) {
      assert.equal(dep.assessmentId, proof.id);
      assert.equal(dep.customerId, customerId);
      assert.equal(dep.projectId, c.projectId);
      assert.equal(dep.factId, c.factId);
    }
    const conflicts = pre.FactAuthorityConflict.filter(
      (row) =>
        row.factId === c.factId &&
        row.revision <= proof.conflictThroughRevision,
    );
    assert.equal(proof.conflictCount, conflicts.length);
    assert.deepEqual(
      pre.FactAssessmentConflict.filter((row) => row.assessmentId === proof.id)
        .map((row) => row.conflictId)
        .sort(),
      conflicts.map((row) => row.id).sort(),
    );
    for (const dep of pre.FactAssessmentConflict.filter(
      (row) => row.assessmentId === proof.id,
    )) {
      assert.equal(dep.customerId, customerId);
      assert.equal(dep.projectId, c.projectId);
      assert.equal(dep.factId, c.factId);
    }
    for (const row of conflicts) {
      assert(originals.some((v) => v.id === row.leftVersionId));
      assert(originals.some((v) => v.id === row.rightVersionId));
    }
    if (c.preSeals.length === 2) {
      const graph = c.preSeals[1].state;
      const request = graph.ScalarReconciliationRequest.find(
        (row) => row.id === c.requestId,
      );
      assert(request && !request.sealed);
      assert.equal(c.preSeals[1].id, request.id);
      const sealedProof = graph.FactAssessment.find(
        (row) => row.id === proof.id,
      );
      assert.deepEqual(sealedProof, { ...proof, sealed: true });
      const identity = identityOf(sealedProof);
      assert.equal(c.originalRequest.contributorIdentity, identity);
      assert.equal(c.originalRequest.contributorHash, digest(identity));
      let expectedIdentity = identity;
      if (c.name === "coherent-wrong-identity") {
        assert.match(c.changedSourceId, uuid);
        const changed = JSON.parse(identity);
        assert.notEqual(c.changedSourceId, changed[5][0][1]);
        changed[5][0][1] = c.changedSourceId;
        expectedIdentity = JSON.stringify(changed);
      }
      assert.equal(request.contributorIdentity, expectedIdentity);
      assert.equal(request.contributorHash, digest(expectedIdentity));
      assert.deepEqual(
        { ...request, createdAt: asTime(request.createdAt) },
        {
          ...c.originalRequest,
          createdAt: asTime(c.originalRequest.createdAt),
          state: "OPEN",
          sealed: false,
          contributorIdentity: expectedIdentity,
          contributorHash: digest(expectedIdentity),
        },
      );
      assert.equal(request.originalAssessmentId, proof.id);
      assert.equal(request.originCommandId, proof.scalarReconciliationCheckId);
      for (const field of [
        "id",
        "customerId",
        "projectId",
        "factId",
        "ruleRevision",
        "originalAssessmentId",
        "originCommandId",
        "createdBy",
        "auditEventId",
      ])
        assert.equal(request[field], c.originalRequest[field]);
      assert.equal(request.createdBy, c.actor);
      assert.equal(asTime(request.createdAt), asTime(proof.asOf));
      assert.equal(
        asTime(request.createdAt),
        asTime(c.originalRequest.createdAt),
      );
      const check = graph.ScalarReconciliationCheck.find(
        (row) => row.id === request.originCommandId,
      );
      assert(
        check &&
          check.requestId === request.id &&
          check.assessmentId === proof.id &&
          check.outcome === "CREATED",
      );
      assert.equal(check.subject, c.actor);
      assert.equal(check.customerId, customerId);
      assert.equal(check.projectId, c.projectId);
      assert.equal(check.factId, c.factId);
      assert.equal(check.requestHash, commandHash);
      assert.equal(check.idempotencyKey, c.command.idempotencyKey);
      assert.equal(asTime(check.occurredAt), asTime(proof.asOf));
      const assignments = graph.ScalarReconciliationAssignment.filter(
        (row) => row.requestId === request.id,
      );
      assert.equal(
        assignments.length,
        c.name === "missing-initial-assignment-seal" ? 0 : 1,
      );
      if (assignments.length) {
        assert.equal(assignments[0].kind, "INITIAL");
        assert.equal(assignments[0].revision, 1);
      } else
        assert(
          c.omittedAssignment &&
            c.omittedAssignment.requestId === request.id &&
            c.omittedAssignment.kind === "INITIAL",
        );
      const audits = graph.AuditEvent.filter(
        (row) => row.correlationId === c.correlationId,
      );
      assert.equal(audits.length, 3);
      for (const event of audits) {
        assert.equal(event.actor, c.actor);
        assert.equal(asTime(event.occurredAt), asTime(proof.asOf));
      }
      assert.deepEqual(
        audits.find((row) => row.id === request.auditEventId)?.detail,
        {
          projectId: c.projectId,
          factId: c.factId,
          requestId: request.id,
          assessmentId: proof.id,
          checkId: check.id,
        },
      );
      assert.equal(
        audits.find((row) => row.id === request.auditEventId)?.event,
        "scalar.reconciliation.requested",
      );
      assert.deepEqual(
        audits.find((row) => row.id === check.auditEventId)?.detail,
        {
          projectId: c.projectId,
          factId: c.factId,
          requestId: request.id,
          assessmentId: proof.id,
          checkId: check.id,
          outcome: "CREATED",
        },
      );
      assert.equal(
        audits.find((row) => row.id === check.auditEventId)?.event,
        "scalar.reconciliation.checked",
      );
      const assignment = assignments[0] ?? c.omittedAssignment;
      assert.equal(assignment.customerId, customerId);
      assert.equal(assignment.projectId, c.projectId);
      assert.equal(assignment.factId, c.factId);
      assert.equal(assignment.requestId, request.id);
      assert.equal(assignment.actor, c.actor);
      assert.equal(asTime(assignment.occurredAt), asTime(proof.asOf));
      assert.equal(assignment.expectedRevision, 0);
      assert.equal(assignment.previousAssignmentId, null);
      assert.equal(assignment.idempotencyKey, null);
      assert.equal(assignment.requestHash, null);
      assert.deepEqual(
        audits.find((row) => row.id === assignment.auditEventId)?.detail,
        {
          projectId: c.projectId,
          factId: c.factId,
          requestId: request.id,
          assignmentId: assignment.id,
          revision: 1,
          reason: assignment.reason,
        },
      );
      assert.equal(
        audits.find((row) => row.id === assignment.auditEventId)?.event,
        "scalar.reconciliation.assigned",
      );
    }
    const oldIds = new Set(
        tables.flatMap((table) =>
          c.before[table].map((row) => row.id).filter(Boolean),
        ),
      ),
      ids = new Set();
    for (const p of c.proposals)
      for (const row of Array.isArray(p.data) ? p.data : [p.data])
        for (const key of [
          "id",
          "assessmentId",
          "scalarReconciliationCheckId",
          "auditEventId",
        ])
          if (row[key] && !oldIds.has(row[key])) ids.add(row[key]);
    assert.deepEqual(c.generatedIds, [...ids].sort());
    assert(c.generatedIds.includes(proof.id));
    assert(c.generatedIds.includes(proof.scalarReconciliationCheckId));
    // Independent SQL graph membership closes the proposal-omission loophole.
    for (const state of [
      ...c.preSeals.map((seal) => seal.state),
      ...(positive ? [c.pending] : []),
    ])
      for (const table of tables)
        for (const row of state[table]) {
          const old = c.before[table].some(
            (retained) => JSON.stringify(retained) === JSON.stringify(row),
          );
          if (!old)
            for (const key of [
              "id",
              "assessmentId",
              "scalarReconciliationCheckId",
              "auditEventId",
            ])
              if (row[key] && !oldIds.has(row[key]))
                assert(
                  c.generatedIds.includes(row[key]),
                  "Generated SQL row omitted from rollback inventory",
                );
        }
    if (c.omittedAssignment)
      for (const key of ["id", "auditEventId"])
        assert(c.generatedIds.includes(c.omittedAssignment[key]));
    for (const id of c.generatedIds) assert.match(id, uuid);
    if (positive) {
      assert.deepEqual(c.after, c.pending);
      const priorSeal = c.preSeals[1].state;
      assert.deepEqual(c.pending, {
        ...priorSeal,
        ScalarReconciliationRequest: priorSeal.ScalarReconciliationRequest.map(
          (row) => (row.id === c.requestId ? { ...row, sealed: true } : row),
        ),
      });
      assert.deepEqual(c.generatedAbsence, {});
      for (const table of tables)
        for (const old of c.before[table])
          assert(
            c.after[table].some(
              (row) => JSON.stringify(row) === JSON.stringify(old),
            ),
          );
      assert.equal(
        c.after.ScalarReconciliationRequest.find(
          (row) => row.id === c.requestId,
        )?.sealed,
        true,
      );
      assert.equal(c.auditAfter.length, 3);
    } else {
      assert.deepEqual(c.after, c.before);
      assert.deepEqual(c.auditAfter, []);
      assert.deepEqual(
        c.generatedAbsence,
        Object.fromEntries(tables.map((table) => [table, 0])),
      );
    }
  }
}
