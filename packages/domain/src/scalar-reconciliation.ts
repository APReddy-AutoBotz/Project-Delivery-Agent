import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  humanStatementSchema,
  projectFactIdSchema as id,
  projectFactInstantSchema as instant,
  type FactMutationContext,
} from "./project-facts.js";
import { assessmentDeliverySchema } from "./evidence-responses.js";
import {
  reconciliationAssignmentSchema,
  reconciliationAssignmentRefreshSchema,
  reconciliationAssignmentResultSchema,
  reconciliationCursorSchema,
  reconciliationListSchema,
  reconciliationReadSchema,
} from "./milestone-reconciliation.js";
import { scalarReconciliationIdentity } from "./scalar-reconciliation-identity.js";

// FR-EVD-007/009/012 / NFR-SEC-001 / NFR-REL-002: separate strict scalar wire
// contracts. Shared assignment metadata has no grant snapshot or proof content.
export const scalarReconciliationCheckSchema = z.strictObject({
  projectId: id,
  factId: id,
  idempotencyKey: humanStatementSchema.shape.idempotencyKey,
});
export const scalarReconciliationReadSchema = reconciliationReadSchema;
export const scalarReconciliationListSchema = reconciliationListSchema;
export const scalarReconciliationAssignmentRefreshSchema =
  reconciliationAssignmentRefreshSchema;
export const scalarReconciliationAssignmentResultSchema =
  reconciliationAssignmentResultSchema;
export const scalarReconciliationRequestSummarySchema = z.strictObject({
  id,
  projectId: id,
  factId: id,
  factType: humanStatementSchema.shape.factType,
  createdAt: instant,
  state: z.literal("OPEN"),
  assignment: reconciliationAssignmentSchema,
});
type Summary = z.infer<typeof scalarReconciliationRequestSummarySchema>;
type Delivery = z.infer<typeof assessmentDeliverySchema>;
function scopeMatches(request: Summary, assessment: Delivery) {
  return (
    request.factId === assessment.factId &&
    (assessment.visibility === "restricted" ||
      (request.projectId === assessment.result.scope.projectId &&
        request.factType === assessment.result.scope.factType))
  );
}
function eligible(assessment: Delivery): boolean | null {
  if (assessment.visibility === "restricted") return null;
  return scalarReconciliationIdentity(assessment.result) !== null;
}
export const scalarReconciliationCheckResultSchema = z
  .strictObject({
    checkId: id,
    outcome: z.enum(["NO_REQUEST", "CREATED", "REUSED"]),
    replayed: z.boolean(),
    assessment: assessmentDeliverySchema,
    request: scalarReconciliationRequestSummarySchema.nullable(),
  })
  .refine((row) => {
    try {
      const positive = eligible(row.assessment);
      return (
        row.replayed === row.assessment.replayed &&
        (row.outcome === "NO_REQUEST") === (row.request === null) &&
        (row.request === null || scopeMatches(row.request, row.assessment)) &&
        (positive === null || positive === (row.outcome !== "NO_REQUEST"))
      );
    } catch {
      return false;
    }
  });
export const scalarReconciliationDeliverySchema = z
  .strictObject({
    request: scalarReconciliationRequestSummarySchema,
    assessment: assessmentDeliverySchema,
  })
  .refine((row) => {
    try {
      return (
        row.request.assignment.reason === "ASSIGNED" &&
        scopeMatches(row.request, row.assessment) &&
        eligible(row.assessment) !== false
      );
    } catch {
      return false;
    }
  });
export const scalarReconciliationPageSchema = z.strictObject({
  requests: z.array(scalarReconciliationRequestSummarySchema).max(20),
  next: reconciliationCursorSchema.nullable(),
  live: z.literal(true),
});
export type ScalarReconciliationCheck = z.infer<
  typeof scalarReconciliationCheckSchema
>;
export type ScalarReconciliationCheckResult = z.infer<
  typeof scalarReconciliationCheckResultSchema
>;
export type ScalarReconciliationRequestSummary = Summary;
export type ScalarReconciliationRead = z.infer<
  typeof scalarReconciliationReadSchema
>;
export type ScalarReconciliationList = z.input<
  typeof scalarReconciliationListSchema
>;
export type ScalarReconciliationPage = z.infer<
  typeof scalarReconciliationPageSchema
>;
export type ScalarReconciliationDelivery = z.infer<
  typeof scalarReconciliationDeliverySchema
>;
export type ScalarReconciliationAssignmentRefresh = z.infer<
  typeof scalarReconciliationAssignmentRefreshSchema
>;
export type ScalarReconciliationAssignmentResult = z.infer<
  typeof scalarReconciliationAssignmentResultSchema
>;
export interface ScalarReconciliationRepository {
  check(
    actor: Actor,
    request: ScalarReconciliationCheck,
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
  ): Promise<ScalarReconciliationAssignmentResult>;
}
