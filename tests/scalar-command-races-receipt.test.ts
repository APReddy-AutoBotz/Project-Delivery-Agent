import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  assertScalarCommandRaces,
  assertScalarVersionBoundary,
} from "../scripts/acceptance/scalar-command-races-receipt.mjs";

function raceReceipt() {
  const customerId = randomUUID();
  return {
    customerId,
    family: "scalar-command-races/v1",
    observer: { role: "pdaa_api", pid: 9 },
    cases: [
      "same-command",
      "same-business",
      "refresh-cas",
      "refresh-retry",
      "changed-fact-key",
    ].map((name) => {
      const changedFact = name === "changed-fact-key";
      const refresh = name.startsWith("refresh"),
        checks = name === "same-business" ? 2 : refresh ? 0 : 1;
      const delta = {
        ScalarReconciliationRequest: refresh ? 0 : 1,
        ScalarReconciliationCheck: checks,
        ScalarReconciliationAssignment: 1,
        FactAssessment: checks,
        FactAssessmentVersion: checks * 2,
        FactAssessmentConflict: checks,
        FactAuthorityConflict: refresh ? 0 : 1,
        AuditEvent:
          name === "same-business" || changedFact
            ? 4
            : name === "same-command"
              ? 3
              : name === "refresh-cas"
                ? 2
                : 1,
        ProjectFact: 0,
        ProjectFactVersion: 0,
        FactEvidence: 0,
      };
      const participants = [1, 2, 3].map((pid) => ({
        pid,
        tag: `scalar-${pid}`,
        correlationId: `correlation-${pid}`,
        actor: name === "same-business" ? `actor-${pid}` : "actor",
      }));
      const value = {
        status: "fulfilled",
        replayed: false,
        requestId: randomUUID(),
        assignmentId: randomUUID(),
        checkId: randomUUID(),
        assessmentId: randomUUID(),
        outcome: refresh ? null : "CREATED",
      };
      const second =
        name === "refresh-cas" || changedFact
          ? {
              status: "rejected",
              code: changedFact ? "IDEMPOTENCY_CONFLICT" : "REVISION_CONFLICT",
            }
          : {
              ...value,
              replayed: name !== "same-business",
              ...(name === "same-business"
                ? {
                    checkId: randomUUID(),
                    assessmentId: randomUUID(),
                    outcome: "REUSED",
                  }
                : {}),
            };
      const factId = randomUUID(),
        otherFactId = randomUUID(),
        previousId = randomUUID();
      const projectId = randomUUID();
      const keys = [randomUUID(), randomUUID()];
      if (name === "same-command" || name === "refresh-retry" || changedFact)
        keys[1] = keys[0]!;
      const requestAuditId = randomUUID(),
        assignmentAuditId = randomUUID();
      const checkAuditIds = [randomUUID(), randomUUID()];
      const scopedParticipants = participants.map((p, index) => ({
        ...p,
        operation:
          index === 0 ? "list" : refresh ? "refreshAssignment" : "check",
        command:
          index === 0
            ? { projectId, limit: 20 }
            : refresh
              ? {
                  projectId,
                  requestId: value.requestId,
                  expectedAssignmentRevision: 1,
                  idempotencyKey: keys[index - 1],
                }
              : {
                  projectId,
                  factId: changedFact && index === 2 ? otherFactId : factId,
                  idempotencyKey: keys[index - 1],
                },
      }));
      const audits = [value, second].flatMap((o, index) => {
        const participant = participants[index + 1]!;
        const rejected = o.status === "rejected";
        const events = rejected
          ? [
              changedFact
                ? "scalar.reconciliation.check.denied"
                : "scalar.reconciliation.assignment.denied",
            ]
          : (o as typeof value).replayed
            ? []
            : refresh
              ? ["scalar.reconciliation.assigned"]
              : (o as typeof value).outcome === "CREATED"
                ? [
                    "scalar.reconciliation.checked",
                    "scalar.reconciliation.requested",
                    "scalar.reconciliation.assigned",
                  ]
                : ["scalar.reconciliation.checked"];
        return events.map((event) => ({
          id: event.endsWith("checked")
            ? checkAuditIds[index]
            : event.endsWith("requested")
              ? requestAuditId
              : assignmentAuditId,
          event,
          actor: participant.actor,
          correlationId: participant.correlationId,
          detail: rejected
            ? {
                projectId,
                reason: changedFact
                  ? "IDEMPOTENCY_CONFLICT"
                  : "REVISION_CONFLICT",
              }
            : event.endsWith("checked")
              ? {
                  projectId,
                  factId,
                  checkId: (o as typeof value).checkId,
                  assessmentId: (o as typeof value).assessmentId,
                  requestId: value.requestId,
                  outcome: (o as typeof value).outcome,
                }
              : event.endsWith("requested")
                ? {
                    projectId,
                    factId,
                    requestId: value.requestId,
                    assessmentId: value.assessmentId,
                    checkId: value.checkId,
                  }
                : {
                    projectId,
                    factId,
                    requestId: value.requestId,
                    assignmentId: value.assignmentId,
                    revision: refresh ? 2 : 1,
                    reason: "ASSIGNED",
                  },
        }));
      });
      const committedChecks = refresh
        ? []
        : [
            value,
            ...(name === "same-business" ? [second as typeof value] : []),
          ].map((o, index) => ({
            id: o.checkId,
            requestId: o.requestId,
            assessmentId: o.assessmentId,
            outcome: o.outcome,
            subject: participants[index + 1]!.actor,
            idempotencyKey: keys[index],
            auditEventId: checkAuditIds[index],
          }));
      const result = {
        name,
        projectId,
        factId,
        committed: {
          audits,
          requests: [{ id: value.requestId, auditEventId: requestAuditId }],
          assignments: [
            {
              id: value.assignmentId,
              requestId: value.requestId,
              revision: refresh ? 2 : 1,
              expectedRevision: refresh ? 1 : 0,
              previousAssignmentId: refresh ? previousId : null,
              actor: participants[1]!.actor,
              idempotencyKey: refresh ? keys[0] : null,
              auditEventId: assignmentAuditId,
              reason: "ASSIGNED",
            },
            ...(refresh
              ? [
                  {
                    id: previousId,
                    requestId: value.requestId,
                    revision: 1,
                    expectedRevision: 0,
                    previousAssignmentId: null,
                  },
                ]
              : []),
          ],
          checks: committedChecks,
          assessments: committedChecks.map((c) => ({
            id: c.assessmentId,
            scalarReconciliationCheckId: c.id,
            factId,
          })),
        },
        participants: scopedParticipants,
        blocked: participants.map((p, i) => ({
          pid: p.pid,
          application_name: p.tag,
          usename: "pdaa_api",
          state: i === 0 ? "idle in transaction" : "active",
          wait_event_type: i === 0 ? "Client" : "Lock",
          blockers: i === 0 ? [] : [1],
        })),
        delta,
        before: Object.fromEntries(
          Object.keys(delta).map((table) => [
            table,
            { count: 2, sha256: "a".repeat(64) },
          ]),
        ),
        after: Object.fromEntries(
          Object.entries(delta).map(([table, count]) => [
            table,
            { count: 2 + count, sha256: (count ? "b" : "a").repeat(64) },
          ]),
        ),
        outcomes: [value, second],
      };
      if (!changedFact) return result;
      const scoped = <T extends object>(row: T) => ({
        ...row,
        customerId,
        projectId,
        factId,
      });
      const committed = {
        ...result.committed,
        checks: result.committed.checks.map((row) =>
          scoped({
            ...row,
            requestHash: createHash("sha256")
              .update(JSON.stringify({ projectId, factId }))
              .digest("hex"),
            occurredAt: "2026-09-14T00:00:00.000Z",
          }),
        ),
        requests: result.committed.requests.map((row) =>
          scoped({
            ...row,
            sealed: true,
            originCommandId: value.checkId,
            originalAssessmentId: value.assessmentId,
            createdAt: "2026-09-14T00:00:00.000Z",
          }),
        ),
        assignments: result.committed.assignments.map((row) =>
          scoped({
            ...row,
            kind: "INITIAL",
            occurredAt: "2026-09-14T00:00:00.000Z",
          }),
        ),
        audits: result.committed.audits.map((a) => ({
          ...a,
          customerId,
          occurredAt: "2026-09-14T00:00:00.000Z",
        })),
      };
      const inputs = {
        ProjectFact: [factId, otherFactId].map((id) => ({
          id,
          customerId,
          projectId,
        })),
        ProjectFactVersion: [factId, factId, otherFactId, otherFactId].map(
          (id) => ({
            id: randomUUID(),
            customerId,
            projectId,
            factId: id,
            sourceId: randomUUID(),
            evidenceId: randomUUID(),
            value: { type: "date", value: "2026-10-01" },
          }),
        ),
        FactEvidence: [] as object[],
      };
      inputs.FactEvidence = inputs.ProjectFactVersion.map((row) => ({
        id: row.evidenceId,
        customerId,
        projectId,
        factId: row.factId,
        sourceId: row.sourceId,
      }));
      const fullBefore = {
        ...Object.fromEntries(Object.keys(delta).map((table) => [table, []])),
        ...inputs,
      };
      const conflictId = randomUUID();
      const fullAfter = {
        ...fullBefore,
        ScalarReconciliationCheck: committed.checks,
        ScalarReconciliationRequest: committed.requests,
        ScalarReconciliationAssignment: committed.assignments,
        FactAssessment: committed.assessments.map((row) =>
          scoped({
            ...row,
            sealed: true,
            subject: participants[1]!.actor,
            requestHash: committed.checks[0]!.requestHash,
            idempotencyKey: "sr_" + value.checkId.replaceAll("-", ""),
            captureKind: "SCALAR_REQUEST",
            milestoneAssessmentId: null,
            asOf: "2026-09-14T00:00:00.000Z",
            complete: true,
            versionCount: 2,
            result: {
              scope: { customerId, projectId, factId },
              asOf: "2026-09-14T00:00:00.000Z",
              complete: true,
              status: "CONFLICTING",
              reconciliationRequired: true,
              revalidationRequired: false,
              versions: inputs.ProjectFactVersion.filter(
                (v) => v.factId === factId,
              ).map((v) => ({
                id: v.id,
                value: v.value,
                evidenceIds: [v.evidenceId],
                source: { instanceId: v.sourceId },
                visibility: "available",
                revalidationRequired: false,
              })),
            },
          }),
        ),
        FactAssessmentVersion: inputs.ProjectFactVersion.filter(
          (row) => row.factId === factId,
        ).map((row) =>
          scoped({ versionId: row.id, assessmentId: value.assessmentId }),
        ),
        FactAssessmentConflict: [
          scoped({ conflictId, assessmentId: value.assessmentId }),
        ],
        FactAuthorityConflict: [scoped({ id: conflictId })],
        AuditEvent: committed.audits,
      };
      const summary = (rows: object) =>
        Object.fromEntries(
          Object.entries(rows).map(([table, values]) => [
            table,
            {
              count: values.length,
              sha256: createHash("sha256")
                .update(JSON.stringify(values))
                .digest("hex"),
            },
          ]),
        );
      return {
        ...result,
        committed,
        attemptedFactIds: [factId, otherFactId],
        fullBefore,
        fullAfter,
        before: summary(fullBefore),
        after: summary(fullAfter),
      };
    }),
  };
}
it("NFR-REL-001: accepts only the complete observed scalar command race inventory", () => {
  const r = raceReceipt();
  expect(assertScalarCommandRaces(r, r.customerId)).toBe(true);
  const missing = structuredClone(r);
  missing.cases.pop();
  expect(() => assertScalarCommandRaces(missing, r.customerId)).toThrow();
  const unlocked = structuredClone(r);
  unlocked.cases[0]!.blocked[1]!.blockers = [];
  expect(() => assertScalarCommandRaces(unlocked, r.customerId)).toThrow();
  const doubled = structuredClone(r);
  doubled.cases[0]!.delta.ScalarReconciliationRequest = 2;
  expect(() => assertScalarCommandRaces(doubled, r.customerId)).toThrow();
  const unchanged = structuredClone(r);
  unchanged.cases[0]!.after.ProjectFact.sha256 = "c".repeat(64);
  expect(() => assertScalarCommandRaces(unchanged, r.customerId)).toThrow();
  const wrongProof = structuredClone(r);
  wrongProof.cases[0]!.committed.checks[0]!.assessmentId = randomUUID();
  expect(() => assertScalarCommandRaces(wrongProof, r.customerId)).toThrow();
  const wrongAudit = structuredClone(r);
  wrongAudit.cases[0]!.committed.audits[0]!.actor = "wrong-actor";
  expect(() => assertScalarCommandRaces(wrongAudit, r.customerId)).toThrow();
  const wrongEvent = structuredClone(r);
  wrongEvent.cases[0]!.committed.audits[0]!.event = "wrong.event";
  expect(() => assertScalarCommandRaces(wrongEvent, r.customerId)).toThrow();
  const wrongDetail = structuredClone(r);
  wrongDetail.cases[0]!.committed.audits[0]!.detail = {
    ...wrongDetail.cases[0]!.committed.audits[0]!.detail,
    factId: randomUUID(),
  };
  expect(() => assertScalarCommandRaces(wrongDetail, r.customerId)).toThrow();
  const wrongCommand = structuredClone(r);
  wrongCommand.cases[0]!.participants[2]!.command.idempotencyKey = randomUUID();
  expect(() => assertScalarCommandRaces(wrongCommand, r.customerId)).toThrow();
  const wrongLoserRequest = structuredClone(r);
  wrongLoserRequest.cases[2]!.participants[2]!.command.requestId = randomUUID();
  expect(() =>
    assertScalarCommandRaces(wrongLoserRequest, r.customerId),
  ).toThrow();
});
it("FR-EVD-012: changed-fact contention rejects substituted targets and partial loser graphs", () => {
  const r = raceReceipt();
  for (const change of [
    (c: any) => {
      c.participants[2].command.idempotencyKey = randomUUID();
    },
    (c: any) => {
      c.participants[2].command.factId = c.factId;
    },
    (c: any) => {
      c.outcomes[1].code = "REVISION_CONFLICT";
    },
    (c: any) => {
      c.factId = c.attemptedFactIds[1];
    },
    (c: any) => {
      c.fullAfter.FactAssessment[0].factId = c.attemptedFactIds[1];
    },
    (c: any) => {
      c.fullBefore.ProjectFactVersion.pop();
    },
    (c: any) => {
      delete c.fullAfter;
    },
    (c: any) => {
      c.committed.audits.pop();
    },
  ]) {
    const changed = structuredClone(r);
    change(changed.cases.find((c) => c.name === "changed-fact-key"));
    expect(() => assertScalarCommandRaces(changed, r.customerId)).toThrow();
  }
});
it("FR-EVD-012: refuses missing native scalar load identities or changed deadlines", () => {
  const r = {
    family: "scalar-version-boundary/v1",
    customerId: randomUUID(),
    runtimeRole: "pdaa_api",
    projectId: randomUUID(),
    factId: randomUUID(),
    durationMs: 200,
    measurement: {
      family: "scalar-load-measurement/v1",
      deadlineMs: 10000,
      commandState: "returned",
      durationMs: 200,
      deadlineExceeded: false,
      cpuUserMs: 1,
      cpuSystemMs: 1,
      eventLoopActiveMs: 5,
      eventLoopIdleMs: 195,
    },
    completeVersionCount: 1000,
    incompletePrefix: 1001,
    originalCheckId: randomUUID(),
    originalRequestId: randomUUID(),
    originalAssessmentId: randomUUID(),
    overflowCheckId: randomUUID(),
    overflowAssessmentId: randomUUID(),
    exactSqlIdentity: true,
    ownedNegativeCheck: true,
    originalOpenRequestPreserved: true,
    originalReplayPreserved: true,
  };
  expect(assertScalarVersionBoundary(r, r.customerId)).toBe(true);
  for (const patch of [
    { measurement: undefined },
    { measurement: { ...r.measurement, commandState: "rejected" } },
    { measurement: { ...r.measurement, durationMs: 199 } },
  ])
    expect(() =>
      assertScalarVersionBoundary({ ...r, ...patch }, r.customerId),
    ).toThrow();
  expect(() =>
    assertScalarVersionBoundary({ ...r, durationMs: 10000 }, r.customerId),
  ).toThrow();
  expect(() =>
    assertScalarVersionBoundary(
      { ...r, originalRequestId: undefined },
      r.customerId,
    ),
  ).toThrow();
  expect(() =>
    assertScalarVersionBoundary(
      { ...r, ownedNegativeCheck: false },
      r.customerId,
    ),
  ).toThrow();
});
