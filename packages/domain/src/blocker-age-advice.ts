import { z } from "zod";
import { canonicalDateSchema, canonicalKeySchema } from "./canonical-project.js";
import { evaluateBlockerAgeSignals } from "./blocker-age-signals.js";
import type { Actor } from "./actor.js";
import { fitsBlockerAgeBudget } from "./blocker-age-budget.js";

// EXEC-027 / FR-HLT-004 / FR-ADV-007: the caller must supply current,
// authorized proof bindings obtained under the transaction's source gates.
const instant = z.iso.datetime({ precision: 3 });
const audience = z.enum(["project_manager", "leadership"]);
const revision = z.number().int().min(1).max(2147483647);
const id = z.uuid().regex(/^[0-9a-f-]+$/);
const factType = z.string().min(1).max(160).regex(/^[a-z][a-z0-9_.-]*$/);
const support = z.strictObject({
  versionId: id, evidenceId: id, sourceId: id, accessRevision: revision,
});
const proof = z.strictObject({
  factId: id, factType, factRevision: revision, policyId: id,
  policyRevisionId: id, policyRevision: revision, status: z.literal("RESOLVED"),
  provenance: z.literal("HUMAN_CONFIRMED"), sourceType: z.literal("human_statement"),
  freshness: z.literal("CURRENT"), conflict: z.literal("NONE"), validity: z.enum(["FINITE", "UNTIL_SUPERSEDED"]),
  supports: z.array(support).min(1).max(1000),
});
const threshold = z.strictObject({ minimumBlockerAgeDays: z.number().int().min(1).max(3650), revision });
const candidate = z.strictObject({
  raidItemId: id, key: canonicalKeySchema, state: z.enum(["OPEN", "IN_PROGRESS"]),
  openedAt: canonicalDateSchema, classification: proof, openedAtProof: proof,
});
const item = candidate.extend({
  ageDays: z.number().int().min(0), sourceDateField: z.literal("opened_at"),
  suggestedAction: z.string(), expectedOutcome: z.string(),
});
const evaluated = z.strictObject({
  projectId: id, audience, asOf: instant,
  coverage: z.enum(["COMPLETE", "PARTIAL"]), ruleRevision: z.literal("blocker-age@1"),
  orderRevision: z.literal("blocker-review-order@1"), timeZone: z.literal("UTC"),
  threshold, inventory: proof, noOpenBlockers: z.boolean().nullable(), items: z.array(item).max(50),
});
const unassessable = z.strictObject({
  projectId: id, audience, asOf: instant, coverage: z.literal("UNASSESSABLE"),
  ruleRevision: z.literal("blocker-age@1"), orderRevision: z.literal("blocker-review-order@1"),
  timeZone: z.literal("UTC"), threshold: z.null(), inventory: z.null(),
  noOpenBlockers: z.null(), items: z.array(item).max(0),
});
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const textFor = (role: z.infer<typeof audience>) => ({
  suggestedAction: role === "project_manager"
    ? "Review the aged blocker and decide the next delivery action."
    : "Review the aged blocker and decide whether an intervention is needed.",
  expectedOutcome: "A reviewed next step for the blocker and its delivery impact.",
});
function validProof(value: z.infer<typeof proof>, expectedType: string, validity: "FINITE" | "UNTIL_SUPERSEDED") {
  if (value.factType !== expectedType || value.validity !== validity || value.supports.length > value.factRevision) return false;
  const versions = value.supports.map((entry) => entry.versionId.toLowerCase());
  const evidence = value.supports.map((entry) => entry.evidenceId.toLowerCase());
  if (new Set(versions).size !== versions.length || new Set(evidence).size !== evidence.length) return false;
  const ordered = [...versions].sort(compare);
  return versions.every((id, index) => id === ordered[index]);
}

const blockerAgeAdviceBase = z.discriminatedUnion("coverage", [
  evaluated.extend({ coverage: z.literal("COMPLETE") }),
  evaluated.extend({ coverage: z.literal("PARTIAL") }),
  unassessable,
]);
function validateAdvice(value: z.infer<typeof blockerAgeAdviceBase>, context: z.RefinementCtx) {
  const invalid = () => context.addIssue({ code: "custom", message: "Invalid blocker-age advice" });
  if (!fitsBlockerAgeBudget(value)) invalid();
  if (value.coverage === "UNASSESSABLE") return;
  if (!validProof(value.inventory, "project.open_blocker_inventory_complete", "FINITE") ||
      (value.coverage === "PARTIAL" && value.noOpenBlockers !== null) ||
      (value.coverage === "COMPLETE" && value.noOpenBlockers === null) ||
      (value.noOpenBlockers === true && value.items.length > 0)) invalid();
  // IDs are globally scoped by the ledger. A source may support more than one
  // version of its own fact, but no ID may silently move to another fact.
  const owners = new Map<string, string>();
  let supportCount = 0;
  const bind = (kind: string, id: string, owner: string) => {
    const key = `${kind}:${id.toLowerCase()}`, previous = owners.get(key);
    if (previous !== undefined && previous !== owner) invalid();
    owners.set(key, owner);
  };
  const bindProof = (value: z.infer<typeof proof>) => {
    supportCount += value.supports.length;
    if (supportCount > 1000) invalid();
    const owner = JSON.stringify([value.factType, value.factId.toLowerCase()]);
    bind("fact", value.factId, value.factType);
    bind("policy", value.policyId, owner);
    bind("policyRevision", value.policyRevisionId, JSON.stringify([owner, value.policyId.toLowerCase(), value.policyRevision]));
    for (const entry of value.supports) {
      bind("source", entry.sourceId, JSON.stringify([owner, entry.accessRevision]));
      bind("version", entry.versionId, JSON.stringify([owner, entry.sourceId.toLowerCase()]));
      bind("evidence", entry.evidenceId, JSON.stringify([owner, entry.versionId.toLowerCase()]));
    }
  };
  bindProof(value.inventory);
  const keys = new Set<string>(), ids = new Set<string>();
  for (const [index, candidate] of value.items.entries()) {
    const raidId = candidate.raidItemId.toLowerCase();
    if (keys.has(candidate.key) || ids.has(raidId) ||
        !validProof(candidate.classification, `raid_item.${raidId}.blocks_delivery`, "FINITE") ||
        !validProof(candidate.openedAtProof, `raid_item.${raidId}.opened_at`, "UNTIL_SUPERSEDED") ||
        candidate.suggestedAction !== textFor(value.audience).suggestedAction ||
        candidate.expectedOutcome !== textFor(value.audience).expectedOutcome ||
        (index > 0 && (compare(value.items[index - 1]!.key, candidate.key) > 0 ||
          (value.items[index - 1]!.key === candidate.key && compare(value.items[index - 1]!.raidItemId, candidate.raidItemId) >= 0)))) invalid();
    keys.add(candidate.key); ids.add(raidId);
    bindProof(candidate.classification); bindProof(candidate.openedAtProof);
    try {
      const assessment = evaluateBlockerAgeSignals({ asOf: value.asOf, timeZone: "UTC", blockerReadComplete: true,
        threshold: { ruleKey: "blocker-age", ruleRevision: "1", minimumBlockerAgeDays: value.threshold.minimumBlockerAgeDays },
        blockers: [{ targetType: "RAID_ITEM", targetKey: candidate.key, state: candidate.state, sourceDate: candidate.openedAt,
          sourceDateField: "opened_at", source: { kind: "canonical_field" } }] }).assessments[0];
      if (!assessment || assessment.status !== "AGED" || assessment.ageDays !== candidate.ageDays) invalid();
    } catch { invalid(); }
  }
}
export const blockerAgeAdviceSchema = blockerAgeAdviceBase.superRefine(validateAdvice);
export const leadershipBlockerAgeAdviceSchema = z.discriminatedUnion("coverage", [
  evaluated.extend({ coverage: z.literal("COMPLETE"), audience: z.literal("leadership") }),
  evaluated.extend({ coverage: z.literal("PARTIAL"), audience: z.literal("leadership") }),
  unassessable.extend({ audience: z.literal("leadership") }),
]).superRefine(validateAdvice);
export type BlockerAgeAdvice = z.infer<typeof blockerAgeAdviceSchema>;
export class BlockerAgeAdviceError extends Error {
  constructor(readonly code: "DENIED" | "UNAVAILABLE") { super(code); this.name = "BlockerAgeAdviceError"; }
}
export interface BlockerAgeAdviceRepository {
  readLeadership(actor: Actor, projectId: string): Promise<BlockerAgeAdvice>;
}

const request = z.strictObject({
  projectId: id, audience, asOf: instant, coverage: z.enum(["COMPLETE", "PARTIAL", "UNASSESSABLE"]),
  threshold: threshold.nullable(), inventory: proof.nullable(), noOpenBlockers: z.boolean().nullable(),
  candidates: z.array(candidate).max(50),
});

// This function does not authorize evidence or establish criticality. It only
// derives presentation from a transaction-owned, already-authorized snapshot.
export function buildBlockerAgeAdvice(value: unknown): BlockerAgeAdvice {
  const input = request.parse(value), base = { projectId: input.projectId, audience: input.audience,
    asOf: input.asOf, ruleRevision: "blocker-age@1" as const, orderRevision: "blocker-review-order@1" as const, timeZone: "UTC" as const };
  if (input.coverage === "UNASSESSABLE") {
    if (input.threshold !== null || input.inventory !== null || input.noOpenBlockers !== null || input.candidates.length) throw new Error("Invalid blocker-age advice");
    return blockerAgeAdviceSchema.parse({ ...base, coverage: input.coverage, threshold: null, inventory: null, noOpenBlockers: null, items: [] });
  }
  if (!input.threshold || !input.inventory) throw new Error("Invalid blocker-age advice");
  const assessments = evaluateBlockerAgeSignals({ asOf: input.asOf, timeZone: "UTC", blockerReadComplete: true,
    threshold: { ruleKey: "blocker-age", ruleRevision: "1", minimumBlockerAgeDays: input.threshold.minimumBlockerAgeDays },
    blockers: input.candidates.map((candidate) => ({ targetType: "RAID_ITEM", targetKey: candidate.key, state: candidate.state,
      sourceDate: candidate.openedAt, sourceDateField: "opened_at", source: { kind: "canonical_field" } })) });
  const ages = new Map(assessments.assessments.map((assessment) => [assessment.targetKey, assessment]));
  const items = input.candidates.map((candidate) => {
    const age = ages.get(candidate.key);
    if (!age || age.status !== "AGED" || age.ageDays === null) throw new Error("Invalid blocker-age advice");
    return { ...candidate, ageDays: age.ageDays, sourceDateField: "opened_at" as const, ...textFor(input.audience) };
  }).sort((a, b) => compare(a.key, b.key) || compare(a.raidItemId, b.raidItemId));
  return blockerAgeAdviceSchema.parse({ ...base, coverage: input.coverage, threshold: input.threshold,
    inventory: input.inventory, noOpenBlockers: input.noOpenBlockers, items });
}
