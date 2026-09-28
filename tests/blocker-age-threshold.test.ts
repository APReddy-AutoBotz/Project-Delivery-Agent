import { describe, expect, it } from "vitest";
import {
  blockerAgeThresholdPolicyChangeSchema,
  blockerAgeThresholdPolicyViewSchema,
} from "../packages/domain/src/index.js";

describe("EXEC-011 customer blocker-age threshold policy", () => {
  it("requires explicit finite values and a revision for every write", () => {
    expect(
      blockerAgeThresholdPolicyChangeSchema.parse({
        expectedRevision: 0,
        minimumBlockerAgeDays: 1,
        auditRetentionHours: 1,
      }),
    ).toEqual({
      expectedRevision: 0,
      minimumBlockerAgeDays: 1,
      auditRetentionHours: 1,
    });
    expect(
      blockerAgeThresholdPolicyChangeSchema.parse({
        expectedRevision: 2147483646,
        minimumBlockerAgeDays: 3650,
        auditRetentionHours: 87600,
      }).minimumBlockerAgeDays,
    ).toBe(3650);
  });

  it.each([
    { expectedRevision: 0, auditRetentionHours: 24 },
    { expectedRevision: 0, minimumBlockerAgeDays: 30 },
    { expectedRevision: -1, minimumBlockerAgeDays: 30, auditRetentionHours: 24 },
    { expectedRevision: 2147483647, minimumBlockerAgeDays: 30, auditRetentionHours: 24 },
    { expectedRevision: 0, minimumBlockerAgeDays: 0, auditRetentionHours: 24 },
    { expectedRevision: 0, minimumBlockerAgeDays: 3651, auditRetentionHours: 24 },
    { expectedRevision: 0, minimumBlockerAgeDays: 30, auditRetentionHours: 0 },
    { expectedRevision: 0, minimumBlockerAgeDays: 30, auditRetentionHours: 87601 },
    { expectedRevision: 0, minimumBlockerAgeDays: 30, auditRetentionHours: 24, extra: true },
  ])("rejects incomplete or out-of-range changes %#", (input) => {
    expect(blockerAgeThresholdPolicyChangeSchema.safeParse(input).success).toBe(false);
  });

  it("validates the persisted configuration view", () => {
    expect(
      blockerAgeThresholdPolicyViewSchema.parse({
        minimumBlockerAgeDays: 30,
        auditRetentionHours: 720,
        revision: 1,
        changedBy: "pmo-user",
        changedAt: "2026-09-27T00:00:00.000Z",
      }),
    ).toMatchObject({ minimumBlockerAgeDays: 30, revision: 1 });
  });
});
