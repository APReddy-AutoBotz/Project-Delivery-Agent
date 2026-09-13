// Pure validation of schemaVersion 1 receipts; no I/O or compiled imports.
// FR-EVD-004/012, NFR-REL-001/002. This validates retained evidence, not its origin.
// Original-artifact authentication and producer missing-evidence gaps remain separate.
export const reconciliationCommitCases = Object.freeze([
  "positive-birth",
  "unsealed-request",
  "orphan-owned-assessment",
  "wrong-no-request-semantics",
  "wrong-check-hash",
  "wrong-check-audit",
  "wrong-refresh-hash",
  "wrong-refresh-audit",
  "positive-refresh",
  "positive-no-request",
  "wrong-reused-identity",
  "wrong-refresh-time",
]);
export const reconciliationCommitTables = Object.freeze([
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
  "ProjectFact",
  "ProjectFactVersion",
  "FactEvidence",
]);
export const reconciliationReceiptLimits = Object.freeze([
  "Original artifact authentication and CI/candidate binding are outside this receipt validator.",
  "Fingerprints cannot be independently recomputed without the original SQL row sets.",
  "Negative callback result IDs are not retained; their generated-ID set and absence counts are checked.",
  "The seed workflow proof is a different fixture and requires its own projection-row binding.",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const emptyDigest =
  "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const newTables = [
  "MilestoneReconciliationRequest",
  "MilestoneReconciliationCheck",
  "MilestoneReconciliationAssignment",
];
const positives = new Set([
  "positive-birth",
  "positive-refresh",
  "positive-no-request",
]);
const refreshes = new Set([
  "wrong-refresh-hash",
  "wrong-refresh-audit",
  "positive-refresh",
  "wrong-refresh-time",
]);
const ownershipErrors = [
  "Unowned reconciliation assessment cannot commit",
  "Incomplete reconciliation check cannot commit",
];
const guardErrors = {
  "unsealed-request": [
    ...ownershipErrors,
    "Incomplete reconciliation request cannot commit",
    "Incomplete reconciliation assignment cannot commit",
  ],
  "orphan-owned-assessment": [ownershipErrors[0]],
  "wrong-no-request-semantics": ownershipErrors,
  "wrong-check-hash": ownershipErrors,
  "wrong-check-audit": ownershipErrors,
  "wrong-refresh-hash": ["Incomplete reconciliation assignment cannot commit"],
  "wrong-refresh-audit": ["Incomplete reconciliation assignment cannot commit"],
  "wrong-reused-identity": ownershipErrors,
  "wrong-refresh-time": ["Incomplete reconciliation assignment cannot commit"],
};
function requireValue(condition, location, message) {
  if (!condition)
    throw new Error(`Reconciliation receipt ${location}: ${message}`);
}
function object(value, required, optional, location) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    location,
    "object required",
  );
  const prototype = Object.getPrototypeOf(value);
  requireValue(
    prototype === Object.prototype || prototype === null,
    location,
    "plain object required",
  );
  requireValue(
    required.every((key) => Object.hasOwn(value, key)),
    location,
    "required field missing",
  );
  const allowed = new Set([...required, ...optional]);
  requireValue(
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.has(key),
    ),
    location,
    "unexpected field",
  );
}
function id(value, location) {
  requireValue(
    typeof value === "string" && uuid.test(value),
    location,
    "lowercase UUID required",
  );
}
function pid(value, location) {
  requireValue(
    Number.isInteger(value) && value > 0 && value <= 2147483647,
    location,
    "positive PostgreSQL PID required",
  );
}
function fingerprints(value, location) {
  object(value, reconciliationCommitTables, [], location);
  for (const table of reconciliationCommitTables) {
    const row = value[table];
    object(row, ["count", "sha256"], [], `${location}.${table}`);
    requireValue(
      Number.isInteger(row.count) && row.count >= 0 && row.count <= 5000,
      location,
      "fingerprint count outside bound",
    );
    requireValue(
      typeof row.sha256 === "string" && digest.test(row.sha256),
      location,
      "SHA-256 required",
    );
    if (row.count === 0)
      requireValue(
        row.sha256 === emptyDigest,
        location,
        "empty table has wrong digest",
      );
  }
}
function sameFingerprints(a, b) {
  return reconciliationCommitTables.every(
    (table) =>
      a[table].count === b[table].count && a[table].sha256 === b[table].sha256,
  );
}
function nativeResult(value, mode, location) {
  if (positives.has(mode)) {
    object(value, ["command"], [], location);
    requireValue(
      value.command === "COMMIT",
      location,
      "positive native COMMIT required",
    );
    return;
  }
  object(value, ["code", "message"], ["constraint"], location);
  const foreignKey =
    mode === "orphan-owned-assessment" &&
    value.code === "23503" &&
    value.constraint === "ReconciliationAssessment_check_fk" &&
    value.message ===
      'insert or update on table "MilestoneConsistencyAssessment" violates foreign key constraint "ReconciliationAssessment_check_fk"';
  const guard =
    value.code === "P0001" &&
    value.constraint === undefined &&
    guardErrors[mode].includes(value.message);
  requireValue(
    foreignKey || guard,
    location,
    "wrong native PostgreSQL guard/constraint",
  );
}
function positiveDelta(row, location) {
  const delta = Object.fromEntries(
    reconciliationCommitTables.map((table) => [
      table,
      row.after[table].count - row.before[table].count,
    ]),
  );
  for (const table of reconciliationCommitTables) {
    requireValue(
      delta[table] >= 0,
      location,
      "positive control removed history",
    );
    requireValue(
      (delta[table] === 0) ===
        (row.after[table].sha256 === row.before[table].sha256),
      location,
      "count/digest transition inconsistent",
    );
  }
  for (const table of ["ProjectFact", "ProjectFactVersion", "FactEvidence"])
    requireValue(
      delta[table] === 0 &&
        row.after[table].sha256 === row.before[table].sha256,
      location,
      "positive capture/refresh changed input history",
    );
  if (row.mode === "positive-refresh") {
    for (const table of reconciliationCommitTables)
      requireValue(
        delta[table] ===
          (["MilestoneReconciliationAssignment", "AuditEvent"].includes(table)
            ? 1
            : 0),
        location,
        "refresh changed the wrong row family",
      );
    return;
  }
  const birth = row.mode === "positive-birth";
  requireValue(
    delta.MilestoneConsistencyAssessment === 1,
    location,
    "fresh assessment delta missing",
  );
  requireValue(
    delta.MilestoneReconciliationCheck === 1,
    location,
    "fresh check delta missing",
  );
  requireValue(
    delta.MilestoneReconciliationRequest === (birth ? 1 : 0),
    location,
    "wrong request delta",
  );
  requireValue(
    delta.MilestoneReconciliationAssignment === (birth ? 1 : 0),
    location,
    "wrong assignment delta",
  );
  requireValue(
    delta.MilestoneConsistencyTarget >= 2 &&
      delta.MilestoneConsistencyTarget <= 51,
    location,
    "complete target set missing",
  );
  requireValue(
    delta.FactAssessment === delta.MilestoneConsistencyTarget,
    location,
    "scalar/target count mismatch",
  );
  requireValue(
    delta.FactAssessmentVersion >= delta.FactAssessment &&
      delta.FactAssessmentVersion <= 1000,
    location,
    "retained scalar versions missing or unbounded",
  );
  requireValue(
    birth
      ? delta.MilestoneConsistencyContributorVersion >= 2 &&
          delta.MilestoneConsistencyContributorVersion <=
            delta.FactAssessmentVersion
      : delta.MilestoneConsistencyContributorVersion === 0,
    location,
    "wrong contributor delta",
  );
  // The internal scalar persistence primitive adds no capture audit of its own.
  // Birth adds milestone/request/assignment/check audits; NO_REQUEST adds two.
  requireValue(
    delta.AuditEvent === (birth ? 4 : 2),
    location,
    "wrong positive audit delta",
  );
}

function positiveEvidence(row, receipt, birth, location) {
  requireValue(
    row.generatedAbsence === null,
    location,
    "positive case cannot claim an absence probe",
  );
  const refresh = row.mode === "positive-refresh",
    noRequest = row.mode === "positive-no-request";
  object(
    row.result,
    refresh ? ["id", "revision"] : ["requestId", "checkId", "assessmentId"],
    [],
    `${location}.result`,
  );
  const generated = (value) => {
    id(value, location);
    requireValue(
      row.generatedIds.includes(value),
      location,
      "result/row ID not generated by this case",
    );
  };
  if (refresh) {
    generated(row.result.id);
    requireValue(
      row.result.revision === 2,
      location,
      "positive refresh must be the second committed revision",
    );
  } else {
    generated(row.result.checkId);
    generated(row.result.assessmentId);
    requireValue(
      row.result.checkId !== row.result.assessmentId,
      location,
      "check aliases its assessment",
    );
    if (noRequest)
      requireValue(
        row.result.requestId === null,
        location,
        "NO_REQUEST has request identity",
      );
    else {
      generated(row.result.requestId);
      requireValue(
        row.result.requestId === receipt.originalRequestId,
        location,
        "original request result mismatch",
      );
      requireValue(
        ![row.result.checkId, row.result.assessmentId].includes(
          row.result.requestId,
        ),
        location,
        "request aliases its proof/command",
      );
    }
  }
  object(
    row.positiveRows,
    ["request", "check", "assignment"],
    [],
    `${location}.positiveRows`,
  );
  const fields = {
    request: [
      "id",
      "customerId",
      "projectId",
      "milestoneId",
      "originalAssessmentId",
      "originCommandId",
      "sealed",
      "valid",
    ],
    check: [
      "id",
      "customerId",
      "projectId",
      "assessmentId",
      "requestId",
      "outcome",
      "valid",
    ],
    assignment: [
      "id",
      "customerId",
      "projectId",
      "requestId",
      "revision",
      "previousAssignmentId",
      "valid",
    ],
  };
  for (const family of ["request", "check", "assignment"]) {
    const rows = row.positiveRows[family];
    const count = family === "check" ? (refresh ? 0 : 1) : noRequest ? 0 : 1;
    requireValue(
      Array.isArray(rows) && rows.length === count,
      location,
      "wrong observed SQL row cardinality",
    );
    for (const observed of rows) {
      object(
        observed,
        fields[family],
        [],
        `${location}.positiveRows.${family}`,
      );
      id(observed.id, location);
      requireValue(
        observed.customerId === row.customerId &&
          observed.projectId === row.projectId,
        location,
        "SQL row scope mismatch",
      );
      requireValue(
        observed.valid === true,
        location,
        "observed SQL predicate failed",
      );
    }
  }
  const request = row.positiveRows.request[0],
    check = row.positiveRows.check[0],
    assignment = row.positiveRows.assignment[0];
  if (check) {
    requireValue(
      check.id === row.result.checkId &&
        check.assessmentId === row.result.assessmentId &&
        check.requestId === row.result.requestId &&
        check.outcome === (noRequest ? "NO_REQUEST" : "CREATED"),
      location,
      "observed check/result binding mismatch",
    );
  }
  if (request) {
    requireValue(
      request.id === receipt.originalRequestId &&
        request.milestoneId === row.milestoneId &&
        request.sealed === true,
      location,
      "observed original request mismatch",
    );
    id(request.originalAssessmentId, location);
    id(request.originCommandId, location);
    if (refresh) {
      requireValue(
        birth !== undefined,
        location,
        "original committed birth is missing",
      );
      const original = birth.positiveRows.request[0];
      requireValue(
        fields.request.every((field) => request[field] === original[field]),
        location,
        "refresh substituted or changed original request proof",
      );
    } else
      requireValue(
        request.originalAssessmentId === row.result.assessmentId &&
          request.originCommandId === row.result.checkId,
        location,
        "request original proof/command mismatch",
      );
  }
  if (assignment) {
    generated(assignment.id);
    requireValue(
      assignment.requestId === receipt.originalRequestId,
      location,
      "assignment belongs to another request",
    );
    if (refresh)
      requireValue(
        assignment.id === row.result.id &&
          assignment.revision === row.result.revision &&
          assignment.previousAssignmentId ===
            birth.positiveRows.assignment[0].id,
        location,
        "refresh result/predecessor mismatch",
      );
    else
      requireValue(
        assignment.revision === 1 &&
          assignment.previousAssignmentId === null &&
          ![
            row.result.requestId,
            row.result.checkId,
            row.result.assessmentId,
          ].includes(assignment.id),
        location,
        "invalid observed INITIAL assignment",
      );
  }
}

/** Validates schemaVersion 1 receipt structure/cross-bindings; never authenticates bytes.
 * expectedSessionUser should be supplied by the invoking host's verified transport
 * context: pdaa_api for ordinary probes, the actual owner login for quarantined restore.
 * Never assume observer.sessionUser must equal the effective SET LOCAL ROLE.
 */
export function validateReconciliationCommitReceipt(receipt, pins = {}) {
  object(
    pins,
    [],
    [
      "expectedCustomerId",
      "expectedSessionUser",
      "expectedPositiveProjectId",
      "expectedNegativeProjectId",
      "expectedOriginalRequestId",
    ],
    "pins",
  );
  object(
    receipt,
    [
      "schemaVersion",
      "customerId",
      "positiveProjectId",
      "negativeProjectId",
      "originalRequestId",
      "cases",
    ],
    [],
    "root",
  );
  requireValue(
    receipt.schemaVersion === 1,
    "root",
    "unsupported schema version",
  );
  for (const field of [
    "customerId",
    "positiveProjectId",
    "negativeProjectId",
    "originalRequestId",
  ])
    id(receipt[field], field);
  requireValue(
    receipt.positiveProjectId !== receipt.negativeProjectId,
    "root",
    "probe projects must differ",
  );
  requireValue(
    ![receipt.positiveProjectId, receipt.negativeProjectId].includes(
      receipt.originalRequestId,
    ),
    "root",
    "request aliases project identity",
  );
  for (const [pin, field] of [
    ["expectedCustomerId", "customerId"],
    ["expectedPositiveProjectId", "positiveProjectId"],
    ["expectedNegativeProjectId", "negativeProjectId"],
    ["expectedOriginalRequestId", "originalRequestId"],
  ]) {
    if (Object.hasOwn(pins, pin)) {
      id(pins[pin], pin);
      requireValue(
        receipt[field] === pins[pin],
        field,
        "external pin mismatch",
      );
    }
  }
  if (Object.hasOwn(pins, "expectedSessionUser"))
    requireValue(
      typeof pins.expectedSessionUser === "string" &&
        pins.expectedSessionUser.length > 0 &&
        pins.expectedSessionUser.length <= 63,
      "pins",
      "session login required",
    );
  requireValue(
    Array.isArray(receipt.cases) &&
      receipt.cases.length === reconciliationCommitCases.length,
    "cases",
    "exact case set required",
  );
  const seenIds = new Set(),
    cursors = new Map(),
    milestones = new Map();
  let observerPid, sessionUser, birth;
  for (const [index, row] of receipt.cases.entries()) {
    const location = `cases[${index}]`;
    object(
      row,
      [
        "mode",
        "customerId",
        "projectId",
        "milestoneId",
        "runtimeRole",
        "transactionPid",
        "transactionSessionUser",
        "nativePid",
        "callbackReturned",
        "nativeCommit",
        "nativeCommitAttempts",
        "callbackReturnedAtCommit",
        "commitObserver",
        "generatedIds",
        "generatedAbsence",
        "result",
        "positiveRows",
        "before",
        "after",
      ],
      [],
      location,
    );
    requireValue(
      row.mode === reconciliationCommitCases[index],
      location,
      "missing, duplicate, unknown or reordered case",
    );
    const fixture =
      row.mode === "positive-birth" ||
      row.mode === "wrong-reused-identity" ||
      refreshes.has(row.mode)
        ? "positive"
        : "negative";
    requireValue(
      row.customerId === receipt.customerId &&
        row.projectId === receipt[`${fixture}ProjectId`],
      location,
      "case scope differs from pinned fixture",
    );
    id(row.milestoneId, location);
    if (milestones.has(fixture))
      requireValue(
        milestones.get(fixture) === row.milestoneId,
        location,
        "case milestone changed within fixture",
      );
    else milestones.set(fixture, row.milestoneId);
    requireValue(
      row.runtimeRole === "pdaa_api",
      location,
      "wrong effective runtime role",
    );
    pid(row.transactionPid, location);
    pid(row.nativePid, location);
    requireValue(
      row.nativePid === row.transactionPid,
      location,
      "native COMMIT writer PID mismatch",
    );
    requireValue(
      row.callbackReturned === true,
      location,
      "transaction callback did not return",
    );
    requireValue(
      row.nativeCommitAttempts === 1,
      location,
      "exactly one native COMMIT required",
    );
    requireValue(
      row.callbackReturnedAtCommit === true,
      location,
      "callback did not return before COMMIT",
    );
    const observed = row.commitObserver;
    object(
      observed,
      ["observerPid", "writerPid", "sessionUser", "state", "query", "phase"],
      [],
      `${location}.commitObserver`,
    );
    pid(observed.observerPid, location);
    pid(observed.writerPid, location);
    requireValue(
      observed.writerPid === row.transactionPid &&
        observed.observerPid !== row.transactionPid,
      location,
      "observer/writer PID mismatch",
    );
    requireValue(
      typeof observed.sessionUser === "string" &&
        observed.sessionUser.length > 0 &&
        observed.sessionUser.length <= 63 &&
        !observed.sessionUser.includes("\0"),
      location,
      "invalid observer session user",
    );
    requireValue(
      row.transactionSessionUser === observed.sessionUser,
      location,
      "transaction and observer login differ",
    );
    requireValue(
      observed.state === "idle" && observed.phase === "native-commit-settled",
      location,
      "wrong observer phase/state",
    );
    requireValue(
      typeof observed.query === "string" &&
        observed.query.length <= 64 &&
        /^\s*COMMIT\s*;?\s*$/i.test(observed.query),
      location,
      "observer did not see COMMIT",
    );
    observerPid ??= observed.observerPid;
    sessionUser ??= observed.sessionUser;
    requireValue(
      observerPid === observed.observerPid &&
        sessionUser === observed.sessionUser,
      location,
      "observer backend/login changed",
    );
    if (Object.hasOwn(pins, "expectedSessionUser"))
      requireValue(
        observed.sessionUser === pins.expectedSessionUser,
        location,
        "session user external pin mismatch",
      );
    nativeResult(row.nativeCommit, row.mode, `${location}.nativeCommit`);
    requireValue(
      Array.isArray(row.generatedIds) &&
        row.generatedIds.length >= 2 &&
        row.generatedIds.length <= 10000,
      location,
      "bounded generated IDs required",
    );
    if (refreshes.has(row.mode))
      requireValue(
        row.generatedIds.length === 2,
        location,
        "refresh must generate assignment and audit IDs",
      );
    for (const generated of row.generatedIds) {
      id(generated, location);
      requireValue(
        !seenIds.has(generated),
        location,
        "generated UUID reused within/across cases",
      );
      requireValue(
        ![receipt.positiveProjectId, receipt.negativeProjectId].includes(
          generated,
        ),
        location,
        "generated UUID aliases a probe project",
      );
      seenIds.add(generated);
    }
    fingerprints(row.before, `${location}.before`);
    fingerprints(row.after, `${location}.after`);
    const prior = cursors.get(fixture);
    if (prior)
      requireValue(
        sameFingerprints(prior, row.before),
        location,
        "fixture fingerprint chain broken",
      );
    else
      for (const table of newTables)
        requireValue(
          row.before[table].count === 0,
          location,
          "fixture already contains Stage 3 history",
        );
    if (positives.has(row.mode)) {
      positiveDelta(row, location);
      positiveEvidence(row, receipt, birth, location);
      if (row.mode === "positive-birth") birth = row;
    } else {
      requireValue(
        row.result === null && row.positiveRows === null,
        location,
        "negative case carries positive result residue",
      );
      object(
        row.generatedAbsence,
        reconciliationCommitTables,
        [],
        `${location}.generatedAbsence`,
      );
      requireValue(
        reconciliationCommitTables.every(
          (table) => row.generatedAbsence[table] === 0,
        ),
        location,
        "generated-row absence not proven",
      );
      requireValue(
        sameFingerprints(row.before, row.after),
        location,
        "negative COMMIT changed committed fingerprints",
      );
    }
    cursors.set(fixture, row.after);
  }
  requireValue(
    receipt.cases[0].generatedIds.includes(receipt.originalRequestId),
    "originalRequestId",
    "not generated by the positive birth",
  );
  requireValue(
    milestones.get("positive") !== milestones.get("negative"),
    "root",
    "probe milestones alias each other",
  );
  for (const scopeId of [
    receipt.customerId,
    receipt.positiveProjectId,
    receipt.negativeProjectId,
    ...milestones.values(),
  ])
    requireValue(
      !seenIds.has(scopeId),
      "root",
      "generated UUID aliases fixture scope",
    );
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    customerId: receipt.customerId,
    positiveProjectId: receipt.positiveProjectId,
    negativeProjectId: receipt.negativeProjectId,
    originalRequestId: receipt.originalRequestId,
    observerPid,
    sessionUser,
    caseCount: receipt.cases.length,
    positiveControls: 3,
    negativeControls: 9,
    retainedEvidenceLimits: reconciliationReceiptLimits,
  });
}
