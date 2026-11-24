import { z } from "zod";
import {
  assessDeliveryHealth,
  type DeliveryHealthAssessmentInput,
  type DeliveryHealthSignalInput,
} from "./delivery-health.js";

const distinctTargets = z.array(z.uuid().refine((id) => id === id.toLowerCase()))
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length);
export const criticalDeliveryTargetsSchema = z.strictObject({
  milestoneIds: distinctTargets,
  raidItemIds: distinctTargets,
});
export type CriticalDeliveryTargets = z.infer<typeof criticalDeliveryTargetsSchema>;

export const deliveryConcernAssessmentRevision =
  "schedule-health@2+blocker-age@1+delivery-concern@1" as const;

export type CriticalBlockerObservation = {
  id: string;
  key: string;
  state: "OPEN" | "IN_PROGRESS" | "COMPLETE" | "CANCELLED";
} & (
  | { status: "ACTIVE"; openedAt: string; ageDays: number; minimumBlockerAgeDays: number; thresholdRevision: number }
  | { status: "CLEAR" | "UNASSESSABLE" }
);

export type DeliveryUpdateObservation =
  | {
      state: "CURRENT" | "STALE";
      asOf: string;
      sourceDate: string;
      timeZone: string;
      policyRevision: number;
      freshnessWindowSeconds: number;
      ageMilliseconds: number;
    }
  | { state: "UNASSESSABLE"; asOf: string; policyRevision: number | null };

type Source = DeliveryHealthSignalInput["targetSource"];
type Value = DeliveryHealthSignalInput["sourceFacts"][number]["value"];
const fact = (factType: string, field: string, value: Value, source: Source) =>
  ({ factType, field, value, source });

function blockerSignal(
  blocker: CriticalBlockerObservation,
  projectRevision: number | null,
  policyRevision: number,
): DeliveryHealthSignalInput {
  const targetSource = {
    kind: "canonical_record",
    recordType: "RAID_ITEM",
    recordId: blocker.id,
    revision: projectRevision,
  } as const;
  const open = blocker.state === "OPEN" || blocker.state === "IN_PROGRESS";
  if (!open && blocker.status !== "CLEAR")
    throw new Error("Invalid closed critical blocker observation");
  const parameters: DeliveryHealthSignalInput["rule"]["parameters"] = [
    { name: "criticalTargetsPolicyRevision", value: policyRevision },
  ];
  if (blocker.status === "ACTIVE") {
    // The saved blocker-age proof carries the immutable source references.
    // These resolved inputs do not originate on the canonical RAID row.
    parameters.push(
      { name: "resolvedBlocksDelivery", value: true },
      { name: "resolvedOpenedAt", value: blocker.openedAt },
      { name: "ageDays", value: blocker.ageDays },
      { name: "timeZone", value: "UTC" },
      { name: "minimumBlockerAgeDays", value: blocker.minimumBlockerAgeDays },
      { name: "blockerAgeThresholdRevision", value: blocker.thresholdRevision },
    );
  }
  return {
    signalId: "DCB-" + blocker.id.toUpperCase(),
    kind: "CRITICAL_BLOCKER",
    targetType: "RAID_ITEM",
    targetKey: blocker.key,
    targetSource,
    state: blocker.status,
    severity: "CRITICAL",
    rule: { key: "critical-open-blocker", revision: "1", parameters },
    sourceFacts: [fact("raid_item.state", "state", blocker.state, targetSource)],
  };
}

function freshnessSignal(
  observation: DeliveryUpdateObservation,
  targetSource: Extract<Source, { kind: "canonical_record" }>,
): DeliveryHealthSignalInput {
  const assessed = observation.state !== "UNASSESSABLE";
  return {
    signalId: "DELIVERY-UPDATE-FRESHNESS",
    kind: "UPDATE_FRESHNESS",
    targetType: "PROJECT",
    targetKey: "PROJECT-UPDATE",
    targetSource,
    state: assessed
      ? observation.state === "STALE" ? "ACTIVE" : "CLEAR"
      : "UNASSESSABLE",
    severity: "MEDIUM",
    rule: {
      key: "delivery-update-freshness",
      revision: "1",
      parameters: [
        { name: "cadencePolicyRevision", value: observation.policyRevision },
        ...(assessed ? [
          { name: "timeZone", value: observation.timeZone },
          { name: "freshnessWindowSeconds", value: observation.freshnessWindowSeconds },
          { name: "ageMilliseconds", value: observation.ageMilliseconds },
          // Derived from the separately saved, authorized cadence references.
          { name: "latestValidUpdateAt", value: observation.sourceDate },
        ] : []),
      ],
    },
    sourceFacts: [
      fact("project.id", "id", targetSource.recordId, targetSource),
    ],
  };
}

/** Compose the bounded server-authorized inputs for one assessment instant. */
export function buildDeliveryConcernAssessment(options: {
  schedule: DeliveryHealthAssessmentInput;
  criticalTargets: CriticalDeliveryTargets;
  policyRevision: number;
  blockers: readonly CriticalBlockerObservation[];
  update: DeliveryUpdateObservation;
}) {
  const { schedule, policyRevision, blockers, update } = options;
  if (schedule.assessedAt !== update.asOf)
    throw new Error("Delivery concern inputs have different assessment instants");

  const targets = criticalDeliveryTargetsSchema.parse(options.criticalTargets);
  const milestoneIds = new Set(targets.milestoneIds);
  const milestones = schedule.signals.filter((signal) =>
    signal.kind === "OVERDUE_MILESTONE" &&
    signal.targetSource.kind === "canonical_record" &&
    milestoneIds.delete(signal.targetSource.recordId),
  );
  const blockerIds = new Set(targets.raidItemIds);
  if (
    milestoneIds.size > 0 ||
    !blockers.every((blocker) => blockerIds.delete(blocker.id)) ||
    blockerIds.size > 0
  ) throw new Error("Missing or unexpected configured critical target");

  const project = schedule.reportedStatusFact.source;
  if (project.kind !== "canonical_record")
    throw new Error("Invalid reported health source");
  const input: DeliveryHealthAssessmentInput = {
    ...schedule,
    calculationRule: {
      key: "delivery-concern",
      revision: "1",
      severityBands: { red: ["CRITICAL"], amber: ["HIGH", "MEDIUM"], green: ["LOW"] },
    },
    contradictionRule: { key: "delivery-reported-vs-calculated", revision: "1" },
    signals: [
      ...milestones.map((signal): DeliveryHealthSignalInput => ({
        ...signal,
        severity: "CRITICAL",
      })),
      ...blockers.map((blocker) => blockerSignal(blocker, project.revision, policyRevision)),
      freshnessSignal(update, project),
    ],
  };
  const result = assessDeliveryHealth(input);
  const pmReview = result.reported.status === "GREEN" &&
    (result.calculated.status === "RED" || result.calculated.status === "AMBER");
  return {
    input,
    result: {
      ...result,
      recommendation: pmReview ? "PM_REVIEW" as const : null,
    },
  };
}
