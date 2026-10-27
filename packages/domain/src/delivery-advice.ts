import { z } from "zod";
import type { Actor } from "./actor.js";
import {
  canonicalKeySchema,
  canonicalSubjectSchema,
} from "./canonical-project.js";
import {
  assessDeliveryHealth,
  deliveryHealthCalculationRuleSchema,
} from "./delivery-health.js";
import {
  buildScheduleHealthAssessment,
  scheduleHealthSnapshotSchema,
  type HealthAssessmentRepository,
} from "./health-assessment.js";
import { provenanceSchema } from "./fact-state.js";

// FR-ADV-001/002/006/007/008, BR-013, NFR-REL-003: internal pure groundwork.
// The server must supply current, independently authorized project, assignment,
// evidence and reviewer inputs. This function is not an authorization boundary.
const id = z.uuid().refine((value) => value === value.toLowerCase());
const instant = z
  .string()
  .length(24)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      !value.startsWith("0000-") &&
      Number.isFinite(time) &&
      new Date(time).toISOString() === value
    );
  });
const urgency = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const rule = z.strictObject({
  key: canonicalKeySchema,
  revision: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
});
const recipient = z.strictObject({
  subject: canonicalSubjectSchema,
  audience: z.enum(["project_manager", "leadership"]),
});
const factReference = z.strictObject({
  factId: id,
  versionId: id,
  evidenceId: id,
  provenance: provenanceSchema,
  freshness: z.enum(["CURRENT", "STALE", "UNKNOWN"]),
  conflict: z.enum(["NONE", "CONFLICTING"]),
  assessedAt: instant,
});
const approval = z.strictObject({
  proposalId: id,
  proposalRevision: z.number().int().min(1).max(2147483647),
  reviewerSubject: canonicalSubjectSchema,
  raisedAt: instant,
  expiresAt: instant,
  urgency,
  rule,
  factReferences: z.array(factReference).min(1).max(16),
});
const requestSchema = z.strictObject({
  asOf: instant,
  recipient,
  readableProjectIds: z.array(id).max(25),
  assignedProjectIds: z.array(id).max(25),
  projects: z
    .array(
      z.strictObject({
        projectId: id,
        validUntil: instant,
        healthAssessmentInput: z.unknown(),
        pendingApprovals: z.array(approval).max(100),
      }),
    )
    .max(25),
});
export type DeliveryAdviceInput = z.input<typeof requestSchema>;
type Health = ReturnType<typeof assessDeliveryHealth>;
type Signal = Health["objectiveSignals"][number];
type Recipient = z.infer<typeof recipient>;
type Approval = z.infer<typeof approval>;
type Category =
  | "INTERVENTION"
  | "APPROVAL_REVIEW"
  | "UPDATE_FOLLOW_UP"
  | "RECONCILIATION"
  | "SCHEDULE_REVIEW"
  | "EVIDENCE_REVIEW";
type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
type Trigger =
  | { kind: "DELIVERY_SIGNAL"; sourceAssessedAt: string; signal: Signal }
  | {
      kind: "REPORTED_CALCULATED_MISMATCH";
      sourceAssessedAt: string;
      reported: Health["reported"];
      calculated: Health["calculated"];
      objectiveSignals: Health["objectiveSignals"];
      contradiction: NonNullable<Health["contradiction"]>;
    }
  | { kind: "PENDING_APPROVAL"; proposal: Approval };
export type DeliveryRecommendation = DeepReadonly<{
  concernKey: string;
  projectId: string;
  recipient: Recipient;
  classification: "RULE_BASED_SUGGESTION";
  adviceRuleRevision: "advice-core@1";
  category: Category;
  urgency: z.infer<typeof urgency>;
  triggeredAt: string;
  assessedAt: string;
  validUntil: string;
  // Review before taking the suggested action; never approval authority.
  approvalRequired: true;
  triggeringRule: { key: string; revision: string };
  trigger: Trigger;
  suggestedAction: string;
  expectedOutcome: string;
}>;
export type PointInTimeScheduleRecommendation = Omit<
  DeliveryRecommendation,
  "validUntil" | "recipient"
>;

const scheduleRag = z.enum(["GREEN", "AMBER", "RED", "UNKNOWN"]);
const scheduleSource = z.strictObject({
  kind: z.literal("canonical_record"),
  recordType: z.enum(["PROJECT", "MILESTONE", "WORK_ITEM"]),
  recordId: id,
  revision: z.number().int().min(0).max(2147483647).nullable(),
});
const scheduleValue = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
const scheduleFact = z.strictObject({
  factType: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_.-]*$/),
  field: z.string().min(1).max(96).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  value: scheduleValue,
  source: scheduleSource,
});
const scheduleSignalRule = z.strictObject({
  key: canonicalKeySchema,
  revision: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  parameters: z.array(z.strictObject({
    name: z.string().min(1).max(96).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
    value: scheduleValue,
  })).max(16),
});
const scheduleSignal = z.strictObject({
  signalId: canonicalKeySchema,
  kind: z.enum(["OVERDUE_MILESTONE", "OVERDUE_WORK_ITEM", "SCHEDULE_COVERAGE"]),
  targetType: z.enum(["PROJECT", "MILESTONE", "WORK_ITEM"]),
  targetKey: canonicalKeySchema,
  targetSource: scheduleSource,
  state: z.enum(["ACTIVE", "CLEAR", "UNASSESSABLE"]),
  severity: urgency,
  rule: scheduleSignalRule,
  sourceFacts: z.array(scheduleFact).min(1).max(16),
});
const scheduleTrigger = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("DELIVERY_SIGNAL"),
    sourceAssessedAt: instant,
    signal: scheduleSignal,
  }),
  z.strictObject({
    kind: z.literal("REPORTED_CALCULATED_MISMATCH"),
    sourceAssessedAt: instant,
    reported: z.strictObject({ status: scheduleRag, sourceFact: scheduleFact }),
    calculated: z.strictObject({
      status: scheduleRag,
      rule: deliveryHealthCalculationRuleSchema,
      rationale: z.strictObject({ code: z.string(), text: z.string(), signalIds: z.array(canonicalKeySchema) }),
    }),
    objectiveSignals: z.array(scheduleSignal).max(100),
    contradiction: z.strictObject({
      kind: z.literal("REPORTED_CALCULATED_MISMATCH"),
      severity: urgency,
      rule,
      reportedStatus: scheduleRag,
      calculatedStatus: scheduleRag,
      signalIds: z.array(canonicalKeySchema),
      rationale: z.string(),
    }),
  }),
]);
export const scheduleAdviceSnapshotSchema = z.strictObject({
  asOf: instant,
  projectId: id,
  audience: z.enum(["project_manager", "leadership"]),
  coverage: z.literal("SCHEDULE_ONLY"),
  sourceAuthority: z.literal("NOT_ASSESSED"),
  approvalItems: z.literal("UNAVAILABLE"),
  rankPolicyRevision: z.literal("advice-core@1"),
  items: z.array(z.strictObject({
    concernKey: z.string(),
    projectId: id,
    classification: z.literal("RULE_BASED_SUGGESTION"),
    adviceRuleRevision: z.literal("advice-core@1"),
    category: z.enum(["SCHEDULE_REVIEW", "EVIDENCE_REVIEW", "RECONCILIATION"]),
    urgency,
    triggeredAt: instant,
    assessedAt: instant,
    approvalRequired: z.literal(true),
    triggeringRule: z.union([
      rule,
      scheduleSignalRule,
    ]),
    trigger: scheduleTrigger,
    suggestedAction: z.string(),
    expectedOutcome: z.string(),
  })).max(101),
}).superRefine((snapshot, context) => {
  for (const [index, item] of snapshot.items.entries()) {
    const trigger = item.trigger;
    const expectedCategory = trigger.kind === "REPORTED_CALCULATED_MISMATCH"
      ? "RECONCILIATION"
      : trigger.signal.state === "UNASSESSABLE" || trigger.signal.kind === "SCHEDULE_COVERAGE"
        ? "EVIDENCE_REVIEW"
        : "SCHEDULE_REVIEW";
    if (
      item.projectId !== snapshot.projectId ||
      item.assessedAt !== snapshot.asOf ||
      item.triggeredAt !== snapshot.asOf ||
      trigger.sourceAssessedAt !== snapshot.asOf ||
      item.category !== expectedCategory ||
      (trigger.kind === "DELIVERY_SIGNAL" && trigger.signal.state === "CLEAR")
    ) {
      context.addIssue({ code: "custom", path: ["items", index], message: "Inconsistent schedule suggestion" });
    }
  }
});

const urgencyOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
const categoryOrder: Record<Category, number> = {
  INTERVENTION: 0,
  APPROVAL_REVIEW: 1,
  UPDATE_FOLLOW_UP: 2,
  RECONCILIATION: 3,
  SCHEDULE_REVIEW: 4,
  EVIDENCE_REVIEW: 5,
};
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const compareRecommendations = (
  left: PointInTimeScheduleRecommendation,
  right: PointInTimeScheduleRecommendation,
) =>
  urgencyOrder[left.urgency] - urgencyOrder[right.urgency] ||
  categoryOrder[left.category] - categoryOrder[right.category] ||
  compare(left.triggeredAt, right.triggeredAt) ||
  compare(left.concernKey, right.concernKey);
function invalid(): never {
  throw new Error("Invalid delivery advice input");
}
function unique(values: readonly string[]) {
  if (new Set(values).size !== values.length) invalid();
}
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function wording(category: Category, audience: Recipient["audience"]) {
  switch (category) {
    case "INTERVENTION":
      return audience === "project_manager"
        ? {
            suggestedAction:
              "Review escalation to the configured blocker owner and reassess the project forecast.",
            expectedOutcome:
              "An owned blocker resolution path and a reviewed forecast impact.",
          }
        : {
            suggestedAction:
              "Review the decision or intervention needed to resolve the delivery blocker.",
            expectedOutcome:
              "An explicit intervention decision and accountable resolution path.",
          };
    case "APPROVAL_REVIEW":
      return {
        suggestedAction:
          "Review the pending proposal, its evidence and conflicts before making an explicit approval decision.",
        expectedOutcome:
          "A recorded human decision on the exact proposal revision, with no implied execution.",
      };
    case "UPDATE_FOLLOW_UP":
      return audience === "project_manager"
        ? {
            suggestedAction:
              "Review the missing or stale information and prepare a focused follow-up for the configured owner.",
            expectedOutcome:
              "Current, attributed information for the unresolved update need.",
          }
        : {
            suggestedAction:
              "Review the information gap and decide whether management intervention is needed.",
            expectedOutcome:
              "A decision that reflects the available evidence and its uncertainty.",
          };
    case "RECONCILIATION":
      return {
        suggestedAction:
          audience === "project_manager"
            ? "Review the reported and calculated positions with the project owner; retain both until reconciled."
            : "Review the conflicting delivery positions and decide what reconciliation is needed before relying on either.",
        expectedOutcome:
          "An explicit reconciliation that preserves reported status, calculated signals and source authority.",
      };
    case "SCHEDULE_REVIEW":
      return {
        suggestedAction:
          audience === "project_manager"
            ? "Review the overdue work with the configured owner and assess forecast and recovery options."
            : "Review the schedule exposure and decide whether a recovery intervention is needed.",
        expectedOutcome:
          "A reviewed recovery option without an unsupported schedule commitment.",
      };
    case "EVIDENCE_REVIEW":
      return {
        suggestedAction:
          audience === "project_manager"
            ? "Review missing evidence and prepare a clarification before drawing a delivery conclusion."
            : "Review the evidence gap before making a delivery decision.",
        expectedOutcome:
          "An explicit evidence gap or validated input for the next assessment.",
      };
  }
}
function categoryFor(signal: Signal): Category {
  if (signal.state === "UNASSESSABLE") return "EVIDENCE_REVIEW";
  switch (signal.kind) {
    case "BLOCKER_AGE":
      return "INTERVENTION";
    case "UPDATE_FRESHNESS":
    case "COMPLETENESS":
      return "UPDATE_FOLLOW_UP";
    case "OVERDUE_MILESTONE":
    case "OVERDUE_WORK_ITEM":
      return "SCHEDULE_REVIEW";
    case "SCHEDULE_COVERAGE":
      return "EVIDENCE_REVIEW";
  }
}

/**
 * Build read-only suggestions from complete, preauthorized snapshots. Expiry
 * filtering supplements the caller's current permission/policy/source checks;
 * supplied scope IDs and reviewer subjects cannot establish those permissions.
 */
export function buildDeliveryAdviceQueue(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const request = parsed.data;
  unique(request.readableProjectIds);
  unique(request.assignedProjectIds);
  unique(request.projects.map((project) => project.projectId));
  const readable = new Set(request.readableProjectIds);
  const assigned = new Set(request.assignedProjectIds);
  const items: DeliveryRecommendation[] = [];
  const proposalIds = new Set<string>();
  let signalCount = 0;
  let approvalCount = 0;

  for (const project of request.projects) {
    approvalCount += project.pendingApprovals.length;
    if (approvalCount > 100) invalid();
    for (const proposal of project.pendingApprovals) {
      if (proposalIds.has(proposal.proposalId)) invalid();
      proposalIds.add(proposal.proposalId);
      unique(
        proposal.factReferences.map((fact) =>
          JSON.stringify([fact.factId, fact.versionId]),
        ),
      );
      if (
        proposal.raisedAt > request.asOf ||
        proposal.expiresAt <= proposal.raisedAt ||
        proposal.factReferences.some((fact) => fact.assessedAt > request.asOf)
      )
        invalid();
    }
    if (
      !readable.has(project.projectId) ||
      (request.recipient.audience === "project_manager" &&
        !assigned.has(project.projectId))
    )
      continue;

    let health: Health;
    try {
      health = assessDeliveryHealth(project.healthAssessmentInput);
    } catch {
      return invalid();
    }
    signalCount += health.objectiveSignals.length;
    if (
      signalCount > 500 ||
      health.projectId !== project.projectId ||
      health.assessedAt > request.asOf ||
      project.validUntil <= health.assessedAt
    )
      invalid();
    if (project.validUntil <= request.asOf) continue;

    const append = (details: {
      concern: readonly string[];
      category: Category;
      urgency: DeliveryRecommendation["urgency"];
      triggeredAt: string;
      triggeringRule: DeliveryRecommendation["triggeringRule"];
      trigger: Trigger;
      validUntil?: string;
    }) => {
      items.push({
        concernKey: JSON.stringify([project.projectId, ...details.concern]),
        projectId: project.projectId,
        recipient: { ...request.recipient },
        classification: "RULE_BASED_SUGGESTION",
        adviceRuleRevision: "advice-core@1",
        category: details.category,
        urgency: details.urgency,
        triggeredAt: details.triggeredAt,
        assessedAt: request.asOf,
        validUntil: details.validUntil ?? project.validUntil,
        approvalRequired: true,
        triggeringRule: { ...details.triggeringRule },
        trigger: details.trigger,
        ...wording(details.category, request.recipient.audience),
      });
    };
    for (const signal of health.objectiveSignals) {
      if (signal.state === "CLEAR") continue;
      const category = categoryFor(signal);
      append({
        concern: ["signal", signal.signalId],
        category,
        urgency: category === "EVIDENCE_REVIEW" ? "LOW" : signal.severity,
        triggeredAt: health.assessedAt,
        triggeringRule: signal.rule,
        trigger: {
          kind: "DELIVERY_SIGNAL",
          sourceAssessedAt: health.assessedAt,
          signal,
        },
      });
    }
    if (health.contradiction !== null)
      append({
        concern: ["reported-calculated-mismatch"],
        category: "RECONCILIATION",
        urgency: health.contradiction.severity,
        triggeredAt: health.assessedAt,
        triggeringRule: health.contradiction.rule,
        trigger: {
          kind: "REPORTED_CALCULATED_MISMATCH",
          sourceAssessedAt: health.assessedAt,
          reported: health.reported,
          calculated: health.calculated,
          objectiveSignals: health.objectiveSignals,
          contradiction: health.contradiction,
        },
      });
    for (const proposal of project.pendingApprovals) {
      if (
        proposal.reviewerSubject !== request.recipient.subject ||
        proposal.expiresAt <= request.asOf
      )
        continue;
      proposal.factReferences.sort((left, right) =>
        compare(
          JSON.stringify([left.factId, left.versionId]),
          JSON.stringify([right.factId, right.versionId]),
        ),
      );
      append({
        concern: [
          "proposal",
          proposal.proposalId,
          String(proposal.proposalRevision),
        ],
        category: "APPROVAL_REVIEW",
        urgency: proposal.urgency,
        triggeredAt: proposal.raisedAt,
        triggeringRule: proposal.rule,
        trigger: { kind: "PENDING_APPROVAL", proposal },
        validUntil:
          proposal.expiresAt < project.validUntil
            ? proposal.expiresAt
            : project.validUntil,
      });
    }
  }
  items.sort(compareRecommendations);
  return freeze({
    asOf: request.asOf,
    recipient: { ...request.recipient },
    rankPolicyRevision: "advice-core@1" as const,
    items,
  });
}

// EXEC-022 / FR-ADV-001/006/007: an as-of observation, never an
// authorization or a promise that the inputs remain current afterward.
// The caller must construct the snapshot from a current authorized read.
const scheduleAdviceSnapshotRequest = z.strictObject({
  asOf: instant,
  recipient,
  snapshot: scheduleHealthSnapshotSchema,
});

export function buildScheduleAdviceSnapshot(input: unknown) {
  const parsed = scheduleAdviceSnapshotRequest.safeParse(input);
  if (!parsed.success || parsed.data.snapshot.assessedAt !== parsed.data.asOf)
    return invalid();
  const { asOf, recipient: audience, snapshot } = parsed.data;
  let health: Health;
  try {
    health = buildScheduleHealthAssessment(snapshot).result;
  } catch {
    return invalid();
  }
  const items: PointInTimeScheduleRecommendation[] = [];
  const append = (details: {
    concern: readonly string[];
    category: Category;
    urgency: DeliveryRecommendation["urgency"];
    triggeringRule: DeliveryRecommendation["triggeringRule"];
    trigger: Trigger;
  }) => {
    items.push({
      concernKey: JSON.stringify([health.projectId, ...details.concern]),
      projectId: health.projectId,
      classification: "RULE_BASED_SUGGESTION",
      adviceRuleRevision: "advice-core@1",
      category: details.category,
      urgency: details.urgency,
      triggeredAt: health.assessedAt,
      assessedAt: asOf,
      approvalRequired: true,
      triggeringRule: { ...details.triggeringRule },
      trigger: details.trigger,
      ...wording(details.category, audience.audience),
    });
  };
  for (const signal of health.objectiveSignals) {
    if (signal.state === "CLEAR") continue;
    const category = categoryFor(signal);
    append({
      concern: ["signal", signal.signalId],
      category,
      urgency: category === "EVIDENCE_REVIEW" ? "LOW" : signal.severity,
      triggeringRule: signal.rule,
      trigger: {
        kind: "DELIVERY_SIGNAL",
        sourceAssessedAt: health.assessedAt,
        signal,
      },
    });
  }
  if (health.contradiction !== null)
    append({
      concern: ["reported-calculated-mismatch"],
      category: "RECONCILIATION",
      urgency: health.contradiction.severity,
      triggeringRule: health.contradiction.rule,
      trigger: {
        kind: "REPORTED_CALCULATED_MISMATCH",
        sourceAssessedAt: health.assessedAt,
        reported: health.reported,
        calculated: health.calculated,
        objectiveSignals: health.objectiveSignals,
        contradiction: health.contradiction,
      },
    });
  items.sort(compareRecommendations);
  const result = scheduleAdviceSnapshotSchema.safeParse({
    asOf,
    projectId: snapshot.projectId,
    audience: audience.audience,
    coverage: "SCHEDULE_ONLY" as const,
    sourceAuthority: "NOT_ASSESSED" as const,
    approvalItems: "UNAVAILABLE" as const,
    rankPolicyRevision: "advice-core@1" as const,
    items,
  });
  if (!result.success) return invalid();
  return freeze(result.data);
}

export type ScheduleAdviceSnapshot = ReturnType<typeof buildScheduleAdviceSnapshot>;
export type ScheduleAdviceHealthRepository = HealthAssessmentRepository & {
  scheduleSuggestions(actor: Actor, projectId: string): Promise<ScheduleAdviceSnapshot>;
};
