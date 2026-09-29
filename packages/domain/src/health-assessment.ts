import { z } from "zod";
import type { Actor } from "./actor.js";
import { canonicalKeySchema, canonicalDateSchema } from "./canonical-project.js";
import { calendarDayDifference, evaluateOverdueSignals } from "./overdue-signals.js";
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
const timeZone = z.string().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
});
const scheduleHealthTargetOverrideSchema = z.strictObject({
  targetType: z.enum(["MILESTONE", "WORK_ITEM"]),
  targetKey: canonicalKeySchema,
  minimumOverdueDays: z.number().int().min(1).max(3650),
});
const scheduleHealthPolicyFields = {
  timeZone,
  defaultMinimumOverdueDays: z.number().int().min(1).max(3650),
  targetOverrides: z.array(scheduleHealthTargetOverrideSchema).max(100),
};
function uniqueScheduleHealthOverrides(
  overrides: readonly z.infer<typeof scheduleHealthTargetOverrideSchema>[],
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  overrides.forEach((override, index) => {
    const key = JSON.stringify([override.targetType, override.targetKey]);
    if (seen.has(key))
      context.addIssue({
        code: "custom",
        path: ["targetOverrides", index],
        message: "Each schedule target may have only one threshold override",
      });
    seen.add(key);
  });
}
export const scheduleHealthPolicySnapshotSchema = z
  .strictObject({
    revision: z.number().int().min(0).max(2147483647),
    ...scheduleHealthPolicyFields,
  })
  .superRefine((policy, context) =>
    uniqueScheduleHealthOverrides(policy.targetOverrides, context),
  );
export type ScheduleHealthPolicySnapshot = z.infer<
  typeof scheduleHealthPolicySnapshotSchema
>;
export const scheduleHealthPolicyViewSchema = z
  .strictObject({
    revision: z.number().int().min(0).max(2147483647),
    ...scheduleHealthPolicyFields,
    changedBy: z.string().min(1).max(256).nullable(),
    changedAt: instant.nullable(),
  })
  .superRefine((policy, context) =>
    uniqueScheduleHealthOverrides(policy.targetOverrides, context),
  );
export type ScheduleHealthPolicyView = z.infer<
  typeof scheduleHealthPolicyViewSchema
>;
export const scheduleHealthPolicyChangeSchema = z
  .strictObject({
    expectedRevision: z.number().int().min(0).max(2147483646),
    ...scheduleHealthPolicyFields,
  })
  .superRefine((policy, context) =>
    uniqueScheduleHealthOverrides(policy.targetOverrides, context),
  );
export type ScheduleHealthPolicyChange = z.infer<
  typeof scheduleHealthPolicyChangeSchema
>;
export const defaultScheduleHealthPolicy: ScheduleHealthPolicySnapshot = {
  revision: 0,
  timeZone: "UTC",
  defaultMinimumOverdueDays: 1,
  targetOverrides: [],
};
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
  scheduleHealthPolicy: scheduleHealthPolicySnapshotSchema.optional(),
  milestones: z.array(scheduleRecord).max(50),
  workItems: z.array(scheduleRecord).max(50),
});
export type ScheduleHealthSnapshot = z.infer<typeof scheduleHealthSnapshotSchema>;
export type ScheduleHealthAssessment = {
  coverage: "SCHEDULE_ONLY";
  input: DeliveryHealthAssessmentInput;
  result: ReturnType<typeof assessDeliveryHealth>;
  scheduleHealthPolicy: ScheduleHealthPolicySnapshot;
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
  coverage: z.enum(["SCHEDULE_ONLY", "SCHEDULE_AND_BLOCKER_AGE"]),
  ruleRevision: z.enum([
    "schedule-health@1",
    "schedule-health@1+blocker-age@1",
    "schedule-health@2+blocker-age@1",
  ]),
  blockerAgeCoverage: z
    .enum(["COMPLETE", "PARTIAL", "UNASSESSABLE"])
    .optional(),
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

export const blockerAgeThresholdPolicyChangeSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2147483646),
  minimumBlockerAgeDays: z.number().int().min(1).max(3650),
  auditRetentionHours: z.number().int().min(1).max(87600),
});
export type BlockerAgeThresholdPolicyChange = z.infer<
  typeof blockerAgeThresholdPolicyChangeSchema
>;
export const blockerAgeThresholdPolicyViewSchema = z.strictObject({
  minimumBlockerAgeDays: z.number().int().min(1).max(3650),
  auditRetentionHours: z.number().int().min(1).max(87600),
  revision: z.number().int().min(1).max(2147483647),
  changedBy: z.string().min(1).max(256),
  changedAt: instant,
});
export type BlockerAgeThresholdPolicyView = z.infer<
  typeof blockerAgeThresholdPolicyViewSchema
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
  blockerAgeThresholdPolicy(
    actor: Actor,
  ): Promise<BlockerAgeThresholdPolicyView | null>;
  scheduleHealthPolicy(
    actor: Actor,
    projectId: string,
  ): Promise<ScheduleHealthPolicyView>;
  setScheduleHealthPolicy(
    actor: Actor,
    projectId: string,
    policy: ScheduleHealthPolicyChange,
    correlationId: string,
  ): Promise<ScheduleHealthPolicyView>;
  setBlockerAgeThresholdPolicy(
    actor: Actor,
    policy: BlockerAgeThresholdPolicyChange,
    correlationId: string,
  ): Promise<BlockerAgeThresholdPolicyView>;
}

const scheduleRule = {
  key: "schedule-health",
  revision: "2",
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

/** Evaluate only the sealed canonical schedule plus its saved project policy. */
export function buildScheduleHealthAssessment(snapshotValue: unknown): ScheduleHealthAssessment {
  const snapshot = scheduleHealthSnapshotSchema.parse(snapshotValue);
  const policy = scheduleHealthPolicySnapshotSchema.parse(
    snapshot.scheduleHealthPolicy ?? defaultScheduleHealthPolicy,
  );
  const projectSource = source("PROJECT", snapshot.projectId, snapshot.projectRevision);
  const records = [
    ...snapshot.milestones.map((item) => ({ item, recordType: "MILESTONE" as const })),
    ...snapshot.workItems.map((item) => ({ item, recordType: "WORK_ITEM" as const })),
  ];
  const overdue = evaluateOverdueSignals({
    asOf: snapshot.assessedAt,
    timeZone: policy.timeZone,
    records: records.map(({ item, recordType }) => {
      const dueDate = item.forecastEnd ?? item.plannedEnd;
      const dueDateField = item.forecastEnd !== null ? "forecastEnd" as const : "plannedEnd" as const;
      const override = policy.targetOverrides.find(
        (candidate) => candidate.targetType === recordType && candidate.targetKey === item.key,
      );
      return {
        targetType: recordType,
        targetKey: item.key,
        state: item.state,
        dueDate,
        dueDateField,
        source: { kind: "canonical_field" as const },
        threshold: {
          ruleRevision: "schedule-health@2",
          minimumOverdueDays: override?.minimumOverdueDays ?? policy.defaultMinimumOverdueDays,
        },
      };
    }),
  });
  const overdueByTarget = new Map(
    overdue.signals.map((signal) => [
      JSON.stringify([signal.targetType, signal.targetKey]),
      signal,
    ]),
  );
  const signals: DeliveryHealthSignalInput[] = records.map(({ item, recordType }) => {
    const targetSource = source(recordType, item.id, snapshot.projectRevision);
    const selectedDate = item.forecastEnd ?? item.plannedEnd;
    const selectedDateField =
      item.forecastEnd !== null
        ? "forecastEnd"
        : item.plannedEnd !== null
          ? "plannedEnd"
          : "none";
    const override = policy.targetOverrides.find(
      (candidate) => candidate.targetType === recordType && candidate.targetKey === item.key,
    );
    const minimumOverdueDays =
      override?.minimumOverdueDays ?? policy.defaultMinimumOverdueDays;
    const overdueSignal = overdueByTarget.get(
      JSON.stringify([recordType, item.key]),
    );
    const daysOverdue =
      (item.state === "OPEN" || item.state === "IN_PROGRESS") &&
      selectedDate !== null
        ? Math.max(0, calendarDayDifference(overdue.localDate, selectedDate))
        : null;
    let signalState: "ACTIVE" | "CLEAR" | "UNASSESSABLE";
    let severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "LOW";
    if (item.state === "COMPLETE" || item.state === "CANCELLED") {
      signalState = "CLEAR";
    } else if (selectedDate === null) {
      signalState = "UNASSESSABLE";
    } else if (overdueSignal) {
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
          { name: "assessedLocalDate", value: overdue.localDate },
          { name: "timeZone", value: policy.timeZone },
          { name: "scheduleHealthPolicyRevision", value: policy.revision },
          { name: "minimumOverdueDays", value: minimumOverdueDays },
          { name: "selectedDateField", value: selectedDateField },
          { name: "daysOverdue", value: overdueSignal?.daysOverdue ?? daysOverdue },
        ],
      },
      sourceFacts: [
        fact(prefix + ".state", "state", item.state, targetSource),
        fact(prefix + ".forecast_end", "forecastEnd", item.forecastEnd, targetSource),
        fact(prefix + ".planned_end", "plannedEnd", item.plannedEnd, targetSource),
        fact(prefix + ".selected_due_date", "selectedDueDate", selectedDate, targetSource),
        fact(prefix + ".selected_due_date_field", "selectedDateField", selectedDateField, targetSource),
        fact(prefix + ".assessed_local_date", "assessedLocalDate", overdue.localDate, targetSource),
        fact(prefix + ".minimum_overdue_days", "minimumOverdueDays", minimumOverdueDays, targetSource),
        fact(prefix + ".days_overdue", "daysOverdue", overdueSignal?.daysOverdue ?? daysOverdue, targetSource),
      ],
    };
  });
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
          { name: "assessedLocalDate", value: overdue.localDate },
          { name: "timeZone", value: policy.timeZone },
          { name: "scheduleHealthPolicyRevision", value: policy.revision },
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
    timeZone: policy.timeZone,
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
      revision: "2",
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
    scheduleHealthPolicy: policy,
  };
}
