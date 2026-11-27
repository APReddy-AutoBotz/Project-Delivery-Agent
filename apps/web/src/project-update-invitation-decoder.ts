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
      stageKind !== "ESCALATION" || Date.parse(value.asOf) < Date.parse(capturedAt) || value.impact !== "UNKNOWN" ||
      (value.state !== "AVAILABLE" && value.state !== "UNAVAILABLE") || !dense(value.entries, 0, 20) ||
      (value.originalRequestId !== null && !uuid(value.originalRequestId))) return false;
  if (value.state === "UNAVAILABLE") return value.originalRequestId === null && value.entries.length === 0;
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
  if (!object(value) || !keys(value, ["requestId", "project", "stageKind", "dueAt", "capturedAt", "expiresAt", "body", "requiredFacts", "rawResponseReaders", "responses"], ["escalationContext", "atlasInterpretation", "clarification"]) ||
      !uuid(value.requestId) || !object(value.project) || !keys(value.project, ["id", "code", "name"]) || !uuid(value.project.id) ||
      !label(value.project.code, 160) || !label(value.project.name, 160) || !stage(value.stageKind) ||
      !instant(value.dueAt) || !instant(value.capturedAt) || !instant(value.expiresAt) || typeof value.body !== "string" || !value.body.length || value.body.length > 65536 ||
      !dense(value.requiredFacts, 1, 100) ||
      !value.requiredFacts.every((fact: unknown) => object(fact) && keys(fact, ["factType", "label"]) && typeof fact.factType === "string" &&
        /^[a-z][a-z0-9_.-]{0,95}$/.test(fact.factType) && label(fact.label, 160)) ||
      !dense(value.rawResponseReaders, 0, 33) || !value.rawResponseReaders.every(subject) ||
      !dense(value.responses, 0, 20) || !value.responses.every(response) ||
      !escalation(value.escalationContext, value.capturedAt, value.stageKind)) return null;
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

function validProjectLeadershipFacts(value: Record<string, unknown>): value is Record<string, unknown> & { asOf: string } {
  if (!instant(value.asOf)) return false;
  if (value.schedule !== null) {
    const schedule = decodeAtlasSchedule(value.schedule);
    if (!schedule) return false;
    const movement = schedule.baseline && schedule.forecast
      ? (Date.parse(schedule.forecast) - Date.parse(schedule.baseline)) / 86400000 : null;
    if (schedule.movementDays !== movement) return false;
  }
  const freshness = value.updateFreshness;
  return freshness === null || (object(freshness) && keys(freshness, ["state", "assessedAt", "sourceDate", "sourceDateField", "assessmentId", "openObligation"]) &&
    uuid(freshness.assessmentId) && instant(freshness.assessedAt) && instant(freshness.sourceDate) &&
    Date.parse(freshness.sourceDate) <= Date.parse(freshness.assessedAt) && Date.parse(freshness.assessedAt) <= Date.parse(value.asOf) &&
    (freshness.state === "CURRENT" || freshness.state === "STALE") &&
    (freshness.sourceDateField === "project.createdAt" || freshness.sourceDateField === "project.latestValidUpdateAt") &&
    typeof freshness.openObligation === "boolean");
}

const leadershipFactKeys = ["asOf", "schedule", "updateFreshness"];

export function decodeProjectLeadershipAnswer(value: unknown, projectId: string): ProjectLeadershipAnswer | null {
  if (!object(value)) return null;
  if (value.state === "CLARIFY" && keys(value, ["state"])) return { state: "CLARIFY" };
  if (value.projectId !== projectId || !validProjectLeadershipFacts(value)) return null;
  const required = ["state", "projectId", ...leadershipFactKeys];
  if (value.state === "ANSWERED" && value.cause === "UNKNOWN" && keys(value, [...required, "cause"]))
    return value as ProjectLeadershipAnswer;
  const delay = value.delayCause;
  if (value.state === "ANSWERED" && value.cause === "HUMAN_CONFIRMED" && keys(value, [...required, "cause", "delayCause"]) &&
      object(delay) && keys(delay, ["evidence", "confirmation"])) {
    const evidence = decodeProjectDelayCauseEvidence(delay.evidence);
    const confirmation = decodeProjectDelayCauseConfirmation(delay.confirmation);
    const schedule = decodeAtlasSchedule(value.schedule);
    return evidence && confirmation && evidence.versionId === confirmation.versionId &&
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
  if (!object(value) || !keys(value, ["projectId", "asOf", "schedule", "ownerReply", "receipt", "delayAssessment"]) ||
      value.projectId !== projectId || !instant(value.asOf)) return null;
  const schedule = decodeAtlasSchedule(value.schedule);
  if (value.schedule !== null && !schedule) return null;
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

export function decodeAtlasLeadershipAnswer(value: unknown, projectId: string): AtlasLeadershipAnswer | null {
  if (!object(value)) return null;
  const { integrationStart, jiraBlocker, pmEscalation, priorSnapshot, updateFreshness, delayClarificationState, ...facts } = value;
  const answer = decodeAtlasLeadershipFacts(facts, projectId);
  if (!answer) return null;
  if (delayClarificationState !== undefined && (!answer.schedule || (answer.schedule.movementDays ?? 0) <= 0 || answer.delayAssessment ||
      typeof delayClarificationState !== "string" || !["AVAILABLE", "REQUESTED", "RESOLVED"].includes(delayClarificationState))) return null;
  if (updateFreshness !== null && updateFreshness !== undefined && (!object(updateFreshness) ||
      !keys(updateFreshness, ["state", "assessedAt", "sourceDate", "sourceDateField", "openObligation"], ["activeClarification"]) ||
      (updateFreshness.state !== "CURRENT" && updateFreshness.state !== "STALE") ||
      (updateFreshness.sourceDateField !== "project.createdAt" && updateFreshness.sourceDateField !== "project.latestValidUpdateAt") ||
      !instant(updateFreshness.assessedAt) || !instant(updateFreshness.sourceDate) ||
      Date.parse(updateFreshness.sourceDate) > Date.parse(updateFreshness.assessedAt) ||
      Date.parse(updateFreshness.assessedAt) > Date.parse(answer.asOf) ||
      typeof updateFreshness.openObligation !== "boolean")) return null;
  const clarification = object(updateFreshness) ? updateFreshness.activeClarification : undefined;
  if (clarification !== undefined && (!object(updateFreshness) || updateFreshness.state !== "STALE" || !updateFreshness.openObligation ||
      !object(clarification) || !keys(clarification, ["clarificationId", "factType", "requestedAt", "availableUntil"]) ||
      !uuid(clarification.clarificationId) || (clarification.factType !== "project.status" && clarification.factType !== "project.forecast") ||
      !instant(clarification.requestedAt) || !instant(clarification.availableUntil) ||
      Date.parse(clarification.requestedAt) > Date.parse(answer.asOf) || Date.parse(clarification.availableUntil) <= Date.parse(answer.asOf)))
    return null;
  if (integrationStart !== null && (!answer.schedule || !object(integrationStart) ||
      !keys(integrationStart, ["milestoneId", "planned", "actual"]) || !uuid(integrationStart.milestoneId) ||
      !date(integrationStart.planned) || !date(integrationStart.actual) || integrationStart.actual <= integrationStart.planned))
    return null;
  if (jiraBlocker !== null && (!answer.schedule || !object(jiraBlocker) || !keys(jiraBlocker, ["mappingId", "issueKey"]) ||
      !uuid(jiraBlocker.mappingId) || jiraBlocker.issueKey !== "ATLAS-248")) return null;
  if (pmEscalation !== null && (!answer.ownerReply || !object(pmEscalation) ||
      !keys(pmEscalation, ["requestId", "capturedAt", "availableUntil"]) || !uuid(pmEscalation.requestId) ||
      !instant(pmEscalation.capturedAt) || !instant(pmEscalation.availableUntil) ||
      Date.parse(pmEscalation.capturedAt) > Date.parse(answer.asOf) || Date.parse(pmEscalation.availableUntil) <= Date.parse(answer.asOf)))
    return null;
  if (priorSnapshot !== undefined) {
    if (!object(priorSnapshot) || !keys(priorSnapshot, ["id", "facts"]) || !uuid(priorSnapshot.id)) return null;
    const prior = decodeAtlasLeadershipFacts(priorSnapshot.facts, projectId);
    if (!prior?.schedule || !prior.ownerReply || !prior.receipt || Date.parse(prior.asOf) > Date.parse(answer.asOf) ||
        Date.parse(prior.ownerReply.availableUntil) <= Date.parse(answer.asOf)) return null;
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
  const answer = decodeProjectLeadershipAnswer({ ...facts, state: "ANSWERED", cause: "UNKNOWN" }, projectId);
  if (answer?.state !== "ANSWERED" || approvalState !== "DRAFT" || reportingPeriod !== answer.asOf.slice(0, 7)) return null;
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
        Date.parse(previous.asOf) > Date.parse(answer.asOf) ||
        (previous.schedule !== null && !decodeAtlasSchedule(previous.schedule)) ||
        ![null, "CURRENT", "STALE"].some((state) => state === previous.freshnessState))) return null;
  } else if (digestHighlights !== undefined) return null;
  const approval = value.approval;
  if (approval !== undefined) {
    if (!value.snapshotId || !object(approval) || !keys(approval, ["requestId", "requestedAt", "state", "decidedAt"]) ||
        !uuid(approval.requestId) || !instant(approval.requestedAt) || Date.parse(approval.requestedAt) < Date.parse(answer.asOf)) return null;
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
