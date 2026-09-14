import { randomUUID } from "node:crypto";
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
    ].map((name) => {
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
          name === "same-business"
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
        name === "refresh-cas"
          ? { status: "rejected", code: "REVISION_CONFLICT" }
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
        previousId = randomUUID();
      const projectId = randomUUID();
      const audits = [value, second].flatMap((o, index) => {
        const participant = participants[index + 1]!;
        const rejected = o.status === "rejected";
        const events = rejected
          ? ["scalar.reconciliation.assignment.denied"]
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
          event,
          actor: participant.actor,
          correlationId: participant.correlationId,
          detail: rejected ? { projectId, reason: "REVISION_CONFLICT" } : {},
        }));
      });
      const committedChecks = refresh
        ? []
        : [
            value,
            ...(name === "same-business" ? [second as typeof value] : []),
          ].map((o) => ({
            id: o.checkId,
            requestId: o.requestId,
            assessmentId: o.assessmentId,
            outcome: o.outcome,
          }));
      return {
        name,
        projectId,
        factId,
        committed: {
          audits,
          requests: [{ id: value.requestId }],
          assignments: [
            {
              id: value.assignmentId,
              requestId: value.requestId,
              revision: refresh ? 2 : 1,
              expectedRevision: refresh ? 1 : 0,
              previousAssignmentId: refresh ? previousId : null,
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
        participants,
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
});
it("FR-EVD-012: refuses missing native scalar load identities or changed deadlines", () => {
  const r = {
    family: "scalar-version-boundary/v1",
    customerId: randomUUID(),
    runtimeRole: "pdaa_api",
    projectId: randomUUID(),
    factId: randomUUID(),
    durationMs: 200,
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
