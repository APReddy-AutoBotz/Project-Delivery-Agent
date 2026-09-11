// Host-side acceptance gate: no browser/package dependency before image builds.
import assert from "node:assert/strict";
export function assertEvidenceWorkflowReceipt(value) {
  assert.equal(value.status, "passed");
  assert.equal(value.factType, "acceptance.forecast");
  assert.match(value.originalAssessmentId, /^[0-9a-f-]{36}$/);
  assert.match(value.screenshot.sha256, /^[0-9a-f]{64}$/);
  assert.equal(value.screenshot.file, "evidence-stale-conflict.png");
  const {
    changedSourceBefore,
    changedSourceAfter,
    firstHistory,
    retainedHistory,
    original,
    conflict,
    stale,
    restricted,
  } = value.observations;
  assert.deepEqual(changedSourceAfter.entries[0], changedSourceBefore.entry);
  assert.equal(
    changedSourceAfter.entries[1].sourceId,
    changedSourceBefore.entry.sourceId,
  );
  assert.deepEqual(changedSourceAfter.entries[0].content.value, {
    type: "number",
    value: 10,
  });
  assert.deepEqual(changedSourceAfter.entries[1].content.value, {
    type: "number",
    value: 20,
  });
  assert.equal(firstHistory.entries.length, 1);
  assert.equal(retainedHistory.entries.length, 2);
  for (const key of ["id", "revision", "sourceId", "evidenceId", "content"])
    assert.deepEqual(
      retainedHistory.entries[0][key],
      firstHistory.entries[0][key],
    );
  assert.equal(original.assessmentId, value.originalAssessmentId);
  assert.equal(original.result.status, "RESOLVED");
  assert.equal(original.result.versions[0].assessment.freshness, "CURRENT");
  assert.equal(conflict.result.status, "CONFLICTING");
  assert.equal(stale.result.versions.length, 2);
  assert(
    stale.result.versions.every(
      (v) =>
        v.assessment.provenance === "HUMAN_CONFIRMED" &&
        v.assessment.freshness === "STALE" &&
        v.assessment.conflict === "CONFLICTING",
    ),
  );
  assert.equal(restricted.assessmentId, original.assessmentId);
  assert.equal(restricted.visibility, "restricted");
  assert.equal(restricted.result, null);
  for (const key of [
    "emptyAuthorizedHistory",
    "reviewedHumanStatement",
    "originalHistoryPreserved",
    "pmoOnlyReviewedSharing",
    "identicalStatementReplay",
    "currentConflict",
    "humanStaleConflict",
    "configuredExpiryWarning",
    "subsequentPolicyOnly",
    "sourceRevalidationWithheld",
    "savedLinkAfterRecreation",
    "projectRevocationDenied",
  ])
    assert.equal(value[key], true, key);
}
