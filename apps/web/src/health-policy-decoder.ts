import type { BlockerAgeThresholdPolicyView, ScheduleHealthPolicyChange, ScheduleHealthPolicyView } from "@pdaa/domain";

const fail = (): never => { throw new Error("Policy information is unavailable."); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const keys = (value: Record<string, unknown>, expected: string[]) => {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key)) || expected.some((key) => !Object.hasOwn(value, key))) fail();
};
const integer = (value: unknown, min: number, max: number): number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fail();
const text = (value: unknown, min: number, max: number): string => typeof value === "string" && value.length >= min && value.length <= max ? value : fail();
const instant = (value: unknown): string => {
  const result = text(value, 24, 24), time = Date.parse(result);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || result.startsWith("0000-") || !Number.isFinite(time) || new Date(time).toISOString() !== result) return fail();
  return result;
};
const overrides = (value: unknown): ScheduleHealthPolicyChange["targetOverrides"] => {
  if (!Array.isArray(value)) return fail();
  const count = value.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) return fail();
  const seen = new Set<string>();
  const rows: ScheduleHealthPolicyChange["targetOverrides"] = [];
  for (let index = 0; index < count; index++) {
    if (!Object.hasOwn(value, index)) return fail();
    const row = object(value[index]); keys(row, ["targetType", "targetKey", "minimumOverdueDays"]);
    const targetType = row.targetType;
    if (targetType !== "MILESTONE" && targetType !== "WORK_ITEM") return fail();
    const targetKey = text(row.targetKey, 1, 48);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(targetKey)) return fail();
    const key = JSON.stringify([targetType, targetKey]); if (seen.has(key)) return fail(); seen.add(key);
    rows.push({ targetType, targetKey, minimumOverdueDays: integer(row.minimumOverdueDays, 1, 3650) });
  }
  return rows;
};
const fields = (value: Record<string, unknown>) => {
  const timeZone = text(value.timeZone, 1, 64);
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0)); } catch { return fail(); }
  return { timeZone, defaultMinimumOverdueDays: integer(value.defaultMinimumOverdueDays, 1, 3650), targetOverrides: overrides(value.targetOverrides) };
};

function threshold(value: unknown): BlockerAgeThresholdPolicyView | null {
  if (value === null) return null;
  const v = object(value); keys(v, ["minimumBlockerAgeDays", "auditRetentionHours", "revision", "changedBy", "changedAt"]);
  return { minimumBlockerAgeDays: integer(v.minimumBlockerAgeDays, 1, 3650), auditRetentionHours: integer(v.auditRetentionHours, 1, 87600),
    revision: integer(v.revision, 1, 2147483647), changedBy: text(v.changedBy, 1, 256), changedAt: instant(v.changedAt) };
}
function thresholdChange(value: unknown): { expectedRevision: number; minimumBlockerAgeDays: number; auditRetentionHours: number } {
  const v = object(value); keys(v, ["expectedRevision", "minimumBlockerAgeDays", "auditRetentionHours"]);
  return { expectedRevision: integer(v.expectedRevision, 0, 2147483646), minimumBlockerAgeDays: integer(v.minimumBlockerAgeDays, 1, 3650), auditRetentionHours: integer(v.auditRetentionHours, 1, 87600) };
}
function schedule(value: unknown): ScheduleHealthPolicyView {
  const v = object(value); keys(v, ["revision", "timeZone", "defaultMinimumOverdueDays", "targetOverrides", "changedBy", "changedAt"]);
  const changedBy = v.changedBy, changedAt = v.changedAt;
  return { revision: integer(v.revision, 0, 2147483647), ...fields(v), changedBy: changedBy === null ? null : text(changedBy, 1, 256),
    changedAt: changedAt === null ? null : instant(changedAt) };
}
function scheduleChange(value: unknown): ScheduleHealthPolicyChange {
  const v = object(value); keys(v, ["expectedRevision", "timeZone", "defaultMinimumOverdueDays", "targetOverrides"]);
  return { expectedRevision: integer(v.expectedRevision, 0, 2147483646), ...fields(v) };
}
function guarded<T>(decode: (value: unknown) => T, value: unknown): T {
  try { return decode(value); } catch { return fail(); }
}
export const decodeThreshold = (value: unknown): BlockerAgeThresholdPolicyView | null => guarded(threshold, value);
export const decodeThresholdChange = (value: unknown): ReturnType<typeof thresholdChange> => guarded(thresholdChange, value);
export const decodeSchedule = (value: unknown): ScheduleHealthPolicyView => guarded(schedule, value);
export const decodeScheduleChange = (value: unknown): ScheduleHealthPolicyChange => guarded(scheduleChange, value);
