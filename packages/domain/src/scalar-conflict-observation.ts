import { z } from "zod";
import type { Actor } from "./actor.js";
import { canonicalDateSchema } from "./canonical-project.js";
import { projectFactIdSchema, projectFactInstantSchema } from "./project-facts.js";

const id = projectFactIdSchema.regex(/^[0-9a-f-]+$/);
const instant = projectFactInstantSchema.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const support = z.strictObject({
  versionId: id, evidenceId: id, sourceId: id,
  provenance: z.enum(["SYSTEM_VERIFIED", "HUMAN_CONFIRMED"]),
  effectiveAt: instant, observedAt: instant, versionValidUntil: instant.nullable(),
  assessedValidUntil: instant,
});
const position = z.strictObject({ value: canonicalDateSchema, supports: z.array(support).min(1).max(1000) });
const base = z.strictObject({
  projectId: id, factId: id, factType: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_.-]*$/),
  asOf: instant, policyRevisionId: id,
});
const priorAssessment = z.strictObject({ assessmentId: id, asOf: instant, policyRevisionId: id, position });

function validPositions(positions: readonly z.infer<typeof position>[], asOf: string) {
  const dates = new Set<string>(), versions = new Set<string>(), evidence = new Set<string>();
  let count = 0;
  for (const position of positions) {
    if (dates.has(position.value)) return false;
    dates.add(position.value);
    count += position.supports.length;
    if (count > 1000) return false;
    for (const row of position.supports) {
      if (versions.has(row.versionId) || evidence.has(row.evidenceId) ||
        row.effectiveAt > asOf || row.observedAt > asOf || row.assessedValidUntil <= asOf ||
        (row.versionValidUntil !== null && (row.versionValidUntil <= asOf || row.assessedValidUntil > row.versionValidUntil))) return false;
      versions.add(row.versionId); evidence.add(row.evidenceId);
    }
  }
  return true;
}

// This validates presentation integrity; the repository establishes authority.
export const scalarConflictObservationSchema = z.union([
  base.extend({ positions: z.array(position).min(2).max(1000) }),
  base.extend({ status: z.literal("RESOLVED"), positions: z.tuple([position]), prior: priorAssessment.optional() }),
]).superRefine((value, ctx) => {
  const prior = "prior" in value ? value.prior : undefined;
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144 || !validPositions(value.positions, value.asOf) ||
      (prior && (prior.asOf > value.asOf || !validPositions([prior.position], prior.asOf))))
    ctx.addIssue({ code: "custom", message: "Invalid scalar date evidence" });
});
export type ScalarConflictObservation = z.infer<typeof scalarConflictObservationSchema>;
export class ScalarConflictObservationError extends Error {
  constructor(readonly code: "DENIED" | "UNAVAILABLE") { super(code); this.name = "ScalarConflictObservationError"; }
}
export interface ScalarConflictObservationRepository {
  readLeadership(actor: Actor, projectId: string, factId: string, afterFactType?: string | null,
    includeResolved?: boolean, priorAssessmentId?: string): Promise<ScalarConflictObservation>;
}
