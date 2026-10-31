import type { UnrankedMilestoneObservation } from "@pdaa/domain";

// Presentation validation only; the server proves access and policy absence.
const fail = (): never => { throw new Error("Invalid unranked milestone observation"); };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const keys = (v: Record<string, unknown>, expected: string[]) => {
  if (Object.keys(v).sort().join(",") !== [...expected].sort().join(",")) fail();
};
const id = (v: unknown): string => typeof v === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v) ||
  v === "00000000-0000-0000-0000-000000000000" || v === "ffffffff-ffff-ffff-ffff-ffffffffffff") ? v : fail();
const instant = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || v.startsWith("0000-") ||
      !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) return fail();
  return v;
};
const array = (v: unknown, min: number, max: number): unknown[] => Array.isArray(v) && v.length >= min && v.length <= max ? v : fail();

export function decodeUnrankedMilestone(value: unknown, projectId: string, milestoneId: string): UnrankedMilestoneObservation {
  const v = object(value);
  keys(v, ["kind", "projectId", "milestoneId", "bindingId", "factId", "factType", "asOf", "positions"]);
  if (v.kind !== "UNRANKED_NO_POLICY" || id(v.projectId) !== projectId || id(v.milestoneId) !== milestoneId) fail();
  id(v.bindingId); id(v.factId);
  if (typeof v.factType !== "string" || !/^canonical\.state\.[a-f0-9]{32}$/.test(v.factType)) fail();
  const asOf = instant(v.asOf);
  if (new TextEncoder().encode(JSON.stringify(v)).length > 262144) fail();
  const states = new Set<string>(), versions = new Set<string>(), evidence = new Set<string>(), sources = new Set<string>();
  let count = 0;
  for (const raw of array(v.positions, 2, 4)) {
    const item = object(raw);
    keys(item, ["state", "supports"]);
    if (typeof item.state !== "string" || !["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"].includes(item.state) || states.has(item.state)) fail();
    states.add(item.state as string);
    const supports = array(item.supports, 1, 1000); count += supports.length; if (count > 1000) fail();
    for (const rawSupport of supports) {
      const row = object(rawSupport);
      keys(row, ["versionId", "evidenceId", "sourceId", "provenance", "effectiveAt", "observedAt", "versionValidUntil"]);
      const version = id(row.versionId), proof = id(row.evidenceId), source = id(row.sourceId);
      if (versions.has(version) || evidence.has(proof) || sources.has(source) || row.provenance !== "HUMAN_CONFIRMED") fail();
      versions.add(version); evidence.add(proof); sources.add(source);
      const effective = instant(row.effectiveAt), observed = instant(row.observedAt), validUntil = instant(row.versionValidUntil);
      if (effective > asOf || observed > asOf || validUntil <= asOf) fail();
    }
  }
  return v as UnrankedMilestoneObservation;
}
