import { z } from "zod";
import { canonicalDateSchema, canonicalKeySchema } from "./canonical-project.js";

// FR-HLT-003/009/011, AC-HLT-007: deterministic, internal signal calculation.
// Callers must provide already-authorized canonical records, source mappings and
// current configuration. This module is not a source authorization boundary.
const instant = z
  .string()
  .length(24)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
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
  z.object({ kind: z.literal("canonical_field") }).strict(),
  z
    .object({
      kind: z.literal("external_record"),
      sourceSystem: z.string().min(1).max(64),
      instanceKey: canonicalKeySchema,
      externalType: z.string().min(1).max(64),
      externalId: z.string().min(1).max(200),
      externalRevision: z.string().max(128).nullable(),
    })
    .strict(),
]);
const record = z
  .object({
    targetType: z.enum(["WORK_ITEM", "MILESTONE"]),
    targetKey: canonicalKeySchema,
    state: z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]),
    dueDate: canonicalDateSchema.nullable(),
    dueDateField: z.enum(["plannedEnd", "forecastEnd"]),
    source,
    threshold: z
      .object({
        ruleRevision,
        minimumOverdueDays: z.number().int().min(1).max(3650),
      })
      .strict(),
  })
  .strict();
const inputSchema = z
  .object({
    asOf: instant,
    timeZone: z.string().min(1).max(64),
    records: z.array(record).max(200),
  })
  .strict();
export type OverdueSignalInput = z.infer<typeof inputSchema>;
export type OverdueSignal = {
  kind: "OVERDUE";
  targetType: "WORK_ITEM" | "MILESTONE";
  targetKey: string;
  state: "OPEN" | "IN_PROGRESS";
  dueDate: string;
  dueDateField: "plannedEnd" | "forecastEnd";
  source: z.infer<typeof source>;
  threshold: {
    ruleRevision: string;
    minimumOverdueDays: number;
  };
  daysOverdue: number;
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
  throw new Error("Invalid overdue signal input");
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
    }).formatToParts(new Date(asOf));
    const fields = new Map(parts.map((part) => [part.type, part.value]));
    const year = fields.get("year");
    const month = fields.get("month");
    const day = fields.get("day");
    if (!year || !month || !day) return invalid();
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
 * Calculate configured open work-item and milestone overdue signals at one
 * explicit instant. Date-only due dates expire at the end of their local
 * calendar day. A signal is emitted on a later local date once the configured
 * minimum overdue calendar days have elapsed; DST hours do not change that age.
 */
export function evaluateOverdueSignals(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const request = parsed.data;
  const localDate = localDateAt(request.asOf, request.timeZone);
  const seen = new Set<string>();
  const signals: OverdueSignal[] = [];
  for (const item of request.records) {
    const key = JSON.stringify([item.targetType, item.targetKey]);
    if (seen.has(key)) return invalid();
    seen.add(key);
    if (
      item.dueDate === null ||
      item.state === "COMPLETE" ||
      item.state === "CANCELLED"
    )
      continue;
    const daysOverdue = dayOrdinal(localDate) - dayOrdinal(item.dueDate);
    if (
      daysOverdue < 1 ||
      daysOverdue < item.threshold.minimumOverdueDays
    )
      continue;
    signals.push({
      kind: "OVERDUE",
      targetType: item.targetType,
      targetKey: item.targetKey,
      state: item.state,
      dueDate: item.dueDate,
      dueDateField: item.dueDateField,
      source: item.source,
      threshold: item.threshold,
      daysOverdue,
    });
  }
  signals.sort((left, right) =>
    compare(
      JSON.stringify([
        left.targetType,
        left.targetKey,
        left.dueDateField,
        left.dueDate,
      ]),
      JSON.stringify([
        right.targetType,
        right.targetKey,
        right.dueDateField,
        right.dueDate,
      ]),
    ),
  );
  return freeze({
    asOf: request.asOf,
    timeZone: request.timeZone,
    localDate,
    signals,
  });
}
