import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  humanStatementSchema,
  projectFactIdSchema,
  projectFactInstantSchema,
  type FactMutationContext,
} from "./project-facts.js";
import {
  sourceAuthorityPolicySchema,
  type resolveSourceAuthority,
} from "./source-authority.js";

// FR-ADM-005, FR-EVD-003/004/006/007/009/010/012: trusted repository ports.
export const authorityDefinitionSchema = sourceAuthorityPolicySchema
  .pick({ tiers: true, conflictBehavior: true })
  .refine((definition) => {
    const prior: { sourceType: string; instanceId: string | null }[] = [];
    for (const tier of definition.tiers) {
      for (const selector of tier.selectors) {
        if (
          prior.some(
            (item) =>
              item.sourceType === selector.sourceType &&
              (item.instanceId === null ||
                selector.instanceId === null ||
                item.instanceId === selector.instanceId),
          )
        )
          return false;
        prior.push(selector);
      }
    }
    return true;
  });
export const authorityTargetSchema = z
  .object({
    projectId: projectFactIdSchema,
    factType: humanStatementSchema.shape.factType,
  })
  .strict();
export const authorityPolicyChangeSchema = authorityTargetSchema.extend({
  expectedRevision: humanStatementSchema.shape.expectedRevision,
  idempotencyKey: humanStatementSchema.shape.idempotencyKey,
  effectiveAt: projectFactInstantSchema,
  definition: authorityDefinitionSchema.nullable(),
});
export const assessmentCaptureSchema = authorityTargetSchema.extend({
  idempotencyKey: humanStatementSchema.shape.idempotencyKey,
});
export const assessmentReadSchema = z
  .object({
    projectId: projectFactIdSchema,
    assessmentId: projectFactIdSchema,
  })
  .strict();
export type AuthorityDefinition = z.infer<typeof authorityDefinitionSchema>;
export type AuthorityPolicyChange = z.input<typeof authorityPolicyChangeSchema>;
export type AuthorityTarget = z.infer<typeof authorityTargetSchema>;
export type AssessmentCapture = z.infer<typeof assessmentCaptureSchema>;
export type AssessmentRead = z.infer<typeof assessmentReadSchema>;
export type AuthorityAssessment = ReturnType<typeof resolveSourceAuthority>;
export interface AuthorityPolicyEvent {
  id: string;
  policyId: string;
  revision: number;
  recordedAt: string;
  recordedBy: string;
  effectiveAt: string;
  state: "ENABLED" | "DISABLED";
  definition: AuthorityDefinition | null;
}
export interface ActiveAuthorityPolicy {
  asOf: string;
  policyId: string | null;
  throughRevision: number | null;
  event: AuthorityPolicyEvent | null;
}
export type AssessmentDelivery = {
  assessmentId: string;
  factId: string;
  asOf: string;
  historical: true;
  replayed: boolean;
} & (
  | {
      visibility: "available";
      revalidationRequired: false;
      result: AuthorityAssessment;
    }
  | { visibility: "restricted"; revalidationRequired: true; result: null }
);
export interface AuthorityRepository {
  appendPolicy(
    actor: Actor,
    request: AuthorityPolicyChange,
    context: FactMutationContext,
  ): Promise<{ event: AuthorityPolicyEvent; replayed: boolean }>;
  getActivePolicy(
    actor: Actor,
    request: AuthorityTarget,
  ): Promise<ActiveAuthorityPolicy | null>;
  captureAssessment(
    actor: Actor,
    request: AssessmentCapture,
    context: FactMutationContext,
  ): Promise<AssessmentDelivery>;
  getAssessment(
    actor: Actor,
    request: AssessmentRead,
  ): Promise<AssessmentDelivery | null>;
}
