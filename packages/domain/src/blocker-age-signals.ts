import { z } from "zod";
import { canonicalDateSchema, canonicalKeySchema } from "./canonical-project.js";

// FR-HLT-004/009/011, AC-HLT-003: deterministic, read-only calculation.
// Callers must provide the complete, already-authorized blocker snapshot,
// source mappings and current rule. This module is not an authorization boundary.
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
const ruleRevision = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const source = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("canonical_field") }),
  z.strictObject({
    kind: z.literal("external_record"),
    sourceSystem: z.string().min(1).max(64),
    instanceKey: canonicalKeySchema,
    externalType: z.string().min(1).max(64),
    externalId: z.string().min(1).max(200),
    externalRevision: z.string().max(128).nullable(),
  }),
]);
const sourceDateField = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/);
const blocker = z.strictObject({
  targetType: z.enum(["RAID_ITEM", "WORK_ITEM", "EXTERNAL_RECORD"]),
  targetKey: canonicalKeySchema,
  state: z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]),
  sourceDate: canonicalDateSchema.nullable(),
  sourceDateField: sourceDateField.nullable(),
  source,
});
const thresholdSchema = z.strictObject({
  ruleKey: canonicalKeySchema,
  ruleRevision,
  minimumBlockerAgeDays: z.number().int().min(1).max(3650),
});
const requestSchema = z.strictObject({
  asOf: instant,
  timeZone: z.string().min(1).max(64),
  blockerReadComplete: z.literal(true),
  threshold: thresholdSchema,
  blockers: z.array(blocker).max(200),
});
export type BlockerAgeSignalInput = z.input<typeof requestSchema>;
type BlockerRecord = z.infer<typeof blocker>;
type BlockerAgeThreshold = z.infer<typeof thresholdSchema>;
export type BlockerAgeSignal = {
  targetType: BlockerRecord["targetType"];
  targetKey: string;
  state: "OPEN" | "IN_PROGRESS";
  sourceDate: string | null;
  sourceDateField: string | null;
  source: z.infer<typeof source>;
  ageDays: number | null;
  threshold: BlockerAgeThreshold;
  thresholdExceeded: boolean | null;
  status: "AGED" | "WITHIN_THRESHOLD" | "UNASSESSABLE";
};
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
  throw new Error("Invalid blocker age signal input");
}
function dayOrdinal(value: string): number {
  const parts = value.split("-").map(Number);
  const year = parts[0]!;
  const month = parts[1]!;
  const day = parts[2]!;
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra;
}
function localDateAt(asOf: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      era: "short",
    }).formatToParts(new Date(asOf));
    const fields = new Map(parts.map((part) => [part.type, part.value] as const));
    const year = fields.get("year");
    const month = fields.get("month");
    const day = fields.get("day");
    const era = fields.get("era");
    if (!year || !month || !day || era !== "AD") return invalid();
    const result = year.padStart(4, "0") + "-" + month + "-" + day;
    if (!canonicalDateSchema.safeParse(result).success) return invalid();
    return result;
  } catch {
    return invalid();
  }
}
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Assess every open blocker in a complete source snapshot at one explicit
 * instant. Age is elapsed local calendar days, so DST hours do not change it.
 * A missing source date remains unassessable and is never treated as fresh.
 */
export function evaluateBlockerAgeSignals(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const request = parsed.data;
  const localDate = localDateAt(request.asOf, request.timeZone);
  const seen = new Set<string>();
  const assessments: BlockerAgeSignal[] = [];
  for (const item of request.blockers) {
    const identity = JSON.stringify([item.targetType, item.targetKey]);
    if (seen.has(identity)) return invalid();
    seen.add(identity);
    if ((item.sourceDate === null) !== (item.sourceDateField === null))
      return invalid();
    if (
      item.state === "COMPLETE" ||
      item.state === "CANCELLED"
    )
      continue;
    if (item.sourceDate === null) {
      assessments.push({
        targetType: item.targetType,
        targetKey: item.targetKey,
        state: item.state,
        sourceDate: null,
        sourceDateField: null,
        source: item.source,
        ageDays: null,
        threshold: request.threshold,
        thresholdExceeded: null,
        status: "UNASSESSABLE",
      });
      continue;
    }
    if (item.sourceDate > localDate) return invalid();
    const ageDays = dayOrdinal(localDate) - dayOrdinal(item.sourceDate);
    const thresholdExceeded =
      ageDays >= request.threshold.minimumBlockerAgeDays;
    assessments.push({
      targetType: item.targetType,
      targetKey: item.targetKey,
      state: item.state,
      sourceDate: item.sourceDate,
      sourceDateField: item.sourceDateField,
      source: item.source,
      ageDays,
      threshold: request.threshold,
      thresholdExceeded,
      status: thresholdExceeded ? "AGED" : "WITHIN_THRESHOLD",
    });
  }
  assessments.sort((left, right) =>
    compare(
      JSON.stringify([left.targetType, left.targetKey]),
      JSON.stringify([right.targetType, right.targetKey]),
    ),
  );
  return freeze({
    asOf: request.asOf,
    timeZone: request.timeZone,
    localDate,
    threshold: request.threshold,
    assessments,
  });
}
