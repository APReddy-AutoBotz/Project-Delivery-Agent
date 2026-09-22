// FR-EVD-004/007/009/012: synthetic unit receipts, not native execution.
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { assertScalarConflictPrefix } from "../scripts/acceptance/scalar-conflict-prefix-receipt.mjs";

function fixture() {
  let next = 1;
  const id = () =>
    "00000000-0000-4000-8000-" + (next++).toString(16).padStart(12, "0");
  const customerId = id(),
    projectId = id(),
    factId = id(),
    policyId = id(),
    policyRevisionId = id();
  const factType = "project.forecast",
    scope = { customerId, projectId, factId };
  const actor = { customerId, subject: "synthetic-pmo", roles: ["pmo_admin"] };
  const pm = {
    customerId,
    subject: "synthetic-pm",
    roles: ["project_manager"],
  };
  const oldAt = "2026-09-14T00:00:01.000Z",
    seededAt = "2026-09-14T00:00:02.000Z";
  const newAt = "2026-09-14T00:00:03.000Z",
    sourceIds = [id(), id()];
  const versions = Array.from({ length: 64 }, (_, i) => ({
    ...scope,
    id: id(),
    evidenceId: id(),
    sourceId: sourceIds[i === 1 ? 1 : 0]!,
    revision: i + 1,
    provenance: "HUMAN_CONFIRMED",
    effectiveAt: "2026-09-14T00:00:00.000Z",
    validUntil: "2026-09-15T00:00:00.000Z",
    value: { type: "date", value: "2026-10-0" + ((i % 4) + 1) },
  }));
  const evidence = versions.map((v, i) => ({
    ...scope,
    id: v.evidenceId,
    sourceId: v.sourceId,
    providedBy: i === 1 ? pm.subject : actor.subject,
    observedAt: i < 2 ? oldAt : seededAt,
    originalStatement: "Synthetic prefix evidence " + i,
  }));
  const conflicts: {
    id: string;
    customerId: string;
    projectId: string;
    factId: string;
    factType: string;
    revision: number;
    policyRevisionId: string;
    detectedAt: string;
    leftVersionId: string;
    rightVersionId: string;
  }[] = [];
  for (const left of versions)
    for (const right of versions)
      if (
        left.id < right.id &&
        left.value.value !== right.value.value &&
        conflicts.length < 1002
      )
        conflicts.push({
          ...scope,
          id: id(),
          factType,
          revision: conflicts.length + 1,
          policyRevisionId,
          detectedAt: conflicts.length === 0 ? oldAt : seededAt,
          leftVersionId: left.id,
          rightVersionId: right.id,
        });
  const highestId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  conflicts[1001]!.id = highestId;
  const command = { projectId, factId, idempotencyKey: id() };
  const freshCommand = { ...command, idempotencyKey: id() };
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ projectId, factId }))
    .digest("hex");
  const oldCheckId = id(),
    oldProofId = id(),
    requestId = id(),
    assignmentId = id();
  const checkId = id(),
    proofId = id();
  const correlationIds = Array.from({ length: 5 }, id);
  const policy = {
    customerId,
    projectId,
    factType,
    revisionId: policyRevisionId,
    conflictBehavior: "REQUEST_RECONCILIATION",
  };
  const result = {
    scope: { ...scope, factType },
    asOf: oldAt,
    mode: "HISTORICAL",
    policy,
    complete: true,
    status: "CONFLICTING",
    revalidationRequired: false,
    reconciliationRequired: true,
    resolvedValue: null,
    candidateVersionIds: [],
    supportingVersionIds: [],
    supportingEvidenceIds: [],
    versions: versions.slice(0, 2).map((v) => ({
      id: v.id,
      source: { instanceId: v.sourceId },
      value: v.value,
      evidenceIds: [v.evidenceId],
    })),
    conflicts: [
      {
        versionIds: versions.slice(0, 2).map((v) => v.id),
        evidenceIds: versions.slice(0, 2).map((v) => v.evidenceId),
      },
    ],
  };
  const incomplete = {
    ...result,
    asOf: newAt,
    complete: false,
    status: "INCOMPLETE",
    reconciliationRequired: false,
    versions: [],
    conflicts: [],
  };
  const oldProof = {
    ...scope,
    id: oldProofId,
    factType,
    factRevision: 2,
    policyId,
    policyRevisionId,
    policyThroughRevision: 1,
    asOf: oldAt,
    subject: pm.subject,
    idempotencyKey: "sr_" + oldCheckId.replaceAll("-", ""),
    requestHash,
    captureKind: "SCALAR_REQUEST",
    milestoneAssessmentId: null,
    scalarReconciliationCheckId: oldCheckId,
    complete: true,
    versionCount: 2,
    conflictCount: 1,
    conflictThroughRevision: 1,
    result,
    sealed: true,
  };
  const proof = {
    ...oldProof,
    id: proofId,
    factRevision: 64,
    asOf: newAt,
    idempotencyKey: "sr_" + checkId.replaceAll("-", ""),
    scalarReconciliationCheckId: checkId,
    complete: false,
    versionCount: 0,
    conflictCount: 0,
    conflictThroughRevision: 1002,
    result: incomplete,
  };
  const oldCheck = {
    ...scope,
    id: oldCheckId,
    subject: pm.subject,
    idempotencyKey: command.idempotencyKey,
    requestHash,
    assessmentId: oldProofId,
    requestId,
    outcome: "CREATED",
    occurredAt: oldAt,
    auditEventId: id(),
  };
  const check = {
    ...oldCheck,
    id: checkId,
    idempotencyKey: freshCommand.idempotencyKey,
    assessmentId: proofId,
    requestId: null,
    outcome: "NO_REQUEST",
    occurredAt: newAt,
    auditEventId: id(),
  };
  const request = {
    ...scope,
    id: requestId,
    originalAssessmentId: oldProofId,
    originCommandId: oldCheckId,
    state: "OPEN",
    sealed: true,
    auditEventId: id(),
  };
  const assignment = {
    ...scope,
    id: assignmentId,
    requestId,
    kind: "INITIAL",
    revision: 1,
    reason: "ASSIGNED",
    recipientSubject: pm.subject,
    auditEventId: id(),
  };
  const audit = (
    auditId: string,
    event: string,
    detail: unknown,
    overflow = false,
  ) => ({
    id: auditId,
    customerId,
    actor: pm.subject,
    event,
    detail,
    correlationId: correlationIds[overflow ? 2 : 0]!,
    occurredAt: overflow ? newAt : oldAt,
  });
  const oldAudits = [
    audit(oldCheck.auditEventId, "scalar.reconciliation.checked", {
      projectId,
      factId,
      checkId: oldCheckId,
      assessmentId: oldProofId,
      requestId,
      outcome: "CREATED",
    }),
    audit(request.auditEventId, "scalar.reconciliation.requested", {
      projectId,
      factId,
      requestId,
      assessmentId: oldProofId,
      checkId: oldCheckId,
    }),
    audit(assignment.auditEventId, "scalar.reconciliation.assigned", {
      projectId,
      factId,
      requestId,
      assignmentId,
      revision: 1,
      reason: "ASSIGNED",
    }),
  ];
  const newAudit = audit(
    check.auditEventId,
    "scalar.reconciliation.checked",
    {
      projectId,
      factId,
      checkId,
      assessmentId: proofId,
      requestId: null,
      outcome: "NO_REQUEST",
    },
    true,
  );
  const retained = {
    ScalarReconciliationRequest: [request],
    ScalarReconciliationCheck: [oldCheck],
    ScalarReconciliationAssignment: [assignment],
    FactAssessment: [oldProof],
    FactAssessmentVersion: versions.slice(0, 2).map((v) => ({
      ...scope,
      assessmentId: oldProofId,
      versionId: v.id,
      sourceAccessRevision: 4,
    })),
    FactAssessmentConflict: [
      { ...scope, assessmentId: oldProofId, conflictId: conflicts[0]!.id },
    ],
    FactAuthorityConflict: conflicts.slice(0, 1),
    AuditEvent: oldAudits,
    ProjectFact: [{ customerId, projectId, id: factId, factType, revision: 2 }],
    ProjectFactVersion: versions.slice(0, 2),
    FactEvidence: evidence.slice(0, 2),
  };
  const before = {
    ...structuredClone(retained),
    ProjectFactVersion: structuredClone(versions),
    FactEvidence: structuredClone(evidence),
    FactAuthorityConflict: structuredClone(conflicts),
    ProjectFact: [{ ...retained.ProjectFact[0]!, revision: 64 }],
  };
  const after = {
    ...structuredClone(before),
    ScalarReconciliationCheck: [
      ...structuredClone(before.ScalarReconciliationCheck),
      check,
    ],
    FactAssessment: [...structuredClone(before.FactAssessment), proof],
    AuditEvent: [...structuredClone(before.AuditEvent), newAudit],
  };
  const delivered = {
    assessmentId: oldProofId,
    factId,
    asOf: oldAt,
    historical: true,
    replayed: false,
    visibility: "available",
    revalidationRequired: false,
    result,
  };
  const summary = {
    id: requestId,
    projectId,
    factId,
    state: "OPEN",
    assignment: { id: assignmentId, recipientSubject: pm.subject },
  };
  const original = {
    checkId: oldCheckId,
    outcome: "CREATED",
    replayed: false,
    assessment: delivered,
    request: summary,
  };
  const baseline = { request: summary, assessment: delivered };
  const overflow = {
    checkId,
    outcome: "NO_REQUEST",
    replayed: false,
    request: null,
    assessment: {
      ...delivered,
      assessmentId: proofId,
      asOf: newAt,
      result: incomplete,
    },
  };
  const commandRecord = (
    name: string,
    i: number,
    input: unknown,
    output: unknown,
  ) => ({
    name,
    operation: [1, 4].includes(i) ? "get" : "check",
    actor: pm,
    command: input,
    correlationId: correlationIds[i],
    nativeCommitAttempts: 1,
    callbackReturned: true,
    options: { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 },
    role: "pdaa_api",
    sessionUser: "pdaa_api",
    pid: 70,
    nativePid: 70,
    callbackReturnedAtCommit: true,
    nativeCommand: "COMMIT",
    commitObserver: {
      observerPid: 80,
      writerPid: 70,
      sessionUser: "pdaa_api",
      state: "idle",
      query: "COMMIT",
      phase: "native-commit-settled",
    },
    result: output,
  });
  const read = { projectId, requestId };
  return JSON.parse(
    JSON.stringify({
      family: "scalar-conflict-prefix/v1",
      customerId,
      projectId,
      factId,
      actor,
      pm,
      command,
      observer: { role: "pdaa_api", sessionUser: "pdaa_api", pid: 80 },
      setup: {
        method: "guarded-owner-append",
        principal: {
          role: "fixture_admin",
          sessionUser: "fixture_admin",
          pid: 90,
        },
        highestId,
      },
      retained,
      before,
      after,
      prefix: { count: 1002, throughRevision: 1002 },
      sample: [...conflicts]
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 1001)
        .map(({ id, revision }) => ({ id, revision })),
      commands: [
        commandRecord("original-check", 0, command, original),
        commandRecord("baseline-get", 1, read, baseline),
        commandRecord("overflow-check", 2, freshCommand, overflow),
        commandRecord("original-replay", 3, command, {
          ...original,
          replayed: true,
          assessment: { ...delivered, replayed: true },
        }),
        commandRecord("original-get", 4, read, baseline),
      ],
      baseline,
      integrity: {
        originalRequestId: requestId,
        originalProofId: oldProofId,
        overflowCheckId: checkId,
        overflowProofId: proofId,
        originalRequestValid: true,
        originalProofValid: true,
        overflowCheckValid: true,
        overflowProofValid: true,
      },
    }),
  );
}

it("interprets offsetless SQL audit timestamps as UTC", () => {
  const r = fixture();
  for (const graph of [r.retained, r.before, r.after])
    for (const audit of graph.AuditEvent)
      audit.occurredAt = audit.occurredAt.replace(/Z$/, "");
  expect(() => assertScalarConflictPrefix(r, r.customerId)).not.toThrow();
});

it("requires the true 1002 conflict prefix and original native command/proof evidence", () => {
  const r = fixture();
  expect(() => assertScalarConflictPrefix(r, r.customerId)).not.toThrow();
  const changes: [string, (v: ReturnType<typeof fixture>) => void][] = [
    [
      "sample max substituted",
      (v) => {
        v.after.FactAssessment[1].conflictThroughRevision = 1001;
      },
    ],
    [
      "highest row included in sample",
      (v) => {
        v.sample[1000] = { id: v.setup.highestId, revision: 1002 };
      },
    ],
    [
      "wrong total count",
      (v) => {
        v.prefix.count = 1001;
      },
    ],
    [
      "missing history family",
      (v) => {
        delete v.after.FactEvidence;
      },
    ],
    [
      "missing native command",
      (v) => {
        v.commands.pop();
      },
    ],
    [
      "unknown command",
      (v) => {
        v.commands[2].name = "renamed";
      },
    ],
    [
      "role override",
      (v) => {
        v.commands[2].role = "fixture_admin";
      },
    ],
    [
      "changed transaction limit",
      (v) => {
        v.commands[2].options.timeout = 20000;
      },
    ],
    [
      "wrong native PID",
      (v) => {
        v.commands[2].nativePid = 71;
      },
    ],
    [
      "callback not returned",
      (v) => {
        v.commands[2].callbackReturnedAtCommit = false;
      },
    ],
    [
      "wrong COMMIT phase",
      (v) => {
        v.commands[2].commitObserver.phase = "before-commit";
      },
    ],
    [
      "changed original retry key",
      (v) => {
        v.commands[3].command.idempotencyKey =
          v.commands[2].command.idempotencyKey;
      },
    ],
    [
      "mutated original proof",
      (v) => {
        v.after.FactAssessment[0].result.status = "UNKNOWN";
      },
    ],
    [
      "request closed",
      (v) => {
        v.after.ScalarReconciliationRequest[0].state = "CLOSED";
      },
    ],
    [
      "extra request",
      (v) => {
        v.after.ScalarReconciliationRequest.push(
          v.after.ScalarReconciliationRequest[0],
        );
      },
    ],
    [
      "unexpected dependency",
      (v) => {
        v.after.FactAssessmentVersion.push({
          ...v.after.FactAssessmentVersion[0],
          assessmentId: v.commands[2].result.assessment.assessmentId,
        });
      },
    ],
    [
      "changed conflict row",
      (v) => {
        v.after.FactAuthorityConflict[0].detectedAt =
          "2026-09-14T00:00:09.000Z";
      },
    ],
    [
      "wrong negative owner",
      (v) => {
        v.after.FactAssessment[1].scalarReconciliationCheckId =
          v.commands[0].result.checkId;
      },
    ],
    [
      "wrong checked audit",
      (v) => {
        v.after.AuditEvent[3].detail.outcome = "CREATED";
      },
    ],
    [
      "false original audit actor",
      (v) => {
        v.retained.AuditEvent[0].actor = "other";
      },
    ],
    [
      "invalid stored proof",
      (v) => {
        v.integrity.overflowProofValid = false;
      },
    ],
    [
      "restricted instead of incomplete",
      (v) => {
        v.commands[2].result.assessment.visibility = "restricted";
      },
    ],
  ];
  for (const [label, change] of changes) {
    const altered = structuredClone(r);
    change(altered);
    expect(
      () => assertScalarConflictPrefix(altered, r.customerId),
      label,
    ).toThrow();
  }
});
