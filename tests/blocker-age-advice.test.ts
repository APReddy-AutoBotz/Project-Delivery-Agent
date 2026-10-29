import { describe, expect, it } from "vitest";
import { blockerAgeAdviceSchema, buildBlockerAgeAdvice } from "../packages/domain/src/blocker-age-advice.js";
import { fitsBlockerAgeBudget } from "../packages/domain/src/blocker-age-budget.js";

const asOf = "2026-10-21T12:00:00.000Z";
const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const proof = (factType: string, number: number, validity: "FINITE" | "UNTIL_SUPERSEDED" = "FINITE") => ({ factId: id(number), factType, factRevision: 1,
  policyId: id(number + 100), policyRevisionId: id(number + 200), policyRevision: 2,
  status: "RESOLVED" as const, provenance: "HUMAN_CONFIRMED" as const, sourceType: "human_statement" as const,
  freshness: "CURRENT" as const, conflict: "NONE" as const, validity,
  supports: [{ versionId: id(number + 300), evidenceId: id(number + 400), sourceId: id(number + 500), accessRevision: 1 }] });
function input(audience: "project_manager" | "leadership" = "project_manager") {
  const raidItemId = id(2);
  return { projectId: id(1), audience, asOf, coverage: "COMPLETE" as const,
    threshold: { minimumBlockerAgeDays: 5, revision: 3 }, noOpenBlockers: false,
    inventory: proof("project.open_blocker_inventory_complete", 10),
    candidates: [{ raidItemId, key: "ISSUE-1", state: "OPEN" as const, openedAt: "2026-10-16",
      classification: proof(`raid_item.${raidItemId}.blocks_delivery`, 11),
      openedAtProof: proof(`raid_item.${raidItemId}.opened_at`, 12, "UNTIL_SUPERSEDED") }] };
}

describe("EXEC-027 blocker-age advice composition", () => {
  it("enforces the exact UTF-8 facet byte boundary", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ padding: "" })).byteLength;
    const atLimit = { padding: "a".repeat(262144 - overhead) };
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).byteLength).toBe(262144);
    expect(fitsBlockerAgeBudget(atLimit)).toBe(true);
    expect(fitsBlockerAgeBudget({ padding: atLimit.padding + "a" })).toBe(false);
    const unicode = { padding: "a".repeat(262144 - overhead - 2) + "é" };
    expect(fitsBlockerAgeBudget(unicode)).toBe(true);
    expect(fitsBlockerAgeBudget({ padding: unicode.padding + "a" })).toBe(false);
  });
  it("derives an aged review on the exact UTC threshold and retains bound proofs", () => {
    const candidate = input(), result = buildBlockerAgeAdvice(candidate);
    expect(result).toMatchObject({ coverage: "COMPLETE", timeZone: "UTC", ruleRevision: "blocker-age@1",
      orderRevision: "blocker-review-order@1", threshold: { minimumBlockerAgeDays: 5, revision: 3 },
      items: [{ key: "ISSUE-1", ageDays: 5, sourceDateField: "opened_at", classification: candidate.candidates[0]!.classification }] });
    expect(result.items[0]!.suggestedAction).not.toMatch(/critical|owner|underperform/i);
    expect(blockerAgeAdviceSchema.safeParse(result).success).toBe(true);
  });
  it("derives different role wording without changing the underlying proof", () => {
    const pm = buildBlockerAgeAdvice(input()), leader = buildBlockerAgeAdvice(input("leadership"));
    expect(leader.items[0]!.suggestedAction).toContain("intervention");
    expect(pm.items[0]!.suggestedAction).not.toEqual(leader.items[0]!.suggestedAction);
    expect(pm.items[0]!.openedAtProof).toEqual(leader.items[0]!.openedAtProof);
  });
  it("rejects an under-threshold or future candidate rather than calling it aged", () => {
    const candidate = input();
    candidate.candidates[0]!.openedAt = "2026-10-17";
    expect(() => buildBlockerAgeAdvice(candidate)).toThrow();
    candidate.candidates[0]!.openedAt = "2026-10-22";
    expect(() => buildBlockerAgeAdvice(candidate)).toThrow();
  });
  it("keeps an unavailable facet empty and forbids hidden proof content", () => {
    const candidate = input();
    const unavailable = { ...candidate, coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, candidates: [] };
    expect(buildBlockerAgeAdvice(unavailable)).toMatchObject({ coverage: "UNASSESSABLE", items: [], threshold: null, inventory: null });
    expect(() => buildBlockerAgeAdvice({ ...unavailable, candidates: candidate.candidates })).toThrow();
    expect(() => buildBlockerAgeAdvice({ ...unavailable, inventory: candidate.inventory })).toThrow();
  });
  it("distinguishes complete below-threshold coverage from no open blockers and partial coverage", () => {
    const candidate = input();
    const belowThreshold = buildBlockerAgeAdvice({ ...candidate, candidates: [], noOpenBlockers: false });
    const noneOpen = buildBlockerAgeAdvice({ ...candidate, candidates: [], noOpenBlockers: true });
    expect(belowThreshold).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: false, items: [] });
    expect(noneOpen).toMatchObject({ coverage: "COMPLETE", noOpenBlockers: true, items: [] });
    const partial = buildBlockerAgeAdvice({ ...candidate, coverage: "PARTIAL", noOpenBlockers: null });
    expect(partial).toMatchObject({ coverage: "PARTIAL", noOpenBlockers: null, items: [{ key: "ISSUE-1" }] });
    expect(() => buildBlockerAgeAdvice({ ...candidate, coverage: "PARTIAL", noOpenBlockers: false })).toThrow();
    expect(() => buildBlockerAgeAdvice({ ...candidate, noOpenBlockers: true })).toThrow();
  });
  it("rejects mismatched, duplicated or unsorted proof references", () => {
    const candidate = input();
    const wrong = structuredClone(candidate); wrong.candidates[0]!.classification.factType = "project.unrelated";
    expect(() => buildBlockerAgeAdvice(wrong)).toThrow();
    const wrongValidity = structuredClone(candidate); wrongValidity.candidates[0]!.openedAtProof.validity = "FINITE";
    expect(() => buildBlockerAgeAdvice(wrongValidity)).toThrow();
    const wrongInventoryValidity = structuredClone(candidate); wrongInventoryValidity.inventory.validity = "UNTIL_SUPERSEDED";
    expect(() => buildBlockerAgeAdvice(wrongInventoryValidity)).toThrow();
    const wrongClassificationValidity = structuredClone(candidate); wrongClassificationValidity.candidates[0]!.classification.validity = "UNTIL_SUPERSEDED";
    expect(() => buildBlockerAgeAdvice(wrongClassificationValidity)).toThrow();
    for (const [field, value] of [["sourceType", "jira"], ["provenance", "SYSTEM_VERIFIED"], ["freshness", "STALE"],
      ["conflict", "CONFLICTING"], ["status", "UNKNOWN"]] as const) {
      const changed = structuredClone(candidate);
      (changed.inventory as unknown as Record<string, unknown>)[field] = value;
      expect(() => buildBlockerAgeAdvice(changed)).toThrow();
    }
    const duplicate = structuredClone(candidate);
    duplicate.inventory.factRevision = 2;
    duplicate.inventory.supports.push({ ...duplicate.inventory.supports[0]! });
    expect(() => buildBlockerAgeAdvice(duplicate)).toThrow();
    const reversed = structuredClone(candidate);
    reversed.inventory.factRevision = 2;
    reversed.inventory.supports.unshift({ ...reversed.inventory.supports[0]!, versionId: id(999), evidenceId: id(998) });
    expect(() => buildBlockerAgeAdvice(reversed)).toThrow();
    const duplicateEvidence = structuredClone(candidate);
    duplicateEvidence.inventory.factRevision = 2;
    duplicateEvidence.inventory.supports.push({ ...duplicateEvidence.inventory.supports[0]!, versionId: id(999) });
    expect(() => buildBlockerAgeAdvice(duplicateEvidence)).toThrow();
    for (const field of ["factId", "policyId", "policyRevisionId"] as const) {
      const reused = structuredClone(candidate);
      reused.candidates[0]!.classification[field] = reused.inventory[field];
      expect(() => buildBlockerAgeAdvice(reused)).toThrow();
    }
    const reusedSource = structuredClone(candidate);
    reusedSource.candidates[0]!.openedAtProof.supports[0]!.sourceId = reusedSource.inventory.supports[0]!.sourceId;
    expect(() => buildBlockerAgeAdvice(reusedSource)).toThrow();
    const sameSource = structuredClone(candidate), original = sameSource.inventory.supports[0]!;
    sameSource.inventory.supports.push({ ...original, versionId: id(998), evidenceId: id(999) });
    sameSource.inventory.factRevision = 2;
    expect(() => buildBlockerAgeAdvice(sameSource)).not.toThrow();
    sameSource.inventory.supports[1]!.accessRevision++;
    expect(() => buildBlockerAgeAdvice(sameSource)).toThrow();
    const mixedCase = structuredClone(candidate);
    mixedCase.inventory.factRevision = 2;
    mixedCase.inventory.supports[0]!.versionId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    mixedCase.inventory.supports.push({ ...mixedCase.inventory.supports[0]!, versionId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", evidenceId: id(999) });
    expect(() => buildBlockerAgeAdvice(mixedCase)).toThrow();
  });
  it("rejects changed ages, rule text, duplicate candidates and unrecognized fields", () => {
    const candidate = input(), result = buildBlockerAgeAdvice(candidate);
    const changed = structuredClone(result); changed.items[0]!.ageDays++;
    expect(blockerAgeAdviceSchema.safeParse(changed).success).toBe(false);
    const wording = structuredClone(result); wording.items[0]!.suggestedAction = "Escalate this critical blocker.";
    expect(blockerAgeAdviceSchema.safeParse(wording).success).toBe(false);
    expect(() => buildBlockerAgeAdvice({ ...candidate, candidates: [...candidate.candidates, candidate.candidates[0]!] })).toThrow();
    expect(() => buildBlockerAgeAdvice({ ...candidate, dependencies: ["private"] })).toThrow();
  });
  it("bounds supporting versions across all proofs, not just within each proof", () => {
    const candidate = input(), initial = candidate.inventory.supports[0]!;
    candidate.inventory.factRevision = 999;
    for (let i = 0; i < 997; i++) candidate.inventory.supports.push({ ...initial, versionId: id(5000 + i), evidenceId: id(7000 + i) });
    expect(buildBlockerAgeAdvice(candidate).inventory?.supports).toHaveLength(998);
    candidate.inventory.supports.push({ ...initial, versionId: id(5997), evidenceId: id(7997) });
    expect(() => buildBlockerAgeAdvice(candidate)).toThrow();
  });
});
