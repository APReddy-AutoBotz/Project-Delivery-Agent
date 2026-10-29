import { z } from "zod";
import { BlockerAgeAdviceError, blockerAgeThresholdPolicyViewSchema, buildBlockerAgeAdvice, evaluateBlockerAgeSignals,
  projectFactIdSchema, projectFactValueSchema, type Actor, type BlockerAgeAdvice, type BlockerAgeAdviceRepository } from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import { buildBlockerAgeAssessmentInTransaction, type BlockerAgeThreshold } from "./blocker-age-assessment.js";
import { DatabaseHealthAssessmentRepository } from "./health-assessment.js";
import { actorInput } from "./fact-authorization.js";

type Tx = Prisma.TransactionClient;
type Audience = "project_manager" | "leadership";
const id = z.uuid().regex(/^[0-9a-f-]+$/);
const rawProof = z.object({ status: z.enum(["RESOLVED", "UNKNOWN"]), value: z.unknown(), factId: id.nullable(),
  versionIds: z.array(id).max(1000), evidenceIds: z.array(id).max(1000) });
const rawCandidate = z.object({ raidItemId: id, key: z.string(), state: z.enum(["OPEN", "IN_PROGRESS"]),
  classification: rawProof, openedAt: rawProof.nullable(), outcome: z.enum(["AGED", "WITHIN_THRESHOLD", "EXCLUDED",
    "UNKNOWN_CLASSIFICATION", "UNASSESSABLE_OPENED_AT"]), age: z.number().int().nonnegative().optional(),
  thresholdExceeded: z.boolean().optional() });
const rawAuthority = z.object({ factId: id, factType: z.string(), factRevision: z.number().int().min(0),
  policyId: id.nullable(), policyThroughRevision: z.number().int().min(1).nullable(),
  policyRevisionId: id.nullable(), policyRevision: z.number().int().min(1).nullable() });
const rawInput = z.object({ coverage: z.enum(["COMPLETE", "PARTIAL", "UNASSESSABLE"]),
  gates: z.object({ canonicalSealed: z.boolean(), raidSnapshotBounded: z.boolean(), inventoryAttested: z.boolean(),
    thresholdConfigured: z.boolean(), sourceHistoryComplete: z.boolean() }),
  threshold: z.object({ minimumBlockerAgeDays: z.number().int().min(1).max(3650), revision: z.number().int().min(1) }).nullable(),
  inventoryCompleteness: rawProof, candidates: z.array(rawCandidate).max(50),
  authorityRevisions: z.array(rawAuthority).max(101), dependencies: z.array(z.object({ factId: id, sourceId: id })).max(1000),
});
type RawProof = z.infer<typeof rawProof>;
type RawAuthority = z.infer<typeof rawAuthority>;
type Binding = { factId: string; factType: string; factRevision: number; policyId: string; policyThroughRevision: number;
  policyRevisionId: string; policyRevision: number; versionIds: string[]; evidenceIds: string[];
  expectedValue: boolean | string; validity: "FINITE" | "UNTIL_SUPERSEDED" };
type BoundRow = { factId: string; factType: string; factRevision: number; policyId: string; policyRevisionId: string;
  policyRevision: number; versionId: string; evidenceId: string; sourceId: string; accessRevision: number;
  sourceType: string; provenance: string; value: unknown };
const fail = (): never => { throw new Error("Blocker-age advice unavailable"); };
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function binding(raw: RawProof, expectedType: string, expectedValue: boolean | string,
  validity: Binding["validity"], authorities: RawAuthority[]): Binding {
  if (raw.status !== "RESOLVED" || raw.value !== expectedValue || !raw.factId || !raw.versionIds.length ||
      new Set(raw.versionIds).size !== raw.versionIds.length || new Set(raw.evidenceIds).size !== raw.evidenceIds.length) return fail();
  const matches = authorities.filter((entry) => entry.factId === raw.factId && entry.factType === expectedType);
  const row = matches[0];
  if (matches.length !== 1 || !row || row.factRevision < 1 || !row.policyId || !row.policyThroughRevision || !row.policyRevisionId || !row.policyRevision) return fail();
  return { factId: raw.factId, factType: expectedType, factRevision: row.factRevision, policyId: row.policyId,
    policyThroughRevision: row.policyThroughRevision, policyRevisionId: row.policyRevisionId,
    policyRevision: row.policyRevision, versionIds: [...raw.versionIds].sort(compare),
    evidenceIds: [...raw.evidenceIds].sort(compare), expectedValue, validity };
}

// Caller must have authenticated the actor, enforced the requested audience,
// acquired Project SHARE and the shared customer threshold gate, and retain
// them until commit. This function is not itself an authorization boundary.
export async function observeBlockerAgeAdviceInTransaction(tx: Tx, db: Database, actor: Actor, projectId: string,
  audience: Audience, threshold: BlockerAgeThreshold, canonicalSealed: boolean): Promise<BlockerAgeAdvice> {
  const built = await buildBlockerAgeAssessmentInTransaction(tx, db, actor, projectId, canonicalSealed, threshold, undefined,
    { strictPreparationErrors: true });
  const internal = built.input as Record<string, unknown>;
  if (internal.reason === "RAID_SNAPSHOT_OVER_LIMIT" || internal.reason === "SOURCE_HISTORY_OVER_LIMIT") return fail();
  const unavailable = () => buildBlockerAgeAdvice({ projectId, audience, asOf: built.asOf.toISOString(),
    coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, candidates: [] });
  if (built.coverage === "UNASSESSABLE" || built.newConflicts.length) return unavailable();
  const input = rawInput.parse(built.input);
  if (input.coverage !== built.coverage || !input.gates.canonicalSealed || !input.gates.raidSnapshotBounded ||
      !input.gates.inventoryAttested || !input.gates.thresholdConfigured || !input.gates.sourceHistoryComplete ||
      !input.threshold || !threshold || input.threshold.revision !== threshold.revision ||
      input.threshold.minimumBlockerAgeDays !== threshold.minimumBlockerAgeDays) return fail();
  const dependencyKeys = new Set(input.dependencies.map((entry) => `${entry.factId}:${entry.sourceId}`));
  if (dependencyKeys.size !== input.dependencies.length) return fail();
  if (!await new DatabaseHealthAssessmentRepository(db).sourcesReadableInTransaction(tx, actor, projectId,
    { blockerAge: built.input })) return unavailable();
  const result = built.result;
  if (result.coverage !== built.coverage || result.asOf !== built.asOf.toISOString() ||
      result.candidateCount !== input.candidates.length) return fail();
  if (new Set(input.candidates.map((candidate) => candidate.raidItemId)).size !== input.candidates.length ||
      new Set(input.candidates.map((candidate) => candidate.key)).size !== input.candidates.length ||
      input.candidates.some((candidate, index) => index > 0 && input.candidates[index - 1]!.raidItemId >= candidate.raidItemId)) return fail();
  const assessed = input.candidates.filter((candidate) => candidate.outcome === "AGED" || candidate.outcome === "WITHIN_THRESHOLD");
  const unknown = input.candidates.filter((candidate) => candidate.outcome === "UNKNOWN_CLASSIFICATION" || candidate.outcome === "UNASSESSABLE_OPENED_AT");
  if (input.inventoryCompleteness.status !== "RESOLVED" || input.inventoryCompleteness.value !== true ||
      (built.coverage === "COMPLETE" && unknown.length !== 0) ||
      (built.coverage === "PARTIAL" && (!unknown.length || !assessed.length)) ||
      input.candidates.some((candidate) => candidate.outcome === "EXCLUDED" &&
        (candidate.classification.status !== "RESOLVED" || candidate.classification.value !== false || candidate.openedAt !== null)) ||
      input.candidates.some((candidate) => candidate.outcome === "UNASSESSABLE_OPENED_AT" &&
        (candidate.classification.status !== "RESOLVED" || candidate.classification.value !== true || !candidate.openedAt)) ||
      input.candidates.some((candidate) => candidate.outcome === "UNASSESSABLE_OPENED_AT" && candidate.openedAt?.status === "UNKNOWN" &&
        candidate.openedAt.value !== null) ||
      input.candidates.some((candidate) => candidate.outcome === "UNKNOWN_CLASSIFICATION" &&
        (candidate.openedAt !== null || (candidate.classification.status === "UNKNOWN" && candidate.classification.value !== null) ||
          (candidate.classification.status === "RESOLVED" && typeof candidate.classification.value === "boolean"))) ||
      input.candidates.some((candidate) => candidate.outcome === "UNASSESSABLE_OPENED_AT" && candidate.openedAt?.status === "RESOLVED" &&
        typeof candidate.openedAt.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(candidate.openedAt.value) &&
        candidate.openedAt.value <= built.asOf.toISOString().slice(0, 10)) ||
      assessed.some((candidate) => candidate.classification.status !== "RESOLVED" || candidate.classification.value !== true ||
        !candidate.openedAt || candidate.openedAt.status !== "RESOLVED" || typeof candidate.openedAt.value !== "string")) return fail();
  const recomputed = evaluateBlockerAgeSignals({ asOf: built.asOf.toISOString(), timeZone: "UTC", blockerReadComplete: true,
    threshold: { ruleKey: "blocker-age", ruleRevision: "1", minimumBlockerAgeDays: threshold.minimumBlockerAgeDays },
    blockers: assessed.map((candidate) => ({ targetType: "RAID_ITEM", targetKey: candidate.key, state: candidate.state,
      sourceDate: candidate.openedAt!.value, sourceDateField: "opened_at", source: { kind: "canonical_field" } })) });
  for (const candidate of assessed) {
    const age = recomputed.assessments.find((entry) => entry.targetKey === candidate.key);
    if (!age || age.status !== candidate.outcome || age.ageDays !== candidate.age || age.thresholdExceeded !== candidate.thresholdExceeded) return fail();
  }
  if ((built.coverage === "PARTIAL" && result.noOpenBlockers !== null) ||
      (built.coverage === "COMPLETE" && result.noOpenBlockers !== (assessed.length === 0))) return fail();
  const aged = input.candidates.filter((candidate) => candidate.outcome === "AGED");
  if (aged.some((candidate) => candidate.classification.value !== true || !candidate.openedAt ||
      candidate.openedAt.status !== "RESOLVED" || typeof candidate.openedAt.value !== "string" || candidate.thresholdExceeded !== true)) return fail();
  const proofs: Binding[] = [binding(input.inventoryCompleteness, "project.open_blocker_inventory_complete", true, "FINITE", input.authorityRevisions)];
  const positions = new Map<string, { classification: number; openedAt?: number }>();
  // A clear/no-open or below-threshold statement also depends on the evidence
  // for every resolved candidate, not merely on the positive aged items.
  for (const candidate of input.candidates) {
    if (candidate.outcome !== "EXCLUDED" && candidate.outcome !== "AGED" && candidate.outcome !== "WITHIN_THRESHOLD") continue;
    const classification = proofs.length;
    proofs.push(binding(candidate.classification, `raid_item.${candidate.raidItemId}.blocks_delivery`,
      candidate.outcome !== "EXCLUDED", "FINITE", input.authorityRevisions));
    if (candidate.outcome === "EXCLUDED") positions.set(candidate.raidItemId, { classification });
    else {
      const openedAt = proofs.length;
      proofs.push(binding(candidate.openedAt!, `raid_item.${candidate.raidItemId}.opened_at`, candidate.openedAt!.value as string,
        "UNTIL_SUPERSEDED", input.authorityRevisions));
      positions.set(candidate.raidItemId, { classification, openedAt });
    }
  }
  if (proofs.reduce((sum, entry) => sum + entry.versionIds.length, 0) > 1000) return fail();
  const rows = await tx.$queryRawUnsafe<BoundRow[]>(
    `WITH requested AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS q("factId" uuid,"factType" text,"factRevision" integer,
      "policyId" uuid,"policyThroughRevision" integer,"policyRevisionId" uuid,"policyRevision" integer,"versionIds" uuid[]))
    SELECT f.id AS "factId",f."factType",f.revision AS "factRevision",p.id AS "policyId",pr.id AS "policyRevisionId",
      pr.revision AS "policyRevision",v.id AS "versionId",v."evidenceId",v."sourceId",a.revision AS "accessRevision",
      s."sourceType",v.provenance,v.value
    FROM requested q JOIN public."ProjectFact" f ON f."customerId"=$1::uuid AND f."projectId"=$2::uuid
      AND f.id=q."factId" AND f."factType"=q."factType" AND f.revision=q."factRevision"
    JOIN public."AuthorityPolicy" p ON p."customerId"=f."customerId" AND p."projectId"=f."projectId"
      AND p."factType"=f."factType" AND p.id=q."policyId" AND p.revision=q."policyThroughRevision"
    JOIN public."AuthorityPolicyRevision" pr ON pr."customerId"=p."customerId" AND pr."projectId"=p."projectId"
      AND pr."factType"=p."factType" AND pr."policyId"=p.id AND pr.id=q."policyRevisionId" AND pr.revision=q."policyRevision"
      AND pr.state='ENABLED' AND pr."recordedAt"<=$5::timestamptz AND pr."effectiveAt"<=$5::timestamptz
    JOIN public."ProjectFactVersion" v ON v."customerId"=f."customerId" AND v."projectId"=f."projectId"
      AND v."factId"=f.id AND v.id=ANY(q."versionIds") AND v.revision<=f.revision
    JOIN public."FactEvidence" e ON e."customerId"=v."customerId" AND e."projectId"=v."projectId"
      AND e."factId"=v."factId" AND e."sourceId"=v."sourceId" AND e.id=v."evidenceId"
    JOIN public."FactSource" s ON s."customerId"=e."customerId" AND s."projectId"=e."projectId"
      AND s."factId"=e."factId" AND s.id=e."sourceId" AND s."providedBy"=e."providedBy"
    JOIN public."FactSourceAccess" a ON a."customerId"=s."customerId" AND a."projectId"=s."projectId"
      AND a."factId"=s."factId" AND a."sourceId"=s.id AND a.state='AVAILABLE'
    JOIN public."FactSourceReader" r ON r."customerId"=a."customerId" AND r."projectId"=a."projectId"
      AND r."factId"=a."factId" AND r."sourceId"=a."sourceId" AND r.subject=$4
    ORDER BY f.id,v.id`, actor.customerId, projectId, JSON.stringify(proofs), actor.subject, built.asOf);
  const projected = proofs.map((expected) => {
    const bound = rows.filter((row) => row.factId === expected.factId && row.factType === expected.factType).sort((a, b) => compare(a.versionId, b.versionId));
    if (bound.length !== expected.versionIds.length || bound.some((row, index) => row.versionId !== expected.versionIds[index] ||
        row.factRevision !== expected.factRevision || row.policyId !== expected.policyId || row.policyRevisionId !== expected.policyRevisionId ||
        row.policyRevision !== expected.policyRevision || row.provenance !== "HUMAN_CONFIRMED" || row.sourceType !== "human_statement" ||
        !dependencyKeys.has(`${row.factId}:${row.sourceId}`))) return fail();
    if (JSON.stringify(bound.map((row) => row.evidenceId).sort(compare)) !== JSON.stringify(expected.evidenceIds)) return fail();
    for (const row of bound) {
      const value = projectFactValueSchema.parse(row.value);
      if ((typeof expected.expectedValue === "boolean" && (value.type !== "boolean" || value.value !== expected.expectedValue)) ||
          (typeof expected.expectedValue === "string" && (value.type !== "date" || value.value !== expected.expectedValue))) return fail();
    }
    return { factId: expected.factId, factType: expected.factType, factRevision: expected.factRevision,
      policyId: expected.policyId, policyRevisionId: expected.policyRevisionId, policyRevision: expected.policyRevision,
      status: "RESOLVED" as const, provenance: "HUMAN_CONFIRMED" as const, sourceType: "human_statement" as const,
      freshness: "CURRENT" as const, conflict: "NONE" as const, validity: expected.validity,
      supports: bound.map((row) => ({ versionId: row.versionId, evidenceId: row.evidenceId, sourceId: row.sourceId, accessRevision: row.accessRevision })) };
  });
  if (rows.length !== proofs.reduce((sum, entry) => sum + entry.versionIds.length, 0)) return fail();
  const advice = buildBlockerAgeAdvice({ projectId, audience, asOf: built.asOf.toISOString(), coverage: built.coverage,
    threshold: { minimumBlockerAgeDays: threshold.minimumBlockerAgeDays, revision: threshold.revision },
    inventory: projected[0], noOpenBlockers: result.noOpenBlockers, candidates: aged.map((candidate) => ({
      raidItemId: candidate.raidItemId, key: candidate.key, state: candidate.state, openedAt: candidate.openedAt!.value,
      classification: projected[positions.get(candidate.raidItemId)!.classification],
      openedAtProof: projected[positions.get(candidate.raidItemId)!.openedAt!],
    })) });
  for (const item of advice.items) {
    const source = aged.find((candidate) => candidate.raidItemId === item.raidItemId);
    if (!source || source.age !== item.ageDays) return fail();
  }
  return advice;
}

// The advisory lock protects both an existing threshold and the absent→insert
// case for supported writers. Call only after the project/grant gates are held.
export async function blockerThresholdInTransaction(tx: Tx, customerId: string): Promise<BlockerAgeThreshold> {
  await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0)) IS NULL AS locked",
    "blocker-age-threshold:" + customerId);
  const rows = await tx.$queryRawUnsafe<{ minimumBlockerAgeDays: number; auditRetentionHours: number; revision: number;
    changedBy: string; changedAt: Date }[]>(
    'SELECT "minimumBlockerAgeDays","auditRetentionHours",revision,"changedBy","changedAt" FROM public."BlockerAgeThresholdPolicy" WHERE "customerId"=$1::uuid FOR SHARE', customerId);
  if (rows.length > 1) return fail();
  const row = rows[0];
  if (!row) return null;
  blockerAgeThresholdPolicyViewSchema.parse({ ...row, changedAt: row.changedAt.toISOString() });
  return row;
}

// EXEC-027 / FR-ADV-006 / NFR-SEC-001: leadership is an explicit audience,
// never a fallback from the assigned-PM queue.
export class DatabaseBlockerAgeAdviceRepository implements BlockerAgeAdviceRepository {
  constructor(private readonly db: Database) {}
  async readLeadership(value: Actor, requestedProject: string): Promise<BlockerAgeAdvice> {
    let actor: Actor, projectId: string;
    try { actor = actorInput(value); projectId = projectFactIdSchema.parse(requestedProject); }
    catch { throw new BlockerAgeAdviceError("DENIED"); }
    if (!actor.roles.includes("leadership")) throw new BlockerAgeAdviceError("DENIED");
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='8s'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
        const projects = await tx.$queryRawUnsafe<{ id: string; portfolioId: string }[]>(
          'SELECT id,"portfolioId" FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE', actor.customerId, projectId);
        if (projects.length !== 1 || projects[0]!.id !== projectId) throw new BlockerAgeAdviceError("DENIED");
        const grants = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=$2 AND role='leadership'
            AND (("scopeType"='project' AND "scopeId"=$3::uuid) OR ("scopeType"='portfolio' AND "scopeId"=$4::uuid)) ORDER BY id FOR SHARE`,
          actor.customerId, actor.subject, projectId, projects[0]!.portfolioId);
        if (!grants.length) throw new BlockerAgeAdviceError("DENIED");
        const policy = await blockerThresholdInTransaction(tx, actor.customerId);
        const canonical = await tx.$queryRawUnsafe<{ sealed: boolean }[]>(
          'SELECT sealed FROM public."CanonicalProject" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE', actor.customerId, projectId);
        if (canonical.length > 1) return fail();
        return observeBlockerAgeAdviceInTransaction(tx, this.db, actor, projectId, "leadership", policy, canonical[0]?.sealed === true);
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 20000 });
    } catch (error) {
      if (error instanceof BlockerAgeAdviceError && error.code === "DENIED") throw error;
      throw new BlockerAgeAdviceError("UNAVAILABLE");
    }
  }
}
