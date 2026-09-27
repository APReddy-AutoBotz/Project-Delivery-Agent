import { z } from "zod";
import type { Actor } from "./actor.js";
import { canonicalKeySchema, canonicalDateSchema } from "./canonical-project.js";
import {
  assessDeliveryHealth,
  type DeliveryHealthAssessmentInput,
  type DeliveryHealthSignalInput,
} from "./delivery-health.js";

const safeId = z.uuid().refine((value) => value === value.toLowerCase());
const instant = z.string().length(24).refine((value) => {
  const parsed = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number(value.slice(0, 4)) >= 1 &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value
  );
});
const rag = z.enum(["GREEN", "AMBER", "RED", "UNKNOWN"]);
const state = z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]);
const scheduleRecord = z.strictObject({
  id: safeId,
  key: canonicalKeySchema,
  state,
  forecastEnd: canonicalDateSchema.nullable(),
  plannedEnd: canonicalDateSchema.nullable(),
});
export const scheduleHealthSnapshotSchema = z.strictObject({
  projectId: safeId,
  projectRevision: z.number().int().min(0).max(2147483647).nullable(),
  reportedStatus: rag,
  assessedAt: instant,
  milestones: z.array(scheduleRecord).max(50),
  workItems: z.array(scheduleRecord).max(50),
});
export type ScheduleHealthSnapshot = z.infer<typeof scheduleHealthSnapshotSchema>;
export type ScheduleHealthAssessment = {
  coverage: "SCHEDULE_ONLY";
  input: DeliveryHealthAssessmentInput;
  result: ReturnType<typeof assessDeliveryHealth>;
};

const hours = z.number().int().min(1).max(87600);
export const healthAssessmentRetentionPolicySchema = z
  .strictObject({
    contentRetentionHours: hours,
    auditRetentionHours: hours,
    idempotencyRetentionHours: hours,
  })
  .superRefine((policy, context) => {
    if (policy.auditRetentionHours < policy.contentRetentionHours)
      context.addIssue({
        code: "custom",
        path: ["auditRetentionHours"],
        message: "Audit retention must be at least content retention",
      });
    if (policy.idempotencyRetentionHours < policy.auditRetentionHours)
      context.addIssue({
        code: "custom",
        path: ["idempotencyRetentionHours"],
        message: "Idempotency retention must be at least audit retention",
      });
  });
export type HealthAssessmentRetentionPolicy = z.infer<
  typeof healthAssessmentRetentionPolicySchema
>;
export const healthAssessmentCommandSchema = z.strictObject({
  commandKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const healthAssessmentViewSchema = z.strictObject({
  assessmentId: safeId,
  projectId: safeId,
  assessedAt: instant,
  coverage: z.literal("SCHEDULE_ONLY"),
  ruleRevision: z.literal("schedule-health@1"),
  envelopeHash: z.string().length(64).regex(/^[0-9a-f]{64}$/),
  contentAvailable: z.boolean(),
  input: z.record(z.string(), z.unknown()).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  replayed: z.boolean(),
});
export type HealthAssessmentView = z.infer<typeof healthAssessmentViewSchema>;
export const healthAssessmentRetentionViewSchema = z.strictObject({
  contentRetentionHours: hours,
  auditRetentionHours: hours,
  idempotencyRetentionHours: hours,
  revision: z.number().int().min(1).max(2147483647),
  changedBy: z.string().min(1).max(256),
  changedAt: instant,
});
export type HealthAssessmentRetentionView = z.infer<
  typeof healthAssessmentRetentionViewSchema
>;

export class HealthAssessmentError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "DENIED"
      | "FORBIDDEN"
      | "CONFLICT"
      | "IDEMPOTENCY_RESULT_EXPIRED"
      | "RETENTION_REQUIRED"
      | "UNAVAILABLE",
  ) {
    super(code);
    this.name = "HealthAssessmentError";
  }
}
export interface HealthAssessmentRepository {
  create(
    actor: Actor,
    projectId: string,
    commandKey: string,
    correlationId: string,
  ): Promise<HealthAssessmentView>;
  latest(actor: Actor, projectId: string): Promise<HealthAssessmentView | null>;
  retention(actor: Actor): Promise<HealthAssessmentRetentionView | null>;
  setRetention(
    actor: Actor,
    policy: HealthAssessmentRetentionPolicy,
    correlationId: string,
  ): Promise<HealthAssessmentRetentionView>;
}

const scheduleRule = {
  key: "schedule-health",
  revision: "1",
} as const;
const rule = {
  key: scheduleRule.key,
  revision: scheduleRule.revision,
  parameters: [] as { name: string; value: string | number | boolean | null }[],
};
const source = (
  recordType: "PROJECT" | "MILESTONE" | "WORK_ITEM",
  recordId: string,
  revision: number | null,
) => ({ kind: "canonical_record" as const, recordType, recordId, revision });
const fact = (
  factType: string,
  field: string,
  value: string | number | boolean | null,
  targetSource: ReturnType<typeof source>,
) => ({ factType, field, value, source: targetSource });

function scheduleSignal(
  snapshot: ScheduleHealthSnapshot,
  item: z.infer<typeof scheduleRecord>,
  recordType: "MILESTONE" | "WORK_ITEM",
): DeliveryHealthSignalInput {
  const targetSource = source(recordType, item.id, null);
  const asOfDate = snapshot.assessedAt.slice(0, 10);
  const selectedDate = item.forecastEnd ?? item.plannedEnd;
  const selectedDateField =
    item.forecastEnd !== null
      ? "forecastEnd"
      : item.plannedEnd !== null
        ? "plannedEnd"
        : "none";
  let signalState: "ACTIVE" | "CLEAR" | "UNASSESSABLE";
  let severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "LOW";
  if (item.state === "COMPLETE" || item.state === "CANCELLED") {
    signalState = "CLEAR";
  } else if (selectedDate === null) {
    signalState = "UNASSESSABLE";
  } else if (selectedDate < asOfDate) {
    signalState = "ACTIVE";
    severity = "HIGH";
  } else {
    signalState = "CLEAR";
  }
  const prefix = recordType === "MILESTONE" ? "milestone" : "work_item";
  const kind = recordType === "MILESTONE" ? "OVERDUE_MILESTONE" : "OVERDUE_WORK_ITEM";
  return {
    signalId: "SCHED-" + (recordType === "MILESTONE" ? "MS-" : "WI-") + item.id.toUpperCase(),
    kind,
    targetType: recordType,
    targetKey: item.key,
    targetSource,
    state: signalState,
    severity,
    rule: {
      ...rule,
      parameters: [
        { name: "assessedUtcDate", value: asOfDate },
        { name: "minimumOverdueDays", value: 1 },
        { name: "selectedDateField", value: selectedDateField },
      ],
    },
    sourceFacts: [
      fact(prefix + ".state", "state", item.state, targetSource),
      fact(prefix + ".forecast_end", "forecastEnd", item.forecastEnd, targetSource),
      fact(prefix + ".planned_end", "plannedEnd", item.plannedEnd, targetSource),
      fact(prefix + ".selected_due_date", "selectedDueDate", selectedDate, targetSource),
    ],
  };
}

/** Evaluate only sealed saved schedule configuration. No source mappings, imports, proposals or AI are read. */
export function buildScheduleHealthAssessment(snapshotValue: unknown): ScheduleHealthAssessment {
  const snapshot = scheduleHealthSnapshotSchema.parse(snapshotValue);
  const projectSource = source("PROJECT", snapshot.projectId, snapshot.projectRevision);
  const signals: DeliveryHealthSignalInput[] = [
    ...snapshot.milestones.map((item) =>
      scheduleSignal(snapshot, item, "MILESTONE"),
    ),
    ...snapshot.workItems.map((item) =>
      scheduleSignal(snapshot, item, "WORK_ITEM"),
    ),
  ];
  if (signals.length === 0) {
    signals.push({
      signalId: "SCHEDULE-COVERAGE",
      kind: "SCHEDULE_COVERAGE",
      targetType: "PROJECT",
      targetKey: "PROJECT-SCHEDULE",
      targetSource: projectSource,
      state: "UNASSESSABLE",
      severity: "LOW",
      rule: {
        ...rule,
        parameters: [
          { name: "assessedUtcDate", value: snapshot.assessedAt.slice(0, 10) },
          { name: "scheduleTargetCount", value: 0 },
        ],
      },
      sourceFacts: [
        fact("project.schedule_target_count", "scheduleTargetCount", 0, projectSource),
      ],
    });
  }
  const input: DeliveryHealthAssessmentInput = {
    projectId: snapshot.projectId,
    assessedAt: snapshot.assessedAt,
    timeZone: "UTC",
    sourceSnapshotComplete: true,
    reportedStatus: snapshot.reportedStatus,
    reportedStatusFact: fact(
      "project.reported_status",
      "reportedStatus",
      snapshot.reportedStatus,
      projectSource,
    ),
    calculationRule: {
      key: "schedule-health",
      revision: "1",
      severityBands: {
        red: ["CRITICAL", "HIGH"],
        amber: ["MEDIUM"],
        green: ["LOW"],
      },
    },
    contradictionRule: {
      key: "reported-vs-calculated",
      revision: "1",
    },
    signals,
  };
  return {
    coverage: "SCHEDULE_ONLY",
    input,
    result: assessDeliveryHealth(input),
  };
}
