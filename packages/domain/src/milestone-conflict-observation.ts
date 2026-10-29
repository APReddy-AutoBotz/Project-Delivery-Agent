import { z } from "zod";
import type { Actor } from "./actor.js";
import { projectFactIdSchema, projectFactInstantSchema } from "./project-facts.js";
const id = projectFactIdSchema.regex(/^[0-9a-f-]+$/);
const instant = projectFactInstantSchema.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

// Read-only presentation contract. The repository must establish current source
// authorization and canonical identity; this schema is not an authority check.
const support = z.strictObject({
  versionId: id, evidenceId: id, sourceId: id,
  provenance: z.enum(["SYSTEM_VERIFIED", "HUMAN_CONFIRMED"]),
  freshness: z.literal("CURRENT"), validity: z.literal("FINITE"),
  effectiveAt: instant, observedAt: instant, versionValidUntil: instant.nullable(),
  assessedValidUntil: instant,
});
const positionBase = {
  targetId: id, bindingId: id, factId: id,
  factType: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_.-]*$/),
  policyRevisionId: id, supports: z.array(support).min(1).max(1000),
};
const position = z.discriminatedUnion("targetKind", [
  z.strictObject({ ...positionBase, targetKind: z.literal("MILESTONE"), state: z.literal("COMPLETE") }),
  z.strictObject({ ...positionBase, targetKind: z.literal("WORK_ITEM"), state: z.enum(["OPEN", "IN_PROGRESS"]) }),
]);
const envelope = { projectId: id, milestoneId: id, asOf: instant, ruleRevision: z.literal("milestone-required-state/v1") };
const observationBase = z.discriminatedUnion("outcome", [
  z.strictObject({ ...envelope, outcome: z.literal("NOT_DETECTED") }),
  z.strictObject({ ...envelope, outcome: z.literal("CONFLICTING"), positions: z.array(position).min(2).max(51) }),
]);
export const milestoneConflictObservationSchema = observationBase.superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Invalid conflict observation" });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144) invalid();
  if (value.outcome === "NOT_DETECTED") return;
  const targets = new Set<string>(), bindings = new Set<string>(), facts = new Set<string>();
  const versions = new Set<string>(), evidence = new Set<string>();
  let milestones = 0, count = 0;
  for (const item of value.positions) {
    if (targets.has(item.targetId) || bindings.has(item.bindingId) || facts.has(item.factId)) invalid();
    targets.add(item.targetId); bindings.add(item.bindingId); facts.add(item.factId);
    if (item.targetKind === "MILESTONE") {
      milestones++;
      if (item.targetId !== value.milestoneId) invalid();
    } else if (item.targetId === value.milestoneId) invalid();
    count += item.supports.length;
    if (count > 1000) invalid();
    for (const row of item.supports) {
      if (versions.has(row.versionId) || evidence.has(row.evidenceId) ||
          row.effectiveAt > value.asOf || row.observedAt > value.asOf || row.assessedValidUntil <= value.asOf ||
          (row.versionValidUntil !== null && row.versionValidUntil <= value.asOf) ||
          (row.versionValidUntil !== null && row.assessedValidUntil > row.versionValidUntil)) invalid();
      versions.add(row.versionId); evidence.add(row.evidenceId);
    }
  }
  if (milestones !== 1) invalid();
});
export type MilestoneConflictObservation = z.infer<typeof milestoneConflictObservationSchema>;
export class MilestoneConflictObservationError extends Error {
  constructor(readonly code: "DENIED" | "UNAVAILABLE") { super(code); this.name = "MilestoneConflictObservationError"; }
}
export interface MilestoneConflictObservationRepository {
  readLeadership(actor: Actor, projectId: string, milestoneId: string): Promise<MilestoneConflictObservation>;
}
