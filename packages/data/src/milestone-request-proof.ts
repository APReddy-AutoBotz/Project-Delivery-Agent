import { createHash } from "node:crypto";
import type { Actor, MilestoneConflictObservation } from "@pdaa/domain";
import type { Prisma } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
const maxVersions = 1000, maxTargets = 51, maxBytes = 4 * 1024 * 1024;
const unavailable = (): never => { throw new Error("Milestone request proof unavailable"); };

// Called only inside the already authorized project-gated observation
// transaction. A hash is an index input, never a substitute for exact identity.
export async function findMatchingMilestoneRequest(
  tx: Tx, actor: Actor, observation: MilestoneConflictObservation, contributorIdentity: string,
): Promise<"MATCHING_REQUEST_RECORDED" | "NO_MATCHING_REQUEST_RECORDED"> {
  if (observation.outcome !== "CONFLICTING" || !contributorIdentity || Buffer.byteLength(contributorIdentity, "utf8") > maxBytes)
    return unavailable();
  const scope = { customerId: actor.customerId, projectId: observation.projectId };
  const contributorHash = createHash("sha256").update(contributorIdentity, "utf8").digest("hex");
  const request = await tx.milestoneReconciliationRequest.findUnique({ where: {
    customerId_projectId_milestoneId_ruleRevision_contributorHash: { ...scope, milestoneId: observation.milestoneId,
      ruleRevision: observation.ruleRevision, contributorHash },
  }, select: { id: true, sealed: true, state: true, contributorIdentity: true, originalAssessmentId: true, createdAt: true } });
  if (!request) return "NO_MATCHING_REQUEST_RECORDED";
  if (!request.sealed || request.state !== "OPEN" || request.contributorIdentity !== contributorIdentity ||
      request.createdAt.toISOString() > observation.asOf) return unavailable();

  // Inspect lengths/counts before loading frozen proof JSON or invoking the
  // native validator. Each relation below has an overflow sentinel.
  const headers = await tx.$queryRaw<{ id: string; sealed: boolean; complete: boolean; status: string;
    milestoneId: string; ruleRevision: string; targetCount: number; requiredLinkCount: number;
    versionCount: number; evidenceCount: number; conflictCount: number; contributorCount: number; bytes: number }[]>`
    SELECT id,sealed,complete,status,"milestoneId","ruleRevision","targetCount","requiredLinkCount",
      "versionCount","evidenceCount","conflictCount","contributorCount",octet_length(result::text)::int AS bytes
    FROM public."MilestoneConsistencyAssessment" WHERE "customerId"=${scope.customerId}::uuid
      AND "projectId"=${scope.projectId}::uuid AND id=${request.originalAssessmentId}::uuid`;
  const header = headers[0];
  if (!header || !header.sealed || !header.complete || header.status !== "CONFLICTING" ||
      header.milestoneId !== observation.milestoneId || header.ruleRevision !== observation.ruleRevision ||
      header.targetCount < 2 || header.targetCount > maxTargets || header.requiredLinkCount !== header.targetCount - 1 ||
      header.versionCount < 2 || header.versionCount > maxVersions || header.evidenceCount !== header.versionCount ||
      header.conflictCount < 0 || header.conflictCount > maxVersions || header.contributorCount < 2 ||
      header.contributorCount > maxVersions || header.bytes < 1 || header.bytes > maxBytes) return unavailable();
  const targets = await tx.milestoneConsistencyTarget.findMany({ where: { ...scope, assessmentId: header.id },
    select: { id: true, scalarAssessmentId: true }, take: maxTargets + 1 });
  const childBytes = await tx.$queryRaw<{ id: string; bytes: number }[]>`
    SELECT id,octet_length(result::text)::int AS bytes FROM public."FactAssessment"
    WHERE "customerId"=${scope.customerId}::uuid AND "projectId"=${scope.projectId}::uuid
      AND "milestoneAssessmentId"=${header.id}::uuid ORDER BY id LIMIT ${maxTargets + 1}`;
  const children = await tx.factAssessment.findMany({ where: { ...scope, milestoneAssessmentId: header.id },
    select: { id: true, factId: true, sealed: true, complete: true, versionCount: true, conflictCount: true,
      policyThroughRevision: true, conflictThroughRevision: true }, take: maxTargets + 1 });
  if (targets.length !== header.targetCount || children.length !== targets.length || childBytes.length !== children.length ||
      childBytes.some((row) => row.bytes < 1 || row.bytes > maxBytes) ||
      header.bytes + childBytes.reduce((sum, row) => sum + row.bytes, 0) > maxBytes ||
      new Set(children.map((row) => row.id)).size !== children.length ||
      new Set(childBytes.map((row) => row.id)).size !== children.length ||
      childBytes.some((row) => !children.some((child) => child.id === row.id)) ||
      targets.some((row) => !row.scalarAssessmentId || !children.some((child) => child.id === row.scalarAssessmentId)) ||
      new Set(targets.map((row) => row.scalarAssessmentId)).size !== children.length ||
      children.some((row) => !row.sealed || !row.complete || row.versionCount < 1 || row.versionCount > maxVersions ||
        row.conflictCount < 0 || row.conflictCount > maxVersions || (row.policyThroughRevision ?? 0) > maxVersions ||
        (row.conflictThroughRevision ?? 0) > maxVersions) ||
      children.reduce((sum, row) => sum + row.versionCount, 0) !== header.versionCount ||
      children.reduce((sum, row) => sum + row.conflictCount, 0) !== header.conflictCount) return unavailable();
  const ids = children.map((row) => row.id);
  const versions = await tx.factAssessmentVersion.findMany({ where: { ...scope, assessmentId: { in: ids } },
    select: { assessmentId: true, factId: true, versionId: true, version: { select: { id: true, factId: true, sourceId: true,
      provenance: true, evidence: { select: { source: { select: { id: true, factId: true, sourceType: true } } } } } } },
    take: maxVersions + 1 });
  const conflicts = await tx.factAssessmentConflict.findMany({ where: { ...scope, assessmentId: { in: ids } },
    select: { assessmentId: true, factId: true }, take: maxVersions + 1 });
  const contributors = await tx.milestoneConsistencyContributorVersion.findMany({ where: { ...scope, assessmentId: header.id },
    select: { targetRowId: true, versionId: true }, take: maxVersions + 1 });
  if (versions.length !== header.versionCount || conflicts.length !== header.conflictCount ||
      contributors.length !== header.contributorCount || versions.length > maxVersions || conflicts.length > maxVersions ||
      contributors.length > maxVersions || children.some((child) =>
        versions.filter((row) => row.assessmentId === child.id && row.factId === child.factId).length !== child.versionCount ||
        conflicts.filter((row) => row.assessmentId === child.id && row.factId === child.factId).length !== child.conflictCount) ||
      versions.some((row) => row.versionId !== row.version.id || row.factId !== row.version.factId ||
        row.version.provenance !== "HUMAN_CONFIRMED" || row.version.evidence.source.id !== row.version.sourceId ||
        row.version.evidence.source.factId !== row.factId || row.version.evidence.source.sourceType !== "human_statement") ||
      contributors.some((row) => !targets.some((target) => target.id === row.targetRowId) ||
        !versions.some((version) => version.versionId === row.versionId))) return unavailable();
  const sourceIds = [...new Set(versions.map((row) => row.version.sourceId))];
  const access = await tx.factSourceAccess.findMany({ where: { ...scope, sourceId: { in: sourceIds } },
    select: { sourceId: true, factId: true, state: true, readers: { where: { subject: actor.subject }, select: { subject: true } } },
    take: maxVersions + 1 });
  if (access.length !== sourceIds.length || versions.some((row) => {
    const entry = access.find((item) => item.sourceId === row.version.sourceId);
    return !entry || entry.factId !== row.factId || entry.state !== "AVAILABLE" ||
      entry.readers.length !== 1 || entry.readers[0]?.subject !== actor.subject;
  })) return unavailable();
  const valid = await tx.$queryRaw<{ valid: boolean }[]>`SELECT public.valid_milestone_reconciliation_request(${request.id}::uuid) AS valid`;
  if (valid[0]?.valid !== true) return unavailable();
  return "MATCHING_REQUEST_RECORDED";
}
