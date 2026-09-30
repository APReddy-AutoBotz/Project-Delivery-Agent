import { describe, expect, it } from "vitest";
import { planProjectUpdateRecipientStage } from "../packages/domain/dist/index.js";

const initial = {
  kind: "REQUEST",
  ordinal: 0,
  recipientSubject: "synthetic-owner-4",
  recipientRole: "OWNER",
  logicalDueAt: "2026-03-06T23:30:00.000Z",
  anchorAt: "2026-03-06T23:30:00.000Z",
  recipientTimeZone: "America/New_York",
  projectTimeZone: "UTC",
  customerTimeZone: "Asia/Kolkata",
  quietHoursStartLocal: "18:00",
  quietHoursEndLocal: "08:00",
};

describe("EXEC-015 recipient-stage snapshots", () => {
  it("uses recipient-local quiet hours, weekends and DST, with durable reason and offset metadata", () => {
    const result = planProjectUpdateRecipientStage(initial);
    expect(result).toMatchObject({
      recipientSubject: initial.recipientSubject,
      recipientRole: "OWNER",
      timeZone: "America/New_York",
      zoneSource: "RECIPIENT",
      candidateAt: initial.logicalDueAt,
      scheduledAt: "2026-03-09T12:00:00.000Z",
      localAt: "2026-03-09T08:00:00",
      utcOffset: "-04:00",
      deferralReasons: ["QUIET_HOURS", "WEEKEND"],
      ruleRevision: "engagement-schedule@1",
    });
    expect(planProjectUpdateRecipientStage(initial)).toEqual(result);
  });

  it("falls back explicitly from recipient to project to customer, rejecting any configured invalid zone", () => {
    expect(planProjectUpdateRecipientStage({
      ...initial, recipientTimeZone: null,
    })).toMatchObject({ timeZone: "UTC", zoneSource: "PROJECT" });
    expect(planProjectUpdateRecipientStage({
      ...initial, recipientTimeZone: null, projectTimeZone: null, customerTimeZone: "Asia/Tokyo",
    })).toMatchObject({ timeZone: "Asia/Tokyo", zoneSource: "CUSTOMER" });
    for (const field of ["recipientTimeZone", "projectTimeZone", "customerTimeZone"])
      expect(() => planProjectUpdateRecipientStage({
        ...initial, [field]: "Mars/Olympus",
      })).toThrow();
  });

  it("normalizes named zone case and rejects numeric offsets before a persistable snapshot", () => {
    expect(planProjectUpdateRecipientStage({
      ...initial, recipientTimeZone: "america/new_york",
    })).toMatchObject({ timeZone: "America/New_York", zoneSource: "RECIPIENT" });
    for (const zone of ["+05:30", "-04:00"])
      for (const field of ["recipientTimeZone", "projectTimeZone", "customerTimeZone"])
        expect(() => planProjectUpdateRecipientStage({ ...initial, [field]: zone })).toThrow();
  });

  it("counts owner reminder offsets from the eligible owner request, preserving the anchor wall time", () => {
    const request = planProjectUpdateRecipientStage(initial);
    const reminder = planProjectUpdateRecipientStage({
      ...initial, kind: "REMINDER", ordinal: 2, anchorAt: request.scheduledAt,
    });
    expect(reminder).toMatchObject({
      logicalDueAt: initial.logicalDueAt,
      candidateAt: "2026-03-11T12:00:00.000Z",
      scheduledAt: "2026-03-11T12:00:00.000Z",
      localAt: "2026-03-11T08:00:00",
      deferralReasons: [],
    });
  });

  it("applies PM local eligibility to the owner escalation instant without adding ordinal days twice", () => {
    const request = planProjectUpdateRecipientStage(initial);
    const ownerEscalation = planProjectUpdateRecipientStage({
      ...initial, kind: "ESCALATION", ordinal: 3, anchorAt: request.scheduledAt,
    });
    expect(ownerEscalation.scheduledAt).toBe("2026-03-12T12:00:00.000Z");
    const pmEscalation = planProjectUpdateRecipientStage({
      ...initial, kind: "ESCALATION", ordinal: 3,
      recipientSubject: "synthetic-owner-1", recipientRole: "PROJECT_MANAGER",
      recipientTimeZone: "Asia/Tokyo", anchorAt: ownerEscalation.scheduledAt,
    });
    expect(pmEscalation).toMatchObject({
      candidateAt: ownerEscalation.scheduledAt,
      scheduledAt: "2026-03-12T23:00:00.000Z",
      localAt: "2026-03-13T08:00:00",
      utcOffset: "+09:00",
      deferralReasons: ["QUIET_HOURS"],
    });
    expect(Date.parse(pmEscalation.scheduledAt)).toBeGreaterThanOrEqual(
      Date.parse(ownerEscalation.scheduledAt),
    );
  });

  it("records a spring gap at quiet-hour end before the weekend move", () => {
    const result = planProjectUpdateRecipientStage({
      ...initial,
      logicalDueAt: "2026-03-28T23:00:00.000Z",
      anchorAt: "2026-03-28T23:00:00.000Z",
      recipientTimeZone: "Europe/Paris",
      quietHoursStartLocal: "00:00", quietHoursEndLocal: "02:30",
    });
    expect(result).toMatchObject({
      scheduledAt: "2026-03-30T01:00:00.000Z",
      localAt: "2026-03-30T03:00:00",
      utcOffset: "+02:00",
      deferralReasons: ["QUIET_HOURS", "DST_GAP", "WEEKEND"],
    });
  });

  it("preserves the lower bound during the second autumn overlap occurrence", () => {
    const result = planProjectUpdateRecipientStage({
      ...initial,
      logicalDueAt: "2026-11-01T06:15:00.000Z",
      anchorAt: "2026-11-01T06:15:00.000Z",
      quietHoursStartLocal: "00:00", quietHoursEndLocal: "01:30",
    });
    expect(result).toMatchObject({
      scheduledAt: "2026-11-02T06:30:00.000Z",
      localAt: "2026-11-02T01:30:00",
      utcOffset: "-05:00",
      deferralReasons: ["QUIET_HOURS", "WEEKEND"],
    });
  });

  it("treats quiet start as inclusive and end as exclusive", () => {
    const base = {
      ...initial, recipientTimeZone: "UTC",
      logicalDueAt: "2026-02-02T22:00:00.000Z",
      anchorAt: "2026-02-02T22:00:00.000Z",
      quietHoursStartLocal: "22:00", quietHoursEndLocal: "07:00",
    };
    expect(planProjectUpdateRecipientStage(base)).toMatchObject({
      scheduledAt: "2026-02-03T07:00:00.000Z", deferralReasons: ["QUIET_HOURS"],
    });
    expect(planProjectUpdateRecipientStage({
      ...base, logicalDueAt: "2026-02-02T07:00:00.000Z", anchorAt: "2026-02-02T07:00:00.000Z",
    })).toMatchObject({
      scheduledAt: "2026-02-02T07:00:00.000Z", deferralReasons: [],
    });
  });

  it("rejects invalid stage identities, calendar values and a backward anchor", () => {
    for (const change of [
      { ordinal: 1 }, { kind: "REMINDER", ordinal: 0 },
      { kind: "ESCALATION", ordinal: 0 },
      { recipientRole: "PROJECT_MANAGER" },
      { anchorAt: "2026-03-06T23:29:59.999Z" },
      { anchorAt: "2026-03-07T23:30:00.000Z" },
      { logicalDueAt: "2026-02-30T07:00:00.000Z" },
      { quietHoursEndLocal: null }, { quietHoursEndLocal: "18:00" },
      { ordinal: 91 }, { extra: true },
    ])
      expect(() => planProjectUpdateRecipientStage({ ...initial, ...change })).toThrow();
  });
});
