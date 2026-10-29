import type { FactCatalogue, ScalarConflictObservation } from "@pdaa/domain";

const fail = (): never => { throw new Error("Invalid scalar conflict response"); };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const keys = (v: Record<string, unknown>, expected: string[]) => { if (Object.keys(v).sort().join(",") !== [...expected].sort().join(",")) fail(); };
const id = (v: unknown): string => typeof v === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v) ||
  v === "00000000-0000-0000-0000-000000000000" || v === "ffffffff-ffff-ffff-ffff-ffffffffffff") ? v : fail();
const factType = (v: unknown): string => typeof v === "string" && /^[a-z][a-z0-9_.-]{0,95}$/.test(v) ? v : fail();
const array = (v: unknown, min: number, max: number): unknown[] => Array.isArray(v) && v.length >= min && v.length <= max ? v : fail();
const instant = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) || v.startsWith("0000-") ||
      !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) return fail();
  return v;
};
const date = (v: unknown): string => {
  if (typeof v !== "string" || !/^(?!0000)\d{4}-\d\d-\d\d$/.test(v)) return fail();
  const ms = Date.parse(`${v}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== v) return fail();
  return v;
};

export function decodeScalarCatalogue(value: unknown): FactCatalogue {
  const v = object(value); keys(v, ["canAppend", "canConfigure", "facts", "next"]);
  if (typeof v.canAppend !== "boolean" || typeof v.canConfigure !== "boolean") fail();
  const facts = array(v.facts, 0, 50), ids = new Set<string>(), types = new Set<string>();
  for (const raw of facts) {
    const row = object(raw); keys(row, ["factId", "factType", "revision"]);
    const key = id(row.factId), type = factType(row.factType);
    if (ids.has(key) || types.has(type) || !Number.isInteger(row.revision) || (row.revision as number) < 1 || (row.revision as number) > 2147483647) fail();
    ids.add(key); types.add(type);
  }
  if (v.next !== null && (!facts.length || factType(v.next) !== object(facts[facts.length - 1]).factType)) fail();
  return v as FactCatalogue;
}

export function decodeScalarConflict(value: unknown, projectId: string, factId: string, expectedType: string): ScalarConflictObservation {
  const v = object(value); keys(v, ["projectId", "factId", "factType", "asOf", "policyRevisionId", "positions"]);
  if (id(v.projectId) !== projectId || id(v.factId) !== factId || factType(v.factType) !== expectedType) fail();
  id(v.policyRevisionId); const asOf = instant(v.asOf);
  if (new TextEncoder().encode(JSON.stringify(v)).length > 262144) fail();
  const positions = array(v.positions, 2, 1000), dates = new Set<string>(), versions = new Set<string>(), evidence = new Set<string>();
  let count = 0;
  for (const raw of positions) {
    const item = object(raw); keys(item, ["value", "supports"]); const key = date(item.value);
    if (dates.has(key)) fail(); dates.add(key);
    const supports = array(item.supports, 1, 1000); count += supports.length; if (count > 1000) fail();
    for (const rawSupport of supports) {
      const row = object(rawSupport); keys(row, ["versionId", "evidenceId", "sourceId", "provenance", "effectiveAt", "observedAt", "versionValidUntil", "assessedValidUntil"]);
      const version = id(row.versionId), proof = id(row.evidenceId); id(row.sourceId);
      if (versions.has(version) || evidence.has(proof)) fail(); versions.add(version); evidence.add(proof);
      if (row.provenance !== "HUMAN_CONFIRMED" && row.provenance !== "SYSTEM_VERIFIED") fail();
      const effective = instant(row.effectiveAt), observed = instant(row.observedAt), adjusted = instant(row.assessedValidUntil);
      const original = row.versionValidUntil === null ? null : instant(row.versionValidUntil);
      if (effective > asOf || observed > asOf || adjusted <= asOf || (original !== null && (original <= asOf || adjusted > original))) fail();
    }
  }
  return v as ScalarConflictObservation;
}
