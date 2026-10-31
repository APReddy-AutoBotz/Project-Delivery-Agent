import { z } from "zod";
import { projectFactIdSchema, projectFactInstantSchema } from "./project-facts.js";
import { resolveSourceAuthority } from "./source-authority.js";
import type { Actor } from "./actor.js";

const id = projectFactIdSchema.regex(/^[0-9a-f-]+$/);
const instant = projectFactInstantSchema.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const support = z.strictObject({
  versionId: id, evidenceId: id, sourceId: id,
  provenance: z.literal("HUMAN_CONFIRMED"),
  effectiveAt: instant, observedAt: instant, versionValidUntil: instant,
});
const position = z.strictObject({
  state: z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]),
  supports: z.array(support).min(1).max(1000),
});

// Presentation validation alone establishes neither policy absence nor access.
// This is a distinct, unranked human-report DTO, not an authority decision.
export const unrankedMilestoneObservationSchema = z.strictObject({
  kind: z.literal("UNRANKED_NO_POLICY"),
  projectId: id, milestoneId: id, bindingId: id, factId: id,
  factType: z.string().regex(/^canonical\.state\.[a-f0-9]{32}$/),
  asOf: instant, positions: z.array(position).min(2).max(4),
}).superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Invalid unranked milestone observation" });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144) invalid();
  const states = new Set<string>(), versions = new Set<string>(), evidence = new Set<string>(), sources = new Set<string>();
  let count = 0;
  for (const item of value.positions) {
    if (states.has(item.state)) invalid();
    states.add(item.state);
    count += item.supports.length;
    if (count > 1000) invalid();
    for (const row of item.supports) {
      if (versions.has(row.versionId) || evidence.has(row.evidenceId) || sources.has(row.sourceId) ||
          row.effectiveAt > value.asOf || row.observedAt > value.asOf || row.versionValidUntil <= value.asOf) invalid();
      versions.add(row.versionId);
      evidence.add(row.evidenceId);
      sources.add(row.sourceId);
    }
  }
});
export type UnrankedMilestoneObservation = z.infer<typeof unrankedMilestoneObservationSchema>;
export interface UnrankedMilestoneObservationRepository {
  readUnrankedLeadership(actor: Actor, projectId: string, milestoneId: string): Promise<UnrankedMilestoneObservation>;
}

// Pure transformation of an already complete, authorized snapshot. A null
// resolver policy does not prove that a policy aggregate is absent: callers
// must independently establish that fact under the appropriate project lock.
export function unrankedMilestoneFromSnapshot(
  snapshot: unknown,
  target: { milestoneId: string; bindingId: string },
): UnrankedMilestoneObservation | null {
  try {
    const result = resolveSourceAuthority(snapshot);
    if (!result.complete || result.policy !== null || result.status !== "NO_POLICY" ||
        result.revalidationRequired || result.conflicts.length !== 0) return null;
    const positions = new Map<string, { versionId: string; evidenceId: string; sourceId: string;
      provenance: "HUMAN_CONFIRMED"; effectiveAt: string; observedAt: string; versionValidUntil: string }[]>();
    const historicalEvidence = new Set<string>();
    for (const version of result.versions) {
      if (version.visibility !== "available" || version.provenance !== "HUMAN_CONFIRMED" ||
          version.sourceType !== "human_statement" || version.source.recordType !== "human_statement" ||
          version.source.recordId !== version.source.instanceId || version.evidenceIds.length !== 1 ||
          version.source.revision !== version.evidenceIds[0] || historicalEvidence.has(version.evidenceIds[0]!) ||
          version.approval.state !== "NOT_REQUIRED" || version.approvalStateAsOf !== "NOT_REQUIRED" ||
          version.approval.decisionId !== null || version.approval.decisionAt !== null ||
          version.value.type !== "text" || !["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"].includes(version.value.value) ||
          version.temporalApplicability === "AMBIGUOUS") return null;
      historicalEvidence.add(version.evidenceIds[0]!);
      if (version.temporalApplicability !== "APPLICABLE") continue;
      if (version.assessment.freshness !== "CURRENT" || !version.validUntil || version.validUntil <= result.asOf) return null;
      const supports = positions.get(version.value.value) ?? [];
      supports.push({ versionId: version.id, evidenceId: version.evidenceIds[0]!, sourceId: version.source.instanceId,
        provenance: "HUMAN_CONFIRMED", effectiveAt: version.effectiveAt, observedAt: version.observedAt,
        versionValidUntil: version.validUntil });
      positions.set(version.value.value, supports);
    }
    return unrankedMilestoneObservationSchema.parse({ kind: "UNRANKED_NO_POLICY",
      projectId: result.scope.projectId, milestoneId: target.milestoneId, bindingId: target.bindingId,
      factId: result.scope.factId, factType: result.scope.factType, asOf: result.asOf,
      positions: [...positions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([state, supports]) => ({
        state, supports: supports.sort((a, b) => a.versionId.localeCompare(b.versionId)),
      })) });
  } catch { return null; }
}
