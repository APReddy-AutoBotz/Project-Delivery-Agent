import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { resolveSourceAuthority, scalarReconciliationIdentity } from "../packages/domain/src/index.js";
import { boundedResultReferences, verifyScalarOriginalRequestProof } from "../packages/data/src/scalar-request-proof.js";
import { scalarId as id, scalarScope, scalarSnapshot, scalarTime } from "./fixtures/scalar-reconciliation.js";
import { rawSqlText } from "./fixtures/read-only-sql.js";

function fixture() {
  const input = scalarSnapshot();
  input.policy!.tiers[0]!.selectors[0]!.sourceType = "human_statement";
  input.versions.forEach((version) => { version.provenance = "HUMAN_CONFIRMED"; });
  input.sources.forEach((source) => { source.sourceType = "human_statement"; });
  input.conflicts.push({ id: id(700), scope: { ...scalarScope }, detectedAt: scalarTime, resolvedAt: null,
    versionIds: [input.versions[0]!.id, input.versions[1]!.id] });
  const result = resolveSourceAuthority(input), identity = scalarReconciliationIdentity(result)!;
  const scope = { ...scalarScope }, actor = { customerId: scope.customerId, subject: "synthetic-leader", roles: ["leadership" as const] };
  const requestId = id(500), assessmentId = id(501), commandId = id(502), auditIds = [id(503), id(504), id(505)];
  const request = { ...scope, id: requestId, ruleRevision: "scalar-authority-conflict/v1", contributorHash: createHash("sha256").update(identity).digest("hex"), sealed: true, state: "OPEN",
    originalAssessmentId: assessmentId, originCommandId: commandId, auditEventId: auditIds[0]!, createdAt: new Date(scalarTime),
    identityBytes: Buffer.byteLength(identity) };
  const header = { ...scope, id: assessmentId, factRevision: 2, policyId: id(600), policyThroughRevision: 1,
    policyRevisionId: input.policy!.revisionId, conflictThroughRevision: 1, scalarReconciliationCheckId: commandId,
    captureKind: "SCALAR_REQUEST", evaluatorVersion: 1, sealed: true, complete: true, versionCount: 2, conflictCount: 1,
    asOf: new Date(scalarTime), bytes: Buffer.byteLength(JSON.stringify(result)) };
  const versions = input.versions.map((version, index) => ({ ...scope, id: version.id, revision: index + 1,
    sourceId: version.source.instanceId, evidenceId: version.evidenceIds[0]!, provenance: version.provenance, valueBytes: 64,
    evidenceCustomerId: scope.customerId, evidenceProjectId: scope.projectId, evidenceFactId: scope.factId,
    evidenceSourceId: version.source.instanceId, evidenceProvidedBy: "synthetic-author", sourceProvidedBy: "synthetic-author",
    sourceCustomerId: scope.customerId, sourceProjectId: scope.projectId,
    sourceFactId: scope.factId, sourceType: "human_statement" }));
  const links = versions.map((row) => ({ ...scope, versionId: row.id }));
  const policies = [{ id: input.policy!.revisionId, customerId: scope.customerId, projectId: scope.projectId, factType: scope.factType,
    policyId: header.policyId, revision: 1, state: "ENABLED", bytes: 100 }];
  const conflicts = [{ ...scope, id: id(700), revision: 1, leftVersionId: versions[0]!.id,
    rightVersionId: versions[1]!.id, policyRevisionId: input.policy!.revisionId }];
  const conflictLinks = [{ ...scope, conflictId: conflicts[0]!.id }];
  const access = versions.map((row) => ({ ...scope, sourceId: row.sourceId, state: "AVAILABLE", readers: [{ subject: actor.subject }] }));
  const checks = [{ ...scope, requestId, assessmentId, outcome: "CREATED", auditEventId: auditIds[1]! }];
  const assignments = [{ ...scope, requestId, auditEventId: auditIds[2]! }];
  const audits = auditIds.map((auditId) => ({ id: auditId, customerId: scope.customerId, bytes: 200 }));
  const state = { request, header, versions, links, policies, conflicts, conflictLinks, access, checks, assignments, audits,
    identity, returnedIdentity: identity, result: result as unknown, valid: true, nativeThrows: false, missingRequest: false, calls: [] as string[] };
  const query = vi.fn(async (arg: unknown) => {
    const sql = rawSqlText(arg); state.calls.push(sql);
    if (sql.includes("valid_scalar_reconciliation_request")) {
      if (state.nativeThrows) throw new Error("private native detail");
      return [{ valid: state.valid }];
    }
    if (sql.includes('FROM public."ScalarReconciliationRequest"') && sql.includes('AS "identityBytes"')) return state.missingRequest ? [] : [state.request];
    if (sql.includes('FROM public."ScalarReconciliationRequest"')) return [{ identity: state.returnedIdentity }];
    if (sql.includes('FROM public."FactAssessment"') && sql.includes("AS bytes")) return [state.header];
    if (sql.includes('FROM public."FactAssessment"')) return [{ result: state.result }];
    if (sql.includes('FROM public."ProjectFactVersion"')) return state.versions;
    if (sql.includes('FROM public."AuthorityPolicyRevision"')) return state.policies;
    if (sql.includes('FROM public."FactAuthorityConflict"')) return state.conflicts;
    if (sql.includes('FROM public."AuditEvent"')) return state.audits;
    throw new Error("unexpected SQL");
  });
  const tx = { $queryRaw: query,
    factAssessmentVersion: { findMany: vi.fn(async () => state.links) },
    factAssessmentConflict: { findMany: vi.fn(async () => state.conflictLinks) },
    factSourceAccess: { findMany: vi.fn(async () => state.access) },
    scalarReconciliationCheck: { findMany: vi.fn(async () => state.checks) },
    scalarReconciliationAssignment: { findMany: vi.fn(async () => state.assignments) },
    projectResponsibility: { findMany: vi.fn(async () => []) } };
  const run = () => verifyScalarOriginalRequestProof(tx as never, actor, scope, requestId, state.identity, new Date("2026-09-14T00:00:00.000Z"));
  return { state, tx, run };
}

it("checks bounded original proof and current access before the native validator", async () => {
  const f = fixture(); await expect(f.run()).resolves.toBeUndefined();
  expect(f.state.calls.at(-1)).toContain("valid_scalar_reconciliation_request");
  expect(f.state.calls.findIndex((sql) => sql.includes('AS "identityBytes"')))
    .toBeLessThan(f.state.calls.findIndex((sql) => sql.includes('AS identity')));
  expect(f.state.calls.findIndex((sql) => sql.includes('AS bytes FROM public."FactAssessment"')))
    .toBeLessThan(f.state.calls.findIndex((sql) => sql.includes('SELECT result FROM public."FactAssessment"')));
  expect(f.tx.factSourceAccess.findMany).toHaveBeenCalledOnce();
  expect(f.state.calls.some((sql) => sql.includes('FROM public."FactAuthorityConflict"'))).toBe(true);
  expect(f.tx.factAssessmentConflict.findMany).toHaveBeenCalledOnce();
});

it("bounds the combined reference budget before deep parsing", () => {
  const result = { candidateVersionIds: Array(1000).fill(id(1)), supportingVersionIds: Array(1000).fill(id(2)),
    supportingEvidenceIds: Array(62000).fill(id(3)), versions: [], conflicts: [], policy: { tiers: [] } };
  expect(boundedResultReferences(result)).toBe(true);
  result.supportingEvidenceIds.push(id(4));
  expect(boundedResultReferences(result)).toBe(false);
});

it.each(["missing", "request-scope", "unsealed", "identity-limit", "collision", "hash-mismatch", "header-limit", "header-fact-type", "version-scope", "version-budget",
  "version-link", "policy-budget", "conflict-scope", "conflict-endpoint", "conflict-policy", "conflict-link", "source-origin",
  "source-author", "evidence-source", "access-missing", "source-revoked", "reader-revoked", "result", "reference-overflow", "check-missing", "assignment-missing", "audit-missing", "audit-budget", "native-false", "native-throws"])(
  "returns the same unavailable error for %s", async (kind) => {
    const f = fixture();
    if (kind === "missing") f.state.missingRequest = true;
    if (kind === "request-scope") f.state.request.customerId = id(999);
    if (kind === "unsealed") f.state.request.sealed = false;
    if (kind === "identity-limit") f.state.request.identityBytes = 4_194_305;
    if (kind === "collision") f.state.returnedIdentity += "x";
    if (kind === "hash-mismatch") f.state.request.contributorHash = "0".repeat(64);
    if (kind === "header-limit") f.state.header.bytes = 4_194_305;
    if (kind === "header-fact-type") f.state.header.factType = "other.fact";
    if (kind === "version-scope") f.state.versions[0]!.projectId = id(999);
    if (kind === "version-budget") f.state.versions[0]!.valueBytes = 1_048_577;
    if (kind === "version-link") f.state.links[0]!.versionId = id(999);
    if (kind === "policy-budget") f.state.policies[0]!.bytes = 4_194_305;
    if (kind === "conflict-scope") f.state.conflicts[0]!.projectId = id(999);
    if (kind === "conflict-endpoint") f.state.conflicts[0]!.leftVersionId = id(999);
    if (kind === "conflict-policy") f.state.conflicts[0]!.policyRevisionId = id(999);
    if (kind === "conflict-link") f.state.conflictLinks[0]!.conflictId = id(999);
    if (kind === "source-origin") f.state.versions[0]!.sourceType = "connector";
    if (kind === "source-author") f.state.versions[0]!.sourceProvidedBy = "other";
    if (kind === "evidence-source") f.state.versions[0]!.evidenceSourceId = id(999);
    if (kind === "access-missing") f.state.access.pop();
    if (kind === "source-revoked") f.state.access[0]!.state = "REVOKED";
    if (kind === "reader-revoked") f.state.access[0]!.readers = [];
    if (kind === "result") f.state.result = { private: "not returned" };
    if (kind === "reference-overflow") {
      const result = structuredClone(f.state.result) as { conflicts: { versionIds: string[]; evidenceIds: string[] }[] };
      result.conflicts = Array.from({ length: 70 }, () => ({ versionIds: Array(1000).fill(id(10)), evidenceIds: [] }));
      f.state.result = result;
    }
    if (kind === "check-missing") f.state.checks.pop();
    if (kind === "assignment-missing") f.state.assignments.pop();
    if (kind === "audit-missing") f.state.audits.pop();
    if (kind === "audit-budget") f.state.audits[0]!.bytes = 16_385;
    if (kind === "native-false") f.state.valid = false;
    if (kind === "native-throws") f.state.nativeThrows = true;
    await expect(f.run()).rejects.toThrowError(/^Scalar request proof unavailable$/);
    if (kind !== "native-false" && kind !== "native-throws")
      expect(f.state.calls.some((sql) => sql.includes("valid_scalar_reconciliation_request"))).toBe(false);
  },
);
