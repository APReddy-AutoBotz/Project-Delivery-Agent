import { z } from "zod";
import { canonicalDateSchema, canonicalSubjectSchema } from "./canonical-project.js";
import { calendarDayDifference } from "./overdue-signals.js";
import { projectUpdateAssessmentViewSchema } from "./project-updates.js";
import { composeLeadershipComparisonClaims, leadershipComparisonClaimsSchema,
  leadershipScheduleMovementText, leadershipUpdateClaimSchema, matchesLeadershipUpdateClaim, projectDelayClarificationCommandSchema,
  projectDelayClarificationSchema, projectLeadershipScheduleSchema, settledLeadershipClaimSchema } from "./project-leadership-answer.js";
import { projectReportApprovalRequestSchema, projectReportDecisionSchema, projectReportVersionSchema } from "./project-management-draft.js";

export const atlasApprovalProjectCode = "ATLAS-APPROVAL-DEMO";
export const atlasIntegrationMilestoneKey = "INTEGRATION-TESTING";
export const atlasJiraBlockerKey = "ATLAS-248";
export const atlasJiraBlockerClaimText = "The synthetic Jira blocker ATLAS-248 is open.";
export const atlasSpreadsheetOrigin = "https://atlas-spreadsheet.example.test";
export const atlasSpreadsheetRow = "ATLAS-DELIVERY";
export const atlasCommentTemplate = "atlas-comment@1";
export const atlasAccessStatusSchema = z.enum(["ACCESS_PENDING", "ACCESS_RESTORED"]);
export const atlasSuggestionStatusSchema = z.enum(["ACCESS_PENDING", "ACCESS_RESTORED", "NEEDS_CLARIFICATION"]);
export type AtlasAccessStatus = z.infer<typeof atlasAccessStatusSchema>;

export const atlasReplyConfirmationSchema = z.strictObject({
  responseId: z.uuid(),
  accessStatus: atlasAccessStatusSchema,
});
export const atlasCommentLimit = 500;
const atlasProposedCommentSchema = z.string().min(1).max(atlasCommentLimit)
  .regex(/^[^\p{Cc}\p{Surrogate}]+$/u)
  .refine((text) => text.trim().length > 0 && new TextEncoder().encode(text).length <= atlasCommentLimit);
export const atlasApprovalDecisionSchema = z.strictObject({
  approvalId: z.uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  proposedComment: atlasProposedCommentSchema.optional(),
}).refine((value) => value.decision === "APPROVED" || value.proposedComment === undefined, {
  path: ["proposedComment"], message: "Comment text is only accepted for approval.",
});
export const atlasCommentCommandSchema = z.strictObject({ approvalId: z.uuid() });
export const atlasCommentReceiptSchema = z.strictObject({
  id: z.uuid(),
  approvalId: z.uuid(),
  target: z.literal("ATLAS-248"),
  fixtureRevision: z.number().int().min(1),
  recordedAt: z.iso.datetime(),
  result: z.literal("SIMULATED"),
});
export type AtlasCommentReceipt = z.infer<typeof atlasCommentReceiptSchema>;
export const atlasScheduleSchema = projectLeadershipScheduleSchema;
export type AtlasSchedule = z.infer<typeof atlasScheduleSchema>;
export const atlasDelayClarificationCommandSchema = projectDelayClarificationCommandSchema;
export const atlasDelayClarificationSchema = projectDelayClarificationSchema;
export type AtlasDelayClarification = z.infer<typeof atlasDelayClarificationSchema>;
export const atlasForecastConfidenceSchema = z.enum(["MEDIUM", "LOW", "UNKNOWN"]);
export const atlasDelayCommandSchema = z.strictObject({
  approvalId: z.uuid(),
  receiptId: z.uuid(),
  scheduleRevision: atlasScheduleSchema.shape.revision,
  cause: z.literal("API_ACCESS_DELAY"),
  confidence: atlasForecastConfidenceSchema,
});
export const atlasDelayAssessmentSchema = atlasDelayCommandSchema.extend({
  id: z.uuid(),
  confirmedBy: canonicalSubjectSchema,
  confirmedAt: z.iso.datetime(),
});
export type AtlasDelayAssessment = z.infer<typeof atlasDelayAssessmentSchema>;
export const atlasApprovalViewSchema = z.strictObject({
  approvalId: z.uuid(),
  responseId: z.uuid(),
  replyReceivedAt: z.iso.datetime(),
  confirmedBy: canonicalSubjectSchema,
  approver: canonicalSubjectSchema,
  accessStatus: atlasAccessStatusSchema,
  target: z.literal("ATLAS-248"),
  currentComment: atlasProposedCommentSchema.nullable(),
  proposedComment: atlasProposedCommentSchema,
  sourceRevision: z.number().int().nonnegative(),
  replacesApprovalId: z.uuid().optional(),
  expiresAt: z.iso.datetime(),
  decision: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  receipt: atlasCommentReceiptSchema.nullable(),
  executionPending: z.literal(true).optional(),
  delayReview: z.strictObject({
    schedule: atlasScheduleSchema,
    assessment: atlasDelayAssessmentSchema.nullable(),
  }).nullable().optional(),
});
export type AtlasApprovalView = z.infer<typeof atlasApprovalViewSchema>;

export const atlasScheduleCitationSchema = z.strictObject({
  sourceId: z.uuid(),
  receiptId: z.uuid(),
  reviewedAt: z.iso.datetime(),
  availableUntil: z.iso.datetime(),
});
export const atlasLeadershipFactsSchema = z.strictObject({
  projectId: z.uuid(),
  asOf: z.iso.datetime(),
  schedule: atlasScheduleSchema.nullable(),
  scheduleCitation: atlasScheduleCitationSchema.optional(),
  ownerReply: z.strictObject({
    responseId: z.uuid(),
    receivedAt: z.iso.datetime(),
    availableUntil: z.iso.datetime(),
    accessStatus: atlasAccessStatusSchema,
  }).nullable(),
  receipt: atlasCommentReceiptSchema.nullable(),
  delayAssessment: atlasDelayAssessmentSchema.nullable(),
});
export type AtlasLeadershipFacts = z.infer<typeof atlasLeadershipFactsSchema>;
const atlasReceiptClaim = z.strictObject({
  projectId: z.uuid(), assessedAt: z.iso.datetime(), validUntil: z.iso.datetime(),
  scheduleRevision: atlasScheduleSchema.shape.revision,
  claimText: z.string().min(1).max(200), freshness: z.literal("CURRENT"), conflict: z.literal("NONE"),
});
const atlasReceiptClaimsSchema = z.array(z.discriminatedUnion("kind", [
  atlasReceiptClaim.extend({
    kind: z.literal("REVIEWED_SCHEDULE"), sourceId: z.uuid(),
    evidenceIds: z.array(z.uuid()).length(1),
    provenance: z.literal("SYSTEM_VERIFIED"), classification: z.literal("SYSTEM_VERIFIED"),
  }),
  atlasReceiptClaim.extend({
    kind: z.literal("PM_DELAY_ASSESSMENT"), assessmentId: z.uuid(),
    evidenceIds: z.array(z.uuid()).length(2),
    provenance: z.literal("HUMAN_CONFIRMED"), classification: z.literal("HUMAN_CONFIRMED"),
  }),
])).max(2);

function reviewedMovementDays(schedule: AtlasSchedule | null) {
  const { baseline, forecast } = schedule ?? {};
  return canonicalDateSchema.safeParse(baseline).success && canonicalDateSchema.safeParse(forecast).success
    ? calendarDayDifference(forecast, baseline) : null;
}

export function composeAtlasReceiptClaims(facts: AtlasLeadershipFacts) {
  const { projectId, asOf: assessedAt, schedule, scheduleCitation, ownerReply, delayAssessment, receipt } = facts;
  if (!schedule) return [];
  const scope = { projectId, assessedAt, scheduleRevision: schedule.revision, freshness: "CURRENT", conflict: "NONE" } as const;
  const claims: z.input<typeof atlasReceiptClaimsSchema> = [];
  const days = scheduleCitation ? reviewedMovementDays(schedule) : null;
  if (days !== null && scheduleCitation) claims.push({
    ...scope, kind: "REVIEWED_SCHEDULE", sourceId: scheduleCitation.sourceId,
    evidenceIds: [scheduleCitation.receiptId], validUntil: scheduleCitation.availableUntil,
    provenance: "SYSTEM_VERIFIED", classification: "SYSTEM_VERIFIED",
    claimText: leadershipScheduleMovementText(days),
  });
  if (ownerReply && delayAssessment && receipt) {
    const validUntil = scheduleCitation && Date.parse(scheduleCitation.availableUntil) < Date.parse(ownerReply.availableUntil)
      ? scheduleCitation.availableUntil : ownerReply.availableUntil;
    claims.push({ ...scope, kind: "PM_DELAY_ASSESSMENT", assessmentId: delayAssessment.id,
      evidenceIds: [delayAssessment.id, receipt.id], validUntil,
      provenance: "HUMAN_CONFIRMED", classification: "HUMAN_CONFIRMED",
      claimText: `The PM confirmed that delayed API access caused the go-live delay. The PM assessed forecast confidence as ${delayAssessment.confidence.toLowerCase()}.`,
    });
  }
  const parsed = atlasReceiptClaimsSchema.safeParse(claims);
  return parsed.success ? parsed.data : [];
}

const atlasDetailClaimSchema = z.strictObject({
  kind: z.enum(["OWNER_ACCESS", "PM_COMMENT", "PM_ESCALATION", "UPDATE_CLARIFICATION",
    "CANONICAL_SCHEDULE", "INTEGRATION_START", "FORECAST_INFERENCE"]),
  projectId: z.uuid(), asOf: z.iso.datetime(), validUntil: z.iso.datetime().nullable(),
  claimText: z.string().min(1).max(200),
  evidenceIds: z.array(z.uuid()).min(1).max(67),
  provenance: z.enum(["SYSTEM_VERIFIED", "HUMAN_CONFIRMED", "AGENT_INFERENCE"]),
  freshness: z.literal("CURRENT"), conflict: z.literal("NONE"),
  classification: z.enum(["SYSTEM_VERIFIED", "HUMAN_CONFIRMED", "AGENT_INFERENCE"]),
});

const atlasLeadershipAnswerFactsSchema = atlasLeadershipFactsSchema.extend({
  receiptClaims: atlasReceiptClaimsSchema.optional(),
  delayClarificationState: z.enum(["AVAILABLE", "REQUESTED", "RESOLVED"]).optional(),
  updateFreshness: projectUpdateAssessmentViewSchema.shape.freshness.pick({
    state: true, assessedAt: true, sourceDate: true, sourceDateField: true,
  }).extend({
    assessmentId: z.uuid(),
    openObligation: z.boolean(),
    obligationId: z.uuid().optional(),
    activeClarification: z.strictObject({
      clarificationId: z.uuid(), factType: z.enum(["project.status", "project.forecast"]),
      requestedAt: z.iso.datetime(), availableUntil: z.iso.datetime(),
    }).optional(),
  }).refine((freshness) => freshness.openObligation === (freshness.obligationId !== undefined) &&
    (!freshness.activeClarification || (freshness.state === "STALE" && freshness.openObligation)), {
    path: ["obligationId"], message: "An open obligation requires its evidence ID",
  }).nullable().optional(),
  updateClaim: leadershipUpdateClaimSchema.nullable().optional(),
  canonicalCreationReceiptId: z.uuid().optional(),
  integrationStart: z.strictObject({
    milestoneId: z.uuid(),
    planned: z.iso.date(),
    actual: z.iso.date(),
  }).refine(({ planned, actual }) => planned < actual).nullable(),
  jiraBlocker: z.strictObject({
    mappingId: z.uuid(),
    issueKey: z.literal(atlasJiraBlockerKey),
    claim: settledLeadershipClaimSchema.safeExtend({ claimText: z.literal(atlasJiraBlockerClaimText),
      provenance: z.literal("SYSTEM_VERIFIED"), classification: z.literal("SYSTEM_VERIFIED") }),
  }).nullable(),
  forecastInference: z.strictObject({
    classification: z.literal("AGENT_INFERENCE"),
    scheduleRevision: atlasScheduleSchema.shape.revision,
    milestoneId: z.uuid(),
    blockerMappingId: z.uuid(),
  }).optional(),
  pmEscalation: z.strictObject({
    requestId: z.uuid(),
    capturedAt: z.iso.datetime(),
    availableUntil: z.iso.datetime(),
  }).nullable(),
  priorSnapshot: z.strictObject({
    id: z.uuid(),
    facts: atlasLeadershipFactsSchema,
  }).optional(),
});

export function composeAtlasDetailClaims(facts: Pick<z.infer<typeof atlasLeadershipAnswerFactsSchema>,
  "projectId" | "asOf" | "ownerReply" | "receipt" | "pmEscalation" | "updateFreshness" | "canonicalCreationReceiptId" |
  "schedule" | "scheduleCitation" | "integrationStart" | "forecastInference"> & {
    jiraBlocker: { mappingId: string; claim: { evidenceIds: string[]; validUntil: string | null } } | null;
  }) {
  const { projectId, asOf, ownerReply, receipt, pmEscalation, updateFreshness, canonicalCreationReceiptId,
    schedule, scheduleCitation, integrationStart, jiraBlocker, forecastInference } = facts;
  type DetailClaim = z.infer<typeof atlasDetailClaimSchema>;
  const claims: DetailClaim[] = [];
  function add(kind: DetailClaim["kind"], claimText: string, evidenceIds: string[], validUntil: string | null,
    provenance: DetailClaim["provenance"] = "SYSTEM_VERIFIED") {
    if (validUntil === null || Date.parse(validUntil) > Date.parse(asOf)) claims.push({
      kind, projectId, asOf, validUntil, claimText, evidenceIds: [...new Set(evidenceIds)], provenance,
      freshness: "CURRENT", conflict: "NONE", classification: provenance,
    });
  }
  if (ownerReply) {
    add("OWNER_ACCESS",
      `The owner confirmed API access was ${ownerReply.accessStatus === "ACCESS_PENDING" ? "pending" : "restored"} at the time of the reply.`,
      [ownerReply.responseId], ownerReply.availableUntil, "HUMAN_CONFIRMED");
    if (receipt) add("PM_COMMENT", `The PM recorded a simulated comment for ${receipt.target}.`,
      [receipt.id], ownerReply.availableUntil);
    if (pmEscalation) add("PM_ESCALATION", "A simulated escalation was captured for the assigned PM.",
      [pmEscalation.requestId], Date.parse(pmEscalation.availableUntil) < Date.parse(ownerReply.availableUntil)
        ? pmEscalation.availableUntil : ownerReply.availableUntil);
  }
  const clarification = updateFreshness?.activeClarification;
  if (clarification && updateFreshness?.obligationId) {
    const fact = clarification.factType === "project.forecast" ? "forecast finish date" : "project status";
    add("UPDATE_CLARIFICATION", `A clarification about the ${fact} is open.`,
      [clarification.clarificationId, updateFreshness.assessmentId, updateFreshness.obligationId], clarification.availableUntil);
  }
  const movement = reviewedMovementDays(schedule);
  if (canonicalCreationReceiptId) {
    if (!scheduleCitation && movement !== null)
      add("CANONICAL_SCHEDULE", leadershipScheduleMovementText(movement), [canonicalCreationReceiptId], null);
    if (integrationStart) add("INTEGRATION_START", "Integration testing started late.",
      [integrationStart.milestoneId, canonicalCreationReceiptId], null);
    if (forecastInference && schedule && movement !== null && movement > 0 && integrationStart && jiraBlocker &&
        forecastInference.scheduleRevision === schedule.revision && forecastInference.milestoneId === integrationStart.milestoneId &&
        forecastInference.blockerMappingId === jiraBlocker.mappingId) {
      const blockerExpiry = jiraBlocker.claim.validUntil;
      const scheduleExpiry = scheduleCitation?.availableUntil;
      const validUntil = scheduleExpiry && (!blockerExpiry || Date.parse(scheduleExpiry) < Date.parse(blockerExpiry))
        ? scheduleExpiry : blockerExpiry;
      add("FORECAST_INFERENCE", "The open integration blocker may still affect the forecast.",
        [scheduleCitation?.receiptId ?? canonicalCreationReceiptId, integrationStart.milestoneId,
          canonicalCreationReceiptId, ...jiraBlocker.claim.evidenceIds], validUntil, "AGENT_INFERENCE");
    }
  }
  return claims;
}

export function composeAtlasComparisonClaims(facts: Pick<z.infer<typeof atlasLeadershipAnswerFactsSchema>,
  "projectId" | "asOf" | "schedule" | "scheduleCitation" | "canonicalCreationReceiptId" |
  "ownerReply" | "receipt" | "delayAssessment" | "priorSnapshot">) {
  const saved = facts.priorSnapshot;
  if (!saved) return [];
  const before = saved.facts;
  const currentScheduleReceipt = facts.schedule ? facts.scheduleCitation?.receiptId ?? facts.canonicalCreationReceiptId : undefined;
  const schedule = currentScheduleReceipt ? facts.schedule : null;
  const deadline = (previous?: string, current?: string) =>
    previous && current ? (Date.parse(previous) <= Date.parse(current) ? previous : current) : previous ?? current ?? null;
  const scheduleDeadline = deadline(before.scheduleCitation?.availableUntil, facts.scheduleCitation?.availableUntil);
  const replyDeadline = deadline(before.ownerReply?.availableUntil, facts.ownerReply?.availableUntil);
  const assessmentDeadline = deadline(scheduleDeadline ?? undefined, replyDeadline ?? undefined);
  const ownerAccess = (reply: AtlasLeadershipFacts["ownerReply"]) => reply
    ? reply.accessStatus === "ACCESS_PENDING" ? "Pending" : "Restored" : null;
  const action = (receipt: AtlasLeadershipFacts["receipt"]) => receipt ? `Fixture revision ${receipt.fixtureRevision}` : null;
  return composeLeadershipComparisonClaims({ projectId: facts.projectId, asOf: facts.asOf, priorSnapshotId: saved.id }, [
    ["Baseline date", before.schedule?.baseline ?? null, schedule?.baseline ?? null,
      before.scheduleCitation?.receiptId, currentScheduleReceipt, scheduleDeadline],
    ["Forecast date", before.schedule?.forecast ?? null, schedule?.forecast ?? null,
      before.scheduleCitation?.receiptId, currentScheduleReceipt, scheduleDeadline],
    ["Owner-confirmed API access", ownerAccess(before.ownerReply), ownerAccess(facts.ownerReply),
      before.ownerReply?.responseId, facts.ownerReply?.responseId, replyDeadline],
    ["Simulated Jira action", action(before.receipt), action(facts.receipt), before.receipt?.id, facts.receipt?.id, replyDeadline],
    ["PM-confirmed cause", before.delayAssessment ? "API access delay" : "Unknown", facts.delayAssessment ? "API access delay" : "Unknown",
      before.delayAssessment?.id, facts.delayAssessment?.id, assessmentDeadline],
    ["PM forecast confidence", before.delayAssessment?.confidence.toLowerCase() ?? "unknown", facts.delayAssessment?.confidence.toLowerCase() ?? "unknown",
      before.delayAssessment?.id, facts.delayAssessment?.id, assessmentDeadline],
  ]);
}

export const atlasLeadershipAnswerSchema = atlasLeadershipAnswerFactsSchema.extend({
  detailClaims: z.array(atlasDetailClaimSchema).max(7).optional(),
  comparisonClaims: leadershipComparisonClaimsSchema.optional(),
}).refine(({ jiraBlocker, projectId, asOf }) => !jiraBlocker ||
  (jiraBlocker.claim.projectId === projectId && jiraBlocker.claim.assessedAt === asOf))
  .refine(({ scheduleCitation, schedule, canonicalCreationReceiptId }) => {
    if (!scheduleCitation && !canonicalCreationReceiptId) return true;
    const days = reviewedMovementDays(schedule);
    return scheduleCitation ? days !== null && days === schedule?.movementDays : !schedule || days === schedule.movementDays;
  })
  .refine((answer) => JSON.stringify(answer.receiptClaims ?? []) === JSON.stringify(composeAtlasReceiptClaims(answer)))
  .refine((answer) => {
    const expected = composeAtlasDetailClaims(answer);
    return (!answer.integrationStart || Boolean(answer.canonicalCreationReceiptId)) &&
      (!answer.forecastInference || expected.some(({ kind }) => kind === "FORECAST_INFERENCE")) &&
      JSON.stringify(answer.detailClaims ?? []) === JSON.stringify(expected);
  })
  .refine(({ projectId, asOf, updateFreshness, updateClaim }) =>
    matchesLeadershipUpdateClaim({ projectId, asOf }, updateFreshness ?? null, updateClaim ?? null))
  .refine((facts) => {
    const prior = facts.priorSnapshot?.facts;
    if (prior && (prior.projectId !== facts.projectId || !prior.schedule || !prior.ownerReply || !prior.receipt ||
        Date.parse(prior.asOf) > Date.parse(facts.asOf) || Date.parse(prior.ownerReply.availableUntil) <= Date.parse(facts.asOf) ||
        (prior.scheduleCitation && Date.parse(prior.scheduleCitation.availableUntil) <= Date.parse(facts.asOf)))) return false;
    return Boolean(prior) === Boolean(facts.comparisonClaims) &&
      JSON.stringify(facts.comparisonClaims ?? []) === JSON.stringify(composeAtlasComparisonClaims(facts));
  });
export type AtlasLeadershipAnswer = z.infer<typeof atlasLeadershipAnswerSchema>;

export const atlasManagementFactsSchema = atlasLeadershipFactsSchema.extend({
  schedule: atlasLeadershipFactsSchema.shape.schedule.unwrap(),
  ownerReply: atlasLeadershipFactsSchema.shape.ownerReply.unwrap(),
  receipt: atlasCommentReceiptSchema,
  delayAssessment: atlasLeadershipFactsSchema.shape.delayAssessment.default(null),
});
export const atlasManagementSnapshotSchema = atlasManagementFactsSchema.extend({
  id: z.uuid(),
  reportingPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  approvalState: z.enum(["DRAFT", "PENDING", "APPROVED", "REJECTED"]),
  approval: z.strictObject({
    requestId: z.uuid(),
    approver: canonicalSubjectSchema,
    decidedAt: z.iso.datetime().nullable(),
  }).nullable(),
  classification: z.literal("SYNTHETIC_INTERNAL"),
});
export type AtlasManagementSnapshot = z.infer<typeof atlasManagementSnapshotSchema>;
export const atlasManagementPreviewSchema = z.strictObject({
  snapshot: atlasManagementSnapshotSchema,
  highlights: z.array(z.string().min(1).max(240)).length(4),
});
export type AtlasManagementPreview = z.infer<typeof atlasManagementPreviewSchema>;
export const atlasManagementOutputSchema = atlasManagementPreviewSchema.extend({
  livePath: z.string().regex(/^\/\?project=[0-9a-f-]{36}$/u),
  powerpointBase64: z.string().max(196608).regex(/^UEsDB[A-Za-z0-9+/]+={0,2}$/u),
});
export type AtlasManagementOutput = z.infer<typeof atlasManagementOutputSchema>;
export const atlasReportApprovalRequestSchema = projectReportApprovalRequestSchema;
export const atlasReportVersionSchema = projectReportVersionSchema;
export const atlasReportDecisionSchema = projectReportDecisionSchema;
export const atlasReportRecipientSubject = "leader-atlas";
export const atlasReportDistributionReceiptSchema = atlasReportVersionSchema.extend({
  id: z.uuid(),
  recipient: z.literal(atlasReportRecipientSubject),
  distributedAt: z.iso.datetime(),
});
export type AtlasReportDistributionReceipt = z.infer<typeof atlasReportDistributionReceiptSchema>;
export const atlasReportReviewSchema = atlasManagementPreviewSchema.extend({
  distribution: atlasReportDistributionReceiptSchema.nullable(),
});
export const atlasDistributedReportSchema = atlasManagementOutputSchema.extend({
  distribution: atlasReportDistributionReceiptSchema,
});

export function suggestAtlasAccessStatus(reply: string): AtlasAccessStatus | null {
  // Match the fixture's explicit answer only. Other wording needs owner review.
  switch (reply.trim()) {
    case "Access is still pending from Infrastructure. They expect to provide it on Wednesday. I need two working days after access to complete the integration task.":
      return "ACCESS_PENDING";
    case "Infrastructure restored API access.":
      return "ACCESS_RESTORED";
    default:
      return null;
  }
}

export function atlasComment(status: AtlasAccessStatus): string {
  return status === "ACCESS_PENDING"
    ? "The Atlas owner confirmed that API access is still pending."
    : "The Atlas owner confirmed that API access has been restored.";
}
