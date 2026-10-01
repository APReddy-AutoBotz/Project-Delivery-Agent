import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  deriveProjectUpdateSourceSatisfaction,
  projectUpdateCaptureConfigurationSchema, projectUpdateInvitationLocatorSchema,
  projectUpdateResponseSubmissionSchema, projectUpdateRecipientRequestViewSchema,
  mayAccessProjectUpdateInvitation, renderProjectUpdateCapture,
  type ProjectUpdateCaptureConfiguration, type ProjectUpdateRecipientRequestView,
  type ProjectUpdateResponseReceipt, type ProjectUpdateCaptureHistory,
  projectUpdateZoneConfigurationSchema,
  planProjectUpdateRecipientStage,
  type ProjectUpdateZoneConfiguration,
  type ProjectUpdateEngagementView,
  type ProjectUpdateRecipientStageSnapshot,
  assessProjectCompleteness,
  assessUpdateFreshness,
  projectUpdatePolicyChangeSchema,
  projectUpdateFactReferenceSchema,
  projectUpdateCadenceFieldsSchema,
  previewProjectUpdateSchedule,
  type ProjectUpdateSchedulePreview,
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

type CaptureInvitationRow = {
  invitationId: string; requestId: string; recipientSubject: string; issuanceEpoch: string;
  issuedAt: Date; expiresAt: Date; capturedAt: Date; purgeAfter: Date;
  contentRetentionSeconds: number; reviewerSubjects: string[]; requiredFacts: unknown; dependencies: unknown;
  body: string | null; contentState: "PRESENT" | "PURGED"; stageId: string;
  stageKind: "REQUEST" | "REMINDER" | "ESCALATION"; recipientRole: "OWNER" | "PROJECT_MANAGER";
  logicalDueAt: Date; stageGeneration: number; policyRevision: number; ownerSubject: string;
  engagementState: string; engagementGeneration: number; obligationState: string;
  currentPolicyRevision: number; outboxState: string; code: string; name: string;
};

type EngagementRow = {
  id: string; customerId: string; projectId: string; obligationId: string;
  policyRevisionId: string; policyRevision: number; assessmentId: string;
  ownerSubject: string; generation: number; state: "ACTIVE" | "PAUSED" | "CLOSED";
  sourceSatisfiedFactTypes: string[];
};
type PendingStage = ProjectUpdateRecipientStageSnapshot & {
  id: string; engagementId: string; generation: number; factTypes: string[];
  outboxId: string; outboxState: "READY" | "CLAIMED"; claimGeneration: number;
  availableAt: Date; leaseUntil: Date | null; mode: string;
};
type PreparedUpdate = {
  view: ProjectUpdateAssessmentView; assessmentId: string; asOf: Date; policy: PolicyRow;
  source: ReturnType<typeof deriveProjectUpdateSourceSatisfaction>;
};
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
  reminderBusinessDayOffsets: number[];
  escalationAfterBusinessDays: number;
  escalationRecipientSubject: string | null;
  quietHoursStartLocal: string | null;
  quietHoursEndLocal: string | null;
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
  reminderBusinessDayOffsets: number[];
  escalationAfterBusinessDays: number;
  escalationRecipientSubject: string | null;
  quietHoursStartLocal: string | null;
  quietHoursEndLocal: string | null;
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
  versions: Array<{ id: string; visibility: string; sourceType?: string }>;
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
function policyCadence(row: Pick<PolicyRow,
  "reminderBusinessDayOffsets" | "escalationAfterBusinessDays" |
  "escalationRecipientSubject" | "quietHoursStartLocal" | "quietHoursEndLocal"
>) {
  try {
    return projectUpdateCadenceFieldsSchema.parse({
      reminderBusinessDayOffsets: row.reminderBusinessDayOffsets,
      escalationAfterBusinessDays: row.escalationAfterBusinessDays,
      escalationRecipientSubject: row.escalationRecipientSubject,
      quietHoursStartLocal: row.quietHoursStartLocal,
      quietHoursEndLocal: row.quietHoursEndLocal,
    });
  } catch { throw new ProjectUpdateError("UNAVAILABLE"); }
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
    ...policyCadence(row),
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
  private readonly zones: ProjectUpdateZoneConfiguration | null;

  constructor(
    private readonly db: Database,
    configuredServiceSubject?: string | null,
    zones?: ProjectUpdateZoneConfiguration | null,
    private readonly captureReader?: () => { globalShadowMode: string; configuration: unknown },
  ) {
    this.authority = new DatabaseAuthorityRepository(db);
    this.zones = zones ? projectUpdateZoneConfigurationSchema.parse(zones) : null;
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
      'SELECT r.id AS "policyRevisionId",r."projectId",r.revision,r."freshnessWindowSeconds",r."timeZone",r."requiredFacts",r."responsibleSubject",r."scheduledScanEnabled",r."scheduledServiceSubject",r."reminderBusinessDayOffsets",r."escalationAfterBusinessDays",r."escalationRecipientSubject",r."quietHoursStartLocal",r."quietHoursEndLocal",r."changedBy",r."changedAt" FROM public."ProjectUpdatePolicy" p JOIN public."ProjectUpdatePolicyRevision" r ON r."customerId"=p."customerId" AND r."projectId"=p."projectId" AND r.revision=p.revision WHERE p."customerId"=$1::uuid AND p."projectId"=$2::uuid AND p.key=\'project-update\'' + (lock ? " FOR UPDATE OF p" : ""),
      customerId, id,
    );
    return rows[0] ?? null;
  }

  private async validateEscalationRecipient(
    tx: Tx,
    customerId: string,
    projectId: string,
    subject: string | null,
  ) {
    if (subject === null) return;
    const responsibilities = await tx.$queryRawUnsafe<{ subject: string }[]>(
      'SELECT subject FROM public."ProjectResponsibility" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND role=\'PROJECT_MANAGER\' AND subject=$3',
      customerId, projectId, subject,
    );
    if (!responsibilities[0]) throw new ProjectUpdateError("INVALID_REQUEST");
    try {
      await authorizeFactProject(tx, {
        customerId,
        subject,
        roles: ["project_manager"],
      }, projectId, "read");
    } catch {
      throw new ProjectUpdateError("DENIED");
    }
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
        'SELECT subject FROM public."ProjectResponsibility" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND role=\'RESPONSIBLE_OWNER\' AND subject=$3',
        current.customerId, id, change.responsibleSubject,
      );
      if (!owner[0]) throw new ProjectUpdateError("INVALID_REQUEST");
      await this.validateEscalationRecipient(
        tx, current.customerId, id, change.escalationRecipientSubject,
      );
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
        'INSERT INTO public."ProjectUpdatePolicyRevision" (id,"customerId","projectId",revision,"freshnessWindowSeconds","timeZone","requiredFacts","responsibleSubject","scheduledScanEnabled","scheduledServiceSubject","changedBy","changedAt","reminderBusinessDayOffsets","escalationAfterBusinessDays","escalationRecipientSubject","quietHoursStartLocal","quietHoursEndLocal") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::smallint[],$14,$15,$16,$17)',
        revisionId, current.customerId, id, revision, change.freshnessWindowSeconds,
        change.timeZone, stringify(change.requiredFacts), change.responsibleSubject,
        change.scheduledScanEnabled, scheduledSubject, current.subject, changedAt,
        change.reminderBusinessDayOffsets, change.escalationAfterBusinessDays,
        change.escalationRecipientSubject, change.quietHoursStartLocal,
        change.quietHoursEndLocal,
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
          reminderBusinessDayOffsets: change.reminderBusinessDayOffsets,
          escalationAfterBusinessDays: change.escalationAfterBusinessDays,
          escalationRecipientSubject: change.escalationRecipientSubject,
          quietHoursStartLocal: change.quietHoursStartLocal,
          quietHoursEndLocal: change.quietHoursEndLocal,
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
        reminderBusinessDayOffsets: change.reminderBusinessDayOffsets,
        escalationAfterBusinessDays: change.escalationAfterBusinessDays,
        escalationRecipientSubject: change.escalationRecipientSubject,
        quietHoursStartLocal: change.quietHoursStartLocal,
        quietHoursEndLocal: change.quietHoursEndLocal,
        changedBy: current.subject,
        changedAt,
      });
    });
  }

  private async currentOpen(tx: Tx, customerId: string, id: string) {
    const rows = await tx.$queryRawUnsafe<{
      id: string; cycleHash: string; dueAt: Date; state: "OPEN";
      policyRevisionId: string; policyRevision: number;
    }[]>(
      'SELECT id,"cycleHash","freshnessThresholdAt" AS "dueAt",state,"policyRevisionId","policyRevision" FROM public."ProjectUpdateObligation" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND state=\'OPEN\' FOR UPDATE',
      customerId, id,
    );
    return rows[0] ?? null;
  }

  private async assessInTransaction(tx: Tx, current: Actor, id: string, correlationId: string, scheduled: boolean): Promise<PreparedUpdate> {
      // Match source append/configuration lock order before taking shared fact locks.
      const locked = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR UPDATE',
        current.customerId, id,
      );
      if (!locked[0]) throw new ProjectUpdateError("DENIED");
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
      const sourceChecks: Array<{ factType: string; sourceState: "MISSING" | "UNKNOWN" | "RESOLVED"; trustedTimes: string[] }> = [];
      let allTrusted = true;
      for (const requirement of requiredFacts) {
        const check = { factType: requirement.factType, sourceState: "MISSING" as "MISSING" | "UNKNOWN" | "RESOLVED", trustedTimes: [] as string[] };
        sourceChecks.push(check);
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
        check.sourceState = "UNKNOWN";
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
        let factTrusted = selected.length === resolved.supportingVersionIds.length;
        for (const version of selected) {
          const authorityVersion = resolved.versions.find((item) => item.id === version.id);
          const effectiveAtValidated = prepared.snapshot.versions.some(
            (item) => item.id === version.id && item.effectiveAtValidated === true,
          );
          const access = prepared.access.find((item) => item.sourceId === version.sourceId);
          if (
            authorityVersion?.visibility !== "available" ||
            !access || access.state !== "AVAILABLE" ||
            !access.readers.some((reader) => reader.subject === current.subject)
          ) {
            allTrusted = false;
            factTrusted = false;
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
            effectiveAtValidated,
            asOf,
          });
          const timestampBasis = selectedTime.timestampBasis;
          if (selectedTime.timestamp) {
            trustedTimes.push(selectedTime.timestamp.getTime());
            check.trustedTimes.push(iso(selectedTime.timestamp));
          } else {
            allTrusted = false;
            factTrusted = false;
          }
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
        allTrusted = allTrusted && factTrusted;
        if (factTrusted) check.sourceState = "RESOLVED";
      }
      const source = deriveProjectUpdateSourceSatisfaction({
        asOf: iso(asOf), freshnessWindowSeconds: policy.freshnessWindowSeconds, checks: sourceChecks,
      });
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
      const activeCycle = open ? await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM public."ProjectUpdateEngagement" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "obligationId"=$3::uuid AND state IN (\'ACTIVE\',\'PAUSED\') FOR UPDATE',
        current.customerId, id, open.id,
      ) : [];
      const samePolicy = open !== null && open.policyRevisionId === policy.policyRevisionId &&
        open.policyRevision === policy.revision;
      const stale = freshnessAssessment.freshness.state === "STALE" ||
        (activeCycle.length > 0 && samePolicy && source.remainingFactTypes.length > 0);
      // A durable cycle keeps its pending actions while any required facts remain
      // unresolved. New source timestamps do not discard an active request.
      const reuse = stale && open !== null &&
        (open.cycleHash === cycleHash || activeCycle.length > 0) &&
        open.policyRevisionId === policy.policyRevisionId && open.policyRevision === policy.revision;
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
        sourceTimeBasis: freshnessAssessment.freshness.sourceDateField === "project.createdAt"
          ? "PROJECT_CREATED_AT"
          : allTrusted ? "REQUIRED_FACTS" : "UNCONFIRMED",
        timestampBasis: allTrusted ? "REQUIRED_FACTS" : "UNCONFIRMED",
      };
      const safeResult = {
        completeness,
        freshness: freshnessAssessment.freshness,
        engagementFacts: source.facts,
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
      const view: ProjectUpdateAssessmentView = {
        project: {
          id, code: project.code, name: project.name,
          reportedStatus: project.reportedStatus,
        },
        assessedAt: iso(asOf),
        policy: policyView(policy),
        completeness,
        freshness: freshnessAssessment.freshness,
        obligation: obligationId
          ? { id: obligationId, state: obligationState!, dueAt: iso(reuse ? open!.dueAt : freshnessThresholdAt) }
          : null,
        preview,
        knownPosition: knownPosition.sort((left, right) =>
          left.factType.localeCompare(right.factType) ||
          left.sourceId.localeCompare(right.sourceId) ||
          left.versionId.localeCompare(right.versionId),
        ),
      };
      const prepared = { view, assessmentId, asOf, policy, source };
      await this.refreshEngagements(tx, current, id, correlationId, prepared);
      return prepared;
  }

  private async assessCore(current: Actor, id: string, correlationId: string, scheduled: boolean): Promise<ProjectUpdateAssessmentView> {
    return this.transaction(async (tx) =>
      (await this.assessInTransaction(tx, current, id, correlationId, scheduled)).view,
    );
  }

  private async engagementAudit(tx: Tx, current: Actor, projectId: string, correlationId: string, event: string, detail: unknown) {
    const auditId = randomUUID();
    await tx.$executeRawUnsafe(
      "INSERT INTO public.\"AuditEvent\" (id,\"customerId\",actor,event,\"correlationId\",detail,\"occurredAt\") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7)",
      auditId, current.customerId, current.subject, event, correlationId, stringify(detail), await this.now(tx),
    );
    return auditId;
  }

  private async recipientAuthorized(tx: Tx, customerId: string, projectId: string, subject: string, role: "OWNER" | "PROJECT_MANAGER") {
    const rows = await tx.$queryRawUnsafe<{ subject: string }[]>(
      "SELECT subject FROM public.\"ProjectResponsibility\" WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND subject=$3 AND role=$4",
      customerId, projectId, subject, role === "OWNER" ? "RESPONSIBLE_OWNER" : "PROJECT_MANAGER",
    );
    if (!rows[0]) return false;
    const grants = await tx.$queryRawUnsafe<{ role: string }[]>(
      "SELECT g.role FROM public.\"AccessGrant\" g JOIN public.\"Project\" p ON p.\"customerId\"=g.\"customerId\" AND p.id=$2::uuid WHERE g.\"customerId\"=$1::uuid AND g.subject=$3 AND ((g.\"scopeType\"='project' AND g.\"scopeId\"=p.id) OR (g.\"scopeType\"='portfolio' AND g.\"scopeId\"=p.\"portfolioId\")) ORDER BY g.id FOR SHARE OF g",
      customerId, projectId, subject,
    );
    const allowed = role === "PROJECT_MANAGER" ? ["project_manager"]
      : ["project_manager", "portfolio_manager", "pmo_admin", "team_lead", "contributor"];
    return grants.some((grant) => allowed.includes(grant.role));
  }

  private async stagePlans(tx: Tx, customerId: string, projectId: string, policy: PolicyRow, dueAt: string) {
    if (!this.zones || this.zones.customerId !== customerId || !this.serviceSubject ||
        !policy.scheduledScanEnabled || policy.scheduledServiceSubject !== this.serviceSubject)
      throw new ProjectUpdateError("UNAVAILABLE");
    const projectZone = projectUpdateZoneConfigurationSchema.shape.customerTimeZone.parse(policy.timeZone);
    const allZones = [...new Set([this.zones.customerTimeZone, projectZone,
      ...this.zones.recipientTimeZones.map((item) => item.timeZone)])];
    const catalog = await tx.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM pg_catalog.pg_timezone_names WHERE name=ANY($1::text[])", allZones,
    );
    if (catalog.length !== allZones.length) throw new ProjectUpdateError("UNAVAILABLE");
    const zoneFor = (subject: string) =>
      this.zones!.recipientTimeZones.find((entry) => entry.subject === subject)?.timeZone ?? null;
    const base = { logicalDueAt: dueAt, projectTimeZone: projectZone,
      customerTimeZone: this.zones.customerTimeZone,
      quietHoursStartLocal: policy.quietHoursStartLocal, quietHoursEndLocal: policy.quietHoursEndLocal };
    const request = planProjectUpdateRecipientStage({
      ...base, kind: "REQUEST", ordinal: 0, recipientRole: "OWNER",
      recipientSubject: policy.responsibleSubject, recipientTimeZone: zoneFor(policy.responsibleSubject), anchorAt: dueAt,
    });
    const plans = [request];
    for (const ordinal of policy.reminderBusinessDayOffsets)
      plans.push(planProjectUpdateRecipientStage({
        ...base, kind: "REMINDER", ordinal, recipientRole: "OWNER",
        recipientSubject: policy.responsibleSubject, recipientTimeZone: zoneFor(policy.responsibleSubject), anchorAt: request.scheduledAt,
      }));
    const configurationActions: ProjectUpdateEngagementView["configurationActions"] = [];
    if (policy.escalationAfterBusinessDays > 0) {
      const ownerEscalation = planProjectUpdateRecipientStage({
        ...base, kind: "ESCALATION", ordinal: policy.escalationAfterBusinessDays,
        recipientRole: "OWNER", recipientSubject: policy.responsibleSubject,
        recipientTimeZone: zoneFor(policy.responsibleSubject), anchorAt: request.scheduledAt,
      });
      plans.push(ownerEscalation);
      const pm = policy.escalationRecipientSubject;
      if (pm && await this.recipientAuthorized(tx, customerId, projectId, pm, "PROJECT_MANAGER"))
        plans.push(planProjectUpdateRecipientStage({
          ...base, kind: "ESCALATION", ordinal: policy.escalationAfterBusinessDays,
          recipientRole: "PROJECT_MANAGER", recipientSubject: pm, recipientTimeZone: zoneFor(pm), anchorAt: ownerEscalation.scheduledAt,
        }));
      else configurationActions.push("PM_RECIPIENT_REVOKED");
    }
    return { plans, configurationActions };
  }

  private async pendingStages(tx: Tx, current: Actor, projectId: string, engagementId: string): Promise<PendingStage[]> {
    return tx.$queryRawUnsafe<PendingStage[]>(
      "SELECT s.id,s.\"engagementId\",s.generation,s.kind,s.ordinal,s.\"recipientSubject\",s.\"recipientRole\",s.\"factTypes\",s.\"timeZone\",s.\"zoneSource\",to_char(s.\"logicalDueAt\" AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"logicalDueAt\",to_char(s.\"candidateAt\" AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"candidateAt\",to_char(s.\"scheduledAt\" AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"scheduledAt\",s.\"localAt\",s.\"utcOffset\",s.\"deferralReasons\",s.\"ruleRevision\",s.mode,o.id AS \"outboxId\",o.state AS \"outboxState\",o.\"claimGeneration\",o.\"availableAt\",o.\"leaseUntil\" FROM public.\"ProjectUpdateStage\" s JOIN public.\"ProjectUpdateOutbox\" o ON o.\"customerId\"=s.\"customerId\" AND o.\"projectId\"=s.\"projectId\" AND o.\"stageId\"=s.id WHERE s.\"customerId\"=$1::uuid AND s.\"projectId\"=$2::uuid AND s.\"engagementId\"=$3::uuid AND o.state IN ('READY','CLAIMED') ORDER BY s.id FOR UPDATE OF o",
      current.customerId, projectId, engagementId,
    );
  }

  private async releaseExpired(tx: Tx, current: Actor, projectId: string, stage: PendingStage, correlationId: string) {
    if (stage.outboxState !== "CLAIMED") return;
    if (!stage.leaseUntil || stage.leaseUntil > await this.now(tx)) return;
    const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
      "project_update.stage.released", { stageId: stage.id, reason: "LEASE_EXPIRED" });
    const changed = await tx.$executeRawUnsafe(
      "UPDATE public.\"ProjectUpdateOutbox\" SET state='READY',\"leaseUntil\"=NULL,reason='LEASE_EXPIRED',\"auditEventId\"=$4::uuid WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid AND state='CLAIMED' AND \"claimGeneration\"=$5 AND \"leaseUntil\"<=clock_timestamp() AND \"handoffAt\" IS NULL",
      current.customerId, projectId, stage.outboxId, auditId, stage.claimGeneration,
    );
    if (changed !== 1) throw new ProjectUpdateError("CONFLICT");
    stage.outboxState = "READY";
  }

  private async suppressStage(tx: Tx, current: Actor, projectId: string, stage: PendingStage, reason: string, correlationId: string) {
    await this.releaseExpired(tx, current, projectId, stage, correlationId);
    const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
      "project_update.stage.suppressed", { stageId: stage.id, reason });
    const changed = await tx.$executeRawUnsafe(
      "UPDATE public.\"ProjectUpdateOutbox\" SET state='SUPPRESSED',\"leaseUntil\"=NULL,\"completedAt\"=date_trunc('milliseconds',clock_timestamp()),reason=$4,\"auditEventId\"=$5::uuid WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid AND \"claimGeneration\"=$6 AND (state='READY' OR (state='CLAIMED' AND \"leaseUntil\">clock_timestamp())) AND \"handoffAt\" IS NULL",
      current.customerId, projectId, stage.outboxId, reason, auditId, stage.claimGeneration,
    );
    if (changed !== 1) throw new ProjectUpdateError("CONFLICT");
  }

  private async insertStage(tx: Tx, current: Actor, projectId: string, engagement: EngagementRow, plan: ProjectUpdateRecipientStageSnapshot, remaining: string[], auditId: string, replacesStageId: string | null = null, mode: "SHADOW" | "CAPTURE" = "SHADOW") {
    const stageId = randomUUID();
    await tx.$executeRawUnsafe(
      "INSERT INTO public.\"ProjectUpdateStage\" (id,\"customerId\",\"projectId\",\"engagementId\",\"obligationId\",\"policyRevisionId\",\"policyRevision\",\"assessmentId\",generation,kind,ordinal,\"recipientSubject\",\"recipientRole\",\"factTypes\",\"timeZone\",\"zoneSource\",\"logicalDueAt\",\"candidateAt\",\"scheduledAt\",\"localAt\",\"utcOffset\",\"deferralReasons\",\"ruleRevision\",mode,\"replacesStageId\",\"auditEventId\") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,$9,$10,$11,$12,$13,$14::text[],$15,$16,$17::timestamptz,$18::timestamptz,$19::timestamptz,$20,$21,$22::text[],$23,$26,$24::uuid,$25::uuid)",
      stageId, current.customerId, projectId, engagement.id, engagement.obligationId,
      engagement.policyRevisionId, engagement.policyRevision, engagement.assessmentId, engagement.generation,
      plan.kind, plan.ordinal, plan.recipientSubject, plan.recipientRole, remaining,
      plan.timeZone, plan.zoneSource, plan.logicalDueAt, plan.candidateAt, plan.scheduledAt,
      plan.localAt, plan.utcOffset, plan.deferralReasons, plan.ruleRevision, replacesStageId, auditId, mode,
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO public.\"ProjectUpdateOutbox\" (id,\"customerId\",\"projectId\",\"stageId\",\"availableAt\",\"auditEventId\") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::timestamptz,$6::uuid)",
      randomUUID(), current.customerId, projectId, stageId, plan.scheduledAt, auditId,
    );
  }

  private async createEngagement(tx: Tx, current: Actor, projectId: string, correlationId: string, prepared: PreparedUpdate): Promise<ProjectUpdateEngagementView | null> {
    const obligation = prepared.view.obligation;
    if (!obligation || prepared.source.remainingFactTypes.length === 0) return null;
    if (prepared.source.sourceUnknown) throw new ProjectUpdateError("CONFLICT");
    if (!await this.recipientAuthorized(tx, current.customerId, projectId, prepared.policy.responsibleSubject, "OWNER"))
      throw new ProjectUpdateError("DENIED");
    const schedule = await this.stagePlans(tx, current.customerId, projectId, prepared.policy, obligation.dueAt);
    const existing = await tx.$queryRawUnsafe<EngagementRow[]>(
      "SELECT * FROM public.\"ProjectUpdateEngagement\" WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND \"obligationId\"=$3::uuid FOR UPDATE",
      current.customerId, projectId, obligation.id,
    );
    if (existing[0] && existing[0].state !== "ACTIVE") throw new ProjectUpdateError("CONFLICT");
    let engagement = existing[0];
    if (!engagement) {
      const configuration = this.captureConfiguration(current.customerId);
      const mode = configuration ? "CAPTURE" as const : "SHADOW" as const;
      if (configuration && !await this.captureGate(tx, current.customerId, configuration))
        throw new ProjectUpdateError("UNAVAILABLE");
      const originals = await tx.$queryRawUnsafe<{ assessmentId: string }[]>(
        "SELECT \"assessmentId\" FROM public.\"ProjectUpdateObligation\" WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid FOR UPDATE",
        current.customerId, projectId, obligation.id,
      );
      if (!originals[0]) throw new ProjectUpdateError("CONFLICT");
      const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
        "project_update.engagement.activated", {
          obligationId: obligation.id, policyRevision: prepared.policy.revision,
          mode, configurationFingerprint: hash(this.zones),
          sourceAssessmentId: prepared.assessmentId, configurationActions: schedule.configurationActions,
        });
      engagement = {
        id: randomUUID(), customerId: current.customerId, projectId, obligationId: obligation.id,
        policyRevisionId: prepared.policy.policyRevisionId, policyRevision: prepared.policy.revision,
        assessmentId: originals[0].assessmentId, ownerSubject: prepared.policy.responsibleSubject,
        generation: 1, state: "ACTIVE", sourceSatisfiedFactTypes: prepared.source.satisfiedFactTypes,
      };
      await tx.$executeRawUnsafe(
        "INSERT INTO public.\"ProjectUpdateEngagement\" (id,\"customerId\",\"projectId\",\"obligationId\",\"policyRevisionId\",\"policyRevision\",\"assessmentId\",\"ownerSubject\",\"sourceSatisfiedFactTypes\",\"sourceAssessmentId\",\"sourceAssessedAt\",\"auditEventId\") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9::text[],$10::uuid,$11,$12::uuid)",
        engagement.id, current.customerId, projectId, engagement.obligationId, engagement.policyRevisionId,
        engagement.policyRevision, engagement.assessmentId, engagement.ownerSubject,
        prepared.source.satisfiedFactTypes, prepared.assessmentId, prepared.asOf, auditId,
      );
      for (const plan of schedule.plans)
        await this.insertStage(tx, current, projectId, engagement, plan, prepared.source.remainingFactTypes, auditId, null, mode);
    }
    const counts = await tx.$queryRawUnsafe<{ count: number; mode: "SHADOW" | "CAPTURE" }[]>(
      "SELECT count(*)::int AS count,min(mode) AS mode FROM public.\"ProjectUpdateStage\" WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND \"engagementId\"=$3::uuid AND generation=$4",
      current.customerId, projectId, engagement.id, engagement.generation,
    );
    return { projectId, engagementId: engagement.id, obligationId: obligation.id,
      policyRevision: prepared.policy.revision, mode: counts[0]!.mode, stageCount: counts[0]!.count,
      remainingFactTypes: prepared.source.remainingFactTypes, configurationActions: schedule.configurationActions };
  }

  private async refreshEngagements(tx: Tx, current: Actor, projectId: string, correlationId: string, prepared: PreparedUpdate) {
    const engagements = await tx.$queryRawUnsafe<EngagementRow[]>(
      "SELECT * FROM public.\"ProjectUpdateEngagement\" WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND state IN ('ACTIVE','PAUSED') ORDER BY id FOR UPDATE",
      current.customerId, projectId,
    );
    let carryForward = false;
    for (const engagement of engagements) {
      const pending = await this.pendingStages(tx, current, projectId, engagement.id);
      if (prepared.view.obligation?.id !== engagement.obligationId) {
        const reason = prepared.policy.revision !== engagement.policyRevision ? "POLICY_CHANGED"
          : prepared.source.remainingFactTypes.length === 0 ? "REQUIRED_FACTS_SATISFIED" : "OBLIGATION_ENDED";
        for (const stage of pending) await this.suppressStage(tx, current, projectId, stage, reason, correlationId);
        const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
          "project_update.engagement.closed", { engagementId: engagement.id, reason });
        await tx.$executeRawUnsafe(
          "UPDATE public.\"ProjectUpdateEngagement\" SET state='CLOSED',\"auditEventId\"=$4::uuid,\"changedAt\"=$5,\"sourceSatisfiedFactTypes\"=CASE WHEN \"policyRevisionId\"=$6::uuid THEN $7::text[] ELSE \"sourceSatisfiedFactTypes\" END,\"sourceAssessmentId\"=CASE WHEN \"policyRevisionId\"=$6::uuid THEN $8::uuid ELSE \"sourceAssessmentId\" END,\"sourceAssessedAt\"=CASE WHEN \"policyRevisionId\"=$6::uuid THEN $9::timestamptz ELSE \"sourceAssessedAt\" END WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid",
          current.customerId, projectId, engagement.id, auditId, await this.now(tx),
          prepared.policy.policyRevisionId, prepared.source.satisfiedFactTypes, prepared.assessmentId, prepared.asOf,
        );
        carryForward = carryForward || engagement.state === "ACTIVE";
        continue;
      }
      const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
        "project_update.engagement.source_rechecked", { engagementId: engagement.id, sourceAssessmentId: prepared.assessmentId });
      await tx.$executeRawUnsafe(
        "UPDATE public.\"ProjectUpdateEngagement\" SET \"sourceSatisfiedFactTypes\"=$4::text[],\"sourceAssessmentId\"=$5::uuid,\"sourceAssessedAt\"=$6,\"auditEventId\"=$7::uuid,\"changedAt\"=$8 WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid",
        current.customerId, projectId, engagement.id, prepared.source.satisfiedFactTypes,
        prepared.assessmentId, prepared.asOf, auditId, await this.now(tx),
      );
      if (!pending.length || !this.zones || engagement.state === "PAUSED") continue;
      const schedule = await this.stagePlans(tx, current.customerId, projectId, prepared.policy, prepared.view.obligation.dueAt);
      const replacements: Array<{ stage: PendingStage; plan: ProjectUpdateRecipientStageSnapshot }> = [];
      for (const stage of pending) {
        if (!await this.recipientAuthorized(tx, current.customerId, projectId, stage.recipientSubject, stage.recipientRole)) {
          // Retain the pending action; due processing records a bounded denial
          // and retries current authorization after access is restored.
          continue;
        }
        const plan = schedule.plans.find((item) => item.kind === stage.kind && item.ordinal === stage.ordinal &&
          item.recipientSubject === stage.recipientSubject && item.recipientRole === stage.recipientRole);
        if (!plan) {
          await this.suppressStage(tx, current, projectId, stage, "POLICY_CHANGED", correlationId);
          continue;
        }
        const maskChanged = stringify([...stage.factTypes].sort()) !== stringify(prepared.source.remainingFactTypes);
        const zoneChanged = plan.timeZone !== stage.timeZone || plan.zoneSource !== stage.zoneSource;
        if (!prepared.source.remainingFactTypes.length)
          await this.suppressStage(tx, current, projectId, stage, "REQUIRED_FACTS_SATISFIED", correlationId);
        else if (maskChanged || zoneChanged) {
          await this.suppressStage(tx, current, projectId, stage,
            zoneChanged ? "RECIPIENT_ZONE_CHANGED"
              : prepared.source.remainingFactTypes.some((fact) => !stage.factTypes.includes(fact))
                ? "SOURCE_REASSESSMENT_REQUIRED" : "REQUIRED_FACTS_SATISFIED", correlationId);
          replacements.push({ stage, plan });
        }
      }
      if (replacements.length) {
        // A generation covers the whole unsent snapshot. Replace retained
        // stages too, so no pending action is stranded behind a newer generation.
        const replacedIds = new Set(replacements.map((entry) => entry.stage.id));
        for (const stage of pending) {
          if (replacedIds.has(stage.id)) continue;
          const plan = schedule.plans.find((item) => item.kind === stage.kind &&
            item.ordinal === stage.ordinal && item.recipientSubject === stage.recipientSubject &&
            item.recipientRole === stage.recipientRole);
          if (!plan) continue;
          await this.suppressStage(tx, current, projectId, stage, "SOURCE_REASSESSMENT_REQUIRED", correlationId);
          replacements.push({ stage, plan });
        }
        const revisionAudit = await this.engagementAudit(tx, current, projectId, correlationId,
          "project_update.engagement.replanned", { engagementId: engagement.id, generation: engagement.generation + 1 });
        await tx.$executeRawUnsafe(
          "UPDATE public.\"ProjectUpdateEngagement\" SET generation=generation+1,\"auditEventId\"=$4::uuid,\"changedAt\"=$5 WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid AND generation=$6",
          current.customerId, projectId, engagement.id, revisionAudit, await this.now(tx), engagement.generation,
        );
        engagement.generation += 1;
        for (const { stage, plan } of replacements)
          await this.insertStage(tx, current, projectId, engagement, plan, prepared.source.remainingFactTypes, revisionAudit, stage.id, stage.mode === "CAPTURE" ? "CAPTURE" : "SHADOW");
      }
    }
    if (carryForward && prepared.view.obligation && this.zones && !prepared.source.sourceUnknown &&
        prepared.policy.scheduledScanEnabled && prepared.policy.scheduledServiceSubject === this.serviceSubject &&
        await this.recipientAuthorized(tx, current.customerId, projectId, prepared.policy.responsibleSubject, "OWNER"))
      await this.createEngagement(tx, current, projectId, correlationId, prepared);
  }

  async activateEngagement(actorValue: Actor, projectValue: string, expectedPolicyRevision: number, correlationValue: string) {
    const current = parseActor(actorValue);
    const id = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    if (!Number.isInteger(expectedPolicyRevision) || expectedPolicyRevision < 1 || expectedPolicyRevision > 2147483647)
      throw new ProjectUpdateError("INVALID_REQUEST");
    if (!current.roles.includes("pmo_admin")) throw new ProjectUpdateError("FORBIDDEN");
    return this.transaction(async (tx) => {
      try { await authorizeFactProject(tx, current, id, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
      const policy = await this.loadPolicy(tx, current.customerId, id, true);
      if (!policy || policy.revision !== expectedPolicyRevision) throw new ProjectUpdateError("CONFLICT");
      if (!this.zones || this.zones.customerId !== current.customerId) throw new ProjectUpdateError("UNAVAILABLE");
      const prepared = await this.assessInTransaction(tx, current, id, correlationId, false);
      return this.createEngagement(tx, current, id, correlationId, prepared);
    });
  }

  private async deferStage(tx: Tx, current: Actor, projectId: string, stage: PendingStage, until: string, reason: string, correlationId: string) {
    const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
      "project_update.stage.deferred", { stageId: stage.id, reason });
    const changed = await tx.$executeRawUnsafe(
      "UPDATE public.\"ProjectUpdateOutbox\" SET state='READY',\"availableAt\"=$4::timestamptz,\"leaseUntil\"=NULL,reason=$5,\"auditEventId\"=$6::uuid WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid AND state='CLAIMED' AND \"claimGeneration\"=$7 AND \"leaseUntil\">clock_timestamp() AND \"handoffAt\" IS NULL",
      current.customerId, projectId, stage.outboxId, until, reason, auditId, stage.claimGeneration,
    );
    if (changed !== 1) throw new ProjectUpdateError("CONFLICT");
  }


  private async captureStage(tx: Tx, current: Actor, projectId: string, stage: PendingStage, prepared: PreparedUpdate, correlationId: string) {
    const configuration = this.captureConfiguration(current.customerId);
    if (!configuration || !await this.captureGate(tx, current.customerId, configuration))
      return "CAPTURE_GATE_CLOSED" as const;
    const rows = await tx.$queryRawUnsafe<{ dependencies: unknown }[]>(
      'SELECT dependencies FROM public."ProjectUpdateAssessment" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid',
      current.customerId, projectId, prepared.assessmentId,
    );
    const exactDependencies = z.array(projectUpdateFactReferenceSchema).max(1000).parse(jsonValue(rows[0]?.dependencies));
    // Every source copied to immutable prose must remain readable to the
    // named recipient, independently of the scheduling service's access.
    const recipient: Actor = { customerId: current.customerId, subject: stage.recipientSubject, roles: [] };
    const readable = await this.resolveKnownPosition(tx, recipient, projectId, exactDependencies, prepared.policy.requiredFacts);
    if (readable.length !== exactDependencies.length || prepared.view.knownPosition.length !== exactDependencies.length)
      return "SOURCE_REASSESSMENT_REQUIRED" as const;
    for (const reviewer of configuration.responseReviewerSubjects) {
      const grants = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT g.id FROM public."AccessGrant" g JOIN public."Project" p ON p."customerId"=g."customerId" AND p.id=$2::uuid WHERE g."customerId"=$1::uuid AND g.subject=$3 AND g.role=\'pmo_admin\' AND ((g."scopeType"=\'project\' AND g."scopeId"=p.id) OR (g."scopeType"=\'portfolio\' AND g."scopeId"=p."portfolioId")) ORDER BY g.id FOR SHARE OF g',
        current.customerId, projectId, reviewer,
      );
      if (!grants.length) return "CAPTURE_GATE_CLOSED" as const;
    }
    const capturedAt = await this.now(tx);
    const requiredFacts = policyFacts(prepared.policy.requiredFacts)
      .filter((fact) => stage.factTypes.includes(fact.factType));
    const rendered = renderProjectUpdateCapture({
      project: { id: projectId, code: prepared.view.project.code, name: prepared.view.project.name },
      kind: stage.kind, policyRevision: prepared.policy.revision, dueAt: stage.logicalDueAt,
      capturedAt: iso(capturedAt), requiredFacts,
      knownPosition: prepared.view.knownPosition, dependencies: exactDependencies,
      responseReviewerSubjects: configuration.responseReviewerSubjects,
    });
    const requestId = randomUUID();
    const invitationId = randomUUID();
    const locator = randomUUID();
    const expiresAt = new Date(capturedAt.getTime() + configuration.invitationLifetimeSeconds * 1000);
    const purgeAfter = new Date(capturedAt.getTime() + configuration.contentRetentionSeconds * 1000);
    const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
      "project_update.stage.captured", { stageId: stage.id, requestId, mode: "CAPTURE" });
    const contentDigest = createHash("sha256").update(rendered.text, "utf8").digest("hex");
    await tx.$executeRawUnsafe(
      'INSERT INTO public."ProjectUpdateCapturedRequest" (id,"customerId","projectId","stageId","sourceAssessmentId","issuanceEpoch","recipientSubject","reviewerSubjects","requiredFacts",dependencies,"rendererRevision","contentDigest","capturedAt","invitationLifetimeSeconds","contentRetentionSeconds","purgeAfter","auditEventId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::text[],$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::uuid)',
      requestId, current.customerId, projectId, stage.id, prepared.assessmentId, configuration.issuanceEpoch,
      stage.recipientSubject, configuration.responseReviewerSubjects, stringify(requiredFacts),
      stringify(rendered.dependencies), rendered.rendererRevision, contentDigest, capturedAt,
      configuration.invitationLifetimeSeconds, configuration.contentRetentionSeconds, purgeAfter, auditId,
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO public."ProjectUpdateRequestContent" ("requestId","customerId","projectId",body) VALUES ($1::uuid,$2::uuid,$3::uuid,$4)',
      requestId, current.customerId, projectId, rendered.text,
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO public."ProjectUpdateInvitation" (id,locator,"customerId","projectId","requestId","recipientSubject","issuanceEpoch","issuedAt","expiresAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9)',
      invitationId, locator, current.customerId, projectId, requestId, stage.recipientSubject,
      configuration.issuanceEpoch, capturedAt, expiresAt,
    );
    const changed = await tx.$executeRawUnsafe(
      'UPDATE public."ProjectUpdateOutbox" SET state=\'CAPTURED\',"leaseUntil"=NULL,"completedAt"=date_trunc(\'milliseconds\',clock_timestamp()),reason=NULL,"auditEventId"=$4::uuid WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid AND state=\'CLAIMED\' AND "claimGeneration"=$5 AND "leaseUntil">clock_timestamp() AND "handoffAt" IS NULL',
      current.customerId, projectId, stage.outboxId, auditId, stage.claimGeneration,
    );
    if (changed !== 1) throw new ProjectUpdateError("CONFLICT");
    return "CAPTURED" as const;
  }

  async processEngagements(limit: number) { return this.processEngagementBatch(limit, true); }
  async processShadowEngagements(limit: number) { return this.processEngagementBatch(limit, false); }

  private async processEngagementBatch(limit: number, allowCapture: boolean) {
    if (limit !== 1) throw new ProjectUpdateError("INVALID_REQUEST");
    if (!this.zones || !this.serviceSubject) return 0;
    const customerId = this.zones.customerId;
    const current: Actor = { customerId, subject: this.serviceSubject, roles: [] };
    const projectId = await this.transaction(async (tx) => {
      // Pick and lock the project first. Other workers skip this project and
      // source/configuration writers use the same project-first lock order.
      const projects = await tx.$queryRawUnsafe<{ projectId: string }[]>(
        "SELECT p.id AS \"projectId\" FROM public.\"Project\" p JOIN public.\"ProjectUpdatePolicy\" h ON h.\"customerId\"=p.\"customerId\" AND h.\"projectId\"=p.id JOIN public.\"ProjectUpdatePolicyRevision\" r ON r.\"customerId\"=h.\"customerId\" AND r.\"projectId\"=h.\"projectId\" AND r.revision=h.revision WHERE p.\"customerId\"=$1::uuid AND (h.\"engagementProcessNextEligibleAt\" IS NULL OR h.\"engagementProcessNextEligibleAt\"<=clock_timestamp()) AND r.\"scheduledScanEnabled\" AND r.\"scheduledServiceSubject\"=$2 AND EXISTS (SELECT 1 FROM public.\"ProjectUpdateEngagement\" e JOIN public.\"ProjectUpdateStage\" s ON s.\"customerId\"=e.\"customerId\" AND s.\"projectId\"=e.\"projectId\" AND s.\"engagementId\"=e.id JOIN public.\"ProjectUpdateOutbox\" o ON o.\"customerId\"=s.\"customerId\" AND o.\"projectId\"=s.\"projectId\" AND o.\"stageId\"=s.id WHERE e.\"customerId\"=p.\"customerId\" AND e.\"projectId\"=p.id AND e.state IN ('ACTIVE','PAUSED') AND s.mode=ANY($3::text[]) AND ((o.state='READY' AND o.\"availableAt\"<=clock_timestamp()) OR (o.state='CLAIMED' AND o.\"leaseUntil\"<=clock_timestamp()))) ORDER BY h.\"engagementProcessLastAttemptAt\" ASC NULLS FIRST,p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED",
        customerId, this.serviceSubject, allowCapture ? ["SHADOW", "CAPTURE"] : ["SHADOW"],
      );
      if (!projects[0]) return null;
      const selected = projects[0].projectId;
      await tx.$executeRawUnsafe(
        "UPDATE public.\"ProjectUpdatePolicy\" SET \"engagementProcessLastAttemptAt\"=date_trunc('milliseconds',clock_timestamp()),\"engagementProcessNextEligibleAt\"=clock_timestamp()+interval '1 minute' WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid", customerId, selected,
      );
      return selected;
    });
    if (!projectId) return 0;
    try {
      return await this.transaction(async (tx) => {
      const correlationId = randomUUID();
      const prepared = await this.assessInTransaction(tx, current, projectId, correlationId, true);
      const engagements = await tx.$queryRawUnsafe<EngagementRow[]>(
        "SELECT * FROM public.\"ProjectUpdateEngagement\" WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND state IN ('ACTIVE','PAUSED') ORDER BY id FOR UPDATE", customerId, projectId,
      );
      let processed = 0;
      for (const engagement of engagements) {
        for (const stage of await this.pendingStages(tx, current, projectId, engagement.id)) {
          if (processed >= 100) return processed;
          if ((stage.mode !== "SHADOW" && (!allowCapture || stage.mode !== "CAPTURE")) || stage.availableAt > await this.now(tx)) continue;
          await this.releaseExpired(tx, current, projectId, stage, correlationId);
          if (stage.outboxState !== "READY") continue;
          const claimAudit = await this.engagementAudit(tx, current, projectId, correlationId,
            "project_update.stage.claimed", { stageId: stage.id, mode: stage.mode });
          const claimed = await tx.$executeRawUnsafe(
            "UPDATE public.\"ProjectUpdateOutbox\" SET state='CLAIMED',\"claimGeneration\"=\"claimGeneration\"+1,\"leaseUntil\"=clock_timestamp()+interval '2 minutes',reason=NULL,\"auditEventId\"=$4::uuid WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid AND id=$3::uuid AND state='READY' AND \"claimGeneration\"=$5 AND \"availableAt\"<=clock_timestamp() AND \"handoffAt\" IS NULL",
            customerId, projectId, stage.outboxId, claimAudit, stage.claimGeneration,
          );
          if (claimed !== 1) throw new ProjectUpdateError("CONFLICT");
          stage.outboxState = "CLAIMED";
          stage.claimGeneration += 1;
          stage.leaseUntil = new Date((await this.now(tx)).getTime() + 120000);
          const authorized = await this.recipientAuthorized(tx, customerId, projectId, stage.recipientSubject, stage.recipientRole) &&
            await this.recipientAuthorized(tx, customerId, projectId, engagement.ownerSubject, "OWNER");
          const reason = !authorized ? "RECIPIENT_REVOKED"
            : prepared.source.sourceUnknown ? "SOURCE_UNKNOWN"
            : engagement.state === "PAUSED" ? "ENGAGEMENT_PAUSED" : null;
          if (reason) {
            await this.deferStage(tx, current, projectId, stage,
              iso(new Date((await this.now(tx)).getTime() + 300000)), reason, correlationId);
          } else {
            const calendarAsOf = iso(await this.now(tx));
            const check = planProjectUpdateRecipientStage({
              kind: "REQUEST", ordinal: 0, recipientRole: "OWNER", recipientSubject: stage.recipientSubject,
              logicalDueAt: calendarAsOf, anchorAt: calendarAsOf, recipientTimeZone: stage.timeZone,
              projectTimeZone: prepared.policy.timeZone, customerTimeZone: this.zones!.customerTimeZone,
              quietHoursStartLocal: prepared.policy.quietHoursStartLocal, quietHoursEndLocal: prepared.policy.quietHoursEndLocal,
            });
            if (Date.parse(check.scheduledAt) > Date.parse(check.candidateAt))
              await this.deferStage(tx, current, projectId, stage, check.scheduledAt, check.deferralReasons[0]!, correlationId);
            else if (stage.mode === "SHADOW" || this.captureReader?.().globalShadowMode !== "false")
              await this.suppressStage(tx, current, projectId, stage, "SHADOW_MODE", correlationId);
            else {
              const outcome = await this.captureStage(tx, current, projectId, stage, prepared, correlationId);
              if (outcome !== "CAPTURED")
                await this.deferStage(tx, current, projectId, stage,
                  iso(new Date((await this.now(tx)).getTime() + 300000)), outcome, correlationId);
            }
          }
          processed += 1;
        }
      }
      return processed;
      });
    } catch (error) {
      // This timer survives rollback of source/stage work. A poisoned project
      // cannot monopolize later invocations or discard any pending intent.
      await this.transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT id FROM public.\"Project\" WHERE \"customerId\"=$1::uuid AND id=$2::uuid FOR UPDATE", customerId, projectId,
        );
        await tx.$executeRawUnsafe(
          "UPDATE public.\"ProjectUpdatePolicy\" SET \"engagementProcessNextEligibleAt\"=clock_timestamp()+interval '5 minutes' WHERE \"customerId\"=$1::uuid AND \"projectId\"=$2::uuid", customerId, projectId,
        );
      });
      throw error;
    }
  }



  private captureConfiguration(customerId: string): ProjectUpdateCaptureConfiguration | null {
    const boundary = this.captureReader?.();
    if (!boundary || boundary.globalShadowMode !== "false") return null;
    const parsed = projectUpdateCaptureConfigurationSchema.safeParse(boundary.configuration);
    return parsed.success && parsed.data.customerId === customerId ? parsed.data : null;
  }

  private async captureGate(tx: Tx, customerId: string, configuration: ProjectUpdateCaptureConfiguration) {
    const rows = await tx.$queryRawUnsafe<{
      issuance_enabled: boolean; issuance_epoch: string; gate_revision: number; not_quarantined: boolean;
    }[]>("SELECT * FROM public.lock_update_issuance_gate($1::uuid)", customerId);
    return rows[0]?.issuance_enabled === true && rows[0].not_quarantined === true &&
      rows[0].issuance_epoch === configuration.issuanceEpoch;
  }

  private async actorRecipientAuthorized(tx: Tx, current: Actor, projectId: string, role: "OWNER" | "PROJECT_MANAGER") {
    if (!await this.recipientAuthorized(tx, current.customerId, projectId, current.subject, role)) return false;
    const grants = await tx.$queryRawUnsafe<{ role: string }[]>(
      'SELECT g.role FROM public."AccessGrant" g JOIN public."Project" p ON p."customerId"=g."customerId" AND p.id=$2::uuid WHERE g."customerId"=$1::uuid AND g.subject=$3 AND ((g."scopeType"=\'project\' AND g."scopeId"=p.id) OR (g."scopeType"=\'portfolio\' AND g."scopeId"=p."portfolioId")) ORDER BY g.id FOR SHARE OF g',
      current.customerId, projectId, current.subject,
    );
    const allowed = role === "PROJECT_MANAGER" ? ["project_manager"]
      : ["project_manager", "portfolio_manager", "pmo_admin", "team_lead", "contributor"];
    return grants.some((grant) => allowed.includes(grant.role) &&
      current.roles.some((actorRole) => actorRole === grant.role));
  }

  private async responseHistory(tx: Tx, current: Actor, projectId: string, requestId: string) {
    const rows = await tx.$queryRawUnsafe<{
      id: string; submittedBy: string; receivedAt: Date; correctsResponseId: string | null;
      body: string | null; contentState: "PRESENT" | "EXPIRED";
    }[]>(
      'SELECT r.id,r."submittedBy",r."receivedAt",r."correctsResponseId",CASE WHEN c.state=\'PRESENT\' AND r."purgeAfter">clock_timestamp() THEN c.body ELSE NULL END AS body,CASE WHEN c.state=\'PRESENT\' AND r."purgeAfter">clock_timestamp() THEN \'PRESENT\' ELSE \'EXPIRED\' END AS "contentState" FROM public."ProjectUpdateResponse" r JOIN public."ProjectUpdateResponseContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."responseId"=r.id WHERE r."customerId"=$1::uuid AND r."projectId"=$2::uuid AND r."requestId"=$3::uuid ORDER BY r."receivedAt" DESC,r.id DESC LIMIT 20',
      current.customerId, projectId, requestId,
    );
    return rows.map((row) => ({ id: row.id, submittedBy: row.submittedBy,
      receivedAt: iso(row.receivedAt), correctsResponseId: row.correctsResponseId,
      state: "UNCONFIRMED" as const, contentState: row.contentState, text: row.body }));
  }

  private async authorizedInvitation(tx: Tx, current: Actor, locatorValue: string) {
    const locator = projectUpdateInvitationLocatorSchema.safeParse(locatorValue);
    const configuration = this.captureConfiguration(current.customerId);
    if (!locator.success || !configuration) throw new ProjectUpdateError("DENIED");
    // Resolve only a scoped identifier; no project or message content is returned
    // before current project-first authorization and gate locking.
    const identities = await tx.$queryRawUnsafe<{ projectId: string }[]>(
      'SELECT "projectId" FROM public."ProjectUpdateInvitation" WHERE "customerId"=$1::uuid AND locator=$2::uuid',
      current.customerId, locator.data,
    );
    const projectId = identities[0]?.projectId;
    if (!projectId) throw new ProjectUpdateError("DENIED");
    const projects = await tx.$queryRawUnsafe<{ id: string }[]>(
      'SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR UPDATE',
      current.customerId, projectId,
    );
    if (!projects[0] || !await this.captureGate(tx, current.customerId, configuration))
      throw new ProjectUpdateError("DENIED");
    const rows = await tx.$queryRawUnsafe<CaptureInvitationRow[]>(
      'SELECT i.id AS "invitationId",i."requestId",i."recipientSubject",i."issuanceEpoch",i."issuedAt",i."expiresAt",r."capturedAt",r."purgeAfter",r."contentRetentionSeconds",r."reviewerSubjects",r."requiredFacts",r.dependencies,c.body,c.state AS "contentState",s.id AS "stageId",s.kind AS "stageKind",s."recipientRole",s."logicalDueAt",s.generation AS "stageGeneration",s."policyRevision",e."ownerSubject",e.state AS "engagementState",e.generation AS "engagementGeneration",o.state AS "obligationState",h.revision AS "currentPolicyRevision",b.state AS "outboxState",p.code,p.name FROM public."ProjectUpdateInvitation" i JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=i."customerId" AND r."projectId"=i."projectId" AND r.id=i."requestId" JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."requestId"=r.id JOIN public."ProjectUpdateStage" s ON s."customerId"=r."customerId" AND s."projectId"=r."projectId" AND s.id=r."stageId" JOIN public."ProjectUpdateEngagement" e ON e."customerId"=s."customerId" AND e."projectId"=s."projectId" AND e.id=s."engagementId" JOIN public."ProjectUpdateObligation" o ON o."customerId"=e."customerId" AND o."projectId"=e."projectId" AND o.id=e."obligationId" JOIN public."ProjectUpdatePolicy" h ON h."customerId"=e."customerId" AND h."projectId"=e."projectId" JOIN public."ProjectUpdateOutbox" b ON b."customerId"=s."customerId" AND b."projectId"=s."projectId" AND b."stageId"=s.id JOIN public."Project" p ON p."customerId"=s."customerId" AND p.id=s."projectId" WHERE i."customerId"=$1::uuid AND i."projectId"=$2::uuid AND i.locator=$3::uuid',
      current.customerId, projectId, locator.data,
    );
    const row = rows[0];
    if (!row || row.recipientSubject !== current.subject) throw new ProjectUpdateError("DENIED");
    const policy = await this.loadPolicy(tx, current.customerId, projectId, true);
    if (!policy) throw new ProjectUpdateError("DENIED");
    const recipientAuthorized = await this.actorRecipientAuthorized(tx, current, projectId, row.recipientRole);
    const ownerAuthorized = await this.recipientAuthorized(tx, current.customerId, projectId, row.ownerSubject, "OWNER");
    const dependencies = z.array(projectUpdateFactReferenceSchema).max(1000).parse(jsonValue(row.dependencies));
    const readable = await this.resolveKnownPosition(tx, current, projectId, dependencies, policy.requiredFacts);
    const asOf = await this.now(tx);
    if (!mayAccessProjectUpdateInvitation({
      authenticatedSubject: current.subject, namedRecipientSubject: row.recipientSubject,
      sameCustomer: true, currentRecipientRoleAndGrant: recipientAuthorized,
      actorRoleMatchesGrant: recipientAuthorized, currentOwnerRoleAndGrant: ownerAuthorized,
      obligationOpen: row.obligationState === "OPEN", engagementActive: row.engagementState === "ACTIVE",
      policyCurrent: row.policyRevision === row.currentPolicyRevision,
      generationCurrent: row.stageGeneration === row.engagementGeneration,
      captureCommitted: row.outboxState === "CAPTURED", globalShadowOff: true,
      captureConfigured: true, issuanceEpochCurrent: row.issuanceEpoch === configuration.issuanceEpoch,
      restoreGateOpen: true, recipientReadsEveryDependency: readable.length === dependencies.length,
      viewerReadsEveryDependency: readable.length === dependencies.length,
      contentAvailable: row.contentState === "PRESENT" && row.body !== null,
      issuedAt: iso(row.issuedAt), expiresAt: iso(row.expiresAt),
      contentExpiresAt: iso(row.purgeAfter), asOf: iso(asOf),
    })) throw new ProjectUpdateError("DENIED");
    return { row, projectId, asOf, configuration };
  }

  async invitation(actorValue: Actor, locatorValue: string): Promise<ProjectUpdateRecipientRequestView> {
    const current = parseActor(actorValue);
    return this.transaction(async (tx) => {
      const { row, projectId } = await this.authorizedInvitation(tx, current, locatorValue);
      const reviewers = row.reviewerSubjects.filter((subject) =>
        this.captureConfiguration(current.customerId)?.responseReviewerSubjects.includes(subject));
      // Readership is an explicit frozen contract; retain names of frozen
      // currently configured reviewers. Each actual reviewer read also checks
      // current PMO identity, scoped administrative grant and source access.
      return projectUpdateRecipientRequestViewSchema.parse({
        requestId: row.requestId, project: { id: projectId, code: row.code, name: row.name },
        stageKind: row.stageKind, dueAt: iso(row.logicalDueAt), capturedAt: iso(row.capturedAt),
        expiresAt: iso(row.expiresAt), body: row.body,
        requiredFacts: policyFacts(row.requiredFacts),
        rawResponseReaders: [...new Set([row.recipientSubject, ...reviewers])],
        responses: await this.responseHistory(tx, current, projectId, row.requestId),
      });
    });
  }

  async submitResponse(actorValue: Actor, locatorValue: string, submissionValue: unknown, correlationValue: string): Promise<ProjectUpdateResponseReceipt> {
    const current = parseActor(actorValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      // Validate text only after the same non-disclosing invitation authorization.
      const { row, projectId, asOf } = await this.authorizedInvitation(tx, current, locatorValue);
      const parsed = projectUpdateResponseSubmissionSchema.safeParse(submissionValue);
      if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
      const submission = parsed.data;
      const payloadDigest = hash(submission);
      const existing = await tx.$queryRawUnsafe<{ id: string; payloadDigest: string; receivedAt: Date }[]>(
        'SELECT id,"payloadDigest","receivedAt" FROM public."ProjectUpdateResponse" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "invitationId"=$3::uuid AND "submittedBy"=$4 AND "idempotencyKey"=$5',
        current.customerId, projectId, row.invitationId, current.subject, submission.idempotencyKey,
      );
      const previous = existing[0];
      if (previous && previous.payloadDigest !== payloadDigest) throw new ProjectUpdateError("CONFLICT");
      if (previous) return { responseId: previous.id, requestId: row.requestId,
        receivedAt: iso(previous.receivedAt), state: "UNCONFIRMED",
        message: "Response recorded; required facts remain unconfirmed." };
      if (submission.correctsResponseId) {
        const correction = await tx.$queryRawUnsafe<{ id: string }[]>(
          'SELECT id FROM public."ProjectUpdateResponse" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "requestId"=$3::uuid AND id=$4::uuid AND "submittedBy"=$5',
          current.customerId, projectId, row.requestId, submission.correctsResponseId, current.subject,
        );
        if (!correction[0]) throw new ProjectUpdateError("INVALID_REQUEST");
      }
      const responseId = randomUUID();
      const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
        "project_update.response.recorded", { requestId: row.requestId, responseId, state: "UNCONFIRMED" });
      const contentDigest = createHash("sha256").update(submission.text, "utf8").digest("hex");
      const purgeAfter = new Date(asOf.getTime() + row.contentRetentionSeconds * 1000);
      await tx.$executeRawUnsafe(
        'INSERT INTO public."ProjectUpdateResponse" (id,"customerId","projectId","requestId","invitationId","submittedBy","receivedAt","idempotencyKey","payloadDigest","contentDigest","correctsResponseId","contentRetentionSeconds","purgeAfter","auditEventId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11::uuid,$12,$13,$14::uuid)',
        responseId, current.customerId, projectId, row.requestId, row.invitationId, current.subject,
        asOf, submission.idempotencyKey, payloadDigest, contentDigest, submission.correctsResponseId,
        row.contentRetentionSeconds, purgeAfter, auditId,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."ProjectUpdateResponseContent" ("responseId","customerId","projectId",body) VALUES ($1::uuid,$2::uuid,$3::uuid,$4)',
        responseId, current.customerId, projectId, submission.text,
      );
      return { responseId, requestId: row.requestId, receivedAt: iso(asOf),
        state: "UNCONFIRMED", message: "Response recorded; required facts remain unconfirmed." };
    });
  }


  async captureHistory(actorValue: Actor, projectValue: string, cursorValue?: string | null): Promise<ProjectUpdateCaptureHistory> {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    if (cursorValue && !projectUpdateInvitationLocatorSchema.safeParse(cursorValue).success)
      throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      const projects = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR UPDATE',
        current.customerId, projectId,
      );
      if (!projects[0]) throw new ProjectUpdateError("DENIED");
      let administrator = false;
      if (current.roles.includes("pmo_admin")) {
        try { await authorizeFactProject(tx, current, projectId, "access"); administrator = true; }
        catch { /* A named recipient may still read only their own requests. */ }
      }
      if (!administrator && !await this.actorRecipientAuthorized(tx, current, projectId, "OWNER") &&
          !await this.actorRecipientAuthorized(tx, current, projectId, "PROJECT_MANAGER"))
        throw new ProjectUpdateError("DENIED");
      const rows = await tx.$queryRawUnsafe<{
        requestId: string; stageId: string; stageKind: "REQUEST" | "REMINDER" | "ESCALATION";
        recipientSubject: string; recipientRole: "OWNER" | "PROJECT_MANAGER"; capturedAt: Date;
        expiresAt: Date; purgeAfter: Date; issuanceEpoch: string; reviewerSubjects: string[];
        body: string | null; contentState: string; dependencies: unknown; requiredFacts: unknown;
        locator: string; engagementState: string; obligationState: string;
        stageGeneration: number; engagementGeneration: number; policyRevision: number; currentPolicyRevision: number;
      }[]>(
        'SELECT r.id AS "requestId",s.id AS "stageId",s.kind AS "stageKind",r."recipientSubject",s."recipientRole",r."capturedAt",i."expiresAt",r."purgeAfter",r."issuanceEpoch",r."reviewerSubjects",c.body,c.state AS "contentState",r.dependencies,p."requiredFacts",i.locator,e.state AS "engagementState",o.state AS "obligationState",s.generation AS "stageGeneration",e.generation AS "engagementGeneration",s."policyRevision",h.revision AS "currentPolicyRevision" FROM public."ProjectUpdateCapturedRequest" r JOIN public."ProjectUpdateStage" s ON s."customerId"=r."customerId" AND s."projectId"=r."projectId" AND s.id=r."stageId" JOIN public."ProjectUpdateEngagement" e ON e."customerId"=s."customerId" AND e."projectId"=s."projectId" AND e.id=s."engagementId" JOIN public."ProjectUpdateObligation" o ON o."customerId"=e."customerId" AND o."projectId"=e."projectId" AND o.id=e."obligationId" JOIN public."ProjectUpdatePolicyRevision" p ON p."customerId"=s."customerId" AND p."projectId"=s."projectId" AND p.id=s."policyRevisionId" JOIN public."ProjectUpdatePolicy" h ON h."customerId"=s."customerId" AND h."projectId"=s."projectId" JOIN public."ProjectUpdateInvitation" i ON i."customerId"=r."customerId" AND i."projectId"=r."projectId" AND i."requestId"=r.id JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."requestId"=r.id WHERE r."customerId"=$1::uuid AND r."projectId"=$2::uuid AND ($3 OR r."recipientSubject"=$4) AND ($5::uuid IS NULL OR (r."capturedAt",r.id)<(SELECT before."capturedAt",before.id FROM public."ProjectUpdateCapturedRequest" before WHERE before."customerId"=$1::uuid AND before."projectId"=$2::uuid AND before.id=$5::uuid AND ($3 OR before."recipientSubject"=$4))) ORDER BY r."capturedAt" DESC,r.id DESC LIMIT 21',
        current.customerId, projectId, administrator, current.subject, cursorValue ?? null,
      );
      const configuration = this.captureConfiguration(current.customerId);
      const gateOpen = configuration ? await this.captureGate(tx, current.customerId, configuration) : false;
      const asOf = await this.now(tx);
      const entries: ProjectUpdateCaptureHistory["entries"] = [];
      for (const row of rows.slice(0, 20)) {
        const retained = row.contentState === "PRESENT" && row.purgeAfter > asOf && row.body !== null;
        const namedRecipient = row.recipientSubject === current.subject &&
          await this.actorRecipientAuthorized(tx, current, projectId, row.recipientRole);
        const frozenReviewer = administrator && row.reviewerSubjects.includes(current.subject) &&
          configuration?.responseReviewerSubjects.includes(current.subject) === true;
        let disclose = retained && gateOpen && (namedRecipient || frozenReviewer) &&
          await this.recipientAuthorized(tx, current.customerId, projectId, row.recipientSubject, row.recipientRole);
        if (disclose) {
          const dependencies = z.array(projectUpdateFactReferenceSchema).max(1000).parse(jsonValue(row.dependencies));
          const recipient: Actor = { customerId: current.customerId, subject: row.recipientSubject, roles: [] };
          const viewerValues = await this.resolveKnownPosition(tx, current, projectId, dependencies, row.requiredFacts);
          const recipientValues = await this.resolveKnownPosition(tx, recipient, projectId, dependencies, row.requiredFacts);
          disclose = viewerValues.length === dependencies.length && recipientValues.length === dependencies.length;
        }
        const currentCycle = row.engagementState === "ACTIVE" && row.obligationState === "OPEN" &&
          row.stageGeneration === row.engagementGeneration && row.policyRevision === row.currentPolicyRevision;
        const status = !gateOpen || row.issuanceEpoch !== configuration?.issuanceEpoch ? "QUARANTINED" as const
          : row.expiresAt <= asOf ? "EXPIRED" as const : !currentCycle ? "ENDED" as const : "ACTIVE" as const;
        entries.push({
          requestId: row.requestId, stageId: row.stageId, stageKind: row.stageKind,
          recipientSubject: row.recipientSubject, capturedAt: iso(row.capturedAt), expiresAt: iso(row.expiresAt),
          status, contentState: !retained ? "EXPIRED" : disclose ? "PRESENT" : "RESTRICTED",
          body: disclose ? row.body : null,
          recipientPath: disclose && namedRecipient && status === "ACTIVE" ? "/update-requests/" + row.locator : null,
          responses: disclose ? await this.responseHistory(tx, current, projectId, row.requestId) : [],
        });
      }
      return { projectId, entries, nextCursor: rows.length > 20 ? rows[19]!.requestId : null };
    });
  }

  async purgeCaptureContent() {
    if (!this.zones || !this.serviceSubject) return 0;
    return this.transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ count: number }[]>(
        "SELECT public.purge_update_capture_content($1::uuid) AS count", this.zones!.customerId,
      );
      return rows[0]?.count ?? 0;
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
        reminderBusinessDayOffsets: row.reminderBusinessDayOffsets,
        escalationAfterBusinessDays: row.escalationAfterBusinessDays,
        escalationRecipientSubject: row.escalationRecipientSubject,
        quietHoursStartLocal: row.quietHoursStartLocal,
        quietHoursEndLocal: row.quietHoursEndLocal,
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

  private async latestAssessmentRow(
    tx: Tx,
    current: Actor,
    id: string,
    policyRevisionId?: string,
  ) {
    const query = [
      'SELECT a.id,a."customerId",a."projectId",a."policyRevisionId",a."policyRevision",a."assessedAt",a.input,a.result,a.dependencies,a."envelopeHash",a."auditEventId",p.code,p.name,p."reportedStatus",c."createdAt",r."responsibleSubject",r."freshnessWindowSeconds",r."timeZone",r."reminderBusinessDayOffsets",r."escalationAfterBusinessDays",r."escalationRecipientSubject",r."quietHoursStartLocal",r."quietHoursEndLocal",r."requiredFacts",r."scheduledScanEnabled",r."changedBy",r."changedAt",o.id AS "obligationId",o.state AS "obligationState",o."freshnessThresholdAt" AS "dueAt",v.id AS "previewId",v.revision AS "previewRevision",v.preview',
      'FROM public."ProjectUpdateAssessment" a JOIN public."ProjectUpdatePolicyRevision" r ON r."customerId"=a."customerId" AND r."projectId"=a."projectId" AND r.id=a."policyRevisionId" JOIN public."Project" p ON p."customerId"=a."customerId" AND p.id=a."projectId" JOIN public."CanonicalProject" c ON c."customerId"=p."customerId" AND c.id=p.id LEFT JOIN public."ProjectUpdateObligation" o ON o."customerId"=a."customerId" AND o."projectId"=a."projectId" AND o.state=\'OPEN\' LEFT JOIN public."ProjectUpdatePreview" v ON v."customerId"=o."customerId" AND v."projectId"=o."projectId" AND v."obligationId"=o.id AND v."assessmentId"=a.id AND v.state=\'CURRENT\'',
      'WHERE a."customerId"=$1::uuid AND a."projectId"=$2::uuid',
      ...(policyRevisionId ? ['AND a."policyRevisionId"=$3::uuid'] : []),
      'ORDER BY a."assessedAt" DESC,a.id DESC LIMIT 1 FOR SHARE OF p,c',
    ].join(" ");
    const rows = await tx.$queryRawUnsafe<AssessmentRow[]>(
      query,
      current.customerId,
      id,
      ...(policyRevisionId ? [policyRevisionId] : []),
    );
    return rows[0] ?? null;
  }

  async latest(actorValue: Actor, projectValue: string) {
    const current = parseActor(actorValue);
    const id = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, current, id, false);
      const row = await this.latestAssessmentRow(tx, current, id);
      return row ? this.assessmentView(tx, current, row, true) : null;
    });
  }

  async schedulePreview(actorValue: Actor, projectValue: string): Promise<ProjectUpdateSchedulePreview> {
    const current = parseActor(actorValue);
    const id = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, current, id, false);
      const policy = await this.loadPolicy(tx, current.customerId, id, true);
      if (!policy) throw new ProjectUpdateError("CONFLICT");
      try {
        await this.validateEscalationRecipient(
          tx, current.customerId, id, policy.escalationRecipientSubject,
        );
      } catch (error) {
        if (error instanceof ProjectUpdateError && error.code === "INVALID_REQUEST")
          throw new ProjectUpdateError("CONFLICT");
        throw error;
      }
      const row = await this.latestAssessmentRow(
        tx, current, id, policy.policyRevisionId,
      );
      if (!row || row.policyRevision !== policy.revision)
        throw new ProjectUpdateError("CONFLICT");
      const assessment = await this.assessmentView(tx, current, row, true);
      let dependencies: ProjectUpdateFactReference[];
      try {
        dependencies = z.array(projectUpdateFactReferenceSchema)
          .max(1000)
          .parse(jsonValue(row.dependencies));
      } catch { throw new ProjectUpdateError("UNAVAILABLE"); }
      if (assessment.knownPosition.length !== dependencies.length)
        throw new ProjectUpdateError("DENIED");
      const durable = row.obligationId ? await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM public."ProjectUpdateEngagement" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "obligationId"=$3::uuid AND "policyRevisionId"=$4::uuid AND state IN (\'ACTIVE\',\'PAUSED\')',
        current.customerId, id, row.obligationId, row.policyRevisionId,
      ) : [];
      if ((assessment.freshness.state !== "STALE" && durable.length === 0) ||
          assessment.obligation?.state !== "OPEN")
        throw new ProjectUpdateError("CONFLICT");

      let input: Record<string, unknown>;
      try { input = safeObject.parse(jsonValue(row.input)); }
      catch { throw new ProjectUpdateError("CONFLICT"); }
      const sourceDate = datesFromJson(input.sourceDate);
      const dueAt = datesFromJson(input.freshnessThresholdAt);
      const sourceTimeBasis = input.sourceDateField === "project.createdAt"
        ? "PROJECT_CREATED_AT"
        : input.timestampBasis === "REQUIRED_FACTS" ? "REQUIRED_FACTS" : "UNCONFIRMED";
      const savedSourceTimeBasis = input.sourceTimeBasis ?? sourceTimeBasis;
      if (!sourceDate || !dueAt || !row.dueAt ||
          input.policyRevision !== policy.revision ||
          input.assessedAt !== iso(row.assessedAt) ||
          input.sourceDate !== iso(sourceDate) ||
          input.sourceDateField !== assessment.freshness.sourceDateField ||
          iso(sourceDate) !== assessment.freshness.sourceDate ||
          input.freshnessThresholdAt !== iso(dueAt) ||
          dueAt.getTime() !== sourceDate.getTime() + policy.freshnessWindowSeconds * 1000 ||
          (durable.length === 0 && dueAt.getTime() !== row.dueAt.getTime()) ||
          assessment.freshness.freshnessWindowSeconds !== policy.freshnessWindowSeconds ||
          savedSourceTimeBasis !== sourceTimeBasis ||
          row.assessedAt.getTime() <= row.dueAt.getTime())
        throw new ProjectUpdateError("CONFLICT");

      return previewProjectUpdateSchedule({
        assessmentId: row.id,
        assessmentPolicyRevision: row.policyRevision,
        policyRevision: policy.revision,
        asOf: iso(row.assessedAt),
        sourceDate: iso(sourceDate),
        sourceDateField: input.sourceDateField,
        sourceTimeBasis,
        logicalDueAt: iso(durable.length > 0 ? row.dueAt! : dueAt),
        timeZone: policy.timeZone,
        responsibleSubject: policy.responsibleSubject,
        cadence: policyCadence(policy),
      });
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
