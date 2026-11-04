import { createHash } from "node:crypto";
import { scalarReconciliationIdentity, scalarReconciliationRuleRevision, projectFactIdSchema, type Actor } from "@pdaa/domain";
import { actorInput } from "./fact-authorization.js";
import type { Prisma } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
type Scope = { customerId: string; projectId: string; factId: string; factType: string };
type Scoped = { customerId: string; projectId: string; factId: string };
const maxRows = 1000, maxIdentityBytes = 4_194_304, maxValues = 1_048_576, maxPolicyBytes = 4_194_304;
const unavailable = (): never => { throw new Error("Scalar request proof unavailable"); };
const validCount = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= maxRows;
const inScope = (row: Scoped, scope: Scope) => row.customerId === scope.customerId && row.projectId === scope.projectId && row.factId === scope.factId;
const unique = (values: readonly string[]) => new Set(values).size === values.length;

// Bound combined nested references before the domain parser clones the result.
export function boundedResultReferences(value: unknown): boolean {
  const object = (item: unknown): Record<string, unknown> | null =>
    item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
  const root = object(value); if (!root) return false;
  let references = 0;
  const array = (item: unknown, maximum: number): unknown[] | null => {
    if (!Array.isArray(item) || item.length > maximum) return null;
    references += item.length;
    return references <= 64000 ? item : null;
  };
  for (const key of ["candidateVersionIds", "supportingVersionIds", "supportingEvidenceIds"])
    if (!array(root[key], key === "supportingEvidenceIds" ? 64000 : 1000)) return false;
  const versions = array(root.versions, 1000), conflicts = array(root.conflicts, 1002);
  if (!versions || !conflicts) return false;
  for (const raw of versions) {
    const row = object(raw);
    if (!row || !array(row.evidenceIds, 64) || !array(row.unresolvedConflictIds, 1000) || !array(row.eligibilityReasons, 8)) return false;
  }
  for (const raw of conflicts) {
    const row = object(raw);
    if (!row || !array(row.versionIds, 1000) || !array(row.evidenceIds, 64000)) return false;
  }
  const policy = object(root.policy), tiers = policy && array(policy.tiers, 16);
  if (!tiers) return false;
  for (const raw of tiers) { const row = object(raw); if (!row || !array(row.selectors, 32)) return false; }
  return true;
}

// Internal positive-proof check only. The caller owns the transaction, an
// authenticated actor, project/grant fence, selected fact and database clock.
// This helper must never be exposed as a request-ID lookup or negative result.
export async function verifyScalarOriginalRequestProof(
  tx: Tx, actorValue: Actor, scope: Scope, requestValue: string, identity: string, asOf: Date,
): Promise<void> {
  try {
    const actor = actorInput(actorValue), requestId = projectFactIdSchema.parse(requestValue);
    projectFactIdSchema.parse(scope.customerId); projectFactIdSchema.parse(scope.projectId); projectFactIdSchema.parse(scope.factId);
    if (actor.customerId !== scope.customerId || !/^[a-z][a-z0-9_.-]{0,95}$/.test(scope.factType) || !Number.isFinite(asOf.getTime()) ||
      typeof identity !== "string" || Buffer.byteLength(identity, "utf8") < 1 || Buffer.byteLength(identity, "utf8") > maxIdentityBytes)
      return unavailable();
    const requests = await tx.$queryRaw<(Scoped & { id: string; ruleRevision: string; contributorHash: string; sealed: boolean; state: string;
      originalAssessmentId: string; originCommandId: string; auditEventId: string; createdAt: Date; identityBytes: number })[]>`
      SELECT id,"customerId","projectId","factId","ruleRevision","contributorHash",sealed,state,"originalAssessmentId","originCommandId",
        "auditEventId","createdAt",octet_length("contributorIdentity")::int AS "identityBytes"
      FROM public."ScalarReconciliationRequest" WHERE id=${requestId}::uuid`;
    const request = requests[0];
    if (requests.length !== 1 || !request || !inScope(request, scope) || request.ruleRevision !== scalarReconciliationRuleRevision ||
      request.sealed !== true || request.state !== "OPEN" || !(request.createdAt instanceof Date) ||
      !Number.isFinite(request.createdAt.getTime()) || request.createdAt > asOf ||
      !Number.isSafeInteger(request.identityBytes) || request.identityBytes < 1 || request.identityBytes > maxIdentityBytes)
      return unavailable();
    const identityRows = await tx.$queryRaw<{ identity: string }[]>`
      SELECT "contributorIdentity" AS identity FROM public."ScalarReconciliationRequest"
      WHERE id=${requestId}::uuid AND octet_length("contributorIdentity")<=${maxIdentityBytes}`;
    if (identityRows.length !== 1 || identityRows[0]?.identity !== identity || Buffer.byteLength(identity, "utf8") !== request.identityBytes ||
      request.contributorHash !== createHash("sha256").update(identity, "utf8").digest("hex"))
      return unavailable();

    const headers = await tx.$queryRaw<(Scoped & { id: string; factType: string; factRevision: number; policyId: string | null;
      policyThroughRevision: number | null; policyRevisionId: string | null; conflictThroughRevision: number | null;
      scalarReconciliationCheckId: string | null; captureKind: string; evaluatorVersion: number; sealed: boolean; complete: boolean;
      versionCount: number; conflictCount: number; asOf: Date; bytes: number })[]>`
      SELECT id,"customerId","projectId","factId","factType","factRevision","policyId","policyThroughRevision","policyRevisionId",
        "conflictThroughRevision","scalarReconciliationCheckId","captureKind","evaluatorVersion",sealed,complete,"versionCount","conflictCount",
        "asOf",octet_length(result::text)::int AS bytes FROM public."FactAssessment" WHERE id=${request.originalAssessmentId}::uuid`;
    const header = headers[0];
    if (headers.length !== 1 || !header || !inScope(header, scope) || header.factType !== scope.factType ||
      header.captureKind !== "SCALAR_REQUEST" || header.scalarReconciliationCheckId !== request.originCommandId ||
      header.evaluatorVersion !== 1 || header.sealed !== true || header.complete !== true ||
      !validCount(header.factRevision, 2) || header.versionCount !== header.factRevision || !validCount(header.conflictCount) ||
      (header.conflictCount === 0 ? header.conflictThroughRevision !== null : header.conflictThroughRevision !== header.conflictCount) ||
      !header.policyId || !header.policyRevisionId || header.policyThroughRevision === null || !validCount(header.policyThroughRevision, 1) ||
      !(header.asOf instanceof Date) || header.asOf.getTime() !== request.createdAt.getTime() ||
      !Number.isSafeInteger(header.bytes) || header.bytes < 1 || header.bytes > maxIdentityBytes) return unavailable();

    type Version = Scoped & { id: string; revision: number; sourceId: string; evidenceId: string; provenance: string; valueBytes: number;
      evidenceCustomerId: string | null; evidenceProjectId: string | null; evidenceFactId: string | null; evidenceSourceId: string | null;
      evidenceProvidedBy: string | null; sourceProvidedBy: string | null;
      sourceCustomerId: string | null; sourceProjectId: string | null; sourceFactId: string | null; sourceType: string | null };
    const versions = await tx.$queryRaw<Version[]>`
      SELECT v.id,v."customerId",v."projectId",v."factId",v.revision,v."sourceId",v."evidenceId",v.provenance,
        octet_length(v.value::text)::int AS "valueBytes",e."customerId" AS "evidenceCustomerId",e."projectId" AS "evidenceProjectId",
        e."factId" AS "evidenceFactId",e."sourceId" AS "evidenceSourceId",e."providedBy" AS "evidenceProvidedBy",
        s."providedBy" AS "sourceProvidedBy",s."customerId" AS "sourceCustomerId",
        s."projectId" AS "sourceProjectId",s."factId" AS "sourceFactId",s."sourceType" AS "sourceType"
      FROM public."ProjectFactVersion" v LEFT JOIN public."FactEvidence" e ON e.id=v."evidenceId"
      LEFT JOIN public."FactSource" s ON s.id=v."sourceId"
      WHERE v."factId"=${scope.factId}::uuid AND v.revision<=${header.factRevision} ORDER BY v.revision,v.id LIMIT 1001`;
    if (versions.length !== header.versionCount || !unique(versions.map((row) => row.id)) || !unique(versions.map((row) => row.evidenceId))) return unavailable();
    let valueBytes = 0;
    for (const [index, row] of versions.entries()) {
      if (!inScope(row, scope) || row.revision !== index + 1 || row.provenance !== "HUMAN_CONFIRMED" || row.sourceType !== "human_statement" ||
        row.evidenceCustomerId !== scope.customerId || row.evidenceProjectId !== scope.projectId || row.evidenceFactId !== scope.factId || row.evidenceSourceId !== row.sourceId ||
        !row.evidenceProvidedBy || row.evidenceProvidedBy !== row.sourceProvidedBy ||
        row.sourceCustomerId !== scope.customerId || row.sourceProjectId !== scope.projectId || row.sourceFactId !== scope.factId ||
        !Number.isSafeInteger(row.valueBytes) || row.valueBytes < 1 || (valueBytes += row.valueBytes) > maxValues) return unavailable();
    }
    const links = await tx.factAssessmentVersion.findMany({ where: { assessmentId: header.id },
      select: { customerId: true, projectId: true, factId: true, versionId: true }, take: maxRows + 1 });
    const versionIds = new Set(versions.map((row) => row.id));
    if (links.length !== versions.length || !unique(links.map((row) => row.versionId)) ||
      links.some((row) => !inScope(row, scope) || !versionIds.has(row.versionId))) return unavailable();

    type Policy = { id: string; customerId: string; projectId: string; policyId: string; factType: string; revision: number;
      state: string; bytes: number | null };
    const policies = await tx.$queryRaw<Policy[]>`
      SELECT id,"customerId","projectId","policyId","factType",revision,state,
        CASE WHEN definition IS NULL THEN NULL ELSE octet_length(definition::text)::int END AS bytes
      FROM public."AuthorityPolicyRevision" WHERE "policyId"=${header.policyId}::uuid AND revision<=${header.policyThroughRevision}
      ORDER BY revision,id LIMIT 1001`;
    if (policies.length !== header.policyThroughRevision || !unique(policies.map((row) => row.id))) return unavailable();
    let policyBytes = 0;
    for (const [index, row] of policies.entries()) {
      if (row.customerId !== scope.customerId || row.projectId !== scope.projectId || row.factType !== scope.factType ||
        row.policyId !== header.policyId || row.revision !== index + 1 ||
        (row.state === "DISABLED" ? row.bytes !== null : row.state !== "ENABLED" || !Number.isSafeInteger(row.bytes) || row.bytes! < 1 || (policyBytes += row.bytes!) > maxPolicyBytes))
        return unavailable();
    }
    const policyIds = new Set(policies.map((row) => row.id));
    if (!policyIds.has(header.policyRevisionId)) return unavailable();

    type Conflict = Scoped & { id: string; revision: number; leftVersionId: string; rightVersionId: string; policyRevisionId: string };
    const conflicts = header.conflictThroughRevision === null ? [] : await tx.$queryRaw<Conflict[]>`
      SELECT id,"customerId","projectId","factId",revision,"leftVersionId","rightVersionId","policyRevisionId"
      FROM public."FactAuthorityConflict" WHERE "factId"=${scope.factId}::uuid AND revision<=${header.conflictThroughRevision}
      ORDER BY revision,id LIMIT 1001`;
    if (conflicts.length !== header.conflictCount || !unique(conflicts.map((row) => row.id)) || conflicts.some((row, index) =>
      !inScope(row, scope) || row.revision !== index + 1 || !versionIds.has(row.leftVersionId) || !versionIds.has(row.rightVersionId) ||
      row.leftVersionId === row.rightVersionId || !policyIds.has(row.policyRevisionId))) return unavailable();
    const conflictLinks = await tx.factAssessmentConflict.findMany({ where: { assessmentId: header.id },
      select: { customerId: true, projectId: true, factId: true, conflictId: true }, take: maxRows + 1 });
    const conflictIds = new Set(conflicts.map((row) => row.id));
    if (conflictLinks.length !== conflicts.length || !unique(conflictLinks.map((row) => row.conflictId)) ||
      conflictLinks.some((row) => !inScope(row, scope) || !conflictIds.has(row.conflictId))) return unavailable();

    const sourceIds = [...new Set(versions.map((row) => row.sourceId))];
    const access = await tx.factSourceAccess.findMany({ where: { sourceId: { in: sourceIds } },
      select: { customerId: true, projectId: true, factId: true, sourceId: true, state: true,
        readers: { where: { subject: actor.subject }, select: { subject: true }, take: 2 } }, take: maxRows + 1 });
    if (access.length !== sourceIds.length || !unique(access.map((row) => row.sourceId)) || access.some((row) =>
      !inScope(row, scope) || !sourceIds.includes(row.sourceId) || row.state !== "AVAILABLE" ||
      row.readers.length !== 1 || row.readers[0]?.subject !== actor.subject)) return unavailable();

    const results = await tx.$queryRaw<{ result: unknown }[]>`
      SELECT result FROM public."FactAssessment" WHERE id=${header.id}::uuid AND octet_length(result::text)<=${maxIdentityBytes}`;
    if (results.length !== 1 || !boundedResultReferences(results[0]?.result) || scalarReconciliationIdentity(results[0]?.result) !== identity) return unavailable();
    const checks = await tx.scalarReconciliationCheck.findMany({ where: { id: request.originCommandId },
      select: { customerId: true, projectId: true, factId: true, requestId: true, assessmentId: true, outcome: true, auditEventId: true }, take: 2 });
    const assignments = await tx.scalarReconciliationAssignment.findMany({ where: { requestId, revision: 1 },
      select: { customerId: true, projectId: true, factId: true, requestId: true, auditEventId: true }, take: 2 });
    if (checks.length !== 1 || !checks[0] || !inScope(checks[0], scope) || checks[0].requestId !== requestId ||
      checks[0].assessmentId !== header.id || checks[0].outcome !== "CREATED" || assignments.length !== 1 || !assignments[0] ||
      !inScope(assignments[0], scope) || assignments[0].requestId !== requestId) return unavailable();
    const auditIds = [request.auditEventId, checks[0].auditEventId, assignments[0].auditEventId];
    if (!unique(auditIds)) return unavailable();
    const audits = await tx.$queryRaw<{ id: string; customerId: string; bytes: number }[]>`
      SELECT id,"customerId",octet_length(detail::text)::int AS bytes FROM public."AuditEvent"
      WHERE id=ANY(${auditIds}::uuid[]) LIMIT 4`;
    if (audits.length !== 3 || !unique(audits.map((row) => row.id)) || audits.some((row) =>
      row.customerId !== scope.customerId || !auditIds.includes(row.id) || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 16384)) return unavailable();
    const responsibilities = await tx.projectResponsibility.findMany({ where: { customerId: scope.customerId, projectId: scope.projectId, role: "PROJECT_MANAGER" },
      select: { id: true }, take: 51 });
    if (responsibilities.length > 50) return unavailable();
    const valid = await tx.$queryRaw<{ valid: boolean }[]>`SELECT public.valid_scalar_reconciliation_request(${requestId}::uuid) AS valid`;
    if (valid.length !== 1 || valid[0]?.valid !== true) return unavailable();
  } catch { return unavailable(); }
}
