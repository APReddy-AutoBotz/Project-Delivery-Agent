import { expect, it } from "vitest";
import { unrankedMilestoneObservationSchema as schema } from "../packages/domain/src/unranked-milestone.js";
import { decodeUnrankedMilestone as decode } from "../apps/web/src/unranked-milestone-decoder.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 2000), sourceId: id(n + 4000), provenance: "HUMAN_CONFIRMED",
  effectiveAt: "2026-10-20T00:00:00.000Z", observedAt: "2026-10-20T00:00:00.000Z", versionValidUntil: "2026-10-23T00:00:00.000Z" });
const fixture = () => ({ kind: "UNRANKED_NO_POLICY", projectId: id(2), milestoneId: id(3), bindingId: id(4), factId: id(5),
  factType: "canonical.state.10000000000040008000000000000003", asOf: "2026-10-21T11:00:00.000Z",
  positions: [{ state: "COMPLETE", supports: [support(30)] }, { state: "OPEN", supports: [support(31)] }] });

it("accepts the same bounded observation as the server and checks the requested scope", () => {
  const value = fixture();
  expect(schema.parse(value)).toEqual(value);
  expect(decode(value, id(2), id(3))).toEqual(value);
  expect(() => decode(value, id(99), id(3))).toThrow();
  expect(() => decode(value, id(2), id(99))).toThrow();
});

it("rejects the same malformed identities, timestamps, alternatives and nested fields as the server", () => {
  const cases: unknown[] = [];
  const add = (change: (v: ReturnType<typeof fixture>) => void) => { const v = fixture(); change(v); cases.push(v); };
  add((v) => { v.kind = "NO_POLICY"; });
  add((v) => { v.projectId = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"; });
  add((v) => { v.asOf = "2026-02-30T12:00:00.000Z"; });
  add((v) => { v.asOf = "2026-10-21T11:00:00Z"; });
  add((v) => { v.positions[1]!.state = "COMPLETE"; });
  add((v) => { v.positions[1]!.supports[0]!.versionId = v.positions[0]!.supports[0]!.versionId; });
  add((v) => { v.positions[1]!.supports[0]!.evidenceId = v.positions[0]!.supports[0]!.evidenceId; });
  add((v) => { v.positions[1]!.supports[0]!.sourceId = v.positions[0]!.supports[0]!.sourceId; });
  add((v) => { v.positions[0]!.supports.push({ ...support(32), sourceId: v.positions[0]!.supports[0]!.sourceId }); });
  add((v) => { v.positions[0]!.supports = []; });
  add((v) => { v.positions[0]!.supports[0]!.versionValidUntil = v.asOf; });
  add((v) => { v.positions[0]!.supports[0]!.effectiveAt = "2026-10-22T00:00:00.000Z"; });
  add((v) => { v.positions[0]!.supports[0]!.observedAt = "2026-10-22T00:00:00.000Z"; });
  add((v) => { v.positions[0]!.supports[0]!.provenance = "SYSTEM_VERIFIED"; });
  add((v) => { Object.assign(v.positions[0]!.supports[0]!, { statement: "private" }); });
  add((v) => { Object.assign(v, { policyRevisionId: id(6) }); });
  add((v) => { v.positions.pop(); });
  for (const value of cases) {
    expect(schema.safeParse(value).success).toBe(false);
    expect(() => decode(value, id(2), id(3))).toThrow();
  }
});

it("enforces the same serialized byte bound before presentation", () => {
  const make = (count: number) => {
    const value = fixture();
    value.positions[0]!.supports = Array.from({ length: count - 1 }, (_, i) => support(i + 10));
    value.positions[1]!.supports = [support(count + 10)];
    return value;
  };
  const under = make(830), over = make(840);
  expect(new TextEncoder().encode(JSON.stringify(under)).length).toBeLessThanOrEqual(262144);
  expect(schema.safeParse(under).success).toBe(true); expect(decode(under, id(2), id(3))).toEqual(under);
  expect(new TextEncoder().encode(JSON.stringify(over)).length).toBeGreaterThan(262144);
  expect(schema.safeParse(over).success).toBe(false); expect(() => decode(over, id(2), id(3))).toThrow();
});
