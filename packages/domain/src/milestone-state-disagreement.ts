import { z } from "zod";
import type { Actor } from "./actor.js";
import { projectFactIdSchema, projectFactInstantSchema } from "./project-facts.js";

const id = projectFactIdSchema.regex(/^[0-9a-f-]+$/);
const instant = projectFactInstantSchema.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const support = z.strictObject({
  versionId: id, evidenceId: id, sourceId: id,
  provenance: z.literal("HUMAN_CONFIRMED"),
  effectiveAt: instant, observedAt: instant, versionValidUntil: instant.nullable(),
  assessedValidUntil: instant,
});
const position = z.strictObject({
  state: z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]),
  supports: z.array(support).min(1).max(1000),
});

// Presentation validation does not establish binding, authority or access.
export const milestoneStateDisagreementSchema = z.strictObject({
  projectId: id, milestoneId: id, bindingId: id, factId: id,
  factType: z.string().regex(/^canonical\.state\.[a-f0-9]{32}$/),
  asOf: instant, policyRevisionId: id,
  positions: z.array(position).min(2).max(4),
}).superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Invalid milestone state disagreement" });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144) invalid();
  const states = new Set<string>(), versions = new Set<string>(), evidence = new Set<string>();
  let count = 0;
  for (const item of value.positions) {
    if (states.has(item.state)) invalid();
    states.add(item.state);
    count += item.supports.length;
    if (count > 1000) invalid();
    for (const row of item.supports) {
      if (versions.has(row.versionId) || evidence.has(row.evidenceId) ||
          row.effectiveAt > value.asOf || row.observedAt > value.asOf || row.assessedValidUntil <= value.asOf ||
          (row.versionValidUntil !== null && (row.versionValidUntil <= value.asOf || row.assessedValidUntil > row.versionValidUntil))) invalid();
      versions.add(row.versionId); evidence.add(row.evidenceId);
    }
  }
});
export type MilestoneStateDisagreement = z.infer<typeof milestoneStateDisagreementSchema>;
export class MilestoneStateDisagreementError extends Error {
  constructor(readonly code: "DENIED" | "UNAVAILABLE") { super(code); this.name = "MilestoneStateDisagreementError"; }
}
export interface MilestoneStateDisagreementRepository {
  readLeadership(actor: Actor, projectId: string, milestoneId: string): Promise<MilestoneStateDisagreement>;
}
