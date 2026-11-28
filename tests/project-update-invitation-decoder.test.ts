import { expect, it } from "vitest";
import { projectUpdateClarificationQuestion, projectUpdateRecipientRequestViewSchema,
  projectUpdateResponseReceiptSchema } from "../packages/domain/src/project-update-capture.js";
import { composeLeadershipUpdateClaim, composeProjectComparisonClaims, composeProjectLeadershipClaims, projectDelayClarificationReviewSchema,
  projectLeadershipAnswerSchema } from "../packages/domain/src/project-leadership-answer.js";
import { atlasLeadershipAnswerSchema, composeAtlasComparisonClaims, composeAtlasDetailClaims, composeAtlasReceiptClaims } from "../packages/domain/src/atlas-update-approval.js";
import { decodeInvitation, decodeInvitationReceipt, decodeProjectDelayClarificationReview,
  decodeAtlasLeadershipAnswer, decodeProjectLeadershipAnswer } from "../apps/web/src/project-update-invitation-decoder.js";

const id = "30000000-0000-4000-8000-000000000001", other = "40000000-0000-4000-8000-000000000001";
const at = "2026-01-01T00:00:00.000Z", later = "2026-01-02T00:00:00.000Z";
const base = { requestId: id, project: { id, code: "S", name: "Synthetic" }, stageKind: "REQUEST", dueAt: at, capturedAt: at,
  expiresAt: later, body: "Synthetic request", requiredFacts: [{ factType: "project.forecast", label: "Forecast" }],
  rawResponseReaders: ["recipient"], responses: [], escalationContext: null };
const receipt = { responseId: other, requestId: id, receivedAt: at, state: "UNCONFIRMED", message: "Response recorded; required facts remain unconfirmed." };

it("validates both sets of scoped evidence in a leadership comparison", () => {
  const priorSnapshot = { id: other, asOf: at, schedule: { revision: 1, baseline: "2026-01-01", forecast: "2026-01-03", movementDays: 2 },
    updateFreshness: null };
  const facts = { state: "COMPARISON" as const, projectId: id, asOf: later, schedule: null, updateFreshness: null, priorSnapshot };
  const comparison = { ...facts, comparisonClaims: composeProjectComparisonClaims(facts) };
  expect(projectLeadershipAnswerSchema.safeParse(comparison).success).toBe(true);
  expect(decodeProjectLeadershipAnswer(comparison, id)).toEqual(comparison);
  expect(decodeProjectLeadershipAnswer(comparison, other)).toBeNull();
  expect(decodeProjectLeadershipAnswer({ ...comparison, priorSnapshot: { ...priorSnapshot, asOf: "2026-01-03T00:00:00.000Z" } }, id)).toBeNull();
  expect(decodeProjectLeadershipAnswer({ ...comparison, priorSnapshot: { ...priorSnapshot,
    schedule: { ...priorSnapshot.schedule, movementDays: 12 } } }, id)).toBeNull();
  const unsupported = { ...comparison, comparisonClaims: comparison.comparisonClaims.map((claim) =>
    ({ ...claim, evidenceIds: [id] })) };
  expect(projectLeadershipAnswerSchema.safeParse(unsupported).success).toBe(false);
  expect(decodeProjectLeadershipAnswer(unsupported, id)).toBeNull();
});

it("requires the saved Atlas assessment and cites an obligation only while open", () => {
  const answer = { projectId: id, asOf: later, schedule: null, ownerReply: null, receipt: null,
    delayAssessment: null, integrationStart: null, jiraBlocker: null, pmEscalation: null };
  const freshness = { assessmentId: other, state: "STALE" as const, assessedAt: later, sourceDate: at,
    sourceDateField: "project.latestValidUpdateAt" as const, openObligation: true, obligationId: id };
  for (const updateFreshness of [null, freshness, { ...freshness, openObligation: false, obligationId: undefined }]) {
    const updateClaim = composeLeadershipUpdateClaim({ projectId: id, asOf: later }, updateFreshness, id);
    const value = { ...answer, updateFreshness, updateClaim };
    expect(atlasLeadershipAnswerSchema.safeParse(value).success).toBe(true);
    expect(decodeAtlasLeadershipAnswer(value, id)).toEqual(value);
  }
  const updateClaim = composeLeadershipUpdateClaim({ projectId: id, asOf: later }, freshness, id);
  for (const [updateFreshness, claim] of [
    [freshness, null], [null, updateClaim], [freshness, { ...updateClaim, projectId: other }],
    [freshness, { ...updateClaim, claimText: "The project is on schedule." }],
    [freshness, { ...updateClaim, evidenceIds: [id, other] }],
    [{ ...freshness, assessmentId: undefined }, updateClaim], [{ ...freshness, obligationId: undefined }, updateClaim],
    [{ ...freshness, obligationId: "unverified" }, updateClaim], [{ ...freshness, openObligation: false }, updateClaim],
  ]) {
    const value = { ...answer, updateFreshness, updateClaim: claim };
    expect(atlasLeadershipAnswerSchema.safeParse(value).success).toBe(false);
    expect(decodeAtlasLeadershipAnswer(value, id)).toBeNull();
  }
  const updateFreshness = { ...freshness, activeClarification: {
    clarificationId: "50000000-0000-4000-8000-000000000001", factType: "project.forecast" as const,
    requestedAt: at, availableUntil: "2026-01-03T00:00:00.000Z",
  } };
  const detailClaims = composeAtlasDetailClaims({ ...answer, updateFreshness });
  const withClarification = { ...answer, updateFreshness, updateClaim, detailClaims };
  expect(atlasLeadershipAnswerSchema.safeParse(withClarification).success).toBe(true);
  expect(decodeAtlasLeadershipAnswer(withClarification, id)).toEqual(withClarification);
  const unsupported = { ...withClarification, updateFreshness: freshness };
  expect(atlasLeadershipAnswerSchema.safeParse(unsupported).success).toBe(false);
  expect(decodeAtlasLeadershipAnswer(unsupported, id)).toBeNull();
});

it("requires exact Atlas schedule and PM statements while their supporting receipts are available", () => {
  const availableUntil = "2026-01-03T00:00:00.000Z";
  const facts = { projectId: id, asOf: later,
    schedule: { revision: 1, baseline: "2026-01-01", forecast: "2026-01-03", movementDays: 2 },
    scheduleCitation: { sourceId: id, receiptId: other, reviewedAt: at, availableUntil },
    ownerReply: { responseId: id, receivedAt: at, availableUntil: "2026-01-04T00:00:00.000Z", accessStatus: "ACCESS_PENDING" as const },
    receipt: { id, approvalId: other, target: "ATLAS-248" as const, fixtureRevision: 1, recordedAt: at, result: "SIMULATED" as const },
    delayAssessment: { id: other, approvalId: other, receiptId: id, scheduleRevision: 1, confirmedAt: later,
      confirmedBy: "synthetic-pm", cause: "API_ACCESS_DELAY" as const, confidence: "MEDIUM" as const },
  };
  const receiptClaims = composeAtlasReceiptClaims(facts);
  const pmEscalation = { requestId: other, capturedAt: at, availableUntil };
  const supported = { ...facts, integrationStart: null, jiraBlocker: null, pmEscalation };
  const detailClaims = composeAtlasDetailClaims(supported);
  const answer = { ...supported, receiptClaims, detailClaims };
  expect(receiptClaims.map(({ validUntil }) => validUntil)).toEqual([availableUntil, availableUntil]);
  expect(atlasLeadershipAnswerSchema.safeParse(answer).success).toBe(true);
  expect(decodeAtlasLeadershipAnswer(answer, id)).toEqual(answer);
  const changedMovement = { ...answer, schedule: { ...answer.schedule, movementDays: 40 },
    receiptClaims: [{ ...receiptClaims[0], claimText: "The forecast is 40 days later than the baseline." }, receiptClaims[1]] };
  expect(atlasLeadershipAnswerSchema.safeParse(changedMovement).success).toBe(false);
  expect(decodeAtlasLeadershipAnswer(changedMovement, id)).toBeNull();
  for (const unsupported of [undefined, receiptClaims.slice(1), [
    { ...receiptClaims[0], claimText: "The forecast is 40 days later than the baseline." }, receiptClaims[1],
  ], [receiptClaims[0], { ...receiptClaims[1], evidenceIds: [id, other] }], [
    receiptClaims[0], { ...receiptClaims[1], validUntil: facts.ownerReply.availableUntil },
  ]]) {
    const changed = { ...answer, receiptClaims: unsupported };
    expect(atlasLeadershipAnswerSchema.safeParse(changed).success).toBe(false);
    expect(decodeAtlasLeadershipAnswer(changed, id)).toBeNull();
  }
  for (const unsupported of [undefined, detailClaims.slice(1), [
    { ...detailClaims[0], claimText: "The owner restored access." }, ...detailClaims.slice(1),
  ], [
    ...detailClaims.slice(0, 2), { ...detailClaims[2], validUntil: facts.ownerReply.availableUntil },
  ]]) {
    const changed = { ...answer, detailClaims: unsupported };
    expect(atlasLeadershipAnswerSchema.safeParse(changed).success).toBe(false);
    expect(decodeAtlasLeadershipAnswer(changed, id)).toBeNull();
  }
  const canonical = { ...supported, canonicalCreationReceiptId: other, scheduleCitation: undefined,
    integrationStart: { milestoneId: id, planned: "2026-01-01", actual: "2026-01-02" } };
  const canonicalAnswer = { ...canonical, receiptClaims: composeAtlasReceiptClaims(canonical),
    detailClaims: composeAtlasDetailClaims(canonical) };
  expect(atlasLeadershipAnswerSchema.safeParse(canonicalAnswer).success).toBe(true);
  expect(decodeAtlasLeadershipAnswer(canonicalAnswer, id)).toEqual(canonicalAnswer);
  const falseStart = { ...canonicalAnswer, integrationStart: { ...canonical.integrationStart, actual: "2026-01-01" } };
  expect(atlasLeadershipAnswerSchema.safeParse(falseStart).success).toBe(false);
  expect(decodeAtlasLeadershipAnswer(falseStart, id)).toBeNull();
  const priorSnapshot = { id: other, facts: { ...facts, asOf: at, delayAssessment: null } };
  const compared = { ...answer, priorSnapshot };
  const comparisonClaims = composeAtlasComparisonClaims(compared);
  const comparison = { ...compared, comparisonClaims };
  expect(atlasLeadershipAnswerSchema.safeParse(comparison).success).toBe(true);
  expect(decodeAtlasLeadershipAnswer(comparison, id)).toEqual(comparison);
  expect(comparisonClaims.map(({ field }) => field)).toEqual(["PM-confirmed cause", "PM forecast confidence"]);
  expect(comparisonClaims.map(({ validUntil }) => validUntil)).toEqual([availableUntil, availableUntil]);
  const unsupported = { ...comparison, comparisonClaims: comparisonClaims.map((claim) => ({ ...claim, after: "high" })) };
  expect(atlasLeadershipAnswerSchema.safeParse(unsupported).success).toBe(false);
  expect(decodeAtlasLeadershipAnswer(unsupported, id)).toBeNull();
  const outsideScope = { ...comparison, priorSnapshot: { ...priorSnapshot, facts: { ...priorSnapshot.facts, projectId: other } } };
  expect(atlasLeadershipAnswerSchema.safeParse(outsideScope).success).toBe(false);
  expect(decodeAtlasLeadershipAnswer(outsideScope, id)).toBeNull();
});

it("binds a pending delay request to its schedule and preserves supported evidence text", () => {
  const schedule = { revision: 1, baseline: "2026-01-01", forecast: "2026-01-03", movementDays: 2 };
  const pending = { id, requestedAt: at, schedule };
  const facts = { projectId: id, asOf: later, schedule, updateFreshness: null };
  const unknown = { ...facts, ...composeProjectLeadershipClaims(facts, other, undefined), state: "ANSWERED", cause: "UNKNOWN" };
  expect(decodeProjectLeadershipAnswer({ ...unknown, pendingDelayClarification: pending }, id)).not.toBeNull();
  expect(decodeProjectLeadershipAnswer({ ...unknown,
    pendingDelayClarification: { ...pending, schedule: { ...schedule, revision: 2 } } }, id)).toBeNull();
  const freshness = { assessmentId: id, assessedAt: at, sourceDate: at, sourceDateField: "project.createdAt",
    state: "STALE", openObligation: true, obligationId: other } as const;
  for (const [updateFreshness, readable] of [[freshness, true], [{ ...freshness, obligationId: undefined }, false],
    [{ ...freshness, openObligation: false }, false]] as const) {
    const answer = { ...unknown, updateFreshness, ...composeProjectLeadershipClaims({ ...facts, updateFreshness }, other, id) };
    expect(decodeProjectLeadershipAnswer(answer, id)).toEqual(readable ? answer : null);
    expect(projectLeadershipAnswerSchema.safeParse(answer).success).toBe(readable);
  }
  const withFreshness = { ...unknown, updateFreshness: freshness,
    ...composeProjectLeadershipClaims({ ...facts, updateFreshness: freshness }, other, id) };
  for (const unsupported of [
    { ...withFreshness, scheduleClaim: { ...withFreshness.scheduleClaim, claimText: "The forecast moved by 99 days." } },
    { ...withFreshness, scheduleClaim: { ...withFreshness.scheduleClaim, evidenceIds: ["unverified"] } },
    { ...withFreshness, updateClaim: { ...withFreshness.updateClaim, evidenceIds: [other, id] } },
    { ...withFreshness, updateClaim: { ...withFreshness.updateClaim, claimText: "There is no stale update." } },
    { ...withFreshness, updateClaim: { ...withFreshness.updateClaim, projectId: other } },
    { ...withFreshness, updateClaim: null },
  ]) {
    expect(decodeProjectLeadershipAnswer(unsupported, id)).toBeNull();
    expect(projectLeadershipAnswerSchema.safeParse(unsupported).success).toBe(false);
  }
  const confirmation = { id, clarificationId: id, versionId: other, confirmedAt: later };
  for (const [value, readable] of [[`${"検".repeat(200)}\n設備の確認を待ちました。`, true],
    ["検".repeat(501), false], ["Invalid\0text", false]] as const) {
    const evidence = { factId: id, versionId: other, evidenceId: id, observedAt: at, value };
    const review = { id, requestedAt: at, schedule, causeEvidence: evidence, confirmation };
    const claim = { claimText: `PM-confirmed delay cause · ${value}`, projectId: id, factId: id, versionId: other,
      evidenceIds: [id], policyRevisionId: other, assessedAt: later, provenance: "HUMAN_CONFIRMED",
      freshness: "CURRENT", conflict: "NONE", classification: "HUMAN_CONFIRMED", validUntil: "2026-01-03T00:00:00.000Z" };
    const answer = { ...unknown, cause: "HUMAN_CONFIRMED",
      delayCause: { evidence, confirmation, claim } };
    expect(decodeProjectDelayClarificationReview(review)).toEqual(readable ? review : null);
    expect(decodeProjectLeadershipAnswer(answer, id)).toEqual(readable ? answer : null);
    expect(projectDelayClarificationReviewSchema.safeParse(review).success).toBe(readable);
    expect(projectLeadershipAnswerSchema.safeParse(answer).success).toBe(readable);
    if (readable) {
      for (const invalid of [{ claimText: "The forecast moved by 99 days." }, { evidenceIds: [other] }, { projectId: other },
        { freshness: "STALE" }, { conflict: "CONFLICTING" }, { assessedAt: at }, { validUntil: later }]) {
        const unsupported = { ...answer, delayCause: { ...answer.delayCause, claim: { ...claim, ...invalid } } };
        expect(decodeProjectLeadershipAnswer(unsupported, id)).toBeNull();
        expect(projectLeadershipAnswerSchema.safeParse(unsupported).success).toBe(false);
      }
    }
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
  const impact = { revision: 1, baseline: "2026-01-01", forecast: "2026-01-04", movementDays: 3,
    citation: { sourceId: id, receiptId: other, reviewedAt: at, availableUntil: later } };
  const values: unknown[] = [escalation, { ...escalation, escalationContext: { ...context, entries: [] } },
    { ...escalation, stageKind: "REQUEST" }, { ...escalation, escalationContext: { ...context, entries: [{ ...original, ordinal: 1 }] } },
    { ...escalation, escalationContext: { ...context, entries: [{ ...original, contentState: "EXPIRED" }] } },
    { ...escalation, escalationContext: { asOf: at, state: "UNAVAILABLE", impact: "UNKNOWN", originalRequestId: null, entries: [] } },
    { ...escalation, escalationContext: { ...context, impact } },
    { ...escalation, escalationContext: { ...context, impact: { ...impact, movementDays: 4 } } },
    { ...escalation, escalationContext: { ...context, impact: { ...impact, citation: { ...impact.citation, availableUntil: at } } } },
    { ...escalation, escalationContext: { ...context, state: "UNAVAILABLE", impact, originalRequestId: null, entries: [] } }];
  for (const value of values) expect(decodeInvitation(value) !== null).toBe(projectUpdateRecipientRequestViewSchema.safeParse(value).success);
  expect(decodeInvitation({ ...escalation, escalationContext: { ...context, impact } })?.escalationContext?.impact).toEqual(impact);
  const legacy: Record<string, unknown> = { ...base }; delete legacy.escalationContext;
  expect(decodeInvitation(legacy)?.escalationContext).toBeNull();
});
