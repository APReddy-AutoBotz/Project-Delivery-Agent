// FR-EVD-009/012, NFR-REL-001/002: independent race-receipt verification.
// Requires the producer to retain fixture.proofTopology and each observation's
// normalized original outcome; see the companion review note.
import assert from "node:assert/strict";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const tables = [
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
const caseNames = [
  "grant-first-fresh-and-replay",
  "source-first-detail-replay-fresh",
  "assignment-distinct-key-CAS",
  "assignment-same-key-replay",
  "assignment-old-replay-live-head",
  "read-first-source-change-control",
];
const expectedDeltas = [
  { AuditEvent: 2 },
  {
    MilestoneConsistencyAssessment: 1,
    MilestoneConsistencyTarget: 4,
    FactAssessment: 4,
    FactAssessmentVersion: 4,
    MilestoneReconciliationCheck: 1,
    AuditEvent: 3,
  },
  { MilestoneReconciliationAssignment: 1, AuditEvent: 2 },
  { MilestoneReconciliationAssignment: 1, AuditEvent: 1 },
  {},
  { AuditEvent: 1 },
];

const exactActor = (value, customerId, subject, role) => {
  assert.deepEqual(value, { customerId, subject, roles: [role] });
};
const exactInput = (actual, expected) => assert.deepEqual(actual, expected);
const target = (fixture) => ({
  projectId: fixture.projectId,
  milestoneId: fixture.milestoneId,
});
const readInput = (fixture) => ({
  projectId: fixture.projectId,
  requestId: fixture.initial.result.request.id,
});
const mutating = (observation) => observation.correlationId !== null;

function observation(value, actor, database, completion, errorCode = null) {
  assert.equal(value.name.length > 0, true);
  assert.match(value.tag, /^pdaa-reconciliation-race-/);
  assert(Number.isInteger(value.pid) && value.pid > 0);
  assert.deepEqual(value.actor, actor);
  assert.equal(value.completion, completion);
  assert.deepEqual(value.connection, {
    role: "pdaa_api",
    sessionUser: "pdaa_api",
    database,
    tag: value.tag,
  });
  if (mutating(value))
    assert.match(value.correlationId, /^reconciliation-race-[0-9a-f-]{36}$/i);
  if (completion === "repository-returned") {
    assert.deepEqual(value.outcome, { status: "fulfilled" });
    assert.equal(value.callbackReturned, true);
    assert(value.beforeCommit);
    assert.equal(value.beforeCommit.pid, value.pid);
    assert.equal(value.beforeCommit.usename, "pdaa_api");
    assert.equal(value.beforeCommit.application_name, value.tag);
    assert.equal(value.beforeCommit.state, "idle in transaction");
    assert.deepEqual(value.beforeCommit.blockers, []);
  } else {
    assert.equal(completion, "repository-rejected");
    assert.deepEqual(value.outcome, {
      status: "rejected",
      error: {
        name: "ProjectFactError",
        code: errorCode,
        message: "Project fact operation rejected",
      },
    });
    assert.equal(value.callbackReturned, false);
    assert.equal(value.beforeCommit, null);
  }
}

function locks(row, observerPid, count) {
  assert.equal(row.blocked.length, count);
  const observations = row.observations.slice(0, count);
  assert.equal(new Set(observations.map((item) => item.pid)).size, count);
  const byPid = new Map(row.blocked.map((item) => [item.pid, item]));
  assert.equal(byPid.size, count);
  const holder = observations[0];
  for (const [index, current] of observations.entries()) {
    assert.notEqual(current.pid, observerPid);
    const activity = byPid.get(current.pid);
    assert(activity);
    assert.equal(activity.usename, "pdaa_api");
    assert.equal(activity.application_name, current.tag);
    assert(Array.isArray(activity.blockers));
    if (index === 0) {
      assert.equal(activity.state, "idle in transaction");
      assert.deepEqual(activity.blockers, []);
    } else {
      assert.equal(activity.state, "active");
      assert.equal(activity.wait_event_type, "Lock");
    }
  }
  const reaches = (pid, seen = new Set()) => {
    if (pid === holder.pid) return true;
    assert(!seen.has(pid), "blocking cycle");
    const activity = byPid.get(pid);
    assert(activity);
    return activity.blockers.some(
      (next) => byPid.has(next) && reaches(next, new Set([...seen, pid])),
    );
  };
  observations.slice(1).forEach((item) => assert(reaches(item.pid)));
}

function history(row, expected) {
  assert.deepEqual(Object.keys(row.before).sort(), [...tables].sort());
  assert.deepEqual(Object.keys(row.after).sort(), [...tables].sort());
  const delta = {};
  for (const table of tables) {
    const before = row.before[table],
      after = row.after[table];
    assert(Number.isInteger(before.count) && before.count >= 0);
    assert(Number.isInteger(after.count) && after.count >= 0);
    assert.match(before.sha256, digest);
    assert.match(after.sha256, digest);
    delta[table] = after.count - before.count;
    assert.equal(delta[table], expected[table] ?? 0, table);
    if (delta[table] === 0) assert.equal(after.sha256, before.sha256, table);
  }
  assert.deepEqual(row.delta, delta);
}

function assessment(value, fixture, visibility, replayed = false) {
  assert.match(value.assessmentId, uuid);
  assert.equal(value.projectId, fixture.projectId);
  assert.equal(value.milestoneId, fixture.milestoneId);
  assert.equal(value.historical, true);
  assert.equal(value.replayed, replayed);
  if (visibility === "available") {
    assert.equal(value.visibility, "available");
    assert.equal(value.revalidationRequired, false);
    assert.equal(value.resultStatus, "CONFLICTING");
    assert.match(value.resultSha256, digest);
  } else {
    assert.equal(value.visibility, "restricted");
    assert.equal(value.revalidationRequired, true);
    assert.equal(value.resultStatus, null);
    assert.equal(value.resultSha256, null);
  }
}

function request(value, fixture, revision) {
  assert.match(value.id, uuid);
  assert.equal(value.projectId, fixture.projectId);
  assert.equal(value.milestoneId, fixture.milestoneId);
  assert.equal(value.state, "OPEN");
  assert.match(value.assignment.id, uuid);
  assert.equal(value.assignment.revision, revision);
  assert.equal(value.assignment.recipientSubject, fixture.pm.subject);
}

function detail(value, fixture, visibility) {
  request(value.request, fixture, value.request.assignment.revision);
  assert.equal(value.request.id, fixture.initial.result.request.id);
  assessment(value.assessment, fixture, visibility);
  assert.equal(
    value.assessment.assessmentId,
    fixture.initial.result.assessment.assessmentId,
  );
  if (visibility === "available")
    assert.equal(
      value.assessment.resultSha256,
      fixture.initial.result.assessment.resultSha256,
    );
}

function audit(rows, observation, event, detail) {
  const own = rows.filter(
    (item) =>
      item.correlationId === observation.correlationId && item.event === event,
  );
  assert.equal(own.length, 1);
  const row = own[0];
  assert.match(row.id, uuid);
  assert.equal(row.customerId, observation.actor.customerId);
  assert.equal(row.actor, observation.actor.subject);
  assert.equal(row.event, event);
  for (const [key, expected] of Object.entries(detail))
    assert.equal(row.detail[key], expected, `${event}.${key}`);
}

function noAudit(rows, observation) {
  assert.equal(
    rows.filter((item) => item.correlationId === observation.correlationId)
      .length,
    0,
  );
}

function fixture(value, customerId, label, database) {
  assert.equal(value.label, label);
  assert.match(value.projectId, uuid);
  assert.match(value.milestoneId, uuid);
  exactActor(value.actor, customerId, value.actor.subject, "pmo_admin");
  exactActor(value.pm, customerId, value.pm.subject, "project_manager");
  assert.notEqual(value.actor.subject, value.pm.subject);
  assert.deepEqual(value.canonicalAfter, value.canonicalBefore);
  assert.equal(value.canonicalBefore.length, 1);
  const canonical = value.canonicalBefore[0];
  assert.equal(canonical.id, value.projectId);
  assert.equal(canonical.customerId, customerId);
  assert.match(canonical.portfolioId, uuid);
  assert.match(canonical.canonicalReceiptId, uuid);
  assert.equal(canonical.sealed, true);
  const pms = canonical.responsibilities.filter(
    (item) => item.role === "PROJECT_MANAGER",
  );
  assert.equal(pms.length, 1);
  assert.equal(pms[0].subject, value.pm.subject);
  const initialActor = label === "source" ? value.pm : value.actor;
  observation(
    value.initial.observation,
    initialActor,
    database,
    "repository-returned",
  );
  assert.equal(value.initial.observation.name, "check");
  assert.deepEqual(
    { ...value.initial.observation.input, idempotencyKey: undefined },
    {
      ...target(value),
      ruleRevision: "milestone-required-state/v1",
      enabled: true,
      idempotencyKey: undefined,
    },
  );
  assert.match(value.initial.observation.input.idempotencyKey, uuid);
  const result = value.initial.result;
  assert.match(result.checkId, uuid);
  assert.equal(result.outcome, "CREATED");
  assert.equal(result.replayed, false);
  assessment(result.assessment, value, "available");
  request(result.request, value, 1);
  const topology = value.proofTopology;
  assert.deepEqual(
    {
      canonicalProjectId: topology.canonicalProjectId,
      canonicalReceiptId: topology.canonicalReceiptId,
      milestoneId: topology.milestoneId,
    },
    {
      canonicalProjectId: value.projectId,
      canonicalReceiptId: canonical.canonicalReceiptId,
      milestoneId: value.milestoneId,
    },
  );
  assert.equal(topology.requiredWorkItems.length, 3);
  assert.equal(
    new Set(topology.requiredWorkItems.map((item) => item.id)).size,
    3,
  );
  assert.equal(
    new Set(topology.requiredWorkItems.map((item) => item.workItemId)).size,
    3,
  );
  topology.requiredWorkItems.forEach((item) => {
    assert.match(item.id, uuid);
    assert.match(item.workItemId, uuid);
    assert.equal(item.milestoneId, value.milestoneId);
  });
  assert.equal(topology.targets.length, 4);
  const allIdentities = [];
  for (const key of [
    "bindingId",
    "factId",
    "sourceId",
    "versionId",
    "evidenceId",
  ]) {
    assert.equal(
      new Set(topology.targets.map((item) => item[key])).size,
      4,
      key,
    );
    allIdentities.push(...topology.targets.map((item) => item[key]));
  }
  assert.equal(new Set(allIdentities).size, allIdentities.length);
  assert.equal(
    topology.targets.filter(
      (item) =>
        item.targetKind === "MILESTONE" && item.targetId === value.milestoneId,
    ).length,
    1,
  );
  assert.equal(
    topology.targets.filter((item) => item.targetKind === "WORK_ITEM").length,
    3,
  );
  assert.equal(
    new Set(
      topology.targets.map((item) => `${item.targetKind}:${item.targetId}`),
    ).size,
    4,
  );
  assert.deepEqual(
    new Set(
      topology.targets
        .filter((item) => item.targetKind === "WORK_ITEM")
        .map((item) => item.requiredWorkItemId),
    ),
    new Set(topology.requiredWorkItems.map((item) => item.id)),
  );
  topology.targets.forEach((item) => {
    for (const key of [
      "targetId",
      "bindingId",
      "factId",
      "sourceId",
      "versionId",
      "evidenceId",
    ])
      assert.match(item[key], uuid);
    if (item.targetKind === "MILESTONE")
      assert.equal(item.requiredWorkItemId, null);
    else {
      assert.match(item.requiredWorkItemId, uuid);
      const link = topology.requiredWorkItems.filter(
        (row) => row.id === item.requiredWorkItemId,
      );
      assert.equal(link.length, 1);
      assert.equal(link[0].workItemId, item.targetId);
    }
    assert.equal(typeof item.factType, "string");
    assert(item.factType.length > 0 && item.factType.length <= 96);
  });
  const sql = value.initial.sql;
  headsScope(sql, value);
  for (const key of ["assessments", "requests", "checks", "assignments"])
    assert.equal(sql[key].length, 1);
  const [a] = sql.assessments,
    [r] = sql.requests,
    [c] = sql.checks,
    [s] = sql.assignments;
  assert.equal(a.id, result.assessment.assessmentId);
  assert.equal(a.reconciliationCheckId, result.checkId);
  assert.equal(a.status, "CONFLICTING");
  assert.equal(a.sealed, true);
  assert.equal(r.id, result.request.id);
  assert.equal(r.originalAssessmentId, a.id);
  assert.equal(r.originCommandId, c.id);
  assert.equal(r.sealed, true);
  assert.equal(c.id, result.checkId);
  assert.equal(c.assessmentId, a.id);
  assert.equal(c.requestId, r.id);
  assert.equal(c.outcome, "CREATED");
  assert.equal(c.subject, initialActor.subject);
  assert.equal(
    c.idempotencyKey,
    value.initial.observation.input.idempotencyKey,
  );
  assert.equal(s.id, result.request.assignment.id);
  assert.equal(s.requestId, r.id);
  assert.equal(s.revision, 1);
  assert.equal(s.previousAssignmentId, null);
  assert.equal(s.kind, "INITIAL");
  assert.equal(s.actor, initialActor.subject);
  assert.equal(s.reason, "ASSIGNED");
  assert.equal(s.recipientSubject, value.pm.subject);
  const base = { projectId: value.projectId };
  audit(
    value.initial.audits,
    value.initial.observation,
    "milestone.consistency.captured",
    {
      ...base,
      assessmentId: a.id,
      milestoneId: value.milestoneId,
      status: "CONFLICTING",
    },
  );
  const own = value.initial.audits.filter(
    (item) => item.correlationId === value.initial.observation.correlationId,
  );
  assert.deepEqual(own.map((item) => item.event).sort(), [
    "milestone.consistency.captured",
    "milestone.reconciliation.assigned",
    "milestone.reconciliation.checked",
    "milestone.reconciliation.requested",
  ]);
  return value;
}

function caseHeader(row, fixture, name, delta) {
  assert.equal(row.name, name);
  assert.equal(row.customerId, fixture.actor.customerId);
  assert.equal(row.projectId, fixture.projectId);
  assert.equal(row.milestoneId, fixture.milestoneId);
  history(row, delta);
  headsScope(row.sql, fixture);
}

function headsScope(sql, fixture) {
  const requestIds = new Set(sql.requests.map((item) => item.id));
  const assessmentIds = new Set(sql.assessments.map((item) => item.id));
  for (const rows of Object.values(sql))
    rows.forEach((item) => {
      assert.equal(item.customerId, fixture.actor.customerId);
      assert.equal(item.projectId, fixture.projectId);
    });
  sql.assessments.forEach((item) =>
    assert.equal(item.milestoneId, fixture.milestoneId),
  );
  sql.requests.forEach((item) =>
    assert.equal(item.milestoneId, fixture.milestoneId),
  );
  sql.checks.forEach((item) => {
    assert(assessmentIds.has(item.assessmentId));
    assert(item.requestId === null || requestIds.has(item.requestId));
  });
  sql.assignments.forEach((item) => assert(requestIds.has(item.requestId)));
}

export function assertReconciliationRacesReceipt(
  value,
  { expectedCustomerId } = {},
) {
  assert.match(
    expectedCustomerId,
    uuid,
    "host-pinned expectedCustomerId is required",
  );
  const customerId = expectedCustomerId;
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.customerId, expectedCustomerId);
  assert.match(value.referenceProjectId, uuid);
  assert.equal(
    value.semantics,
    "Observed production repository transactions; original committed SQL projections; not native-COMMIT wire receipts",
  );
  assert.deepEqual(value.observer.role, "pdaa_api");
  assert.equal(value.observer.sessionUser, "pdaa_api");
  assert(Number.isInteger(value.observer.pid) && value.observer.pid > 0);
  assert.equal(typeof value.observer.database, "string");
  assert(value.observer.database.length > 0);
  assert.deepEqual(
    value.fixtures.map((item) => item.label),
    ["grant", "source", "assignment"],
  );
  const [grant, source, assignmentFixture] = value.fixtures.map((item) =>
    fixture(item, expectedCustomerId, item.label, value.observer.database),
  );
  assert.equal(new Set(value.fixtures.map((item) => item.projectId)).size, 3);
  value.fixtures.forEach((item) =>
    assert.notEqual(item.projectId, value.referenceProjectId),
  );
  assert.deepEqual(
    value.cases.map((item) => item.name),
    caseNames,
  );
  value.cases.forEach((row, index) =>
    caseHeader(
      row,
      [
        grant,
        source,
        assignmentFixture,
        assignmentFixture,
        assignmentFixture,
        assignmentFixture,
      ][index],
      caseNames[index],
      expectedDeltas[index],
    ),
  );

  // 1: grant mutation holds Project; both fresh and old-key checks deny after it.
  let row = value.cases[0];
  assert.equal(row.observations.length, 3);
  locks(row, value.observer.pid, 3);
  row.observations.forEach((item) =>
    observation(
      item,
      grant.actor,
      value.observer.database,
      item === row.observations[0]
        ? "repository-returned"
        : "repository-rejected",
      item === row.observations[0] ? null : "DENIED",
    ),
  );
  assert.equal(row.observations[0].name, "revoke creator grant");
  assert.equal(row.controls.before.length, 1);
  assert.deepEqual(row.controls.after, []);
  assert.deepEqual(row.controls.before[0], {
    ...row.observations[0].input,
    id: row.controls.before[0].id,
    customerId,
    role: "pmo_admin",
  });
  const old = grant.initial.observation.input;
  exactInput(row.observations[2].input, old);
  assert.notEqual(row.observations[1].input.idempotencyKey, old.idempotencyKey);
  assert.deepEqual(
    { ...row.observations[1].input, idempotencyKey: old.idempotencyKey },
    old,
  );
  assert.deepEqual(row.results, [
    { returned: "undefined" },
    { errorCode: "DENIED" },
    { errorCode: "DENIED" },
  ]);
  assert.deepEqual(row.sql, grant.initial.sql);
  audit(
    row.audits,
    row.observations[0],
    "access.revoked",
    row.observations[0].input,
  );
  row.observations.slice(1).forEach((item) =>
    audit(row.audits, item, "milestone.reconciliation.check.denied", {
      projectId: grant.projectId,
      reason: "DENIED",
    }),
  );

  // 2: source mutation precedes detail, retry and fresh check.
  row = value.cases[1];
  assert.equal(row.observations.length, 4);
  locks(row, value.observer.pid, 4);
  [source.actor, source.pm, source.pm, source.pm].forEach((actor, index) =>
    observation(
      row.observations[index],
      actor,
      value.observer.database,
      "repository-returned",
    ),
  );
  exactInput(row.observations[1].input, readInput(source));
  exactInput(row.observations[2].input, source.initial.observation.input);
  assert.notEqual(
    row.observations[3].input.idempotencyKey,
    source.initial.observation.input.idempotencyKey,
  );
  const [sourceWrite, originalRestricted, replay, fresh] = row.results;
  const racedBinding = source.proofTopology.targets.find(
    (item) => item.sourceId === row.controls.before.sourceId,
  );
  assert(racedBinding);
  assert.deepEqual(row.controls.selectedContributor, racedBinding);
  assert.equal(racedBinding.factId, row.controls.before.factId);
  assert.equal(row.controls.before.customerId, customerId);
  assert.equal(row.controls.before.projectId, source.projectId);
  assert.equal(row.controls.before.state, "AVAILABLE");
  assert.deepEqual(
    new Set(row.controls.before.readers),
    new Set([source.actor.subject, source.pm.subject]),
  );
  assert.deepEqual(row.observations[0].input, {
    projectId: source.projectId,
    sourceId: row.controls.before.sourceId,
    expectedRevision: row.controls.before.revision,
    state: "AVAILABLE",
    readers: [source.actor.subject],
  });
  assert.deepEqual(
    {
      ...row.observations[3].input,
      idempotencyKey: source.initial.observation.input.idempotencyKey,
    },
    source.initial.observation.input,
  );
  assert.equal(sourceWrite.sourceId, row.controls.before.sourceId);
  assert.equal(sourceWrite.revision, row.controls.after.revision);
  assert(sourceWrite.revision > row.controls.before.revision);
  detail(originalRestricted, source, "restricted");
  assert.equal(replay.checkId, source.initial.result.checkId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome, "CREATED");
  assessment(replay.assessment, source, "restricted", true);
  request(replay.request, source, 1);
  assert.equal(fresh.outcome, "NO_REQUEST");
  assert.equal(fresh.replayed, false);
  assert.equal(fresh.request, null);
  assessment(fresh.assessment, source, "restricted");
  assert.notEqual(
    fresh.assessment.assessmentId,
    source.initial.result.assessment.assessmentId,
  );
  assert.deepEqual(row.controls.after, {
    ...row.controls.before,
    revision: sourceWrite.revision,
    readers: [source.actor.subject],
  });
  assert.equal(row.sql.assessments.length, 2);
  assert.equal(row.sql.requests.length, 1);
  assert.equal(row.sql.checks.length, 2);
  assert.equal(row.sql.assignments.length, 1);
  const freshHeader = row.sql.assessments.find(
    (item) => item.id === fresh.assessment.assessmentId,
  );
  assert(freshHeader);
  assert.equal(freshHeader.reconciliationCheckId, fresh.checkId);
  assert.equal(freshHeader.status, "REVALIDATION_REQUIRED");
  assert.equal(freshHeader.sealed, true);
  const freshCheck = row.sql.checks.find((item) => item.id === fresh.checkId);
  assert(freshCheck);
  assert.equal(freshCheck.assessmentId, freshHeader.id);
  assert.equal(freshCheck.requestId, null);
  assert.equal(freshCheck.outcome, "NO_REQUEST");
  audit(row.audits, row.observations[0], "fact.source_access.changed", {
    projectId: source.projectId,
    sourceId: sourceWrite.sourceId,
  });
  noAudit(row.audits, row.observations[2]);
  audit(row.audits, row.observations[3], "milestone.consistency.captured", {
    projectId: source.projectId,
    assessmentId: fresh.assessment.assessmentId,
    milestoneId: source.milestoneId,
    status: "REVALIDATION_REQUIRED",
  });
  audit(row.audits, row.observations[3], "milestone.reconciliation.checked", {
    projectId: source.projectId,
    checkId: fresh.checkId,
    requestId: null,
    outcome: "NO_REQUEST",
  });

  // 3: distinct assignment keys have one CAS winner and one audited loser.
  row = value.cases[2];
  assert.equal(row.observations.length, 3);
  locks(row, value.observer.pid, 3);
  observation(
    row.observations[0],
    assignmentFixture.pm,
    value.observer.database,
    "repository-returned",
  );
  const successIndexes = row.results
    .slice(1)
    .map((item, index) => (item.errorCode ? -1 : index + 1))
    .filter((index) => index > 0);
  assert.equal(successIndexes.length, 1);
  const winnerIndex = successIndexes[0],
    loserIndex = winnerIndex === 1 ? 2 : 1;
  observation(
    row.observations[winnerIndex],
    assignmentFixture.actor,
    value.observer.database,
    "repository-returned",
  );
  observation(
    row.observations[loserIndex],
    assignmentFixture.actor,
    value.observer.database,
    "repository-rejected",
    "REVISION_CONFLICT",
  );
  detail(row.results[0], assignmentFixture, "available");
  assert.equal(row.results[0].request.assignment.revision, 1);
  assert.equal(row.results[loserIndex].errorCode, "REVISION_CONFLICT");
  const winner = row.results[winnerIndex];
  assert.equal(winner.replayed, false);
  assert.equal(winner.requestId, assignmentFixture.initial.result.request.id);
  request(
    {
      ...assignmentFixture.initial.result.request,
      assignment: winner.assignment,
    },
    assignmentFixture,
    2,
  );
  assert.notEqual(
    row.observations[1].input.idempotencyKey,
    row.observations[2].input.idempotencyKey,
  );
  row.observations.slice(1).forEach((item) =>
    assert.deepEqual(item.input, {
      projectId: assignmentFixture.projectId,
      requestId: assignmentFixture.initial.result.request.id,
      expectedAssignmentRevision: 1,
      idempotencyKey: item.input.idempotencyKey,
    }),
  );
  audit(
    row.audits,
    row.observations[winnerIndex],
    "milestone.reconciliation.assigned",
    {
      projectId: assignmentFixture.projectId,
      requestId: winner.requestId,
      assignmentId: winner.assignment.id,
      revision: 2,
    },
  );
  audit(
    row.audits,
    row.observations[loserIndex],
    "milestone.reconciliation.assignment.denied",
    { projectId: assignmentFixture.projectId, reason: "REVISION_CONFLICT" },
  );
  assert.equal(row.sql.assignments.length, 2);
  const winnerSql = row.sql.assignments.find(
    (item) => item.id === winner.assignment.id,
  );
  assert(winnerSql);
  assert.equal(
    winnerSql.previousAssignmentId,
    assignmentFixture.initial.result.request.assignment.id,
  );
  assert.equal(
    winnerSql.idempotencyKey,
    row.observations[winnerIndex].input.idempotencyKey,
  );
  assert.equal(winnerSql.actor, assignmentFixture.actor.subject);
  assert.equal(winnerSql.kind, "REFRESH");

  // 4: the same retry key yields one revision and one replay.
  row = value.cases[3];
  assert.deepEqual(row.before, value.cases[2].after);
  assert.equal(row.observations.length, 3);
  locks(row, value.observer.pid, 3);
  row.observations.forEach((item, index) =>
    observation(
      item,
      index ? assignmentFixture.actor : assignmentFixture.pm,
      value.observer.database,
      "repository-returned",
    ),
  );
  detail(row.results[0], assignmentFixture, "available");
  assert.equal(row.results[0].request.assignment.revision, 2);
  exactInput(row.observations[1].input, row.observations[2].input);
  assert.deepEqual(row.observations[1].input, {
    projectId: assignmentFixture.projectId,
    requestId: assignmentFixture.initial.result.request.id,
    expectedAssignmentRevision: 2,
    idempotencyKey: row.observations[1].input.idempotencyKey,
  });
  assert.deepEqual(
    row.results
      .slice(1)
      .map((item) => item.replayed)
      .sort(),
    [false, true],
  );
  assert.deepEqual(row.results[1].assignment, row.results[2].assignment);
  assert.equal(
    row.results[1].requestId,
    assignmentFixture.initial.result.request.id,
  );
  assert.equal(
    row.results[2].requestId,
    assignmentFixture.initial.result.request.id,
  );
  assert.equal(row.results[1].assignment.revision, 3);
  const sharedAssignment = row.results[1].assignment;
  assert.equal(row.sql.assignments.length, 3);
  const sharedSql = row.sql.assignments.find(
    (item) => item.id === sharedAssignment.id,
  );
  assert(sharedSql);
  assert.equal(sharedSql.previousAssignmentId, winner.assignment.id);
  assert.equal(
    sharedSql.idempotencyKey,
    row.observations[1].input.idempotencyKey,
  );
  const committed = row.results[1].replayed ? 2 : 1;
  audit(
    row.audits,
    row.observations[committed],
    "milestone.reconciliation.assigned",
    {
      projectId: assignmentFixture.projectId,
      requestId: assignmentFixture.initial.result.request.id,
      assignmentId: row.results[1].assignment.id,
      revision: 3,
    },
  );
  noAudit(row.audits, row.observations[committed === 1 ? 2 : 1]);

  // 5: an old retry is immutable while both live queues expose revision 3.
  row = value.cases[4];
  assert.equal(row.blocked.length, 0);
  assert.equal(row.observations.length, 3);
  row.observations.forEach((item, index) =>
    observation(
      item,
      index === 2 ? assignmentFixture.pm : assignmentFixture.actor,
      value.observer.database,
      "repository-returned",
    ),
  );
  assert.deepEqual(
    row.observations[0].input,
    value.cases[2].observations[winnerIndex].input,
  );
  assert.equal(row.observations[1].name, "manage live queue");
  assert.equal(row.observations[2].name, "recipient live queue");
  assert.equal(row.results[0].replayed, true);
  assert.equal(row.results[0].assignment.revision, 2);
  assert.equal(
    row.results[0].requestId,
    assignmentFixture.initial.result.request.id,
  );
  assert.deepEqual(row.results[0].assignment, winner.assignment);
  for (const [index, mode] of ["manage", "recipient"].entries()) {
    const page = row.results[index + 1];
    assert.equal(page.mode, mode);
    assert.equal(page.page.live, true);
    assert.equal(page.page.next, null);
    assert.equal(page.page.requests.length, 1);
    request(page.page.requests[0], assignmentFixture, 3);
    assert.equal(
      page.page.requests[0].id,
      assignmentFixture.initial.result.request.id,
    );
    assert.deepEqual(page.page.requests[0].assignment, sharedAssignment);
  }
  assert.deepEqual(row.sql, value.cases[3].sql);
  assert.deepEqual(row.before, value.cases[3].after);
  noAudit(row.audits, row.observations[0]);

  // 6: original read wins, then source changes, then the later read is restricted.
  row = value.cases[5];
  assert.equal(row.observations.length, 3);
  locks(row, value.observer.pid, 2);
  observation(
    row.observations[0],
    assignmentFixture.pm,
    value.observer.database,
    "repository-returned",
  );
  observation(
    row.observations[1],
    assignmentFixture.actor,
    value.observer.database,
    "repository-returned",
  );
  observation(
    row.observations[2],
    assignmentFixture.pm,
    value.observer.database,
    "repository-returned",
  );
  exactInput(row.observations[0].input, readInput(assignmentFixture));
  exactInput(row.observations[2].input, readInput(assignmentFixture));
  detail(row.results[0], assignmentFixture, "available");
  detail(row.results[2], assignmentFixture, "restricted");
  assert.equal(row.results[0].request.assignment.revision, 3);
  assert.equal(row.results[2].request.assignment.revision, 3);
  assert.equal(row.results[1].sourceId, row.controls.before.sourceId);
  assert.equal(row.results[1].revision, row.controls.after.revision);
  const readFirstBinding = assignmentFixture.proofTopology.targets.find(
    (item) => item.sourceId === row.controls.before.sourceId,
  );
  assert(readFirstBinding);
  assert.deepEqual(row.controls.selectedContributor, readFirstBinding);
  assert.equal(readFirstBinding.factId, row.controls.before.factId);
  assert.equal(row.controls.before.customerId, customerId);
  assert.equal(row.controls.before.projectId, assignmentFixture.projectId);
  assert.equal(row.controls.before.state, "AVAILABLE");
  assert.deepEqual(
    new Set(row.controls.before.readers),
    new Set([assignmentFixture.actor.subject, assignmentFixture.pm.subject]),
  );
  assert.deepEqual(row.observations[1].input, {
    projectId: assignmentFixture.projectId,
    sourceId: row.controls.before.sourceId,
    expectedRevision: row.controls.before.revision,
    state: "AVAILABLE",
    readers: [assignmentFixture.actor.subject],
  });
  assert.deepEqual(row.controls.after, {
    ...row.controls.before,
    revision: row.results[1].revision,
    readers: [assignmentFixture.actor.subject],
  });
  assert(row.results[1].revision > row.controls.before.revision);
  assert.deepEqual(row.sql, value.cases[4].sql);
  assert.deepEqual(row.before, value.cases[4].after);
  audit(row.audits, row.observations[1], "fact.source_access.changed", {
    projectId: assignmentFixture.projectId,
    sourceId: row.results[1].sourceId,
  });
}
