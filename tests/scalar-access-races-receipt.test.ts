// FR-EVD-009, NFR-SEC-001: synthetic reader unit controls, not native evidence.
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  assertScalarAccessCase,
  assertScalarAccessRaces,
} from "../scripts/acceptance/scalar-access-races-receipt.mjs";

function roleCase() {
  const customerId = randomUUID(),
    projectId = randomUUID(),
    factId = randomUUID();
  const scope = { customerId, projectId, factId };
  const actor = { customerId, subject: "administrator", roles: ["pmo_admin"] };
  const pm = { customerId, subject: "manager", roles: ["project_manager"] };
  const command = { projectId, factId, idempotencyKey: "original" };
  const proofId = randomUUID(),
    checkId = randomUUID(),
    requestId = randomUUID(),
    assignmentId = randomUUID();
  const dependencies = [0, 1].map(() => ({
    versionId: randomUUID(),
    sourceId: randomUUID(),
    evidenceId: randomUUID(),
  }));
  const result = {
    scope,
    complete: true,
    status: "CONFLICTING",
    revalidationRequired: false,
    resolvedValue: null,
    policy: {
      customerId,
      projectId,
      factType: "forecast",
      conflictBehavior: "REQUEST_RECONCILIATION",
    },
    versions: dependencies.map((d, i) => ({
      id: d.versionId,
      value: { type: "date", value: i === 0 ? "2026-10-01" : "2026-10-02" },
      evidenceIds: [d.evidenceId],
    })),
    conflicts: [
      {
        versionIds: dependencies.map((d) => d.versionId),
        evidenceIds: dependencies.map((d) => d.evidenceId),
      },
    ],
  };
  Object.assign(result.scope, { factType: "forecast" });
  const assessment = {
    assessmentId: proofId,
    factId,
    visibility: "available",
    revalidationRequired: false,
    historical: true,
    result,
  };
  const request = {
    id: requestId,
    projectId,
    factId,
    assignment: { id: assignmentId },
  };
  const original = {
    checkId,
    outcome: "CREATED",
    replayed: false,
    assessment,
    request,
  };
  const before = {
    ScalarReconciliationRequest: [
      {
        ...scope,
        id: requestId,
        originalAssessmentId: proofId,
        originCommandId: checkId,
        state: "OPEN",
        sealed: true,
      },
    ],
    ScalarReconciliationCheck: [
      {
        ...scope,
        id: checkId,
        assessmentId: proofId,
        requestId,
        subject: pm.subject,
        idempotencyKey: command.idempotencyKey,
      },
    ],
    ScalarReconciliationAssignment: [
      {
        ...scope,
        id: assignmentId,
        recipientSubject: pm.subject,
        requestId,
        revision: 1,
        kind: "INITIAL",
      },
    ],
    FactAssessment: [
      {
        ...scope,
        id: proofId,
        scalarReconciliationCheckId: checkId,
        sealed: true,
        result,
      },
    ],
    FactAssessmentVersion: dependencies.map((d) => ({
      ...scope,
      assessmentId: proofId,
      versionId: d.versionId,
    })),
    FactAssessmentConflict: [
      { ...scope, assessmentId: proofId, conflictId: randomUUID() },
    ],
    FactAuthorityConflict: [{ ...scope, id: randomUUID() }],
    AuditEvent: [] as Record<string, unknown>[],
    ProjectFact: [{ ...scope, id: factId }],
    ProjectFactVersion: dependencies.map((d) => ({
      ...scope,
      id: d.versionId,
      sourceId: d.sourceId,
      evidenceId: d.evidenceId,
    })),
    FactEvidence: dependencies.map((d) => ({
      ...scope,
      id: d.evidenceId,
      sourceId: d.sourceId,
    })),
  };
  const participants = ["get", "check", "check"].map((operation, i) => ({
    operation,
    actor: { ...pm, roles: ["leadership"] },
    pid: 20 + i,
    tag: "role-test-" + i,
    callbackReturned: i === 0,
    correlationId: randomUUID(),
    command:
      i === 0
        ? { projectId, requestId }
        : { ...command, idempotencyKey: i === 1 ? "original" : "fresh" },
  }));
  const audits = participants.slice(1).map((p) => ({
    id: randomUUID(),
    customerId,
    actor: pm.subject,
    correlationId: p.correlationId,
    event: "scalar.reconciliation.check.denied",
    detail: { projectId, reason: "DENIED" },
  }));
  const controlBefore = {
    FactSourceAccess: [],
    FactSourceReader: [],
    AuthorityPolicy: [],
    AuthorityPolicyRevision: [],
    AuthorityPolicyReceipt: [],
    FactAppendReceipt: [],
    AccessGrant: [
      {
        id: randomUUID(),
        customerId,
        subject: pm.subject,
        role: "project_manager",
        scopeType: "project",
        scopeId: projectId,
      },
    ],
  };
  const baseline = { request, assessment };
  return {
    name: "current-role-loss",
    projectId,
    factId,
    actor,
    pm,
    command,
    original,
    baseline,
    dependencies,
    selected: dependencies[0],
    before,
    after: { ...structuredClone(before), AuditEvent: structuredClone(audits) },
    controlBefore,
    controlAfter: structuredClone(controlBefore),
    participants,
    blocked: [],
    audits,
    outcomes: [
      { status: "fulfilled", value: null },
      { status: "rejected", code: "DENIED" },
      { status: "rejected", code: "DENIED" },
    ],
    finalDetail: baseline,
  };
}

it("binds current-role denial to unchanged PM grants, original proof and exact audit rows", () => {
  const c = roleCase();
  expect(() => assertScalarAccessCase(c, c.pm.customerId, 99)).not.toThrow();
  const mutate = (change: (v: ReturnType<typeof roleCase>) => void) => {
    const altered = structuredClone(c);
    change(altered);
    expect(() =>
      assertScalarAccessCase(altered, c.pm.customerId, 99),
    ).toThrow();
  };
  mutate((v) => {
    v.participants[1]!.actor.roles = [];
  });
  mutate((v) => {
    v.participants[1]!.actor.roles = ["project_manager"];
  });
  mutate((v) => {
    v.controlAfter.AccessGrant = [];
  });
  mutate((v) => {
    v.outcomes[1]!.code = "INVALID_REQUEST";
  });
  mutate((v) => {
    v.before.ScalarReconciliationAssignment[0]!.requestId = randomUUID();
  });
  mutate((v) => {
    v.selected = { ...v.selected!, sourceId: randomUUID() };
  });
  mutate((v) => {
    v.audits[0]!.detail.reason = "OTHER";
  });
  mutate((v) => {
    v.after.AuditEvent[0]!.actor = "other";
  });
  mutate((v) => {
    v.participants[1]!.command.idempotencyKey = "fresh";
  });
});

it("rejects incomplete case inventories before accepting access race evidence", () => {
  const c = roleCase();
  expect(() =>
    assertScalarAccessRaces(
      {
        family: "scalar-access-races/v1",
        customerId: c.pm.customerId,
        observer: { role: "pdaa_api", pid: 99 },
        cases: [c],
      },
      c.pm.customerId,
    ),
  ).toThrow();
});

// FR-EVD-004/007/009/012: this hand-built receipt is a unit control only.
function contributorCase() {
  // JSON round-trip models the original receipt boundary, not application execution.
  const c = JSON.parse(JSON.stringify(roleCase()));
  c.name = "contributor-first";
  const { customerId } = c.pm;
  const scope = { customerId, projectId: c.projectId, factId: c.factId };
  const factType = "forecast",
    policyId = randomUUID(),
    policyRevisionId = randomUUID();
  const oldAt = "2026-09-14T00:00:01.000Z";
  const appendAt = "2026-09-14T00:00:02.000Z";
  const newAt = "2026-09-14T00:00:03.000Z";
  const validUntil = "2026-09-15T00:00:00.000Z";
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const requestHash = hash(
    JSON.stringify({ projectId: c.projectId, factId: c.factId }),
  );
  const oldProof = c.before.FactAssessment[0];
  const oldRequest = c.before.ScalarReconciliationRequest[0];
  const oldCheck = c.before.ScalarReconciliationCheck[0];
  const oldAssignment = c.before.ScalarReconciliationAssignment[0];
  for (const table of Object.keys(c.before))
    for (const row of c.before[table])
      if (
        !["ProjectFact", "FactAssessment", "FactAuthorityConflict"].includes(
          table,
        )
      )
        delete row.factType;
  Object.assign(c.before.ProjectFact[0], { factType, revision: 2 });
  delete c.before.ProjectFact[0].factId;
  for (const [i, v] of c.before.ProjectFactVersion.entries()) {
    Object.assign(v, {
      revision: i + 1,
      provenance: "HUMAN_CONFIRMED",
      effectiveAt: "2026-09-14T00:00:00.000Z",
      validUntil,
      value: { type: "date", value: i === 0 ? "2026-10-01" : "2026-10-02" },
    });
    Object.assign(c.before.FactEvidence[i], {
      providedBy: i === 0 ? c.actor.subject : c.pm.subject,
      observedAt: "2026-09-14T00:00:00.500Z",
      originalStatement: "Original forecast " + i,
    });
  }
  const oldResult = c.original.assessment.result;
  Object.assign(oldResult, { asOf: oldAt, reconciliationRequired: true });
  Object.assign(oldResult.policy, { revisionId: policyRevisionId });
  oldResult.versions = c.before.ProjectFactVersion.map(
    (v: {
      id: string;
      sourceId: string;
      evidenceId: string;
      value: unknown;
    }) => ({
      id: v.id,
      source: { instanceId: v.sourceId },
      value: v.value,
      evidenceIds: [v.evidenceId],
      visibility: "available",
      revalidationRequired: false,
    }),
  );
  c.original.assessment.replayed = false;
  c.baseline.assessment = structuredClone(c.original.assessment);
  Object.assign(oldProof, {
    factType,
    policyId,
    policyRevisionId,
    policyThroughRevision: 1,
    factRevision: 2,
    asOf: oldAt,
    subject: c.pm.subject,
    captureKind: "SCALAR_REQUEST",
    milestoneAssessmentId: null,
    idempotencyKey: "sr_" + oldCheck.id.replaceAll("-", ""),
    requestHash,
    complete: true,
    versionCount: 2,
    conflictCount: 1,
    conflictThroughRevision: 1,
    result: structuredClone(oldResult),
  });
  const identity = (
    header: { policyRevisionId: string },
    versions: {
      id: string;
      sourceId: string;
      value: { type: string };
      evidenceId: string;
    }[],
  ) =>
    JSON.stringify([
      "scalar-authority-conflict/v1",
      customerId,
      c.projectId,
      c.factId,
      header.policyRevisionId,
      [...versions]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((v) => [v.id, v.sourceId, v.value.type, [v.evidenceId]]),
    ]);
  Object.assign(oldRequest, {
    ruleRevision: "scalar-authority-conflict/v1",
    contributorIdentity: identity(oldProof, c.before.ProjectFactVersion),
    createdBy: c.pm.subject,
    createdAt: oldAt,
    auditEventId: randomUUID(),
  });
  oldRequest.contributorHash = hash(oldRequest.contributorIdentity);
  Object.assign(oldCheck, {
    outcome: "CREATED",
    requestHash,
    occurredAt: oldAt,
    auditEventId: randomUUID(),
  });
  Object.assign(oldAssignment, {
    expectedRevision: 0,
    previousAssignmentId: null,
    idempotencyKey: null,
    requestHash: null,
    actor: c.pm.subject,
    occurredAt: oldAt,
    reason: "ASSIGNED",
    auditEventId: randomUUID(),
    responsibilityId: randomUUID(),
    capturedPortfolioId: randomUUID(),
    configurationReceiptId: randomUUID(),
  });
  const originalConflict = c.before.FactAuthorityConflict[0];
  Object.assign(originalConflict, {
    factType,
    revision: 1,
    policyRevisionId,
    detectedAt: oldAt,
  });
  [originalConflict.leftVersionId, originalConflict.rightVersionId] =
    c.before.ProjectFactVersion.map((v: { id: string }) => v.id).sort();
  c.before.FactAssessmentConflict[0].conflictId = originalConflict.id;
  c.controlBefore.FactSourceAccess = c.dependencies.map(
    (d: { sourceId: string }) => ({
      ...scope,
      sourceId: d.sourceId,
      state: "AVAILABLE",
      revision: 4,
    }),
  );
  c.controlBefore.FactSourceReader = c.dependencies.flatMap(
    (d: { sourceId: string }) =>
      [c.actor.subject, c.pm.subject].map((subject) => ({
        ...scope,
        sourceId: d.sourceId,
        subject,
      })),
  );
  c.controlBefore.FactAppendReceipt = c.before.ProjectFactVersion.map(
    (v: { id: string }, i: number) => ({
      ...scope,
      id: randomUUID(),
      versionId: v.id,
      subject: i === 0 ? c.actor.subject : c.pm.subject,
      idempotencyKey: randomUUID(),
      requestHash: "a".repeat(64),
    }),
  );
  for (const d of c.before.FactAssessmentVersion) d.sourceAccessRevision = 4;
  c.before.AuditEvent = [];
  c.after = structuredClone(c.before);
  c.controlAfter = structuredClone(c.controlBefore);
  const version = {
    ...c.before.ProjectFactVersion[0],
    id: randomUUID(),
    evidenceId: randomUUID(),
    revision: 3,
    effectiveAt: appendAt,
    value: { type: "date", value: "2026-10-03" },
  };
  const evidence = {
    ...c.before.FactEvidence[0],
    id: version.evidenceId,
    observedAt: appendAt,
    originalStatement: "Synthetic changed contributor forecast",
  };
  const command = {
    projectId: c.projectId,
    factType,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
    effectiveAt: appendAt,
    validUntil,
    originalStatement: evidence.originalStatement,
    value: version.value,
  };
  const freshKey = randomUUID();
  c.participants = ["appendHumanStatement", "get", "check", "check"].map(
    (operation, i) => ({
      operation,
      actor: i === 0 ? c.actor : c.pm,
      pid: 30 + i,
      tag: "contributor-unit-" + i,
      callbackReturned: true,
      correlationId: randomUUID(),
      command:
        i === 0
          ? command
          : i === 1
            ? { projectId: c.projectId, requestId: oldRequest.id }
            : {
                ...c.command,
                idempotencyKey: i === 2 ? c.command.idempotencyKey : freshKey,
              },
    }),
  );
  c.blocked = c.participants.map(
    (p: { pid: number; tag: string }, i: number) => ({
      pid: p.pid,
      usename: "pdaa_api",
      application_name: p.tag,
      state: i === 0 ? "idle in transaction" : "active",
      wait_event_type: i === 0 ? "Client" : "Lock",
      blockers: i === 0 ? [] : [30],
    }),
  );
  c.after.ProjectFact[0].revision = 3;
  c.after.ProjectFactVersion.push(version);
  c.after.FactEvidence.push(evidence);
  c.controlAfter.FactAppendReceipt.push({
    ...scope,
    id: randomUUID(),
    subject: c.actor.subject,
    idempotencyKey: command.idempotencyKey,
    versionId: version.id,
    requestHash: hash(
      JSON.stringify({
        projectId: c.projectId,
        factType,
        expectedRevision: 2,
        value: command.value,
        effectiveAt: appendAt,
        validUntil,
        originalStatement: command.originalStatement,
      }),
    ),
  });
  const checkId = randomUUID(),
    proofId = randomUUID(),
    requestId = randomUUID();
  const result = structuredClone(oldResult);
  result.asOf = newAt;
  result.versions.push({
    id: version.id,
    source: { instanceId: version.sourceId },
    value: version.value,
    evidenceIds: [evidence.id],
    visibility: "available",
    revalidationRequired: false,
  });
  const other = c.before.ProjectFactVersion[1];
  result.conflicts.push({
    versionIds: [other.id, version.id],
    evidenceIds: [other.evidenceId, evidence.id],
  });
  const proof = {
    ...oldProof,
    id: proofId,
    scalarReconciliationCheckId: checkId,
    factRevision: 3,
    asOf: newAt,
    idempotencyKey: "sr_" + checkId.replaceAll("-", ""),
    versionCount: 3,
    conflictCount: 2,
    conflictThroughRevision: 2,
    result,
  };
  const check = {
    ...oldCheck,
    id: checkId,
    assessmentId: proofId,
    requestId,
    idempotencyKey: freshKey,
    occurredAt: newAt,
    auditEventId: randomUUID(),
  };
  const request = {
    ...oldRequest,
    id: requestId,
    originCommandId: checkId,
    originalAssessmentId: proofId,
    contributorIdentity: identity(proof, c.after.ProjectFactVersion),
    createdAt: newAt,
    auditEventId: randomUUID(),
  };
  request.contributorHash = hash(request.contributorIdentity);
  const assignment = {
    ...oldAssignment,
    id: randomUUID(),
    requestId,
    occurredAt: newAt,
    auditEventId: randomUUID(),
  };
  const conflict = {
    ...originalConflict,
    id: randomUUID(),
    detectedAt: newAt,
    revision: 2,
  };
  [conflict.leftVersionId, conflict.rightVersionId] = [
    version.id,
    other.id,
  ].sort();
  c.after.ScalarReconciliationRequest.push(request);
  c.after.ScalarReconciliationCheck.push(check);
  c.after.ScalarReconciliationAssignment.push(assignment);
  c.after.FactAssessment.push(proof);
  c.after.FactAuthorityConflict.push(conflict);
  c.after.FactAssessmentVersion.push(
    ...c.after.ProjectFactVersion.map((v: { id: string }) => ({
      ...scope,
      assessmentId: proofId,
      versionId: v.id,
      sourceAccessRevision: 4,
    })),
  );
  c.after.FactAssessmentConflict.push(
    ...c.after.FactAuthorityConflict.map((v: { id: string }) => ({
      ...scope,
      assessmentId: proofId,
      conflictId: v.id,
    })),
  );
  const appended = {
    factId: c.factId,
    replayed: false,
    entry: {
      id: version.id,
      revision: 3,
      sourceId: version.sourceId,
      evidenceId: evidence.id,
      sourceAccessRevision: 4,
      visibility: "available",
      revalidationRequired: false,
      content: {
        value: version.value,
        originalStatement: evidence.originalStatement,
        providedBy: c.actor.subject,
        provenance: "HUMAN_CONFIRMED",
        effectiveAt: appendAt,
        observedAt: appendAt,
        confirmedAt: appendAt,
        validUntil,
        source: {
          instanceId: version.sourceId,
          recordType: "human_statement",
          recordId: version.sourceId,
          revision: evidence.id,
        },
        evidenceIds: [evidence.id],
      },
    },
  };
  const fresh = {
    checkId,
    outcome: "CREATED",
    replayed: false,
    assessment: { ...c.original.assessment, assessmentId: proofId, result },
    request: {
      ...c.original.request,
      id: requestId,
      assignment: { id: assignment.id, recipientSubject: c.pm.subject },
    },
  };
  c.outcomes = [
    { status: "fulfilled", value: appended },
    { status: "fulfilled", value: structuredClone(c.baseline) },
    {
      status: "fulfilled",
      value: {
        ...c.original,
        replayed: true,
        assessment: { ...c.original.assessment, replayed: true },
      },
    },
    { status: "fulfilled", value: fresh },
  ];
  c.finalDetail = structuredClone(c.baseline);
  c.freshDetail = { request: fresh.request, assessment: fresh.assessment };
  const audit = (
    id: string,
    index: number,
    event: string,
    detail: unknown,
  ) => ({
    id,
    customerId,
    actor: c.participants[index].actor.subject,
    correlationId: c.participants[index].correlationId,
    event,
    detail,
    occurredAt: index === 0 ? appendAt : newAt,
  });
  c.audits = [
    audit(randomUUID(), 0, "fact.appended", {
      projectId: c.projectId,
      factId: c.factId,
      versionId: version.id,
      evidenceId: evidence.id,
      revision: 3,
    }),
    audit(check.auditEventId, 3, "scalar.reconciliation.checked", {
      projectId: c.projectId,
      factId: c.factId,
      checkId,
      assessmentId: proofId,
      requestId,
      outcome: "CREATED",
    }),
    audit(request.auditEventId, 3, "scalar.reconciliation.requested", {
      projectId: c.projectId,
      factId: c.factId,
      requestId,
      assessmentId: proofId,
      checkId,
    }),
    audit(assignment.auditEventId, 3, "scalar.reconciliation.assigned", {
      projectId: c.projectId,
      factId: c.factId,
      requestId,
      assignmentId: assignment.id,
      revision: 1,
      reason: "ASSIGNED",
    }),
  ];
  c.after.AuditEvent = structuredClone(c.audits);
  return c;
}

it("binds an observed public contributor append to a new request while preserving the historical proof", () => {
  const c = contributorCase();
  expect(() => assertScalarAccessCase(c, c.pm.customerId, 99)).not.toThrow();
  const mutations: [string, (v: ReturnType<typeof contributorCase>) => void][] =
    [
      [
        "unblocked reader",
        (v) => {
          v.blocked[1].blockers = [];
        },
      ],
      [
        "wrong append actor",
        (v) => {
          v.participants[0].actor = v.pm;
        },
      ],
      [
        "changed original replay key",
        (v) => {
          v.participants[2].command.idempotencyKey = "wrong";
        },
      ],
      [
        "missing append receipt",
        (v) => {
          v.controlAfter.FactAppendReceipt.pop();
        },
      ],
      [
        "wrong append request hash",
        (v) => {
          v.controlAfter.FactAppendReceipt[2].requestHash = "f".repeat(64);
        },
      ],
      [
        "wrong append audit detail",
        (v) => {
          v.audits[0].detail.revision = 2;
        },
      ],
      [
        "audit SQL mismatch",
        (v) => {
          v.after.AuditEvent[0].actor = "other";
        },
      ],
      [
        "wrong new version",
        (v) => {
          v.after.ProjectFactVersion[2].revision = 4;
        },
      ],
      [
        "different source",
        (v) => {
          v.after.ProjectFactVersion[2].sourceId = v.dependencies[1].sourceId;
        },
      ],
      [
        "changed original proof",
        (v) => {
          v.after.FactAssessment[0].result.status = "UNKNOWN";
        },
      ],
      [
        "business reuse instead of creation",
        (v) => {
          v.outcomes[3].value.outcome = "REUSED";
        },
      ],
      [
        "old proof delivered as new",
        (v) => {
          v.freshDetail.assessment = v.baseline.assessment;
        },
      ],
      [
        "wrong check owner",
        (v) => {
          v.after.FactAssessment[1].scalarReconciliationCheckId =
            v.original.checkId;
        },
      ],
      [
        "wrong INITIAL assignment",
        (v) => {
          v.after.ScalarReconciliationAssignment[1].revision = 2;
        },
      ],
      [
        "missing full dependency",
        (v) => {
          v.after.FactAssessmentVersion.pop();
        },
      ],
      [
        "wrong access revision",
        (v) => {
          v.after.FactAssessmentVersion[2].sourceAccessRevision = 0;
        },
      ],
      [
        "wrong conflict owner",
        (v) => {
          v.after.FactAssessmentConflict[1].assessmentId =
            v.original.assessment.assessmentId;
        },
      ],
      [
        "changed contributor identity",
        (v) => {
          v.after.ScalarReconciliationRequest[1].contributorIdentity =
            v.before.ScalarReconciliationRequest[0].contributorIdentity;
        },
      ],
      [
        "missing append family",
        (v) => {
          delete v.controlAfter.FactAppendReceipt;
        },
      ],
    ];
  for (const [label, change] of mutations) {
    const altered = structuredClone(c);
    change(altered);
    expect(
      () => assertScalarAccessCase(altered, c.pm.customerId, 99),
      label,
    ).toThrow();
  }
});
