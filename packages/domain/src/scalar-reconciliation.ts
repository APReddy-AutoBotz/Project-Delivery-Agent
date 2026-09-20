import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  humanStatementSchema,
  projectFactIdSchema as id,
  projectFactInstantSchema as instant,
  type FactMutationContext,
} from "./project-facts.js";
import {
  assessmentDeliverySchema,
  authorityAssessmentSchema,
} from "./evidence-responses.js";
import {
  reconciliationAssignmentSchema,
  reconciliationCursorSchema,
  type ReconciliationAssignment,
  type ReconciliationAssignmentResult,
} from "./milestone-reconciliation.js";

// FR-EVD-007/009/012, FR-ADM-005, NFR-REL-001/002: durable generic scalar reconciliation.
const revision = z.number().int().min(1).max(2147483647);
const key = humanStatementSchema.shape.idempotencyKey;
const factType = humanStatementSchema.shape.factType;

export const scalarReconciliationContextReadSchema = z.strictObject({
  projectId: id,
  factType,
});

export const scalarReconciliationContextSchema = z.strictObject({
  projectId: id,
  factType,
  canAppend: z.boolean(),
  canConfigure: z.boolean(),
  factId: id.nullable(),
});

export const scalarReconciliationCheckRequestSchema = z.strictObject({
  projectId: id,
  factType,
  asOf: instant,
  idempotencyKey: key,
});

export const scalarReconciliationRequestSummarySchema = z.strictObject({
  id,
  projectId: id,
  factId: id,
  factType,
  createdAt: instant,
  state: z.enum(["OPEN", "RESOLVED"]),
  resolvedAssessmentId: id.nullable(),
  assignment: reconciliationAssignmentSchema,
});

export const scalarReconciliationCheckResultSchema = z
  .strictObject({
    checkId: id,
    outcome: z.enum(["NO_REQUEST", "CREATED", "REUSED", "RESOLVED"]),
    replayed: z.boolean(),
    assessment: assessmentDeliverySchema,
    request: scalarReconciliationRequestSummarySchema.nullable(),
  })
  .refine(
    (row) =>
      (row.outcome === "NO_REQUEST") === (row.request === null) &&
      (row.request === null || row.request.factId === row.assessment.factId),
  );

export const scalarReconciliationReadSchema = z.strictObject({
  projectId: id,
  requestId: id,
});

export const scalarReconciliationDeliverySchema = z
  .strictObject({
    request: scalarReconciliationRequestSummarySchema,
    assessment: assessmentDeliverySchema,
  })
  .refine((row) => row.request.factId === row.assessment.factId);

export const scalarReconciliationAssignmentRefreshSchema =
  scalarReconciliationReadSchema.extend({
    expectedAssignmentRevision: revision.max(2147483646),
    idempotencyKey: key,
  });

export const scalarReconciliationResolveSchema =
  scalarReconciliationReadSchema.extend({
    asOf: instant.optional(),
    idempotencyKey: key,
  });

export const scalarReconciliationListSchema = z.strictObject({
  projectId: id,
  after: reconciliationCursorSchema.nullable().default(null),
  limit: z.number().int().min(1).max(20).default(20),
});

export const scalarReconciliationPageSchema = z.strictObject({
  requests: z.array(scalarReconciliationRequestSummarySchema).max(20),
  next: reconciliationCursorSchema.nullable(),
  live: z.literal(true),
});

export type ScalarReconciliationContextRead = z.infer<
  typeof scalarReconciliationContextReadSchema
>;
export type ScalarReconciliationContext = z.infer<
  typeof scalarReconciliationContextSchema
>;
export type ScalarReconciliationCheckRequest = z.infer<
  typeof scalarReconciliationCheckRequestSchema
>;
export type ScalarReconciliationRequestSummary = z.infer<
  typeof scalarReconciliationRequestSummarySchema
>;
export type ScalarReconciliationCheckResult = z.infer<
  typeof scalarReconciliationCheckResultSchema
>;
export type ScalarReconciliationDelivery = z.infer<
  typeof scalarReconciliationDeliverySchema
>;
export type ScalarReconciliationRead = z.infer<
  typeof scalarReconciliationReadSchema
>;
export type ScalarReconciliationAssignmentRefresh = z.infer<
  typeof scalarReconciliationAssignmentRefreshSchema
>;
export type ScalarReconciliationResolve = z.infer<
  typeof scalarReconciliationResolveSchema
>;
export type ScalarReconciliationList = z.input<
  typeof scalarReconciliationListSchema
>;
export type ScalarReconciliationPage = z.infer<
  typeof scalarReconciliationPageSchema
>;

export interface ScalarReconciliationRepository {
  getContext(
    actor: Actor,
    request: ScalarReconciliationContextRead,
  ): Promise<ScalarReconciliationContext | null>;
  check(
    actor: Actor,
    request: ScalarReconciliationCheckRequest,
    context: FactMutationContext,
  ): Promise<ScalarReconciliationCheckResult>;
  list(
    actor: Actor,
    request: ScalarReconciliationList,
    mode: "manage" | "recipient",
  ): Promise<ScalarReconciliationPage | null>;
  get(
    actor: Actor,
    request: ScalarReconciliationRead,
  ): Promise<ScalarReconciliationDelivery | null>;
  refreshAssignment(
    actor: Actor,
    request: ScalarReconciliationAssignmentRefresh,
    context: FactMutationContext,
  ): Promise<ReconciliationAssignmentResult>;
  resolve(
    actor: Actor,
    request: ScalarReconciliationResolve,
    context: FactMutationContext,
  ): Promise<ScalarReconciliationCheckResult>;
}
