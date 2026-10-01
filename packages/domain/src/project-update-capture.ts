import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";
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
    !/[\u0000\p{Surrogate}]/u.test(value) &&
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
  if (!parsed.success) return false;
  const input = parsed.data;
  return input.authenticatedSubject === input.namedRecipientSubject &&
    input.sameCustomer && input.currentRecipientRoleAndGrant &&
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
});
export type ProjectUpdateRecipientRequestView = z.infer<
  typeof projectUpdateRecipientRequestViewSchema
>;
export const projectUpdateCaptureHistorySchema = z.strictObject({
  projectId: z.uuid(),
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
  })).max(20),
  nextCursor: z.uuid().nullable(),
});
export type ProjectUpdateCaptureHistory = z.infer<
  typeof projectUpdateCaptureHistorySchema
>;
export const projectUpdateCaptureGenerationSchema = z.strictObject({
  expectedEngagementGeneration: revision,
});
