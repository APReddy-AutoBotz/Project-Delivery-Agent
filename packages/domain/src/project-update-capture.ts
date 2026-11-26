import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";
import { atlasSuggestionStatusSchema } from "./atlas-update-approval.js";
import {
  projectUpdateFactReferenceSchema,
  projectUpdateKnownPositionSchema,
  projectUpdateRequiredFactSchema,
} from "./project-updates.js";

// EXEC-015 Stage 2c/3; FR-UPD-004/006, NFR-SEC-001, NFR-REL-002.
// Locators identify a request. They are never a bearer authorization.
export const projectUpdateInvitationLocatorSchema = z.uuid();
const instant = z.iso.datetime({ offset: false });
const revision = z.number().int().min(1).max(2147483647);
export const projectUpdateCaptureConfigurationSchema = z.strictObject({
  customerId: z.uuid(),
  mode: z.literal("CAPTURE"),
  invitationLifetimeSeconds: z.number().int().min(900).max(604800),
  contentRetentionSeconds: z.number().int().min(86400).max(31536000),
  issuanceEpoch: z.uuid(),
  responseReviewerSubjects: z.array(canonicalSubjectSchema).max(32),
}).superRefine((value, context) => {
  if (value.contentRetentionSeconds < value.invitationLifetimeSeconds)
    context.addIssue({ code: "custom", path: ["contentRetentionSeconds"],
      message: "Content retention must cover the invitation lifetime" });
  if (new Set(value.responseReviewerSubjects).size !== value.responseReviewerSubjects.length)
    context.addIssue({ code: "custom", path: ["responseReviewerSubjects"],
      message: "Response reviewers must be unique" });
});
export type ProjectUpdateCaptureConfiguration = z.infer<
  typeof projectUpdateCaptureConfigurationSchema
>;

const responseText = z.string().min(1).max(8000).refine(
  (value) => value.trim().length > 0 &&
    !value.includes(String.fromCharCode(0)) && !/\p{Surrogate}/u.test(value) &&
    new TextEncoder().encode(value).length <= 16384,
  "Response text must be nonempty and bounded",
);
export const projectUpdateResponseSubmissionSchema = z.strictObject({
  text: responseText,
  idempotencyKey: z.string().min(1).max(96).regex(/^[A-Za-z0-9._-]+$/),
  correctsResponseId: z.uuid().nullable().default(null),
});
export type ProjectUpdateResponseSubmission = z.infer<
  typeof projectUpdateResponseSubmissionSchema
>;
export const projectUpdateResponseReceiptSchema = z.strictObject({
  responseId: z.uuid(),
  requestId: z.uuid(),
  receivedAt: instant,
  state: z.literal("UNCONFIRMED"),
  message: z.literal("Response recorded; required facts remain unconfirmed."),
});
export type ProjectUpdateResponseReceipt = z.infer<
  typeof projectUpdateResponseReceiptSchema
>;

export const projectUpdateInvitationGateSchema = z.strictObject({
  authenticatedSubject: canonicalSubjectSchema,
  namedRecipientSubject: canonicalSubjectSchema,
  sameCustomer: z.boolean(),
  currentRecipientRoleAndGrant: z.boolean(),
  actorRoleMatchesGrant: z.boolean(),
  currentOwnerRoleAndGrant: z.boolean(),
  obligationOpen: z.boolean(),
  engagementActive: z.boolean(),
  policyCurrent: z.boolean(),
  generationCurrent: z.boolean(),
  captureCommitted: z.boolean(),
  globalShadowOff: z.boolean(),
  captureConfigured: z.boolean(),
  issuanceEpochCurrent: z.boolean(),
  restoreGateOpen: z.boolean(),
  recipientReadsEveryDependency: z.boolean(),
  viewerReadsEveryDependency: z.boolean(),
  contentAvailable: z.boolean(),
  issuedAt: instant,
  expiresAt: instant,
  contentExpiresAt: instant,
  asOf: instant,
}).superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
      Date.parse(value.contentExpiresAt) < Date.parse(value.expiresAt))
    context.addIssue({ code: "custom", path: ["expiresAt"],
      message: "Invalid invitation lifetime" });
});

/** Pure, non-disclosing decision; callers obtain all checks in the same scoped
 * transaction and authenticate before inspecting a located request or body.
 * Stored ACL revisions are provenance, never current authorization.
 */
export function mayAccessProjectUpdateInvitation(value: unknown): boolean {
  const parsed = projectUpdateInvitationGateSchema.safeParse(value);
  return parsed.success && parsed.data.authenticatedSubject === parsed.data.namedRecipientSubject &&
    activeCapture(parsed.data);
}

/** Capture validity for a separately authorized Atlas reviewer. */
export function isActiveProjectUpdateCapture(value: unknown): boolean {
  const parsed = projectUpdateInvitationGateSchema.safeParse(value);
  return parsed.success && activeCapture(parsed.data);
}

function activeCapture(input: z.infer<typeof projectUpdateInvitationGateSchema>): boolean {
  return input.sameCustomer && input.currentRecipientRoleAndGrant &&
    input.actorRoleMatchesGrant && input.currentOwnerRoleAndGrant &&
    input.obligationOpen && input.engagementActive && input.policyCurrent &&
    input.generationCurrent && input.captureCommitted && input.globalShadowOff &&
    input.captureConfigured && input.issuanceEpochCurrent && input.restoreGateOpen &&
    input.recipientReadsEveryDependency && input.viewerReadsEveryDependency &&
    input.contentAvailable && Date.parse(input.issuedAt) <= Date.parse(input.asOf) &&
    Date.parse(input.asOf) < Date.parse(input.expiresAt) &&
    Date.parse(input.asOf) < Date.parse(input.contentExpiresAt);
}

const boundedLabel = z.string().min(1).max(160).refine(
  (value) => value.trim().length > 0 &&
    !/[\p{Cc}\p{Surrogate}]/u.test(value) &&
    new TextEncoder().encode(value).length <= 160,
);
export const projectUpdateCaptureRenderInputSchema = z.strictObject({
  project: z.strictObject({
    id: z.uuid(),
    code: boundedLabel,
    name: boundedLabel,
  }),
  kind: z.enum(["REQUEST", "REMINDER", "ESCALATION"]),
  policyRevision: revision,
  dueAt: instant,
  capturedAt: instant,
  requiredFacts: z.array(projectUpdateRequiredFactSchema).min(1).max(100),
  knownPosition: z.array(projectUpdateKnownPositionSchema).max(1000),
  dependencies: z.array(projectUpdateFactReferenceSchema).max(1000),
  responseReviewerSubjects: z.array(canonicalSubjectSchema).max(32),
}).superRefine((value, context) => {
  const factTypes = new Set(value.requiredFacts.map((fact) => fact.factType));
  if (factTypes.size !== value.requiredFacts.length)
    context.addIssue({ code: "custom", path: ["requiredFacts"],
      message: "Required facts must be unique" });
  const dependencyKeys = value.dependencies.map((entry) =>
    entry.versionId + ":" + entry.evidenceId + ":" + entry.sourceId);
  const knownKeys = value.knownPosition.map((entry) =>
    entry.versionId + ":" + entry.evidenceId + ":" + entry.sourceId);
  if (new Set(dependencyKeys).size !== dependencyKeys.length ||
      new Set(knownKeys).size !== knownKeys.length ||
      knownKeys.length !== dependencyKeys.length ||
      knownKeys.some((key) => !dependencyKeys.includes(key)) ||
      value.knownPosition.some((position) => {
        const dependency = value.dependencies.find((entry) => entry.versionId === position.versionId &&
          entry.evidenceId === position.evidenceId && entry.sourceId === position.sourceId);
        return !dependency || dependency.factType !== position.factType ||
          dependency.sourceAccessRevision !== position.sourceAccessRevision ||
          dependency.authorityRevision !== position.authorityRevision ||
          dependency.observedAt !== position.observedAt || dependency.effectiveAt !== position.effectiveAt ||
          dependency.timestampBasis !== position.timestampBasis;
      }))
    context.addIssue({ code: "custom", path: ["dependencies"],
      message: "The exact rendered values require complete dependencies" });
  if (new Set(value.responseReviewerSubjects).size !== value.responseReviewerSubjects.length)
    context.addIssue({ code: "custom", path: ["responseReviewerSubjects"],
      message: "Response reviewers must be unique" });
});
export type ProjectUpdateCaptureRenderInput = z.infer<
  typeof projectUpdateCaptureRenderInputSchema
>;

/** Escape through the web's plain-text rendering; never evaluate source prose.
 * Rendering returns no locator, address, HTML or inferred project impact.
 * The repository separately verifies every dependency's current readability.
 */
export function renderProjectUpdateCapture(value: unknown) {
  const input = projectUpdateCaptureRenderInputSchema.parse(value);
  const lines = [
    input.kind === "REQUEST" ? "Project update requested"
      : input.kind === "REMINDER" ? "Project update reminder" : "Project update escalation",
    input.project.code + " — " + input.project.name,
    "An update is due and required facts remain missing or stale.",
    "Due: " + input.dueAt,
    "Current known position:",
    ...(input.knownPosition.length === 0
      ? ["No current authorized value is available."]
      : input.knownPosition.map((position) =>
        position.label + ": " + JSON.stringify(position.value))),
    "Information still required:",
    ...input.requiredFacts.map((fact) => "- " + fact.label),
    "Your response is recorded as unconfirmed. Facts and reminders change only after authorized confirmation or current source evidence.",
    "No Jira change is made by submitting a response.",
    "Raw-response reviewers: " + (input.responseReviewerSubjects.length
      ? input.responseReviewerSubjects.join(", ") : "only you"),
  ];
  const text = lines.join("\n");
  if (new TextEncoder().encode(text).length > 65536)
    throw new Error("Captured request exceeds the content limit");
  return {
    rendererRevision: "project-update-capture@1" as const,
    text,
    dependencies: input.dependencies,
  };
}

export const projectUpdateResponseHistorySchema = z.strictObject({
  id: z.uuid(),
  submittedBy: canonicalSubjectSchema,
  receivedAt: instant,
  correctsResponseId: z.uuid().nullable(),
  state: z.literal("UNCONFIRMED"),
  contentState: z.enum(["PRESENT", "EXPIRED"]),
  text: z.string().nullable(),
});
// FR-ESC-005: current-cycle workflow history, not a new fact assessment.
export const projectUpdateEscalationContextSchema = z.strictObject({
  asOf: instant,
  state: z.enum(["AVAILABLE", "UNAVAILABLE"]),
  impact: z.literal("UNKNOWN"),
  originalRequestId: z.uuid().nullable(),
  entries: z.array(z.strictObject({
    requestId: z.uuid(), stageId: z.uuid(),
    stageKind: z.enum(["REQUEST", "REMINDER", "ESCALATION"]),
    generation: revision,
    ordinal: z.number().int().min(0).max(2147483647),
    capturedAt: instant, contentExpiresAt: instant,
    contentState: z.enum(["PRESENT", "EXPIRED", "RESTRICTED"]),
    bodyProjection: z.literal("REVIEWER_NAMES_WITHHELD"),
    body: z.string().min(1).max(65536).nullable(),
  })).max(20),
}).superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Invalid escalation history" });
  if (value.state === "UNAVAILABLE") {
    if (value.originalRequestId !== null || value.entries.length !== 0) invalid();
    return;
  }
  const first = value.entries[0];
  if (!first || first.requestId !== value.originalRequestId || first.stageKind !== "REQUEST" ||
      value.entries.filter((entry) => entry.stageKind === "REQUEST").length !== 1 ||
      new Set(value.entries.map((entry) => entry.requestId)).size !== value.entries.length ||
      new Set(value.entries.map((entry) => entry.stageId)).size !== value.entries.length) invalid();
  for (const [index, entry] of value.entries.entries()) {
    if (Date.parse(entry.capturedAt) > Date.parse(value.asOf) ||
        Date.parse(entry.contentExpiresAt) <= Date.parse(entry.capturedAt) ||
        (entry.stageKind === "REQUEST" ? entry.ordinal !== 0 : entry.ordinal < 1) ||
        (entry.contentState === "PRESENT" && (entry.body === null || Date.parse(entry.contentExpiresAt) <= Date.parse(value.asOf))) ||
        (entry.contentState !== "PRESENT" && entry.body !== null)) invalid();
    const previous = value.entries[index - 1];
    if (previous && (entry.generation < previous.generation ||
        (entry.generation === previous.generation && (Date.parse(entry.capturedAt) < Date.parse(previous.capturedAt) ||
          (Date.parse(entry.capturedAt) === Date.parse(previous.capturedAt) && previous.stageKind !== "REQUEST" &&
            entry.requestId <= previous.requestId))))) invalid();
  }
});
export type ProjectUpdateEscalationContext = z.infer<typeof projectUpdateEscalationContextSchema>;

export const projectUpdateClarificationQuestion = "What is the current project status? If it depends on another person or a date, who is responsible and what is the exact calendar date, if known?";
export const projectUpdateClarificationRequestSchema = z.strictObject({
  requestId: z.uuid(),
  responseId: z.uuid(),
});
export const projectUpdateClarificationReceiptSchema = z.strictObject({
  responseId: z.uuid(),
  clarificationId: z.uuid(),
  requestedAt: instant,
});
export type ProjectUpdateClarificationReceipt = z.infer<typeof projectUpdateClarificationReceiptSchema>;

export const projectUpdateRecipientRequestViewSchema = z.strictObject({
  requestId: z.uuid(),
  project: z.strictObject({ id: z.uuid(), code: boundedLabel, name: boundedLabel }),
  stageKind: z.enum(["REQUEST", "REMINDER", "ESCALATION"]),
  dueAt: instant,
  capturedAt: instant,
  expiresAt: instant,
  body: z.string().min(1).max(65536),
  requiredFacts: z.array(projectUpdateRequiredFactSchema).min(1).max(100),
  rawResponseReaders: z.array(canonicalSubjectSchema).max(33),
  responses: z.array(projectUpdateResponseHistorySchema).max(20),
  clarification: z.strictObject({
    responseId: z.uuid(),
    question: boundedLabel,
  }).optional(),
  atlasInterpretation: z.strictObject({
    responseId: z.uuid(),
    suggestedStatus: atlasSuggestionStatusSchema,
  }).optional(),
  // Legacy payloads and non-PM invitations retain their existing contract.
  escalationContext: projectUpdateEscalationContextSchema.nullable().default(null),
}).superRefine((value, context) => {
  if (value.clarification && (value.responses[0]?.id !== value.clarification.responseId ||
      value.responses[0]?.contentState !== "PRESENT"))
    context.addIssue({ code: "custom", message: "Invalid clarification reference" });
  if (value.escalationContext && (value.stageKind !== "ESCALATION" ||
      Date.parse(value.escalationContext.asOf) < Date.parse(value.capturedAt)))
    context.addIssue({ code: "custom", message: "Invalid escalation context" });
});
export type ProjectUpdateRecipientRequestView = z.infer<
  typeof projectUpdateRecipientRequestViewSchema
>;
const capturedResponseReference = {
  requestId: z.uuid(),
  responseId: z.uuid(),
};
const captureFactRevision = z.number().int().min(0).max(2147483646);
const capturedStatusValue = z.string().min(1).max(500).regex(/^[^\p{Cc}\p{Surrogate}]+$/u)
  .refine((text) => text.trim().length > 0 && new TextEncoder().encode(text).length <= 500);
const capturedForecastValue = z.iso.date().refine((date) => !date.startsWith("0000-"));
export const projectUpdateStatusConfirmationSchema = z.strictObject({
  ...capturedResponseReference,
  expectedRevision: captureFactRevision,
  status: capturedStatusValue,
});
const capturedFactTypeSchema = z.enum(["project.status", "project.forecast"]);
export type CapturedUpdateFactType = z.infer<typeof capturedFactTypeSchema>;
export function extractExplicitCapturedFacts(text: string): Partial<Record<CapturedUpdateFactType, string>> {
  const seen = new Set<CapturedUpdateFactType>();
  const values: Partial<Record<CapturedUpdateFactType, string>> = {};
  for (const line of text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/u)) {
    const parts = /^(?:project\s+)?(status|forecast)\s*:\s*(.*)$/iu.exec(line.trim());
    if (!parts) continue;
    const status = parts[1]!.toLowerCase() === "status";
    const factType = status ? "project.status" : "project.forecast";
    if (seen.has(factType)) {
      delete values[factType];
      continue;
    }
    seen.add(factType);
    const value = (status ? capturedStatusValue : capturedForecastValue).safeParse(parts[2]);
    if (value.success) values[factType] = value.data;
  }
  return values;
}

export const projectUpdateFactConfirmationSchema = z.strictObject({
  ...capturedResponseReference,
  facts: z.array(z.discriminatedUnion("factType", [
    z.strictObject({ factType: z.literal("project.status"), value: capturedStatusValue, expectedRevision: captureFactRevision }),
    z.strictObject({ factType: z.literal("project.forecast"), value: capturedForecastValue,
      expectedRevision: captureFactRevision }),
  ])).min(1).max(2).refine((items) => new Set(items.map(({ factType }) => factType)).size === items.length),
});
export type ProjectUpdateFactConfirmation = z.infer<typeof projectUpdateFactConfirmationSchema>;
export const projectUpdateStatusConfirmationReceiptSchema = z.strictObject({
  responseId: z.uuid(),
  receiptId: z.uuid(),
  confirmedBy: canonicalSubjectSchema,
  confirmedAt: instant,
  factSatisfied: z.boolean(),
});
export type ProjectUpdateStatusConfirmationReceipt = z.infer<typeof projectUpdateStatusConfirmationReceiptSchema>;
export const projectUpdateFactConfirmationReceiptSchema = z.array(
  projectUpdateStatusConfirmationReceiptSchema.extend({ factType: capturedFactTypeSchema }),
).min(1).max(2);
export type ProjectUpdateFactConfirmationReceipt = z.infer<typeof projectUpdateFactConfirmationReceiptSchema>;
const pendingCapturedFactReview = z.strictObject({
  state: z.literal("PENDING"), responseId: z.uuid(), expectedRevision: captureFactRevision,
});
const completedCapturedFactReview = projectUpdateStatusConfirmationReceiptSchema.extend({ state: z.literal("CONFIRMED") });
export const projectUpdateCaptureHistorySchema = z.strictObject({
  projectId: z.uuid(),
  engagement: z.strictObject({ id: z.uuid(), generation: revision, policyRevision: revision,
    mode: z.enum(["SHADOW", "CAPTURE"]) }).nullable(),
  entries: z.array(z.strictObject({
    requestId: z.uuid(),
    stageId: z.uuid(),
    stageKind: z.enum(["REQUEST", "REMINDER", "ESCALATION"]),
    recipientSubject: canonicalSubjectSchema,
    capturedAt: instant,
    expiresAt: instant,
    status: z.enum(["ACTIVE", "ENDED", "EXPIRED", "QUARANTINED"]),
    contentState: z.enum(["PRESENT", "EXPIRED", "RESTRICTED"]),
    body: z.string().nullable(),
    // Locators are returned only for the current exact named recipient.
    recipientPath: z.string().nullable(),
    responses: z.array(projectUpdateResponseHistorySchema).max(20),
    statusReview: z.discriminatedUnion("state", [
      pendingCapturedFactReview.extend({ suggestedValue: capturedStatusValue.optional() }),
      projectUpdateClarificationReceiptSchema.extend({ state: z.literal("CLARIFICATION_REQUESTED") }),
      completedCapturedFactReview,
    ]).optional(),
    forecastReview: z.discriminatedUnion("state", [
      pendingCapturedFactReview.extend({ suggestedValue: capturedForecastValue.optional() }),
      completedCapturedFactReview,
    ]).optional(),
  })).max(20),
  nextCursor: z.uuid().nullable(),
});
export type ProjectUpdateCaptureHistory = z.infer<
  typeof projectUpdateCaptureHistorySchema
>;
export const projectUpdateCaptureGenerationSchema = z.strictObject({
  expectedEngagementGeneration: revision,
  expectedPolicyRevision: revision,
});

export const projectUpdateIssuanceChangeSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2147483646),
  expectedEpoch: z.uuid(),
  enable: z.boolean(),
});
export type ProjectUpdateIssuanceChange = z.infer<
  typeof projectUpdateIssuanceChangeSchema
>;
