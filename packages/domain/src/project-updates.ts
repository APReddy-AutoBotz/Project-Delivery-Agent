import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  canonicalKeySchema,
  canonicalSubjectSchema,
} from "./canonical-project.js";
import type { assessProjectCompleteness } from "./completeness-signals.js";
import type { assessUpdateFreshness } from "./freshness-signals.js";

const factType = z.string().min(1).max(96).regex(/^[a-z][a-z0-9_.-]*$/);
const label = z.string().min(1).max(160).refine(
  (value) =>
    value.trim().length > 0 &&
    !/[\p{Cc}\p{Surrogate}]/u.test(value) &&
    new TextEncoder().encode(value).length <= 160,
);
const revision = z.number().int().min(0).max(2147483646);

export const projectUpdateRequiredFactSchema = z.strictObject({
  factType,
  label,
});
export type ProjectUpdateRequiredFact = z.infer<
  typeof projectUpdateRequiredFactSchema
>;

export const projectUpdatePolicyChangeSchema = z.strictObject({
  expectedRevision: revision,
  freshnessWindowSeconds: z.number().int().min(1).max(315360000),
  timeZone: z.string().min(1).max(64).refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
      return true;
    } catch {
      return false;
    }
  }),
  requiredFacts: z.array(projectUpdateRequiredFactSchema).min(1).max(100),
  responsibleSubject: canonicalSubjectSchema,
  scheduledScanEnabled: z.boolean(),
}).superRefine((policy, context) => {
  const seen = new Set<string>();
  policy.requiredFacts.forEach((fact, index) => {
    if (seen.has(fact.factType))
      context.addIssue({
        code: "custom",
        path: ["requiredFacts", index, "factType"],
        message: "Required fact types must be unique",
      });
    seen.add(fact.factType);
  });
});
export type ProjectUpdatePolicyChange = z.infer<
  typeof projectUpdatePolicyChangeSchema
>;
export const projectUpdateAssessmentRequestSchema = z.strictObject({});

export type ProjectUpdatePolicyView = {
  projectId: string;
  key: string;
  revision: number;
  freshnessWindowSeconds: number;
  timeZone: string;
  requiredFacts: ProjectUpdateRequiredFact[];
  responsibleSubject: string;
  scheduledScanEnabled: boolean;
  changedBy: string;
  changedAt: string;
};

export const projectUpdatePolicyViewSchema = z.strictObject({
  projectId: z.uuid(),
  key: canonicalKeySchema,
  revision: z.number().int().min(1).max(2147483647),
  freshnessWindowSeconds: z.number().int().min(1).max(315360000),
  timeZone: z.string().min(1).max(64),
  requiredFacts: z.array(projectUpdateRequiredFactSchema).min(1).max(100),
  responsibleSubject: canonicalSubjectSchema,
  scheduledScanEnabled: z.boolean(),
  changedBy: canonicalSubjectSchema,
  changedAt: z.iso.datetime(),
});

export const projectUpdateFactReferenceSchema = z.strictObject({
  factId: z.uuid(),
  factType,
  versionId: z.uuid(),
  evidenceId: z.uuid(),
  sourceId: z.uuid(),
  sourceAccessRevision: z.number().int().min(1).max(2147483647),
  authorityRevision: z.number().int().min(1).max(2147483647).nullable(),
  observedAt: z.iso.datetime(),
  effectiveAt: z.iso.datetime(),
  timestampBasis: z.enum([
    "HUMAN_OBSERVED_AT",
    "CONNECTOR_EFFECTIVE_AT",
    "CONNECTOR_OBSERVED_AT",
    "UNCONFIRMED",
  ]),
});
export type ProjectUpdateFactReference = z.infer<
  typeof projectUpdateFactReferenceSchema
>;

export const projectUpdateKnownPositionSchema = z.strictObject({
  factType,
  label,
  value: z.json(),
  versionId: z.uuid(),
  evidenceId: z.uuid(),
  sourceId: z.uuid(),
  sourceAccessRevision: z.number().int().min(1).max(2147483647),
  authorityRevision: z.number().int().min(1).max(2147483647).nullable(),
  observedAt: z.iso.datetime(),
  effectiveAt: z.iso.datetime(),
  timestampBasis: z.enum([
    "HUMAN_OBSERVED_AT",
    "CONNECTOR_EFFECTIVE_AT",
    "CONNECTOR_OBSERVED_AT",
    "UNCONFIRMED",
  ]),
});
export type ProjectUpdateKnownPosition = z.infer<
  typeof projectUpdateKnownPositionSchema
>;

export const projectUpdatePreviewSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().min(1).max(2147483647),
  createdAt: z.iso.datetime(),
  project: z.strictObject({ id: z.uuid(), code: canonicalKeySchema, name: label }),
  reportedStatus: z.string().min(1).max(64),
  policyRevision: z.number().int().min(1).max(2147483647),
  assessedAt: z.iso.datetime(),
  freshnessThresholdAt: z.iso.datetime(),
  sourceDateField: z.enum(["project.createdAt", "project.latestValidUpdateAt"]),
  sourceDate: z.iso.datetime(),
  timestampBasis: z.enum(["REQUIRED_FACTS", "PROJECT_CREATED_AT", "UNCONFIRMED"]),
  completenessState: z.enum(["COMPLETE", "INCOMPLETE"]),
  freshnessState: z.enum(["CURRENT", "STALE"]),
  requiredFacts: z.array(z.strictObject({
    factType,
    label,
    state: z.enum(["CONFIRMED", "MISSING", "UNCONFIRMED"]),
    reasonCodes: z.array(z.string()).max(8),
  })).max(100),
  evidence: z.array(projectUpdateFactReferenceSchema).max(1000),
});
export type ProjectUpdatePreview = z.infer<typeof projectUpdatePreviewSchema>;

export type ProjectUpdateAssessmentView = {
  project: { id: string; code: string; name: string; reportedStatus: string };
  assessedAt: string;
  policy: ProjectUpdatePolicyView;
  completeness: ReturnType<typeof assessProjectCompleteness>;
  freshness: ReturnType<typeof assessUpdateFreshness>["freshness"];
  obligation: { id: string; state: "OPEN" | "SUPERSEDED"; dueAt: string } | null;
  preview: ProjectUpdatePreview | null;
  knownPosition: ProjectUpdateKnownPosition[];
};

const reasonCodeSchema = z.enum([
  "NO_CANONICAL_VALUE",
  "AUTHORITY_INPUT_INCOMPLETE",
  "SOURCE_REVALIDATION_REQUIRED",
  "CONFLICTING_AUTHORITY",
  "AMBIGUOUS_AUTHORITY",
  "NO_APPLICABLE_AUTHORITY_POLICY",
  "NO_CURRENT_AUTHORIZED_VALUE",
]);
const authorityStatusSchema = z.enum([
  "RESOLVED",
  "UNKNOWN",
  "CONFLICTING",
  "AMBIGUOUS",
  "INCOMPLETE",
  "REVALIDATION_REQUIRED",
  "NO_POLICY",
  "POLICY_NOT_APPLICABLE",
]);
export const projectUpdateAssessmentViewSchema = z.strictObject({
  project: z.strictObject({
    id: z.uuid(),
    code: canonicalKeySchema,
    name: label,
    reportedStatus: z.string().min(1).max(64),
  }),
  assessedAt: z.iso.datetime(),
  policy: projectUpdatePolicyViewSchema,
  completeness: z.strictObject({
    projectId: z.uuid(),
    assessedAt: z.iso.datetime(),
    ruleKey: canonicalKeySchema,
    ruleRevision: z.string().min(1).max(64),
    state: z.enum(["COMPLETE", "INCOMPLETE"]),
    complete: z.boolean(),
    requiredCount: z.number().int().min(0).max(100),
    confirmedCount: z.number().int().min(0).max(100),
    confirmedFactTypes: z.array(factType).max(100),
    missing: z.array(z.strictObject({
      factType,
      label,
      state: z.literal("MISSING"),
      canonicalVersionCount: z.number().int().min(0).max(1000),
      sourceAuthorityStatus: authorityStatusSchema,
      conflict: z.enum(["NONE", "CONFLICTING"]),
      reasonCodes: z.array(reasonCodeSchema).max(8),
    })).max(100),
    unconfirmed: z.array(z.strictObject({
      factType,
      label,
      state: z.literal("UNCONFIRMED"),
      canonicalVersionCount: z.number().int().min(0).max(1000),
      sourceAuthorityStatus: authorityStatusSchema,
      conflict: z.enum(["NONE", "CONFLICTING"]),
      reasonCodes: z.array(reasonCodeSchema).max(8),
    })).max(100),
    factAssessments: z.array(z.strictObject({
      factType,
      label,
      state: z.enum(["CONFIRMED", "MISSING", "UNCONFIRMED"]),
      canonicalVersionCount: z.number().int().min(0).max(1000),
      sourceAuthorityStatus: authorityStatusSchema,
      conflict: z.enum(["NONE", "CONFLICTING"]),
      reasonCodes: z.array(reasonCodeSchema).max(8),
    })).max(100),
  }),
  freshness: z.strictObject({
    state: z.enum(["CURRENT", "STALE"]),
    sourceDateField: z.enum(["project.createdAt", "project.latestValidUpdateAt"]),
    sourceDate: z.iso.datetime(),
    ageMilliseconds: z.number().int().min(0),
    freshnessWindowSeconds: z.number().int().min(1).max(315360000),
    exceededByMilliseconds: z.number().int().min(0),
    policyKey: canonicalKeySchema,
    ruleRevision: z.string().min(1).max(64),
    assessedAt: z.iso.datetime(),
    timeZone: z.string().min(1).max(64),
    timeZoneSource: z.enum(["RECIPIENT", "PROJECT", "CUSTOMER"]),
  }),
  obligation: z.strictObject({
    id: z.uuid(),
    state: z.enum(["OPEN", "SUPERSEDED"]),
    dueAt: z.iso.datetime(),
  }).nullable(),
  preview: projectUpdatePreviewSchema.nullable(),
  knownPosition: z.array(projectUpdateKnownPositionSchema).max(1000),
});

export class ProjectUpdateError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "DENIED"
      | "FORBIDDEN"
      | "CONFLICT"
      | "UNAVAILABLE",
  ) {
    super(code);
    this.name = "ProjectUpdateError";
  }
}

export interface ProjectUpdateRepository {
  policy(actor: Actor, projectId: string): Promise<ProjectUpdatePolicyView | null>;
  setPolicy(
    actor: Actor,
    projectId: string,
    change: ProjectUpdatePolicyChange,
    correlationId: string,
  ): Promise<ProjectUpdatePolicyView>;
  assess(
    actor: Actor,
    projectId: string,
    correlationId: string,
  ): Promise<ProjectUpdateAssessmentView>;
  latest(
    actor: Actor,
    projectId: string,
  ): Promise<ProjectUpdateAssessmentView | null>;
  scanScheduledProjects(limit: number): Promise<number>;
}
