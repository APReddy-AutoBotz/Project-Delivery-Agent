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
const rejectInBoth = (input: unknown) => {
  expect(schema.safeParse(input).success).toBe(false);
  expect(() => decodeMilestoneStateDisagreement(input, id(1), id(2))).toThrow();
};

describe("human milestone state disagreement presentation", () => {
  it("retains all distinct supported positions without choosing a winner", () => {
    const input = observation();
    expect(schema.parse(input)).toEqual(input);
    expect(decodeMilestoneStateDisagreement(input, input.projectId, input.milestoneId)).toEqual(input);
    expect(() => decodeMilestoneStateDisagreement(input, id(99), input.milestoneId)).toThrow();
    expect(() => decodeMilestoneStateDisagreement(input, input.projectId, id(99))).toThrow();
    rejectInBoth({ ...input, resolvedValue: "COMPLETE" });
  });
  it("rejects duplicate states, versions and evidence", () => {
    const duplicateState = observation(); duplicateState.positions[1]!.state = "OPEN";
    rejectInBoth(duplicateState);
    const duplicateVersion = observation(); duplicateVersion.positions[1]!.supports[0]!.versionId = duplicateVersion.positions[0]!.supports[0]!.versionId;
    rejectInBoth(duplicateVersion);
    const duplicateEvidence = observation(); duplicateEvidence.positions[1]!.supports[0]!.evidenceId = duplicateEvidence.positions[0]!.supports[0]!.evidenceId;
    rejectInBoth(duplicateEvidence);
  });
  it("rejects unsupported origins and stale, future or invalid contributor intervals", () => {
    const source = observation(); source.positions[0]!.supports[0]!.provenance = "SYSTEM_VERIFIED" as never;
    rejectInBoth(source);
    const stale = observation(); stale.positions[0]!.supports[0]!.assessedValidUntil = asOf;
    rejectInBoth(stale);
    const future = observation(); future.positions[0]!.supports[0]!.observedAt = "2026-11-01T12:00:00.000Z";
    rejectInBoth(future);
    const inconsistent = observation(); inconsistent.positions[0]!.supports[0]!.versionValidUntil = "2026-10-31T13:00:00.000Z" as never;
    rejectInBoth(inconsistent);
  });
  it("requires bounded valid state alternatives and a nonempty supporting set", () => {
    const one = observation(); one.positions.pop(); rejectInBoth(one);
    const empty = observation(); empty.positions[0]!.supports = []; rejectInBoth(empty);
    const unknown = observation(); unknown.positions[0]!.state = "UNKNOWN"; rejectInBoth(unknown);
    const unrelated = observation(); unrelated.factType = "project.status"; rejectInBoth(unrelated);
    const oversized = observation(); oversized.positions[0]!.supports = Array.from({ length: 1001 }, (_, n) => support(n + 100));
    rejectInBoth(oversized);
    const invalidId = observation(); invalidId.positions[0]!.supports[0]!.sourceId = "not-a-uuid"; rejectInBoth(invalidId);
    const invalidDate = observation(); invalidDate.positions[0]!.supports[0]!.observedAt = "2026-02-30T12:00:00.000Z"; rejectInBoth(invalidDate);
    const extraField = observation(); Object.assign(extraField.positions[0]!.supports[0]!, { hidden: true }); rejectInBoth(extraField);
  });
});
