import { describe, expect, it } from "vitest";
import { scalarConflictObservationSchema as schema } from "../packages/domain/src/scalar-conflict-observation.js";
import { decodeScalarCatalogue, decodeScalarConflict } from "../apps/web/src/scalar-conflict-decoder.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20),
  provenance: "HUMAN_CONFIRMED" as const, effectiveAt: "2026-01-01T00:00:00.000Z", observedAt: "2026-01-01T00:00:00.000Z",
  versionValidUntil: "2027-01-01T00:00:00.000Z", assessedValidUntil: "2027-01-01T00:00:00.000Z" });
const observation = () => ({ projectId: id(1), factId: id(2), factType: "project.forecast", asOf: "2026-10-01T00:00:00.000Z",
  policyRevisionId: id(3), positions: [{ value: "2026-10-01", supports: [support(4)] }, { value: "2026-10-02", supports: [support(5)] }] });

describe("scalar conflict presentation", () => {
  it("accepts distinct valid dates and individual evidence associations", () => {
    expect(schema.parse(observation())).toEqual(observation());
    const value = observation(); expect(decodeScalarConflict(value, value.projectId, value.factId, value.factType)).toEqual(value);
  });
  it("rejects duplicate positions, evidence, invalid dates and expiry at the observation clock", () => {
    const sameDate = observation(); sameDate.positions[1]!.value = sameDate.positions[0]!.value;
    const sameEvidence = observation(); sameEvidence.positions[1]!.supports[0]!.evidenceId = sameEvidence.positions[0]!.supports[0]!.evidenceId;
    const invalidDate = observation(); invalidDate.positions[1]!.value = "2026-02-30";
    const expired = observation(); expired.positions[0]!.supports[0]!.assessedValidUntil = expired.asOf;
    for (const value of [sameDate, sameEvidence, invalidDate, expired]) {
      expect(schema.safeParse(value).success).toBe(false);
      expect(() => decodeScalarConflict(value, value.projectId, value.factId, value.factType)).toThrow();
    }
  });
  it("binds the observation to the selected fact and allows database collation order", () => {
    const value = observation(); expect(() => decodeScalarConflict(value, value.projectId, id(100), value.factType)).toThrow();
    const catalogue = { canAppend: false, canConfigure: false, next: null,
      facts: [{ factId: id(4), factType: "x_1", revision: 1 }, { factId: id(5), factType: "x-1", revision: 1 }] };
    expect(decodeScalarCatalogue(catalogue)).toEqual(catalogue);
    expect(() => decodeScalarCatalogue({ ...catalogue, facts: [catalogue.facts[0], catalogue.facts[0]] })).toThrow();
    expect(() => decodeScalarCatalogue({ ...catalogue, extra: "private" })).toThrow();
  });
  it("requires a complete, advancing catalogue page before offering a next cursor", () => {
    const facts = Array.from({ length: 50 }, (_, n) => ({ factId: id(n + 100), factType: `project.fact_${n}`, revision: 1 }));
    const value = { canAppend: false, canConfigure: false, facts, next: facts[49]!.factType };
    expect(decodeScalarCatalogue(value, "project.prior")).toEqual(value);
    expect(() => decodeScalarCatalogue({ ...value, facts: facts.slice(0, 49) }, "project.prior")).toThrow();
    expect(() => decodeScalarCatalogue(value, facts[0]!.factType)).toThrow();
    expect(() => decodeScalarCatalogue(value, "project.prior", [facts[49]!.factType, "project.prior"])).toThrow();
    expect(() => decodeScalarCatalogue({ ...value, next: "project.other" }, "project.prior")).toThrow();
  });
  it("withholds oversized support sets and serialized envelopes", () => {
    const value = observation();
    value.positions[0]!.supports = Array.from({ length: 999 }, (_, index) => support(index + 100));
    value.positions[1]!.supports = [support(2000)];
    expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeGreaterThan(262144);
    expect(schema.safeParse(value).success).toBe(false);
    expect(() => decodeScalarConflict(value, value.projectId, value.factId, value.factType)).toThrow();
    value.positions[1]!.supports.push(support(2001));
    expect(schema.safeParse(value).success).toBe(false);
    expect(() => decodeScalarConflict(value, value.projectId, value.factId, value.factType)).toThrow();
  });
});
