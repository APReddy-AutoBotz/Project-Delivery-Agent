import { describe, expect, it } from "vitest";
import { milestoneConflictObservationSchema as schema } from "../packages/domain/src/milestone-conflict-observation.js";
import { decodeMilestoneConflict } from "../apps/web/src/milestone-conflict-decoder.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asOf = "2026-10-21T12:00:00.000Z";
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 100), sourceId: id(n + 200),
  provenance: "HUMAN_CONFIRMED", freshness: "CURRENT", validity: "FINITE",
  effectiveAt: "2026-10-20T12:00:00.000Z", observedAt: "2026-10-20T12:00:00.000Z",
  versionValidUntil: "2026-10-23T12:00:00.000Z", assessedValidUntil: "2026-10-22T12:00:00.000Z" });
const item = (n: number, targetKind: "MILESTONE" | "WORK_ITEM") => ({ targetKind, targetId: id(n),
  bindingId: id(n + 10), factId: id(n + 20), factType: `canonical.state.${String(n).padStart(32, "0")}`, policyRevisionId: id(n + 30),
  state: targetKind === "MILESTONE" ? "COMPLETE" : "OPEN", supports: [support(n + 300)] });
const conflict = () => ({ projectId: id(1), milestoneId: id(2), asOf, ruleRevision: "milestone-required-state/v1",
  outcome: "CONFLICTING", positions: [item(2, "MILESTONE"), item(3, "WORK_ITEM")] });

describe("milestone conflict observation contract", () => {
  it("accepts a bounded contradiction and a minimal fixed-rule negative result", () => {
    expect(schema.safeParse(conflict()).success).toBe(true);
    const { positions: _positions, ...base } = conflict();
    expect(schema.safeParse({ ...base, outcome: "NOT_DETECTED" }).success).toBe(true);
    expect(schema.safeParse({ ...base, outcome: "NOT_DETECTED", positions: [] }).success).toBe(false);
  });
  it("rejects mismatched targets, duplicate identities and missing positions", () => {
    for (const mutate of [
      (v: ReturnType<typeof conflict>) => { v.milestoneId = id(4); },
      (v: ReturnType<typeof conflict>) => { v.positions[1]!.bindingId = v.positions[0]!.bindingId; },
      (v: ReturnType<typeof conflict>) => { v.positions[1]!.factId = v.positions[0]!.factId; },
      (v: ReturnType<typeof conflict>) => { v.positions[1]!.supports[0]!.evidenceId = v.positions[0]!.supports[0]!.evidenceId; },
      (v: ReturnType<typeof conflict>) => { v.positions.pop(); },
    ]) { const v = conflict(); mutate(v); expect(schema.safeParse(v).success).toBe(false); }
  });
  it("rejects expired, invalid or unapproved proof without returning it", () => {
    for (const mutate of [
      (v: ReturnType<typeof conflict>) => { v.positions[0]!.supports[0]!.assessedValidUntil = asOf; },
      (v: ReturnType<typeof conflict>) => { v.positions[0]!.supports[0]!.versionValidUntil = asOf; },
      (v: ReturnType<typeof conflict>) => { v.positions[0]!.supports[0]!.provenance = "MODEL_GENERATED"; },
      (v: ReturnType<typeof conflict>) => { v.positions[0]!.supports[0]!.effectiveAt = "2026-10-22T12:00:00.000Z"; },
      (v: ReturnType<typeof conflict>) => { v.positions[0]!.supports[0]!.observedAt = "2026-10-22T12:00:00.000Z"; },
      (v: ReturnType<typeof conflict>) => { v.asOf = "2026-02-30T12:00:00.000Z"; },
    ]) { const v = conflict(); mutate(v); expect(schema.safeParse(v).success).toBe(false); }
    expect(schema.safeParse({ ...conflict(), internalDependencies: [id(99)] }).success).toBe(false);
  });
  it("enforces exact identity, nested-property, expiry and aggregate bounds", () => {
    const uppercase = conflict(); uppercase.positions[0]!.bindingId = "abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase();
    expect(schema.safeParse(uppercase).success).toBe(false);
    const extra = conflict(); Object.assign(extra.positions[0]!.supports[0]!, { privateValue: "hidden" });
    expect(schema.safeParse(extra).success).toBe(false);
    const duplicated = conflict(); duplicated.positions[1]!.supports[0]!.versionId = duplicated.positions[0]!.supports[0]!.versionId;
    expect(schema.safeParse(duplicated).success).toBe(false);
    const late = conflict(); late.positions[0]!.supports[0]!.assessedValidUntil = "2026-10-24T12:00:00.000Z";
    expect(schema.safeParse(late).success).toBe(false);
    const over = conflict(); over.positions[0]!.supports = Array.from({ length: 1000 }, (_, n) => support(n + 10000));
    expect(schema.safeParse(over).success).toBe(false);
    const sharedSource = conflict(), another = support(999); another.sourceId = sharedSource.positions[0]!.supports[0]!.sourceId;
    sharedSource.positions[0]!.supports.push(another);
    expect(schema.safeParse(sharedSource).success).toBe(true);
  });
  it("matches server-valid results and rejects malformed or wrong-scope presentation", () => {
    const v = conflict(), { positions: _positions, ...base } = v;
    for (const data of [v, { ...base, outcome: "NOT_DETECTED" }])
      expect(decodeMilestoneConflict(schema.parse(data), v.projectId, v.milestoneId)).toEqual(data);
    const malformed = [
      { ...v, privateMarker: "restricted" },
      { ...v, projectId: id(99) },
      { ...v, positions: [{ ...v.positions[0], supports: [] }, v.positions[1]] },
      { ...v, positions: [{ ...v.positions[0], supports: [{ ...v.positions[0]!.supports[0], observedAt: "2026-10-22T12:00:00.000Z" }] }, v.positions[1]] },
    ];
    for (const data of malformed) expect(() => decodeMilestoneConflict(data, v.projectId, v.milestoneId)).toThrow();
    for (const special of ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
      const item = conflict(); item.positions[0]!.supports[0]!.sourceId = special;
      expect(decodeMilestoneConflict(schema.parse(item), item.projectId, item.milestoneId)).toEqual(item);
    }
  });
  it("keeps server and presentation bounds aligned", () => {
    const v = conflict();
    v.positions = [item(2, "MILESTONE"), ...Array.from({ length: 50 }, (_, n) => item(n + 1000, "WORK_ITEM"))];
    expect(schema.safeParse(v).success).toBe(true);
    expect(decodeMilestoneConflict(v, v.projectId, v.milestoneId)).toEqual(v);
    v.positions.push(item(3000, "WORK_ITEM"));
    expect(schema.safeParse(v).success).toBe(false);
    expect(() => decodeMilestoneConflict(v, v.projectId, v.milestoneId)).toThrow();
    for (const version of "12345678") {
      const one = conflict(); one.positions[0]!.supports[0]!.sourceId = `abcdefab-cdef-${version}abc-8def-abcdefabcdef`;
      expect(schema.safeParse(one).success).toBe(true);
      expect(decodeMilestoneConflict(one, one.projectId, one.milestoneId)).toEqual(one);
    }
    for (const mutate of [
      (x: ReturnType<typeof conflict>) => { x.positions[0]!.supports[0]!.sourceId = "abcdefab-cdef-4abc-0def-abcdefabcdef"; },
      (x: ReturnType<typeof conflict>) => { x.positions[0]!.supports[0]!.assessedValidUntil = asOf; },
      (x: ReturnType<typeof conflict>) => { x.positions[0]!.supports[0]!.assessedValidUntil = "2026-10-24T12:00:00.000Z"; },
      (x: ReturnType<typeof conflict>) => { x.positions[1]!.supports[0]!.versionId = x.positions[0]!.supports[0]!.versionId; },
    ]) { const data = conflict(); mutate(data); expect(schema.safeParse(data).success).toBe(false);
      expect(() => decodeMilestoneConflict(data, data.projectId, data.milestoneId)).toThrow(); }
    const equal = conflict(); equal.positions[0]!.supports[0]!.effectiveAt = asOf; equal.positions[0]!.supports[0]!.observedAt = asOf;
    expect(schema.safeParse(equal).success).toBe(true);
    expect(decodeMilestoneConflict(equal, equal.projectId, equal.milestoneId)).toEqual(equal);
  });
  it("enforces the same UTF-8 response byte boundary", () => {
    const v = conflict(); v.positions[0]!.factType = "a";
    let built = false;
    for (let n = 500; n < 1000 && !built; n++) {
      v.positions[0]!.supports = Array.from({ length: n }, (_, i) => support(i + 10000));
      let bytes = new TextEncoder().encode(JSON.stringify(v)).length;
      for (let i = 0; bytes > 262144 && i < n; i++) {
        v.positions[0]!.supports[i]!.versionValidUntil = null;
        bytes = new TextEncoder().encode(JSON.stringify(v)).length;
      }
      const gap = 262144 - bytes;
      if (gap >= 0 && gap <= 94) { v.positions[0]!.factType = "a".repeat(gap + 1); built = true; }
    }
    expect(built).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(v)).length).toBe(262144);
    expect(schema.safeParse(v).success).toBe(true);
    expect(decodeMilestoneConflict(v, v.projectId, v.milestoneId)).toEqual(v);
    v.positions[0]!.factType += "a";
    expect(new TextEncoder().encode(JSON.stringify(v)).length).toBe(262145);
    expect(schema.safeParse(v).success).toBe(false);
    expect(() => decodeMilestoneConflict(v, v.projectId, v.milestoneId)).toThrow();
  });
  it("allows separately sourced provenance without combining it into a single claim", () => {
    const v = conflict(), second = support(999); second.provenance = "SYSTEM_VERIFIED";
    v.positions[0]!.supports.push(second);
    expect(schema.parse(v)).toEqual(v);
  });
});
