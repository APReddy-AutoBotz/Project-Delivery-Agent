// FR-EVD-009 / SEC-AUTH-001: independent reader of real loaded-proof expiry.
import assert from "node:assert/strict";
import { response } from "./milestone-reconciliation-workflow-receipt.mjs";
import { assertAvailableScalarOriginal } from "./scalar-reconciliation-recovery-receipt.mjs";
const keys = (value, names) =>
  assert.deepEqual(Object.keys(value).sort(), names.sort());
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export function assertScalarExpiryReceipt(value, runId) {
  keys(value, [
    "family",
    "runId",
    "customerId",
    "projectId",
    "factId",
    "requestId",
    "assessmentId",
    "principal",
    "issuedAt",
    "expiresAt",
    "loadedAt",
    "clearedAt",
    "original",
    "denials",
    "browserDenial",
    "projection",
  ]);
  assert.equal(value.family, "scalar-natural-expiry/v1");
  assert.equal(value.runId, runId);
  // Only the existing isolated primary fixture, never a customer environment.
  assert.equal(value.customerId, "10000000-0000-4000-8000-000000000001");
  for (const name of ["projectId", "factId", "requestId", "assessmentId"])
    assert.match(value[name], uuid);
  assert.deepEqual(value.principal, { role: "pdaa_api", login: "pdaa_api" });
  for (const name of ["issuedAt", "expiresAt", "loadedAt", "clearedAt"])
    assert(Number.isSafeInteger(value[name]));
  assert.equal(value.expiresAt - value.issuedAt, 120000);
  assert(value.loadedAt >= value.issuedAt && value.loadedAt < value.expiresAt);
  assert(
    value.clearedAt >= value.expiresAt &&
      value.clearedAt - value.issuedAt < 240000,
  );
  const prefix = "/api/projects/" + value.projectId;
  const detail = prefix + "/scalar-reconciliation-requests/" + value.requestId;
  function observed(item, status, path) {
    keys(item, [
      "path",
      "at",
      "status",
      "bytes",
      "sha256",
      "bodyBase64",
      "body",
    ]);
    assert.equal(item.path, path);
    assert(Number.isSafeInteger(item.at));
    response(item, status);
  }
  observed(value.original, 200, detail);
  assert.equal(value.original.at, value.loadedAt);
  const original = value.original.body;
  // Host validation runs before dependency installation/build. Keep this reader
  // independent of the runtime's generated package and producer assertions.
  keys(original, ["request", "assessment"]);
  keys(original.request, [
    "id",
    "projectId",
    "factId",
    "factType",
    "createdAt",
    "state",
    "assignment",
  ]);
  keys(original.request.assignment, [
    "id",
    "revision",
    "occurredAt",
    "reason",
    "recipientSubject",
  ]);
  keys(original.assessment, [
    "assessmentId",
    "factId",
    "asOf",
    "historical",
    "replayed",
    "visibility",
    "revalidationRequired",
    "result",
  ]);
  const noCredentials = (item) => {
    if (Array.isArray(item)) item.forEach(noCredentials);
    else if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        assert(
          !/^(?:token|access_token|refresh_token|authorization|password|secret)$/i.test(
            key,
          ),
        );
        noCredentials(child);
      }
  };
  noCredentials(original);
  assertAvailableScalarOriginal(original.assessment, value.customerId, value);
  assert.equal(original.assessment.replayed, false);
  assert.equal(original.request.factId, value.factId);
  assert.equal(original.request.factType, "project.forecast");
  assert.equal(original.request.assignment.revision, 1);
  assert.equal(original.assessment.assessmentId, value.assessmentId);
  assert.equal(original.request.id, value.requestId);
  assert.equal(original.request.projectId, value.projectId);
  assert.equal(original.request.assignment.recipientSubject, "pm-atlas");
  assert.equal(original.request.assignment.reason, "ASSIGNED");
  assert.equal(original.request.state, "OPEN");
  assert.equal(value.denials.length, 2);
  for (const [index, path] of [
    detail,
    prefix + "/scalar-reconciliation-requests",
  ].entries())
    observed(value.denials[index], 401, path);
  assert(
    [
      prefix,
      prefix + "/canonical",
      prefix + "/milestone-assessments",
      prefix + "/reconciliation-requests",
      prefix + "/facts",
      detail,
      prefix + "/scalar-reconciliation-requests",
    ].includes(value.browserDenial.path),
  );
  observed(value.browserDenial, 401, value.browserDenial.path);
  for (const item of [...value.denials, value.browserDenial]) {
    assert(item.at >= value.expiresAt && item.at <= value.clearedAt);
    assert.deepEqual(item.body, {
      statusCode: 401,
      message: "Sign-in required",
    });
  }
  keys(value.projection, ["before", "after", "counts"]);
  assert.match(value.projection.before, digest);
  assert.equal(value.projection.after, value.projection.before);
  assert.deepEqual(value.projection.counts, {
    ScalarReconciliationCheck: 1,
    ScalarReconciliationRequest: 1,
    ScalarReconciliationAssignment: 1,
    FactAssessment: 1,
    FactAssessmentVersion: 2,
    FactAssessmentConflict: 1,
    FactAuthorityConflict: 1,
    ProjectFact: 1,
    ProjectFactVersion: 2,
    FactEvidence: 2,
    FactSource: 2,
    FactSourceAccess: 2,
    AuthorityPolicy: 1,
    AuthorityPolicyRevision: 1,
    AuthorityPolicyReceipt: 1,
  });
  return true;
}
