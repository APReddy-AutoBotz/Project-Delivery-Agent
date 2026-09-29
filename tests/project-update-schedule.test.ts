import { describe, expect, it } from "vitest";
import {
  previewProjectUpdateSchedule,
  projectUpdateCadenceFieldsSchema,
  projectUpdatePolicyChangeSchema,
  resolveProjectScheduleWallTime,
} from "../packages/domain/dist/index.js";

const defaults = {
  assessmentId: "20000000-0000-4000-8000-000000000001",
  assessmentPolicyRevision: 2,
  policyRevision: 2,
  asOf: "2026-03-10T12:30:00.000Z",
  sourceDate: "2026-03-06T23:00:00.000Z",
  sourceDateField: "project.latestValidUpdateAt" as const,
  sourceTimeBasis: "REQUIRED_FACTS" as const,
  logicalDueAt: "2026-03-06T23:30:00.000Z",
  timeZone: "America/New_York",
  responsibleSubject: "synthetic-owner-4",
  cadence: {
    reminderBusinessDayOffsets: [1, 2],
    escalationAfterBusinessDays: 3,
    escalationRecipientSubject: "synthetic-owner-1",
    quietHoursStartLocal: "18:00",
    quietHoursEndLocal: "08:00",
  },
};

describe("Project update schedule calculation", () => {
  it("supplies disabled cadence defaults for pre-cadence policy clients", () => {
    const change = projectUpdatePolicyChangeSchema.parse({
      expectedRevision: 0,
      freshnessWindowSeconds: 3600,
      timeZone: "UTC",
      requiredFacts: [{ factType: "project.status", label: "Current status" }],
      responsibleSubject: "synthetic-owner-4",
      scheduledScanEnabled: false,
    });
    expect(change).toMatchObject({
      reminderBusinessDayOffsets: [],
      escalationAfterBusinessDays: 0,
      escalationRecipientSubject: null,
      quietHoursStartLocal: null,
      quietHoursEndLocal: null,
    });
  });

  it("defers a Friday request through quiet hours and the weekend, then counts business days in the project zone", () => {
    const result = previewProjectUpdateSchedule(defaults);
    expect(result).toMatchObject({
      assessmentId: defaults.assessmentId,
      assessmentPolicyRevision: 2,
      policyRevision: 2,
      timeZone: "America/New_York",
      sourceDate: defaults.sourceDate,
      sourceDateField: "project.latestValidUpdateAt",
      sourceTimeBasis: "REQUIRED_FACTS",
      logicalDueAt: "2026-03-06T23:30:00.000Z",
      requestEligibleAt: "2026-03-09T12:00:00.000Z",
    });
    expect(result.events.map((event) => [
      event.kind,
      event.offsetBusinessDays,
      event.scheduledAt,
      event.localAt,
      event.utcOffset,
      event.recipientSubject,
    ])).toEqual([
      ["REQUEST", 0, "2026-03-09T12:00:00.000Z", "2026-03-09T08:00:00.000", "-04:00", "synthetic-owner-4"],
      ["REMINDER", 1, "2026-03-10T12:00:00.000Z", "2026-03-10T08:00:00.000", "-04:00", "synthetic-owner-4"],
      ["REMINDER", 2, "2026-03-11T12:00:00.000Z", "2026-03-11T08:00:00.000", "-04:00", "synthetic-owner-4"],
      ["ESCALATION", 3, "2026-03-12T12:00:00.000Z", "2026-03-12T08:00:00.000", "-04:00", "synthetic-owner-1"],
    ]);
    expect(previewProjectUpdateSchedule(defaults)).toEqual(result);
  });

  it("labels the canonical creation timestamp as the source-time fallback", () => {
    const result = previewProjectUpdateSchedule({
      ...defaults,
      sourceDateField: "project.createdAt",
      sourceTimeBasis: "PROJECT_CREATED_AT",
    });
    expect(result.sourceTimeBasis).toBe("PROJECT_CREATED_AT");
  });

  it("treats quiet-hour start as included, end as excluded, and supports intervals crossing midnight", () => {
    const start = previewProjectUpdateSchedule({
      ...defaults,
      timeZone: "UTC",
      logicalDueAt: "2026-02-02T22:00:00.000Z",
      cadence: {
        reminderBusinessDayOffsets: [],
        escalationAfterBusinessDays: 0,
        escalationRecipientSubject: null,
        quietHoursStartLocal: "22:00",
        quietHoursEndLocal: "07:00",
      },
    });
    expect(start.requestEligibleAt).toBe("2026-02-03T07:00:00.000Z");

    const end = previewProjectUpdateSchedule({
      ...defaults,
      timeZone: "UTC",
      logicalDueAt: "2026-02-02T07:00:00.000Z",
      cadence: {
        reminderBusinessDayOffsets: [],
        escalationAfterBusinessDays: 0,
        escalationRecipientSubject: null,
        quietHoursStartLocal: "22:00",
        quietHoursEndLocal: "07:00",
      },
    });
    expect(end.requestEligibleAt).toBe("2026-02-02T07:00:00.000Z");
  });

  it("defers a weekend event inside overnight quiet hours to the first weekday quiet end", () => {
    const result = previewProjectUpdateSchedule({
      ...defaults,
      timeZone: "UTC",
      logicalDueAt: "2026-02-07T23:00:00.000Z",
      cadence: {
        reminderBusinessDayOffsets: [],
        escalationAfterBusinessDays: 0,
        escalationRecipientSubject: null,
        quietHoursStartLocal: "22:00",
        quietHoursEndLocal: "08:00",
      },
    });
    expect(result.requestEligibleAt).toBe("2026-02-09T08:00:00.000Z");
    expect(result.events[0]!.localAt).toBe("2026-02-09T08:00:00.000");
  });

  it("resolves daylight-saving gaps forward to the first valid local minute and overlaps to the earlier instant", () => {
    expect(resolveProjectScheduleWallTime(
      "2026-03-29T02:30:00.000",
      "Europe/Paris",
    )).toBe(Date.parse("2026-03-29T01:00:00.000Z"));
    expect(resolveProjectScheduleWallTime(
      "2026-10-25T02:30:00.000",
      "Europe/Paris",
    )).toBe(Date.parse("2026-10-25T00:30:00.000Z"));
    expect(resolveProjectScheduleWallTime(
      "2026-11-01T01:30:00.000",
      "America/New_York",
      Date.parse("2026-11-01T06:15:00.000Z"),
    )).toBe(Date.parse("2026-11-01T06:30:00.000Z"));
  });

  it("rejects unordered or unbounded stages, invalid quiet hours, and incomplete escalation configuration", () => {
    const valid = defaults.cadence;
    expect(projectUpdateCadenceFieldsSchema.safeParse(valid).success).toBe(true);
    for (const cadence of [
      { ...valid, reminderBusinessDayOffsets: [2, 2] },
      { ...valid, reminderBusinessDayOffsets: [91] },
      { ...valid, escalationAfterBusinessDays: 2 },
      { ...valid, escalationRecipientSubject: null },
      { ...valid, quietHoursEndLocal: null },
      { ...valid, quietHoursStartLocal: "08:00", quietHoursEndLocal: "08:00" },
    ])
      expect(projectUpdateCadenceFieldsSchema.safeParse(cadence).success).toBe(false);
  });

  it("rejects mismatched revisions, invalid zones, and normalized calendar dates", () => {
    expect(() => previewProjectUpdateSchedule({
      ...defaults,
      assessmentPolicyRevision: 1,
    })).toThrow();
    expect(() => previewProjectUpdateSchedule({
      ...defaults,
      timeZone: "Mars/Olympus",
    })).toThrow();
    expect(() => resolveProjectScheduleWallTime(
      "2026-02-30T09:00:00.000",
      "UTC",
    )).toThrow();
  });
});
