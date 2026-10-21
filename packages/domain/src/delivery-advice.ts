import { z } from "zod";
import {
  canonicalKeySchema,
  canonicalSubjectSchema,
} from "./canonical-project.js";
import { assessDeliveryHealth } from "./delivery-health.js";
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
  items.sort(
    (left, right) =>
      urgencyOrder[left.urgency] - urgencyOrder[right.urgency] ||
      categoryOrder[left.category] - categoryOrder[right.category] ||
      compare(left.triggeredAt, right.triggeredAt) ||
      compare(left.concernKey, right.concernKey),
  );
  return freeze({
    asOf: request.asOf,
    recipient: { ...request.recipient },
    rankPolicyRevision: "advice-core@1" as const,
    items,
  });
}
