import { describe, expect, it } from "vitest";
import { projectUpdatePolicyViewSchema } from "../packages/domain/src/index.js";
import { decodePolicy } from "../apps/web/src/project-update-policy-decoder.js";

const projectId = "30000000-0000-4000-8000-000000000001";
const policy = () => ({ projectId, key: "reporting", revision: 1, freshnessWindowSeconds: 3600, timeZone: "UTC",
  requiredFacts: [{ factType: "project.status", label: "Status" }], responsibleSubject: "synthetic-owner", scheduledScanEnabled: false,
  reminderBusinessDayOffsets: [] as number[], escalationAfterBusinessDays: 0, escalationRecipientSubject: null as string | null,
  quietHoursStartLocal: null as string | null, quietHoursEndLocal: null as string | null,
  changedBy: "synthetic-actor", changedAt: "2026-10-20T00:00:00.000Z" });
const accepted = (value: unknown) => { try { decodePolicy(value, projectId); return true; } catch { return false; } };

describe("FR-HLT-008 reporting policy presentation decoder", () => {
  it("accepts null only as an absent policy and rejects a different project", () => {
    expect(decodePolicy(null, projectId)).toBeNull();
    expect(() => decodePolicy(policy(), "30000000-0000-4000-8000-000000000002")).toThrow();
  });
  it("matches selected domain view-schema boundaries", () => {
    const duplicate = policy(); duplicate.requiredFacts.push({ ...duplicate.requiredFacts[0]! });
    const variants: unknown[] = [
      policy(), duplicate,
      { ...policy(), changedAt: "2026-02-30T00:00:00Z" },
      { ...policy(), changedAt: "2024-02-29T00:00:00Z" },
      { ...policy(), changedAt: "2026-10-20T00:00:00+00:00" },
      { ...policy(), key: " bad" }, { ...policy(), revision: 0 },
      { ...policy(), timeZone: "Not/AZone" }, { ...policy(), requiredFacts: [] },
      { ...policy(), requiredFacts: [{ factType: "project.status", label: "\ud800" }] },
      { ...policy(), requiredFacts: [{ factType: "project.status", label: "x".repeat(161) }] },
      { ...policy(), reminderBusinessDayOffsets: [2, 2] },
      { ...policy(), escalationAfterBusinessDays: 1, escalationRecipientSubject: null },
      { ...policy(), quietHoursStartLocal: "12:00", quietHoursEndLocal: null },
      { ...policy(), unexpected: true },
    ];
    for (const value of variants) expect(accepted(value)).toBe(projectUpdatePolicyViewSchema.safeParse(value).success);
  });
});
