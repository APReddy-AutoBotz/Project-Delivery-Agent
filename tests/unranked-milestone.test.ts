import { describe, expect, it } from "vitest";
import { unrankedMilestoneObservationSchema as schema } from "../packages/domain/src/unranked-milestone.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asOf = "2026-10-31T12:00:00.000Z";
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 100), sourceId: id(n + 200),
  provenance: "HUMAN_CONFIRMED", effectiveAt: "2026-10-30T12:00:00.000Z",
  observedAt: "2026-10-30T12:00:00.000Z", versionValidUntil: "2026-11-01T12:00:00.000Z" });
const observation = () => ({ kind: "UNRANKED_NO_POLICY", projectId: id(1), milestoneId: id(2),
  bindingId: id(3), factId: id(4), factType: "canonical.state.00000000000040008000000000000002", asOf,
  positions: [{ state: "OPEN", supports: [support(10), support(11)] },
    { state: "COMPLETE", supports: [support(12)] }] });

describe("unranked human milestone observation shape", () => {
  it("retains all distinct alternatives without a policy or selected value", () => {
    const input = observation();
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ...input, policyRevisionId: id(5) }).success).toBe(false);
    expect(schema.safeParse({ ...input, resolvedValue: "COMPLETE" }).success).toBe(false);
  });
  it("rejects missing, expired and future-dated evidence", () => {
    for (const change of [
      { versionValidUntil: null }, { versionValidUntil: asOf },
      { effectiveAt: "2026-11-01T12:00:00.000Z" }, { observedAt: "2026-11-01T12:00:00.000Z" },
      { provenance: "SYSTEM_VERIFIED" },
    ]) {
      const input = observation(); Object.assign(input.positions[0]!.supports[0]!, change);
      expect(schema.safeParse(input).success).toBe(false);
    }
  });
  it("rejects duplicated states, versions, evidence or sources and incomplete alternatives", () => {
    const sameState = observation(); sameState.positions[1]!.state = "OPEN";
    expect(schema.safeParse(sameState).success).toBe(false);
    const sameVersion = observation(); sameVersion.positions[1]!.supports[0]!.versionId = sameVersion.positions[0]!.supports[0]!.versionId;
    expect(schema.safeParse(sameVersion).success).toBe(false);
    const sameEvidence = observation(); sameEvidence.positions[1]!.supports[0]!.evidenceId = sameEvidence.positions[0]!.supports[0]!.evidenceId;
    expect(schema.safeParse(sameEvidence).success).toBe(false);
    const sameSource = observation(); sameSource.positions[1]!.supports[0]!.sourceId = sameSource.positions[0]!.supports[0]!.sourceId;
    expect(schema.safeParse(sameSource).success).toBe(false);
    const sameSourceWithin = observation(); sameSourceWithin.positions[0]!.supports[1]!.sourceId = sameSourceWithin.positions[0]!.supports[0]!.sourceId;
    expect(schema.safeParse(sameSourceWithin).success).toBe(false);
    const one = observation(); one.positions.pop();
    expect(schema.safeParse(one).success).toBe(false);
  });
  it("rejects malformed or oversized observations", () => {
    const unknown = observation(); unknown.positions[0]!.state = "UNKNOWN";
    expect(schema.safeParse(unknown).success).toBe(false);
    const large = observation(); large.positions[0]!.supports = Array.from({ length: 1001 }, (_, i) => support(i + 1000));
    expect(schema.safeParse(large).success).toBe(false);
    const invalidDate = observation(); invalidDate.positions[0]!.supports[0]!.observedAt = "2026-02-30T12:00:00.000Z";
    expect(schema.safeParse(invalidDate).success).toBe(false);
    const extra = observation(); Object.assign(extra.positions[0]!.supports[0]!, { hidden: true });
    expect(schema.safeParse(extra).success).toBe(false);
  });
  it("enforces the output byte bound independently of per-position counts", () => {
    const build = (count: number) => {
      const input = observation();
      input.positions[0]!.supports = Array.from({ length: count - 1 }, (_, i) => support(i + 1000));
      input.positions[1]!.supports = [support(count + 1000)];
      return input;
    };
    const under = build(830), over = build(840);
    expect(new TextEncoder().encode(JSON.stringify(under)).length).toBeLessThanOrEqual(262144);
    expect(schema.safeParse(under).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(over)).length).toBeGreaterThan(262144);
    expect(schema.safeParse(over).success).toBe(false);
  });
});
