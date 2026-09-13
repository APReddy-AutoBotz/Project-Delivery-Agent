// FR-EVD-009/012, NFR-REL-001/002: independent race-receipt verification.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertReconciliationRacesReceipt } from "../scripts/acceptance/reconciliation-races-receipt.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = id(1),
  referenceProjectId = id(2),
  database = "pdaa_test_reader";
const tableNames = [
  "MilestoneConsistencyAssessment",
  "MilestoneConsistencyTarget",
  "MilestoneConsistencyContributorVersion",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
  "FactAuthorityConflict",
  "MilestoneReconciliationRequest",
  "MilestoneReconciliationCheck",
  "MilestoneReconciliationAssignment",
  "AuditEvent",
];
const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
let serial;
const next = () => id(serial++);
const actor = (subject, role) => ({ customerId, subject, roles: [role] });

function obs(name, who, input, pid, correlation = true, errorCode = null) {
  const tag = `pdaa-reconciliation-race-${next()}`;
  return {
    name,
    tag,
    pid,
    input,
    actor: who,
    correlationId: correlation ? `reconciliation-race-${next()}` : null,
    callbackReturned: errorCode === null,
    beforeCommit:
      errorCode === null
        ? {
            pid,
            usename: "pdaa_api",
            application_name: tag,
            state: "idle in transaction",
            wait_event_type: "Client",
            wait_event: "ClientRead",
            blockers: [],
          }
        : null,
    connection: { role: "pdaa_api", sessionUser: "pdaa_api", database, tag },
    completion:
      errorCode === null ? "repository-returned" : "repository-rejected",
    outcome:
      errorCode === null
        ? { status: "fulfilled" }
        : {
            status: "rejected",
            error: {
              name: "ProjectFactError",
              code: errorCode,
              message: "Project fact operation rejected",
            },
          },
  };
}

function blocked(observations, count) {
  const holder = observations[0];
  return observations.slice(0, count).map((item, index) => ({
    pid: item.pid,
    usename: "pdaa_api",
    application_name: item.tag,
    state: index ? "active" : "idle in transaction",
    wait_event_type: index ? "Lock" : "Client",
    wait_event: index ? "transactionid" : "ClientRead",
    blockers: index ? [holder.pid] : [],
  }));
}

function footprint(seed, changes, counts = {}) {
  const before = {},
    after = {},
    delta = {};
  for (const table of tableNames) {
    const start = counts[table] ?? 10,
      change = changes[table] ?? 0;
    before[table] = { count: start, sha256: hash(`${seed}-${table}-before`) };
    after[table] = {
      count: start + change,
      sha256: change ? hash(`${seed}-${table}-after`) : before[table].sha256,
    };
    delta[table] = change;
  }
  return { before, after, delta };
}

const compactAssessment = (
  f,
  assessmentId,
  visibility = "available",
  replayed = false,
) => ({
  assessmentId,
  projectId: f.projectId,
  milestoneId: f.milestoneId,
  asOf: "2026-09-13T00:00:00.000Z",
  historical: true,
  replayed,
  visibility,
  revalidationRequired: visibility === "restricted",
  resultStatus: visibility === "available" ? "CONFLICTING" : null,
  resultSha256: visibility === "available" ? hash("proof-" + f.label) : null,
});
const summary = (f, assignment) => ({
  id: f.requestId,
  projectId: f.projectId,
  milestoneId: f.milestoneId,
  createdAt: "2026-09-13T00:00:00.000Z",
  state: "OPEN",
  assignment,
});
const assignment = (f, revision, aid = next()) => ({
  id: aid,
  revision,
  occurredAt: "2026-09-13T00:00:00.000Z",
  reason: "ASSIGNED",
  recipientSubject: f.pm.subject,
});
const auditRow = (who, observation, event, detail) => ({
  id: next(),
  customerId,
  actor: who.subject,
  event,
  correlationId: observation.correlationId,
  occurredAt: "2026-09-13T00:00:00.000Z",
  detail,
});

function makeFixture(label, base, creatorIsPm = false) {
  const f = {
    label,
    projectId: id(base),
    milestoneId: id(base + 1),
    requestId: id(base + 2),
    assessmentId: id(base + 3),
    checkId: id(base + 4),
    actor: actor(`pmo-${label}`, "pmo_admin"),
    pm: actor(`pm-${label}`, "project_manager"),
  };
  const initialAssignment = assignment(f, 1, id(base + 5));
  f.initialAssignment = initialAssignment;
  const input = {
    projectId: f.projectId,
    milestoneId: f.milestoneId,
    ruleRevision: "milestone-required-state/v1",
    enabled: true,
    idempotencyKey: id(base + 6),
  };
  const initialActor = creatorIsPm ? f.pm : f.actor;
  const observation = obs("check", initialActor, input, base + 100);
  const result = {
    checkId: f.checkId,
    outcome: "CREATED",
    replayed: false,
    assessment: compactAssessment(f, f.assessmentId),
    request: summary(f, initialAssignment),
  };
  const sql = {
    assessments: [
      {
        id: f.assessmentId,
        customerId,
        projectId: f.projectId,
        milestoneId: f.milestoneId,
        reconciliationCheckId: f.checkId,
        status: "CONFLICTING",
        complete: true,
        sealed: true,
        targetCount: 4,
        versionCount: 4,
        contributorCount: 4,
      },
    ],
    requests: [
      {
        id: f.requestId,
        customerId,
        projectId: f.projectId,
        milestoneId: f.milestoneId,
        originalAssessmentId: f.assessmentId,
        originCommandId: f.checkId,
        sealed: true,
      },
    ],
    checks: [
      {
        id: f.checkId,
        customerId,
        projectId: f.projectId,
        subject: initialActor.subject,
        idempotencyKey: input.idempotencyKey,
        assessmentId: f.assessmentId,
        requestId: f.requestId,
        outcome: "CREATED",
      },
    ],
    assignments: [
      {
        id: initialAssignment.id,
        customerId,
        projectId: f.projectId,
        requestId: f.requestId,
        revision: 1,
        previousAssignmentId: null,
        kind: "INITIAL",
        actor: initialActor.subject,
        idempotencyKey: null,
        reason: "ASSIGNED",
        recipientSubject: f.pm.subject,
      },
    ],
  };
  const details = {
    "milestone.consistency.captured": {
      projectId: f.projectId,
      assessmentId: f.assessmentId,
      milestoneId: f.milestoneId,
      status: "CONFLICTING",
    },
    "milestone.reconciliation.requested": {
      projectId: f.projectId,
      requestId: f.requestId,
      assessmentId: f.assessmentId,
      checkId: f.checkId,
    },
    "milestone.reconciliation.assigned": {
      projectId: f.projectId,
      requestId: f.requestId,
      assignmentId: initialAssignment.id,
      revision: 1,
      reason: "ASSIGNED",
    },
    "milestone.reconciliation.checked": {
      projectId: f.projectId,
      checkId: f.checkId,
      assessmentId: f.assessmentId,
      requestId: f.requestId,
      outcome: "CREATED",
    },
  };
  const requiredWorkItems = [0, 1, 2].map((n) => ({
    id: id(base + 20 + n),
    milestoneId: f.milestoneId,
    workItemId: id(base + 30 + n),
  }));
  const targets = [
    {
      targetKind: "MILESTONE",
      targetId: f.milestoneId,
      requiredWorkItemId: null,
    },
    ...requiredWorkItems.map((r) => ({
      targetKind: "WORK_ITEM",
      targetId: r.workItemId,
      requiredWorkItemId: r.id,
    })),
  ].map((row, n) => ({
    ...row,
    bindingId: id(base + 40 + n),
    factId: id(base + 50 + n),
    factType: `canonical.state.${label}.${n}`,
    sourceId: id(base + 60 + n),
    versionId: id(base + 70 + n),
    evidenceId: id(base + 80 + n),
  }));
  const canonicalReceiptId = id(base + 7);
  return Object.assign(f, {
    canonicalBefore: [
      {
        id: f.projectId,
        customerId,
        portfolioId: id(base + 8),
        sealed: true,
        canonicalReceiptId,
        responsibilities: [
          { id: id(base + 9), role: "PROJECT_MANAGER", subject: f.pm.subject },
        ],
      },
    ],
    canonicalAfter: null,
    proofTopology: {
      canonicalProjectId: f.projectId,
      canonicalReceiptId,
      milestoneId: f.milestoneId,
      requiredWorkItems,
      targets,
    },
    initial: {
      observation,
      result,
      sql,
      audits: Object.entries(details).map(([event, detail]) =>
        auditRow(initialActor, observation, event, detail),
      ),
    },
  });
}

function makeReceipt() {
  serial = 9000;
  const grant = makeFixture("grant", 100),
    source = makeFixture("source", 200, true),
    af = makeFixture("assignment", 300);
  [grant, source, af].forEach((f) => {
    f.canonicalAfter = structuredClone(f.canonicalBefore);
  });
  let fp = footprint("grant", { AuditEvent: 2 });
  const revokeInput = {
    subject: grant.actor.subject,
    scopeType: "portfolio",
    scopeId: grant.canonicalBefore[0].portfolioId,
  };
  const gobs = [
    obs("revoke creator grant", grant.actor, revokeInput, 1001),
    obs(
      "check",
      grant.actor,
      { ...grant.initial.observation.input, idempotencyKey: next() },
      1002,
      true,
      "DENIED",
    ),
    obs(
      "check",
      grant.actor,
      grant.initial.observation.input,
      1003,
      true,
      "DENIED",
    ),
  ];
  const grantCase = {
    name: "grant-first-fresh-and-replay",
    customerId,
    projectId: grant.projectId,
    milestoneId: grant.milestoneId,
    ...fp,
    observations: gobs,
    blocked: blocked(gobs, 3),
    results: [
      { returned: "undefined" },
      { errorCode: "DENIED" },
      { errorCode: "DENIED" },
    ],
    sql: structuredClone(grant.initial.sql),
    controls: {
      before: [
        {
          id: next(),
          customerId,
          subject: grant.actor.subject,
          scopeType: "portfolio",
          scopeId: revokeInput.scopeId,
          role: "pmo_admin",
        },
      ],
      after: [],
    },
    audits: [
      auditRow(grant.actor, gobs[0], "access.revoked", revokeInput),
      ...gobs.slice(1).map((o) =>
        auditRow(grant.actor, o, "milestone.reconciliation.check.denied", {
          projectId: grant.projectId,
          reason: "DENIED",
        }),
      ),
    ],
  };

  const sourceControl = {
    customerId,
    projectId: source.projectId,
    factId: source.proofTopology.targets[0].factId,
    sourceId: source.proofTopology.targets[0].sourceId,
    revision: 2,
    state: "AVAILABLE",
    readers: [source.actor.subject, source.pm.subject].sort(),
  };
  const sobs = [
    obs(
      "remove PM source reader",
      source.actor,
      {
        projectId: source.projectId,
        sourceId: sourceControl.sourceId,
        expectedRevision: 2,
        state: "AVAILABLE",
        readers: [source.actor.subject],
      },
      1101,
    ),
    obs(
      "PM original-proof GET",
      source.pm,
      { projectId: source.projectId, requestId: source.requestId },
      1102,
      false,
    ),
    obs("check", source.pm, source.initial.observation.input, 1103),
    obs(
      "check",
      source.pm,
      { ...source.initial.observation.input, idempotencyKey: next() },
      1104,
    ),
  ];
  const freshId = next(),
    freshCheckId = next();
  const sourceSql = structuredClone(source.initial.sql);
  sourceSql.assessments.push({
    ...sourceSql.assessments[0],
    id: freshId,
    reconciliationCheckId: freshCheckId,
    status: "REVALIDATION_REQUIRED",
    contributorCount: 0,
  });
  sourceSql.checks.push({
    ...sourceSql.checks[0],
    id: freshCheckId,
    assessmentId: freshId,
    requestId: null,
    outcome: "NO_REQUEST",
    idempotencyKey: sobs[3].input.idempotencyKey,
  });
  fp = footprint("source", {
    MilestoneConsistencyAssessment: 1,
    MilestoneConsistencyTarget: 4,
    FactAssessment: 4,
    FactAssessmentVersion: 4,
    MilestoneReconciliationCheck: 1,
    AuditEvent: 3,
  });
  const sourceCase = {
    name: "source-first-detail-replay-fresh",
    customerId,
    projectId: source.projectId,
    milestoneId: source.milestoneId,
    ...fp,
    observations: sobs,
    blocked: blocked(sobs, 4),
    sql: sourceSql,
    results: [
      { sourceId: sourceControl.sourceId, revision: 5 },
      {
        request: source.initial.result.request,
        assessment: compactAssessment(
          source,
          source.assessmentId,
          "restricted",
        ),
      },
      {
        ...source.initial.result,
        replayed: true,
        assessment: compactAssessment(
          source,
          source.assessmentId,
          "restricted",
          true,
        ),
      },
      {
        checkId: freshCheckId,
        outcome: "NO_REQUEST",
        replayed: false,
        assessment: compactAssessment(source, freshId, "restricted"),
        request: null,
      },
    ],
    controls: {
      before: sourceControl,
      after: { ...sourceControl, revision: 5, readers: [source.actor.subject] },
      selectedContributor: structuredClone(source.proofTopology.targets[0]),
    },
    audits: [
      auditRow(source.actor, sobs[0], "fact.source_access.changed", {
        projectId: source.projectId,
        sourceId: sourceControl.sourceId,
      }),
      auditRow(source.pm, sobs[3], "milestone.consistency.captured", {
        projectId: source.projectId,
        assessmentId: freshId,
        milestoneId: source.milestoneId,
        status: "REVALIDATION_REQUIRED",
      }),
      auditRow(source.pm, sobs[3], "milestone.reconciliation.checked", {
        projectId: source.projectId,
        checkId: freshCheckId,
        assessmentId: freshId,
        requestId: null,
        outcome: "NO_REQUEST",
      }),
    ],
  };

  const get = (pid) =>
    obs(
      "PM original-proof GET",
      af.pm,
      { projectId: af.projectId, requestId: af.requestId },
      pid,
      false,
    );
  const refreshInput = (revision, key = next()) => ({
    projectId: af.projectId,
    requestId: af.requestId,
    expectedAssignmentRevision: revision,
    idempotencyKey: key,
  });
  const dObs = [
    get(1201),
    obs("assignment refresh", af.actor, refreshInput(1), 1202),
    obs(
      "assignment refresh",
      af.actor,
      refreshInput(1),
      1203,
      true,
      "REVISION_CONFLICT",
    ),
  ];
  const a2 = assignment(af, 2),
    win = { requestId: af.requestId, assignment: a2, replayed: false };
  const sql2 = structuredClone(af.initial.sql);
  sql2.assignments.push({
    id: a2.id,
    customerId,
    projectId: af.projectId,
    requestId: af.requestId,
    revision: 2,
    previousAssignmentId: af.initialAssignment.id,
    kind: "REFRESH",
    actor: af.actor.subject,
    idempotencyKey: dObs[1].input.idempotencyKey,
    reason: "ASSIGNED",
    recipientSubject: af.pm.subject,
  });
  fp = footprint("distinct", {
    MilestoneReconciliationAssignment: 1,
    AuditEvent: 2,
  });
  const distinct = {
    name: "assignment-distinct-key-CAS",
    customerId,
    projectId: af.projectId,
    milestoneId: af.milestoneId,
    ...fp,
    observations: dObs,
    blocked: blocked(dObs, 3),
    results: [
      {
        request: af.initial.result.request,
        assessment: af.initial.result.assessment,
      },
      win,
      { errorCode: "REVISION_CONFLICT" },
    ],
    sql: sql2,
    audits: [
      auditRow(af.actor, dObs[1], "milestone.reconciliation.assigned", {
        projectId: af.projectId,
        requestId: af.requestId,
        assignmentId: a2.id,
        revision: 2,
      }),
      auditRow(
        af.actor,
        dObs[2],
        "milestone.reconciliation.assignment.denied",
        { projectId: af.projectId, reason: "REVISION_CONFLICT" },
      ),
    ],
    controls: null,
  };

  const sharedInput = refreshInput(2),
    s2obs = [
      get(1301),
      obs("assignment refresh", af.actor, sharedInput, 1302),
      obs("assignment refresh", af.actor, sharedInput, 1303),
    ];
  const a3 = assignment(af, 3),
    s3a = { requestId: af.requestId, assignment: a3, replayed: false },
    s3b = { ...s3a, replayed: true };
  const sql3 = structuredClone(sql2);
  sql3.assignments.push({
    id: a3.id,
    customerId,
    projectId: af.projectId,
    requestId: af.requestId,
    revision: 3,
    previousAssignmentId: a2.id,
    kind: "REFRESH",
    actor: af.actor.subject,
    idempotencyKey: sharedInput.idempotencyKey,
    reason: "ASSIGNED",
    recipientSubject: af.pm.subject,
  });
  fp = footprint("same", {
    MilestoneReconciliationAssignment: 1,
    AuditEvent: 1,
  });
  fp.before = structuredClone(distinct.after);
  for (const table of tableNames)
    fp.after[table] = {
      count:
        fp.before[table].count +
        (table === "MilestoneReconciliationAssignment" || table === "AuditEvent"
          ? 1
          : 0),
      sha256:
        table === "MilestoneReconciliationAssignment" || table === "AuditEvent"
          ? hash(`same-${table}-after`)
          : fp.before[table].sha256,
    };
  const same = {
    name: "assignment-same-key-replay",
    customerId,
    projectId: af.projectId,
    milestoneId: af.milestoneId,
    ...fp,
    observations: s2obs,
    blocked: blocked(s2obs, 3),
    results: [
      { request: summary(af, a2), assessment: af.initial.result.assessment },
      s3a,
      s3b,
    ],
    sql: sql3,
    audits: [
      auditRow(af.actor, s2obs[1], "milestone.reconciliation.assigned", {
        projectId: af.projectId,
        requestId: af.requestId,
        assignmentId: a3.id,
        revision: 3,
      }),
    ],
    controls: null,
  };

  const oldObs = obs("assignment refresh", af.actor, dObs[1].input, 1401),
    manageObs = obs(
      "manage live queue",
      af.actor,
      { projectId: af.projectId, limit: 20 },
      1402,
      false,
    ),
    recipientObs = obs(
      "recipient live queue",
      af.pm,
      { projectId: af.projectId, limit: 20 },
      1403,
      false,
    );
  fp = footprint("old", {});
  fp.before = structuredClone(same.after);
  fp.after = structuredClone(same.after);
  const page = { live: true, requests: [summary(af, a3)], next: null };
  const oldCase = {
    name: "assignment-old-replay-live-head",
    customerId,
    projectId: af.projectId,
    milestoneId: af.milestoneId,
    ...fp,
    observations: [oldObs, manageObs, recipientObs],
    blocked: [],
    results: [
      { requestId: af.requestId, assignment: a2, replayed: true },
      { mode: "manage", page },
      { mode: "recipient", page },
    ],
    sql: structuredClone(sql3),
    audits: [],
    controls: null,
  };

  const readObs = [
    get(1501),
    obs(
      "remove PM source reader",
      af.actor,
      {
        projectId: af.projectId,
        sourceId: af.proofTopology.targets[0].sourceId,
        expectedRevision: 2,
        state: "AVAILABLE",
        readers: [af.actor.subject],
      },
      1502,
    ),
    get(1503),
  ];
  fp = footprint("read-first", { AuditEvent: 1 });
  fp.before = structuredClone(oldCase.after);
  for (const table of tableNames)
    fp.after[table] = {
      count: fp.before[table].count + (table === "AuditEvent" ? 1 : 0),
      sha256:
        table === "AuditEvent"
          ? hash("read-first-audit")
          : fp.before[table].sha256,
    };
  const control = {
    customerId,
    projectId: af.projectId,
    factId: af.proofTopology.targets[0].factId,
    sourceId: af.proofTopology.targets[0].sourceId,
    revision: 2,
    state: "AVAILABLE",
    readers: [af.actor.subject, af.pm.subject].sort(),
  };
  const readFirst = {
    name: "read-first-source-change-control",
    customerId,
    projectId: af.projectId,
    milestoneId: af.milestoneId,
    ...fp,
    observations: readObs,
    blocked: blocked(readObs, 2),
    results: [
      { request: summary(af, a3), assessment: af.initial.result.assessment },
      { sourceId: control.sourceId, revision: 5 },
      {
        request: summary(af, a3),
        assessment: compactAssessment(af, af.assessmentId, "restricted"),
      },
    ],
    sql: structuredClone(sql3),
    controls: {
      before: control,
      after: { ...control, revision: 5, readers: [af.actor.subject] },
      selectedContributor: structuredClone(af.proofTopology.targets[0]),
    },
    audits: [
      auditRow(af.actor, readObs[1], "fact.source_access.changed", {
        projectId: af.projectId,
        sourceId: control.sourceId,
      }),
    ],
  };
  return {
    schemaVersion: 1,
    customerId,
    referenceProjectId,
    semantics:
      "Observed production repository transactions; original committed SQL projections; not native-COMMIT wire receipts",
    observer: { role: "pdaa_api", sessionUser: "pdaa_api", pid: 999, database },
    fixtures: [grant, source, af],
    cases: [grantCase, sourceCase, distinct, same, oldCase, readFirst],
  };
}

describe("handcrafted reconciliation race receipt reader", () => {
  it("accepts a linked six-case shape only as unit input", () => {
    expect(() =>
      assertReconciliationRacesReceipt(makeReceipt(), {
        expectedCustomerId: customerId,
      }),
    ).not.toThrow();
  });
  it.each([
    [
      "host customer",
      (r) => {
        r.customerId = id(999);
      },
    ],
    [
      "case order",
      (r) => {
        [r.cases[0], r.cases[1]] = [r.cases[1], r.cases[0]];
      },
    ],
    [
      "writer role",
      (r) => {
        r.cases[0].blocked[0].usename = "pdaa";
      },
    ],
    [
      "holder path",
      (r) => {
        r.cases[0].blocked[1].blockers = [];
      },
    ],
    [
      "delta",
      (r) => {
        r.cases[2].delta.AuditEvent = 1;
      },
    ],
    [
      "rejection class",
      (r) => {
        r.cases[0].observations[1].outcome.error.name = "Error";
      },
    ],
    [
      "canonical target",
      (r) => {
        r.fixtures[1].proofTopology.targets[0].targetId = id(999);
      },
    ],
    [
      "source contributor",
      (r) => {
        r.cases[1].controls.selectedContributor.factId = id(999);
      },
    ],
    [
      "original request",
      (r) => {
        r.cases[1].results[1].request.id = id(999);
      },
    ],
    [
      "SQL winner",
      (r) => {
        r.cases[2].sql.assignments[1].previousAssignmentId = id(999);
      },
    ],
    [
      "replay identity",
      (r) => {
        r.cases[3].results[2].assignment.id = id(999);
      },
    ],
    [
      "same-key request",
      (r) => {
        r.cases[3].results[2].requestId = id(999);
      },
    ],
    [
      "old replay result",
      (r) => {
        r.cases[4].results[0].assignment.id = id(999);
      },
    ],
    [
      "live queue head",
      (r) => {
        r.cases[4].results[2].page.requests[0].assignment.id = id(999);
      },
    ],
    [
      "SQL scope",
      (r) => {
        r.cases[5].sql.checks[0].projectId = id(999);
      },
    ],
  ])("rejects %s corruption", (_name, corrupt) => {
    const receipt = JSON.parse(JSON.stringify(makeReceipt()));
    corrupt(receipt);
    expect(() =>
      assertReconciliationRacesReceipt(receipt, {
        expectedCustomerId: customerId,
      }),
    ).toThrow();
  });
});
