import type { MilestoneConflictObservation, MilestoneRequestObservation } from "@pdaa/domain";

// Presentation-only decoding; the server remains the authorization boundary.
const fail = (): never => { throw new Error("Invalid milestone conflict observation"); };
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
export function decodeMilestoneConflict(value: unknown, projectId: string, milestoneId: string): MilestoneConflictObservation {
  const v = object(value);
  if (id(v.projectId) !== projectId || id(v.milestoneId) !== milestoneId || v.ruleRevision !== "milestone-required-state/v1") fail();
  const asOf = instant(v.asOf);
  if (new TextEncoder().encode(JSON.stringify(v)).length > 262144) fail();
  if (v.outcome === "NOT_DETECTED") {
    keys(v, ["projectId", "milestoneId", "asOf", "ruleRevision", "outcome"]);
    return v as MilestoneConflictObservation;
  }
  if (v.outcome !== "CONFLICTING") return fail();
  keys(v, ["projectId", "milestoneId", "asOf", "ruleRevision", "outcome", "positions"]);
  const positions = array(v.positions, 2, 51), targets = new Set<string>(), bindings = new Set<string>(), facts = new Set<string>();
  const versions = new Set<string>(), evidence = new Set<string>();
  let milestones = 0, count = 0;
  for (const raw of positions) {
    const item = object(raw);
    keys(item, ["targetKind", "targetId", "bindingId", "factId", "factType", "policyRevisionId", "state", "supports"]);
    const target = id(item.targetId), binding = id(item.bindingId), fact = id(item.factId); id(item.policyRevisionId);
    if (targets.has(target) || bindings.has(binding) || facts.has(fact)) fail();
    targets.add(target); bindings.add(binding); facts.add(fact);
    if (typeof item.factType !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(item.factType)) fail();
    if (item.targetKind === "MILESTONE") { milestones++; if (target !== milestoneId || item.state !== "COMPLETE") fail(); }
    else if (item.targetKind !== "WORK_ITEM" || target === milestoneId || (item.state !== "OPEN" && item.state !== "IN_PROGRESS")) fail();
    const supports = array(item.supports, 1, 1000); count += supports.length; if (count > 1000) fail();
    for (const rawSupport of supports) {
      const row = object(rawSupport);
      keys(row, ["versionId", "evidenceId", "sourceId", "provenance", "freshness", "validity", "effectiveAt", "observedAt", "versionValidUntil", "assessedValidUntil"]);
      const version = id(row.versionId), proof = id(row.evidenceId); id(row.sourceId);
      if (versions.has(version) || evidence.has(proof)) fail(); versions.add(version); evidence.add(proof);
      if ((row.provenance !== "HUMAN_CONFIRMED" && row.provenance !== "SYSTEM_VERIFIED") || row.freshness !== "CURRENT" || row.validity !== "FINITE") fail();
      const effective = instant(row.effectiveAt), observed = instant(row.observedAt), adjusted = instant(row.assessedValidUntil);
      const original = row.versionValidUntil === null ? null : instant(row.versionValidUntil);
      if (effective > asOf || observed > asOf || adjusted <= asOf || (original !== null && (original <= asOf || adjusted > original))) fail();
    }
  }
  if (milestones !== 1) fail();
  return v as MilestoneConflictObservation;
}

export function decodeMilestoneRequestObservation(value: unknown, projectId: string, milestoneId: string): MilestoneRequestObservation {
  const wrapper = object(value);
  keys(wrapper, ["observation", "requestStatus"]);
  if (new TextEncoder().encode(JSON.stringify(wrapper)).length > 262144) fail();
  const observation = decodeMilestoneConflict(wrapper.observation, projectId, milestoneId);
  if (observation.outcome === "NOT_DETECTED") {
    if (wrapper.requestStatus !== null) fail();
    return { observation, requestStatus: null };
  }
  if (wrapper.requestStatus !== "MATCHING_REQUEST_RECORDED" && wrapper.requestStatus !== "NO_MATCHING_REQUEST_RECORDED") return fail();
  if (observation.positions.some((position) => position.supports.some((support) => support.provenance !== "HUMAN_CONFIRMED"))) fail();
  return { observation, requestStatus: wrapper.requestStatus };
}
