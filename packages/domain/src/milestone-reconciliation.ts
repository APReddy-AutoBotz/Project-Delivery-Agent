import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  humanStatementSchema,
  projectFactIdSchema as id,
  projectFactInstantSchema as instant,
  projectFactSubjectSchema as subject,
  type FactMutationContext,
} from "./project-facts.js";
import {
  canonicalStateTargetKindSchema as kind,
  milestoneConsistencyCaptureSchema,
  type MilestoneConsistencyCapture,
  type MilestoneConsistencyRepository,
} from "./milestone-persistence.js";
import {
  authorityAssessmentSchema,
  factHistoryEntrySchema,
} from "./evidence-responses.js";

// FR-EVD-007/009/012, FR-HLT-008/009, NFR-REL-001/002: a pending
// request is not a settled source value, a sent message or a human approval.
const revision = z.number().int().min(1).max(2147483647);
const key = humanStatementSchema.shape.idempotencyKey;
const factType = humanStatementSchema.shape.factType;
const ruleRevision = milestoneConsistencyCaptureSchema.shape.ruleRevision;
const scope = z.strictObject({
  customerId: id,
  projectId: id,
  milestoneId: id,
});
const binding = z.strictObject({
  id,
  customerId: id,
  projectId: id,
  targetKind: kind,
  targetId: id,
  field: z.literal("state"),
  factId: id,
  factType,
});
const envelope = { scope, asOf: instant, ruleRevision };
const evaluations = z
  .array(
    z.strictObject({
      targetKind: kind,
      targetId: id,
      binding: binding.nullable(),
      assessment: authorityAssessmentSchema.nullable(),
    }),
  )
  .max(51);
const dependencies = z
  .array(
    z.strictObject({
      bindingId: id,
      factId: id,
      versionIds: z.array(id).max(1000),
      evidenceIds: z.array(id).max(64000),
    }),
  )
  .max(51);
export const milestoneConsistencyResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...envelope, status: z.literal("INCOMPLETE") }),
  z.strictObject({ ...envelope, status: z.literal("DISABLED") }),
  z.strictObject({ ...envelope, status: z.literal("REVALIDATION_REQUIRED") }),
  z.strictObject({
    ...envelope,
    status: z.literal("UNKNOWN"),
    evaluations,
    dependencies,
  }),
  z.strictObject({
    ...envelope,
    status: z.literal("NOT_DETECTED"),
    evaluations,
    dependencies,
  }),
  z.strictObject({
    ...envelope,
    status: z.literal("CONFLICTING"),
    evaluations,
    dependencies,
    contributors: z
      .array(
        z.strictObject({
          targetKind: kind,
          targetId: id,
          bindingId: id,
          factId: id,
          factType,
          supportingVersionIds: z.array(id).min(1).max(1000),
          supportingEvidenceIds: z.array(id).min(1).max(64000),
        }),
      )
      .min(2)
      .max(51),
    contributorIdentity: z
      .string()
      .min(1)
      .max(4 * 1024 * 1024),
  }),
]);
const deliveryMetadata = {
  assessmentId: id,
  projectId: id,
  milestoneId: id,
  asOf: instant,
  historical: z.literal(true),
  replayed: z.boolean(),
};
export const milestoneConsistencyDeliverySchema = z
  .discriminatedUnion("visibility", [
    z.strictObject({
      ...deliveryMetadata,
      visibility: z.literal("available"),
      revalidationRequired: z.literal(false),
      result: milestoneConsistencyResultSchema,
    }),
    z.strictObject({
      ...deliveryMetadata,
      visibility: z.literal("restricted"),
      revalidationRequired: z.literal(true),
      result: z.null(),
    }),
  ])
  .refine(
    (row) =>
      row.visibility === "restricted" ||
      (row.result.scope.projectId === row.projectId &&
        row.result.scope.milestoneId === row.milestoneId &&
        row.result.asOf === row.asOf),
  );
export const stateBindingViewSchema = z.strictObject({
  id,
  projectId: id,
  targetKind: kind,
  targetId: id,
  field: z.literal("state"),
  factId: id,
  factType,
  createdAt: instant,
  replayed: z.boolean(),
  entry: factHistoryEntrySchema,
});
export const reconciliationContextReadSchema = z.strictObject({
  projectId: id,
  milestoneId: id,
});
export const reconciliationContextSchema = z.strictObject({
  projectId: id,
  milestoneId: id,
  canAppend: z.boolean(),
  canConfigure: z.boolean(),
  targets: z
    .array(
      z.strictObject({
        targetKind: kind,
        targetId: id,
        binding: z.strictObject({ id, factId: id, factType }).nullable(),
      }),
    )
    .min(1)
    .max(51),
});
const assignmentMetadata = { id, revision, occurredAt: instant };
export const reconciliationAssignmentSchema = z.discriminatedUnion("reason", [
  z.strictObject({
    ...assignmentMetadata,
    reason: z.literal("ASSIGNED"),
    recipientSubject: subject,
  }),
  ...(
    [
      "NO_CONFIGURED_PM",
      "AMBIGUOUS_CONFIGURED_PM",
      "PM_SCOPE_UNAVAILABLE",
    ] as const
  ).map((reason) =>
    z.strictObject({
      ...assignmentMetadata,
      reason: z.literal(reason),
      recipientSubject: z.null(),
    }),
  ),
]);
export const reconciliationRequestSummarySchema = z.strictObject({
  id,
  projectId: id,
  milestoneId: id,
  createdAt: instant,
  state: z.literal("OPEN"),
  assignment: reconciliationAssignmentSchema,
});
export const reconciliationCheckResultSchema = z
  .strictObject({
    checkId: id,
    outcome: z.enum(["NO_REQUEST", "CREATED", "REUSED"]),
    replayed: z.boolean(),
    assessment: milestoneConsistencyDeliverySchema,
    request: reconciliationRequestSummarySchema.nullable(),
  })
  .refine(
    (row) =>
      (row.outcome === "NO_REQUEST") === (row.request === null) &&
      (row.request === null ||
        (row.request.projectId === row.assessment.projectId &&
          row.request.milestoneId === row.assessment.milestoneId)) &&
      (row.assessment.visibility === "restricted" ||
        (row.outcome === "NO_REQUEST") ===
          (row.assessment.result.status !== "CONFLICTING")),
  );
export const reconciliationReadSchema = z.strictObject({
  projectId: id,
  requestId: id,
});
export const reconciliationDeliverySchema = z
  .strictObject({
    request: reconciliationRequestSummarySchema,
    assessment: milestoneConsistencyDeliverySchema,
  })
  .refine(
    (row) =>
      row.request.assignment.reason === "ASSIGNED" &&
      row.request.projectId === row.assessment.projectId &&
      row.request.milestoneId === row.assessment.milestoneId &&
      (row.assessment.visibility === "restricted" ||
        row.assessment.result.status === "CONFLICTING"),
  );
export const reconciliationAssignmentRefreshSchema =
  reconciliationReadSchema.extend({
    expectedAssignmentRevision: revision.max(2147483646),
    idempotencyKey: key,
  });
export const reconciliationAssignmentResultSchema = z.strictObject({
  requestId: id,
  assignment: reconciliationAssignmentSchema,
  replayed: z.boolean(),
});
export const reconciliationCursorSchema = z.strictObject({
  createdAt: instant,
  id,
});
export const reconciliationListSchema = z.strictObject({
  projectId: id,
  after: reconciliationCursorSchema.nullable().default(null),
  limit: z.number().int().min(1).max(20).default(20),
});
export const reconciliationPageSchema = z.strictObject({
  requests: z.array(reconciliationRequestSummarySchema).max(20),
  next: reconciliationCursorSchema.nullable(),
  live: z.literal(true),
});
export type ReconciliationContext = z.infer<typeof reconciliationContextSchema>;
export type ReconciliationAssignment = z.infer<
  typeof reconciliationAssignmentSchema
>;
export type ReconciliationRequestSummary = z.infer<
  typeof reconciliationRequestSummarySchema
>;
export type ReconciliationCheckResult = z.infer<
  typeof reconciliationCheckResultSchema
>;
export type ReconciliationDelivery = z.infer<
  typeof reconciliationDeliverySchema
>;
export type ReconciliationRead = z.infer<typeof reconciliationReadSchema>;
export type ReconciliationList = z.input<typeof reconciliationListSchema>;
export type ReconciliationPage = z.infer<typeof reconciliationPageSchema>;
export type ReconciliationAssignmentRefresh = z.infer<
  typeof reconciliationAssignmentRefreshSchema
>;
export type ReconciliationAssignmentResult = z.infer<
  typeof reconciliationAssignmentResultSchema
>;
export interface MilestoneReconciliationRepository
  extends Pick<MilestoneConsistencyRepository, "createStateBinding"> {
  getContext(
    actor: Actor,
    request: z.infer<typeof reconciliationContextReadSchema>,
  ): Promise<ReconciliationContext | null>;
  check(
    actor: Actor,
    request: MilestoneConsistencyCapture,
    context: FactMutationContext,
  ): Promise<ReconciliationCheckResult>;
  list(
    actor: Actor,
    request: ReconciliationList,
    mode: "manage" | "recipient",
  ): Promise<ReconciliationPage | null>;
  get(
    actor: Actor,
    request: ReconciliationRead,
  ): Promise<ReconciliationDelivery | null>;
  refreshAssignment(
    actor: Actor,
    request: ReconciliationAssignmentRefresh,
    context: FactMutationContext,
  ): Promise<ReconciliationAssignmentResult>;
}
