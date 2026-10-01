// FR-UPD-010, AC-UPD-007: partial source freshness is independent of aggregate completeness.
import { describe, expect, it } from "vitest";
import {
  deriveProjectUpdateSourceSatisfaction, projectUpdateZoneConfigurationSchema,
  projectUpdateEngagementActivationSchema,
} from "../packages/domain/src/index.js";
const asOf = "2026-09-30T12:00:00.000Z";
const fresh = "2026-09-30T11:59:00.000Z";
const stale = "2026-09-30T11:58:59.999Z";
describe("source satisfaction", () => {
  it("keeps missing, hidden and stale requirements while satisfying only the current authorized fact", () => {
    const result = deriveProjectUpdateSourceSatisfaction({ asOf, freshnessWindowSeconds: 60, checks: [
      { factType: "project.status", sourceState: "RESOLVED", trustedTimes: [fresh] },
      { factType: "project.forecast", sourceState: "RESOLVED", trustedTimes: [stale] },
      { factType: "project.risk", sourceState: "MISSING", trustedTimes: [] },
      { factType: "project.cost", sourceState: "UNKNOWN", trustedTimes: [fresh] },
    ] });
    expect(result.satisfiedFactTypes).toEqual(["project.status"]);
    expect(result.remainingFactTypes).toEqual(["project.cost", "project.forecast", "project.risk"]);
    expect(result.sourceUnknown).toBe(true);
  });
  it.each([
    ["UNKNOWN", [fresh]], ["MISSING", []], ["RESOLVED", []],
    ["RESOLVED", [fresh, stale]], ["RESOLVED", ["2026-09-30T12:00:00.001Z"]],
  ] as const)("does not satisfy %s with untrusted or incomplete timestamps", (sourceState, times) => {
    expect(deriveProjectUpdateSourceSatisfaction({ asOf, freshnessWindowSeconds: 60, checks: [
      { factType: "project.status", sourceState, trustedTimes: [...times] },
    ] }).satisfiedFactTypes).toEqual([]);
  });
  it("allows satisfaction to disappear after source revocation", () => {
    const check = { factType: "project.status", sourceState: "RESOLVED" as const, trustedTimes: [fresh] };
    expect(deriveProjectUpdateSourceSatisfaction({ asOf, freshnessWindowSeconds: 60, checks: [check] }).remainingFactTypes).toEqual([]);
    expect(deriveProjectUpdateSourceSatisfaction({ asOf, freshnessWindowSeconds: 60, checks: [
      { ...check, sourceState: "UNKNOWN" },
    ] }).remainingFactTypes).toEqual(["project.status"]);
  });
  it("rejects duplicate requirement identities", () => {
    const check = { factType: "project.status", sourceState: "MISSING" as const, trustedTimes: [] };
    expect(() => deriveProjectUpdateSourceSatisfaction({ asOf, freshnessWindowSeconds: 60, checks: [check, check] })).toThrow();
  });
});
describe("operator-owned zones and activation inputs", () => {
  const customerId = "10000000-0000-4000-8000-000000000001";
  it("canonicalizes named zones and rejects duplicate subject preferences", () => {
    const zones = { customerId, customerTimeZone: "utc", recipientTimeZones: [{ subject: "owner", timeZone: "america/new_york" }] };
    expect(projectUpdateZoneConfigurationSchema.parse(zones)).toMatchObject({
      customerTimeZone: "UTC", recipientTimeZones: [{ subject: "owner", timeZone: "America/New_York" }],
    });
    expect(projectUpdateZoneConfigurationSchema.safeParse({ ...zones,
      recipientTimeZones: [zones.recipientTimeZones[0], zones.recipientTimeZones[0]],
    }).success).toBe(false);
  });
  it.each(["+05:30", "invalid/Zone", " UTC "])("fails closed for configured zone %s", (customerTimeZone) => {
    expect(projectUpdateZoneConfigurationSchema.safeParse({ customerId, customerTimeZone, recipientTimeZones: [] }).success).toBe(false);
  });
  it.each(["recipientSubject", "customerTimeZone", "mode", "sourceSatisfiedFactTypes"])("does not accept caller-selected %s", (key) => {
    expect(projectUpdateEngagementActivationSchema.safeParse({ expectedPolicyRevision: 1, [key]: "forged" }).success).toBe(false);
  });
});
