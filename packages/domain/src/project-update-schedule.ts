import { z } from "zod";
import { canonicalSubjectSchema } from "./canonical-project.js";

const instant = z.string().length(24).refine((value) => {
  const parsed = Date.parse(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const localDateTime = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/)
  .refine((value) => {
    const [year, month, day, hour, minute, second, millisecond] =
      value.match(/\d+/g)!.map(Number);
    if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || day! > 31 ||
        hour! > 23 || minute! > 59 || second! > 59)
      return false;
    const date = new Date(0);
    date.setUTCFullYear(year!, month! - 1, day!);
    date.setUTCHours(hour!, minute!, second!, millisecond!);
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day && date.getUTCHours() === hour &&
      date.getUTCMinutes() === minute && date.getUTCSeconds() === second &&
      date.getUTCMilliseconds() === millisecond;
  });
export const projectUpdateLocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const projectUpdateTimeZoneSchema = z.string().min(1).max(64).refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
});

export const projectUpdateCadenceFieldsSchema = z.strictObject({
  reminderBusinessDayOffsets: z.array(z.number().int().min(1).max(90)).max(8),
  escalationAfterBusinessDays: z.number().int().min(0).max(90),
  escalationRecipientSubject: z.union([canonicalSubjectSchema, z.null()]),
  quietHoursStartLocal: projectUpdateLocalTimeSchema.nullable(),
  quietHoursEndLocal: projectUpdateLocalTimeSchema.nullable(),
}).superRefine((value, context) => {
  for (let index = 1; index < value.reminderBusinessDayOffsets.length; index += 1) {
    if (value.reminderBusinessDayOffsets[index]! <= value.reminderBusinessDayOffsets[index - 1]!) {
      context.addIssue({
        code: "custom",
        path: ["reminderBusinessDayOffsets", index],
        message: "Reminder offsets must be strictly increasing",
      });
    }
  }
  const hasEscalation = value.escalationAfterBusinessDays > 0;
  if (hasEscalation !== (value.escalationRecipientSubject !== null)) {
    context.addIssue({
      code: "custom",
      path: ["escalationRecipientSubject"],
      message: "An escalation recipient is required exactly when escalation is enabled",
    });
  }
  const lastReminder = value.reminderBusinessDayOffsets.at(-1) ?? 0;
  if (hasEscalation && value.escalationAfterBusinessDays <= lastReminder) {
    context.addIssue({
      code: "custom",
      path: ["escalationAfterBusinessDays"],
      message: "Escalation must follow all reminder stages",
    });
  }
  const hasStart = value.quietHoursStartLocal !== null;
  const hasEnd = value.quietHoursEndLocal !== null;
  if (hasStart !== hasEnd ||
      (hasStart && value.quietHoursStartLocal === value.quietHoursEndLocal)) {
    context.addIssue({
      code: "custom",
      path: ["quietHoursEndLocal"],
      message: "Quiet hours require two different local times",
    });
  }
});
export type ProjectUpdateCadenceFields = z.infer<typeof projectUpdateCadenceFieldsSchema>;

export const projectUpdateSchedulePreviewInputSchema = z.strictObject({
  assessmentId: z.uuid(),
  assessmentPolicyRevision: z.number().int().min(1).max(2147483647),
  policyRevision: z.number().int().min(1).max(2147483647),
  asOf: instant,
  sourceDate: instant,
  sourceDateField: z.enum(["project.createdAt", "project.latestValidUpdateAt"]),
  sourceTimeBasis: z.enum(["REQUIRED_FACTS", "PROJECT_CREATED_AT", "UNCONFIRMED"]),
  logicalDueAt: instant,
  timeZone: projectUpdateTimeZoneSchema,
  responsibleSubject: canonicalSubjectSchema,
  cadence: projectUpdateCadenceFieldsSchema,
}).superRefine((input, context) => {
  if (input.assessmentPolicyRevision !== input.policyRevision) {
    context.addIssue({
      code: "custom",
      path: ["assessmentPolicyRevision"],
      message: "Schedule previews require the current policy revision",
    });
  }
});
export type ProjectUpdateSchedulePreviewInput = z.infer<typeof projectUpdateSchedulePreviewInputSchema>;

const scheduleEventSchema = z.strictObject({
  kind: z.enum(["REQUEST", "REMINDER", "ESCALATION"]),
  offsetBusinessDays: z.number().int().min(0).max(90),
  recipientSubject: canonicalSubjectSchema,
  scheduledAt: instant,
  localAt: localDateTime,
  utcOffset: z.string().regex(/^(?:[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/),
});
export const projectUpdateSchedulePreviewSchema = z.strictObject({
  assessmentId: z.uuid(),
  assessmentPolicyRevision: z.number().int().min(1).max(2147483647),
  policyRevision: z.number().int().min(1).max(2147483647),
  asOf: instant,
  timeZone: projectUpdateTimeZoneSchema,
  sourceDate: instant,
  sourceDateField: z.enum(["project.createdAt", "project.latestValidUpdateAt"]),
  sourceTimeBasis: z.enum(["REQUIRED_FACTS", "PROJECT_CREATED_AT", "UNCONFIRMED"]),
  logicalDueAt: instant,
  requestEligibleAt: instant,
  events: z.array(scheduleEventSchema).min(1).max(10),
});
export type ProjectUpdateSchedulePreview = z.infer<typeof projectUpdateSchedulePreviewSchema>;

type WallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};
const datePart = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
};
function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}
function dateValue(parts: WallParts) {
  return pad(parts.year, 4) + "-" + pad(parts.month) + "-" + pad(parts.day);
}
function localValue(parts: WallParts) {
  return dateValue(parts) + "T" + pad(parts.hour) + ":" + pad(parts.minute) + ":" +
    pad(parts.second) + "." + pad(parts.millisecond, 3);
}
function wallEpoch(parts: WallParts) {
  const value = new Date(0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  value.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return value.getTime();
}
function fieldsAt(epoch: number, timeZone: string): WallParts {
  const date = new Date(epoch);
  const fields = new Map(new Intl.DateTimeFormat("en-US", {
    calendar: "gregory",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value] as const));
  const year = Number(fields.get("year"));
  const month = Number(fields.get("month"));
  const day = Number(fields.get("day"));
  const hour = Number(fields.get("hour"));
  const minute = Number(fields.get("minute"));
  const second = Number(fields.get("second"));
  if (![year, month, day, hour, minute, second].every(Number.isInteger) ||
      hour < 0 || hour > 23)
    throw new Error("Invalid project update schedule time zone result");
  return { year, month, day, hour, minute, second, millisecond: date.getUTCMilliseconds() };
}
function offsetMinutesAt(epoch: number, timeZone: string) {
  const parts = fieldsAt(epoch, timeZone);
  return Math.round((wallEpoch({ ...parts, millisecond: 0 }) - (epoch - (epoch % 1000))) / 60000);
}
function offsetsNear(wall: number, timeZone: string) {
  const hours = [-36, -18, 0, 18, 36];
  return [...new Set(hours.map((offset) => offsetMinutesAt(wall + offset * 3600000, timeZone)))];
}
function sameWall(left: WallParts, right: WallParts) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second &&
    left.millisecond === right.millisecond;
}
function exactInstants(parts: WallParts, timeZone: string, offsets: number[]) {
  const wall = wallEpoch(parts);
  return offsets
    .map((offset) => wall - offset * 60000)
    .filter((epoch, index, values) => values.indexOf(epoch) === index)
    .filter((epoch) => sameWall(fieldsAt(epoch, timeZone), parts))
    .sort((left, right) => left - right);
}
function wallFromEpoch(epoch: number): WallParts {
  const value = new Date(epoch);
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
    second: value.getUTCSeconds(),
    millisecond: value.getUTCMilliseconds(),
  };
}

/** Resolve a project-local wall time; overlaps choose the earlier instant and gaps the first valid minute. */
export function resolveProjectScheduleWallTime(
  value: unknown,
  zoneValue: unknown,
  notBeforeEpoch?: number,
) {
  const wall = localDateTime.safeParse(value);
  const zone = projectUpdateTimeZoneSchema.safeParse(zoneValue);
  if (!wall.success || !zone.success ||
      (notBeforeEpoch !== undefined && !Number.isFinite(notBeforeEpoch)))
    throw new Error("Invalid project update schedule wall time");
  const [date, clock] = wall.data.split("T");
  const [hour, minute, secondAndMs] = clock!.split(":");
  const [second, millisecond] = secondAndMs!.split(".");
  const local = {
    ...datePart(date!),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(millisecond),
  };
  const naive = wallEpoch(local);
  const offsets = offsetsNear(naive, zone.data);
  const atOrAfter = (instants: number[]) =>
    instants.filter((epoch) => notBeforeEpoch === undefined || epoch >= notBeforeEpoch);
  const exact = atOrAfter(exactInstants(local, zone.data, offsets));
  if (exact.length) return exact[0]!;
  for (let minuteAfter = 1; minuteAfter <= 1440; minuteAfter += 1) {
    const next = wallFromEpoch(naive + minuteAfter * 60000);
    const resolved = atOrAfter(exactInstants(next, zone.data, offsets));
    if (resolved.length) return resolved[0]!;
  }
  throw new Error("Unresolvable project update schedule wall time");
}
function dateFromOrdinal(date: string) {
  const { year, month, day } = datePart(date);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}
function addCalendarDays(date: string, days: number) {
  const value = dateFromOrdinal(date);
  value.setUTCDate(value.getUTCDate() + days);
  return pad(value.getUTCFullYear(), 4) + "-" + pad(value.getUTCMonth() + 1) + "-" +
    pad(value.getUTCDate());
}
function weekday(date: string) {
  return dateFromOrdinal(date).getUTCDay();
}
function addBusinessDays(date: string, days: number) {
  let result = date;
  let count = 0;
  while (count < days) {
    result = addCalendarDays(result, 1);
    const day = weekday(result);
    if (day !== 0 && day !== 6) count += 1;
  }
  return result;
}
function localTimeMinutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}
function insideQuietHours(parts: WallParts, startValue: string | null, endValue: string | null) {
  if (startValue === null || endValue === null) return false;
  const time = parts.hour * 60 + parts.minute;
  const start = localTimeMinutes(startValue);
  const end = localTimeMinutes(endValue);
  return start < end ? time >= start && time < end : time >= start || time < end;
}
function quietEnd(parts: WallParts, startValue: string, endValue: string): WallParts {
  const start = localTimeMinutes(startValue);
  const end = localTimeMinutes(endValue);
  const time = parts.hour * 60 + parts.minute;
  const crossesMidnight = start > end;
  const nextDate = crossesMidnight && time >= start
    ? addCalendarDays(dateValue(parts), 1)
    : dateValue(parts);
  const [hour, minute] = endValue.split(":").map(Number);
  return { ...datePart(nextDate), hour: hour!, minute: minute!, second: 0, millisecond: 0 };
}
function nextEligible(epoch: number, zone: string, start: string | null, end: string | null) {
  let result = epoch;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const parts = fieldsAt(result, zone);
    if (insideQuietHours(parts, start, end)) {
      result = resolveProjectScheduleWallTime(
        localValue(quietEnd(parts, start!, end!)),
        zone,
        result,
      );
      continue;
    }
    const day = weekday(dateValue(parts));
    if (day === 0 || day === 6) {
      let date = dateValue(parts);
      do { date = addCalendarDays(date, 1); } while (weekday(date) === 0 || weekday(date) === 6);
      result = resolveProjectScheduleWallTime(
        date + "T" + pad(parts.hour) + ":" + pad(parts.minute) + ":" +
          pad(parts.second) + "." + pad(parts.millisecond, 3),
        zone,
        result,
      );
      continue;
    }
    return result;
  }
  throw new Error("Unable to find an eligible project update schedule time");
}
function offsetText(minutes: number) {
  const sign = minutes < 0 ? "-" : "+";
  const magnitude = Math.abs(minutes);
  return sign + pad(Math.floor(magnitude / 60)) + ":" + pad(magnitude % 60);
}
function event(
  kind: "REQUEST" | "REMINDER" | "ESCALATION",
  offsetBusinessDays: number,
  recipientSubject: string,
  epoch: number,
  timeZone: string,
): ProjectUpdateSchedulePreview["events"][number] {
  return {
    kind,
    offsetBusinessDays,
    recipientSubject,
    scheduledAt: new Date(epoch).toISOString(),
    localAt: localValue(fieldsAt(epoch, timeZone)),
    utcOffset: offsetText(offsetMinutesAt(epoch, timeZone)),
  };
}

/** Calculate a transient, deterministic request/reminder/PM schedule from server-selected inputs. */
export function previewProjectUpdateSchedule(value: unknown): ProjectUpdateSchedulePreview {
  const parsed = projectUpdateSchedulePreviewInputSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid project update schedule input");
  const input = parsed.data;
  const dueEpoch = Date.parse(input.logicalDueAt);
  const requestEpoch = nextEligible(
    dueEpoch,
    input.timeZone,
    input.cadence.quietHoursStartLocal,
    input.cadence.quietHoursEndLocal,
  );
  const requestLocal = fieldsAt(requestEpoch, input.timeZone);
  const schedule = [
    event("REQUEST", 0, input.responsibleSubject, requestEpoch, input.timeZone),
  ];
  for (const offset of input.cadence.reminderBusinessDayOffsets) {
    const date = addBusinessDays(dateValue(requestLocal), offset);
    const candidate = resolveProjectScheduleWallTime(
      date + "T" + pad(requestLocal.hour) + ":" + pad(requestLocal.minute) + ":" +
        pad(requestLocal.second) + "." + pad(requestLocal.millisecond, 3),
      input.timeZone,
    );
    const eligible = nextEligible(
      candidate,
      input.timeZone,
      input.cadence.quietHoursStartLocal,
      input.cadence.quietHoursEndLocal,
    );
    schedule.push(event("REMINDER", offset, input.responsibleSubject, eligible, input.timeZone));
  }
  if (input.cadence.escalationAfterBusinessDays > 0) {
    const date = addBusinessDays(dateValue(requestLocal), input.cadence.escalationAfterBusinessDays);
    const candidate = resolveProjectScheduleWallTime(
      date + "T" + pad(requestLocal.hour) + ":" + pad(requestLocal.minute) + ":" +
        pad(requestLocal.second) + "." + pad(requestLocal.millisecond, 3),
      input.timeZone,
    );
    const eligible = nextEligible(
      candidate,
      input.timeZone,
      input.cadence.quietHoursStartLocal,
      input.cadence.quietHoursEndLocal,
    );
    schedule.push(event(
      "ESCALATION",
      input.cadence.escalationAfterBusinessDays,
      input.cadence.escalationRecipientSubject!,
      eligible,
      input.timeZone,
    ));
  }
  return projectUpdateSchedulePreviewSchema.parse({
    assessmentId: input.assessmentId,
    assessmentPolicyRevision: input.assessmentPolicyRevision,
    policyRevision: input.policyRevision,
    asOf: input.asOf,
    timeZone: input.timeZone,
    sourceDate: input.sourceDate,
    sourceDateField: input.sourceDateField,
    sourceTimeBasis: input.sourceTimeBasis,
    logicalDueAt: input.logicalDueAt,
    requestEligibleAt: schedule[0]!.scheduledAt,
    events: schedule,
  });
}
