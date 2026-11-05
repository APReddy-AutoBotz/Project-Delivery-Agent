import type { ProjectUpdateRecipientRequestView, ProjectUpdateResponseReceipt } from "@pdaa/domain";

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
  if (!object(value) || !keys(value, ["requestId", "project", "stageKind", "dueAt", "capturedAt", "expiresAt", "body", "requiredFacts", "rawResponseReaders", "responses"], ["escalationContext"]) ||
      !uuid(value.requestId) || !object(value.project) || !keys(value.project, ["id", "code", "name"]) || !uuid(value.project.id) ||
      !label(value.project.code, 160) || !label(value.project.name, 160) || !stage(value.stageKind) ||
      !instant(value.dueAt) || !instant(value.capturedAt) || !instant(value.expiresAt) || typeof value.body !== "string" || !value.body.length || value.body.length > 65536 ||
      !dense(value.requiredFacts, 1, 100) ||
      !value.requiredFacts.every((fact: unknown) => object(fact) && keys(fact, ["factType", "label"]) && typeof fact.factType === "string" &&
        /^[a-z][a-z0-9_.-]{0,95}$/.test(fact.factType) && label(fact.label, 160)) ||
      !dense(value.rawResponseReaders, 0, 33) || !value.rawResponseReaders.every(subject) ||
      !dense(value.responses, 0, 20) || !value.responses.every(response) ||
      !escalation(value.escalationContext, value.capturedAt, value.stageKind)) return null;
  return { ...value, escalationContext: value.escalationContext ?? null } as ProjectUpdateRecipientRequestView;
}

export function decodeInvitationReceipt(value: unknown, requestId: string): ProjectUpdateResponseReceipt | null {
  if (!object(value) || !keys(value, ["responseId", "requestId", "receivedAt", "state", "message"]) ||
      !uuid(value.responseId) || !uuid(value.requestId) || value.requestId.toLowerCase() !== requestId.toLowerCase() ||
      !instant(value.receivedAt) || value.state !== "UNCONFIRMED" ||
      value.message !== "Response recorded; required facts remain unconfirmed.") return null;
  return value as ProjectUpdateResponseReceipt;
}
