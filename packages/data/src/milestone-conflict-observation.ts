import {
  MilestoneConflictObservationError, evaluateMilestoneConsistency, milestoneConflictObservationSchema,
  projectFactIdSchema, type Actor, type MilestoneConflictObservation, type MilestoneConflictObservationRepository,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import { actorInput } from "./fact-authorization.js";
import { DatabaseCanonicalProjectRepository } from "./canonical-project.js";
import { DatabaseAuthorityRepository } from "./authority-persistence.js";

type Tx = Prisma.TransactionClient;
const denied = (): never => { throw new MilestoneConflictObservationError("DENIED"); };
const unavailable = (): never => { throw new MilestoneConflictObservationError("UNAVAILABLE"); };

// Project and grant locks are retained until the complete response is validated.
// Supported fact, source and graph writers coordinate on Project before mutation.
export class DatabaseMilestoneConflictObservationRepository implements MilestoneConflictObservationRepository {
  constructor(private readonly db: Database) {}

  async readLeadership(actorValue: Actor, projectValue: string, milestoneValue: string): Promise<MilestoneConflictObservation> {
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
        const roles = grants.filter((row) => actor.roles.some((role) => role === row.role)).map((row) => row.role);
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
      if (error instanceof MilestoneConflictObservationError) throw error;
      throw new MilestoneConflictObservationError(visible ? "UNAVAILABLE" : "DENIED");
    }
  }

  private async observe(tx: Tx, actor: Actor, projectId: string, milestoneId: string): Promise<MilestoneConflictObservation> {
    const scope = { customerId: actor.customerId, projectId };
    const canonical = await tx.canonicalProject.findFirst({ where: { customerId: actor.customerId, id: projectId, sealed: true },
      include: { canonicalCreationReceipt_project: true } });
    if (!canonical?.canonicalCreationReceipt_project) return unavailable();
    const links = await tx.requiredWorkItem.findMany({ where: { ...scope, milestoneId }, orderBy: { id: "asc" }, take: 51 });
    if (!links.length || links.length > 50 || new Set(links.map((x) => x.workItemId)).size !== links.length) return unavailable();
    const slots = [{ targetKind: "MILESTONE" as const, targetId: milestoneId },
      ...links.map((row) => ({ targetKind: "WORK_ITEM" as const, targetId: row.workItemId }))];
    const bindings = await tx.canonicalStateBinding.findMany({ where: { ...scope, sealed: true,
      OR: [{ milestoneId }, { workItemId: { in: links.map((row) => row.workItemId) } }] }, orderBy: { id: "asc" }, take: 52 });
    if (bindings.length !== slots.length) return unavailable();
    const byTarget = new Map(bindings.map((row) => [`${row.targetKind}:${row.milestoneId ?? row.workItemId}`, row]));
    if (byTarget.size !== bindings.length || slots.some((row) => !byTarget.has(`${row.targetKind}:${row.targetId}`))) return unavailable();
    const facts = await tx.projectFact.findMany({ where: { ...scope, id: { in: bindings.map((row) => row.factId) } }, orderBy: { id: "asc" }, take: 52 });
    if (facts.length !== bindings.length || new Set(bindings.map((row) => row.factId)).size !== bindings.length) return unavailable();
    if (facts.reduce((total, fact) => total + fact.revision, 0) > 1000) return unavailable();
    for (const binding of bindings) {
      const valid = await tx.$queryRaw<{ valid: boolean }[]>`SELECT public.valid_canonical_state_binding(${binding.id}::uuid) AS valid`;
      if (valid[0]?.valid !== true) return unavailable();
    }
    const byFact = new Map(facts.map((row) => [row.id, row]));
    if (bindings.some((binding) => byFact.get(binding.factId)?.factType !== binding.factType)) return unavailable();
    // Re-read all identities together while the project gate is held. This is
    // structural equality of database values, not a hash or client assertion.
    const expected = {
      receipt: canonical.canonicalCreationReceipt_project.id, milestone: milestoneId,
      links: links.map((row) => [row.id, row.milestoneId, row.workItemId]),
      bindings: bindings.map((row) => [row.id, row.targetKind, row.milestoneId, row.workItemId, row.factId, row.factType]),
      facts: facts.map((row) => [row.id, row.factType, row.revision, row.bindingBirthId]),
    };
    const coherent = await tx.$queryRaw<{ valid: boolean }[]>`
      WITH required AS (
        SELECT id,"milestoneId","workItemId" FROM public."RequiredWorkItem"
        WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${projectId}::uuid AND "milestoneId"=${milestoneId}::uuid ORDER BY id LIMIT 51
      ), bound AS (
        SELECT * FROM public."CanonicalStateBinding" WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${projectId}::uuid AND sealed
          AND ("milestoneId"=${milestoneId}::uuid OR "workItemId" IN (SELECT "workItemId" FROM required))
      )
      SELECT jsonb_build_object(
        'receipt',(SELECT r.id FROM public."CanonicalProject" p JOIN public."CanonicalCreationReceipt" r ON r."projectId"=p.id AND r."customerId"=p."customerId" WHERE p."customerId"=${actor.customerId}::uuid AND p.id=${projectId}::uuid AND p.sealed),
        'milestone',(SELECT id FROM public."Milestone" WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${projectId}::uuid AND id=${milestoneId}::uuid),
        'links',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,"milestoneId","workItemId") ORDER BY id),'[]'::jsonb) FROM required),
        'bindings',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,"targetKind","milestoneId","workItemId","factId","factType") ORDER BY id),'[]'::jsonb) FROM bound),
        'facts',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,"factType",revision,"bindingBirthId") ORDER BY id),'[]'::jsonb) FROM public."ProjectFact" WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${projectId}::uuid AND id IN (SELECT "factId" FROM bound))
      )=${JSON.stringify(expected)}::jsonb AS valid`;
    if (coherent[0]?.valid !== true) return unavailable();
    const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    const asOf = clock[0]?.now;
    if (!asOf) return unavailable();
    const authority = new DatabaseAuthorityRepository(this.db);
    const prefixes = await authority.loadAssessmentPrefixesInTransaction(tx, actor, projectId, facts, asOf);
    if (!prefixes) return unavailable();
    const prepared = new Map<string, Awaited<ReturnType<DatabaseAuthorityRepository["prepareAssessmentInTransaction"]>>>();
    for (const binding of bindings) {
      const fact = byFact.get(binding.factId), prefix = prefixes.get(binding.factId);
      if (!fact || !prefix) return unavailable();
      const result = await authority.prepareAssessmentInTransaction(tx, actor, { projectId, fact, asOf, prefix });
      if (!result.complete || result.newConflicts.length || result.versions.some((version) => {
        const matches = result.access.filter((access) => access.factId === version.factId && access.sourceId === version.sourceId);
        return matches.length !== 1 || matches[0]!.state !== "AVAILABLE" || matches[0]!.readers.length !== 1;
      })) return unavailable();
      prepared.set(binding.id, result);
    }
    const all = [...prepared.values()];
    if (all.reduce((n, p) => n + p.versions.length, 0) > 1000 || all.reduce((n, p) => n + p.conflicts.length, 0) > 1000 ||
        all.reduce((n, p) => n + p.access.length, 0) > 1000 ||
        all.reduce((n, p) => n + 4 * p.versions.length + 4 * p.conflicts.length, 0) > 64000) return unavailable();
    const result = evaluateMilestoneConsistency({ scope: { ...scope, milestoneId }, asOf: asOf.toISOString(),
      ruleRevision: "milestone-required-state/v1", enabled: true, complete: true,
      requiredWorkItemIds: links.map((row) => row.workItemId), targets: slots.map((slot) => {
        const binding = byTarget.get(`${slot.targetKind}:${slot.targetId}`)!;
        return { ...slot, binding: { id: binding.id, ...scope, targetKind: slot.targetKind, targetId: slot.targetId,
          field: "state", factId: binding.factId, factType: binding.factType }, snapshot: prepared.get(binding.id)!.snapshot };
      }) });
    const envelope = { projectId, milestoneId, asOf: asOf.toISOString(), ruleRevision: "milestone-required-state/v1" as const };
    if (result.status === "NOT_DETECTED") return milestoneConflictObservationSchema.parse({ ...envelope, outcome: "NOT_DETECTED" });
    if (result.status !== "CONFLICTING") return unavailable();
    if (result.contributors.reduce((n, row) => n + row.supportingVersionIds.length, 0) > 1000) return unavailable();
    const positions = result.contributors.map((contributor) => {
      const plan = prepared.get(contributor.bindingId);
      const assessment = plan?.result;
      if (!plan || !assessment || assessment.status !== "RESOLVED" || !assessment.policy ||
          assessment.resolvedValue?.type !== "text" || !contributor.supportingVersionIds.length) return unavailable();
      const supports = contributor.supportingVersionIds.map((versionId) => {
        const version = assessment.versions.find((row) => row.id === versionId);
        const stored = plan.versions.find((row) => row.id === versionId);
        if (!version || version.visibility !== "available" || !stored || version.evidenceIds.length !== 1 ||
            version.evidenceIds[0] !== stored.evidenceId || version.source.instanceId !== stored.sourceId ||
            version.assessment.freshness !== "CURRENT" || !version.assessedValidUntil ||
            (version.provenance !== "SYSTEM_VERIFIED" && version.provenance !== "HUMAN_CONFIRMED")) return unavailable();
        return { versionId, evidenceId: stored.evidenceId, sourceId: stored.sourceId, provenance: version.provenance,
          freshness: "CURRENT" as const, validity: "FINITE" as const, effectiveAt: version.effectiveAt, observedAt: version.observedAt,
          versionValidUntil: version.validUntil, assessedValidUntil: version.assessedValidUntil };
      });
      const ids = supports.map((row) => row.evidenceId).sort();
      if (JSON.stringify(ids) !== JSON.stringify([...contributor.supportingEvidenceIds].sort())) return unavailable();
      return { targetKind: contributor.targetKind, targetId: contributor.targetId, bindingId: contributor.bindingId,
        factId: contributor.factId, factType: contributor.factType, policyRevisionId: assessment.policy.revisionId,
        state: assessment.resolvedValue.value, supports };
    });
    return milestoneConflictObservationSchema.parse({ ...envelope, outcome: "CONFLICTING", positions });
  }
}
