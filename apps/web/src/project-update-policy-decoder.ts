type RequiredFact = { factType: string; label: string };
export type Policy = {
  projectId: string;
  key: string;
  revision: number;
  freshnessWindowSeconds: number;
  timeZone: string;
  requiredFacts: RequiredFact[];
  responsibleSubject: string;
  scheduledScanEnabled: boolean;
  reminderBusinessDayOffsets: number[];
  escalationAfterBusinessDays: number;
  escalationRecipientSubject: string | null;
  quietHoursStartLocal: string | null;
  quietHoursEndLocal: string | null;
  changedBy: string;
  changedAt: string;
};
// Fail closed on malformed policy snapshots before using them as a write base.
// This is a local presentation boundary, not a replacement for API validation.
export function decodePolicy(value: unknown, projectId: string): Policy | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reporting policy is unavailable.");
  const policy = value as Record<string, unknown>;
  const expected = ["projectId", "key", "revision", "freshnessWindowSeconds", "timeZone", "requiredFacts", "responsibleSubject",
    "scheduledScanEnabled", "reminderBusinessDayOffsets", "escalationAfterBusinessDays", "escalationRecipientSubject",
    "quietHoursStartLocal", "quietHoursEndLocal", "changedBy", "changedAt"].sort();
  const integer = (item: unknown, min: number, max: number) => typeof item === "number" && Number.isSafeInteger(item) && item >= min && item <= max;
  const text = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 200 &&
    // eslint-disable-next-line no-control-regex -- Match the wire subject contract.
    /^\S(?:[^\u0000-\u001f\u007f]*\S)?$/.test(item) && /^[^\u0000-\u001f\u007f]+$/.test(item);
  const localTime = (item: unknown) => item === null || (typeof item === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(item));
  const instant = (item: unknown) => {
    if (typeof item !== "string") return false;
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z$/.exec(item);
    if (!match) return false;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const date = new Date(0); date.setUTCFullYear(year!, month! - 1, day!); date.setUTCHours(hour!, minute!, second!, 0);
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day &&
      date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  };
  if (Object.keys(policy).sort().join("\0") !== expected.join("\0") || policy.projectId !== projectId ||
      typeof policy.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(policy.key) ||
      !integer(policy.revision, 1, 2147483647) || !integer(policy.freshnessWindowSeconds, 1, 315360000) ||
      typeof policy.timeZone !== "string" || !policy.timeZone.length || policy.timeZone.length > 64 ||
      !text(policy.responsibleSubject) || !text(policy.changedBy) || !instant(policy.changedAt) ||
      typeof policy.scheduledScanEnabled !== "boolean" || !Array.isArray(policy.requiredFacts) ||
      policy.requiredFacts.length < 1 || policy.requiredFacts.length > 100 || !Array.isArray(policy.reminderBusinessDayOffsets) ||
      policy.reminderBusinessDayOffsets.length > 8 || !integer(policy.escalationAfterBusinessDays, 0, 90) ||
      !(policy.escalationRecipientSubject === null || text(policy.escalationRecipientSubject)) ||
      !localTime(policy.quietHoursStartLocal) || !localTime(policy.quietHoursEndLocal)) throw new Error("Reporting policy is unavailable.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: policy.timeZone }).format(0); }
  catch { throw new Error("Reporting policy is unavailable."); }
  for (const fact of policy.requiredFacts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact) || Object.keys(fact).sort().join(",") !== "factType,label") throw new Error("Reporting policy is unavailable.");
    const row = fact as Record<string, unknown>;
    if (typeof row.factType !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(row.factType) ||
        typeof row.label !== "string" || !row.label.trim() || row.label.length > 160 || new TextEncoder().encode(row.label).length > 160 ||
        /[\p{Cc}\p{Surrogate}]/u.test(row.label)) throw new Error("Reporting policy is unavailable.");
  }
  const offsets = policy.reminderBusinessDayOffsets as unknown[];
  if (offsets.some((offset, index) => !integer(offset, 1, 90) || (index > 0 && (offset as number) <= (offsets[index - 1] as number))) ||
      ((policy.escalationAfterBusinessDays as number) > 0) !== (policy.escalationRecipientSubject !== null) ||
      ((policy.escalationAfterBusinessDays as number) > 0 && (policy.escalationAfterBusinessDays as number) <= ((offsets.at(-1) as number | undefined) ?? 0)) ||
      (policy.quietHoursStartLocal === null) !== (policy.quietHoursEndLocal === null) ||
      (policy.quietHoursStartLocal !== null && policy.quietHoursStartLocal === policy.quietHoursEndLocal)) throw new Error("Reporting policy is unavailable.");
  return policy as Policy;
}
