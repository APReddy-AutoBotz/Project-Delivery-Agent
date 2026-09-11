import { z } from "zod";
import { temporalFactSnapshotSchema } from "./temporal-facts.js";
import {
  sourceAuthorityPolicySchema,
  sourceAuthoritySnapshotSchema,
} from "./source-authority.js";
import { authorityDefinitionSchema } from "./authority-persistence.js";
import {
  projectFactIdSchema as id,
  projectFactInstantSchema as instant,
  projectFactSubjectSchema as subject,
  humanStatementSchema,
} from "./project-facts.js";

// FR-EVD-003/009/010 / TR-API-001: strict wire envelopes cannot carry restricted content.
const temporal = temporalFactSnapshotSchema.shape;
const revision = z.number().int().min(1).max(2147483647);
const counter = z.number().int().min(0).max(2147483647);
const historyMetadata = {
  id,
  revision,
  sourceId: id,
  evidenceId: id,
  sourceAccessRevision: counter,
};
export const factHistoryEntrySchema = z.discriminatedUnion("visibility", [
  z.strictObject({
    ...historyMetadata,
    visibility: z.literal("restricted"),
    revalidationRequired: z.literal(true),
  }),
  z.strictObject({
    ...historyMetadata,
    visibility: z.literal("available"),
    revalidationRequired: z.literal(false),
    content: z.strictObject({
      value: humanStatementSchema.shape.value,
      originalStatement: humanStatementSchema.shape.originalStatement,
      providedBy: subject,
      provenance: z.literal("HUMAN_CONFIRMED"),
      effectiveAt: instant,
      observedAt: instant,
      confirmedAt: instant,
      validUntil: instant.nullable(),
      source: z.strictObject({
        instanceId: id,
        recordType: z.literal("human_statement"),
        recordId: id,
        revision: id,
      }),
      evidenceIds: z.array(id).length(1),
    }),
  }),
]);
export const factHistoryPageSchema = z
  .strictObject({
    factId: id.nullable(),
    factType: humanStatementSchema.shape.factType,
    throughRevision: counter,
    entries: z.array(factHistoryEntrySchema).max(100),
    next: z
      .strictObject({ afterRevision: counter, throughRevision: counter })
      .nullable(),
    historical: z.literal(true),
  })
  .refine(
    (page) =>
      page.factId !== null ||
      (page.throughRevision === 0 &&
        page.entries.length === 0 &&
        page.next === null),
  );
export const humanStatementResultSchema = z.strictObject({
  factId: id,
  replayed: z.boolean(),
  entry: factHistoryEntrySchema,
});
const eventMetadata = {
  id,
  policyId: id,
  revision,
  recordedAt: instant,
  recordedBy: subject,
  effectiveAt: instant,
};
export const authorityPolicyEventSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...eventMetadata,
    state: z.literal("ENABLED"),
    definition: authorityDefinitionSchema,
  }),
  z.strictObject({
    ...eventMetadata,
    state: z.literal("DISABLED"),
    definition: z.null(),
  }),
]);
export const activeAuthorityPolicySchema = z.strictObject({
  asOf: instant,
  policyId: id.nullable(),
  throughRevision: revision.nullable(),
  event: authorityPolicyEventSchema.nullable(),
});
export const policyChangeResultSchema = z.strictObject({
  event: authorityPolicyEventSchema,
  replayed: z.boolean(),
});
const ids = z.array(id).max(1000);
const evidenceIds = z.array(id).max(64000);
export const authorityAssessmentSchema = z.strictObject({
  scope: temporal.scope,
  asOf: temporal.asOf,
  mode: z.literal("HISTORICAL"),
  policy: sourceAuthorityPolicySchema.nullable(),
  complete: z.boolean(),
  status: z.enum([
    "INCOMPLETE",
    "REVALIDATION_REQUIRED",
    "NO_POLICY",
    "POLICY_NOT_APPLICABLE",
    "CONFLICTING",
    "AMBIGUOUS",
    "RESOLVED",
    "UNKNOWN",
  ]),
  revalidationRequired: z.boolean(),
  selectedTier: z.number().int().min(0).max(15).nullable(),
  resolvedValue: temporal.versions.element.shape.value.nullable(),
  candidateVersionIds: ids,
  supportingVersionIds: ids,
  supportingEvidenceIds: evidenceIds,
  conflict: z.enum(["NONE", "CONFLICTING"]),
  conflicts: z
    .array(
      z.strictObject({
        kind: z.enum([
          "RECORDED",
          "AUTHORITY_DISAGREEMENT",
          "HIGHER_AUTHORITY_CONTRADICTION",
        ]),
        recordedConflictId: id.nullable(),
        versionIds: ids,
        evidenceIds,
      }),
    )
    .max(1002),
  reconciliationRequired: z.boolean(),
  versions: z
    .array(
      z.discriminatedUnion("visibility", [
        z.strictObject({
          id,
          evidenceIds: z.array(id).min(1).max(64),
          visibility: z.literal("restricted"),
          revalidationRequired: z.literal(true),
        }),
        temporal.versions.element.extend({
          temporalApplicability: z.enum([
            "NOT_YET_OBSERVED",
            "NOT_YET_EFFECTIVE",
            "SUPERSEDED",
            "AMBIGUOUS",
            "APPLICABLE",
          ]),
          assessedValidUntil: temporal.asOf.nullable(),
          unresolvedConflictIds: ids,
          visibility: z.literal("available"),
          revalidationRequired: z.literal(false),
          sourceType: humanStatementSchema.shape.factType,
          approval:
            sourceAuthoritySnapshotSchema.shape.versions.element.shape.approval,
          approvalStateAsOf: z.enum([
            "APPROVED",
            "PENDING",
            "REJECTED",
            "NOT_REQUIRED",
          ]),
          authorityTier: z.number().int().min(0).max(15).nullable(),
          eligibilityReasons: z
            .array(
              z.enum([
                "NO_AUTHORITY_RULE",
                "NOT_APPLICABLE",
                "AMBIGUOUS_STREAM",
                "APPROVAL_REQUIRED",
                "REJECTED",
                "STALE",
                "UNKNOWN_VALIDITY",
                "UNVERIFIED_ORIGIN",
              ]),
            )
            .max(8),
          assessment: z.strictObject({
            provenance: temporal.versions.element.shape.provenance,
            freshness: z.enum(["CURRENT", "STALE", "UNKNOWN"]),
            conflict: z.enum(["NONE", "CONFLICTING"]),
            classification: z.enum([
              "SYSTEM_VERIFIED",
              "HUMAN_CONFIRMED",
              "AGENT_INFERENCE",
              "UNKNOWN",
              "STALE",
              "CONFLICTING",
            ]),
            assessedAt: temporal.asOf,
          }),
        }),
      ]),
    )
    .max(1000),
});
const deliveryMetadata = {
  assessmentId: id,
  factId: id,
  asOf: temporal.asOf,
  historical: z.literal(true),
  replayed: z.boolean(),
};
export const assessmentDeliverySchema = z
  .discriminatedUnion("visibility", [
    z.strictObject({
      ...deliveryMetadata,
      visibility: z.literal("available"),
      revalidationRequired: z.literal(false),
      result: authorityAssessmentSchema,
    }),
    z.strictObject({
      ...deliveryMetadata,
      visibility: z.literal("restricted"),
      revalidationRequired: z.literal(true),
      result: z.null(),
    }),
  ])
  .refine(
    (delivery) =>
      delivery.visibility === "restricted" ||
      (delivery.result.asOf === delivery.asOf &&
        delivery.result.scope.factId === delivery.factId),
  );
