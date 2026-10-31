import { describe, expect, it } from "vitest";
import { milestoneStateDisagreementSchema as schema } from "../packages/domain/src/milestone-state-disagreement.js";
import { decodeMilestoneStateDisagreement } from "../apps/web/src/milestone-state-disagreement-decoder.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asOf = "2026-10-31T12:00:00.000Z";
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20),
  provenance: "HUMAN_CONFIRMED" as const, effectiveAt: "2026-10-30T12:00:00.000Z",
  observedAt: "2026-10-30T12:00:00.000Z", versionValidUntil: null,
  assessedValidUntil: "2026-11-01T12:00:00.000Z" });
const observation = () => ({ projectId: id(1), milestoneId: id(2), bindingId: id(3), factId: id(4),
  factType: "canonical.state.00000000000040008000000000000002", asOf, policyRevisionId: id(5), positions: [
    { state: "OPEN", supports: [support(30), support(31)] },
    { state: "COMPLETE", supports: [support(32)] },
  ] });

describe("human milestone state disagreement presentation", () => {
  it("retains all distinct supported positions without choosing a winner", () => {
    const input = observation();
    expect(schema.parse(input)).toEqual(input);
    expect(decodeMilestoneStateDisagreement(input, input.projectId, input.milestoneId)).toEqual(input);
    expect(() => decodeMilestoneStateDisagreement(input, id(99), input.milestoneId)).toThrow();
    expect(() => decodeMilestoneStateDisagreement(input, input.projectId, id(99))).toThrow();
    expect(schema.safeParse({ ...input, resolvedValue: "COMPLETE" }).success).toBe(false);
  });
  it("rejects duplicate states, versions and evidence", () => {
    const duplicateState = observation(); duplicateState.positions[1]!.state = "OPEN";
    expect(schema.safeParse(duplicateState).success).toBe(false);
    const duplicateVersion = observation(); duplicateVersion.positions[1]!.supports[0]!.versionId = duplicateVersion.positions[0]!.supports[0]!.versionId;
    expect(schema.safeParse(duplicateVersion).success).toBe(false);
    const duplicateEvidence = observation(); duplicateEvidence.positions[1]!.supports[0]!.evidenceId = duplicateEvidence.positions[0]!.supports[0]!.evidenceId;
    expect(schema.safeParse(duplicateEvidence).success).toBe(false);
  });
  it("rejects unsupported origins and stale, future or invalid contributor intervals", () => {
    const source = observation(); source.positions[0]!.supports[0]!.provenance = "SYSTEM_VERIFIED" as never;
    expect(schema.safeParse(source).success).toBe(false);
    const stale = observation(); stale.positions[0]!.supports[0]!.assessedValidUntil = asOf;
    expect(schema.safeParse(stale).success).toBe(false);
    const future = observation(); future.positions[0]!.supports[0]!.observedAt = "2026-11-01T12:00:00.000Z";
    expect(schema.safeParse(future).success).toBe(false);
    const inconsistent = observation(); inconsistent.positions[0]!.supports[0]!.versionValidUntil = "2026-10-31T13:00:00.000Z" as never;
    expect(schema.safeParse(inconsistent).success).toBe(false);
  });
  it("requires bounded valid state alternatives and a nonempty supporting set", () => {
    const one = observation(); one.positions.pop(); expect(schema.safeParse(one).success).toBe(false);
    const empty = observation(); empty.positions[0]!.supports = []; expect(schema.safeParse(empty).success).toBe(false);
    const unknown = observation(); unknown.positions[0]!.state = "UNKNOWN"; expect(schema.safeParse(unknown).success).toBe(false);
    const unrelated = observation(); unrelated.factType = "project.status"; expect(schema.safeParse(unrelated).success).toBe(false);
    const oversized = observation(); oversized.positions[0]!.supports = Array.from({ length: 1001 }, (_, n) => support(n + 100));
    expect(schema.safeParse(oversized).success).toBe(false);
  });
});
