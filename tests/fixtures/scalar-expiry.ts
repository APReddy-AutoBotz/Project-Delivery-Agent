import { createHash } from "node:crypto";
import { scalarContractFixture } from "./scalar-reconciliation.js";
export const expiryRunId = "pdaa-acceptance-1234567890-abcdef12";
export function scalarExpiryFixture() {
  const f = scalarContractFixture();
  // Synthetic unit receipt only; the production producer retains original HTTP bytes.
  const body = JSON.parse(
    JSON.stringify({ request: f.request, assessment: f.assessment }).replaceAll(
      "abcdefab-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000001",
    ),
  );
  const issuedAt = Date.parse(f.assessment.asOf);
  const prefix = "/api/projects/" + f.request.projectId;
  const path = prefix + "/scalar-reconciliation-requests/" + f.request.id;
  const observed = (
    path: string,
    body: unknown,
    status: number,
    at: number,
  ) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return {
      path,
      at,
      body,
      status,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bodyBase64: bytes.toString("base64"),
    };
  };
  const denied = { statusCode: 401, message: "Sign-in required" };
  return {
    family: "scalar-natural-expiry/v1",
    runId: expiryRunId,
    customerId: "10000000-0000-4000-8000-000000000001",
    projectId: f.request.projectId,
    factId: f.request.factId,
    requestId: f.request.id,
    assessmentId: f.assessment.assessmentId,
    principal: { role: "pdaa_api", login: "pdaa_api" },
    issuedAt,
    expiresAt: issuedAt + 120000,
    loadedAt: issuedAt + 1000,
    clearedAt: issuedAt + 130000,
    original: observed(path, body, 200, issuedAt + 1000),
    denials: [path, prefix + "/scalar-reconciliation-requests"].map((p) =>
      observed(p, denied, 401, issuedAt + 122000),
    ),
    browserDenial: observed(path, denied, 401, issuedAt + 125000),
    projection: {
      before: "a".repeat(64),
      after: "a".repeat(64),
      counts: {
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
      },
    },
  };
}
