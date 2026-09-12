import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  humanStatementSchema,
  projectFactIdSchema,
  projectFactInstantSchema,
  type FactHistoryEntry,
  type FactMutationContext,
} from "./project-facts.js";
import type { evaluateMilestoneConsistency } from "./milestone-consistency.js";

// FR-EVD-001/002/004/007/009/012, FR-MOD-002: internal repository ports.
// These inputs select canonical identities; they cannot assert bindings, clocks,
// policies, provenance, source access or precomputed consistency outcomes.
export const canonicalStateSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "COMPLETE",
  "CANCELLED",
]);
export const canonicalStateTargetKindSchema = z.enum([
  "MILESTONE",
  "WORK_ITEM",
]);
export const stateBindingCreateSchema = z
  .object({
    projectId: projectFactIdSchema,
    targetKind: canonicalStateTargetKindSchema,
    targetId: projectFactIdSchema,
    idempotencyKey: humanStatementSchema.shape.idempotencyKey,
    initialState: canonicalStateSchema,
    effectiveAt: projectFactInstantSchema,
    validUntil: projectFactInstantSchema.nullable().default(null),
    originalStatement: humanStatementSchema.shape.originalStatement,
  })
  .strict()
  .refine(
    (request) =>
      request.validUntil === null || request.validUntil >= request.effectiveAt,
  );
export const milestoneConsistencyCaptureSchema = z
  .object({
    projectId: projectFactIdSchema,
    milestoneId: projectFactIdSchema,
    ruleRevision: z.literal("milestone-required-state/v1"),
    enabled: z.boolean(),
    idempotencyKey: humanStatementSchema.shape.idempotencyKey,
  })
  .strict();
export const milestoneConsistencyReadSchema = z
  .object({
    projectId: projectFactIdSchema,
    assessmentId: projectFactIdSchema,
  })
  .strict();

export type StateBindingCreate = z.input<typeof stateBindingCreateSchema>;
export type MilestoneConsistencyCapture = z.infer<
  typeof milestoneConsistencyCaptureSchema
>;
export type MilestoneConsistencyRead = z.infer<
  typeof milestoneConsistencyReadSchema
>;

// Kept separately so the public name above cannot accidentally alias a scalar
// authority capture schema during future imports.
const milestoneConsistencyReadShape = milestoneConsistencyReadSchema;
type MilestoneConsistencyResult = ReturnType<
  typeof evaluateMilestoneConsistency
>;
export interface CanonicalStateBindingView {
  id: string;
  projectId: string;
  targetKind: "MILESTONE" | "WORK_ITEM";
  targetId: string;
  field: "state";
  factId: string;
  factType: string;
  createdAt: string;
  replayed: boolean;
  entry: FactHistoryEntry;
}
export type MilestoneConsistencyDelivery = {
  assessmentId: string;
  projectId: string;
  milestoneId: string;
  asOf: string;
  historical: true;
  replayed: boolean;
} & (
  | {
      visibility: "available";
      revalidationRequired: false;
      result: MilestoneConsistencyResult;
    }
  | {
      visibility: "restricted";
      revalidationRequired: true;
      result: null;
    }
);
export interface MilestoneConsistencyRepository {
  createStateBinding(
    actor: Actor,
    request: StateBindingCreate,
    context: FactMutationContext,
  ): Promise<CanonicalStateBindingView>;
  captureMilestoneConsistency(
    actor: Actor,
    request: MilestoneConsistencyCapture,
    context: FactMutationContext,
  ): Promise<MilestoneConsistencyDelivery>;
  getMilestoneConsistency(
    actor: Actor,
    request: z.infer<typeof milestoneConsistencyReadShape>,
  ): Promise<MilestoneConsistencyDelivery | null>;
}
