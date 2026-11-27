import { expect, it } from "vitest";
import { projectUpdateClarificationQuestion, projectUpdateRecipientRequestViewSchema,
  projectUpdateResponseReceiptSchema } from "../packages/domain/src/project-update-capture.js";
import { projectDelayClarificationReviewSchema, projectLeadershipAnswerSchema } from "../packages/domain/src/project-leadership-answer.js";
import { decodeInvitation, decodeInvitationReceipt, decodeProjectDelayClarificationReview,
  decodeProjectLeadershipAnswer } from "../apps/web/src/project-update-invitation-decoder.js";

const id = "30000000-0000-4000-8000-000000000001", other = "40000000-0000-4000-8000-000000000001";
const at = "2026-01-01T00:00:00.000Z", later = "2026-01-02T00:00:00.000Z";
const base = { requestId: id, project: { id, code: "S", name: "Synthetic" }, stageKind: "REQUEST", dueAt: at, capturedAt: at,
  expiresAt: later, body: "Synthetic request", requiredFacts: [{ factType: "project.forecast", label: "Forecast" }],
  rawResponseReaders: ["recipient"], responses: [], escalationContext: null };
const receipt = { responseId: other, requestId: id, receivedAt: at, state: "UNCONFIRMED", message: "Response recorded; required facts remain unconfirmed." };

it("validates both sets of scoped evidence in a leadership comparison", () => {
  const priorSnapshot = { id: other, asOf: at, schedule: { revision: 1, baseline: "2026-01-01", forecast: "2026-01-03", movementDays: 2 },
    updateFreshness: null };
  const comparison = { state: "COMPARISON", projectId: id, asOf: later, schedule: null, updateFreshness: null, priorSnapshot };
  expect(decodeProjectLeadershipAnswer(comparison, id)).toEqual(comparison);
  expect(decodeProjectLeadershipAnswer(comparison, other)).toBeNull();
  expect(decodeProjectLeadershipAnswer({ ...comparison, priorSnapshot: { ...priorSnapshot, asOf: "2026-01-03T00:00:00.000Z" } }, id)).toBeNull();
  expect(decodeProjectLeadershipAnswer({ ...comparison, priorSnapshot: { ...priorSnapshot,
    schedule: { ...priorSnapshot.schedule, movementDays: 12 } } }, id)).toBeNull();
});

it("binds a pending delay request to its schedule and preserves supported evidence text", () => {
  const schedule = { revision: 1, baseline: "2026-01-01", forecast: "2026-01-03", movementDays: 2 };
  const pending = { id, requestedAt: at, schedule };
  const unknown = { state: "ANSWERED", projectId: id, asOf: later, schedule, updateFreshness: null, cause: "UNKNOWN" };
  expect(decodeProjectLeadershipAnswer({ ...unknown, pendingDelayClarification: pending }, id)).not.toBeNull();
  expect(decodeProjectLeadershipAnswer({ ...unknown,
    pendingDelayClarification: { ...pending, schedule: { ...schedule, revision: 2 } } }, id)).toBeNull();
  const confirmation = { id, clarificationId: id, versionId: other, confirmedAt: later };
  for (const [value, readable] of [[`${"検".repeat(200)}\n設備の確認を待ちました。`, true],
    ["検".repeat(501), false], ["Invalid\0text", false]] as const) {
    const evidence = { factId: id, versionId: other, evidenceId: id, observedAt: at, value };
    const review = { id, requestedAt: at, schedule, causeEvidence: evidence, confirmation };
    const answer = { state: "ANSWERED", projectId: id, asOf: later, schedule, updateFreshness: null, cause: "HUMAN_CONFIRMED",
      delayCause: { evidence, confirmation } };
    expect(decodeProjectDelayClarificationReview(review)).toEqual(readable ? review : null);
    expect(decodeProjectLeadershipAnswer(answer, id)).toEqual(readable ? answer : null);
    expect(projectDelayClarificationReviewSchema.safeParse(review).success).toBe(readable);
    expect(projectLeadershipAnswerSchema.safeParse(answer).success).toBe(readable);
  }
});

it("matches representative invitation and receipt wire schemas", () => {
  const values: unknown[] = [base, { ...base, escalationContext: undefined }, { ...base, extra: true }, null,
    { ...base, project: { ...base.project, name: " " } }, { ...base, project: { ...base.project, name: "é".repeat(81) } },
    { ...base, requiredFacts: [] }, { ...base, requiredFacts: [{ factType: "Invalid", label: "Forecast" }] },
    { ...base, rawResponseReaders: [" recipient"] }, { ...base, responses: Array(21).fill(null) },
    { ...base, expiresAt: "2026-02-30T00:00:00.000Z" }, { ...base, expiresAt: "2026-01-01T00:00:00+01:00" },
    { ...base, expiresAt: "2026-01-01T00:00:00.123456Z" }, { ...base, requestId: "not-a-uuid" }];
  for (const value of values) expect(decodeInvitation(value) !== null).toBe(projectUpdateRecipientRequestViewSchema.safeParse(value).success);
  const receipts: unknown[] = [receipt, { ...receipt, extra: true }, { ...receipt, state: "CONFIRMED" },
    { ...receipt, message: "Different message" }, { ...receipt, receivedAt: "not-a-date" }, null];
  for (const value of receipts) expect(decodeInvitationReceipt(value, id) !== null).toBe(projectUpdateResponseReceiptSchema.safeParse(value).success);
  expect(decodeInvitationReceipt(receipt, other)).toBeNull();
  expect(decodeInvitation({ ...base, responses: new Array(1) })).toBeNull();
  expect(decodeInvitation({ ...base, requiredFacts: new Array(1) })).toBeNull();
  const hidden = Object.defineProperty({ ...base }, "requestId", { value: id, enumerable: false });
  expect(decodeInvitation(hidden)).toBeNull();
  const reply = { id: other, submittedBy: "recipient", receivedAt: at, state: "UNCONFIRMED",
    contentState: "PRESENT", correctsResponseId: null, text: "It should be fine next week once they sort it." };
  const clarification = { responseId: other, question: projectUpdateClarificationQuestion };
  const current = { ...base, responses: [reply], clarification };
  expect(decodeInvitation(current)?.clarification).toEqual(clarification);
  expect(decodeInvitation({ ...current, clarification: { ...clarification, responseId: id } })).toBeNull();
});

it("checks escalation ordering, retention and the explicit default", () => {
  const original = { requestId: other, stageId: "50000000-0000-4000-8000-000000000001", stageKind: "REQUEST",
    generation: 1, ordinal: 0, capturedAt: at, contentExpiresAt: later, contentState: "PRESENT", bodyProjection: "REVIEWER_NAMES_WITHHELD", body: "Original" };
  const context = { asOf: at, state: "AVAILABLE", impact: "UNKNOWN", originalRequestId: other, entries: [original] };
  const escalation = { ...base, stageKind: "ESCALATION", escalationContext: context };
  const values: unknown[] = [escalation, { ...escalation, escalationContext: { ...context, entries: [] } },
    { ...escalation, stageKind: "REQUEST" }, { ...escalation, escalationContext: { ...context, entries: [{ ...original, ordinal: 1 }] } },
    { ...escalation, escalationContext: { ...context, entries: [{ ...original, contentState: "EXPIRED" }] } },
    { ...escalation, escalationContext: { asOf: at, state: "UNAVAILABLE", impact: "UNKNOWN", originalRequestId: null, entries: [] } }];
  for (const value of values) expect(decodeInvitation(value) !== null).toBe(projectUpdateRecipientRequestViewSchema.safeParse(value).success);
  const legacy: Record<string, unknown> = { ...base }; delete legacy.escalationContext;
  expect(decodeInvitation(legacy)?.escalationContext).toBeNull();
});
