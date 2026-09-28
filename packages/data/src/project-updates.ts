import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assessProjectCompleteness,
  assessUpdateFreshness,
  projectUpdatePolicyChangeSchema,
  projectUpdateFactReferenceSchema,
  projectUpdateKnownPositionSchema,
  selectProjectUpdateTimestamp,
  canonicalSubjectSchema,
  projectUpdateRequiredFactSchema,
  ProjectUpdateError,
  type Actor,
  type ProjectUpdateAssessmentView,
  type ProjectUpdateFactReference,
  type ProjectUpdateKnownPosition,
  type ProjectUpdatePolicyChange,
  type ProjectUpdatePolicyView,
  type ProjectUpdatePreview,
  type ProjectUpdateRepository,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import { actorInput, authorizeFactProject } from "./fact-authorization.js";
import { DatabaseAuthorityRepository } from "./authority-persistence.js";

type Tx = Prisma.TransactionClient;
type PolicyRow = {
  policyRevisionId: string;
  projectId: string;
  revision: number;
  freshnessWindowSeconds: number;
  timeZone: string;
  requiredFacts: unknown;
  responsibleSubject: string;
  scheduledScanEnabled: boolean;
  scheduledServiceSubject: string | null;
  changedBy: string;
  changedAt: Date;
};
type ProjectRow = {
  id: string;
  code: string;
  name: string;
  reportedStatus: string;
  createdAt: Date;
};
type FactRow = { id: string; factType: string; revision: number };
type DependencyRow = ProjectUpdateFactReference;
type AssessmentRow = {
  id: string;
  customerId: string;
  projectId: string;
  policyRevisionId: string;
  policyRevision: number;
  assessedAt: Date;
  input: unknown;
  result: unknown;
  dependencies: unknown;
  envelopeHash: string;
  auditEventId: string;
  code: string;
  name: string;
  reportedStatus: string;
  createdAt: Date;
  responsibleSubject: string;
  freshnessWindowSeconds: number;
  timeZone: string;
  requiredFacts: unknown;
  scheduledScanEnabled: boolean;
  changedBy: string;
  changedAt: Date;
  obligationId: string | null;
  obligationState: "OPEN" | "SUPERSEDED" | null;
  dueAt: Date | null;
  previewId: string | null;
  previewRevision: number | null;
  preview: unknown | null;
};
type Resolution = {
  status: string;
  conflict: string;
  candidateVersionIds: string[];
  supportingVersionIds: string[];
  selectedTier: number | null;
  policy: {
    revisionId: string;
    tiers: Array<{
      selectors: Array<{
        sourceType: string;
        instanceId: string | null;
        validity: { basis?: string } | { mode: string } | null;
      }>;
    }>;
  } | null;
  versions: Array<{ id: string; visibility: string; sourceType?: string; effectiveAtValidated?: boolean }>;
};
const SCHEDULED_SCAN_INTERVAL_SECONDS = 60 * 60;
const SCHEDULED_SCAN_RETRY_SECONDS = 5 * 60;
const projectIdSchema = z.uuid().refine((value) => value === value.toLowerCase());
const correlationSchema = z.uuid();
const factsSchema = z.array(projectUpdateRequiredFactSchema).min(1).max(100);
const safeObject = z.record(z.string(), z.unknown());
const iso = (value: Date) => value.toISOString();
function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value) as unknown; }
    catch { throw new ProjectUpdateError("UNAVAILABLE"); }
  }
  return value;
}
function knownPositionValue(value: unknown): ProjectUpdateKnownPosition["value"] {
  try { return projectUpdateKnownPositionSchema.shape.value.parse(value); }
  catch { throw new ProjectUpdateError("UNAVAILABLE"); }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, stable(child)]));
  return value;
}
function stringify(value: unknown) { return JSON.stringify(stable(value)); }
function hash(value: unknown) {
  return createHash("sha256").update(stringify(value)).digest("hex");
}
function parseActor(value: Actor): Actor {
  try { return actorInput(value); }
  catch { throw new ProjectUpdateError("INVALID_REQUEST"); }
}
function parseProjectId(value: string): string {
  try { return projectIdSchema.parse(value); }
  catch { throw new ProjectUpdateError("INVALID_REQUEST"); }
}
function parseCorrelation(value: string): string {
  try { return correlationSchema.parse(value); }
  catch { throw new ProjectUpdateError("INVALID_REQUEST"); }
}
function policyFacts(value: unknown) {
  try { return factsSchema.parse(jsonValue(value)); }
  catch { throw new ProjectUpdateError("UNAVAILABLE"); }
}
function policyView(row: PolicyRow): ProjectUpdatePolicyView {
  return {
    projectId: row.projectId,
    key: "project-update",
    revision: row.revision,
    freshnessWindowSeconds: row.freshnessWindowSeconds,
    timeZone: row.timeZone,
    requiredFacts: policyFacts(row.requiredFacts),
    responsibleSubject: row.responsibleSubject,
    scheduledScanEnabled: row.scheduledScanEnabled,
    changedBy: row.changedBy,
    changedAt: iso(row.changedAt),
  };
}
function datesFromJson(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function mapError(error: unknown): never {
  if (error instanceof ProjectUpdateError) throw error;
  if (error && typeof error === "object" && "code" in error &&
    ["P2002", "P2034", "40001", "23505"].includes(String(error.code)))
    throw new ProjectUpdateError("CONFLICT");
  throw new ProjectUpdateError("UNAVAILABLE");
}
function selectorBasis(policy: Resolution["policy"], selectedTier: number | null, sourceType: string, sourceId: string): string | null {
  if (!policy || selectedTier === null) return null;
  const tier = policy.tiers[selectedTier];
  if (!tier) return null;
  const selector = tier.selectors.find((entry) =>
    entry.sourceType === sourceType &&
    (entry.instanceId === null || entry.instanceId === sourceId),
  );
  const validity = selector?.validity;
  return validity && "basis" in validity ? validity.basis ?? null : null;
}

/**
 * Timestamp authorization for canonical project facts. Human statements always
 * use server observation time; connector effectiveAt values require an explicit
 * adapter-validation receipt from the authoritative version snapshot. Visibility
 * only proves reader access and cannot authorize a timestamp.
 */
export function selectCanonicalProjectUpdateTimestamp(input: {
  sourceType: string;
  selectedBasis: string | null;
  observedAt: Date | null;
  effectiveAt: Date | null;
  effectiveAtValidated: boolean;
  asOf: Date;
}) {
  return selectProjectUpdateTimestamp({
    ...input,
    selectedBasis: input.sourceType === "human_statement" ? "observedAt" : input.selectedBasis,
    effectiveAtValidated: input.sourceType !== "human_statement" && input.effectiveAtValidated,
  });
}

export class DatabaseProjectUpdateRepository implements ProjectUpdateRepository {
  private readonly authority: DatabaseAuthorityRepository;
  private readonly serviceSubject: string | null;

  constructor(
    private readonly db: Database,
    configuredServiceSubject?: string | null,
  ) {
    this.authority = new DatabaseAuthorityRepository(db);
    this.serviceSubject = configuredServiceSubject
      ? canonicalSubjectSchema.parse(configuredServiceSubject)
      : null;
  }

  private async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(operation, {
        isolationLevel: "RepeatableRead",
        maxWait: 5000,
        timeout: 20000,
      });
    } catch (error) {
      mapError(error);
    }
  }

  private async now(tx: Tx) {
    const rows = await tx.$queryRawUnsafe<{ now: Date }[]>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
    );
    if (!rows[0]?.now) throw new ProjectUpdateError("UNAVAILABLE");
    return rows[0].now;
  }

  private async authorize(tx: Tx, current: Actor, id: string, scheduled: boolean) {
    if (scheduled) {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE',
        current.customerId, id,
      );
      if (!rows[0]) throw new ProjectUpdateError("DENIED");
      return;
    }
    try { await authorizeFactProject(tx, current, id, "read"); }
    catch { throw new ProjectUpdateError("DENIED"); }
  }

  private async loadPolicy(tx: Tx, customerId: string, id: string, lock = false): Promise<PolicyRow | null> {
    const rows = await tx.$queryRawUnsafe<PolicyRow[]>(
      'SELECT r.id AS "policyRevisionId",r."projectId",r.revision,r."freshnessWindowSeconds",r."timeZone",r."requiredFacts",r."responsibleSubject",r."scheduledScanEnabled",r."scheduledServiceSubject",r."changedBy",r."changedAt" FROM public."ProjectUpdatePolicy" p JOIN public."ProjectUpdatePolicyRevision" r ON r."customerId"=p."customerId" AND r."projectId"=p."projectId" AND r.revision=p.revision WHERE p."customerId"=$1::uuid AND p."projectId"=$2::uuid AND p.key=\'project-update\'' + (lock ? " FOR UPDATE OF p" : ""),
      customerId, id,
    );
    return rows[0] ?? null;
  }

  private async loadProject(tx: Tx, customerId: string, id: string): Promise<ProjectRow> {
    const rows = await tx.$queryRawUnsafe<ProjectRow[]>(
      'SELECT p.id,p.code,p.name,p."reportedStatus",c."createdAt" FROM public."Project" p JOIN public."CanonicalProject" c ON c."customerId"=p."customerId" AND c.id=p.id WHERE p."customerId"=$1::uuid AND p.id=$2::uuid AND c.sealed=true FOR SHARE OF p,c',
      customerId, id,
    );
    if (!rows[0]) throw new ProjectUpdateError("UNAVAILABLE");
    return rows[0];
  }

  async policy(actorValue: Actor, projectValue: string) {
    const current = parseActor(actorValue);
    const id = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, current, id, false);
      const row = await this.loadPolicy(tx, current.customerId, id);
      return row ? policyView(row) : null;
    });
  }

  async setPolicy(actorValue: Actor, projectValue: string, changeValue: ProjectUpdatePolicyChange, correlationValue: string) {
    const current = parseActor(actorValue);
    const id = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    let change: ProjectUpdatePolicyChange;
    try { change = projectUpdatePolicyChangeSchema.parse(changeValue); }
    catch { throw new ProjectUpdateError("INVALID_REQUEST"); }
    if (!current.roles.includes("pmo_admin"))
      throw new ProjectUpdateError("FORBIDDEN");
    if (change.scheduledScanEnabled && !this.serviceSubject)
      throw new ProjectUpdateError("UNAVAILABLE");
    return this.transaction(async (tx) => {
      try { await authorizeFactProject(tx, current, id, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
      await this.loadProject(tx, current.customerId, id);
      const owner = await tx.$queryRawUnsafe<{ subject: string }[]>(
        'SELECT subject FROM public."ProjectResponsibility" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND role=\'RESPONSIBLE_OWNER\' AND subject=$3 FOR SHARE',
        current.customerId, id, change.responsibleSubject,
      );
      if (!owner[0]) throw new ProjectUpdateError("INVALID_REQUEST");
      await tx.$queryRawUnsafe(
        'INSERT INTO public."ProjectUpdatePolicy" ("customerId","projectId",key,revision,"changedBy","changedAt") VALUES ($1::uuid,$2::uuid,\'project-update\',0,$3,$4) ON CONFLICT ("customerId","projectId") DO NOTHING',
        current.customerId, id, current.subject, await this.now(tx),
      );
      const heads = await tx.$queryRawUnsafe<{ revision: number }[]>(
        'SELECT revision FROM public."ProjectUpdatePolicy" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid FOR UPDATE',
        current.customerId, id,
      );
      if (!heads[0] || heads[0].revision !== change.expectedRevision)
        throw new ProjectUpdateError("CONFLICT");
      const revision = heads[0].revision + 1;
      const changedAt = await this.now(tx);
      const revisionId = randomUUID();
      const scheduledSubject = change.scheduledScanEnabled ? this.serviceSubject : null;
      await tx.$executeRawUnsafe(
        'INSERT INTO public."ProjectUpdatePolicyRevision" (id,"customerId","projectId",revision,"freshnessWindowSeconds","timeZone","requiredFacts","responsibleSubject","scheduledScanEnabled","scheduledServiceSubject","changedBy","changedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)',
        revisionId, current.customerId, id, revision, change.freshnessWindowSeconds,
        change.timeZone, stringify(change.requiredFacts), change.responsibleSubject,
        change.scheduledScanEnabled, scheduledSubject, current.subject, changedAt,
      );
      await tx.$executeRawUnsafe(
        'UPDATE public."ProjectUpdatePolicy" SET revision=$3,"changedBy"=$4,"changedAt"=$5 WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid',
        current.customerId, id, revision, current.subject, changedAt,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,\'project_update.policy.changed\',$4,$5::jsonb,$6)',
        randomUUID(), current.customerId, current.subject, correlationId,
        stringify({
          projectId: id,
          revision,
          freshnessWindowSeconds: change.freshnessWindowSeconds,
          timeZone: change.timeZone,
          requiredFactTypes: change.requiredFacts.map((fact) => fact.factType),
          responsibleSubject: change.responsibleSubject,
          scheduledScanEnabled: change.scheduledScanEnabled,
        }), changedAt,
      );
      return policyView({
        policyRevisionId: revisionId,
        projectId: id,
        revision,
        freshnessWindowSeconds: change.freshnessWindowSeconds,
        timeZone: change.timeZone,
        requiredFacts: change.requiredFacts,
        responsibleSubject: change.responsibleSubject,
        scheduledScanEnabled: change.scheduledScanEnabled,
        scheduledServiceSubject: scheduledSubject,
        changedBy: current.subject,
        changedAt,
      });
    });
  }

  private async currentOpen(tx: Tx, customerId: string, id: string) {
    const rows = await tx.$queryRawUnsafe<{
      id: string; cycleHash: string; dueAt: Date; state: "OPEN";
    }[]>(
      'SELECT id,"cycleHash","freshnessThresholdAt" AS "dueAt",state FROM public."ProjectUpdateObligation" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND state=\'OPEN\' FOR UPDATE',
      customerId, id,
    );
    return rows[0] ?? null;
  }

  private async assessCore(current: Actor, id: string, correlationId: string, scheduled: boolean): Promise<ProjectUpdateAssessmentView> {
    return this.transaction(async (tx) => {
      await this.authorize(tx, current, id, scheduled);
      const project = await this.loadProject(tx, current.customerId, id);
      const policy = await this.loadPolicy(tx, current.customerId, id, true);
      if (!policy) throw new ProjectUpdateError("CONFLICT");
      if (scheduled &&
        (!policy.scheduledScanEnabled ||
         policy.scheduledServiceSubject !== current.subject ||
         !this.serviceSubject ||
         this.serviceSubject !== current.subject))
        throw new ProjectUpdateError("DENIED");
      const requiredFacts = policyFacts(policy.requiredFacts);
      const asOf = await this.now(tx);
      const facts = await tx.$queryRawUnsafe<FactRow[]>(
        'SELECT id,"factType",revision FROM public."ProjectFact" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factType"=ANY($3::text[]) ORDER BY "factType",id FOR SHARE',
        current.customerId, id, requiredFacts.map((fact) => fact.factType),
      );
      const factByType = new Map(facts.map((fact) => [fact.factType, fact]));
      const prefixes = facts.length
        ? await this.authority.loadAssessmentPrefixesInTransaction(tx, current, id, facts, asOf)
        : new Map();
      if (prefixes === null) throw new ProjectUpdateError("UNAVAILABLE");

      const factAssessments: Array<{
        factType: string;
        canonicalVersionCount: number;
        sourceAuthorityStatus: "RESOLVED" | "UNKNOWN" | "CONFLICTING" | "AMBIGUOUS" | "INCOMPLETE" | "REVALIDATION_REQUIRED" | "NO_POLICY" | "POLICY_NOT_APPLICABLE";
        conflict: "NONE" | "CONFLICTING";
      }> = [];
      const evidence: ProjectUpdateFactReference[] = [];
      const knownPosition: ProjectUpdateKnownPosition[] = [];
      const trustedTimes: number[] = [];
      let allTrusted = true;
      for (const requirement of requiredFacts) {
        const fact = factByType.get(requirement.factType);
        if (!fact) {
          allTrusted = false;
          factAssessments.push({
            factType: requirement.factType,
            canonicalVersionCount: 0,
            sourceAuthorityStatus: "UNKNOWN",
            conflict: "NONE",
          });
          continue;
        }
        const prepared = await this.authority.prepareAssessmentInTransaction(tx, current, {
          projectId: id,
          fact,
          asOf,
          prefix: prefixes.get(fact.id),
        });
        const resolved = prepared.result as unknown as Resolution;
        const statuses = new Set([
          "RESOLVED", "UNKNOWN", "CONFLICTING", "AMBIGUOUS", "INCOMPLETE",
          "REVALIDATION_REQUIRED", "NO_POLICY", "POLICY_NOT_APPLICABLE",
        ]);
        const status = statuses.has(resolved.status)
          ? resolved.status as typeof factAssessments[number]["sourceAuthorityStatus"]
          : "INCOMPLETE";
        const versionsCount = Math.max(
          resolved.candidateVersionIds.length,
          resolved.supportingVersionIds.length,
        );
        factAssessments.push({
          factType: requirement.factType,
          canonicalVersionCount: versionsCount,
          sourceAuthorityStatus: status,
          conflict: resolved.conflict === "CONFLICTING" ? "CONFLICTING" : "NONE",
        });
        if (status !== "RESOLVED" || resolved.conflict !== "NONE" ||
            !resolved.supportingVersionIds.length) {
          allTrusted = false;
          continue;
        }
        const selected = prepared.versions.filter((version) =>
          resolved.supportingVersionIds.includes(version.id),
        );
        if (!selected.length) {
          allTrusted = false;
          continue;
        }
        for (const version of selected) {
          const authorityVersion = resolved.versions.find((item) => item.id === version.id);
          const access = prepared.access.find((item) => item.sourceId === version.sourceId);
          if (
            authorityVersion?.visibility !== "available" ||
            !access || access.state !== "AVAILABLE" ||
            !access.readers.some((reader) => reader.subject === current.subject)
          ) {
            allTrusted = false;
            continue;
          }
          const sourceType = authorityVersion.sourceType ?? "";
          const basis = sourceType === "human_statement"
            ? "observedAt"
            : selectorBasis(resolved.policy, resolved.selectedTier, sourceType, version.sourceId);
          const observedAt = version.evidence.observedAt;
          const effectiveAt = version.effectiveAt;
          const selectedTime = selectCanonicalProjectUpdateTimestamp({
            sourceType,
            selectedBasis: basis,
            observedAt,
            effectiveAt,
            effectiveAtValidated: authorityVersion?.effectiveAtValidated === true,
            asOf,
          });
          const timestampBasis = selectedTime.timestampBasis;
          if (selectedTime.timestamp)
            trustedTimes.push(selectedTime.timestamp.getTime());
          else
            allTrusted = false;
          const reference: ProjectUpdateFactReference = {
            factId: fact.id,
            factType: requirement.factType,
            versionId: version.id,
            evidenceId: version.evidenceId,
            sourceId: version.sourceId,
            sourceAccessRevision: access.revision,
            authorityRevision: prepared.event?.revision ?? null,
            observedAt: iso(observedAt),
            effectiveAt: iso(effectiveAt),
            timestampBasis,
          };
          evidence.push(reference);
          knownPosition.push({
            factType: requirement.factType,
            label: requirement.label,
            value: knownPositionValue(version.value),
            versionId: reference.versionId,
            evidenceId: reference.evidenceId,
            sourceId: reference.sourceId,
            sourceAccessRevision: reference.sourceAccessRevision,
            authorityRevision: reference.authorityRevision,
            observedAt: reference.observedAt,
            effectiveAt: reference.effectiveAt,
            timestampBasis: reference.timestampBasis,
          });
        }
      }
      const completeness = assessProjectCompleteness({
        assessedAt: iso(asOf),
        projectId: id,
        ruleKey: "project-update",
        ruleRevision: String(policy.revision),
        requiredFactsComplete: true,
        requiredFacts,
        factAssessments,
      });
      allTrusted = allTrusted && evidence.length > 0 &&
        evidence.every((item) => item.timestampBasis !== "UNCONFIRMED");
      const latestValidUpdateAt = allTrusted
        ? new Date(Math.min(...trustedTimes)).toISOString()
        : null;
      const freshnessThresholdAt = new Date(
        Date.parse(latestValidUpdateAt ?? iso(project.createdAt)) +
          policy.freshnessWindowSeconds * 1000,
      );
      if (!Number.isFinite(freshnessThresholdAt.getTime()))
        throw new ProjectUpdateError("UNAVAILABLE");
      const freshnessAssessment = assessUpdateFreshness({
        asOf: iso(asOf),
        timeZone: policy.timeZone,
        timeZoneSource: "PROJECT",
        project: {
          id,
          code: project.code,
          name: project.name,
          createdAt: iso(project.createdAt),
          latestValidUpdateAt,
        },
        policy: {
          key: "project-update",
          revision: String(policy.revision),
          freshnessWindowSeconds: policy.freshnessWindowSeconds,
          responsibleSubject: policy.responsibleSubject,
          obligationDueAt: iso(freshnessThresholdAt),
          requiredFacts,
        },
      });
      const sourceDate = freshnessAssessment.freshness.sourceDate;
      const sourceDateTime = datesFromJson(sourceDate);
      if (!sourceDateTime) throw new ProjectUpdateError("UNAVAILABLE");
      const cycleRequiredFacts = [...requiredFacts].sort((left, right) =>
        left.factType.localeCompare(right.factType),
      );
      const cycleHash = hash({
        sourceDateField: freshnessAssessment.freshness.sourceDateField,
        sourceDate,
        thresholdAt: iso(freshnessThresholdAt),
        responsibleSubject: policy.responsibleSubject,
        requiredFacts: cycleRequiredFacts,
      });
      const assessmentId = randomUUID();
      const open = await this.currentOpen(tx, current.customerId, id);
      const stale = freshnessAssessment.freshness.state === "STALE";
      const reuse = stale && open?.cycleHash === cycleHash;
      const supersede = open !== null && !reuse;
      const obligationId = stale
        ? (reuse ? open!.id : randomUUID())
        : null;
      const obligationState = stale ? "OPEN" as const : null;
      const safeInput = {
        project: {
          id, code: project.code, name: project.name,
          reportedStatus: project.reportedStatus,
        },
        policyRevision: policy.revision,
        assessedAt: iso(asOf),
        latestValidUpdateAt,
        sourceDateField: freshnessAssessment.freshness.sourceDateField,
        sourceDate,
        freshnessThresholdAt: iso(freshnessThresholdAt),
        timestampBasis: allTrusted ? "REQUIRED_FACTS" : "UNCONFIRMED",
      };
      const safeResult = {
        completeness,
        freshness: freshnessAssessment.freshness,
      };
      const dependencyData: DependencyRow[] = evidence;
      const envelopeHash = hash({ input: safeInput, result: safeResult, dependencies: dependencyData });
      const previewId = stale ? randomUUID() : null;
      const previewRevisionRows = stale
        ? await tx.$queryRawUnsafe<{ revision: number }[]>(
            'SELECT COALESCE(MAX(revision),0)::int AS revision FROM public."ProjectUpdatePreview" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "obligationId"=$3::uuid',
            current.customerId, id, obligationId,
          )
        : [];
      const previewRevision = stale ? (previewRevisionRows[0]?.revision ?? 0) + 1 : null;
      const preview: ProjectUpdatePreview | null = stale
        ? {
            id: previewId!,
            revision: previewRevision!,
            createdAt: iso(asOf),
            project: { id, code: project.code, name: project.name },
            reportedStatus: project.reportedStatus,
            policyRevision: policy.revision,
            assessedAt: iso(asOf),
            freshnessThresholdAt: iso(freshnessThresholdAt),
            sourceDateField: freshnessAssessment.freshness.sourceDateField as ProjectUpdatePreview["sourceDateField"],
            sourceDate,
            timestampBasis: allTrusted
              ? "REQUIRED_FACTS"
              : (latestValidUpdateAt === null && evidence.length === 0
                ? "UNCONFIRMED"
                : "UNCONFIRMED"),
            completenessState: completeness.state,
            freshnessState: freshnessAssessment.freshness.state,
            requiredFacts: completeness.factAssessments.map((fact) => ({
              factType: fact.factType,
              label: fact.label,
              state: fact.state,
              reasonCodes: [...fact.reasonCodes],
            })),
            evidence,
          }
        : null;
      const previewHash = preview ? hash(preview) : null;
      const auditId = randomUUID();
      await tx.$executeRawUnsafe(
        'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,\'project_update.assessed\',$4,$5::jsonb,$6)',
        auditId, current.customerId, current.subject, correlationId,
        stringify({
          projectId: id,
          assessmentId,
          policyRevision: policy.revision,
          envelopeHash,
          obligationId,
          freshnessState: freshnessAssessment.freshness.state,
          completenessState: completeness.state,
        }), asOf,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."ProjectUpdateAssessment" (id,"customerId","projectId","policyRevisionId","policyRevision","assessedAt",input,result,dependencies,"envelopeHash","auditEventId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::uuid)',
        assessmentId, current.customerId, id, policy.policyRevisionId,
        policy.revision, asOf, stringify(safeInput), stringify(safeResult),
        stringify(dependencyData), envelopeHash, auditId,
      );
      if (supersede && open) {
        await tx.$executeRawUnsafe(
          'UPDATE public."ProjectUpdateObligation" SET state=\'SUPERSEDED\',"supersededAt"=$3 WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$4::uuid AND state=\'OPEN\'',
          current.customerId, id, asOf, open.id,
        );
        await tx.$executeRawUnsafe(
          'UPDATE public."ProjectUpdatePreview" SET state=\'SUPERSEDED\' WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "obligationId"=$3::uuid AND state=\'CURRENT\'',
          current.customerId, id, open.id,
        );
      }
      if (stale && !reuse) {
        await tx.$executeRawUnsafe(
          'INSERT INTO public."ProjectUpdateObligation" (id,"customerId","projectId","policyRevisionId","policyRevision","assessmentId","cycleHash","sourceDateField","sourceDate","freshnessThresholdAt","responsibleSubject","requiredFacts",state,"createdAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::uuid,$7,$8,$9,$10,$11,$12::jsonb,\'OPEN\',$13)',
          obligationId, current.customerId, id, policy.policyRevisionId,
          policy.revision, assessmentId, cycleHash,
          freshnessAssessment.freshness.sourceDateField, sourceDateTime,
          freshnessThresholdAt, policy.responsibleSubject,
          stringify(cycleRequiredFacts), asOf,
        );
      }
      if (stale && preview && previewHash) {
        await tx.$executeRawUnsafe(
          'UPDATE public."ProjectUpdatePreview" SET state=\'SUPERSEDED\' WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "obligationId"=$3::uuid AND state=\'CURRENT\'',
          current.customerId, id, obligationId,
        );
        await tx.$executeRawUnsafe(
          'INSERT INTO public."ProjectUpdatePreview" (id,"customerId","projectId","obligationId","assessmentId",revision,state,preview,"envelopeHash","createdAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,\'CURRENT\',$7::jsonb,$8,$9)',
          preview.id, current.customerId, id, obligationId, assessmentId,
          preview.revision, stringify(preview), previewHash, asOf,
        );
      }
      return {
        project: {
          id, code: project.code, name: project.name,
          reportedStatus: project.reportedStatus,
        },
        assessedAt: iso(asOf),
        policy: policyView(policy),
        completeness,
        freshness: freshnessAssessment.freshness,
        obligation: obligationId
          ? { id: obligationId, state: obligationState!, dueAt: iso(freshnessThresholdAt) }
          : null,
        preview,
        knownPosition: knownPosition.sort((left, right) =>
          left.factType.localeCompare(right.factType) ||
          left.sourceId.localeCompare(right.sourceId) ||
          left.versionId.localeCompare(right.versionId),
        ),
      };
    });
  }

  async assess(actorValue: Actor, projectValue: string, correlationValue: string) {
    const current = parseActor(actorValue);
    const id = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.assessCore(current, id, correlationId, false);
  }

  private async resolveKnownPosition(
    tx: Tx,
    current: Actor,
    id: string,
    value: unknown,
    requiredFactsValue: unknown,
  ): Promise<ProjectUpdateKnownPosition[]> {
    let entries: DependencyRow[];
    try {
      entries = z.array(projectUpdateFactReferenceSchema)
        .max(1000)
        .parse(jsonValue(value));
    } catch { throw new ProjectUpdateError("UNAVAILABLE"); }
    if (entries.length === 0) return [];
    const rows = await tx.$queryRawUnsafe<Array<{
      factType: string;
      value: unknown;
      versionId: string;
      evidenceId: string;
      sourceId: string;
      sourceAccessRevision: number;
      authorityRevision: number | null;
      observedAt: Date;
      effectiveAt: Date;
      timestampBasis: ProjectUpdateFactReference["timestampBasis"];
    }>>(
      'WITH d AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x("factId" uuid,"factType" text,"versionId" uuid,"evidenceId" uuid,"sourceId" uuid,"sourceAccessRevision" integer,"authorityRevision" integer,"observedAt" timestamptz,"effectiveAt" timestamptz,"timestampBasis" text)) SELECT d."factType",v.value,d."versionId",d."evidenceId",d."sourceId",d."sourceAccessRevision",d."authorityRevision",d."observedAt",d."effectiveAt",d."timestampBasis" FROM d JOIN public."ProjectFact" f ON f."customerId"=$1::uuid AND f."projectId"=$2::uuid AND f.id=d."factId" AND f."factType"=d."factType" JOIN public."ProjectFactVersion" v ON v."customerId"=f."customerId" AND v."projectId"=f."projectId" AND v."factId"=f.id AND v."sourceId"=d."sourceId" AND v.id=d."versionId" AND v."evidenceId"=d."evidenceId" JOIN public."FactEvidence" e ON e."customerId"=v."customerId" AND e."projectId"=v."projectId" AND e."factId"=v."factId" AND e."sourceId"=v."sourceId" AND e.id=v."evidenceId" JOIN public."FactSourceAccess" a ON a."customerId"=v."customerId" AND a."projectId"=v."projectId" AND a."factId"=v."factId" AND a."sourceId"=v."sourceId" AND a.state=\'AVAILABLE\' JOIN public."FactSourceReader" r ON r."customerId"=a."customerId" AND r."projectId"=a."projectId" AND r."factId"=a."factId" AND r."sourceId"=a."sourceId" AND r.subject=$4 ORDER BY d."factType",d."sourceId",d."versionId"',
      current.customerId, id, stringify(entries), current.subject,
    );
    // Missing or revoked references are omitted; their values never enter the response.
    const labels = new Map(policyFacts(requiredFactsValue).map((fact) => [
      fact.factType,
      fact.label,
    ]));
    return rows.map((row) => {
      const label = labels.get(row.factType);
      if (!label) throw new ProjectUpdateError("UNAVAILABLE");
      return {
        factType: row.factType,
        label,
        value: knownPositionValue(row.value),
        versionId: row.versionId,
        evidenceId: row.evidenceId,
        sourceId: row.sourceId,
        sourceAccessRevision: row.sourceAccessRevision,
        authorityRevision: row.authorityRevision,
        observedAt: iso(row.observedAt),
        effectiveAt: iso(row.effectiveAt),
        timestampBasis: row.timestampBasis,
      };
    });
  }

  private async assessmentView(tx: Tx, current: Actor, row: AssessmentRow, requireAccess: boolean) {
    const knownPosition = requireAccess
      ? await this.resolveKnownPosition(
          tx, current, row.projectId, row.dependencies, row.requiredFacts,
        )
      : [];
    const result = safeObject.parse(jsonValue(row.result));
    let preview: ProjectUpdatePreview | null = null;
    if (row.preview) {
      try {
        const stored = row.preview as ProjectUpdatePreview;
        const readableVersions = new Set(knownPosition.map((fact) => fact.versionId));
        preview = {
          ...stored,
          evidence: stored.evidence.filter((fact) => readableVersions.has(fact.versionId)),
        };
      } catch { throw new ProjectUpdateError("UNAVAILABLE"); }
    }
    return {
      project: {
        id: row.projectId, code: row.code, name: row.name,
        reportedStatus: row.reportedStatus,
      },
      assessedAt: iso(row.assessedAt),
      policy: policyView({
        policyRevisionId: row.policyRevisionId,
        projectId: row.projectId,
        revision: row.policyRevision,
        freshnessWindowSeconds: row.freshnessWindowSeconds,
        timeZone: row.timeZone,
        requiredFacts: row.requiredFacts,
        responsibleSubject: row.responsibleSubject,
        scheduledScanEnabled: row.scheduledScanEnabled,
        scheduledServiceSubject: null,
        changedBy: row.changedBy,
        changedAt: row.changedAt,
      }),
      completeness: result.completeness as ProjectUpdateAssessmentView["completeness"],
      freshness: result.freshness as ProjectUpdateAssessmentView["freshness"],
      obligation: row.obligationId && row.obligationState && row.dueAt
        ? { id: row.obligationId, state: row.obligationState, dueAt: iso(row.dueAt) }
        : null,
      preview,
      knownPosition,
    } satisfies ProjectUpdateAssessmentView;
  }

  async latest(actorValue: Actor, projectValue: string) {
    const current = parseActor(actorValue);
    const id = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, current, id, false);
      const rows = await tx.$queryRawUnsafe<AssessmentRow[]>(
        'SELECT a.id,a."customerId",a."projectId",a."policyRevisionId",a."policyRevision",a."assessedAt",a.input,a.result,a.dependencies,a."envelopeHash",a."auditEventId",p.code,p.name,p."reportedStatus",c."createdAt",r."responsibleSubject",r."freshnessWindowSeconds",r."timeZone",r."requiredFacts",r."scheduledScanEnabled",r."changedBy",r."changedAt",o.id AS "obligationId",o.state AS "obligationState",o."freshnessThresholdAt" AS "dueAt",v.id AS "previewId",v.revision AS "previewRevision",v.preview FROM public."ProjectUpdateAssessment" a JOIN public."ProjectUpdatePolicyRevision" r ON r."customerId"=a."customerId" AND r."projectId"=a."projectId" AND r.id=a."policyRevisionId" JOIN public."Project" p ON p."customerId"=a."customerId" AND p.id=a."projectId" JOIN public."CanonicalProject" c ON c."customerId"=p."customerId" AND c.id=p.id LEFT JOIN public."ProjectUpdateObligation" o ON o."customerId"=a."customerId" AND o."projectId"=a."projectId" AND o.state=\'OPEN\' LEFT JOIN public."ProjectUpdatePreview" v ON v."customerId"=o."customerId" AND v."projectId"=o."projectId" AND v."obligationId"=o.id AND v."assessmentId"=a.id AND v.state=\'CURRENT\' WHERE a."customerId"=$1::uuid AND a."projectId"=$2::uuid ORDER BY a."assessedAt" DESC,a.id DESC LIMIT 1 FOR SHARE OF a,p,c',
        current.customerId, id,
      );
      return rows[0] ? this.assessmentView(tx, current, rows[0], true) : null;
    });
  }

  async scanScheduledProjects(limitValue: number) {
    if (!this.serviceSubject) throw new ProjectUpdateError("UNAVAILABLE");
    const limit = z.number().int().min(1).max(1).safeParse(limitValue);
    if (!limit.success) throw new ProjectUpdateError("INVALID_REQUEST");
    let candidate: { customerId: string; projectId: string } | null;
    try {
      candidate = await this.db.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{
          customerId: string;
          projectId: string;
        }>>(
          'SELECT p."customerId",p."projectId" FROM public."ProjectUpdatePolicy" p JOIN public."ProjectUpdatePolicyRevision" r ON r."customerId"=p."customerId" AND r."projectId"=p."projectId" AND r.revision=p.revision WHERE r."scheduledScanEnabled"=true AND r."scheduledServiceSubject"=$1 AND (p."scheduledScanNextEligibleAt" IS NULL OR p."scheduledScanNextEligibleAt"<=clock_timestamp()) ORDER BY p."scheduledScanLastAttemptAt" ASC NULLS FIRST,p."customerId",p."projectId" LIMIT 1 FOR UPDATE OF p SKIP LOCKED',
          this.serviceSubject,
        );
        const selected = rows[0];
        if (!selected) return null;
        await tx.$executeRawUnsafe(
          'UPDATE public."ProjectUpdatePolicy" SET "scheduledScanLastAttemptAt"=date_trunc(\'milliseconds\',clock_timestamp()),"scheduledScanNextEligibleAt"=date_trunc(\'milliseconds\',clock_timestamp())+($3::int*interval \'1 second\') WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid',
          selected.customerId,
          selected.projectId,
          SCHEDULED_SCAN_INTERVAL_SECONDS,
        );
        return selected;
      }, {
        isolationLevel: "ReadCommitted",
        maxWait: 5000,
        timeout: 10000,
      });
    } catch (error) { mapError(error); }
    if (!candidate) return 0;
    const serviceActor: Actor = {
      customerId: candidate.customerId,
      subject: this.serviceSubject,
      roles: [],
    };
    // Persisted eligibility caps immutable history growth. Failures receive a shorter
    // retry delay; the attempt timestamp still rotates this project behind peers.
    try {
      await this.assessCore(serviceActor, candidate.projectId, randomUUID(), true);
    } catch (error) {
      try {
        await this.db.$executeRawUnsafe(
          'UPDATE public."ProjectUpdatePolicy" SET "scheduledScanNextEligibleAt"=date_trunc(\'milliseconds\',clock_timestamp())+($3::int*interval \'1 second\') WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid',
          candidate.customerId,
          candidate.projectId,
          SCHEDULED_SCAN_RETRY_SECONDS,
        );
      } catch (retryError) { mapError(retryError); }
      throw error;
    }
    return 1;
  }
}
