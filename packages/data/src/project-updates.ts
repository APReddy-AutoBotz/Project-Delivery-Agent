import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  deriveProjectUpdateSourceSatisfaction,
  buildUpdateAdviceSnapshot,
  updateAdviceSnapshotSchema,
  projectUpdateCaptureConfigurationSchema, projectUpdateInvitationLocatorSchema,
  projectUpdateCaptureGenerationSchema,
  projectUpdateResponseSubmissionSchema, projectUpdateRecipientRequestViewSchema,
  projectUpdateClarificationQuestion, projectUpdateForecastClarificationQuestion,
  projectUpdateClarificationRequestSchema, projectUpdateClarificationReceiptSchema,
  projectUpdateFactConfirmationSchema, projectUpdateFactConfirmationReceiptSchema, type CapturedUpdateFactType,
  extractExplicitCapturedFacts,
  projectUpdateStatusConfirmationSchema, projectUpdateStatusConfirmationReceiptSchema,
  capturedReplyInterpretationRequestSchema, capturedReplyInterpretationSchema, readGroundedReplySuggestions,
  capturedReplyInterpreterMetadataSchema, type CapturedReplyInterpreter, type CapturedReplyInterpretation,
  projectUpdateEscalationContextSchema, type ProjectUpdateEscalationContext,
  mayAccessProjectUpdateInvitation, isActiveProjectUpdateCapture, renderProjectUpdateCapture,
  atlasApprovalDecisionSchema, atlasApprovalProjectCode, atlasApprovalViewSchema, atlasComment,
  atlasCommentTemplate, atlasReplyConfirmationSchema,
  atlasCommentCommandSchema, atlasCommentReceiptSchema, type AtlasCommentReceipt,
  atlasIntegrationMilestoneKey, atlasJiraBlockerKey, atlasLeadershipAnswerSchema, atlasLeadershipFactsSchema,
  atlasScheduleCitationSchema, atlasSpreadsheetOrigin, atlasSpreadsheetRow, IngestionPersistenceError,
  atlasManagementFactsSchema, atlasManagementSnapshotSchema, calendarDayDifference,
  atlasDelayAssessmentSchema, atlasDelayCommandSchema, atlasDelayClarificationCommandSchema,
  atlasDelayClarificationSchema, type AtlasApprovalView, type AtlasSchedule,
  isCurrentProjectScheduleQuestion, isProjectSnapshotComparisonQuestion, projectLeadershipAnswerSchema, projectLeadershipQuestionSchema,
  projectDelayClarificationCommandSchema, projectDelayClarificationSchema,
  projectDelayCauseFactType, projectDelayCauseEvidenceSchema, projectDelayCauseCommandSchema,
  projectDelayCauseConfirmationSchema, projectDelayClarificationReviewSchema,
  projectManagementDraftSchema, projectManagementSnapshotSchema,
  projectReportApprovalSchema, projectReportApprovalRequestSchema, projectReportDecisionSchema,
  projectReportVersionSchema, projectReportDeliverySchema,
  type ProjectManagementDraft, type ProjectManagementSnapshot, type ProjectReportApproval, type ProjectReportDecision, type ProjectReportVersion,
  atlasReportApprovalRequestSchema, atlasReportDecisionSchema,
  atlasReportVersionSchema, atlasReportDistributionReceiptSchema, atlasReportRecipientSubject,
  suggestAtlasAccessStatus,
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
  projectUpdateAssessmentViewSchema,
  portfolioUpdateFreshnessPageSchema, portfolioUpdatePageSize, type PortfolioUpdateFreshnessPage,
  selectProjectUpdateTimestamp,
  canonicalSubjectSchema,
  projectUpdateRequiredFactSchema,
  ingestionReassessmentRetrySchema,
  ingestionReassessmentItemSchema,
  type IngestionReassessmentRetry,
  type IngestionReassessmentItem,
  ProjectFactError, ProjectUpdateError,
  type Actor,
  type DeliveryUpdateObservation,
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
import { DatabaseProjectFactRepository } from "./project-facts.js";
import {
  blockDisabledPolicyCauses, mayReadReassessmentSource, sourceStillMatches,
  reassessmentAudit, reassessmentNow, type ReassessmentCause,
} from "./ingestion-reassessments.js";
import { ProjectUpdateScanCoordinator } from "./project-update-scan.js";
import { projectEscalationHistoryBody } from "./project-update-history.js";
import type { DatabaseIngestionRepository } from "./ingestion-persistence.js";

type Tx = Prisma.TransactionClient;

const atlasConfirmedEvent = "atlas_demo.reply.confirmed";
const atlasDecidedEvent = "atlas_demo.approval.decided";
const atlasCommentEvent = "atlas_demo.comment.recorded";
const atlasCommentAttemptEvent = "atlas_demo.comment.attempt_started";
const atlasFixtureCommentPostedEvent = "atlas_demo.fixture.comment_posted";
const atlasFixtureChangedEvent = "atlas_demo.fixture.changed";
const atlasFixtureSourceSubject = "atlas-jira-fixture";
const atlasProposalRefreshedEvent = "atlas_demo.proposal.refreshed";
const atlasDelayConfirmedEvent = "atlas_demo.delay.confirmed";
const atlasDelayClarificationEvent = "atlas_demo.delay.clarification_requested";
const atlasManagementSnapshotEvent = "atlas_demo.management_snapshot.created";
const atlasReportRequestedEvent = "atlas_demo.report_approval.requested";
const atlasReportDecidedEvent = "atlas_demo.report_approval.decided";
const atlasReportDistributedEvent = "atlas_demo.report.distributed";
const projectDelayClarificationEvent = "project_delay.clarification_requested";
const projectDelayCauseConfirmedEvent = "project_delay.cause_confirmed";
const projectReportSavedEvent = "project_report.draft.saved";
const projectReportRequestedEvent = "project_report.approval.requested";
const projectReportDecidedEvent = "project_report.approval.decided";
const projectReportDeliveredEvent = "project_report.delivered";
const savedProjectReportDetail = z.strictObject({ projectId: z.uuid(), draft: projectManagementDraftSchema });
const storedProjectReportRequest = projectReportApprovalRequestSchema.extend({ projectId: z.uuid(), approver: canonicalSubjectSchema });
const storedProjectReportDecision = projectReportDecisionSchema.extend({ projectId: z.uuid() });
const storedProjectReportDelivery = projectReportVersionSchema.extend({
  projectId: z.uuid(), decisionId: z.uuid(), recipient: canonicalSubjectSchema,
});
type ProjectReportSubmission = z.infer<typeof storedProjectReportRequest> & {
  requestId: string; author: string; requestedAt: string;
};
type ProjectReportRequestRow = { id: string; detail: unknown; actor: string; occurredAt: Date };
type ProjectReportApprovalRecord = { approval: ProjectReportApproval; decisionId: string | null };
const payloadDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const capturedFactConfirmedEvents: Record<CapturedUpdateFactType, string> = {
  "project.status": "project_update.response.status_confirmed",
  "project.forecast": "project_update.response.forecast_confirmed",
};
const capturedStatusFactType = "project.status";
const capturedFactTypes = [capturedStatusFactType, "project.forecast"] as const;
const capturedFactClarifications = {
  "project.status": { event: "project_update.response.status_clarification_requested", question: projectUpdateClarificationQuestion },
  "project.forecast": { event: "project_update.response.forecast_clarification_requested", question: projectUpdateForecastClarificationQuestion },
} as const;
const clarificationFactType = (required: ReadonlySet<string>) => capturedFactTypes.find((factType) => required.has(factType));
const storedCapturedClarification = projectUpdateClarificationRequestSchema.omit({ factType: true }).extend({
  projectId: z.uuid(), captureIssuanceEpoch: z.uuid(),
});
const storedCapturedFactConfirmation = z.strictObject({
  projectId: z.uuid(), requestId: z.uuid(), responseId: z.uuid(), captureIssuanceEpoch: z.uuid(),
  factId: z.uuid(), versionId: z.uuid(), evidenceId: z.uuid(), payloadDigest: payloadDigestSchema,
  factSatisfied: z.boolean(),
});
const storedAtlasConfirmation = atlasReplyConfirmationSchema.extend({
  projectId: z.uuid(), requestId: z.uuid(), approver: canonicalSubjectSchema,
  template: z.literal(atlasCommentTemplate), captureIssuanceEpoch: z.uuid(),
  sourceRevision: z.number().int().nonnegative().optional(),
  currentComment: z.string().nullable().default(null),
});
const storedAtlasDecision = atlasApprovalDecisionSchema.safeExtend({
  projectId: z.uuid(), captureIssuanceEpoch: z.uuid(),
  payloadDigest: payloadDigestSchema.optional(),
});
const storedAtlasComment = z.strictObject({
  projectId: z.uuid(), approvalId: z.uuid(), responseId: z.uuid(), decisionId: z.uuid(),
  captureIssuanceEpoch: z.uuid(), fixtureRevision: z.number().int().positive(),
  template: z.literal(atlasCommentTemplate), accessStatus: atlasReplyConfirmationSchema.shape.accessStatus,
  payloadDigest: payloadDigestSchema,
});
const storedAtlasFixtureComment = storedAtlasComment.extend({ attemptId: z.uuid(), marker: z.string() });
const storedAtlasAttempt = z.strictObject({
  projectId: z.uuid(), approvalId: z.uuid(), responseId: z.uuid(), decisionId: z.uuid(), captureIssuanceEpoch: z.uuid(),
  target: z.literal(atlasJiraBlockerKey), sourceRevision: atlasApprovalViewSchema.shape.sourceRevision,
  payloadDigest: payloadDigestSchema, marker: z.string(),
});
const atlasActionMarker = (approvalId: string) => "pdaa-atlas:" + approvalId;
const storedAtlasFixtureChange = z.strictObject({
  projectId: z.uuid(),
  fixtureRevision: z.number().int().positive(),
  comment: atlasApprovalViewSchema.shape.currentComment,
});
const storedAtlasProposalRefresh = z.strictObject({
  projectId: z.uuid(), confirmationId: z.uuid(), responseId: z.uuid(), replacesApprovalId: z.uuid(),
  captureIssuanceEpoch: z.uuid(),
  sourceRevision: atlasApprovalViewSchema.shape.sourceRevision,
  currentComment: atlasApprovalViewSchema.shape.currentComment,
  proposedComment: atlasApprovalViewSchema.shape.proposedComment,
});
const storedAtlasDelay = atlasDelayCommandSchema.extend({
  projectId: z.uuid(), responseId: z.uuid(), captureIssuanceEpoch: z.uuid(), clarificationId: z.uuid().optional(),
});
const storedAtlasManagementSnapshot = z.strictObject({
  projectId: z.uuid(), locator: z.uuid(), captureIssuanceEpoch: z.uuid(), facts: atlasManagementFactsSchema,
});
const storedAtlasReportRequest = atlasReportApprovalRequestSchema.extend({
  projectId: z.uuid(), approver: canonicalSubjectSchema, captureIssuanceEpoch: z.uuid(),
});
const storedAtlasReportDecision = atlasReportDecisionSchema.extend({
  projectId: z.uuid(), captureIssuanceEpoch: z.uuid(),
});
const storedAtlasReportDistribution = atlasReportVersionSchema.extend({
  projectId: z.uuid(), decisionId: z.uuid(), recipient: z.literal(atlasReportRecipientSubject), captureIssuanceEpoch: z.uuid(),
});
type StoredAtlasManagementSnapshot = z.infer<typeof storedAtlasManagementSnapshot> & { id: string };
type AtlasReportSubmission = z.infer<typeof storedAtlasReportRequest> & { id: string; author: string };
type AtlasReportDecision = Pick<z.infer<typeof storedAtlasReportDecision>, "decision"> & { id: string; decidedAt: string };
type AtlasReportDistribution = { id: string; actor: string; distributedAt: string; detail: z.infer<typeof storedAtlasReportDistribution> };

type CaptureInvitationRow = {
  invitationId: string; requestId: string; recipientSubject: string; issuanceEpoch: string;
  issuedAt: Date; expiresAt: Date; capturedAt: Date; purgeAfter: Date;
  contentRetentionSeconds: number; reviewerSubjects: string[]; requiredFacts: unknown; dependencies: unknown;
  body: string | null; hasContent: boolean; contentState: "PRESENT" | "PURGED"; stageId: string;
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
type SourceDependency = Pick<ProjectUpdateFactReference, "factId" | "sourceId">;
class ConcernUpdateEvidenceUnavailable extends Error {}
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
  versions: Array<{ id: string; visibility: string; sourceType?: string; eligibilityReasons?: string[] }>;
};
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
 * validation marker from the authoritative version snapshot. Supported writers do
 * not establish a connector validation receipt. Visibility only proves reader
 * access and cannot authorize a timestamp.
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
    private readonly atlasDemoEnabled = false,
    private readonly replyInterpreter?: CapturedReplyInterpreter,
    private readonly reviewedCsv?: Pick<DatabaseIngestionRepository, "readReviewedCsvRow">,
  ) {
    this.authority = new DatabaseAuthorityRepository(db);
    this.zones = zones ? projectUpdateZoneConfigurationSchema.parse(zones) : null;
    this.serviceSubject = configuredServiceSubject
      ? canonicalSubjectSchema.parse(configuredServiceSubject)
      : null;
  }

  private async transaction<T>(operation: (tx: Tx) => Promise<T>, isolationLevel: "RepeatableRead" | "ReadCommitted" = "RepeatableRead"): Promise<T> {
    try {
      return await this.db.$transaction(operation, {
        isolationLevel,
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

  private async loadObservationPolicy(tx: Tx, customerId: string, id: string) {
    const heads = await tx.$queryRawUnsafe<{ revision: number }[]>(
      'SELECT revision FROM public."ProjectUpdatePolicy" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND key=\'project-update\' FOR SHARE',
      customerId, id,
    );
    if (!heads[0]) return null;
    const policy = await this.loadPolicy(tx, customerId, id);
    if (!policy || policy.revision !== heads[0].revision)
      throw new ProjectUpdateError("UNAVAILABLE");
    return policy;
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

  async portfolioFreshness(actorValue: Actor, after: string | null): Promise<PortfolioUpdateFreshnessPage> {
    const actor = parseActor(actorValue);
    const roles = actor.roles.filter((role) => role === "pmo_admin" || role === "portfolio_manager");
    if (!roles.length) throw new ProjectUpdateError("DENIED");
    const current = { ...actor, roles };
    const cursor = after === null ? null : parseProjectId(after);
    return this.transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Pick<ProjectRow, "id" | "code" | "name">[]>`
        SELECT p.id,p.code,p.name FROM public."Project" p
        WHERE p."customerId"=${current.customerId}::uuid
          AND (${cursor}::uuid IS NULL OR p.id>${cursor}::uuid)
          AND EXISTS (
            SELECT 1 FROM public."AccessGrant" g
            WHERE g."customerId"=p."customerId" AND g.subject=${current.subject}
              AND g.role=ANY(${roles}::text[])
              AND ((g."scopeType"='project' AND g."scopeId"=p.id)
                OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
          )
        ORDER BY p.id LIMIT ${portfolioUpdatePageSize + 1}`;
      const page = candidates.slice(0, portfolioUpdatePageSize);
      // Read the source projection only after any writer holding a Project
      // lock has committed, using the current grants and source readers.
      for (const project of page) await this.authorize(tx, current, project.id, false);
      const asOf = await this.now(tx);
      const projects = [];
      for (const { id, code, name } of page) projects.push({ id, code, name,
        assessment: await this.portfolioProjectFreshness(tx, current, id, asOf) });
      return portfolioUpdateFreshnessPageSchema.parse({
        asOf: iso(asOf), projects,
        next: candidates.length > portfolioUpdatePageSize ? page.at(-1)?.id : null,
      });
    }, "ReadCommitted");
  }

  private async portfolioProjectFreshness(tx: Tx, current: Actor, id: string, asOf: Date) {
    const policy = await this.loadObservationPolicy(tx, current.customerId, id);
    if (!policy) return { state: "UNCONFIGURED" as const };
    try {
      const project = await this.loadProject(tx, current.customerId, id);
      const { requiredFacts, facts } = await this.loadRequiredUpdateFacts(tx, current, id, policy);
      const { completeness, source, staleFactTypes, latestValidUpdateAt, freshnessThresholdAt, freshnessAssessment } =
        await this.prepareUpdateObservation(tx, current, id, project, policy, requiredFacts, asOf, facts, true);
      return {
        state: freshnessAssessment.freshness.state,
        lastVerifiedUpdateAt: latestValidUpdateAt,
        updateDueAt: freshnessAssessment.obligation?.dueAt ?? null,
        openObligation: source.remainingFactTypes.length ? await this.portfolioOpenObligation(
          tx, current, id, policy, freshnessThresholdAt,
        ) : null,
        missing: completeness.missing.map(({ factType, label }) => ({ factType, label })),
        stale: requiredFacts.filter((fact) => staleFactTypes.has(fact.factType)),
        conflicts: completeness.factAssessments.filter((fact) => fact.conflict === "CONFLICTING")
          .map(({ factType, label }) => ({ factType, label })),
      };
    } catch (error) {
      if (error instanceof ProjectUpdateError && error.code === "UNAVAILABLE")
        return { state: "UNAVAILABLE" as const };
      throw error;
    }
  }

  private async portfolioOpenObligation(tx: Tx, current: Actor, id: string, policy: PolicyRow, thresholdAt: Date) {
    const [row] = await tx.$queryRaw<Array<Pick<AssessmentRow, "result" | "assessedAt" | "dependencies"> & { id: string; dueAt: Date }>>`
      SELECT o.id,o."freshnessThresholdAt" AS "dueAt",a.result,a."assessedAt",a.dependencies
      FROM public."ProjectUpdateObligation" o JOIN public."ProjectUpdateAssessment" a
        ON a."customerId"=o."customerId" AND a."projectId"=o."projectId" AND a.id=o."assessmentId"
      WHERE o."customerId"=${current.customerId}::uuid AND o."projectId"=${id}::uuid
        AND o.state='OPEN' AND o."policyRevisionId"=${policy.policyRevisionId}::uuid
        AND (o."freshnessThresholdAt"=${thresholdAt} OR EXISTS (
          SELECT 1 FROM public."ProjectUpdateEngagement" e
          WHERE e."customerId"=o."customerId" AND e."projectId"=o."projectId"
            AND e."obligationId"=o.id AND e."policyRevisionId"=o."policyRevisionId" AND e.state IN ('ACTIVE','PAUSED')
        ))`;
    if (!row) return null;
    const origin = await this.readableUpdateFreshness(tx, current, id, { ...row, requiredFacts: policy.requiredFacts });
    return origin && Date.parse(origin.sourceDate) + policy.freshnessWindowSeconds * 1000 === row.dueAt.getTime()
      ? { id: row.id, dueAt: iso(row.dueAt) } : null;
  }

  private async loadRequiredUpdateFacts(tx: Tx, current: Actor, id: string, policy: PolicyRow) {
    const requiredFacts = policyFacts(policy.requiredFacts);
    const facts = await tx.$queryRawUnsafe<FactRow[]>(
      'SELECT id,"factType",revision FROM public."ProjectFact" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factType"=ANY($3::text[]) ORDER BY "factType",id FOR SHARE',
      current.customerId, id, requiredFacts.map((fact) => fact.factType),
    );
    return { requiredFacts, facts };
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

  // EXEC-023: current, authorized read only; no assessment or workflow writes.
  async updateSuggestions(actorValue: Actor, projectValue: string) {
    const current = parseActor(actorValue), id = parseProjectId(projectValue);
    try { return await this.transaction((tx) => this.updateSuggestionsInTransaction(tx, current, id), "ReadCommitted"); } catch (error) {
      if (error instanceof ProjectUpdateError && error.code === "CONFLICT")
        throw new ProjectUpdateError("UNAVAILABLE");
      throw error;
    }
  }

  // Internal composition: the caller owns the transaction. Every project,
  // grant, assignment, policy and source-authority check remains mandatory.
  async updateSuggestionsInTransaction(tx: Tx, actorValue: Actor, projectValue: string) {
      const current = parseActor(actorValue), id = parseProjectId(projectValue);
      const projects = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE',
        current.customerId, id,
      );
      if (!projects[0]) throw new ProjectUpdateError("DENIED");
      const scope = await tx.$queryRawUnsafe<{ portfolioId: string }[]>(
        'SELECT "portfolioId" FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid',
        current.customerId, id,
      );
      if (!scope[0]) throw new ProjectUpdateError("DENIED");
      const grants = await tx.$queryRawUnsafe<{ role: string }[]>(
        'SELECT role FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=$2 AND (("scopeType"=\'portfolio\' AND "scopeId"=$3::uuid) OR ("scopeType"=\'project\' AND "scopeId"=$4::uuid)) ORDER BY id FOR SHARE',
        current.customerId, current.subject, scope[0].portfolioId, id,
      );
      const canonical = await tx.$queryRawUnsafe<{ sealed: boolean }[]>(
        'SELECT sealed FROM public."CanonicalProject" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE',
        current.customerId, id,
      );
      const assignments = await tx.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM public."ProjectResponsibility" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND role=\'PROJECT_MANAGER\' AND subject=$3 ORDER BY id LIMIT 1',
        current.customerId, id, current.subject,
      );
      const isPm = current.roles.includes("project_manager") &&
        grants.some((grant) => grant.role === "project_manager") && canonical[0]?.sealed === true && assignments.length === 1;
      const isLeadership = current.roles.includes("leadership") && grants.some((grant) => grant.role === "leadership");
      if (!isPm && !isLeadership) throw new ProjectUpdateError("DENIED");
      if (canonical[0] && !canonical[0].sealed) throw new ProjectUpdateError("UNAVAILABLE");
      const audience = isPm ? "project_manager" : "leadership";
      const policy = await this.loadObservationPolicy(tx, current.customerId, id);
      if (!policy) return updateAdviceSnapshotSchema.parse({
        availability: "UNCONFIGURED", asOf: iso(await this.now(tx)), projectId: id,
        audience, approvalItems: "UNAVAILABLE",
      });
      const project = await this.loadProject(tx, current.customerId, id);
      const { requiredFacts, facts } = await this.loadRequiredUpdateFacts(tx, current, id, policy);
      const asOf = await this.now(tx);
      const result = await this.prepareUpdateObservation(tx, current, id, project, policy, requiredFacts, asOf, facts, true);
      return buildUpdateAdviceSnapshot({
        asOf: iso(asOf), projectId: id, audience, policyRevision: policy.revision,
        completeness: result.completeness, freshness: result.freshnessAssessment.freshness,
        evidence: result.evidence,
      });
  }

  // The health repository calls this under its Project SHARE gate. Keep the
  // cadence read permission-checked, side-effect free and on the caller's clock.
  async deliveryFreshnessInTransaction(
    tx: Tx, current: Actor, id: string, asOf: Date,
  ): Promise<{
    observation: DeliveryUpdateObservation;
    evidence: ProjectUpdateFactReference[];
    dependencies: SourceDependency[];
  }> {
    await authorizeFactProject(tx, current, id, "read");
    const policy = await this.loadObservationPolicy(tx, current.customerId, id);
    const unavailable = () => ({
      observation: {
        state: "UNASSESSABLE" as const,
        asOf: iso(asOf),
        policyRevision: policy?.revision ?? null,
      },
      evidence: [],
      dependencies: [],
    });
    if (!policy) return unavailable();

    const project = await this.loadProject(tx, current.customerId, id);
    const requiredFacts = policyFacts(policy.requiredFacts);
    const facts = await tx.$queryRawUnsafe<FactRow[]>(
      'SELECT id,"factType",revision FROM public."ProjectFact" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factType"=ANY($3::text[]) ORDER BY "factType",id FOR SHARE',
      current.customerId, id, requiredFacts.map((fact) => fact.factType),
    );
    const dependencies = new Map<string, SourceDependency>();
    try {
      const prepared = await this.prepareUpdateObservation(
        tx, current, id, project, policy, requiredFacts, asOf, facts, true, dependencies,
      );
      if (dependencies.size > 1000) throw new ProjectUpdateError("UNAVAILABLE");
      if (!prepared.allTrusted || prepared.latestValidUpdateAt === null)
        return unavailable();
      const freshness = prepared.freshnessAssessment.freshness;
      return {
        observation: {
          state: freshness.state,
          asOf: freshness.assessedAt,
          sourceDate: prepared.latestValidUpdateAt,
          policyRevision: policy.revision,
          timeZone: freshness.timeZone,
          freshnessWindowSeconds: freshness.freshnessWindowSeconds,
          ageMilliseconds: freshness.ageMilliseconds,
        },
        evidence: prepared.evidence,
        dependencies: [...dependencies.values()],
      };
    } catch (error) {
      if (error instanceof ConcernUpdateEvidenceUnavailable) return unavailable();
      throw error;
    }
  }

  private reassessmentItem(row: ReassessmentCause): IngestionReassessmentItem {
    return ingestionReassessmentItemSchema.parse({
      id: row.id, sourceId: row.sourceId, receiptId: row.receiptId, projectId: row.projectId,
      configRevision: row.configRevision, mappingRevision: row.mappingRevision,
      state: row.state, reason: row.lastReason, attemptCount: row.attemptCount,
      totalAttempts: row.totalAttempts, recoveryRevision: row.recoveryRevision,
      createdAt: row.createdAt.toISOString(), availableAt: row.availableAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      assessmentId: row.assessmentId, obligationId: row.obligationId, previewId: row.previewId,
    });
  }

  async reassessments(actorValue: Actor, projectValue: string, cursorValue?: string | null) {
    const current = parseActor(actorValue), id = parseProjectId(projectValue);
    const cursor = cursorValue == null ? null : parseProjectId(cursorValue);
    if (!current.roles.includes("pmo_admin")) throw new ProjectUpdateError("FORBIDDEN");
    return this.transaction(async (tx) => {
      try { await authorizeFactProject(tx, current, id, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
      // Filter before pagination so unreadable causes cannot displace authorized
      // work. Source locks then protect the current-reader recheck until commit.
      const rows = await tx.$queryRaw<ReassessmentCause[]>`
        SELECT w.* FROM public."IngestionProjectReassessment" w
        JOIN public."IngestionSource" s ON s."customerId"=w."customerId" AND s.id=w."sourceId"
        WHERE w."customerId"=${current.customerId}::uuid AND w."projectId"=${id}::uuid
          AND (${cursor}::uuid IS NULL OR w.id>${cursor}::uuid)
          AND EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" r
            JOIN public."IngestionConfigurationRevision" c ON c."customerId"=r."customerId" AND c."sourceId"=r."sourceId"
              AND c.revision=r."configRevision" AND c.sealed
            WHERE r."customerId"=s."customerId" AND r."sourceId"=s.id AND r."configRevision"=s."currentConfigRevision"
              AND r."projectId"=w."projectId" AND r.subject=${current.subject})
        ORDER BY w.id LIMIT 26`;
      for (const row of rows) if (!await mayReadReassessmentSource(tx, current, row)) throw new ProjectUpdateError("DENIED");
      const items = rows.slice(0, 25).map((row) => this.reassessmentItem(row));
      return { items, nextCursor: rows.length > 25 ? items[24]!.id : null };
    });
  }

  async retryReassessment(actorValue: Actor, projectValue: string, changeValue: IngestionReassessmentRetry, correlationValue: string) {
    const current = parseActor(actorValue), id = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    let change: IngestionReassessmentRetry;
    try { change = ingestionReassessmentRetrySchema.parse(changeValue); }
    catch { throw new ProjectUpdateError("INVALID_REQUEST"); }
    if (!current.roles.includes("pmo_admin")) throw new ProjectUpdateError("FORBIDDEN");
    return this.transaction(async (tx) => {
      try { await authorizeFactProject(tx, current, id, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
      const policy = await this.loadPolicy(tx, current.customerId, id, true);
      const [cause] = await tx.$queryRaw<ReassessmentCause[]>`
        SELECT * FROM public."IngestionProjectReassessment" WHERE "customerId"=${current.customerId}::uuid
          AND "projectId"=${id}::uuid AND id=${change.workId}::uuid FOR UPDATE`;
      if (!cause || !await mayReadReassessmentSource(tx, current, cause)) throw new ProjectUpdateError("DENIED");
      if (cause.state !== "BLOCKED" || cause.recoveryRevision !== change.expectedRecoveryRevision)
        throw new ProjectUpdateError("CONFLICT");
      if (!this.serviceSubject || !policy?.scheduledScanEnabled || policy.scheduledServiceSubject !== this.serviceSubject ||
          !await sourceStillMatches(tx, cause)) throw new ProjectUpdateError("CONFLICT");
      const now = await reassessmentNow(tx);
      const auditId = await reassessmentAudit(tx, cause, current.subject, "retried", {
        expectedRecoveryRevision: change.expectedRecoveryRevision,
      }, now, correlationId);
      const [updated] = await tx.$queryRaw<ReassessmentCause[]>`
        UPDATE public."IngestionProjectReassessment" SET state='READY',"attemptCount"=0,
          "recoveryRevision"="recoveryRevision"+1,"claimedGeneration"=NULL,"availableAt"=${now},
          "lastReason"='RETRY_REQUESTED',"auditEventId"=${auditId}::uuid
        WHERE id=${cause.id}::uuid AND "customerId"=${current.customerId}::uuid AND "projectId"=${id}::uuid
          AND state='BLOCKED' AND "recoveryRevision"=${change.expectedRecoveryRevision} RETURNING *`;
      if (!updated) throw new ProjectUpdateError("CONFLICT");
      return this.reassessmentItem(updated);
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
      if (!change.scheduledScanEnabled)
        await blockDisabledPolicyCauses(tx, current, id, correlationId);
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
    }, "ReadCommitted");
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

  private async prepareUpdateObservation(
    tx: Tx, current: Actor, id: string, project: ProjectRow, policy: PolicyRow,
    requiredFacts: ReturnType<typeof policyFacts>, asOf: Date, facts: FactRow[],
    strictRead = false,
    readDependencies?: Map<string, SourceDependency>,
  ) {
      const factByType = new Map(facts.map((fact) => [fact.factType, fact]));
      const prefixes = await this.authority.loadAssessmentPrefixesInTransaction(tx, current, id, facts, asOf);
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
      const staleFactTypes = new Set<string>();
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
        const prefix = prefixes.get(fact.id);
        if (strictRead && !prefix) throw new ProjectUpdateError("UNAVAILABLE");
        if (readDependencies && prefix?.versions.some((version) => version.provenance === "SYSTEM_VERIFIED")) {
          if (
            prefix.versions.length !== fact.revision ||
            prefix.versions.some((version, index) => version.revision !== index + 1)
          ) throw new ProjectUpdateError("UNAVAILABLE");
          // Cadence uses the existing authority prefix. Admitted source
          // observations require a different current disclosure contract.
          throw new ConcernUpdateEvidenceUnavailable();
        }
        const prepared = await this.authority.prepareAssessmentInTransaction(tx, current, {
          projectId: id,
          fact,
          asOf,
          prefix,
        });
        const resolved = prepared.result as unknown as Resolution;
        const statuses = new Set([
          "RESOLVED", "UNKNOWN", "CONFLICTING", "AMBIGUOUS", "INCOMPLETE",
          "REVALIDATION_REQUIRED", "NO_POLICY", "POLICY_NOT_APPLICABLE",
        ]);
        const status = statuses.has(resolved.status)
          ? resolved.status as typeof factAssessments[number]["sourceAuthorityStatus"]
          : "INCOMPLETE";
        if (strictRead && (!prepared.complete || status === "INCOMPLETE"))
          throw new ProjectUpdateError("UNAVAILABLE");
        if (strictRead && (
          resolved.versions.some((version) => version.visibility !== "available") ||
          prepared.versions.some((version) => {
            const access = prepared.access.find((item) => item.sourceId === version.sourceId);
            return !access || access.state !== "AVAILABLE" ||
              !access.readers.some((reader) => reader.subject === current.subject);
          })
        )) {
          if (readDependencies) throw new ConcernUpdateEvidenceUnavailable();
          throw new ProjectUpdateError("UNAVAILABLE");
        }
        if (strictRead && status === "REVALIDATION_REQUIRED")
          throw new ProjectUpdateError("UNAVAILABLE");
        if (status === "UNKNOWN" && resolved.versions.some((version) =>
          version.visibility === "available" && version.eligibilityReasons?.length === 1 &&
          version.eligibilityReasons[0] === "STALE")) staleFactTypes.add(requirement.factType);
        if (readDependencies) {
          for (const version of prepared.versions) {
            readDependencies.set(fact.id + ":" + version.sourceId, {
              factId: fact.id,
              sourceId: version.sourceId,
            });
          }
        }
        check.sourceState = "UNKNOWN";
        // Evidence may exist without an eligible authority selection. Count only
        // currently readable assessed versions, never restricted database history.
        const versionsCount = resolved.versions.filter(
          (version) => version.visibility === "available",
        ).length;
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
          if (!strictRead) knownPosition.push({
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
      for (const fact of source.facts) {
        if (fact.sourceState === "RESOLVED" && fact.state === "UNRESOLVED") staleFactTypes.add(fact.factType);
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
      return { source, completeness, allTrusted, evidence, knownPosition, staleFactTypes,
        latestValidUpdateAt, freshnessThresholdAt, freshnessAssessment };
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
      const { source, completeness, allTrusted, evidence, knownPosition,
        latestValidUpdateAt, freshnessThresholdAt, freshnessAssessment } =
        await this.prepareUpdateObservation(tx, current, id, project, policy, requiredFacts, asOf, facts);
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

  private async engagementAudit(tx: Tx, current: Actor, projectId: string, correlationId: string, event: string, detail: unknown,
    captureFence?: { expiresAt: Date; generation: string }) {
    const auditId = randomUUID();
    const capture = this.captureConfiguration(current.customerId);
    const recordedDetail = capture && typeof detail === "object" && detail !== null
      ? { ...detail, captureIssuanceEpoch: capture.issuanceEpoch } : detail;
    const occurredAt = await this.now(tx);
    if (captureFence && (capture?.issuanceEpoch !== captureFence.generation || occurredAt >= captureFence.expiresAt))
      throw new ProjectUpdateError("CONFLICT");
    await tx.$executeRawUnsafe(
      "INSERT INTO public.\"AuditEvent\" (id,\"customerId\",actor,event,\"correlationId\",detail,\"occurredAt\") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7)",
      auditId, current.customerId, current.subject, event, correlationId, stringify(recordedDetail), occurredAt,
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
        // A new generation invalidates captured locators. Prepare a fresh
        // owner request too, so unresolved facts retain a response path after
        // a partial source or recipient-zone replan. It must pass capture's
        // current source/recipient checks before any new invitation exists.
        if (replacements.some(({ stage }) => stage.mode === "CAPTURE") &&
            !replacements.some(({ stage }) => stage.kind === "REQUEST")) {
          const requestPlan = schedule.plans.find((plan) => plan.kind === "REQUEST");
          if (requestPlan) await this.insertStage(tx, current, projectId, engagement, requestPlan,
            prepared.source.remainingFactTypes, revisionAudit, null, "CAPTURE");
        }
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
    const policyRequiredFacts = policyFacts(prepared.policy.requiredFacts);
    const requiredFacts = policyRequiredFacts.filter((fact) => stage.factTypes.includes(fact.factType));
    const rendered = renderProjectUpdateCapture({
      project: { id: projectId, code: prepared.view.project.code, name: prepared.view.project.name },
      kind: stage.kind, policyRevision: prepared.policy.revision, dueAt: stage.logicalDueAt,
      capturedAt: iso(capturedAt), requiredFacts,
      clarifyRemainingFacts: stage.kind === "REQUEST" && stage.recipientRole === "OWNER" &&
        stage.generation > 1 && requiredFacts.length < policyRequiredFacts.length,
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

  private async captureSequenceWait(tx: Tx, current: Actor, projectId: string, stage: PendingStage, policy: PolicyRow) {
    if (stage.kind === "REQUEST") return null;
    const beforeOffsets = policy.reminderBusinessDayOffsets.filter((offset) => offset < stage.ordinal);
    const previousOffset = beforeOffsets.length ? Math.max(...beforeOffsets) : 0;
    const pm = stage.recipientRole === "PROJECT_MANAGER";
    const previousKind = pm ? "ESCALATION" : previousOffset ? "REMINDER" : "REQUEST";
    const previousOrdinal = pm ? stage.ordinal : previousOffset;
    const rows = await tx.$queryRawUnsafe<{ capturedAt: Date }[]>(
      'SELECT r."capturedAt" FROM public."ProjectUpdateCapturedRequest" r JOIN public."ProjectUpdateStage" s ON s."customerId"=r."customerId" AND s."projectId"=r."projectId" AND s.id=r."stageId" JOIN public."ProjectUpdateOutbox" o ON o."customerId"=s."customerId" AND o."projectId"=s."projectId" AND o."stageId"=s.id JOIN public."ProjectUpdateIssuanceGate" g ON g."customerId"=r."customerId" AND g."issuanceEpoch"=r."issuanceEpoch" WHERE r."customerId"=$1::uuid AND r."projectId"=$2::uuid AND s."engagementId"=$3::uuid AND s.kind=$4 AND s.ordinal=$5 AND s."recipientRole"=\'OWNER\' AND s."recipientSubject"=$6 AND o.state=\'CAPTURED\' AND s.generation<=$7 AND s.generation>=(SELECT max(initial.generation) FROM public."ProjectUpdateStage" initial WHERE initial."customerId"=$1::uuid AND initial."projectId"=$2::uuid AND initial."engagementId"=$3::uuid AND initial.kind=\'REQUEST\' AND initial.generation<=$7) ORDER BY s.generation DESC,r."capturedAt" DESC LIMIT 1',
      current.customerId, projectId, stage.engagementId, previousKind, previousOrdinal, policy.responsibleSubject, stage.generation,
    );
    const asOf = await this.now(tx);
    if (!rows[0]) return iso(new Date(asOf.getTime() + 300000));
    const plan = planProjectUpdateRecipientStage({
      kind: stage.kind, ordinal: pm ? stage.ordinal : stage.ordinal - previousOrdinal,
      recipientRole: stage.recipientRole, recipientSubject: stage.recipientSubject,
      logicalDueAt: stage.logicalDueAt, anchorAt: iso(rows[0].capturedAt),
      recipientTimeZone: stage.timeZone, projectTimeZone: policy.timeZone,
      customerTimeZone: this.zones!.customerTimeZone,
      quietHoursStartLocal: policy.quietHoursStartLocal, quietHoursEndLocal: policy.quietHoursEndLocal,
    });
    return Date.parse(plan.scheduledAt) > asOf.getTime() ? plan.scheduledAt : null;
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
              const sequenceWait = await this.captureSequenceWait(tx, current, projectId, stage, prepared.policy);
              const outcome = sequenceWait ? "UNANSWERED_STAGE_WAIT" :
                await this.captureStage(tx, current, projectId, stage, prepared, correlationId);
              if (outcome !== "CAPTURED")
                await this.deferStage(tx, current, projectId, stage,
                  sequenceWait ?? iso(new Date((await this.now(tx)).getTime() + 300000)), outcome, correlationId);
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

  private async authorizedInvitation(tx: Tx, current: Actor, locatorValue: string,
    review?: "pm" | "leadership" | "leadership-escalation" | "response-review") {
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
      'SELECT i.id AS "invitationId",i."requestId",i."recipientSubject",i."issuanceEpoch",i."issuedAt",i."expiresAt",r."capturedAt",r."purgeAfter",r."contentRetentionSeconds",r."reviewerSubjects",r."requiredFacts",r.dependencies,CASE WHEN $4::boolean THEN NULL ELSE c.body END AS body,(c.body IS NOT NULL) AS "hasContent",c.state AS "contentState",s.id AS "stageId",s.kind AS "stageKind",s."recipientRole",s."logicalDueAt",s.generation AS "stageGeneration",s."policyRevision",e."ownerSubject",e.state AS "engagementState",e.generation AS "engagementGeneration",o.state AS "obligationState",h.revision AS "currentPolicyRevision",b.state AS "outboxState",p.code,p.name FROM public."ProjectUpdateInvitation" i JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=i."customerId" AND r."projectId"=i."projectId" AND r.id=i."requestId" JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."requestId"=r.id JOIN public."ProjectUpdateStage" s ON s."customerId"=r."customerId" AND s."projectId"=r."projectId" AND s.id=r."stageId" JOIN public."ProjectUpdateEngagement" e ON e."customerId"=s."customerId" AND e."projectId"=s."projectId" AND e.id=s."engagementId" JOIN public."ProjectUpdateObligation" o ON o."customerId"=e."customerId" AND o."projectId"=e."projectId" AND o.id=e."obligationId" JOIN public."ProjectUpdatePolicy" h ON h."customerId"=e."customerId" AND h."projectId"=e."projectId" JOIN public."ProjectUpdateOutbox" b ON b."customerId"=s."customerId" AND b."projectId"=s."projectId" AND b."stageId"=s.id JOIN public."Project" p ON p."customerId"=s."customerId" AND p.id=s."projectId" WHERE i."customerId"=$1::uuid AND i."projectId"=$2::uuid AND i.locator=$3::uuid',
      current.customerId, projectId, locator.data, Boolean(review),
    );
    const row = rows[0];
    if (!row || (!review && row.recipientSubject !== current.subject)) throw new ProjectUpdateError("DENIED");
    const policy = await this.loadPolicy(tx, current.customerId, projectId, true);
    if (!policy) throw new ProjectUpdateError("DENIED");
    if (review === "response-review") {
      if (row.recipientRole !== "OWNER" || !row.reviewerSubjects.includes(current.subject) ||
          !configuration.responseReviewerSubjects.includes(current.subject)) throw new ProjectUpdateError("DENIED");
      try { await authorizeFactProject(tx, current, projectId, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
    } else if (review) {
      const pm = policy.escalationRecipientSubject;
      if (!this.atlasDemoEnabled || row.code !== atlasApprovalProjectCode || !pm || current.subject === row.recipientSubject)
        throw new ProjectUpdateError("DENIED");
      if (review === "leadership-escalation") {
        if (current.roles.length !== 1 || current.roles[0] !== "leadership" || row.stageKind !== "ESCALATION" ||
            row.recipientRole !== "PROJECT_MANAGER" || row.recipientSubject !== pm) throw new ProjectUpdateError("DENIED");
      } else {
        if (row.stageKind !== "REQUEST" || row.recipientRole !== "OWNER" || pm === row.recipientSubject)
          throw new ProjectUpdateError("DENIED");
        const reviewerAuthorized = review === "pm"
          ? pm === current.subject && await this.actorRecipientAuthorized(tx, current, projectId, "PROJECT_MANAGER")
          : await this.recipientAuthorized(tx, current.customerId, projectId, pm, "PROJECT_MANAGER");
        if (!reviewerAuthorized) throw new ProjectUpdateError("DENIED");
      }
    }
    const recipientAuthorized = review
      ? await this.recipientAuthorized(tx, current.customerId, projectId, row.recipientSubject, row.recipientRole)
      : await this.actorRecipientAuthorized(tx, current, projectId, row.recipientRole);
    const ownerAuthorized = await this.recipientAuthorized(tx, current.customerId, projectId, row.ownerSubject, "OWNER");
    const dependencies = z.array(projectUpdateFactReferenceSchema).max(1000).parse(jsonValue(row.dependencies));
    const readable = await this.resolveKnownPosition(tx, current, projectId, dependencies, policy.requiredFacts);
    const recipientReadable = review ? await this.resolveKnownPosition(tx,
      { customerId: current.customerId, subject: row.recipientSubject, roles: [] },
      projectId, dependencies, policy.requiredFacts) : readable;
    const asOf = await this.now(tx);
    const capture = {
      authenticatedSubject: current.subject, namedRecipientSubject: row.recipientSubject,
      sameCustomer: true, currentRecipientRoleAndGrant: recipientAuthorized,
      actorRoleMatchesGrant: recipientAuthorized, currentOwnerRoleAndGrant: ownerAuthorized,
      obligationOpen: row.obligationState === "OPEN", engagementActive: row.engagementState === "ACTIVE",
      policyCurrent: row.policyRevision === row.currentPolicyRevision,
      generationCurrent: row.stageGeneration === row.engagementGeneration,
      captureCommitted: row.outboxState === "CAPTURED", globalShadowOff: true,
      captureConfigured: true, issuanceEpochCurrent: row.issuanceEpoch === configuration.issuanceEpoch,
      restoreGateOpen: true, recipientReadsEveryDependency: recipientReadable.length === dependencies.length,
      viewerReadsEveryDependency: readable.length === dependencies.length,
      contentAvailable: row.contentState === "PRESENT" && row.hasContent,
      issuedAt: iso(row.issuedAt), expiresAt: iso(row.expiresAt),
      contentExpiresAt: iso(row.purgeAfter), asOf: iso(asOf),
    };
    if (!(review ? isActiveProjectUpdateCapture(capture) : mayAccessProjectUpdateInvitation(capture)))
      throw new ProjectUpdateError("DENIED");
    return { row, projectId, asOf, configuration, policy };
  }

  private async escalationContext(tx: Tx, current: Actor, projectId: string,
    invitation: CaptureInvitationRow, asOf: Date): Promise<ProjectUpdateEscalationContext | null> {
    if (invitation.stageKind !== "ESCALATION" || invitation.recipientRole !== "PROJECT_MANAGER")
      return null;
    const unavailable: ProjectUpdateEscalationContext = {
      asOf: iso(asOf), state: "UNAVAILABLE", impact: "UNKNOWN", originalRequestId: null, entries: [],
    };
    const rows = await tx.$queryRawUnsafe<Array<{
      requestId: string; stageId: string; stageKind: "REQUEST" | "REMINDER" | "ESCALATION";
      generation: number; ordinal: number; capturedAt: Date; purgeAfter: Date;
      recipientSubject: string; dependencies: unknown; policyRequiredFacts: unknown;
      contentState: string; rendererRevision: string; contentDigest: string;
      reviewerSubjects: string[]; originalRequestId: string;
    }>>(`WITH pm AS (
        SELECT "engagementId","policyRevision",generation FROM public."ProjectUpdateStage"
        WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid
          AND kind='ESCALATION' AND "recipientRole"='PROJECT_MANAGER'
      ), anchor AS (
        SELECT r.id,r."capturedAt",s.generation FROM pm
        JOIN public."ProjectUpdateStage" s ON s."customerId"=$1::uuid AND s."projectId"=$2::uuid
          AND s."engagementId"=pm."engagementId" AND s."policyRevision"=pm."policyRevision"
          AND s.generation<=pm.generation AND s.kind='REQUEST' AND s."recipientRole"='OWNER'
        JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=s."customerId"
          AND r."projectId"=s."projectId" AND r."stageId"=s.id
        JOIN public."ProjectUpdateOutbox" o ON o."customerId"=s."customerId"
          AND o."projectId"=s."projectId" AND o."stageId"=s.id AND o.state='CAPTURED'
        ORDER BY s.generation DESC,r."capturedAt" DESC,r.id DESC LIMIT 1
      )
      SELECT r.id AS "requestId",s.id AS "stageId",s.kind AS "stageKind",s.generation,s.ordinal,
        r."capturedAt",r."purgeAfter",r."recipientSubject",r.dependencies,
        p."requiredFacts" AS "policyRequiredFacts",c.state AS "contentState",r."rendererRevision",
        r."contentDigest",r."reviewerSubjects",anchor.id AS "originalRequestId"
      FROM pm CROSS JOIN anchor
      JOIN public."ProjectUpdateStage" s ON s."customerId"=$1::uuid AND s."projectId"=$2::uuid
        AND s."engagementId"=pm."engagementId" AND s."policyRevision"=pm."policyRevision"
        AND s."recipientRole"='OWNER' AND s.generation BETWEEN anchor.generation AND pm.generation
      JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=s."customerId"
        AND r."projectId"=s."projectId" AND r."stageId"=s.id
      JOIN public."ProjectUpdateOutbox" o ON o."customerId"=s."customerId"
        AND o."projectId"=s."projectId" AND o."stageId"=s.id AND o.state='CAPTURED'
      JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId"
        AND c."projectId"=r."projectId" AND c."requestId"=r.id
      JOIN public."ProjectUpdatePolicyRevision" p ON p."customerId"=s."customerId"
        AND p."projectId"=s."projectId" AND p.id=s."policyRevisionId"
      WHERE r.id=anchor.id OR s.kind IN ('REMINDER','ESCALATION')
      ORDER BY s.generation,CASE WHEN r.id=anchor.id THEN 0 ELSE 1 END,r."capturedAt",r.id LIMIT 21`,
    current.customerId, projectId, invitation.stageId);
    // Bound before reading any origin body or querying its source dependencies.
    if (rows.length === 0 || rows.length > 20) return unavailable;
    const entries: ProjectUpdateEscalationContext["entries"] = [];
    for (const row of rows) {
      const retained = row.contentState === "PRESENT" && row.purgeAfter > asOf;
      let body: string | null = null;
      if (retained && row.recipientSubject === invitation.ownerSubject &&
          await this.recipientAuthorized(tx, current.customerId, projectId, row.recipientSubject, "OWNER")) {
        const dependencies = z.array(projectUpdateFactReferenceSchema).max(1000).parse(jsonValue(row.dependencies));
        const recipient: Actor = { customerId: current.customerId, subject: row.recipientSubject, roles: [] };
        const viewerValues = await this.resolveKnownPosition(tx, current, projectId, dependencies, row.policyRequiredFacts);
        const recipientValues = await this.resolveKnownPosition(tx, recipient, projectId, dependencies, row.policyRequiredFacts);
        if (viewerValues.length === dependencies.length && recipientValues.length === dependencies.length) {
          const contents = await tx.$queryRawUnsafe<{ body: string }[]>(
            `SELECT c.body FROM public."ProjectUpdateRequestContent" c
              JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=c."customerId"
                AND r."projectId"=c."projectId" AND r.id=c."requestId"
              WHERE r."customerId"=$1::uuid AND r."projectId"=$2::uuid AND r.id=$3::uuid
                AND c.state='PRESENT' AND r."purgeAfter">clock_timestamp()`,
            current.customerId, projectId, row.requestId,
          );
          if (contents[0]) body = projectEscalationHistoryBody({
            body: contents[0].body, rendererRevision: row.rendererRevision,
            contentDigest: row.contentDigest, reviewerSubjects: row.reviewerSubjects,
          });
        }
      }
      entries.push({ requestId: row.requestId, stageId: row.stageId, stageKind: row.stageKind,
        generation: row.generation, ordinal: row.ordinal, capturedAt: iso(row.capturedAt),
        contentExpiresAt: iso(row.purgeAfter),
        contentState: !retained ? "EXPIRED" : body === null ? "RESTRICTED" : "PRESENT",
        bodyProjection: "REVIEWER_NAMES_WITHHELD", body });
    }
    const context = projectUpdateEscalationContextSchema.safeParse({
      asOf: iso(asOf), state: "AVAILABLE", impact: "UNKNOWN",
      originalRequestId: rows[0]!.originalRequestId, entries,
    });
    return context.success ? context.data : unavailable;
  }

  async invitation(actorValue: Actor, locatorValue: string): Promise<ProjectUpdateRecipientRequestView> {
    const current = parseActor(actorValue);
    return this.transaction(async (tx) => {
      const { row, projectId, asOf } = await this.authorizedInvitation(tx, current, locatorValue);
      const reviewers = row.reviewerSubjects.filter((subject) =>
        this.captureConfiguration(current.customerId)?.responseReviewerSubjects.includes(subject));
      const responses = await this.responseHistory(tx, current, projectId, row.requestId);
      const latest = responses[0];
      const requiredFacts = policyFacts(row.requiredFacts);
      let clarification: ProjectUpdateRecipientRequestView["clarification"];
      if (latest?.contentState === "PRESENT" && latest.text !== null && row.recipientRole === "OWNER" &&
          latest.submittedBy === current.subject) {
        const questions = [];
        for (const factType of capturedFactTypes) {
          if (requiredFacts.some((fact) => fact.factType === factType) &&
              await this.capturedClarification(tx, current.customerId, projectId, row.requestId, latest.id, row.issuanceEpoch, factType))
            questions.push(capturedFactClarifications[factType].question);
        }
        const question = questions.length === 2
          ? "What is the current project status, who is responsible if it is blocked, and what is the forecast finish date? Use an exact calendar date if known."
          : questions[0];
        if (question) clarification = { responseId: latest.id, question };
      }
      const atlasInterpretation = this.atlasDemoEnabled && row.code === atlasApprovalProjectCode &&
        row.stageKind === "REQUEST" && row.recipientRole === "OWNER" && latest?.contentState === "PRESENT" &&
        latest.text !== null && latest.submittedBy === current.subject
        ? { responseId: latest.id, suggestedStatus: suggestAtlasAccessStatus(latest.text) ?? "NEEDS_CLARIFICATION" } : undefined;
      // Readership is an explicit frozen contract; retain names of frozen
      // currently configured reviewers. Each actual reviewer read also checks
      // current PMO identity, scoped administrative grant and source access.
      return projectUpdateRecipientRequestViewSchema.parse({
        requestId: row.requestId, project: { id: projectId, code: row.code, name: row.name },
        stageKind: row.stageKind, dueAt: iso(row.logicalDueAt), capturedAt: iso(row.capturedAt),
        expiresAt: iso(row.expiresAt), body: row.body,
        requiredFacts,
        rawResponseReaders: [...new Set([row.recipientSubject, ...reviewers])],
        responses, atlasInterpretation, clarification,
        escalationContext: await this.escalationContext(tx, current, projectId, row, asOf),
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
        receivedAt: iso(previous.receivedAt), state: "UNCONFIRMED" as const,
        message: "Response recorded; required facts remain unconfirmed." as const };
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
        state: "UNCONFIRMED" as const, message: "Response recorded; required facts remain unconfirmed." as const };
    });
  }


  private async latestRetainedReply(tx: Tx, customerId: string, projectId: string, requestId: string, asOf: Date) {
    const rows = await tx.$queryRaw<{
      id: string; submittedBy: string; receivedAt: Date; purgeAfter: Date; state: string;
    }[]>`
      SELECT r.id, r."submittedBy", r."receivedAt", r."purgeAfter", c.state
      FROM public."ProjectUpdateResponse" r
      JOIN public."ProjectUpdateResponseContent" c ON c."customerId"=r."customerId"
        AND c."projectId"=r."projectId" AND c."responseId"=r.id
      WHERE r."customerId"=${customerId}::uuid AND r."projectId"=${projectId}::uuid AND r."requestId"=${requestId}::uuid
      ORDER BY r."receivedAt" DESC, r.id DESC LIMIT 1`;
    const latest = rows[0];
    return latest?.state === "PRESENT" && latest.purgeAfter > asOf ? latest : null;
  }

  private async capturedFactConfirmation(tx: Tx, customerId: string, projectId: string, requestId: string,
    responseId: string, captureIssuanceEpoch: string, factType: CapturedUpdateFactType) {
    const saved = await tx.auditEvent.findFirst({
      where: { customerId, event: capturedFactConfirmedEvents[factType], AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["requestId"], equals: requestId } },
        { detail: { path: ["responseId"], equals: responseId } },
      ] }, select: { id: true, actor: true, occurredAt: true, detail: true },
    });
    if (!saved) return null;
    const detail = storedCapturedFactConfirmation.parse(saved.detail);
    if (detail.captureIssuanceEpoch !== captureIssuanceEpoch) throw new ProjectUpdateError("UNAVAILABLE");
    const receipt = projectUpdateStatusConfirmationReceiptSchema.parse({
      responseId, receiptId: saved.id, confirmedBy: saved.actor, confirmedAt: iso(saved.occurredAt),
      factSatisfied: detail.factSatisfied,
    });
    return { receipt, payloadDigest: detail.payloadDigest };
  }

  private async capturedClarification(tx: Tx, customerId: string, projectId: string, requestId: string,
    responseId: string, captureIssuanceEpoch: string, factType: CapturedUpdateFactType) {
    const saved = await tx.auditEvent.findFirst({
      where: { customerId, event: capturedFactClarifications[factType].event, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["requestId"], equals: requestId } },
        { detail: { path: ["responseId"], equals: responseId } },
        { detail: { path: ["captureIssuanceEpoch"], equals: captureIssuanceEpoch } },
      ] }, select: { id: true, occurredAt: true },
    });
    return saved ? projectUpdateClarificationReceiptSchema.parse({
      responseId, clarificationId: saved.id, requestedAt: iso(saved.occurredAt),
    }) : null;
  }

  private async reviewCapturedReply(tx: Tx, current: Actor, projectId: string, requestId: string, responseId: string,
    factTypes: readonly CapturedUpdateFactType[]) {
    const invitation = await tx.projectUpdateInvitation.findFirst({
      where: { customerId: current.customerId, projectId, requestId }, select: { locator: true },
    });
    if (!invitation) throw new ProjectUpdateError("DENIED");
    const { row, asOf, policy } = await this.authorizedInvitation(tx, current, invitation.locator, "response-review");
    const latest = await this.latestRetainedReply(tx, current.customerId, projectId, requestId, asOf);
    const required = new Set(policyFacts(row.requiredFacts).map(({ factType }) => factType));
    if (factTypes.some((factType) => !required.has(factType)) ||
        latest?.id !== responseId || latest.submittedBy !== row.recipientSubject)
      throw new ProjectUpdateError("CONFLICT");
    return { row, latest, policy, required };
  }

  private async replyInterpretationInput(tx: Tx, current: Actor, projectId: string, requestId: string, responseId: string) {
    try { await authorizeFactProject(tx, current, projectId, "access"); }
    catch { throw new ProjectUpdateError("DENIED"); }
    const { row, latest, required } = await this.reviewCapturedReply(tx, current, projectId, requestId, responseId, []);
    const allowed: CapturedUpdateFactType[] = [];
    for (const factType of capturedFactTypes) {
      if (required.has(factType) &&
          !await this.capturedFactConfirmation(tx, current.customerId, projectId, requestId, responseId, row.issuanceEpoch, factType) &&
          !await this.capturedClarification(tx, current.customerId, projectId, requestId, responseId, row.issuanceEpoch, factType))
        allowed.push(factType);
    }
    const content = await tx.projectUpdateResponseContent.findFirst({
      where: { customerId: current.customerId, projectId, responseId, state: "PRESENT" },
      select: { body: true },
    });
    const text = projectUpdateResponseSubmissionSchema.shape.text.safeParse(content?.body);
    if (!allowed.length || !text.success) throw new ProjectUpdateError("CONFLICT");
    const expiresAt = new Date(Math.min(+row.expiresAt, +row.purgeAfter, +latest.purgeAfter));
    return { text: text.data, allowed, captureFence: { generation: row.issuanceEpoch, expiresAt } };
  }

  async interpretCapturedReply(actorValue: Actor, projectValue: string, requestValue: unknown,
    correlationValue: string): Promise<CapturedReplyInterpretation> {
    const interpreter = this.replyInterpreter;
    if (!interpreter) throw new ProjectUpdateError("DENIED");
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = capturedReplyInterpretationRequestSchema.safeParse(requestValue);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    const { requestId, responseId } = parsed.data;
    const readReply = (tx: Tx) => this.replyInterpretationInput(tx, current, projectId, requestId, responseId);
    const metadata = capturedReplyInterpreterMetadataSchema.parse(interpreter.metadata);
    const previous = await this.transaction(async (tx) => {
      const input = await readReply(tx);
      const runId = await this.engagementAudit(tx, current, projectId, correlationId,
        "project_update.response.interpretation_started", { projectId, requestId, responseId, ...metadata }, input.captureFence);
      return { ...input, runId };
    }, "ReadCommitted");
    if (Date.now() >= +previous.captureFence.expiresAt) throw new ProjectUpdateError("CONFLICT");
    let suggestions: CapturedReplyInterpretation["suggestions"] = [];
    let outcome = "UNAVAILABLE";
    try {
      const output = await interpreter.interpret(previous.text, previous.allowed);
      suggestions = readGroundedReplySuggestions(previous.text, previous.allowed, output);
      outcome = suggestions.length ? "PROPOSED" : "MANUAL_REVIEW";
    } catch { /* Manual review remains available. */ }

    return this.transaction(async (tx) => {
      const latest = await readReply(tx);
      if (latest.captureFence.generation !== previous.captureFence.generation || latest.text !== previous.text ||
          JSON.stringify(latest.allowed) !== JSON.stringify(previous.allowed)) throw new ProjectUpdateError("CONFLICT");
      await this.engagementAudit(tx, current, projectId, correlationId, "project_update.response.interpreted", {
        projectId, requestId, responseId, ...metadata, outcome, runId: previous.runId,
      }, latest.captureFence);
      return capturedReplyInterpretationSchema.parse({ requestId, responseId, classification: "AGENT_INFERENCE", suggestions });
    }, "ReadCommitted");
  }

  async requestCapturedStatusClarification(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      try { await authorizeFactProject(tx, current, projectId, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
      const parsed = projectUpdateClarificationRequestSchema.safeParse(value);
      if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
      const { requestId, responseId } = parsed.data;
      const { row, latest, required } = await this.reviewCapturedReply(tx, current, projectId, requestId, responseId, []);
      const factType = parsed.data.factType ?? clarificationFactType(required);
      if (!factType || !required.has(factType)) throw new ProjectUpdateError("CONFLICT");
      const previous = await this.capturedClarification(tx, current.customerId, projectId, requestId, responseId, row.issuanceEpoch, factType);
      if (previous) return previous;
      if (await this.capturedFactConfirmation(tx, current.customerId, projectId, requestId,
        responseId, row.issuanceEpoch, factType))
        throw new ProjectUpdateError("CONFLICT");
      const id = await this.engagementAudit(tx, current, projectId, correlationId, capturedFactClarifications[factType].event,
        { projectId, requestId, responseId });
      const saved = await tx.auditEvent.findUniqueOrThrow({ where: { id }, select: { occurredAt: true, detail: true } });
      if (storedCapturedClarification.parse(saved.detail).captureIssuanceEpoch !== row.issuanceEpoch ||
          saved.occurredAt >= row.expiresAt || saved.occurredAt >= row.purgeAfter || saved.occurredAt >= latest.purgeAfter)
        throw new ProjectUpdateError("CONFLICT");
      return projectUpdateClarificationReceiptSchema.parse({ responseId, clarificationId: id, requestedAt: iso(saved.occurredAt) });
    }, "ReadCommitted");
  }

  async confirmCapturedStatus(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const parsed = projectUpdateStatusConfirmationSchema.safeParse(value);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    const { requestId, responseId, expectedRevision, status } = parsed.data;
    const [confirmed] = await this.confirmCapturedFacts(actorValue, projectValue, {
      requestId, responseId, facts: [{ factType: capturedStatusFactType, expectedRevision, value: status }],
    }, correlationValue);
    if (!confirmed) throw new ProjectUpdateError("UNAVAILABLE");
    const { factType, ...receipt } = confirmed;
    if (factType !== capturedStatusFactType) throw new ProjectUpdateError("UNAVAILABLE");
    return receipt;
  }

  async confirmCapturedFacts(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      try { await authorizeFactProject(tx, current, projectId, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
      const parsed = projectUpdateFactConfirmationSchema.safeParse(value);
      if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
      const { requestId, responseId, facts: confirmationItems } = parsed.data;
      const { row, latest, policy } = await this.reviewCapturedReply(tx, current, projectId, requestId, responseId,
        confirmationItems.map(({ factType }) => factType));

      const facts = new DatabaseProjectFactRepository(this.db);
      const receipts = new Map<CapturedUpdateFactType, z.infer<typeof projectUpdateStatusConfirmationReceiptSchema>>();
      const written: { factType: CapturedUpdateFactType; payloadDigest: string; factId: string; versionId: string; evidenceId: string }[] = [];
      for (const item of confirmationItems) {
        const { factType, expectedRevision } = item;
        if (await this.capturedClarification(tx, current.customerId, projectId, requestId, responseId, row.issuanceEpoch, factType))
          throw new ProjectUpdateError("CONFLICT");
        const payloadDigest = hash({ requestId, responseId, expectedRevision,
          [factType === capturedStatusFactType ? "status" : "forecast"]: item.value });
        const previous = await this.capturedFactConfirmation(tx, current.customerId, projectId, requestId,
          responseId, row.issuanceEpoch, factType);
        if (previous) {
          if (previous.payloadDigest !== payloadDigest || previous.receipt.confirmedBy !== current.subject)
            throw new ProjectUpdateError("CONFLICT");
          receipts.set(factType, previous.receipt);
          continue;
        }
        const statement = await facts.appendHumanStatementInTransaction(tx, current, {
          projectId, factType, expectedRevision, idempotencyKey: randomUUID(),
          value: { type: factType === capturedStatusFactType ? "text" : "date", value: item.value },
          originalStatement: item.value, effectiveAt: iso(latest.receivedAt),
        }, { correlationId }).catch((error: unknown) => {
          if (error instanceof ProjectFactError && (error.code === "REVISION_CONFLICT" || error.code === "SOURCE_RESTRICTED"))
            throw new ProjectUpdateError("CONFLICT");
          throw error;
        });
        written.push({ factType, payloadDigest, factId: statement.factId,
          versionId: statement.entry.id, evidenceId: statement.entry.evidenceId });
      }
      const service = this.serviceSubject;
      const prepared = written.length > 0 && service && this.zones?.customerId === current.customerId &&
        policy.scheduledScanEnabled && policy.scheduledServiceSubject === service
        ? await this.assessInTransaction(tx, { customerId: current.customerId, subject: service, roles: [] },
          projectId, correlationId, true)
        : null;
      for (const { factType, ...evidence } of written) {
        const factSatisfied = Boolean(prepared?.source.satisfiedFactTypes.includes(factType) &&
          prepared.view.knownPosition.some((fact) => fact.versionId === evidence.versionId));
        const id = await this.engagementAudit(tx, current, projectId, correlationId, capturedFactConfirmedEvents[factType], {
          projectId, requestId, responseId, ...evidence, factSatisfied,
        });
        const saved = await tx.auditEvent.findUniqueOrThrow({ where: { id }, select: { occurredAt: true, detail: true } });
        if (storedCapturedFactConfirmation.parse(saved.detail).captureIssuanceEpoch !== row.issuanceEpoch ||
            saved.occurredAt >= row.expiresAt || saved.occurredAt >= row.purgeAfter || saved.occurredAt >= latest.purgeAfter)
          throw new ProjectUpdateError("CONFLICT");
        receipts.set(factType, { responseId, receiptId: id, confirmedBy: current.subject,
          confirmedAt: iso(saved.occurredAt), factSatisfied });
      }
      return projectUpdateFactConfirmationReceiptSchema.parse(confirmationItems.map(({ factType }) =>
        ({ factType, ...receipts.get(factType) })));
    }, "ReadCommitted");
  }

  async confirmAtlasReply(actorValue: Actor, locator: string, value: unknown, correlationValue: string) {
    if (!this.atlasDemoEnabled) throw new ProjectUpdateError("DENIED");
    const current = parseActor(actorValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      const { row, projectId, asOf, policy } = await this.authorizedInvitation(tx, current, locator);
      const approver = policy.escalationRecipientSubject;
      if (row.code !== atlasApprovalProjectCode || row.stageKind !== "REQUEST" || row.recipientRole !== "OWNER" ||
          !approver || approver === current.subject ||
          !await this.recipientAuthorized(tx, current.customerId, projectId, approver, "PROJECT_MANAGER"))
        throw new ProjectUpdateError("DENIED");
      const parsed = atlasReplyConfirmationSchema.safeParse(value);
      if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
      const latest = await this.latestRetainedReply(tx, current.customerId, projectId, row.requestId, asOf);
      if (latest?.id !== parsed.data.responseId || latest.submittedBy !== current.subject)
        throw new ProjectUpdateError("CONFLICT");
      const previous = await tx.auditEvent.findFirst({
        where: { customerId: current.customerId, actor: current.subject, event: atlasConfirmedEvent, AND: [
          { detail: { path: ["projectId"], equals: projectId } },
          { detail: { path: ["responseId"], equals: latest.id } },
        ] }, select: { id: true, detail: true },
      });
      if (previous) {
        const old = storedAtlasConfirmation.parse(previous.detail);
        if (old.accessStatus !== parsed.data.accessStatus || old.approver !== approver ||
            old.captureIssuanceEpoch !== row.issuanceEpoch)
          throw new ProjectUpdateError("CONFLICT");
        return { approvalId: previous.id };
      }
      const fixture = await this.atlasFixtureState(tx, current.customerId, projectId);
      return { approvalId: await this.engagementAudit(tx, current, projectId, correlationId, atlasConfirmedEvent, {
        ...parsed.data, projectId, requestId: row.requestId, approver, template: atlasCommentTemplate,
        sourceRevision: fixture.revision, currentComment: fixture.comment,
      }) };
    }, "ReadCommitted");
  }

  private async atlasFixtureState(tx: Tx, customerId: string, projectId: string) {
    const [last] = await tx.$queryRaw<{ event: string; detail: unknown; decision: unknown }[]>`
      SELECT receipt.event, receipt.detail, approval.detail AS decision FROM public."AuditEvent" receipt
      LEFT JOIN public."AuditEvent" approval ON approval."customerId"=receipt."customerId"
        AND approval.id=(receipt.detail->>'decisionId')::uuid AND approval.event=${atlasDecidedEvent}
        AND approval.actor=receipt.actor
      WHERE receipt."customerId"=${customerId}::uuid
        AND (receipt.event=${atlasCommentEvent} OR receipt.event=${atlasFixtureCommentPostedEvent} OR
          (receipt.event=${atlasFixtureChangedEvent} AND receipt.actor=${atlasFixtureSourceSubject}))
        AND receipt.detail->>'projectId'=${projectId}
      ORDER BY (receipt.detail->>'fixtureRevision')::integer DESC, receipt."occurredAt" DESC, receipt.id DESC LIMIT 1`;
    if (!last) return { revision: 0, comment: null };
    if (last.event === atlasFixtureChangedEvent) {
      const change = storedAtlasFixtureChange.parse(last.detail);
      return { revision: change.fixtureRevision, comment: change.comment };
    }
    const event = last.event === atlasFixtureCommentPostedEvent
      ? storedAtlasFixtureComment.parse(last.detail) : storedAtlasComment.parse(last.detail);
    const decision = storedAtlasDecision.parse(last.decision);
    const comment = decision.proposedComment ?? atlasComment(event.accessStatus);
    if (("marker" in event && event.marker !== atlasActionMarker(event.approvalId)) ||
        decision.decision !== "APPROVED" || decision.projectId !== projectId || decision.approvalId !== event.approvalId ||
        decision.captureIssuanceEpoch !== event.captureIssuanceEpoch ||
        ((decision.payloadDigest !== undefined || decision.proposedComment !== undefined) &&
          decision.payloadDigest !== event.payloadDigest) ||
        event.payloadDigest !== hash({ approvalId: event.approvalId, target: atlasJiraBlockerKey,
          proposedComment: comment, sourceRevision: event.fixtureRevision - 1 }))
      throw new ProjectUpdateError("UNAVAILABLE");
    return { revision: event.fixtureRevision, comment };
  }

  private async lockAtlasProject(tx: Tx, current: Actor, projectId: string) {
    if (!this.atlasDemoEnabled) throw new ProjectUpdateError("DENIED");
    const projects = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM public."Project" WHERE "customerId"=${current.customerId}::uuid
        AND id=${projectId}::uuid AND code=${atlasApprovalProjectCode} FOR UPDATE`;
    if (!projects[0]) throw new ProjectUpdateError("DENIED");
  }

  private async loadAtlasApproval(tx: Tx, current: Actor, projectId: string, audience: "pm" | "leadership" = "pm") {
    await this.lockAtlasProject(tx, current, projectId);
    if (audience === "leadership") {
      if (current.roles.length !== 1 || current.roles[0] !== "leadership") throw new ProjectUpdateError("DENIED");
      await this.authorize(tx, current, projectId, false);
    }
    else if (!await this.actorRecipientAuthorized(tx, current, projectId, "PROJECT_MANAGER"))
      throw new ProjectUpdateError("DENIED");
    const confirmed = await tx.auditEvent.findFirst({
      where: { customerId: current.customerId, event: atlasConfirmedEvent, detail: { path: ["projectId"], equals: projectId } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true, actor: true, detail: true },
    });
    if (!confirmed) return null;
    const detail = storedAtlasConfirmation.parse(confirmed.detail);
    if (audience === "pm" && detail.approver !== current.subject) throw new ProjectUpdateError("DENIED");
    const invitation = await tx.projectUpdateInvitation.findFirst({
      where: { customerId: current.customerId, projectId, requestId: detail.requestId }, select: { locator: true },
    });
    if (!invitation) throw new ProjectUpdateError("DENIED");
    const { row, asOf, policy } = await this.authorizedInvitation(tx, current, invitation.locator, audience);
    if (row.issuanceEpoch !== detail.captureIssuanceEpoch || row.recipientSubject !== confirmed.actor ||
        policy.escalationRecipientSubject !== detail.approver)
      throw new ProjectUpdateError("DENIED");
    const latest = await this.latestRetainedReply(tx, current.customerId, projectId, row.requestId, asOf);
    if (latest?.id !== detail.responseId || latest.submittedBy !== confirmed.actor) return null;
    const [refreshed] = await tx.$queryRaw<{ id: string; detail: unknown }[]>`
      SELECT id,detail FROM public."AuditEvent"
      WHERE "customerId"=${current.customerId}::uuid AND actor=${detail.approver} AND event=${atlasProposalRefreshedEvent}
        AND detail->>'projectId'=${projectId} AND detail->>'confirmationId'=${confirmed.id}
      ORDER BY (detail->>'sourceRevision')::integer DESC LIMIT 1`;
    const comparison = refreshed ? storedAtlasProposalRefresh.parse(refreshed.detail) : null;
    if (comparison && (comparison.captureIssuanceEpoch !== row.issuanceEpoch || comparison.responseId !== latest.id ||
        comparison.replacesApprovalId === refreshed?.id))
      throw new ProjectUpdateError("UNAVAILABLE");
    const approvalId = refreshed?.id ?? confirmed.id;
    const decided = await tx.auditEvent.findFirst({
      where: { customerId: current.customerId, actor: detail.approver, event: atlasDecidedEvent, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["approvalId"], equals: approvalId } },
      ] }, select: { id: true, detail: true },
    });
    const decision = decided ? storedAtlasDecision.parse(decided.detail) : null;
    if (decision && decision.captureIssuanceEpoch !== row.issuanceEpoch)
      throw new ProjectUpdateError("UNAVAILABLE");
    if (audience === "leadership" && decision?.decision !== "APPROVED") return null;
    const recorded = await tx.auditEvent.findFirst({
      where: { customerId: current.customerId, actor: detail.approver, event: atlasCommentEvent, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["approvalId"], equals: approvalId } },
      ] }, select: { id: true, detail: true, occurredAt: true },
    });
    let receipt: AtlasCommentReceipt | null = null;
    const target = atlasJiraBlockerKey;
    const draftComment = comparison?.proposedComment ?? atlasComment(detail.accessStatus);
    const proposedComment = decision?.proposedComment ?? draftComment;
    const sourceRevision = comparison?.sourceRevision ?? detail.sourceRevision ?? 0;
    const payloadDigest = hash({ approvalId, target, proposedComment, sourceRevision });
    if (decision?.proposedComment !== undefined && decision.payloadDigest !== payloadDigest)
      throw new ProjectUpdateError("UNAVAILABLE");
    const attempt = await tx.auditEvent.findFirst({
      where: { customerId: current.customerId, actor: detail.approver, event: atlasCommentAttemptEvent, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["approvalId"], equals: approvalId } },
      ] }, select: { id: true, detail: true },
    });
    if (attempt) {
      const event = storedAtlasAttempt.parse(attempt.detail);
      if (event.decisionId !== decided?.id || decision?.decision !== "APPROVED" ||
          event.payloadDigest !== payloadDigest || event.responseId !== latest.id ||
          event.sourceRevision !== sourceRevision || event.captureIssuanceEpoch !== row.issuanceEpoch ||
          event.marker !== atlasActionMarker(approvalId))
        throw new ProjectUpdateError("UNAVAILABLE");
    }
    if (recorded) {
      const event = storedAtlasComment.parse(recorded.detail);
      if (event.decisionId !== decided?.id || decision?.decision !== "APPROVED" ||
          event.payloadDigest !== payloadDigest || event.responseId !== latest.id ||
          event.accessStatus !== detail.accessStatus || event.fixtureRevision !== sourceRevision + 1 ||
          event.captureIssuanceEpoch !== row.issuanceEpoch)
        throw new ProjectUpdateError("UNAVAILABLE");
      receipt = { id: recorded.id, approvalId, target, fixtureRevision: event.fixtureRevision,
        recordedAt: iso(recorded.occurredAt), result: "SIMULATED" };
    }
    const view = atlasApprovalViewSchema.parse({
      approvalId, responseId: latest.id, replyReceivedAt: iso(latest.receivedAt),
      confirmedBy: confirmed.actor, approver: detail.approver, accessStatus: detail.accessStatus,
      target, currentComment: comparison ? comparison.currentComment : detail.currentComment, proposedComment, sourceRevision,
      replacesApprovalId: comparison?.replacesApprovalId,
      expiresAt: new Date(Math.min(row.expiresAt.getTime(), row.purgeAfter.getTime(), latest.purgeAfter.getTime())).toISOString(),
      decision: decision?.decision ?? "PENDING", receipt,
      executionPending: attempt && !receipt ? true : undefined,
    });
    return { view, draftComment, confirmationId: confirmed.id, locator: invitation.locator, stageId: row.stageId,
      capturedAt: row.capturedAt, captureIssuanceEpoch: row.issuanceEpoch,
      decisionId: decided?.id, approvedDigest: decision?.payloadDigest, payloadDigest,
      attemptId: attempt?.id,
      legacyConfirmation: !comparison && detail.sourceRevision === undefined };
  }

  private async canonicalProjectSchedule(tx: Tx, customerId: string, projectId: string): Promise<AtlasSchedule | null> {
    const project = await tx.canonicalProject.findFirst({
      where: { id: projectId, customerId, sealed: true },
      select: { revision: true, baselineEnd: true, forecastEnd: true },
    });
    if (!project) return null;
    const baseline = project.baselineEnd?.toISOString().slice(0, 10) ?? null;
    const forecast = project.forecastEnd?.toISOString().slice(0, 10) ?? null;
    return { revision: project.revision, baseline, forecast,
      movementDays: baseline && forecast ? calendarDayDifference(forecast, baseline) : null };
  }

  private async atlasScheduleEvidence(tx: Tx, current: Actor, projectId: string, schedule: AtlasSchedule | null,
    expected?: z.infer<typeof atlasScheduleCitationSchema>) {
    if (!schedule) return null;
    const mapping = await tx.canonicalSourceMapping.findFirst({
      where: { customerId: current.customerId, projectId, sourceSystem: "Portfolio CSV", instanceKey: "atlas-demo",
        externalType: "spreadsheet:Portfolio", externalId: atlasSpreadsheetRow, targetType: "PROJECT",
        url: atlasSpreadsheetOrigin + "/atlas-portfolio.csv" },
      select: { externalId: true },
    });
    if (!mapping) return expected ? null : { schedule };
    let reviewed;
    try {
      reviewed = await this.reviewedCsv?.readReviewedCsvRow(tx, current, {
        projectId, origin: atlasSpreadsheetOrigin, sheet: "Portfolio", rowKey: mapping.externalId,
        ...(expected && { sourceId: expected.sourceId, receiptId: expected.receiptId }),
      });
    } catch (error) {
      if (error instanceof IngestionPersistenceError) return null;
      throw error;
    }
    const now = await this.now(tx);
    if (!reviewed || reviewed.availableUntil <= now || reviewed.reviewedAt > iso(now) ||
        !schedule.baseline || !schedule.forecast || reviewed.proposals.length !== 2 ||
        !reviewed.proposals.some(({ factType, value }) => factType === "project.baseline" && value.type === "date" && value.value === schedule.baseline) ||
        !reviewed.proposals.some(({ factType, value }) => factType === "project.forecast" && value.type === "date" && value.value === schedule.forecast))
      return null;
    const { sourceId, receiptId, reviewedAt, availableUntil } = reviewed;
    return { schedule, citation: atlasScheduleCitationSchema.parse({ sourceId, receiptId, reviewedAt, availableUntil: iso(availableUntil) }) };
  }

  private async currentAtlasSchedule(tx: Tx, actor: Actor, projectId: string) {
    const canonical = await this.canonicalProjectSchedule(tx, actor.customerId, projectId);
    return this.atlasScheduleEvidence(tx, actor, projectId, canonical);
  }

  private async atlasDelayReview(tx: Tx, customerId: string, projectId: string,
    view: AtlasApprovalView, captureIssuanceEpoch: string, schedule: AtlasSchedule | null) {
    const { receipt } = view;
    if (!receipt || view.accessStatus !== "ACCESS_PENDING" || !schedule || (schedule.movementDays ?? 0) <= 0) return null;
    const saved = await tx.auditEvent.findFirst({
      where: { customerId, actor: view.approver, event: atlasDelayConfirmedEvent, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["receiptId"], equals: receipt.id } },
        { detail: { path: ["scheduleRevision"], equals: schedule.revision } },
      ] }, select: { id: true, detail: true, occurredAt: true },
    });
    if (!saved) return { schedule, assessment: null };
    const detail = storedAtlasDelay.parse(saved.detail);
    if (detail.approvalId !== view.approvalId || detail.responseId !== view.responseId ||
        detail.captureIssuanceEpoch !== captureIssuanceEpoch ||
        saved.occurredAt < new Date(receipt.recordedAt) || saved.occurredAt >= new Date(view.expiresAt))
      throw new ProjectUpdateError("UNAVAILABLE");
    return { schedule, assessment: atlasDelayAssessmentSchema.parse({
      approvalId: detail.approvalId, receiptId: detail.receiptId, scheduleRevision: detail.scheduleRevision,
      cause: detail.cause, confidence: detail.confidence, id: saved.id, confirmedBy: view.approver, confirmedAt: iso(saved.occurredAt),
    }) };
  }

  async atlasApproval(actorValue: Actor, projectValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      const approved = await this.loadAtlasApproval(tx, current, projectId);
      if (!approved) return null;
      const delayReview = approved.view.receipt ? await this.atlasDelayReview(tx, current.customerId, projectId,
        approved.view, approved.captureIssuanceEpoch, (await this.currentAtlasSchedule(tx, current, projectId))?.schedule ?? null) : null;
      if (delayReview && await this.now(tx) >= new Date(approved.view.expiresAt)) throw new ProjectUpdateError("DENIED");
      return { ...approved.view, delayReview };
    }, "ReadCommitted");
  }

  async confirmAtlasDelay(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = atlasDelayCommandSchema.safeParse(value);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      const approved = await this.loadAtlasApproval(tx, current, projectId);
      const { approvalId, receiptId, scheduleRevision, confidence } = parsed.data;
      if (!approved || approved.view.approvalId !== approvalId || approved.view.receipt?.id !== receiptId)
        throw new ProjectUpdateError("CONFLICT");
      const { view, captureIssuanceEpoch } = approved;
      const review = await this.atlasDelayReview(tx, current.customerId, projectId, view, captureIssuanceEpoch,
        (await this.currentAtlasSchedule(tx, current, projectId))?.schedule ?? null);
      if (await this.now(tx) >= new Date(view.expiresAt)) throw new ProjectUpdateError("DENIED");
      if (!review || review.schedule.revision !== scheduleRevision ||
          (review.assessment && review.assessment.confidence !== confidence))
        throw new ProjectUpdateError("CONFLICT");
      if (review.assessment) return review.assessment;
      const clarification = await this.findDelayClarification(tx, current.customerId, projectId,
        current.subject, scheduleRevision, atlasDelayClarificationEvent, captureIssuanceEpoch);
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasDelayConfirmedEvent,
        { ...parsed.data, projectId, responseId: view.responseId, captureIssuanceEpoch, clarificationId: clarification?.id });
      const event = await tx.auditEvent.findUniqueOrThrow({ where: { id }, select: { occurredAt: true } });
      if (event.occurredAt >= new Date(view.expiresAt)) throw new ProjectUpdateError("DENIED");
      return atlasDelayAssessmentSchema.parse({ ...parsed.data, id, confirmedBy: current.subject, confirmedAt: iso(event.occurredAt) });
    }, "ReadCommitted");
  }

  private atlasLeadershipActor(actorValue: Actor): Actor {
    const actor = parseActor(actorValue);
    if (!actor.roles.includes("leadership")) throw new ProjectUpdateError("DENIED");
    return { ...actor, roles: ["leadership"] };
  }

  private findDelayClarification(tx: Tx, customerId: string, projectId: string, pm: string,
    scheduleRevision: number, event: string, issuanceEpoch?: string) {
    return tx.auditEvent.findFirst({
      where: { customerId, event, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["scheduleRevision"], equals: scheduleRevision } },
        { detail: { path: ["recipient"], equals: pm } },
        ...(issuanceEpoch ? [{ detail: { path: ["captureIssuanceEpoch"], equals: issuanceEpoch } }] : []),
      ] }, select: { id: true, occurredAt: true },
    });
  }

  private async atlasDelayClarificationState(tx: Tx, current: Actor, projectId: string, schedule: AtlasSchedule, audience: "pm" | "leadership") {
    const configuration = this.captureConfiguration(current.customerId);
    if (!configuration || !await this.captureGate(tx, current.customerId, configuration)) return null;
    const pm = (await this.loadPolicy(tx, current.customerId, projectId))?.escalationRecipientSubject;
    if (!pm || (audience === "pm" && pm !== current.subject) ||
        !await this.recipientAuthorized(tx, current.customerId, projectId, pm, "PROJECT_MANAGER"))
      return null;
    const saved = await this.findDelayClarification(tx, current.customerId, projectId, pm, schedule.revision,
      atlasDelayClarificationEvent, configuration.issuanceEpoch);
    const closed = saved && await tx.auditEvent.findFirst({
      where: { customerId: current.customerId, actor: pm, event: atlasDelayConfirmedEvent,
        detail: { path: ["clarificationId"], equals: saved.id } },
      select: { id: true },
    });
    return { pm, schedule, closed: Boolean(closed), clarification: saved
      ? atlasDelayClarificationSchema.parse({ id: saved.id, requestedAt: iso(saved.occurredAt), schedule }) : null };
  }

  private async pendingAtlasDelayClarification(tx: Tx, current: Actor, projectId: string, audience: "pm" | "leadership") {
    const approved = await this.loadAtlasApproval(tx, current, projectId, audience);
    const schedule = (await this.currentAtlasSchedule(tx, current, projectId))?.schedule;
    if (!schedule || (schedule.movementDays ?? 0) <= 0) return null;
    if (approved?.view.receipt && (await this.atlasDelayReview(tx, current.customerId, projectId,
      approved.view, approved.captureIssuanceEpoch, schedule))?.assessment) return null;
    const state = await this.atlasDelayClarificationState(tx, current, projectId, schedule, audience);
    return state?.closed ? null : state;
  }

  async atlasDelayClarification(actorValue: Actor, projectValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    return this.transaction(async (tx) => (await this.pendingAtlasDelayClarification(tx, current, projectId, "pm"))?.clarification ?? null,
      "ReadCommitted");
  }

  async requestAtlasDelayClarification(actorValue: Actor, projectValue: string, command: unknown, correlationValue: string) {
    const current = this.atlasLeadershipActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = atlasDelayClarificationCommandSchema.safeParse(command);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      const pending = await this.pendingAtlasDelayClarification(tx, current, projectId, "leadership");
      if (!pending || pending.schedule.revision !== parsed.data.scheduleRevision)
        throw new ProjectUpdateError("CONFLICT");
      if (pending.clarification) return pending.clarification;
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasDelayClarificationEvent, {
        projectId, scheduleRevision: pending.schedule.revision, recipient: pending.pm,
      });
      const { occurredAt } = await tx.auditEvent.findUniqueOrThrow({ where: { id }, select: { occurredAt: true } });
      return atlasDelayClarificationSchema.parse({ id, requestedAt: iso(occurredAt), schedule: pending.schedule });
    }, "ReadCommitted");
  }

  private async loadAtlasLeadershipAnswer(tx: Tx, current: Actor, projectId: string) {
    const approved = await this.loadAtlasApproval(tx, current, projectId, "leadership");
    const reviewed = await this.currentAtlasSchedule(tx, current, projectId);
    const schedule = reviewed?.schedule ?? null;
    const view = approved?.view;
    const delayReview = approved && await this.atlasDelayReview(tx, current.customerId, projectId,
      approved.view, approved.captureIssuanceEpoch, schedule);
    const asOf = await this.now(tx);
    if (view && asOf >= new Date(view.expiresAt)) throw new ProjectUpdateError("DENIED");
    if (reviewed?.citation && reviewed.citation.availableUntil <= iso(asOf)) throw new ProjectUpdateError("DENIED");
    const answer = atlasLeadershipFactsSchema.parse({
      projectId, asOf: iso(asOf),
      schedule,
      ...(reviewed?.citation && { scheduleCitation: reviewed.citation }),
      ownerReply: view ? { responseId: view.responseId, receivedAt: view.replyReceivedAt, availableUntil: view.expiresAt,
        accessStatus: view.accessStatus } : null,
      receipt: view?.receipt ?? null,
      delayAssessment: delayReview?.assessment ?? null,
    });
    return { answer, locator: approved?.locator, approver: view?.approver, approved };
  }

  private async atlasPmEscalation(tx: Tx, current: Actor, projectId: string, origin: {
    stageId: string; capturedAt: Date; captureIssuanceEpoch: string; view: Pick<AtlasApprovalView, "approver">;
  }) {
    const [invitation] = await tx.$queryRaw<{ locator: string }[]>`
      SELECT i.locator FROM public."ProjectUpdateStage" origin
      JOIN public."ProjectUpdateStage" s ON s."customerId"=origin."customerId" AND s."projectId"=origin."projectId"
        AND s."engagementId"=origin."engagementId" AND s.generation=origin.generation
        AND s."policyRevisionId"=origin."policyRevisionId"
      JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=s."customerId"
        AND r."projectId"=s."projectId" AND r."stageId"=s.id
      JOIN public."ProjectUpdateInvitation" i ON i."customerId"=r."customerId"
        AND i."projectId"=r."projectId" AND i."requestId"=r.id AND i."issuanceEpoch"=r."issuanceEpoch"
      WHERE origin."customerId"=${current.customerId}::uuid AND origin."projectId"=${projectId}::uuid
        AND origin.id=${origin.stageId}::uuid AND s.kind='ESCALATION' AND s."recipientRole"='PROJECT_MANAGER'
        AND s."recipientSubject"=${origin.view.approver} AND r."issuanceEpoch"=${origin.captureIssuanceEpoch}::uuid
        AND r."capturedAt">=${origin.capturedAt}
      ORDER BY r."capturedAt" DESC,r.id DESC LIMIT 1`;
    if (!invitation) return null;
    try {
      const { row, asOf } = await this.authorizedInvitation(tx, current, invitation.locator, "leadership-escalation");
      if (row.capturedAt > asOf) return null;
      return { requestId: row.requestId, capturedAt: iso(row.capturedAt),
        availableUntil: new Date(Math.min(row.expiresAt.getTime(), row.purgeAfter.getTime())).toISOString() };
    } catch (error) {
      if (error instanceof ProjectUpdateError && error.code === "DENIED") return null;
      throw error;
    }
  }

  private async atlasJiraBlocker(tx: Tx, current: Actor, projectId: string, asOf: Date) {
    const scope = { customerId: current.customerId, projectId };
    const mapping = await tx.canonicalSourceMapping.findFirst({
      where: { ...scope, sourceSystem: "Jira", instanceKey: "atlas-demo", externalType: "issue",
        externalId: atlasJiraBlockerKey, targetType: "RAID_ITEM",
        raidItem: { key: atlasJiraBlockerKey, kind: "ISSUE", state: "OPEN" } },
      select: { id: true, externalRevision: true, url: true },
    });
    if (!mapping?.externalRevision || !mapping.url) return null;
    const binding = await tx.canonicalStateBinding.findFirst({
      where: { ...scope, targetKind: "WORK_ITEM", field: "state", sealed: true,
        workItem: { key: atlasJiraBlockerKey } },
      select: { fact: { select: { id: true, factType: true, revision: true } } },
    });
    if (!binding) return null;
    const { result } = await this.authority.prepareAssessmentInTransaction(tx, current, {
      projectId, fact: binding.fact, asOf, allowSourceObservations: true,
    });
    if (result.status !== "RESOLVED" || result.resolvedValue?.type !== "text" || result.resolvedValue.value !== "OPEN" ||
        result.supportingVersionIds.length !== 1) return null;
    const support = result.versions.find((version) => version.id === result.supportingVersionIds[0]);
    if (support?.visibility !== "available" || support.provenance !== "SYSTEM_VERIFIED" ||
        support.source.recordType !== "jira.issue" || support.assessment.freshness !== "CURRENT") return null;
    const matches = await tx.$queryRaw<{ matched: boolean }[]>`
      SELECT true AS matched FROM public."IngestionFactStream" stream
      JOIN public."IngestionExternalRecord" record ON
        (record."customerId",record."sourceId",record.id)=(stream."customerId",stream."sourceId",stream."recordId")
      JOIN public."IngestionSourceRevision" revision ON
        (revision."customerId",revision."sourceId",revision."recordId")=(record."customerId",record."sourceId",record.id)
      JOIN public."IngestionSource" source ON
        (source."customerId",source.id)=(record."customerId",record."sourceId")
      WHERE stream."customerId"=${scope.customerId}::uuid AND stream.id=${support.source.recordId}::uuid
        AND stream."factType"='jira.status' AND record."projectId"=${projectId}::uuid
        AND record."recordType"='jira.issue' AND record."recordKey"=${atlasJiraBlockerKey}
        AND revision.id=${support.source.revision}::uuid AND revision.revision=${mapping.externalRevision}
        AND source."sourceType"='jira' AND source.origin || '/browse/' || record."recordKey"=${mapping.url}`;
    return matches.length === 1 ? { mappingId: mapping.id, issueKey: atlasJiraBlockerKey } : null;
  }

  private async atlasActiveClarification(tx: Tx, current: Actor, projectId: string, obligationId: string) {
    const [invitation] = await tx.$queryRaw<{ locator: string }[]>`
      SELECT i.locator FROM public."ProjectUpdateEngagement" e
      JOIN public."ProjectUpdateStage" s ON (s."customerId",s."projectId",s."engagementId",s.generation)=
        (e."customerId",e."projectId",e.id,e.generation)
      JOIN public."ProjectUpdateCapturedRequest" r ON (r."customerId",r."projectId",r."stageId")=
        (s."customerId",s."projectId",s.id)
      JOIN public."ProjectUpdateInvitation" i ON (i."customerId",i."projectId",i."requestId")=
        (r."customerId",r."projectId",r.id)
      WHERE (e."customerId",e."projectId",e."obligationId")=
        (${current.customerId}::uuid,${projectId}::uuid,${obligationId}::uuid)
        AND e.state='ACTIVE' AND s.kind='REQUEST' AND s."recipientRole"='OWNER'
      ORDER BY r."capturedAt" DESC,r.id DESC LIMIT 1`;
    if (!invitation) return undefined;
    const capture = await this.authorizedInvitation(tx, current, invitation.locator, "leadership").catch((error: unknown) => {
      if (error instanceof ProjectUpdateError && error.code === "DENIED") return null;
      throw error;
    });
    if (!capture) return undefined;
    const { row, asOf } = capture;
    const latest = await this.latestRetainedReply(tx, current.customerId, projectId, row.requestId, asOf);
    if (!latest || latest.submittedBy !== row.recipientSubject) return undefined;
    const required = policyFacts(row.requiredFacts);
    const availableUntil = iso(new Date(Math.min(row.expiresAt.getTime(), row.purgeAfter.getTime(), latest.purgeAfter.getTime())));
    const due = await Promise.all(capturedFactTypes.filter((type) => required.some(({ factType }) => factType === type))
      .map(async (factType) => {
        const clarification = await this.capturedClarification(tx, current.customerId, projectId, row.requestId,
          latest.id, row.issuanceEpoch, factType);
        return clarification && { factType, clarificationId: clarification.clarificationId,
          requestedAt: clarification.requestedAt, availableUntil };
      }));
    return due.filter((entry) => entry !== null).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  }

  private async currentProjectFreshness(tx: Tx, current: Actor, projectId: string) {
    const policy = await this.loadObservationPolicy(tx, current.customerId, projectId);
    if (!policy) return null;
    const row = await this.latestAssessmentRow(tx, current, projectId, policy.policyRevisionId);
    if (!row) return null;
    const freshness = await this.readableUpdateFreshness(tx, current, projectId, row);
    return freshness ? { assessmentId: row.id, obligationId: row.obligationId,
      freshness: { ...freshness, openObligation: row.obligationState === "OPEN" } } : null;
  }

  private async readableUpdateFreshness(tx: Tx, current: Actor, projectId: string,
    row: Pick<AssessmentRow, "result" | "assessedAt" | "dependencies" | "requiredFacts">) {
    const stored = safeObject.safeParse(jsonValue(row.result));
    const freshness = projectUpdateAssessmentViewSchema.shape.freshness.safeParse(stored.data?.freshness);
    if (!freshness.success || freshness.data.assessedAt !== iso(row.assessedAt)) return null;
    const { state, assessedAt, sourceDate, sourceDateField } = freshness.data;
    if (sourceDateField === "project.latestValidUpdateAt") {
      const dependencies = z.array(projectUpdateFactReferenceSchema).min(1).max(1000).safeParse(jsonValue(row.dependencies));
      if (!dependencies.success || (await this.resolveKnownPosition(tx, current, projectId, dependencies.data, row.requiredFacts)).length !== dependencies.data.length)
        return null;
    }
    return { state, assessedAt, sourceDate, sourceDateField };
  }

  private async atlasUpdateFreshness(tx: Tx, current: Actor, projectId: string) {
    const observed = await this.currentProjectFreshness(tx, current, projectId);
    if (!observed) return null;
    const { freshness, obligationId } = observed;
    const activeClarification = freshness.state === "STALE" && freshness.openObligation && obligationId
      ? await this.atlasActiveClarification(tx, current, projectId, obligationId) : undefined;
    return { ...freshness, activeClarification };
  }

  private async currentProjectLeadershipFacts(tx: Tx, current: Actor, projectId: string) {
    const schedule = await this.canonicalProjectSchedule(tx, current.customerId, projectId);
    const observed = await this.currentProjectFreshness(tx, current, projectId);
    return { projectId, asOf: iso(await this.now(tx)), schedule,
      updateFreshness: observed ? { assessmentId: observed.assessmentId, ...observed.freshness } : null };
  }

  async projectLeadershipAnswer(actorValue: Actor, projectValue: string, question: unknown) {
    const projectId = parseProjectId(projectValue);
    const parsed = projectLeadershipQuestionSchema.safeParse(question);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    const { priorSnapshotId } = parsed.data;
    const compare = priorSnapshotId !== undefined && isProjectSnapshotComparisonQuestion(parsed.data.question);
    const current = compare ? this.reportingActor(actorValue, "leadership") : parseActor(actorValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, current, projectId, false);
      if (compare) {
        const saved = await this.readableProjectReport(tx, current, projectId, current.subject, priorSnapshotId.toLowerCase());
        const facts = await this.currentProjectLeadershipFacts(tx, current, projectId);
        const { asOf, schedule, updateFreshness } = saved.draft;
        if (asOf > facts.asOf) throw new ProjectUpdateError("DENIED");
        return projectLeadershipAnswerSchema.parse({ ...facts, state: "COMPARISON",
          priorSnapshot: { id: saved.snapshotId, asOf, schedule, updateFreshness } });
      }
      if (priorSnapshotId || !isCurrentProjectScheduleQuestion(parsed.data.question))
        return projectLeadershipAnswerSchema.parse({ state: "CLARIFY" });
      const facts = await this.currentProjectLeadershipFacts(tx, current, projectId);
      const delayedSchedule = facts.schedule && (facts.schedule.movementDays ?? 0) > 0 ? facts.schedule : null;
      const delayCause = delayedSchedule &&
        await this.confirmedProjectDelayCause(tx, current, projectId, delayedSchedule, new Date(facts.asOf));
      if (delayCause) return projectLeadershipAnswerSchema.parse({ ...facts, state: "ANSWERED", cause: "HUMAN_CONFIRMED", delayCause });
      const pendingDelayClarification = delayedSchedule && current.roles.includes("leadership")
        ? await this.openProjectDelayRequest(tx, current, projectId, delayedSchedule, facts.asOf) : null;
      return projectLeadershipAnswerSchema.parse({ ...facts, state: "ANSWERED", cause: "UNKNOWN",
        ...(pendingDelayClarification && { pendingDelayClarification }) });
    }, "ReadCommitted");
  }

  private async openProjectDelayRequest(tx: Tx, actor: Actor, projectId: string, schedule: AtlasSchedule, asOf: string) {
    const leader = this.reportingActor(actor, "leadership");
    try {
      await this.authorize(tx, leader, projectId, false);
      await this.authorizeProjectDelayWorkflow(tx, leader.customerId, projectId);
    } catch (error) {
      if (error instanceof ProjectUpdateError && error.code === "DENIED") return null;
      throw error;
    }
    const manager = await this.assignedProjectManager(tx, leader.customerId, projectId);
    if (!manager || manager === leader.subject) return null;
    const saved = await this.findDelayClarification(tx, leader.customerId, projectId, manager, schedule.revision, projectDelayClarificationEvent);
    if (!saved || iso(saved.occurredAt) > asOf) return null;
    return projectDelayClarificationSchema.parse({ id: saved.id, requestedAt: iso(saved.occurredAt), schedule });
  }

  async projectDelayClarification(actorValue: Actor, projectValue: string) {
    const manager = this.reportingActor(actorValue, "project_manager");
    const projectId = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      await this.authorizeProjectDelayManager(tx, manager, projectId);
      return this.projectDelayReview(tx, manager, projectId);
    }, "ReadCommitted");
  }

  private async authorizeProjectDelayManager(tx: Tx, manager: Actor, projectId: string) {
    await this.authorize(tx, manager, projectId, false);
    await this.authorizeProjectDelayWorkflow(tx, manager.customerId, projectId);
    if (await this.assignedProjectManager(tx, manager.customerId, projectId) !== manager.subject)
      throw new ProjectUpdateError("DENIED");
  }

  private async projectDelayReview(tx: Tx, manager: Actor, projectId: string) {
    const schedule = await this.canonicalProjectSchedule(tx, manager.customerId, projectId);
    if (!schedule || (schedule.movementDays ?? 0) <= 0) return null;
    const saved = await this.findDelayClarification(tx, manager.customerId, projectId, manager.subject, schedule.revision,
      projectDelayClarificationEvent);
    if (!saved) return null;
    const causeEvidence = await this.currentProjectDelayCauseEvidence(tx, manager, projectId, await this.now(tx));
    const confirmation = causeEvidence && await this.projectDelayCauseConfirmation(tx, manager.customerId, projectId,
      manager.subject, saved.id, causeEvidence.versionId);
    return projectDelayClarificationReviewSchema.parse({ id: saved.id, requestedAt: iso(saved.occurredAt), schedule,
      causeEvidence, confirmation });
  }

  private async currentProjectDelayCauseEvidence(tx: Tx, viewer: Actor, projectId: string, asOf: Date) {
    const fact = await tx.projectFact.findUnique({ where: { customerId_projectId_factType: {
      customerId: viewer.customerId, projectId, factType: projectDelayCauseFactType,
    } }, select: { id: true, factType: true, revision: true } });
    if (!fact) return null;
    const { result } = await this.authority.prepareAssessmentInTransaction(tx, viewer, { projectId, fact, asOf });
    if (result.status !== "RESOLVED" || result.revalidationRequired || result.conflict !== "NONE" ||
        result.resolvedValue?.type !== "text" || result.supportingVersionIds.length !== 1 || result.supportingEvidenceIds.length !== 1)
      return null;
    const source = result.versions.find((version) => version.id === result.supportingVersionIds[0]);
    if (source?.visibility !== "available" || source.provenance !== "HUMAN_CONFIRMED" || source.assessment.freshness !== "CURRENT")
      return null;
    const evidence = projectDelayCauseEvidenceSchema.safeParse({ factId: fact.id, versionId: source.id,
      evidenceId: result.supportingEvidenceIds[0], observedAt: source.observedAt, value: result.resolvedValue.value });
    return evidence.success ? evidence.data : null;
  }

  private async projectDelayCauseConfirmation(tx: Tx, customerId: string, projectId: string, manager: string,
    clarificationId: string, versionId: string) {
    const recorded = await tx.auditEvent.findFirst({ where: { customerId, actor: manager, event: projectDelayCauseConfirmedEvent, AND: [
      { detail: { path: ["projectId"], equals: projectId } },
      { detail: { path: ["clarificationId"], equals: clarificationId } },
      { detail: { path: ["versionId"], equals: versionId } },
    ] }, select: { id: true, occurredAt: true } });
    return recorded ? projectDelayCauseConfirmationSchema.parse({ id: recorded.id, clarificationId, versionId,
      confirmedAt: iso(recorded.occurredAt) }) : null;
  }

  private async confirmedProjectDelayCause(tx: Tx, viewer: Actor, projectId: string, schedule: AtlasSchedule, asOf: Date) {
    const evidence = await this.currentProjectDelayCauseEvidence(tx, viewer, projectId, asOf);
    if (!evidence) return null;
    const manager = await this.assignedProjectManager(tx, viewer.customerId, projectId);
    if (!manager) return null;
    const saved = await this.findDelayClarification(tx, viewer.customerId, projectId, manager, schedule.revision, projectDelayClarificationEvent);
    const confirmation = saved && await this.projectDelayCauseConfirmation(tx, viewer.customerId, projectId, manager, saved.id, evidence.versionId);
    return confirmation && confirmation.confirmedAt <= iso(asOf) ? { evidence, confirmation } : null;
  }

  async confirmProjectDelayCause(actorValue: Actor, projectValue: string, command: unknown, correlationValue: string) {
    const manager = this.reportingActor(actorValue, "project_manager");
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = projectDelayCauseCommandSchema.safeParse(command);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      await this.authorizeProjectDelayManager(tx, manager, projectId);
      await this.lockProjectCommand(tx, "project-delay-clarification", [manager.customerId, projectId]);
      const review = await this.projectDelayReview(tx, manager, projectId);
      if (review?.id !== parsed.data.clarificationId || review.causeEvidence?.versionId !== parsed.data.versionId)
        throw new ProjectUpdateError("CONFLICT");
      if (review.confirmation) return review.confirmation;
      const now = await this.now(tx);
      const { id } = await this.recordProjectAuditEvent(tx, manager, projectDelayCauseConfirmedEvent, correlationId,
        { projectId, ...parsed.data }, now);
      return projectDelayCauseConfirmationSchema.parse({ id, ...parsed.data, confirmedAt: iso(now) });
    }, "ReadCommitted");
  }

  async requestProjectDelayClarification(actorValue: Actor, projectValue: string, command: unknown, correlationValue: string) {
    const leader = this.reportingActor(actorValue, "leadership");
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = projectDelayClarificationCommandSchema.safeParse(command);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      await this.authorize(tx, leader, projectId, false);
      await this.authorizeProjectDelayWorkflow(tx, leader.customerId, projectId);
      const schedule = await this.canonicalProjectSchedule(tx, leader.customerId, projectId);
      const recipient = await this.assignedProjectManager(tx, leader.customerId, projectId);
      if (!schedule || schedule.revision !== parsed.data.scheduleRevision || (schedule.movementDays ?? 0) <= 0 ||
          !recipient || recipient === leader.subject) throw new ProjectUpdateError("CONFLICT");
      await this.lockProjectCommand(tx, "project-delay-clarification", [leader.customerId, projectId]);
      const existing = await this.findDelayClarification(tx, leader.customerId, projectId, recipient, schedule.revision,
        projectDelayClarificationEvent);
      if (existing) return projectDelayClarificationSchema.parse({ id: existing.id, requestedAt: iso(existing.occurredAt), schedule });
      const now = await this.now(tx);
      const { id } = await this.recordProjectAuditEvent(tx, leader, projectDelayClarificationEvent, correlationId,
        { projectId, recipient, scheduleRevision: schedule.revision }, now);
      return projectDelayClarificationSchema.parse({ id, requestedAt: iso(now), schedule });
    }, "ReadCommitted");
  }

  private async authorizeProjectDelayWorkflow(tx: Tx, customerId: string, projectId: string) {
    if (this.atlasDemoEnabled && await tx.project.findFirst({
      where: { id: projectId, customerId, code: atlasApprovalProjectCode }, select: { id: true },
    })) throw new ProjectUpdateError("DENIED");
  }

  private async assignedProjectManager(tx: Tx, customerId: string, projectId: string) {
    const assigned = await tx.projectResponsibility.findMany({ where: { customerId, projectId, role: "PROJECT_MANAGER" },
      select: { subject: true }, take: 2 });
    const subject = assigned[0]?.subject;
    return assigned.length === 1 && subject && await this.recipientAuthorized(tx, customerId, projectId, subject, "PROJECT_MANAGER")
      ? subject : null;
  }

  private reportingActor(actorValue: Actor, role: "leadership" | "project_manager"): Actor {
    const current = parseActor(actorValue);
    if (!current.roles.includes(role)) throw new ProjectUpdateError("DENIED");
    return { ...current, roles: [role] };
  }

  private async currentProjectManagementDraft(tx: Tx, leader: Actor, projectId: string) {
    const project = await tx.project.findFirstOrThrow({
      where: { id: projectId, customerId: leader.customerId },
      select: { code: true, name: true },
    });
    const facts = await this.currentProjectLeadershipFacts(tx, leader, projectId);
    const prior = await this.latestDeliveredProjectReport(tx, leader, projectId, new Date(facts.asOf)).catch((error: unknown) => {
      if (error instanceof ProjectUpdateError && error.code === "DENIED") return null;
      throw error;
    });
    const previousReport = prior && prior.draft.asOf <= facts.asOf ? this.reportComparisonFacts(prior) : null;
    const decisions = await tx.raidItem.findMany({
      where: { customerId: leader.customerId, projectId, kind: "DECISION", state: { in: ["OPEN", "IN_PROGRESS"] },
        project: { sealed: true } },
      orderBy: { key: "asc" }, select: { key: true, title: true }, take: 4,
    });
    const visibleDecisions = decisions.slice(0, 3).map(({ key, title }) => ({
      key, title: title.replace(/[\p{Cc}\p{Surrogate}]/gu, " ").trim() || "Title unavailable",
    }));
    return projectManagementDraftSchema.parse({ ...facts, project,
      approvalState: "DRAFT", reportingPeriod: facts.asOf.slice(0, 7),
      digest: { previousReport, decisions: visibleDecisions, moreDecisions: decisions.length > 3 } });
  }

  private reportComparisonFacts({ snapshotId, draft }: ProjectManagementSnapshot) {
    return { snapshotId, asOf: draft.asOf, schedule: draft.schedule, freshnessState: draft.updateFreshness?.state ?? null };
  }

  async projectManagementDraft(actorValue: Actor, projectValue: string) {
    const leader = this.reportingActor(actorValue, "leadership");
    const projectId = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, leader, projectId, false);
      return this.currentProjectManagementDraft(tx, leader, projectId);
    }, "ReadCommitted");
  }

  private async savedProjectManagementSnapshot(tx: Tx, customerId: string, projectId: string, author: string, snapshotId?: string) {
    const saved = await tx.auditEvent.findFirst({
      where: { customerId, actor: author, event: projectReportSavedEvent,
        ...(snapshotId && { id: snapshotId }), detail: { path: ["projectId"], equals: projectId } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true, detail: true, occurredAt: true },
    });
    if (!saved) return null;
    const { projectId: savedProjectId, draft } = savedProjectReportDetail.parse(saved.detail);
    if (savedProjectId !== projectId || draft.projectId !== projectId || draft.asOf !== iso(saved.occurredAt))
      throw new ProjectUpdateError("UNAVAILABLE");
    return projectManagementSnapshotSchema.parse({ snapshotId: saved.id, draft });
  }

  private async authorizeSavedReportFreshness(tx: Tx, leader: Actor,
    projectId: string, saved: NonNullable<ProjectManagementDraft["updateFreshness"]>) {
    const [row] = await tx.$queryRaw<Pick<AssessmentRow, "result" | "assessedAt" | "dependencies" | "requiredFacts">[]>`
      SELECT a.result,a."assessedAt",a.dependencies,r."requiredFacts"
      FROM public."ProjectUpdateAssessment" a
      JOIN public."ProjectUpdatePolicyRevision" r ON (r."customerId",r."projectId",r.id)=
        (a."customerId",a."projectId",a."policyRevisionId")
      WHERE a."customerId"=${leader.customerId}::uuid AND a."projectId"=${projectId}::uuid AND a.id=${saved.assessmentId}::uuid`;
    const readable = row && await this.readableUpdateFreshness(tx, leader, projectId, row);
    if (!readable || readable.assessedAt !== saved.assessedAt || readable.state !== saved.state ||
        readable.sourceDate !== saved.sourceDate || readable.sourceDateField !== saved.sourceDateField)
      throw new ProjectUpdateError("DENIED");
  }

  private async authorizeSavedReportInputs(tx: Tx, current: Actor, author: string, draft: ProjectManagementDraft) {
    const { projectId, updateFreshness, digest } = draft;
    if (updateFreshness) await this.authorizeSavedReportFreshness(tx, current, projectId, updateFreshness);
    const comparison = digest?.previousReport;
    if (comparison) {
      const previous = await this.savedProjectManagementSnapshot(tx, current.customerId, projectId, author, comparison.snapshotId);
      if (!previous || hash(this.reportComparisonFacts(previous)) !== hash(comparison)) throw new ProjectUpdateError("DENIED");
      if (previous.draft.updateFreshness)
        await this.authorizeSavedReportFreshness(tx, current, projectId, previous.draft.updateFreshness);
    }
  }

  private async readableProjectReport(tx: Tx, current: Actor, projectId: string, author: string, snapshotId?: string) {
    const saved = await this.savedProjectManagementSnapshot(tx, current.customerId, projectId, author, snapshotId);
    if (!saved) throw new ProjectUpdateError("DENIED");
    await this.authorizeSavedReportInputs(tx, current, author, saved.draft);
    return saved;
  }

  private async projectReportSubmission(tx: Tx, customerId: string, projectId: string,
    selector: { snapshotId?: string; approver?: string }): Promise<ProjectReportSubmission | null> {
    const filters: Prisma.AuditEventWhereInput[] = [{ detail: { path: ["projectId"], equals: projectId } }];
    if (selector.snapshotId) filters.push({ detail: { path: ["snapshotId"], equals: selector.snapshotId } });
    if (selector.approver) filters.push({ detail: { path: ["approver"], equals: selector.approver } });
    const saved = await tx.auditEvent.findFirst({ where: { customerId, event: projectReportRequestedEvent, AND: filters },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true, detail: true, actor: true, occurredAt: true } });
    return saved ? this.reportSubmissionFromRow(saved) : null;
  }

  private reportSubmissionFromRow(saved: ProjectReportRequestRow): ProjectReportSubmission {
    return { ...storedProjectReportRequest.parse(saved.detail), requestId: saved.id, author: saved.actor, requestedAt: iso(saved.occurredAt) };
  }

  private async projectReportQueue(tx: Tx, manager: Actor, projectId: string, pendingOnly = false) {
    const saved = await tx.$queryRaw<ProjectReportRequestRow[]>`
      SELECT r.id,r.detail,r.actor,r."occurredAt"
      FROM public."AuditEvent" r
      LEFT JOIN LATERAL (
        SELECT d."occurredAt" AS "decidedAt",d.detail->>'decision' AS decision FROM public."AuditEvent" d
        WHERE d."customerId"=r."customerId" AND d.event=${projectReportDecidedEvent}
          AND d.actor=${manager.subject} AND d.detail->>'requestId'=r.id::text
        ORDER BY d."occurredAt" DESC,d.id DESC LIMIT 1
      ) d ON true
      LEFT JOIN LATERAL (
        SELECT e."occurredAt" AS "deliveredAt" FROM public."AuditEvent" e
        WHERE e."customerId"=r."customerId" AND e.event=${projectReportDeliveredEvent}
          AND e.actor=${manager.subject} AND e.detail->>'requestId'=r.id::text
        ORDER BY e."occurredAt" DESC,e.id DESC LIMIT 1
      ) e ON true
      WHERE r."customerId"=${manager.customerId}::uuid AND r.event=${projectReportRequestedEvent}
        AND r.detail->>'projectId'=${projectId} AND r.detail->>'approver'=${manager.subject}
        AND (NOT ${pendingOnly}::boolean OR d."decidedAt" IS NULL)
      ORDER BY CASE WHEN d."decidedAt" IS NULL THEN 0 WHEN d.decision='APPROVED' AND e."deliveredAt" IS NULL THEN 1 ELSE 2 END,
        COALESCE(e."deliveredAt",d."decidedAt",r."occurredAt") DESC,r.id DESC`;
    return saved.map((row) => this.reportSubmissionFromRow(row));
  }

  private async projectReportDecisionState(tx: Tx, customerId: string,
    request: ProjectReportSubmission): Promise<ProjectReportApprovalRecord> {
    const saved = await tx.auditEvent.findFirst({
      where: { customerId, actor: request.approver, event: projectReportDecidedEvent,
        detail: { path: ["requestId"], equals: request.requestId } },
      select: { id: true, detail: true, occurredAt: true },
    });
    const base = { requestId: request.requestId, requestedAt: request.requestedAt };
    if (!saved) return { approval: { ...base, state: "PENDING", decidedAt: null }, decisionId: null };
    const { projectId, snapshotId, decision } = storedProjectReportDecision.parse(saved.detail);
    const decidedAt = iso(saved.occurredAt);
    if (projectId !== request.projectId || snapshotId !== request.snapshotId || decidedAt < request.requestedAt)
      throw new ProjectUpdateError("UNAVAILABLE");
    return { approval: projectReportApprovalSchema.parse({ ...base, state: decision, decidedAt }), decisionId: saved.id };
  }

  private async projectReportView(tx: Tx, customerId: string, saved: ProjectManagementSnapshot,
    request: ProjectReportSubmission, known?: ProjectReportApprovalRecord) {
    const { approval, decisionId } = known ?? await this.projectReportDecisionState(tx, customerId, request);
    if (approval.state !== "APPROVED" || !decisionId) return { ...saved, approval };
    const prior = await tx.auditEvent.findFirst({
      where: { customerId, actor: request.approver, event: projectReportDeliveredEvent,
        detail: { path: ["requestId"], equals: request.requestId } },
      select: { id: true, detail: true, occurredAt: true },
    });
    if (!prior) return { ...saved, approval };
    const detail = storedProjectReportDelivery.parse(prior.detail);
    const deliveredAt = iso(prior.occurredAt);
    if (detail.snapshotId !== saved.snapshotId || detail.projectId !== saved.draft.projectId ||
        detail.decisionId !== decisionId || detail.recipient !== request.author || deliveredAt < approval.decidedAt)
      throw new ProjectUpdateError("UNAVAILABLE");
    const delivery = projectReportDeliverySchema.parse({ id: prior.id, deliveredAt,
      snapshotId: saved.snapshotId, requestId: request.requestId });
    return { ...saved, approval, delivery };
  }

  private async projectReportWithApproval(tx: Tx, current: Actor, saved: ProjectManagementSnapshot) {
    const request = await this.projectReportSubmission(tx, current.customerId, saved.draft.projectId, { snapshotId: saved.snapshotId });
    if (!request) return saved;
    if (request.author !== current.subject || request.requestedAt < saved.draft.asOf) throw new ProjectUpdateError("UNAVAILABLE");
    return this.projectReportView(tx, current.customerId, saved, request);
  }

  private async lockProjectCommand(tx: Tx, namespace: "project-report" | "project-delay-clarification", identity: readonly string[]) {
    await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked",
      stringify([namespace, ...identity]));
  }

  private async recordProjectAuditEvent(tx: Tx, actor: Actor, event: string, correlationId: string,
    detail: Prisma.InputJsonObject, occurredAt: Date) {
    return tx.auditEvent.create({ data: { customerId: actor.customerId, actor: actor.subject,
      event, correlationId, detail, occurredAt }, select: { id: true } });
  }

  private async latestDeliveredProjectReport(tx: Tx, leader: Actor, projectId: string, asOf?: Date) {
    const receipts = await tx.auditEvent.findMany({
      where: { customerId: leader.customerId, event: projectReportDeliveredEvent,
        ...(asOf && { occurredAt: { lte: asOf } }),
        AND: [{ detail: { path: ["projectId"], equals: projectId } },
          { detail: { path: ["recipient"], equals: leader.subject } }] },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true, detail: true },
    });
    for (const receipt of receipts) {
      const { snapshotId } = storedProjectReportDelivery.parse(receipt.detail);
      try {
        const saved = await this.readableProjectReport(tx, leader, projectId, leader.subject, snapshotId);
        const report = await this.projectReportWithApproval(tx, leader, saved);
        if (report.delivery?.id !== receipt.id) throw new ProjectUpdateError("UNAVAILABLE");
        return report;
      } catch (error) {
        if (!(error instanceof ProjectUpdateError) || error.code !== "DENIED") throw error;
      }
    }
    throw new ProjectUpdateError("DENIED");
  }

  async projectManagementSnapshot(actorValue: Actor, projectValue: string, snapshotValue: string) {
    const leader = this.reportingActor(actorValue, "leadership");
    const projectId = parseProjectId(projectValue);
    const latestDelivery = snapshotValue === "delivered";
    const snapshotId = snapshotValue === "latest" || latestDelivery ? undefined : parseProjectId(snapshotValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, leader, projectId, false);
      if (latestDelivery) return this.latestDeliveredProjectReport(tx, leader, projectId);
      const saved = await this.readableProjectReport(tx, leader, projectId, leader.subject, snapshotId);
      return this.projectReportWithApproval(tx, leader, saved);
    }, "ReadCommitted");
  }

  async saveProjectManagementSnapshot(actorValue: Actor, projectValue: string, expected: ProjectManagementDraft, correlationValue: string) {
    const leader = this.reportingActor(actorValue, "leadership");
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, leader, projectId, false);
      await this.lockProjectCommand(tx, "project-report", [leader.customerId, projectId, leader.subject]);
      const current = await this.currentProjectManagementDraft(tx, leader, projectId);
      const { digest, ...legacyDraft } = current;
      const draft = expected.digest === undefined ? legacyDraft : { ...legacyDraft, digest };
      if (hash({ ...expected, asOf: draft.asOf }) !== hash(draft)) throw new ProjectUpdateError("CONFLICT");
      const previous = await this.savedProjectManagementSnapshot(tx, leader.customerId, projectId, leader.subject);
      if (previous && hash({ ...previous.draft, asOf: draft.asOf }) === hash(draft))
        return this.projectReportWithApproval(tx, leader, previous);
      const saved = await this.recordProjectAuditEvent(tx, leader, projectReportSavedEvent, correlationId,
        { projectId, draft }, new Date(draft.asOf));
      return projectManagementSnapshotSchema.parse({ snapshotId: saved.id, draft });
    }, "ReadCommitted");
  }

  async requestProjectReportApproval(actorValue: Actor, projectValue: string, snapshotValue: string, correlationValue: string) {
    const leader = this.reportingActor(actorValue, "leadership");
    const projectId = parseProjectId(projectValue), snapshotId = parseProjectId(snapshotValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      await this.authorize(tx, leader, projectId, false);
      await this.lockProjectCommand(tx, "project-report", ["approval", leader.customerId, projectId, snapshotId]);
      const snapshot = await this.readableProjectReport(tx, leader, projectId, leader.subject, snapshotId);
      const current = await this.projectReportWithApproval(tx, leader, snapshot);
      if (current.approval) return current;
      const approver = await this.assignedProjectManager(tx, leader.customerId, projectId);
      if (!approver || approver === leader.subject) throw new ProjectUpdateError("CONFLICT");
      await this.authorizeSavedReportInputs(tx, { ...leader, subject: approver, roles: ["project_manager"] }, leader.subject, snapshot.draft);
      const now = await this.now(tx), requestedAt = iso(now);
      if (requestedAt < snapshot.draft.asOf) throw new ProjectUpdateError("UNAVAILABLE");
      const { id } = await this.recordProjectAuditEvent(tx, leader, projectReportRequestedEvent, correlationId,
        { projectId, snapshotId, approver }, now);
      return { ...snapshot, approval: projectReportApprovalSchema.parse({ requestId: id, requestedAt, state: "PENDING", decidedAt: null }) };
    }, "ReadCommitted");
  }

  private async authorizeReportManager(tx: Tx, manager: Actor, projectId: string) {
    await this.authorize(tx, manager, projectId, false);
    if (!await this.recipientAuthorized(tx, manager.customerId, projectId, manager.subject, "PROJECT_MANAGER"))
      throw new ProjectUpdateError("DENIED");
  }

  async pendingProjectReportInTransaction(tx: Tx, actor: Actor, projectId: string, projectCode: string) {
    if (this.atlasDemoEnabled && projectCode === atlasApprovalProjectCode) return null;
    const manager = this.reportingActor(actor, "project_manager");
    await this.authorizeReportManager(tx, manager, projectId);
    for (const request of await this.projectReportQueue(tx, manager, projectId, true)) {
      try {
        const saved = await this.readableProjectReport(tx, manager, projectId, request.author, request.snapshotId);
        if (request.requestedAt < saved.draft.asOf) throw new ProjectUpdateError("UNAVAILABLE");
        const { approval } = await this.projectReportDecisionState(tx, manager.customerId, request);
        if (approval.state === "PENDING")
          return { snapshotId: saved.snapshotId, requestId: request.requestId, requestedAt: request.requestedAt };
      } catch (error) {
        if (!(error instanceof ProjectUpdateError) || error.code !== "DENIED") throw error;
      }
    }
    return null;
  }

  private async authorizeProjectReportRecipient(tx: Tx, manager: Actor, request: ProjectReportSubmission, draft: ProjectManagementDraft) {
    const recipient: Actor = { customerId: manager.customerId, subject: request.author, roles: ["leadership"] };
    await this.authorize(tx, recipient, draft.projectId, false);
    await this.authorizeSavedReportInputs(tx, recipient, request.author, draft);
    return recipient;
  }

  async projectReportForManager(actorValue: Actor, projectValue: string, snapshotValue?: string) {
    const manager = this.reportingActor(actorValue, "project_manager");
    const projectId = parseProjectId(projectValue), snapshotId = snapshotValue === undefined ? undefined : parseProjectId(snapshotValue);
    return this.transaction(async (tx) => {
      await this.authorizeReportManager(tx, manager, projectId);
      const exact = snapshotId
        ? await this.projectReportSubmission(tx, manager.customerId, projectId, { snapshotId, approver: manager.subject })
        : null;
      if (snapshotId && !exact) return null;
      const requests = exact ? [exact] : await this.projectReportQueue(tx, manager, projectId);
      for (const request of requests) {
        try {
          const saved = await this.readableProjectReport(tx, manager, projectId, request.author, request.snapshotId);
          if (request.requestedAt < saved.draft.asOf) throw new ProjectUpdateError("UNAVAILABLE");
          const report = await this.projectReportView(tx, manager.customerId, saved, request);
          if (!snapshotId && report.approval.state === "APPROVED" && !report.delivery)
            await this.authorizeProjectReportRecipient(tx, manager, request, saved.draft);
          return report;
        } catch (error) {
          if (snapshotId || !(error instanceof ProjectUpdateError) || error.code !== "DENIED") throw error;
        }
      }
      return null;
    }, "ReadCommitted");
  }

  async decideProjectReportApproval(actorValue: Actor, projectValue: string, decisionValue: ProjectReportDecision, correlationValue: string) {
    const manager = this.reportingActor(actorValue, "project_manager");
    const projectId = parseProjectId(projectValue), correlationId = parseCorrelation(correlationValue);
    const parsed = projectReportDecisionSchema.safeParse(decisionValue);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    const { snapshotId, requestId, decision } = parsed.data;
    return this.transaction(async (tx) => {
      await this.authorizeReportManager(tx, manager, projectId);
      await this.lockProjectCommand(tx, "project-report", ["approval", manager.customerId, projectId, snapshotId]);
      const request = await this.projectReportSubmission(tx, manager.customerId, projectId, { snapshotId, approver: manager.subject });
      if (!request || request.requestId !== requestId) throw new ProjectUpdateError("CONFLICT");
      const saved = await this.readableProjectReport(tx, manager, projectId, request.author, snapshotId);
      if (request.requestedAt < saved.draft.asOf) throw new ProjectUpdateError("UNAVAILABLE");
      const state = await this.projectReportDecisionState(tx, manager.customerId, request);
      const prior = state.approval;
      if (prior.state === decision) return this.projectReportView(tx, manager.customerId, saved, request, state);
      if (prior.state !== "PENDING") throw new ProjectUpdateError("CONFLICT");
      const now = await this.now(tx), decidedAt = iso(now);
      if (decidedAt < prior.requestedAt) throw new ProjectUpdateError("UNAVAILABLE");
      await this.recordProjectAuditEvent(tx, manager, projectReportDecidedEvent, correlationId, { projectId, ...parsed.data }, now);
      return { ...saved, approval: projectReportApprovalSchema.parse({ ...prior, state: decision, decidedAt }) };
    }, "ReadCommitted");
  }

  async deliverProjectReport(actorValue: Actor, projectValue: string, versionValue: ProjectReportVersion, correlationValue: string) {
    const manager = this.reportingActor(actorValue, "project_manager");
    const projectId = parseProjectId(projectValue), correlationId = parseCorrelation(correlationValue);
    const parsed = projectReportVersionSchema.safeParse(versionValue);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    const { snapshotId, requestId } = parsed.data;
    return this.transaction(async (tx) => {
      await this.authorizeReportManager(tx, manager, projectId);
      await this.lockProjectCommand(tx, "project-report", ["approval", manager.customerId, projectId, snapshotId]);
      const request = await this.projectReportSubmission(tx, manager.customerId, projectId, { snapshotId, approver: manager.subject });
      if (!request || request.requestId !== requestId) throw new ProjectUpdateError("CONFLICT");
      const saved = await this.readableProjectReport(tx, manager, projectId, request.author, snapshotId);
      if (request.requestedAt < saved.draft.asOf) throw new ProjectUpdateError("UNAVAILABLE");
      const state = await this.projectReportDecisionState(tx, manager.customerId, request);
      if (state.approval.state !== "APPROVED" || !state.decisionId) throw new ProjectUpdateError("CONFLICT");
      const recipient = await this.authorizeProjectReportRecipient(tx, manager, request, saved.draft);
      const report = await this.projectReportView(tx, manager.customerId, saved, request, state);
      if (report.delivery) return report;
      const now = await this.now(tx), deliveredAt = iso(now);
      if (deliveredAt < state.approval.decidedAt) throw new ProjectUpdateError("UNAVAILABLE");
      const { id } = await this.recordProjectAuditEvent(tx, manager, projectReportDeliveredEvent, correlationId,
        { projectId, snapshotId, requestId, decisionId: state.decisionId, recipient: recipient.subject }, now);
      return { ...report, delivery: projectReportDeliverySchema.parse({ id, deliveredAt, snapshotId, requestId }) };
    }, "ReadCommitted");
  }

  async atlasLeadershipAnswer(actorValue: Actor, projectValue: string, priorSnapshotId?: string) {
    const current = this.atlasLeadershipActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const priorId = priorSnapshotId === undefined ? undefined : parseProjectId(priorSnapshotId);
    return this.transaction(async (tx) => {
      const { answer, approved } = await this.loadAtlasLeadershipAnswer(tx, current, projectId);
      const scope = { customerId: current.customerId, projectId };
      const milestone = answer.schedule && await tx.milestone.findFirst({
        where: { ...scope, key: atlasIntegrationMilestoneKey },
        select: { id: true, plannedStart: true, actualStart: true },
      });
      const escalation = approved && await this.atlasPmEscalation(tx, current, projectId, approved);
      const prior = priorId ? await this.savedAtlasManagementSnapshot(tx, current.customerId, projectId, current.subject, priorId) : null;
      if (priorId && !prior) throw new ProjectUpdateError("DENIED");
      if (prior) await this.authorizeAtlasReportOrigin(tx, current, prior, "leadership");
      const updateFreshness = await this.atlasUpdateFreshness(tx, current, projectId);
      const clarification = !answer.delayAssessment && answer.schedule && (answer.schedule.movementDays ?? 0) > 0
        ? await this.atlasDelayClarificationState(tx, current, projectId, answer.schedule, "leadership") : null;
      const delayClarificationState = !clarification ? undefined
        : clarification.closed ? "RESOLVED" : clarification.clarification ? "REQUESTED" : "AVAILABLE";
      const assessedAt = await this.now(tx);
      const blocker = answer.schedule ? await this.atlasJiraBlocker(tx, current, projectId, assessedAt) : null;
      const asOf = iso(assessedAt);
      if (updateFreshness?.activeClarification && updateFreshness.activeClarification.availableUntil <= asOf)
        updateFreshness.activeClarification = undefined;
      if ((answer.ownerReply && answer.ownerReply.availableUntil <= asOf) ||
          (answer.scheduleCitation && answer.scheduleCitation.availableUntil <= asOf) ||
          (prior && (prior.facts.ownerReply.availableUntil <= asOf || prior.facts.asOf > asOf)))
        throw new ProjectUpdateError("DENIED");
      return atlasLeadershipAnswerSchema.parse({ ...answer, asOf, updateFreshness, delayClarificationState,
        integrationStart: milestone?.plannedStart && milestone.actualStart && milestone.actualStart > milestone.plannedStart
          ? { milestoneId: milestone.id, planned: iso(milestone.plannedStart).slice(0, 10),
            actual: iso(milestone.actualStart).slice(0, 10) } : null,
        jiraBlocker: blocker,
        pmEscalation: escalation && escalation.availableUntil > asOf ? escalation : null,
        priorSnapshot: prior ? { id: prior.id, facts: prior.facts } : undefined,
      });
    }, "ReadCommitted");
  }

  private async savedAtlasManagementSnapshot(tx: Tx, customerId: string, projectId: string, author: string, snapshotId?: string): Promise<StoredAtlasManagementSnapshot | null> {
    const saved = await tx.auditEvent.findFirst({
      where: { ...(snapshotId && { id: snapshotId }), customerId, actor: author, event: atlasManagementSnapshotEvent,
        detail: { path: ["projectId"], equals: projectId } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true, detail: true },
    });
    if (!saved) return null;
    const detail = storedAtlasManagementSnapshot.parse(saved.detail);
    if (detail.facts.projectId !== projectId) throw new ProjectUpdateError("UNAVAILABLE");
    return { id: saved.id, ...detail };
  }

  private async atlasReportSubmission(tx: Tx, customerId: string, projectId: string, snapshotId?: string): Promise<AtlasReportSubmission | null> {
    const submitted = await tx.auditEvent.findFirst({
      where: { customerId, event: atlasReportRequestedEvent, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        ...(snapshotId ? [{ detail: { path: ["snapshotId"], equals: snapshotId } }] : []),
      ] }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { id: true, actor: true, detail: true },
    });
    if (!submitted) return null;
    return { ...storedAtlasReportRequest.parse(submitted.detail), id: submitted.id, author: submitted.actor };
  }

  private async atlasReportDecision(tx: Tx, customerId: string, submission: AtlasReportSubmission): Promise<AtlasReportDecision | null> {
    const saved = await tx.auditEvent.findFirst({
      where: { customerId, actor: submission.approver, event: atlasReportDecidedEvent,
        detail: { path: ["requestId"], equals: submission.id } },
      select: { id: true, detail: true, occurredAt: true },
    });
    if (!saved) return null;
    const decision = storedAtlasReportDecision.parse(saved.detail);
    if (decision.projectId !== submission.projectId || decision.snapshotId !== submission.snapshotId ||
        decision.captureIssuanceEpoch !== submission.captureIssuanceEpoch)
      throw new ProjectUpdateError("UNAVAILABLE");
    return { id: saved.id, decision: decision.decision, decidedAt: iso(saved.occurredAt) };
  }

  private async atlasReportDistribution(tx: Tx, customerId: string, projectId: string, snapshotId?: string): Promise<AtlasReportDistribution | null> {
    const event = await tx.auditEvent.findFirst({
      where: { customerId, event: atlasReportDistributedEvent, AND: [
        { detail: { path: ["projectId"], equals: projectId } },
        { detail: { path: ["recipient"], equals: atlasReportRecipientSubject } },
        ...(snapshotId ? [{ detail: { path: ["snapshotId"], equals: snapshotId } }] : []),
      ] },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: { id: true, actor: true, detail: true, occurredAt: true },
    });
    if (!event) return null;
    return { id: event.id, actor: event.actor, distributedAt: iso(event.occurredAt),
      detail: storedAtlasReportDistribution.parse(event.detail) };
  }

  private atlasDistributionReceipt(delivery: AtlasReportDistribution, submission: AtlasReportSubmission, decision: AtlasReportDecision | null) {
    const { detail } = delivery;
    if (decision?.decision !== "APPROVED" || delivery.actor !== submission.approver || detail.projectId !== submission.projectId ||
        detail.requestId !== submission.id || detail.snapshotId !== submission.snapshotId || detail.decisionId !== decision.id ||
        detail.captureIssuanceEpoch !== submission.captureIssuanceEpoch || delivery.distributedAt < decision.decidedAt)
      throw new ProjectUpdateError("UNAVAILABLE");
    return atlasReportDistributionReceiptSchema.parse({ id: delivery.id, distributedAt: delivery.distributedAt,
      snapshotId: detail.snapshotId, requestId: detail.requestId, recipient: detail.recipient });
  }

  private atlasManagementView(saved: Pick<StoredAtlasManagementSnapshot, "id" | "facts">,
    submission: Pick<AtlasReportSubmission, "id" | "approver"> | null = null,
    decision: AtlasReportDecision | null = null) {
    return atlasManagementSnapshotSchema.parse({
      ...saved.facts, id: saved.id, reportingPeriod: saved.facts.asOf.slice(0, 7), classification: "SYNTHETIC_INTERNAL",
      approvalState: decision?.decision ?? (submission ? "PENDING" : "DRAFT"),
      approval: submission ? { requestId: submission.id, approver: submission.approver, decidedAt: decision?.decidedAt ?? null } : null,
    });
  }

  private async authorizeAtlasReportOrigin(tx: Tx, current: Actor, saved: StoredAtlasManagementSnapshot, audience: "pm" | "leadership") {
    const origin = await this.authorizedInvitation(tx, current, saved.locator, audience);
    const reply = saved.facts.ownerReply;
    if (origin.projectId !== saved.projectId || origin.row.issuanceEpoch !== saved.captureIssuanceEpoch ||
        origin.asOf >= new Date(reply.availableUntil))
      throw new ProjectUpdateError("DENIED");
    const [present] = await tx.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM public."ProjectUpdateResponse" r
      JOIN public."ProjectUpdateResponseContent" c ON c."customerId"=r."customerId"
        AND c."projectId"=r."projectId" AND c."responseId"=r.id
      WHERE r."customerId"=${current.customerId}::uuid AND r."projectId"=${saved.projectId}::uuid
        AND r."requestId"=${origin.row.requestId}::uuid AND r.id=${reply.responseId}::uuid
        AND c.state='PRESENT' AND r."purgeAfter">clock_timestamp()`;
    if (!present) throw new ProjectUpdateError("DENIED");
    if (saved.facts.scheduleCitation) {
      const expected = saved.facts.scheduleCitation;
      const read = await this.atlasScheduleEvidence(tx, current, saved.projectId, saved.facts.schedule, expected);
      if (!read?.citation || read.citation.reviewedAt !== expected.reviewedAt ||
          read.citation.availableUntil < expected.availableUntil || expected.availableUntil <= iso(await this.now(tx)))
        throw new ProjectUpdateError("DENIED");
    }
    return origin.policy.escalationRecipientSubject;
  }

  private async atlasReportState(tx: Tx, customerId: string, saved: StoredAtlasManagementSnapshot, approver: string | null | undefined) {
    const submission = await this.atlasReportSubmission(tx, customerId, saved.projectId, saved.id);
    if (!submission) return this.atlasManagementView(saved);
    if (submission.captureIssuanceEpoch !== saved.captureIssuanceEpoch)
      throw new ProjectUpdateError("DENIED");
    const decision = await this.atlasReportDecision(tx, customerId, submission);
    return this.atlasManagementView(saved, decision || submission.approver === approver ? submission : null, decision);
  }

  async atlasManagementSnapshot(actorValue: Actor, projectValue: string, snapshotValue?: string) {
    const current = this.atlasLeadershipActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const snapshotId = snapshotValue === undefined ? undefined : parseProjectId(snapshotValue);
    return this.transaction(async (tx) => {
      await this.lockAtlasProject(tx, current, projectId);
      await this.authorize(tx, current, projectId, false);
      const saved = await this.savedAtlasManagementSnapshot(tx, current.customerId, projectId, current.subject, snapshotId);
      if (!saved) {
        if (snapshotId) throw new ProjectUpdateError("DENIED");
        return null;
      }
      const approver = await this.authorizeAtlasReportOrigin(tx, current, saved, "leadership");
      return this.atlasReportState(tx, current.customerId, saved, approver);
    }, "ReadCommitted");
  }

  async createAtlasManagementSnapshot(actorValue: Actor, projectValue: string, correlationValue: string) {
    const current = this.atlasLeadershipActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      const { answer, locator, approver } = await this.loadAtlasLeadershipAnswer(tx, current, projectId);
      const facts = atlasManagementFactsSchema.safeParse(answer);
      if (!facts.success || !locator) throw new ProjectUpdateError("CONFLICT");
      const previous = await this.savedAtlasManagementSnapshot(tx, current.customerId, projectId, current.subject);
      const sameEvidence = (value: typeof facts.data) =>
        hash([value.schedule, value.scheduleCitation ?? null, value.ownerReply, value.receipt, value.delayAssessment]);
      if (previous && previous.locator === locator && previous.facts.asOf.slice(0, 7) === facts.data.asOf.slice(0, 7) &&
          sameEvidence(previous.facts) === sameEvidence(facts.data))
        return this.atlasReportState(tx, current.customerId, previous, approver);
      const { delayAssessment, ...originalFacts } = facts.data;
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasManagementSnapshotEvent,
        { projectId, locator, facts: delayAssessment ? facts.data : originalFacts });
      return this.atlasManagementView({ id, facts: facts.data });
    }, "ReadCommitted");
  }

  async requestAtlasReportApproval(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const current = this.atlasLeadershipActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = atlasReportApprovalRequestSchema.safeParse(value);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      await this.lockAtlasProject(tx, current, projectId);
      await this.authorize(tx, current, projectId, false);
      const saved = await this.savedAtlasManagementSnapshot(tx, current.customerId, projectId, current.subject);
      if (!saved || saved.id !== parsed.data.snapshotId) throw new ProjectUpdateError("CONFLICT");
      const approver = await this.authorizeAtlasReportOrigin(tx, current, saved, "leadership");
      if (!approver || approver === current.subject) throw new ProjectUpdateError("DENIED");
      const existing = await this.atlasReportState(tx, current.customerId, saved, approver);
      if (existing.approvalState !== "DRAFT") return existing;
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasReportRequestedEvent,
        { projectId, snapshotId: saved.id, approver });
      return this.atlasManagementView(saved, { id, approver });
    }, "ReadCommitted");
  }

  private async loadAtlasReportReview(tx: Tx, current: Actor, projectId: string) {
    await this.lockAtlasProject(tx, current, projectId);
    if (!await this.actorRecipientAuthorized(tx, current, projectId, "PROJECT_MANAGER"))
      throw new ProjectUpdateError("DENIED");
    const submission = await this.atlasReportSubmission(tx, current.customerId, projectId);
    if (!submission || submission.approver !== current.subject) return null;
    const saved = await this.savedAtlasManagementSnapshot(tx, current.customerId, projectId, submission.author, submission.snapshotId);
    if (!saved || submission.author === current.subject || submission.captureIssuanceEpoch !== saved.captureIssuanceEpoch)
      throw new ProjectUpdateError("DENIED");
    await this.authorizeAtlasReportOrigin(tx, current, saved, "pm");
    const decision = await this.atlasReportDecision(tx, current.customerId, submission);
    return { saved, submission, decision };
  }

  async atlasReportApproval(actorValue: Actor, projectValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    return this.transaction(async (tx) => {
      const review = await this.loadAtlasReportReview(tx, current, projectId);
      if (!review) return null;
      const { saved, submission, decision } = review;
      const delivery = await this.atlasReportDistribution(tx, current.customerId, projectId, saved.id);
      return { snapshot: this.atlasManagementView(saved, submission, decision),
        distribution: delivery ? this.atlasDistributionReceipt(delivery, submission, decision) : null };
    }, "ReadCommitted");
  }

  async decideAtlasReportApproval(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = atlasReportDecisionSchema.safeParse(value);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      const review = await this.loadAtlasReportReview(tx, current, projectId);
      if (!review || review.submission.id !== parsed.data.requestId || review.saved.id !== parsed.data.snapshotId ||
          (review.decision && review.decision.decision !== parsed.data.decision))
        throw new ProjectUpdateError("CONFLICT");
      if (review.decision) return this.atlasManagementView(review.saved, review.submission, review.decision);
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasReportDecidedEvent,
        { projectId, ...parsed.data });
      const event = await tx.auditEvent.findUniqueOrThrow({ where: { id }, select: { occurredAt: true } });
      return this.atlasManagementView(review.saved, review.submission, { id, decision: parsed.data.decision, decidedAt: iso(event.occurredAt) });
    }, "ReadCommitted");
  }

  async distributeAtlasReport(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const parsed = atlasReportVersionSchema.safeParse(value);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    return this.transaction(async (tx) => {
      const review = await this.loadAtlasReportReview(tx, current, projectId);
      if (!review || review.saved.id !== parsed.data.snapshotId || review.submission.id !== parsed.data.requestId ||
          review.decision?.decision !== "APPROVED") throw new ProjectUpdateError("CONFLICT");
      const { saved, submission, decision } = review;
      const recipient: Actor = { customerId: current.customerId, subject: atlasReportRecipientSubject, roles: ["leadership"] };
      await this.authorize(tx, recipient, projectId, false);
      await this.authorizeAtlasReportOrigin(tx, recipient, saved, "leadership");
      const delivered = await this.atlasReportDistribution(tx, current.customerId, projectId, saved.id);
      if (delivered) return this.atlasDistributionReceipt(delivered, submission, decision);

      const detail: AtlasReportDistribution["detail"] = { ...parsed.data, projectId, decisionId: decision.id, recipient: atlasReportRecipientSubject,
        captureIssuanceEpoch: saved.captureIssuanceEpoch };
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasReportDistributedEvent, detail);
      const event = await tx.auditEvent.findUniqueOrThrow({ where: { id }, select: { occurredAt: true } });
      return this.atlasDistributionReceipt({ id, actor: current.subject, distributedAt: iso(event.occurredAt), detail }, submission, decision);
    }, "ReadCommitted");
  }

  async atlasDistributedReport(actorValue: Actor, projectValue: string) {
    const current = this.atlasLeadershipActor(actorValue);
    const projectId = parseProjectId(projectValue);
    if (current.subject !== atlasReportRecipientSubject) throw new ProjectUpdateError("DENIED");
    return this.transaction(async (tx) => {
      await this.lockAtlasProject(tx, current, projectId);
      await this.authorize(tx, current, projectId, false);
      const delivery = await this.atlasReportDistribution(tx, current.customerId, projectId);
      if (!delivery) return null;
      const submission = await this.atlasReportSubmission(tx, current.customerId, projectId, delivery.detail.snapshotId);
      if (!submission) throw new ProjectUpdateError("UNAVAILABLE");
      const saved = await this.savedAtlasManagementSnapshot(tx, current.customerId, projectId, submission.author, submission.snapshotId);
      if (!saved || submission.captureIssuanceEpoch !== saved.captureIssuanceEpoch)
        throw new ProjectUpdateError("UNAVAILABLE");
      await this.authorizeAtlasReportOrigin(tx, current, saved, "leadership");
      const decision = await this.atlasReportDecision(tx, current.customerId, submission);
      const distribution = this.atlasDistributionReceipt(delivery, submission, decision);
      return { snapshot: this.atlasManagementView(saved, submission, decision), distribution };
    }, "ReadCommitted");
  }

  async decideAtlasApproval(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string) {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    return this.transaction(async (tx) => {
      const approval = await this.loadAtlasApproval(tx, current, projectId);
      const view = approval?.view;
      const parsed = atlasApprovalDecisionSchema.safeParse(value);
      if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
      if (!approval || !view || view.approvalId !== parsed.data.approvalId || await this.now(tx) >= new Date(view.expiresAt))
        throw new ProjectUpdateError("CONFLICT");
      const { approvalId, decision } = parsed.data;
      const proposedComment = parsed.data.proposedComment ?? approval.draftComment;
      if (view.decision !== "PENDING") {
        if (view.decision !== decision || view.proposedComment !== proposedComment) throw new ProjectUpdateError("CONFLICT");
        return view;
      }
      await this.engagementAudit(tx, current, projectId, correlationId, atlasDecidedEvent, {
        approvalId, decision, projectId, payloadDigest: hash({
          approvalId, target: view.target, proposedComment, sourceRevision: view.sourceRevision,
        }),
        ...(decision === "APPROVED" && (view.replacesApprovalId || proposedComment !== approval.draftComment) && { proposedComment }),
      });
      return { ...view, proposedComment, decision };
    }, "ReadCommitted");
  }

  private async atlasApprovalForComment(tx: Tx, current: Actor, projectId: string, value: unknown) {
    const approval = await this.loadAtlasApproval(tx, current, projectId);
    const parsed = atlasCommentCommandSchema.safeParse(value);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    if (!approval || approval.view.approvalId !== parsed.data.approvalId ||
        approval.view.decision !== "APPROVED" || !approval.decisionId)
      throw new ProjectUpdateError("CONFLICT");
    if (!approval.view.receipt && (await this.now(tx) >= new Date(approval.view.expiresAt) ||
        (approval.approvedDigest === undefined ? !approval.legacyConfirmation : approval.approvedDigest !== approval.payloadDigest)))
      throw new ProjectUpdateError("CONFLICT");
    return { ...approval, decisionId: approval.decisionId };
  }

  private async matchAtlasCommentBase(tx: Tx, current: Actor, projectId: string, correlationId: string,
    view: AtlasApprovalView, confirmationId: string) {
    const fixture = await this.atlasFixtureState(tx, current.customerId, projectId);
    if (fixture.revision === view.sourceRevision && fixture.comment === view.currentComment) return true;
    if (fixture.revision <= view.sourceRevision) throw new ProjectUpdateError("CONFLICT");
    await this.engagementAudit(tx, current, projectId, correlationId, atlasProposalRefreshedEvent, {
      projectId, confirmationId, responseId: view.responseId, replacesApprovalId: view.approvalId,
      sourceRevision: fixture.revision, currentComment: fixture.comment, proposedComment: view.proposedComment,
    });
    return false;
  }

  async recordAtlasComment(actorValue: Actor, projectValue: string, value: unknown, correlationValue: string): Promise<AtlasCommentReceipt> {
    const current = parseActor(actorValue);
    const projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    const claimed = await this.transaction(async (tx) => {
      const approval = await this.atlasApprovalForComment(tx, current, projectId, value);
      const { view, attemptId, confirmationId, decisionId, payloadDigest } = approval;
      if (view.receipt) return { receipt: view.receipt } as const;
      if (attemptId) return { attemptId, dispatch: false } as const;
      if (!await this.matchAtlasCommentBase(tx, current, projectId, correlationId, view, confirmationId)) return null;
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasCommentAttemptEvent, {
        projectId, approvalId: view.approvalId, responseId: view.responseId, decisionId,
        target: view.target, sourceRevision: view.sourceRevision, payloadDigest, marker: atlasActionMarker(view.approvalId),
      });
      return { attemptId: id, dispatch: true } as const;
    }, "ReadCommitted");
    if (!claimed) throw new ProjectUpdateError("CONFLICT");
    if (claimed.receipt) return claimed.receipt;

    // Only the request that committed the attempt can submit to the fixture.
    // Later requests can only look for its exact result.
    if (claimed.dispatch) {
      const posted = await this.transaction(async (tx) => {
        const { view, attemptId, confirmationId, decisionId, payloadDigest } = await this.atlasApprovalForComment(tx, current, projectId, value);
        if (attemptId !== claimed.attemptId) throw new ProjectUpdateError("CONFLICT");
        if (!await this.matchAtlasCommentBase(tx, current, projectId, correlationId, view, confirmationId)) return false;
        await this.engagementAudit(tx, current, projectId, correlationId, atlasFixtureCommentPostedEvent, {
          projectId, approvalId: view.approvalId, responseId: view.responseId, decisionId,
          fixtureRevision: view.sourceRevision + 1, accessStatus: view.accessStatus,
          template: atlasCommentTemplate, payloadDigest, attemptId, marker: atlasActionMarker(view.approvalId),
        });
        return true;
      }, "ReadCommitted");
      if (!posted) throw new ProjectUpdateError("CONFLICT");
    }

    return this.transaction(async (tx) => {
      const { view, attemptId, decisionId, payloadDigest, captureIssuanceEpoch } =
        await this.atlasApprovalForComment(tx, current, projectId, value);
      if (attemptId !== claimed.attemptId) throw new ProjectUpdateError("CONFLICT");
      if (view.receipt) return view.receipt;
      const marker = atlasActionMarker(view.approvalId);
      const matches = await tx.auditEvent.findMany({
        where: { customerId: current.customerId, actor: current.subject, event: atlasFixtureCommentPostedEvent, AND: [
          { detail: { path: ["projectId"], equals: projectId } },
          { detail: { path: ["marker"], equals: marker } },
        ] }, take: 2, select: { detail: true },
      });
      if (matches.length !== 1) throw new ProjectUpdateError("CONFLICT");
      const { attemptId: postedAttempt, marker: postedMarker, ...effect } = storedAtlasFixtureComment.parse(matches[0]!.detail);
      if (postedAttempt !== attemptId || postedMarker !== marker || effect.approvalId !== view.approvalId || effect.decisionId !== decisionId ||
          effect.payloadDigest !== payloadDigest || effect.responseId !== view.responseId || effect.accessStatus !== view.accessStatus ||
          effect.fixtureRevision !== view.sourceRevision + 1 || effect.captureIssuanceEpoch !== captureIssuanceEpoch)
        throw new ProjectUpdateError("CONFLICT");
      const id = await this.engagementAudit(tx, current, projectId, correlationId, atlasCommentEvent, effect);
      const saved = await tx.auditEvent.findUniqueOrThrow({ where: { id }, select: { occurredAt: true } });
      return atlasCommentReceiptSchema.parse({ id, approvalId: view.approvalId, target: view.target,
        fixtureRevision: effect.fixtureRevision, recordedAt: iso(saved.occurredAt), result: "SIMULATED" });
    }, "ReadCommitted");
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
        body: string | null; contentState: string; dependencies: unknown; requiredFacts: unknown; capturedRequiredFacts: unknown;
        locator: string; engagementState: string; obligationState: string;
        stageGeneration: number; engagementGeneration: number; policyRevision: number; currentPolicyRevision: number;
      }[]>(
        'SELECT r.id AS "requestId",s.id AS "stageId",s.kind AS "stageKind",r."recipientSubject",s."recipientRole",r."capturedAt",i."expiresAt",r."purgeAfter",r."issuanceEpoch",r."reviewerSubjects",c.body,c.state AS "contentState",r.dependencies,p."requiredFacts",r."requiredFacts" AS "capturedRequiredFacts",i.locator,e.state AS "engagementState",o.state AS "obligationState",s.generation AS "stageGeneration",e.generation AS "engagementGeneration",s."policyRevision",h.revision AS "currentPolicyRevision" FROM public."ProjectUpdateCapturedRequest" r JOIN public."ProjectUpdateStage" s ON s."customerId"=r."customerId" AND s."projectId"=r."projectId" AND s.id=r."stageId" JOIN public."ProjectUpdateEngagement" e ON e."customerId"=s."customerId" AND e."projectId"=s."projectId" AND e.id=s."engagementId" JOIN public."ProjectUpdateObligation" o ON o."customerId"=e."customerId" AND o."projectId"=e."projectId" AND o.id=e."obligationId" JOIN public."ProjectUpdatePolicyRevision" p ON p."customerId"=s."customerId" AND p."projectId"=s."projectId" AND p.id=s."policyRevisionId" JOIN public."ProjectUpdatePolicy" h ON h."customerId"=s."customerId" AND h."projectId"=s."projectId" JOIN public."ProjectUpdateInvitation" i ON i."customerId"=r."customerId" AND i."projectId"=r."projectId" AND i."requestId"=r.id JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."requestId"=r.id WHERE r."customerId"=$1::uuid AND r."projectId"=$2::uuid AND ($3 OR r."recipientSubject"=$4) AND ($5::uuid IS NULL OR (r."capturedAt",r.id)<(SELECT before."capturedAt",before.id FROM public."ProjectUpdateCapturedRequest" before WHERE before."customerId"=$1::uuid AND before."projectId"=$2::uuid AND before.id=$5::uuid AND ($3 OR before."recipientSubject"=$4))) ORDER BY r."capturedAt" DESC,r.id DESC LIMIT 21',
        current.customerId, projectId, administrator, current.subject, cursorValue ?? null,
      );
      const configuration = this.captureConfiguration(current.customerId);
      const gateOpen = configuration ? await this.captureGate(tx, current.customerId, configuration) : false;
      const asOf = await this.now(tx);
      const entries: ProjectUpdateCaptureHistory["entries"] = [];
      const factRevisions = new Map<CapturedUpdateFactType, number>();
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
        const responses = disclose ? await this.responseHistory(tx, current, projectId, row.requestId) : [];
        const latest = responses[0];
        let statusReview: ProjectUpdateCaptureHistory["entries"][number]["statusReview"];
        let forecastReview: ProjectUpdateCaptureHistory["entries"][number]["forecastReview"];
        if (frozenReviewer && row.recipientRole === "OWNER" && latest?.contentState === "PRESENT" && latest.text !== null &&
            latest.submittedBy === row.recipientSubject) {
          const required = new Set(policyFacts(row.capturedRequiredFacts).map(({ factType }) => factType));
          const suggestions = status === "ACTIVE" ? extractExplicitCapturedFacts(latest.text) : {};
          for (const factType of capturedFactTypes) {
            if (!required.has(factType)) continue;
            const confirmed = await this.capturedFactConfirmation(tx, current.customerId, projectId, row.requestId,
              latest.id, row.issuanceEpoch, factType);
            const requested = !confirmed && status === "ACTIVE"
              ? await this.capturedClarification(tx, current.customerId, projectId, row.requestId,
                latest.id, row.issuanceEpoch, factType)
              : null;
            let review: typeof forecastReview;
            if (confirmed) review = { state: "CONFIRMED", ...confirmed.receipt };
            else if (requested) review = { state: "CLARIFICATION_REQUESTED", ...requested };
            else if (status === "ACTIVE") {
              let expectedRevision = factRevisions.get(factType);
              if (expectedRevision === undefined) {
                expectedRevision = (await tx.projectFact.findFirst({
                  where: { customerId: current.customerId, projectId, factType }, select: { revision: true },
                }))?.revision ?? 0;
                factRevisions.set(factType, expectedRevision);
              }
              if (projectUpdateStatusConfirmationSchema.shape.expectedRevision.safeParse(expectedRevision).success)
                review = { state: "PENDING", responseId: latest.id, expectedRevision,
                  ...(suggestions[factType] !== undefined && { suggestedValue: suggestions[factType] }) };
            }
            if (factType === capturedStatusFactType) statusReview = review;
            else forecastReview = review;
          }
        }
        entries.push({
          requestId: row.requestId, stageId: row.stageId, stageKind: row.stageKind,
          recipientSubject: row.recipientSubject, capturedAt: iso(row.capturedAt), expiresAt: iso(row.expiresAt),
          status, contentState: !retained ? "EXPIRED" : disclose ? "PRESENT" : "RESTRICTED",
          body: disclose ? row.body : null,
          recipientPath: disclose && namedRecipient && status === "ACTIVE" ? "/update-requests/" + row.locator : null,
          responses, statusReview, forecastReview,
          ...(this.replyInterpreter && (statusReview?.state === "PENDING" || forecastReview?.state === "PENDING") &&
            { interpretationAvailable: true as const }),
        });
      }
      const engagements = await tx.$queryRawUnsafe<{ id: string; generation: number; policyRevision: number; mode: "SHADOW" | "CAPTURE" }[]>(
        'SELECT e.id,e.generation,e."policyRevision",min(s.mode) AS mode FROM public."ProjectUpdateEngagement" e JOIN public."ProjectUpdateStage" s ON s."customerId"=e."customerId" AND s."projectId"=e."projectId" AND s."engagementId"=e.id AND s.generation=e.generation WHERE e."customerId"=$1::uuid AND e."projectId"=$2::uuid AND e.state=\'ACTIVE\' GROUP BY e.id,e.generation,e."policyRevision" ORDER BY e.id LIMIT 1',
        current.customerId, projectId,
      );
      return { projectId, engagement: engagements[0] ?? null, entries, nextCursor: rows.length > 20 ? rows[19]!.requestId : null };
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

  // Explicit PMO approval creates a new generation; terminal receipts and old
  // invitation epochs retain their history. No implicit SHADOW reinterpretation.
  async beginCaptureGeneration(actorValue: Actor, projectValue: string, changeValue: unknown, correlationValue: string): Promise<ProjectUpdateEngagementView> {
    const current = parseActor(actorValue), projectId = parseProjectId(projectValue);
    const correlationId = parseCorrelation(correlationValue);
    if (!current.roles.includes("pmo_admin")) throw new ProjectUpdateError("FORBIDDEN");
    const parsed = projectUpdateCaptureGenerationSchema.safeParse(changeValue);
    if (!parsed.success) throw new ProjectUpdateError("INVALID_REQUEST");
    const change = parsed.data;
    return this.transaction(async (tx) => {
      try { await authorizeFactProject(tx, current, projectId, "access"); }
      catch { throw new ProjectUpdateError("DENIED"); }
      const configuration = this.captureConfiguration(current.customerId);
      if (!configuration || !this.zones || !await this.captureGate(tx, current.customerId, configuration))
        throw new ProjectUpdateError("UNAVAILABLE");
      const policy = await this.loadPolicy(tx, current.customerId, projectId, true);
      if (!policy || policy.revision !== change.expectedPolicyRevision) throw new ProjectUpdateError("CONFLICT");
      const prepared = await this.assessInTransaction(tx, current, projectId, correlationId, false);
      if (!prepared.view.obligation || prepared.source.sourceUnknown || !prepared.source.remainingFactTypes.length)
        throw new ProjectUpdateError("CONFLICT");
      const engagements = await tx.$queryRawUnsafe<EngagementRow[]>(
        'SELECT * FROM public."ProjectUpdateEngagement" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "obligationId"=$3::uuid FOR UPDATE',
        current.customerId, projectId, prepared.view.obligation.id,
      );
      const engagement = engagements[0];
      if (!engagement || engagement.state !== "ACTIVE" || engagement.generation !== change.expectedEngagementGeneration ||
          engagement.generation >= 2147483647 || !await this.recipientAuthorized(tx, current.customerId, projectId, policy.responsibleSubject, "OWNER"))
        throw new ProjectUpdateError("CONFLICT");
      const hazards = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT s.id FROM public."ProjectUpdateStage" s
          JOIN public."ProjectUpdateOutbox" o ON o."customerId"=s."customerId" AND o."projectId"=s."projectId" AND o."stageId"=s.id
          LEFT JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=s."customerId" AND r."projectId"=s."projectId" AND r."stageId"=s.id
          WHERE s."customerId"=$1::uuid AND s."projectId"=$2::uuid AND s."engagementId"=$3::uuid
            AND (s.mode='EMAIL' OR o.state IN ('UNKNOWN','HANDED_OFF','SENT')
              OR (s.generation=$4 AND s.mode='CAPTURE' AND (
                o.state='CLAIMED' OR r."issuanceEpoch"=$5::uuid
                OR (o.state='READY' AND NOT EXISTS (
                  SELECT 1 FROM public."AuditEvent" birth WHERE birth.id=s."auditEventId"
                    AND birth."customerId"=s."customerId"
                    AND birth.detail->>'captureIssuanceEpoch' IS NOT NULL
                    AND birth.detail->>'captureIssuanceEpoch'<>$5::text))))) LIMIT 1`,
        current.customerId, projectId, engagement.id, engagement.generation, configuration.issuanceEpoch,
      );
      if (hazards.length) throw new ProjectUpdateError("CONFLICT");
      const pending = await this.pendingStages(tx, current, projectId, engagement.id);
      for (const stage of pending) await this.suppressStage(tx, current, projectId, stage, "SOURCE_REASSESSMENT_REQUIRED", correlationId);
      const schedule = await this.stagePlans(tx, current.customerId, projectId, policy, prepared.view.obligation.dueAt);
      const auditId = await this.engagementAudit(tx, current, projectId, correlationId,
        "project_update.engagement.capture_approved", { engagementId: engagement.id, generation: engagement.generation + 1,
          policyRevision: policy.revision, mode: "CAPTURE" });
      const changed = await tx.$executeRawUnsafe(
        'UPDATE public."ProjectUpdateEngagement" SET generation=generation+1,"auditEventId"=$4::uuid,"changedAt"=$5 WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid AND generation=$6',
        current.customerId, projectId, engagement.id, auditId, await this.now(tx), engagement.generation,
      );
      if (changed !== 1) throw new ProjectUpdateError("CONFLICT");
      engagement.generation += 1;
      for (const plan of schedule.plans)
        await this.insertStage(tx, current, projectId, engagement, plan, prepared.source.remainingFactTypes, auditId, null, "CAPTURE");
      return { projectId, engagementId: engagement.id, obligationId: engagement.obligationId,
        policyRevision: policy.revision, mode: "CAPTURE", stageCount: schedule.plans.length,
        remainingFactTypes: prepared.source.remainingFactTypes, configurationActions: schedule.configurationActions };
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
    try {
      return await new ProjectUpdateScanCoordinator(
        this.db, this.serviceSubject,
        (tx, actor, projectId, correlationId) => this.assessInTransaction(tx, actor, projectId, correlationId, true),
      ).scan();
    } catch (error) { mapError(error); }
  }
}
