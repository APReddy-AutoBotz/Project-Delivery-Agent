// FR-EVD-009, NFR-SEC-001: synthetic reader unit controls, not native evidence.
import { randomUUID } from "node:crypto";
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
  const audits = participants
    .slice(1)
    .map((p) => ({
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
