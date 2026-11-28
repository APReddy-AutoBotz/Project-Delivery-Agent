import type { atlasCommentLimit, AtlasApprovalView, AtlasCommentReceipt, AtlasDelayAssessment, AtlasLeadershipAnswer, AtlasLeadershipFacts, AtlasManagementOutput, AtlasManagementPreview, AtlasReportDistributionReceipt, AtlasSchedule, ProjectDelayCauseConfirmation, ProjectDelayCauseEvidence, ProjectDelayClarification, ProjectDelayClarificationReview, ProjectLeadershipAnswer, ProjectManagementDraftOutput, ProjectUpdateRecipientRequestView, ProjectUpdateResponseReceipt } from "@pdaa/domain";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key)) && optional.every((key) => !Object.hasOwn(value, key) || actual.includes(key)) &&
    actual.every((key) => required.includes(key) || optional.includes(key));
};
const dense = (value: unknown, min: number, max: number): value is unknown[] => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
  return true;
};
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value);
const instant = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
};
const label = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max &&
  value.trim().length > 0 && !/[\p{Cc}\p{Surrogate}]/u.test(value) && new TextEncoder().encode(value).length <= max;
const subject = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200 &&
  // eslint-disable-next-line no-control-regex -- Match the wire subject label.
  /^\S(?:[^\u0000-\u001f\u007f]*\S)?$/.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
const stage = (value: unknown) => value === "REQUEST" || value === "REMINDER" || value === "ESCALATION";
const accessStatus = (value: unknown) => value === "ACCESS_PENDING" || value === "ACCESS_RESTORED";
const response = (value: unknown) => object(value) && keys(value, ["id", "submittedBy", "receivedAt", "correctsResponseId", "state", "contentState", "text"]) &&
  uuid(value.id) && subject(value.submittedBy) && instant(value.receivedAt) && (value.correctsResponseId === null || uuid(value.correctsResponseId)) &&
  value.state === "UNCONFIRMED" && (value.contentState === "PRESENT" || value.contentState === "EXPIRED") &&
  (value.text === null || typeof value.text === "string");

function escalation(value: unknown, capturedAt: string, stageKind: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!object(value) || !keys(value, ["asOf", "state", "impact", "originalRequestId", "entries"]) || !instant(value.asOf) ||
      stageKind !== "ESCALATION" || Date.parse(value.asOf) < Date.parse(capturedAt) ||
      (value.state !== "AVAILABLE" && value.state !== "UNAVAILABLE") || !dense(value.entries, 0, 20) ||
      (value.originalRequestId !== null && !uuid(value.originalRequestId))) return false;
  if (value.state === "UNAVAILABLE")
    return value.impact === "UNKNOWN" && value.originalRequestId === null && value.entries.length === 0;
  if (value.impact !== "UNKNOWN") {
    if (!object(value.impact)) return false;
    const { citation, ...dates } = value.impact;
    const impact = decodeAtlasSchedule(dates);
    if (!impact || impact.revision > 2147483647 || impact.movementDays === null ||
        impact.movementDays !== scheduleMovement(impact) ||
        (citation !== undefined && !validScheduleCitation(citation, value.asOf))) return false;
  }
  const requestIds = new Set<string>(), stageIds = new Set<string>();
  let previous: Record<string, unknown> | undefined;
  for (const [index, raw] of value.entries.entries()) {
    if (!object(raw) || !keys(raw, ["requestId", "stageId", "stageKind", "generation", "ordinal", "capturedAt", "contentExpiresAt", "contentState", "bodyProjection", "body"]) ||
        !uuid(raw.requestId) || !uuid(raw.stageId) || !stage(raw.stageKind) || !Number.isInteger(raw.generation) ||
        (raw.generation as number) < 1 || (raw.generation as number) > 2147483647 || !Number.isInteger(raw.ordinal) ||
        (raw.ordinal as number) < 0 || (raw.ordinal as number) > 2147483647 || !instant(raw.capturedAt) || !instant(raw.contentExpiresAt) ||
        (raw.contentState !== "PRESENT" && raw.contentState !== "EXPIRED" && raw.contentState !== "RESTRICTED") ||
        raw.bodyProjection !== "REVIEWER_NAMES_WITHHELD" || (raw.body !== null && (typeof raw.body !== "string" || !raw.body.length || raw.body.length > 65536)) ||
        Date.parse(raw.capturedAt) > Date.parse(value.asOf) || Date.parse(raw.contentExpiresAt) <= Date.parse(raw.capturedAt) ||
        (raw.stageKind === "REQUEST" ? raw.ordinal !== 0 : (raw.ordinal as number) < 1) ||
        (raw.contentState === "PRESENT" ? raw.body === null || Date.parse(raw.contentExpiresAt) <= Date.parse(value.asOf) : raw.body !== null) ||
        requestIds.has(raw.requestId) || stageIds.has(raw.stageId)) return false;
    if (index === 0 && (raw.requestId !== value.originalRequestId || raw.stageKind !== "REQUEST")) return false;
    if (index > 0 && raw.stageKind === "REQUEST") return false;
    if (previous && ((raw.generation as number) < (previous.generation as number) ||
        (raw.generation === previous.generation && (Date.parse(raw.capturedAt) < Date.parse(previous.capturedAt as string) ||
          (Date.parse(raw.capturedAt) === Date.parse(previous.capturedAt as string) && previous.stageKind !== "REQUEST" && raw.requestId <= (previous.requestId as string)))))) return false;
    requestIds.add(raw.requestId); stageIds.add(raw.stageId); previous = raw;
  }
  return value.entries.length > 0;
}

export function decodeInvitation(value: unknown): ProjectUpdateRecipientRequestView | null {
  if (!object(value) || !keys(value, ["requestId", "project", "stageKind", "dueAt", "capturedAt", "expiresAt", "body", "requiredFacts", "rawResponseReaders", "responses"], ["escalationContext", "atlasInterpretation", "clarification", "responseChoices"]) ||
      !uuid(value.requestId) || !object(value.project) || !keys(value.project, ["id", "code", "name"]) || !uuid(value.project.id) ||
      !label(value.project.code, 160) || !label(value.project.name, 160) || !stage(value.stageKind) ||
      !instant(value.dueAt) || !instant(value.capturedAt) || !instant(value.expiresAt) || typeof value.body !== "string" || !value.body.length || value.body.length > 65536 ||
      !dense(value.requiredFacts, 1, 100) ||
      !value.requiredFacts.every((fact: unknown) => object(fact) && keys(fact, ["factType", "label"]) && typeof fact.factType === "string" &&
        /^[a-z][a-z0-9_.-]{0,95}$/.test(fact.factType) && label(fact.label, 160)) ||
      !dense(value.rawResponseReaders, 0, 33) || !value.rawResponseReaders.every(subject) ||
      !dense(value.responses, 0, 20) || !value.responses.every(response) ||
      !escalation(value.escalationContext, value.capturedAt, value.stageKind)) return null;
  const choices = value.responseChoices;
  if (choices !== undefined && (!dense(choices, 1, 12) ||
      !choices.every((choice) => typeof choice === "string" && choice.length > 0 && choice.length <= 200 &&
        choice === choice.trim() && !/[\p{Cc}\p{Surrogate}\p{Zl}\p{Zp}]/u.test(choice)) ||
      new Set(choices).size !== choices.length)) return null;
  const atlas = value.atlasInterpretation;
  const latest = value.responses[0];
  const clarification = value.clarification;
  if (clarification !== undefined && (!object(clarification) || !keys(clarification, ["responseId", "question"]) ||
      !object(latest) || latest.id !== clarification.responseId || latest.contentState !== "PRESENT" ||
      !label(clarification.question, 160))) return null;
  if (atlas !== undefined && (!object(atlas) || !keys(atlas, ["responseId", "suggestedStatus"]) ||
      value.stageKind !== "REQUEST" || !object(latest) || latest.id !== atlas.responseId ||
      latest.contentState !== "PRESENT" ||
      !(atlas.suggestedStatus === "NEEDS_CLARIFICATION" || accessStatus(atlas.suggestedStatus)))) return null;
  return { ...value, escalationContext: value.escalationContext ?? null } as ProjectUpdateRecipientRequestView;
}

export function decodeAtlasCommentReceipt(value: unknown): AtlasCommentReceipt | null {
  if (!object(value) || !keys(value, ["id", "approvalId", "target", "fixtureRevision", "recordedAt", "result"]) ||
      !uuid(value.id) || !uuid(value.approvalId) || value.target !== "ATLAS-248" ||
      !Number.isSafeInteger(value.fixtureRevision) || Number(value.fixtureRevision) < 1 ||
      !instant(value.recordedAt) || value.result !== "SIMULATED") return null;
  return value as AtlasCommentReceipt;
}

function decodeAtlasSchedule(value: unknown): AtlasSchedule | null {
  if (!object(value) || !keys(value, ["revision", "baseline", "forecast", "movementDays"]) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      (value.baseline !== null && !date(value.baseline)) || (value.forecast !== null && !date(value.forecast)) ||
      !(value.movementDays === null || Number.isSafeInteger(value.movementDays))) return null;
  return value as AtlasSchedule;
}

const date = (value: unknown): value is string => typeof value === "string" && instant(value + "T00:00:00.000Z");
const scheduleMovement = ({ baseline, forecast }: AtlasSchedule) => baseline && forecast
  ? (Date.parse(forecast) - Date.parse(baseline)) / 86400000 : null;
const validScheduleCitation = (value: unknown, asOf: string) => object(value) &&
  keys(value, ["sourceId", "receiptId", "reviewedAt", "availableUntil"]) &&
  uuid(value.sourceId) && uuid(value.receiptId) && instant(value.reviewedAt) && instant(value.availableUntil) &&
  Date.parse(value.reviewedAt) <= Date.parse(asOf) && Date.parse(value.availableUntil) > Date.parse(asOf);

function validProjectLeadershipFacts(value: Record<string, unknown>, currentAnswer = false): value is Record<string, unknown> & { asOf: string } {
  if (!instant(value.asOf)) return false;
  if (value.schedule !== null) {
    const schedule = decodeAtlasSchedule(value.schedule);
    if (!schedule) return false;
    if (schedule.movementDays !== scheduleMovement(schedule)) return false;
  }
  const freshness = value.updateFreshness;
  return freshness === null || (object(freshness) &&
    keys(freshness, ["state", "assessedAt", "sourceDate", "sourceDateField", "assessmentId", "openObligation"], currentAnswer ? ["obligationId"] : []) &&
    uuid(freshness.assessmentId) && instant(freshness.assessedAt) && instant(freshness.sourceDate) &&
    Date.parse(freshness.sourceDate) <= Date.parse(freshness.assessedAt) && Date.parse(freshness.assessedAt) <= Date.parse(value.asOf) &&
    (freshness.state === "CURRENT" || freshness.state === "STALE") &&
    (freshness.sourceDateField === "project.createdAt" || freshness.sourceDateField === "project.latestValidUpdateAt") &&
    typeof freshness.openObligation === "boolean" &&
    (!currentAnswer || (freshness.openObligation ? uuid(freshness.obligationId) : freshness.obligationId === undefined)));
}

const leadershipFactKeys = ["asOf", "schedule", "updateFreshness"];

function matchesReadClaim(value: unknown, projectId: string, asOf: string): value is Record<string, unknown> {
  return object(value) && value.projectId === projectId && value.asOf === asOf &&
    value.provenance === "SYSTEM_VERIFIED" && value.conflict === "NONE";
}

function validProjectLeadershipClaims(value: Record<string, unknown> & { asOf: string }, projectId: string) {
  const { scheduleClaim, updateClaim, updateFreshness } = value;
  const common = ["projectId", "asOf", "claimText", "provenance", "conflict", "evidenceIds", "freshness", "classification"];
  if (scheduleClaim !== null) {
    const schedule = decodeAtlasSchedule(value.schedule);
    if (!schedule || !matchesReadClaim(scheduleClaim, projectId, value.asOf) ||
        !keys(scheduleClaim, [...common, "scheduleRevision"]) || scheduleClaim.scheduleRevision !== schedule.revision ||
        scheduleClaim.claimText !== atlasScheduleMovementText(schedule.movementDays) ||
        scheduleClaim.freshness !== "CURRENT" || scheduleClaim.classification !== "SYSTEM_VERIFIED" ||
        !dense(scheduleClaim.evidenceIds, 1, 1) || !uuid(scheduleClaim.evidenceIds[0])) return false;
  }
  if (updateFreshness === null) return updateClaim === null;
  if (!object(updateFreshness) || !matchesReadClaim(updateClaim, projectId, value.asOf) ||
      !keys(updateClaim, [...common, "policyRevisionId", "assessedAt"]) || !uuid(updateClaim.policyRevisionId)) return false;
  const stale = updateFreshness.state === "STALE";
  const expectedText = `The latest saved assessment found the project ${stale ? "stale" : "current"} under its update policy.`
    + (updateFreshness.openObligation ? " A project update remains due." : "");
  const evidence = updateClaim.evidenceIds;
  const length = updateFreshness.openObligation ? 2 : 1;
  return updateClaim.claimText === expectedText && updateClaim.assessedAt === updateFreshness.assessedAt &&
    updateClaim.freshness === updateFreshness.state && updateClaim.classification === (stale ? "STALE" : "SYSTEM_VERIFIED") &&
    dense(evidence, length, length) && evidence[0] === updateFreshness.assessmentId &&
    (length === 1 || (evidence[1] === updateFreshness.obligationId && evidence[1] !== evidence[0]));
}

function matchesSettledClaim(value: unknown, projectId: string, asOf: string, provenance: "SYSTEM_VERIFIED" | "HUMAN_CONFIRMED", text: string) {
  return object(value) && keys(value, ["claimText", "projectId", "factId", "versionId", "evidenceIds", "policyRevisionId",
    "assessedAt", "validUntil", "provenance", "freshness", "conflict", "classification"]) &&
    value.projectId === projectId && value.assessedAt === asOf && value.provenance === provenance && value.classification === provenance &&
    value.freshness === "CURRENT" && value.conflict === "NONE" && value.claimText === text &&
    (value.validUntil === null || (instant(value.validUntil) && Date.parse(value.validUntil) > Date.parse(asOf))) &&
    uuid(value.factId) && uuid(value.versionId) && uuid(value.policyRevisionId) &&
    dense(value.evidenceIds, 1, 64) && value.evidenceIds.every(uuid) && new Set(value.evidenceIds).size === value.evidenceIds.length;
}

export function decodeProjectLeadershipAnswer(value: unknown, projectId: string): ProjectLeadershipAnswer | null {
  if (!object(value)) return null;
  if (value.state === "CLARIFY" && keys(value, ["state"])) return { state: "CLARIFY" };
  if (value.projectId !== projectId || !validProjectLeadershipFacts(value, value.state === "ANSWERED")) return null;
  const required = ["state", "projectId", ...leadershipFactKeys];
  const currentRequired = [...required, "cause", "scheduleClaim", "updateClaim"];
  if (value.state === "ANSWERED" && !validProjectLeadershipClaims(value, projectId)) return null;
  if (value.state === "ANSWERED" && value.cause === "UNKNOWN" && keys(value, currentRequired, ["pendingDelayClarification"])) {
    if (value.pendingDelayClarification !== undefined) {
      const pending = decodeProjectDelayClarification(value.pendingDelayClarification);
      const schedule = decodeAtlasSchedule(value.schedule);
      if (!pending || !schedule || pending.schedule.revision !== schedule.revision || pending.schedule.baseline !== schedule.baseline ||
          pending.schedule.forecast !== schedule.forecast || Date.parse(pending.requestedAt) > Date.parse(value.asOf)) return null;
    }
    return value as ProjectLeadershipAnswer;
  }
  const delay = value.delayCause;
  if (value.state === "ANSWERED" && value.cause === "HUMAN_CONFIRMED" && keys(value, [...currentRequired, "delayCause"]) &&
      object(delay) && keys(delay, ["evidence", "confirmation", "claim"])) {
    const evidence = decodeProjectDelayCauseEvidence(delay.evidence);
    const confirmation = decodeProjectDelayCauseConfirmation(delay.confirmation);
    const schedule = decodeAtlasSchedule(value.schedule);
    const claim = delay.claim;
    return evidence && confirmation && evidence.versionId === confirmation.versionId && object(claim) &&
      matchesSettledClaim(claim, projectId, value.asOf, "HUMAN_CONFIRMED", `PM-confirmed delay cause · ${evidence.value}`) &&
      claim.factId === evidence.factId && claim.versionId === evidence.versionId &&
      dense(claim.evidenceIds, 1, 1) && claim.evidenceIds[0] === evidence.evidenceId &&
      (schedule?.movementDays ?? 0) > 0 && Date.parse(evidence.observedAt) <= Date.parse(confirmation.confirmedAt) &&
      Date.parse(confirmation.confirmedAt) <= Date.parse(value.asOf) ? value as ProjectLeadershipAnswer : null;
  }
  const prior = value.priorSnapshot;
  if (value.state !== "COMPARISON" || !keys(value, [...required, "priorSnapshot"]) || !object(prior) ||
      !keys(prior, ["id", ...leadershipFactKeys]) || !uuid(prior.id) || !validProjectLeadershipFacts(prior) ||
      Date.parse(prior.asOf) > Date.parse(value.asOf)) return null;
  return value as ProjectLeadershipAnswer;
}

export function decodeProjectDelayClarification(value: unknown): ProjectDelayClarification | null {
  if (!object(value) || !keys(value, ["id", "requestedAt", "schedule"]) || !uuid(value.id) || !instant(value.requestedAt))
    return null;
  const schedule = decodeAtlasSchedule(value.schedule);
  return schedule?.baseline && schedule.forecast && (schedule.movementDays ?? 0) > 0 &&
    schedule.movementDays === (Date.parse(schedule.forecast) - Date.parse(schedule.baseline)) / 86400000
    ? { id: value.id, requestedAt: value.requestedAt, schedule } : null;
}
export const decodeAtlasDelayClarification = decodeProjectDelayClarification;

function decodeProjectDelayCauseEvidence(value: unknown): ProjectDelayCauseEvidence | null {
  if (!object(value) || !keys(value, ["factId", "versionId", "evidenceId", "observedAt", "value"]) ||
      !uuid(value.factId) || !uuid(value.versionId) || !uuid(value.evidenceId) || !instant(value.observedAt) ||
      typeof value.value !== "string" || value.value.length > 500 || !value.value.trim() || /[\0\p{Surrogate}]/u.test(value.value)) return null;
  return value as ProjectDelayCauseEvidence;
}

export function decodeProjectDelayCauseConfirmation(value: unknown): ProjectDelayCauseConfirmation | null {
  if (!object(value) || !keys(value, ["id", "clarificationId", "versionId", "confirmedAt"]) || !uuid(value.id) ||
      !uuid(value.clarificationId) || !uuid(value.versionId) || !instant(value.confirmedAt)) return null;
  return value as ProjectDelayCauseConfirmation;
}

export function decodeProjectDelayClarificationReview(value: unknown): ProjectDelayClarificationReview | null {
  if (!object(value)) return null;
  const { causeEvidence: rawEvidence, confirmation: rawConfirmation, ...request } = value;
  const clarification = decodeProjectDelayClarification(request);
  const causeEvidence = decodeProjectDelayCauseEvidence(rawEvidence);
  const confirmation = decodeProjectDelayCauseConfirmation(rawConfirmation);
  if (!clarification || (rawEvidence !== null && !causeEvidence) || (rawConfirmation !== null && !confirmation) ||
      (confirmation && (confirmation.clarificationId !== clarification.id || confirmation.versionId !== causeEvidence?.versionId ||
        Date.parse(confirmation.confirmedAt) < Date.parse(clarification.requestedAt) ||
        Date.parse(confirmation.confirmedAt) < Date.parse(causeEvidence.observedAt)))) return null;
  return { ...clarification, causeEvidence, confirmation };
}

export function decodeAtlasDelayAssessment(value: unknown): AtlasDelayAssessment | null {
  if (!object(value) || !keys(value, ["approvalId", "receiptId", "scheduleRevision", "cause", "confidence", "id", "confirmedBy", "confirmedAt"]) ||
      !uuid(value.approvalId) || !uuid(value.receiptId) || !uuid(value.id) || !subject(value.confirmedBy) ||
      !instant(value.confirmedAt) || !Number.isSafeInteger(value.scheduleRevision) || Number(value.scheduleRevision) < 1 ||
      value.cause !== "API_ACCESS_DELAY" || !(value.confidence === "MEDIUM" || value.confidence === "LOW" || value.confidence === "UNKNOWN")) return null;
  return value as AtlasDelayAssessment;
}

function matchesAtlasDelay(assessment: AtlasDelayAssessment, schedule: AtlasSchedule, receipt: AtlasCommentReceipt, expiresAt: string) {
  return (schedule.movementDays ?? 0) > 0 && assessment.scheduleRevision === schedule.revision &&
    assessment.approvalId === receipt.approvalId && assessment.receiptId === receipt.id &&
    Date.parse(assessment.confirmedAt) >= Date.parse(receipt.recordedAt) && Date.parse(assessment.confirmedAt) < Date.parse(expiresAt);
}

export const atlasCommentMaxLength: typeof atlasCommentLimit = 500;
export const validAtlasApprovalComment = (value: unknown) => label(value, atlasCommentMaxLength);

export function decodeAtlasApproval(value: unknown): AtlasApprovalView | null {
  if (!object(value) || !keys(value, ["approvalId", "responseId", "replyReceivedAt", "confirmedBy", "approver",
    "accessStatus", "target", "currentComment", "proposedComment", "sourceRevision", "expiresAt", "decision", "receipt"], ["delayReview", "replacesApprovalId", "executionPending"]) ||
    !uuid(value.approvalId) || !uuid(value.responseId) || !instant(value.replyReceivedAt) || !instant(value.expiresAt) ||
    !subject(value.confirmedBy) || !subject(value.approver) || !accessStatus(value.accessStatus) ||
    value.target !== "ATLAS-248" || !(value.currentComment === null || validAtlasApprovalComment(value.currentComment)) ||
    !validAtlasApprovalComment(value.proposedComment) || !Number.isSafeInteger(value.sourceRevision) || Number(value.sourceRevision) < 0 ||
    (value.replacesApprovalId !== undefined && (!uuid(value.replacesApprovalId) || value.replacesApprovalId === value.approvalId)) ||
    (value.executionPending !== undefined && (value.executionPending !== true || value.decision !== "APPROVED" || value.receipt !== null)) ||
    !(value.decision === "PENDING" || value.decision === "APPROVED" || value.decision === "REJECTED")) return null;
  const receipt = decodeAtlasCommentReceipt(value.receipt);
  if (value.receipt !== null) {
    if (!receipt || value.decision !== "APPROVED" || receipt.approvalId !== value.approvalId ||
        receipt.fixtureRevision !== Number(value.sourceRevision) + 1) return null;
  }
  const review = value.delayReview;
  if (review !== undefined && review !== null) {
    if (!object(review) || !keys(review, ["schedule", "assessment"]) || !receipt || value.accessStatus !== "ACCESS_PENDING") return null;
    const schedule = decodeAtlasSchedule(review.schedule);
    if (!schedule || (schedule.movementDays ?? 0) <= 0) return null;
    if (review.assessment !== null) {
      const assessment = decodeAtlasDelayAssessment(review.assessment);
      if (!assessment || assessment.confirmedBy !== value.approver || !matchesAtlasDelay(assessment, schedule, receipt, value.expiresAt)) return null;
    }
  }
  return value as AtlasApprovalView;
}

function decodeAtlasLeadershipFacts(value: unknown, projectId: string): AtlasLeadershipFacts | null {
  if (!object(value) || !keys(value, ["projectId", "asOf", "schedule", "ownerReply", "receipt", "delayAssessment"], ["scheduleCitation"]) ||
      value.projectId !== projectId || !instant(value.asOf)) return null;
  const schedule = decodeAtlasSchedule(value.schedule);
  if (value.schedule !== null && !schedule) return null;
  const citation = value.scheduleCitation;
  if (citation !== undefined && (!schedule?.baseline || !schedule.forecast || !validScheduleCitation(citation, value.asOf))) return null;
  const reply = value.ownerReply;
  if (reply !== null && (!object(reply) || !keys(reply, ["responseId", "receivedAt", "availableUntil", "accessStatus"]) ||
      !uuid(reply.responseId) || !instant(reply.receivedAt) || !instant(reply.availableUntil) ||
      Date.parse(reply.availableUntil) <= Date.parse(value.asOf) || !accessStatus(reply.accessStatus))) return null;
  const receipt = decodeAtlasCommentReceipt(value.receipt);
  if (value.receipt !== null && (reply === null || !receipt)) return null;
  if (value.delayAssessment !== null) {
    const assessment = decodeAtlasDelayAssessment(value.delayAssessment);
    if (!assessment || !receipt || !schedule || !object(reply) || reply.accessStatus !== "ACCESS_PENDING" ||
        !instant(reply.availableUntil) || !matchesAtlasDelay(assessment, schedule, receipt, reply.availableUntil) ||
        Date.parse(assessment.confirmedAt) > Date.parse(value.asOf)) return null;
  }
  return value as AtlasLeadershipFacts;
}

export function atlasScheduleMovementText(days: number | null) {
  return days === null ? "Schedule movement is unavailable."
    : days === 0 ? "The baseline and forecast dates match."
      : `The forecast is ${Math.abs(days)} ${Math.abs(days) === 1 ? "day" : "days"} ${days > 0 ? "later" : "earlier"} than the baseline.`;
}

function matchesAtlasReceiptClaims(value: unknown, answer: AtlasLeadershipFacts) {
  const { schedule, scheduleCitation, delayAssessment, receipt, ownerReply } = answer;
  const claims = value === undefined ? [] : value;
  if (!Array.isArray(claims) || claims.length > 2) return false;
  let expected = 0;
  const match = (claim: unknown, kind: string, text: string, evidenceIds: string[], validUntil: string,
    provenance: string, proofKey: "sourceId" | "assessmentId", proofId: string) =>
    object(claim) && keys(claim, ["kind", "claimText", "evidenceIds", "validUntil", "projectId", "scheduleRevision",
      "assessedAt", "provenance", "classification", "freshness", "conflict", proofKey]) &&
      claim.kind === kind && claim.claimText === text && claim.validUntil === validUntil &&
      claim.projectId === answer.projectId && claim.scheduleRevision === schedule?.revision &&
      claim.assessedAt === answer.asOf && claim.provenance === provenance && claim.classification === provenance &&
      claim.freshness === "CURRENT" && claim.conflict === "NONE" && claim[proofKey] === proofId &&
      Array.isArray(claim.evidenceIds) && claim.evidenceIds.length === evidenceIds.length &&
      claim.evidenceIds.every((id, index) => evidenceIds[index] === id);
  if (schedule && scheduleCitation) {
    const movement = scheduleMovement(schedule);
    if (movement === null || movement !== schedule.movementDays || !match(claims[expected++], "REVIEWED_SCHEDULE",
        atlasScheduleMovementText(movement), [scheduleCitation.receiptId], scheduleCitation.availableUntil,
        "SYSTEM_VERIFIED", "sourceId", scheduleCitation.sourceId)) return false;
  }
  if (schedule && delayAssessment && receipt && ownerReply) {
    const deadline = scheduleCitation && Date.parse(scheduleCitation.availableUntil) < Date.parse(ownerReply.availableUntil)
      ? scheduleCitation.availableUntil : ownerReply.availableUntil;
    if (!match(claims[expected++], "PM_DELAY_ASSESSMENT",
        `The PM confirmed that delayed API access caused the go-live delay. The PM assessed forecast confidence as ${delayAssessment.confidence.toLowerCase()}.`,
        [delayAssessment.id, receipt.id], deadline, "HUMAN_CONFIRMED", "assessmentId", delayAssessment.id)) return false;
  }
  return claims.length === expected;
}

export function decodeAtlasLeadershipAnswer(value: unknown, projectId: string): AtlasLeadershipAnswer | null {
  if (!object(value)) return null;
  const { integrationStart, jiraBlocker, forecastInference, pmEscalation, priorSnapshot,
    updateFreshness, delayClarificationState, receiptClaims, ...facts } = value;
  const answer = decodeAtlasLeadershipFacts(facts, projectId);
  if (!answer || !matchesAtlasReceiptClaims(receiptClaims, answer)) return null;
  if (delayClarificationState !== undefined && (!answer.schedule || (answer.schedule.movementDays ?? 0) <= 0 || answer.delayAssessment ||
      typeof delayClarificationState !== "string" || !["AVAILABLE", "REQUESTED", "RESOLVED"].includes(delayClarificationState))) return null;
  if (updateFreshness !== null && updateFreshness !== undefined && (!object(updateFreshness) ||
      !keys(updateFreshness, ["assessmentId", "state", "assessedAt", "sourceDate", "sourceDateField", "openObligation"],
        ["obligationId", "activeClarification"]) || !uuid(updateFreshness.assessmentId) ||
      (updateFreshness.state !== "CURRENT" && updateFreshness.state !== "STALE") ||
      (updateFreshness.sourceDateField !== "project.createdAt" && updateFreshness.sourceDateField !== "project.latestValidUpdateAt") ||
      !instant(updateFreshness.assessedAt) || !instant(updateFreshness.sourceDate) ||
      Date.parse(updateFreshness.sourceDate) > Date.parse(updateFreshness.assessedAt) ||
      Date.parse(updateFreshness.assessedAt) > Date.parse(answer.asOf) ||
      typeof updateFreshness.openObligation !== "boolean" ||
      (updateFreshness.openObligation ? !uuid(updateFreshness.obligationId) : updateFreshness.obligationId !== undefined))) return null;
  const clarification = object(updateFreshness) ? updateFreshness.activeClarification : undefined;
  if (clarification !== undefined && (!object(updateFreshness) || updateFreshness.state !== "STALE" || !updateFreshness.openObligation ||
      !object(clarification) || !keys(clarification, ["clarificationId", "factType", "requestedAt", "availableUntil"]) ||
      !uuid(clarification.clarificationId) || (clarification.factType !== "project.status" && clarification.factType !== "project.forecast") ||
      !instant(clarification.requestedAt) || !instant(clarification.availableUntil) ||
      Date.parse(clarification.requestedAt) > Date.parse(answer.asOf) || Date.parse(clarification.availableUntil) <= Date.parse(answer.asOf)))
    return null;
  if (integrationStart !== null && (!object(integrationStart) ||
      !keys(integrationStart, ["milestoneId", "planned", "actual"]) || !uuid(integrationStart.milestoneId) ||
      !date(integrationStart.planned) || !date(integrationStart.actual) || integrationStart.actual <= integrationStart.planned))
    return null;
  if (jiraBlocker !== null && (!object(jiraBlocker) || !keys(jiraBlocker, ["mappingId", "issueKey", "claim"]) ||
      !uuid(jiraBlocker.mappingId) || jiraBlocker.issueKey !== "ATLAS-248" ||
      !matchesSettledClaim(jiraBlocker.claim, projectId, answer.asOf, "SYSTEM_VERIFIED", "The synthetic Jira blocker ATLAS-248 is open."))) return null;
  if (forecastInference !== undefined && (!object(forecastInference) ||
      !keys(forecastInference, ["classification", "scheduleRevision", "milestoneId", "blockerMappingId"]) ||
      forecastInference.classification !== "AGENT_INFERENCE" || !answer.schedule || (answer.schedule.movementDays ?? 0) <= 0 ||
      !object(integrationStart) || !object(jiraBlocker) || forecastInference.scheduleRevision !== answer.schedule.revision ||
      forecastInference.milestoneId !== integrationStart.milestoneId || forecastInference.blockerMappingId !== jiraBlocker.mappingId))
    return null;
  if (pmEscalation !== null && (!answer.ownerReply || !object(pmEscalation) ||
      !keys(pmEscalation, ["requestId", "capturedAt", "availableUntil"]) || !uuid(pmEscalation.requestId) ||
      !instant(pmEscalation.capturedAt) || !instant(pmEscalation.availableUntil) ||
      Date.parse(pmEscalation.capturedAt) > Date.parse(answer.asOf) || Date.parse(pmEscalation.availableUntil) <= Date.parse(answer.asOf)))
    return null;
  if (priorSnapshot !== undefined) {
    if (!object(priorSnapshot) || !keys(priorSnapshot, ["id", "facts"]) || !uuid(priorSnapshot.id)) return null;
    const prior = decodeAtlasLeadershipFacts(priorSnapshot.facts, projectId);
    if (!prior?.schedule || !prior.ownerReply || !prior.receipt || Date.parse(prior.asOf) > Date.parse(answer.asOf) ||
        Date.parse(prior.ownerReply.availableUntil) <= Date.parse(answer.asOf) ||
        (prior.scheduleCitation && prior.scheduleCitation.availableUntil <= answer.asOf)) return null;
  }
  return value as AtlasLeadershipAnswer;
}

export function decodeAtlasManagementPreview(value: unknown, projectId: string): AtlasManagementPreview | null {
  if (!object(value) || !keys(value, ["snapshot", "highlights"]) || !Array.isArray(value.highlights) ||
      value.highlights.length !== 4 || !value.highlights.every((entry) => label(entry, 240)) ||
      !object(value.snapshot)) return null;
  const { id, reportingPeriod, approvalState, approval, classification, ...evidence } = value.snapshot;
  const answer = decodeAtlasLeadershipFacts(evidence, projectId);
  if (!uuid(id) || !answer?.schedule || !answer.ownerReply || !answer.receipt ||
      reportingPeriod !== answer.asOf.slice(0, 7) || classification !== "SYNTHETIC_INTERNAL") return null;
  if (approvalState === "DRAFT") {
    if (approval !== null) return null;
  } else if (!object(approval) || !keys(approval, ["requestId", "approver", "decidedAt"]) ||
      !uuid(approval.requestId) || !subject(approval.approver) || (approvalState === "PENDING"
        ? approval.decidedAt !== null : !(approvalState === "APPROVED" || approvalState === "REJECTED") ||
          !instant(approval.decidedAt) || Date.parse(approval.decidedAt) < Date.parse(answer.asOf))) return null;
  return value as AtlasManagementPreview;
}

export function decodeAtlasManagementOutput(value: unknown, projectId: string): AtlasManagementOutput | null {
  if (!object(value)) return null;
  const { livePath, powerpointBase64, ...preview } = value;
  if (livePath !== `/?project=${projectId}` || typeof powerpointBase64 !== "string" || powerpointBase64.length > 196608 ||
      !/^UEsDB[A-Za-z0-9+/]+={0,2}$/u.test(powerpointBase64)) return null;
  const report = decodeAtlasManagementPreview(preview, projectId);
  return report ? { ...report, livePath, powerpointBase64 } : null;
}

export function decodeProjectManagementDraft(value: unknown, projectId: string): ProjectManagementDraftOutput | null {
  if (!object(value) || !keys(value, ["draft", "highlights", "livePath", "powerpointBase64"], ["snapshotId", "approval", "delivery", "digestHighlights"]) ||
      (value.snapshotId !== undefined && !uuid(value.snapshotId))) return null;
  const { draft, highlights, livePath, powerpointBase64, digestHighlights } = value;
  if (!object(draft) || !keys(draft, ["projectId", "asOf", "schedule", "updateFreshness", "project", "approvalState", "reportingPeriod"], ["digest"]) ||
      livePath !== `/?project=${projectId}` || typeof powerpointBase64 !== "string" || powerpointBase64.length > 160000 ||
      powerpointBase64.length % 4 !== 0 ||
      !/^UEsDB[A-Za-z0-9+/]+={0,2}$/u.test(powerpointBase64) ||
      !dense(highlights, 1, 4) || !highlights.every((line) => label(line, 400))) return null;
  const { approvalState, project, reportingPeriod, digest, ...facts } = draft;
  if (!object(project) || !keys(project, ["code", "name"]) ||
      ![project.code, project.name].every((value) =>
        typeof value === "string" && value.length <= 160 && label(value, 640))) return null;
  if (facts.projectId !== projectId || !validProjectLeadershipFacts(facts) ||
      approvalState !== "DRAFT" || reportingPeriod !== facts.asOf.slice(0, 7)) return null;
  if (digest !== undefined) {
    if (!object(digest) || !keys(digest, ["previousReport", "decisions", "moreDecisions"]) ||
        !dense(digestHighlights, 2, 8) ||
        !digestHighlights.every((line) => typeof line === "string" && line.length <= 400 && label(line, 1600)) ||
        typeof digest.moreDecisions !== "boolean" || !dense(digest.decisions, 0, 3) ||
        !digest.decisions.every((decision) => object(decision) && keys(decision, ["key", "title"]) &&
          typeof decision.key === "string" && decision.key.length <= 48 && label(decision.key, 192) &&
          typeof decision.title === "string" && decision.title.length <= 160 && label(decision.title, 640))) return null;
    const previous = digest.previousReport;
    if (previous !== null && (!object(previous) || !keys(previous, ["snapshotId", "asOf", "schedule", "freshnessState"]) ||
        !uuid(previous.snapshotId) || previous.snapshotId === value.snapshotId || !instant(previous.asOf) ||
        Date.parse(previous.asOf) > Date.parse(facts.asOf) ||
        (previous.schedule !== null && !decodeAtlasSchedule(previous.schedule)) ||
        ![null, "CURRENT", "STALE"].some((state) => state === previous.freshnessState))) return null;
  } else if (digestHighlights !== undefined) return null;
  const approval = value.approval;
  if (approval !== undefined) {
    if (!value.snapshotId || !object(approval) || !keys(approval, ["requestId", "requestedAt", "state", "decidedAt"]) ||
        !uuid(approval.requestId) || !instant(approval.requestedAt) || Date.parse(approval.requestedAt) < Date.parse(facts.asOf)) return null;
    if (approval.state === "PENDING" ? approval.decidedAt !== null :
        (approval.state !== "APPROVED" && approval.state !== "REJECTED") || !instant(approval.decidedAt) ||
        Date.parse(approval.decidedAt) < Date.parse(approval.requestedAt)) return null;
  }
  const delivery = value.delivery;
  if (delivery !== undefined && (!object(approval) || approval.state !== "APPROVED" || !instant(approval.decidedAt) ||
      !object(delivery) || !keys(delivery, ["id", "snapshotId", "requestId", "deliveredAt"]) || !uuid(delivery.id) ||
      delivery.snapshotId !== value.snapshotId || delivery.requestId !== approval.requestId ||
      !instant(delivery.deliveredAt) || Date.parse(delivery.deliveredAt) < Date.parse(approval.decidedAt))) return null;
  return value as ProjectManagementDraftOutput;
}

export function decodeAtlasDistributionReceipt(value: unknown): AtlasReportDistributionReceipt | null {
  if (!object(value) || !keys(value, ["id", "snapshotId", "requestId", "recipient", "distributedAt"]) ||
      !uuid(value.id) || !uuid(value.snapshotId) || !uuid(value.requestId) || value.recipient !== "leader-atlas" ||
      !instant(value.distributedAt)) return null;
  return value as AtlasReportDistributionReceipt;
}

function receiptMatchesReport(receipt: AtlasReportDistributionReceipt, { snapshot }: AtlasManagementPreview) {
  return snapshot.approvalState === "APPROVED" && snapshot.id === receipt.snapshotId &&
    snapshot.approval?.requestId === receipt.requestId && !!snapshot.approval.decidedAt &&
    Date.parse(receipt.distributedAt) >= Date.parse(snapshot.approval.decidedAt);
}

export function decodeAtlasReportReview(value: unknown, projectId: string) {
  if (!object(value)) return null;
  const { distribution, ...preview } = value;
  const report = decodeAtlasManagementPreview(preview, projectId);
  if (!report?.snapshot.approval) return null;
  if (distribution === null) return { ...report, distribution: null };
  const receipt = decodeAtlasDistributionReceipt(distribution);
  return receipt && receiptMatchesReport(receipt, report) ? { ...report, distribution: receipt } : null;
}

export function decodeAtlasDistributedReport(value: unknown, projectId: string) {
  if (!object(value)) return null;
  const { distribution, ...output } = value;
  const report = decodeAtlasManagementOutput(output, projectId);
  const receipt = decodeAtlasDistributionReceipt(distribution);
  return report && receipt && receiptMatchesReport(receipt, report) ? { ...report, distribution: receipt } : null;
}

export function decodeInvitationReceipt(value: unknown, requestId: string): ProjectUpdateResponseReceipt | null {
  if (!object(value) || !keys(value, ["responseId", "requestId", "receivedAt", "state", "message"]) ||
      !uuid(value.responseId) || !uuid(value.requestId) || value.requestId.toLowerCase() !== requestId.toLowerCase() ||
      !instant(value.receivedAt) || value.state !== "UNCONFIRMED" ||
      value.message !== "Response recorded; required facts remain unconfirmed.") return null;
  return value as ProjectUpdateResponseReceipt;
}
