import { z } from "zod";
import { canonicalKeySchema } from "./canonical-project.js";

// FR-HLT-007/008/009/011, FR-MOD-006, AC-HLT-004: deterministic RAG
// aggregation and reported-versus-calculated comparison. Callers must supply
// a complete, already-authorized snapshot and resolved rule inputs. This pure
// evaluator is not an authorization boundary and does not persist or mutate facts.
const instant = z
  .string()
  .length(24)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number(value.slice(0, 4)) >= 1 &&
      Number.isFinite(time) &&
      new Date(time).toISOString() === value
    );
  });
const revision = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const factType = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/);
const fieldName = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const safeText = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(value),
  );
const valueSchema = z.union([
  safeText,
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const ragStatus = z.enum(["GREEN", "AMBER", "RED", "UNKNOWN"]);
const severity = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const recordType = z.enum(["PROJECT", "MILESTONE", "WORK_ITEM", "RAID_ITEM"]);
const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("canonical_record"),
    recordType,
    recordId: z
      .uuid()
      .refine((value) => value === value.toLowerCase()),
    revision: z.number().int().min(0).max(2147483647).nullable(),
  }),
  z.strictObject({
    kind: z.literal("external_record"),
    sourceSystem: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/),
    instanceKey: canonicalKeySchema,
    recordType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
    recordId: safeText,
    revision: z.string().max(128).nullable(),
  }),
]);
const sourceFactSchema = z.strictObject({
  factType,
  field: fieldName,
  value: valueSchema,
  source: sourceSchema,
});
const ruleParameterSchema = z.strictObject({
  name: fieldName,
  value: valueSchema,
});
const signalRuleSchema = z.strictObject({
  key: canonicalKeySchema,
  revision,
  parameters: z.array(ruleParameterSchema).max(16),
});
const severityBandsSchema = z.strictObject({
  red: z.array(severity).min(1).max(4),
  amber: z.array(severity).max(4),
  green: z.array(severity).max(4),
});
const calculationRuleSchema = z
  .strictObject({
    key: canonicalKeySchema,
    revision,
    severityBands: severityBandsSchema,
  })
  .superRefine((rule, context) => {
    const values = [
      ...rule.severityBands.red,
      ...rule.severityBands.amber,
      ...rule.severityBands.green,
    ];
    if (values.length !== 4 || new Set(values).size !== 4)
      context.addIssue({
        code: "custom",
        message: "Severity bands must assign each severity exactly once",
      });
  });
const targetType = z.enum([
  "PROJECT",
  "MILESTONE",
  "WORK_ITEM",
  "RAID_ITEM",
  "EXTERNAL_RECORD",
]);
const signalKind = z.enum([
  "UPDATE_FRESHNESS",
  "BLOCKER_AGE",
  "OVERDUE_MILESTONE",
  "OVERDUE_WORK_ITEM",
  "COMPLETENESS",
]);
const signalSchema = z.strictObject({
  signalId: canonicalKeySchema,
  kind: signalKind,
  targetType,
  targetKey: canonicalKeySchema,
  targetSource: sourceSchema,
  state: z.enum(["ACTIVE", "CLEAR", "UNASSESSABLE"]),
  severity,
  rule: signalRuleSchema,
  sourceFacts: z.array(sourceFactSchema).min(1).max(16),
});
const requestSchema = z.strictObject({
  projectId: z
    .uuid()
    .refine((value) => value === value.toLowerCase()),
  assessedAt: instant,
  timeZone: z.string().min(1).max(64),
  sourceSnapshotComplete: z.literal(true),
  reportedStatus: ragStatus,
  reportedStatusFact: sourceFactSchema,
  calculationRule: calculationRuleSchema,
  contradictionRule: z.strictObject({
    key: canonicalKeySchema,
    revision,
  }),
  signals: z.array(signalSchema).max(500),
});
export type DeliveryHealthAssessmentInput = z.input<typeof requestSchema>;
export type DeliveryHealthSignalInput = z.input<typeof signalSchema>;
type SeverityValue = z.infer<typeof severity>;
type RagStatus = z.infer<typeof ragStatus>;
type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function invalid(): never {
  throw new Error("Invalid delivery health assessment input");
}
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
function sourceIdentity(source: z.infer<typeof sourceSchema>): string {
  return source.kind === "canonical_record"
    ? JSON.stringify([
        source.kind,
        source.recordType,
        source.recordId,
        source.revision,
      ])
    : JSON.stringify([
        source.kind,
        source.sourceSystem,
        source.instanceKey,
        source.recordType,
        source.recordId,
        source.revision,
      ]);
}
function copySource(source: z.infer<typeof sourceSchema>) {
  return { ...source };
}
function copyFact(fact: z.infer<typeof sourceFactSchema>) {
  return { ...fact, source: copySource(fact.source) };
}
function copySignal(signal: z.infer<typeof signalSchema>) {
  const sourceFacts = signal.sourceFacts.map(copyFact);
  sourceFacts.sort((left, right) =>
    compare(
      JSON.stringify([left.factType, left.field, sourceIdentity(left.source)]),
      JSON.stringify([right.factType, right.field, sourceIdentity(right.source)]),
    ),
  );
  const parameters = signal.rule.parameters.map((parameter) => ({
    ...parameter,
  }));
  parameters.sort((left, right) => compare(left.name, right.name));
  return {
    ...signal,
    targetSource: copySource(signal.targetSource),
    rule: { ...signal.rule, parameters },
    sourceFacts,
  };
}
function validateRequest(request: z.infer<typeof requestSchema>) {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: request.timeZone,
    }).format(new Date(request.assessedAt));
  } catch {
    return invalid();
  }
  const reported = request.reportedStatusFact;
  if (
    reported.factType !== "project.reportedStatus" ||
    reported.field !== "reportedStatus" ||
    reported.value !== request.reportedStatus ||
    reported.source.kind !== "canonical_record" ||
    reported.source.recordType !== "PROJECT" ||
    reported.source.recordId !== request.projectId
  )
    return invalid();

  const signalIds = new Set<string>();
  const signalTargets = new Set<string>();
  for (const signal of request.signals) {
    const targetIdentity = JSON.stringify([
      signal.kind,
      signal.targetType,
      signal.targetKey,
      sourceIdentity(signal.targetSource),
    ]);
    if (signalIds.has(signal.signalId) || signalTargets.has(targetIdentity))
      return invalid();
    signalIds.add(signal.signalId);
    signalTargets.add(targetIdentity);

    if (
      (signal.kind === "UPDATE_FRESHNESS" &&
        signal.targetType !== "PROJECT") ||
      (signal.kind === "COMPLETENESS" && signal.targetType !== "PROJECT") ||
      (signal.kind === "BLOCKER_AGE" &&
        signal.targetType !== "RAID_ITEM" &&
        signal.targetType !== "WORK_ITEM" &&
        signal.targetType !== "EXTERNAL_RECORD") ||
      (signal.kind === "OVERDUE_MILESTONE" &&
        signal.targetType !== "MILESTONE") ||
      (signal.kind === "OVERDUE_WORK_ITEM" &&
        signal.targetType !== "WORK_ITEM")
    )
      return invalid();

    if (
      (signal.targetType === "EXTERNAL_RECORD" &&
        signal.targetSource.kind !== "external_record") ||
      (signal.targetType !== "EXTERNAL_RECORD" &&
        signal.targetSource.kind === "canonical_record" &&
        signal.targetSource.recordType !== signal.targetType)
    )
      return invalid();

    const factIds = new Set<string>();
    for (const fact of signal.sourceFacts) {
      const identity = JSON.stringify([
        fact.factType,
        fact.field,
        sourceIdentity(fact.source),
      ]);
      if (factIds.has(identity)) return invalid();
      factIds.add(identity);
    }
    const parameterNames = signal.rule.parameters.map(
      (parameter) => parameter.name,
    );
    if (new Set(parameterNames).size !== parameterNames.length)
      return invalid();
  }
}
function bandFor(
  value: SeverityValue,
  bands: z.infer<typeof severityBandsSchema>,
): "red" | "amber" | "green" {
  if (bands.red.includes(value)) return "red";
  if (bands.amber.includes(value)) return "amber";
  return "green";
}

/**
 * Preserve the reported RAG and independently aggregate complete objective
 * signal snapshots using explicit, versioned severity bands. Known RED evidence
 * remains RED when another input is unassessable; absent known RED evidence,
 * any unassessable signal prevents a GREEN result.
 */
export function assessDeliveryHealth(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const request = parsed.data;
  validateRequest(request);

  const signals = request.signals.map(copySignal);
  signals.sort((left, right) => compare(left.signalId, right.signalId));
  const active = signals.filter((signal) => signal.state === "ACTIVE");
  const redIds = active
    .filter(
      (signal) =>
        bandFor(signal.severity, request.calculationRule.severityBands) ===
        "red",
    )
    .map((signal) => signal.signalId);
  const amberIds = active
    .filter(
      (signal) =>
        bandFor(signal.severity, request.calculationRule.severityBands) ===
        "amber",
    )
    .map((signal) => signal.signalId);
  const unknownIds = signals
    .filter((signal) => signal.state === "UNASSESSABLE")
    .map((signal) => signal.signalId);

  let calculatedStatus: RagStatus;
  let rationaleCode: string;
  let rationaleSignalIds: string[];
  let rationaleText: string;
  const ruleLabel =
    request.calculationRule.key + "@" + request.calculationRule.revision;
  if (redIds.length > 0) {
    calculatedStatus = "RED";
    rationaleCode = "ACTIVE_RED_SIGNALS";
    rationaleSignalIds = redIds;
    rationaleText =
      "Calculated RED because active red-band delivery signals " +
      redIds.join(", ") +
      " are present under " +
      ruleLabel +
      ".";
  } else if (unknownIds.length > 0) {
    calculatedStatus = "UNKNOWN";
    rationaleCode = "UNASSESSABLE_SIGNALS";
    rationaleSignalIds = unknownIds;
    rationaleText =
      "Calculated status is UNKNOWN because required objective signals " +
      unknownIds.join(", ") +
      " are unassessable.";
  } else if (amberIds.length > 0) {
    calculatedStatus = "AMBER";
    rationaleCode = "ACTIVE_AMBER_SIGNALS";
    rationaleSignalIds = amberIds;
    rationaleText =
      "Calculated AMBER because active amber-band delivery signals " +
      amberIds.join(", ") +
      " are present under " +
      ruleLabel +
      ".";
  } else {
    calculatedStatus = "GREEN";
    rationaleCode = "NO_ELEVATED_ACTIVE_SIGNALS";
    rationaleSignalIds = [];
    rationaleText =
      "Calculated GREEN from the complete objective snapshot because no red- or amber-band signal is active and no required signal is unassessable under " +
      ruleLabel +
      ".";
  }

  const reported = {
    status: request.reportedStatus,
    sourceFact: copyFact(request.reportedStatusFact),
  };
  const calculated = {
    status: calculatedStatus,
    rule: {
      ...request.calculationRule,
      severityBands: {
        red: [...request.calculationRule.severityBands.red].sort(compare),
        amber: [...request.calculationRule.severityBands.amber].sort(compare),
        green: [...request.calculationRule.severityBands.green].sort(compare),
      },
    },
    rationale: {
      code: rationaleCode,
      text: rationaleText,
      signalIds: rationaleSignalIds,
    },
  };
  const contradiction =
    request.reportedStatus !== "UNKNOWN" &&
    calculatedStatus !== "UNKNOWN" &&
    request.reportedStatus !== calculatedStatus
      ? {
          kind: "REPORTED_CALCULATED_MISMATCH" as const,
          severity:
            request.reportedStatus === "RED" || calculatedStatus === "RED"
              ? ("CRITICAL" as const)
              : ("HIGH" as const),
          rule: { ...request.contradictionRule },
          reportedStatus: request.reportedStatus,
          calculatedStatus,
          signalIds: [...rationaleSignalIds],
          rationale:
            "Reported " +
            request.reportedStatus +
            " differs from independently calculated " +
            calculatedStatus +
            " under " +
            request.contradictionRule.key +
            "@" +
            request.contradictionRule.revision +
            ".",
        }
      : null;

  return freeze({
    projectId: request.projectId,
    assessedAt: request.assessedAt,
    timeZone: request.timeZone,
    sourceSnapshotComplete: true as const,
    reported,
    calculated,
    objectiveSignals: signals,
    contradiction,
  });
}
