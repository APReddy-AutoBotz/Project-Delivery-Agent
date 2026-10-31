import {
  MilestoneStateDisagreementError, milestoneStateDisagreementSchema, projectFactIdSchema,
  type Actor, type MilestoneStateDisagreement, type MilestoneStateDisagreementRepository,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import { actorInput } from "./fact-authorization.js";
import { DatabaseCanonicalProjectRepository } from "./canonical-project.js";
import { DatabaseAuthorityRepository, resolveStoredAuthorityPrefix } from "./authority-persistence.js";

type Tx = Prisma.TransactionClient;
const denied = (): never => { throw new MilestoneStateDisagreementError("DENIED"); };
const unavailable = (): never => { throw new MilestoneStateDisagreementError("UNAVAILABLE"); };
const states = new Set(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]);

// This read does not mint conflict, assessment or request records. Project and
// leadership-grant locks remain held through complete response validation.
export class DatabaseMilestoneStateDisagreementRepository implements MilestoneStateDisagreementRepository {
  constructor(private readonly db: Database) {}

  async readLeadership(actorValue: Actor, projectValue: string, milestoneValue: string): Promise<MilestoneStateDisagreement> {
    let actor: Actor, projectId: string, milestoneId: string;
    try {
      actor = actorInput(actorValue);
      projectId = projectFactIdSchema.parse(projectValue);
      milestoneId = projectFactIdSchema.parse(milestoneValue);
      if (!actor.roles.includes("leadership")) return denied();
    } catch { return denied(); }
    let visible = false;
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        const projects = await tx.$queryRaw<{ portfolioId: string }[]>`
          SELECT "portfolioId" FROM public."Project" WHERE "customerId"=${actor.customerId}::uuid AND id=${projectId}::uuid FOR SHARE`;
        if (!projects[0]) return denied();
        const grants = await tx.$queryRaw<{ role: string }[]>`
          SELECT role FROM public."AccessGrant" WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject}
          AND (("scopeType"='project' AND "scopeId"=${projectId}::uuid)
            OR ("scopeType"='portfolio' AND "scopeId"=${projects[0].portfolioId}::uuid)) ORDER BY id FOR SHARE`;
        const roles = grants.filter((grant) => actor.roles.some((role) => role === grant.role)).map((grant) => grant.role);
        if (!roles.includes("leadership")) return denied();
        let detail;
        try {
          detail = await new DatabaseCanonicalProjectRepository(this.db).detailInTransaction(tx, actor, projectId,
            roles.some((role) => role === "pmo_admin" || role === "portfolio_manager"));
        } catch { return denied(); }
        if (!detail.configured || !detail.milestones.some((row) => row.id === milestoneId)) return denied();
        visible = true;
        return await this.observe(tx, actor, projectId, milestoneId);
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 20000 });
    } catch (error) {
      if (error instanceof MilestoneStateDisagreementError) throw error;
      throw new MilestoneStateDisagreementError(visible ? "UNAVAILABLE" : "DENIED");
    }
  }

  private async observe(tx: Tx, actor: Actor, projectId: string, milestoneId: string): Promise<MilestoneStateDisagreement> {
    const scope = { customerId: actor.customerId, projectId };
    const canonical = await tx.canonicalProject.findFirst({ where: { customerId: actor.customerId, id: projectId, sealed: true },
      include: { canonicalCreationReceipt_project: true } });
    if (!canonical?.canonicalCreationReceipt_project) return unavailable();
    const canonicalValid = await tx.$queryRaw<{ valid: boolean }[]>`SELECT public.valid_canonical_project(${projectId}::uuid) AS valid`;
    if (canonicalValid[0]?.valid !== true) return unavailable();
    const bindings = await tx.canonicalStateBinding.findMany({ where: { ...scope, sealed: true,
      targetKind: "MILESTONE", milestoneId, field: "state" }, take: 2 });
    if (bindings.length !== 1 || bindings[0]!.workItemId !== null) return unavailable();
    const binding = bindings[0]!;
    const valid = await tx.$queryRaw<{ valid: boolean }[]>`SELECT public.valid_canonical_state_binding(${binding.id}::uuid) AS valid`;
    if (valid[0]?.valid !== true) return unavailable();
    const fact = await tx.projectFact.findFirst({ where: { ...scope, id: binding.factId, factType: binding.factType } });
    if (!fact || fact.revision < 1 || fact.revision > 1000) return unavailable();
    // Do not lock the fact tuple after the project gate: an explicit tuple-first
    // lock path could wait for this project while this read waits for that tuple.
    // Supported v1 writers must instead be proved to take the project gate;
    // the joint reread below detects a changed binding or fact revision.
    const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    const asOf = clock[0]?.now;
    if (!asOf) return unavailable();
    const prefixes = await new DatabaseAuthorityRepository(this.db).loadAssessmentPrefixesInTransaction(tx, actor, projectId, [fact], asOf);
    const prefix = prefixes?.get(fact.id);
    if (!prefix || !prefix.aggregate || !prefix.event || prefix.aggregate.revision < 1 || prefix.aggregate.revision > 1000 || prefix.versions.length !== fact.revision ||
        prefix.versions.some((v, i) => v.revision !== i + 1 || v.provenance !== "HUMAN_CONFIRMED" || v.evidence.source.sourceType !== "human_statement") ||
        4 * prefix.versions.length + 4 * prefix.conflicts.length > 64000) return unavailable();
    const policies = await tx.authorityPolicyRevision.findMany({ where: { policyId: prefix.aggregate.id }, orderBy: { revision: "asc" }, take: 1001 });
    if (policies.length !== prefix.aggregate.revision || policies.some((row, i) => row.revision !== i + 1) ||
        !policies.some((row) => row.id === prefix.event!.id)) return unavailable();
    const policyValid = await tx.$queryRaw<{ valid: boolean }[]>`SELECT public.valid_authority_history(${prefix.aggregate.id}::uuid) AS valid`;
    if (policyValid[0]?.valid !== true) return unavailable();
    const conflictRevisions = prefix.conflicts.map((row) => row.revision).sort((a, b) => a - b);
    if (conflictRevisions.some((revision, index) => revision !== index + 1)) return unavailable();
    if (prefix.conflicts.length) {
      const conflictValidity = await tx.$queryRaw<{ valid: boolean }[]>`
        SELECT bool_and(public.valid_authority_conflict(id)) AS valid FROM public."FactAuthorityConflict"
        WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${projectId}::uuid AND "factId"=${fact.id}::uuid`;
      if (conflictValidity[0]?.valid !== true) return unavailable();
    }
    const access = new Map(prefix.access.map((row) => [row.sourceId, row]));
    if (access.size !== prefix.access.length || prefix.versions.some((version) => {
      const row = access.get(version.sourceId);
      return !row || row.factId !== fact.id || row.state !== "AVAILABLE" || row.readers.length !== 1 || row.readers[0]?.subject !== actor.subject;
    })) return unavailable();
    const coherent = await tx.$queryRaw<{ valid: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM public."CanonicalProject" c
        JOIN public."CanonicalCreationReceipt" r ON r."customerId"=c."customerId" AND r."projectId"=c.id
        JOIN public."Milestone" m ON m."customerId"=c."customerId" AND m."projectId"=c.id
        JOIN public."CanonicalStateBinding" b ON b."customerId"=c."customerId" AND b."projectId"=c.id AND b."milestoneId"=m.id
        JOIN public."ProjectFact" f ON f."customerId"=b."customerId" AND f."projectId"=b."projectId" AND f.id=b."factId"
        WHERE c."customerId"=${actor.customerId}::uuid AND c.id=${projectId}::uuid AND c.sealed
          AND r.id=${canonical.canonicalCreationReceipt_project.id}::uuid AND m.id=${milestoneId}::uuid
          AND b.id=${binding.id}::uuid AND b.sealed AND b."targetKind"='MILESTONE' AND b.field='state'
          AND b."workItemId" IS NULL AND b."factId"=${fact.id}::uuid AND b."factType"=${fact.factType}
          AND f."factType"=${fact.factType} AND f.revision=${fact.revision}) AS valid`;
    if (coherent[0]?.valid !== true) return unavailable();
    const { result } = resolveStoredAuthorityPrefix({ ...scope, factId: fact.id, factType: fact.factType }, asOf,
      prefix.event, prefix.versions, prefix.conflicts, prefix.access, true);
    if (result.status !== "CONFLICTING" || !result.policy || result.resolvedValue !== null ||
        result.versions.some((row) => row.visibility !== "available" || row.temporalApplicability === "AMBIGUOUS" ||
          (row.temporalApplicability === "APPLICABLE" && row.assessment.freshness !== "CURRENT") ||
          row.value.type !== "text" || !states.has(row.value.value))) return unavailable();
    const groups = result.conflicts.filter((item) => item.kind === "AUTHORITY_DISAGREEMENT");
    if (groups.length !== 1 || result.conflicts.some((item) => item.kind === "HIGHER_AUTHORITY_CONTRADICTION")) return unavailable();
    const candidates = new Set(result.candidateVersionIds), group = groups[0]!;
    if (candidates.size < 2 || candidates.size !== result.candidateVersionIds.length ||
        group.versionIds.length !== candidates.size || group.versionIds.some((id) => !candidates.has(id))) return unavailable();
    const conflicts = new Map(prefix.conflicts.map((row) => [row.id, row]));
    if (conflicts.size !== prefix.conflicts.length || result.conflicts.some((item) => {
      if (item.kind !== "RECORDED") return false;
      const saved = item.recordedConflictId && conflicts.get(item.recordedConflictId);
      return !saved || !candidates.has(saved.leftVersionId) || !candidates.has(saved.rightVersionId);
    })) return unavailable();
    const selected = new Map(result.versions.map((row) => [row.id, row]));
    const stored = new Map(prefix.versions.map((row) => [row.id, row]));
    if (selected.size !== result.versions.length || stored.size !== prefix.versions.length) return unavailable();
    const positions = new Map<string, { versionId: string; evidenceId: string; sourceId: string;
      provenance: "HUMAN_CONFIRMED"; effectiveAt: string; observedAt: string;
      versionValidUntil: string | null; assessedValidUntil: string }[]>();
    for (const id of [...candidates].sort()) {
      const version = selected.get(id), original = stored.get(id);
      if (!version || !original || version.visibility !== "available" || version.temporalApplicability !== "APPLICABLE" ||
          version.assessment.freshness !== "CURRENT" || !version.assessedValidUntil || version.value.type !== "text" ||
          !states.has(version.value.value) || version.provenance !== "HUMAN_CONFIRMED" || version.evidenceIds.length !== 1 ||
          version.evidenceIds[0] !== original.evidenceId || version.source.instanceId !== original.sourceId) return unavailable();
      const supports = positions.get(version.value.value) ?? [];
      supports.push({ versionId: id, evidenceId: original.evidenceId, sourceId: original.sourceId, provenance: "HUMAN_CONFIRMED",
        effectiveAt: version.effectiveAt, observedAt: version.observedAt,
        versionValidUntil: version.validUntil, assessedValidUntil: version.assessedValidUntil });
      positions.set(version.value.value, supports);
    }
    if (positions.size < 2 || JSON.stringify([...positions.values()].flat().map((row) => row.evidenceId).sort()) !==
        JSON.stringify([...group.evidenceIds].sort())) return unavailable();
    return milestoneStateDisagreementSchema.parse({ projectId, milestoneId, bindingId: binding.id, factId: fact.id,
      factType: fact.factType, asOf: asOf.toISOString(), policyRevisionId: result.policy.revisionId,
      positions: [...positions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([state, supports]) => ({ state, supports })) });
  }
}
