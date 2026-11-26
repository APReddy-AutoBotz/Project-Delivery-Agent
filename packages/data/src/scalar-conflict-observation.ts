import {
  ScalarConflictObservationError, projectFactIdSchema, scalarConflictObservationSchema, factCatalogueRequestSchema,
  type Actor, type ScalarConflictObservation, type ScalarConflictObservationRepository,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import { actorInput } from "./fact-authorization.js";
import { DatabaseAuthorityRepository, resolveStoredAuthorityPrefix } from "./authority-persistence.js";
import { matchesUnrankedFactPrefix, preflightMilestoneFactVersions } from "./milestone-observation-preflight.js";

type Tx = Prisma.TransactionClient;
const denied = (): never => { throw new ScalarConflictObservationError("DENIED"); };
const unavailable = (): never => { throw new ScalarConflictObservationError("UNAVAILABLE"); };

export class DatabaseScalarConflictObservationRepository implements ScalarConflictObservationRepository {
  constructor(private readonly db: Database) {}

  async readLeadership(actorValue: Actor, projectValue: string, factValue: string, afterFactType: string | null = null,
    includeResolved = false, priorAssessmentId?: string): Promise<ScalarConflictObservation> {
    let actor: Actor, projectId: string, factId: string, after: string | null, priorId: string | undefined;
    try {
      actor = actorInput(actorValue);
      projectId = projectFactIdSchema.parse(projectValue);
      factId = projectFactIdSchema.parse(factValue);
      after = factCatalogueRequestSchema.parse({ projectId, afterFactType, limit: 50 }).afterFactType;
      priorId = priorAssessmentId === undefined ? undefined : projectFactIdSchema.parse(priorAssessmentId);
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
        if (!grants.some((grant) => grant.role === "leadership" && actor.roles.includes("leadership"))) return denied();
        const page = await tx.projectFact.findMany({ where: { customerId: actor.customerId, projectId,
          ...(after === null ? {} : { factType: { gt: after } }) },
          orderBy: { factType: "asc" }, take: 51, select: { id: true, factType: true, revision: true } });
        const fact = page.slice(0, 50).find((row) => row.id === factId);
        if (!fact) return denied();
        visible = true;
        const current = await this.observe(tx, actor, projectId, fact, includeResolved || Boolean(priorId));
        if (!priorId) return current;
        if (!("status" in current)) return unavailable();
        const prior = await this.priorAssessment(tx, actor, current, priorId);
        return scalarConflictObservationSchema.parse({ ...current, prior });
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 20000 });
    } catch (error) {
      if (error instanceof ScalarConflictObservationError) throw error;
      throw new ScalarConflictObservationError(visible ? "UNAVAILABLE" : "DENIED");
    }
  }

  private async priorAssessment(tx: Tx, actor: Actor, current: ScalarConflictObservation, assessmentId: string) {
    const { projectId, factId, factType } = current;
    const found = await tx.factAssessment.findFirst({
      where: { id: assessmentId, customerId: actor.customerId, projectId, factId, sealed: true }, select: { id: true },
    });
    if (!found) return denied();
    const authority = new DatabaseAuthorityRepository(this.db);
    const saved = await authority.deliverAssessmentInTransaction(tx, actor, projectId, assessmentId, false);
    if (!saved || saved.assessmentId !== assessmentId || saved.factId !== factId || saved.visibility !== "available") return denied();
    const result = saved.result;
    if (saved.asOf > current.asOf || result.asOf !== saved.asOf || result.scope.factType !== factType ||
        result.scope.customerId !== actor.customerId || result.scope.projectId !== projectId || result.scope.factId !== factId ||
        result.status !== "RESOLVED" || !result.policy || result.resolvedValue?.type !== "date") return unavailable();
    const resolvedDate = result.resolvedValue.value;
    const versions = new Map(result.versions.map((version) => [version.id, version]));
    const supports = result.supportingVersionIds.map((id) => {
      const version = versions.get(id);
      if (!version || version.visibility !== "available" || version.temporalApplicability !== "APPLICABLE" ||
          version.assessment.freshness !== "CURRENT" || version.assessment.conflict !== "NONE" || !version.assessedValidUntil ||
          version.value.type !== "date" || version.value.value !== resolvedDate ||
          (version.provenance !== "SYSTEM_VERIFIED" && version.provenance !== "HUMAN_CONFIRMED") ||
          version.evidenceIds.length !== 1 || !version.source.instanceId) return unavailable();
      return { versionId: id, sourceId: version.source.instanceId, evidenceId: version.evidenceIds[0]!,
        provenance: version.provenance, effectiveAt: version.effectiveAt, observedAt: version.observedAt,
        versionValidUntil: version.validUntil, assessedValidUntil: version.assessedValidUntil };
    });
    const evidence = supports.map(({ evidenceId }) => evidenceId).sort();
    if (JSON.stringify(evidence) !== JSON.stringify([...result.supportingEvidenceIds].sort())) return unavailable();
    return { assessmentId, asOf: saved.asOf, policyRevisionId: result.policy.revisionId,
      position: { value: resolvedDate, supports } };
  }

  private async observe(tx: Tx, actor: Actor, projectId: string, fact: { id: string; factType: string; revision: number },
    includeResolved: boolean) {
    const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    const asOf = clock[0]?.now;
    if (!asOf || fact.revision > 1000) return unavailable();
    // Admit the complete bounded value prefix only after project, grant and page
    // visibility checks. This does not bound SQL scan/decompression or policies.
    const admitted = await preflightMilestoneFactVersions(tx, { customerId: actor.customerId, projectId,
      factId: fact.id, revision: fact.revision });
    if (!admitted) return unavailable();
    const authority = new DatabaseAuthorityRepository(this.db);
    const prefixes = await authority.loadAssessmentPrefixesInTransaction(tx, actor, projectId, [fact], asOf);
    const prefix = prefixes?.get(fact.id);
    if (!prefix || !prefix.event || !matchesUnrankedFactPrefix(admitted, prefix.versions) || prefix.versions.length !== fact.revision ||
      prefix.versions.some((v, i) => v.revision !== i + 1) ||
      4 * prefix.versions.length + 4 * prefix.conflicts.length > 64000) return unavailable();
    const accessBySource = new Map(prefix.access.map((row) => [row.sourceId, row]));
    if (accessBySource.size !== prefix.access.length || prefix.versions.some((version) => {
      const access = accessBySource.get(version.sourceId);
      return !access || access.factId !== version.factId || access.state !== "AVAILABLE" || access.readers.length !== 1;
    })) return unavailable();
    const scope = { customerId: actor.customerId, projectId, factId: fact.id, factType: fact.factType };
    const { result } = resolveStoredAuthorityPrefix(scope, asOf, prefix.event, prefix.versions, prefix.conflicts, prefix.access, true);
    const resolved = includeResolved && result.status === "RESOLVED";
    if ((!resolved && result.status !== "CONFLICTING") || !result.policy) return unavailable();
    if (result.versions.some((row) => row.visibility !== "available" || row.temporalApplicability === "AMBIGUOUS" || row.value.type !== "date")) return unavailable();
    const selected = resolved ? result.supportingVersionIds : result.candidateVersionIds;
    const candidates = new Set(selected);
    if (candidates.size < (resolved ? 1 : 2) || candidates.size !== selected.length) return unavailable();
    let evidenceFromAuthority = result.supportingEvidenceIds;
    if (!resolved) {
      const disagreement = result.conflicts.filter((group) => group.kind === "AUTHORITY_DISAGREEMENT");
      if (disagreement.length !== 1 || result.conflicts.some((group) => group.kind === "HIGHER_AUTHORITY_CONTRADICTION")) return unavailable();
      const group = disagreement[0]!;
      if (group.versionIds.length !== candidates.size || group.versionIds.some((id) => !candidates.has(id))) return unavailable();
      const storedConflicts = new Map(prefix.conflicts.map((row) => [row.id, row]));
      if (storedConflicts.size !== prefix.conflicts.length || result.conflicts.some((item) => {
        if (item.kind !== "RECORDED") return false;
        const stored = item.recordedConflictId && storedConflicts.get(item.recordedConflictId);
        return !stored || !candidates.has(stored.leftVersionId) || !candidates.has(stored.rightVersionId);
      })) return unavailable();
      evidenceFromAuthority = group.evidenceIds;
    }
    const resultVersions = new Map(result.versions.map((row) => [row.id, row]));
    const storedVersions = new Map(prefix.versions.map((row) => [row.id, row]));
    if (resultVersions.size !== result.versions.length || storedVersions.size !== prefix.versions.length) return unavailable();
    const positions = new Map<string, { versionId: string; evidenceId: string; sourceId: string;
      provenance: "SYSTEM_VERIFIED" | "HUMAN_CONFIRMED"; effectiveAt: string; observedAt: string;
      versionValidUntil: string | null; assessedValidUntil: string }[]>();
    for (const id of [...candidates].sort()) {
      const version = resultVersions.get(id);
      const stored = storedVersions.get(id);
      if (!version || version.visibility !== "available" || !stored || version.temporalApplicability !== "APPLICABLE" ||
        version.assessment.freshness !== "CURRENT" || !version.assessedValidUntil || version.value.type !== "date" ||
        (version.provenance !== "SYSTEM_VERIFIED" && version.provenance !== "HUMAN_CONFIRMED") ||
        version.evidenceIds.length !== 1 || version.evidenceIds[0] !== stored.evidenceId ||
        version.source.instanceId !== stored.sourceId) return unavailable();
      const supports = positions.get(version.value.value) ?? [];
      supports.push({ versionId: id, evidenceId: stored.evidenceId, sourceId: stored.sourceId,
        provenance: version.provenance, effectiveAt: version.effectiveAt, observedAt: version.observedAt,
        versionValidUntil: version.validUntil, assessedValidUntil: version.assessedValidUntil });
      positions.set(version.value.value, supports);
    }
    if (resolved ? positions.size !== 1 || result.resolvedValue?.type !== "date" || !positions.has(result.resolvedValue.value)
      : positions.size < 2) return unavailable();
    const evidenceIds = [...positions.values()].flat().map((row) => row.evidenceId).sort();
    if (JSON.stringify(evidenceIds) !== JSON.stringify([...evidenceFromAuthority].sort())) return unavailable();
    return scalarConflictObservationSchema.parse({ projectId, factId: fact.id, factType: fact.factType,
      asOf: asOf.toISOString(), policyRevisionId: result.policy.revisionId,
      ...(resolved && { status: "RESOLVED" }),
      positions: [...positions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, supports]) => ({ value, supports })) });
  }
}
