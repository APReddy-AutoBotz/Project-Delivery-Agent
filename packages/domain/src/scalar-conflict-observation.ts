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
  asOf: instant, policyRevisionId: id, positions: z.array(position).min(2).max(1000),
});

// This validates presentation integrity; the repository establishes authority.
export const scalarConflictObservationSchema = base.superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Invalid scalar conflict observation" });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144) invalid();
  const dates = new Set<string>(), versions = new Set<string>(), evidence = new Set<string>();
  let count = 0;
  for (const position of value.positions) {
    if (dates.has(position.value)) invalid();
    dates.add(position.value);
    count += position.supports.length;
    if (count > 1000) invalid();
    for (const row of position.supports) {
      if (versions.has(row.versionId) || evidence.has(row.evidenceId) ||
        row.effectiveAt > value.asOf || row.observedAt > value.asOf || row.assessedValidUntil <= value.asOf ||
        (row.versionValidUntil !== null && (row.versionValidUntil <= value.asOf || row.assessedValidUntil > row.versionValidUntil))) invalid();
      versions.add(row.versionId); evidence.add(row.evidenceId);
    }
  }
});
export type ScalarConflictObservation = z.infer<typeof scalarConflictObservationSchema>;
export class ScalarConflictObservationError extends Error {
  constructor(readonly code: "DENIED" | "UNAVAILABLE") { super(code); this.name = "ScalarConflictObservationError"; }
}
export interface ScalarConflictObservationRepository {
  readLeadership(actor: Actor, projectId: string, factId: string): Promise<ScalarConflictObservation>;
}
