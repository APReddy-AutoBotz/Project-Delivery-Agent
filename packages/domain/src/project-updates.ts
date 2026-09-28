import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  canonicalKeySchema,
  canonicalSubjectSchema,
} from "./canonical-project.js";
import type { assessProjectCompleteness } from "./completeness-signals.js";
import type { assessUpdateFreshness } from "./freshness-signals.js";

const safeId = z.uuid().refine((value) => value === value.toLowerCase());
const instant = z.string().length(24).refine((value) => {
  const parsed = Date.parse(value);
  return (
    /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value) &&
    Number(value.slice(0, 4)) >= 1 &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value
  );
});
const factType = z.string().min(1).max(96).regex(/^[a-z][a-z0-9_.-]*$/);
const label = z.string().min(1).max(160).refine(
  (value) => value.trim().length > 0 && !/[\\0\\p{Surrogate}]/u.test(value),
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

export type ProjectUpdateFactReference = {
  factId: string;
  factType: string;
  versionId: string;
  evidenceId: string;
  sourceId: string;
  sourceAccessRevision: number;
  authorityRevision: number | null;
  observedAt: string;
  effectiveAt: string;
  timestampBasis:
    | "HUMAN_OBSERVED_AT"
    | "CONNECTOR_EFFECTIVE_AT"
    | "CONNECTOR_OBSERVED_AT"
    | "UNCONFIRMED";
};

export type ProjectUpdatePreview = {
  id: string;
  revision: number;
  createdAt: string;
  project: { id: string; code: string; name: string };
  reportedStatus: string;
  policyRevision: number;
  assessedAt: string;
  freshnessThresholdAt: string;
  sourceDateField: "project.createdAt" | "project.latestValidUpdateAt";
  sourceDate: string;
  timestampBasis:
    | "REQUIRED_FACTS"
    | "PROJECT_CREATED_AT"
    | "UNCONFIRMED";
  completenessState: "COMPLETE" | "INCOMPLETE";
  freshnessState: "CURRENT" | "STALE";
  requiredFacts: Array<{
    factType: string;
    label: string;
    state: "CONFIRMED" | "MISSING" | "UNCONFIRMED";
    reasonCodes: string[];
  }>;
  evidence: ProjectUpdateFactReference[];
};

export type ProjectUpdateAssessmentView = {
  project: { id: string; code: string; name: string; reportedStatus: string };
  assessedAt: string;
  policy: ProjectUpdatePolicyView;
  completeness: ReturnType<typeof assessProjectCompleteness>;
  freshness: ReturnType<typeof assessUpdateFreshness>["freshness"];
  obligation: { id: string; state: "OPEN" | "SUPERSEDED"; dueAt: string } | null;
  preview: ProjectUpdatePreview | null;
};

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
