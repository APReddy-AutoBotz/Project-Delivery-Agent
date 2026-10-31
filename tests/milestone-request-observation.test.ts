import { describe, expect, it } from "vitest";
import { milestoneRequestObservationSchema as schema } from "../packages/domain/src/milestone-request-observation.js";
import { decodeMilestoneRequestObservation } from "../apps/web/src/milestone-conflict-decoder.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 100), sourceId: id(n + 200),
  provenance: "HUMAN_CONFIRMED", freshness: "CURRENT", validity: "FINITE",
  effectiveAt: "2026-10-20T12:00:00.000Z", observedAt: "2026-10-20T12:00:00.000Z",
  versionValidUntil: "2026-10-23T12:00:00.000Z", assessedValidUntil: "2026-10-22T12:00:00.000Z" });
const item = (n: number, targetKind: "MILESTONE" | "WORK_ITEM") => ({ targetKind, targetId: id(n),
  bindingId: id(n + 10), factId: id(n + 20), factType: `canonical.state.${String(n).padStart(32, "0")}`,
  policyRevisionId: id(n + 30), state: targetKind === "MILESTONE" ? "COMPLETE" : "OPEN", supports: [support(n + 300)] });
const conflict = () => ({ projectId: id(1), milestoneId: id(2), asOf: "2026-10-21T12:00:00.000Z",
  ruleRevision: "milestone-required-state/v1", outcome: "CONFLICTING", positions: [item(2, "MILESTONE"), item(3, "WORK_ITEM")] });

describe("matched milestone request presentation contract", () => {
  it("ties the narrow request status to one current conflicting observation", () => {
    for (const requestStatus of ["MATCHING_REQUEST_RECORDED", "NO_MATCHING_REQUEST_RECORDED"]) {
      const input = { observation: conflict(), requestStatus };
      expect(schema.parse(input)).toEqual(input);
      expect(decodeMilestoneRequestObservation(input, id(1), id(2))).toEqual(input);
    }
    expect(schema.safeParse({ observation: conflict(), requestStatus: null }).success).toBe(false);
  });
  it("does not claim request status for a non-conflict", () => {
    const { positions: _positions, ...base } = conflict();
    const observation = { ...base, outcome: "NOT_DETECTED" };
    expect(schema.safeParse({ observation, requestStatus: null }).success).toBe(true);
    expect(decodeMilestoneRequestObservation({ observation, requestStatus: null }, id(1), id(2))).toEqual({ observation, requestStatus: null });
    expect(schema.safeParse({ observation, requestStatus: "NO_MATCHING_REQUEST_RECORDED" }).success).toBe(false);
  });
  it("rejects unsupported origin, expired proof and caller-supplied internal details", () => {
    const external = conflict(); external.positions[0]!.supports[0]!.provenance = "SYSTEM_VERIFIED";
    const stale = conflict(); stale.positions[0]!.supports[0]!.assessedValidUntil = stale.asOf;
    for (const input of [
      { observation: external, requestStatus: "MATCHING_REQUEST_RECORDED" },
      { observation: stale, requestStatus: "MATCHING_REQUEST_RECORDED" },
      { observation: conflict(), requestStatus: "DELIVERED" },
      { observation: conflict(), requestStatus: "MATCHING_REQUEST_RECORDED", recipient: "private" },
      { observation: conflict(), requestStatus: "MATCHING_REQUEST_RECORDED", requestId: id(99) },
    ]) {
      expect(schema.safeParse(input).success).toBe(false);
      expect(() => decodeMilestoneRequestObservation(input, id(1), id(2))).toThrow();
    }
    expect(() => decodeMilestoneRequestObservation({ observation: conflict(), requestStatus: "MATCHING_REQUEST_RECORDED" }, id(99), id(2))).toThrow();
  });
});
