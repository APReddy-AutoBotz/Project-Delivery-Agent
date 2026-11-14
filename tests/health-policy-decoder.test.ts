import { expect, it } from "vitest";
import { blockerAgeThresholdPolicyChangeSchema, blockerAgeThresholdPolicyViewSchema, scheduleHealthPolicyChangeSchema, scheduleHealthPolicyViewSchema } from "../packages/domain/src/index.js";
import { decodeSchedule, decodeScheduleChange, decodeThreshold, decodeThresholdChange } from "../apps/web/src/health-policy-decoder.js";

const changedAt = "2026-10-21T00:00:00.000Z";
const threshold = { revision: 1, minimumBlockerAgeDays: 3, auditRetentionHours: 24, changedBy: "subject", changedAt };
const schedule = { revision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], changedBy: null, changedAt: null };
const row = { targetType: "MILESTONE", targetKey: "MS-1", minimumOverdueDays: 2 };
const accepts = (decode: (value: unknown) => unknown, value: unknown) => {
  try { decode(value); return true; } catch { return false; }
};

it("matches the domain threshold contracts on representative valid and invalid values", () => {
  const views: unknown[] = [null, threshold, { ...threshold, revision: 0 }, { ...threshold, revision: 2147483647 },
    { ...threshold, changedAt: "2026-02-30T00:00:00.000Z" }, { ...threshold, changedBy: "" }, { ...threshold, extra: true },
    { ...threshold, minimumBlockerAgeDays: 3651 }, { ...threshold, auditRetentionHours: 0 }];
  for (const value of views) expect(accepts(decodeThreshold, value)).toBe(blockerAgeThresholdPolicyViewSchema.nullable().safeParse(value).success);
  const changes: unknown[] = [{ expectedRevision: 0, minimumBlockerAgeDays: 1, auditRetentionHours: 1 },
    { expectedRevision: 2147483646, minimumBlockerAgeDays: 3650, auditRetentionHours: 87600 },
    { expectedRevision: 2147483647, minimumBlockerAgeDays: 1, auditRetentionHours: 1 },
    { expectedRevision: 1, minimumBlockerAgeDays: 2.5, auditRetentionHours: 1 }];
  for (const value of changes) expect(accepts(decodeThresholdChange, value)).toBe(blockerAgeThresholdPolicyChangeSchema.safeParse(value).success);
});

it("matches schedule contracts, including override uniqueness and reordered object fields", () => {
  const views: unknown[] = [schedule, { ...schedule, revision: 2, changedAt, changedBy: "subject", targetOverrides: [row] },
    { ...schedule, timeZone: "Not/A_Real_Zone" }, { ...schedule, targetOverrides: [row, row] },
    { ...schedule, targetOverrides: [{ ...row, targetKey: "bad key" }] }, { ...schedule, targetOverrides: new Array(1) },
    { ...schedule, changedAt: "2026-02-30T00:00:00.000Z" }, { ...schedule, extra: true }];
  for (const value of views) expect(accepts(decodeSchedule, value)).toBe(scheduleHealthPolicyViewSchema.safeParse(value).success);
  const changes: unknown[] = [{ expectedRevision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] },
    { expectedRevision: 2, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [{ minimumOverdueDays: 2, targetKey: "MS-1", targetType: "MILESTONE" }] },
    { expectedRevision: 2, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [row, row] },
    { expectedRevision: 2147483647, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] }];
  for (const value of changes) expect(accepts(decodeScheduleChange, value)).toBe(scheduleHealthPolicyChangeSchema.safeParse(value).success);
  expect(decodeScheduleChange(changes[1])).toMatchObject({ targetOverrides: [row] });
});

it("matches policy schemas at limits and on missing, extra or duplicate JSON fields", () => {
  const many = Array.from({ length: 101 }, (_, index) => ({ targetType: "WORK_ITEM", targetKey: `WI-${index}`, minimumOverdueDays: 3650 }));
  const scheduleViews: unknown[] = [null, {}, { ...schedule, changedAt: undefined }, { ...schedule, changedBy: "x".repeat(256) },
    { ...schedule, changedBy: "x".repeat(257) }, { ...schedule, defaultMinimumOverdueDays: 3650 },
    { ...schedule, defaultMinimumOverdueDays: 3651 }, { ...schedule, targetOverrides: many.slice(0, 100) },
    { ...schedule, targetOverrides: many }, { ...schedule, targetOverrides: [row, { ...row, minimumOverdueDays: 3 }] }];
  for (const value of scheduleViews) expect(accepts(decodeSchedule, value)).toBe(scheduleHealthPolicyViewSchema.safeParse(value).success);
  const scheduleChanges: unknown[] = [null, {}, { expectedRevision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1 },
    { expectedRevision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], extra: 1 },
    { expectedRevision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: many.slice(0, 100).reverse() }];
  for (const value of scheduleChanges) expect(accepts(decodeScheduleChange, value)).toBe(scheduleHealthPolicyChangeSchema.safeParse(value).success);
  const thresholdChanges: unknown[] = [null, {}, { expectedRevision: 0, minimumBlockerAgeDays: 1 },
    { expectedRevision: 0, minimumBlockerAgeDays: 1, auditRetentionHours: 1, extra: 1 }];
  for (const value of thresholdChanges) expect(accepts(decodeThresholdChange, value)).toBe(blockerAgeThresholdPolicyChangeSchema.safeParse(value).success);
});

it("rejects inherited-field key spoofing and snapshots a changing override count", () => {
  const spoof = Object.assign(Object.create({ changedAt, changedBy: "subject" }), {
    auditRetentionHours: 24, "changedAt,changedBy": "unexpected", minimumBlockerAgeDays: 3, revision: 1,
  });
  expect(() => decodeThreshold(spoof)).toThrow("Policy information is unavailable.");
  expect(blockerAgeThresholdPolicyViewSchema.safeParse(spoof).success).toBe(false);
  let reads = 0;
  const dynamic = new Proxy([row], { get(target, key, receiver) {
    if (key === "length") { reads++; return reads === 1 ? 1 : 1000000; }
    return Reflect.get(target, key, receiver);
  } });
  expect(decodeSchedule({ ...schedule, targetOverrides: dynamic }).targetOverrides).toEqual([row]);
  expect(reads).toBe(1);
});

it("rejects non-enumerable field spoofing and hides hostile getter errors", () => {
  const hidden = { ...threshold, unexpected: true };
  Object.defineProperty(hidden, "changedAt", { value: changedAt, enumerable: false });
  expect(() => decodeThreshold(hidden)).toThrow("Policy information is unavailable.");
  const hostile = new Proxy({}, { ownKeys() { throw new Error("synthetic-private-detail"); } });
  expect(() => decodeThreshold(hostile)).toThrow(/^Policy information is unavailable\.$/);
  let reads = 0;
  const dynamic = { ...row, get targetType() { reads++; return reads === 1 ? "MILESTONE" : "invalid"; } };
  expect(decodeSchedule({ ...schedule, targetOverrides: [dynamic] }).targetOverrides).toEqual([row]);
  expect(reads).toBe(1);
});
