import { authorityAssessmentSchema } from "./evidence-responses.js";

// FR-EVD-007/009/012, FR-ADM-005: internal deterministic computation only.
// A validated frozen proof/immutable version ledger binds actual values. This
// helper neither authorizes a caller nor creates a reconciliation request.
export const scalarReconciliationRuleRevision = "scalar-authority-conflict/v1";
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: readonly string[]) =>
  [...new Set(values)].sort(compare);
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("Invalid scalar reconciliation assessment");
}
function record(value: unknown): Record<string, unknown> {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  valid(Array.isArray(value) && value.length <= maximum);
  return value;
}
// Bound traversal before Zod clones nested arrays, including negative outcomes.
function preflight(input: unknown) {
  const row = record(input);
  const versions = array(row.versions, 1000);
  const conflicts = array(row.conflicts, 1002);
  for (const key of ["candidateVersionIds", "supportingVersionIds"])
    array(row[key], 1000);
  array(row.supportingEvidenceIds, 64000);
  let references = 0;
  for (const raw of versions) {
    const version = record(raw);
    references += array(version.evidenceIds, 64).length;
    valid(references <= 64000);
    if (version.visibility === "available") {
      array(version.unresolvedConflictIds, 1000);
      array(version.eligibilityReasons, 8);
    }
  }
  references = 0;
  for (const raw of conflicts) {
    const conflict = record(raw);
    array(conflict.versionIds, 1000);
    references += array(conflict.evidenceIds, 64000).length;
    valid(references <= 64000);
  }
  if (row.policy !== null) {
    for (const tier of array(record(row.policy).tiers, 16))
      array(record(tier).selectors, 32);
  }
}

/** null means a valid ineligible assessment, never malformed/over-budget input.
 * Input must come from resolveSourceAuthority or independently validated stored
 * proof. This checks identity coherence, not the authority evaluator's semantics.
 */
export function scalarReconciliationIdentity(input: unknown): string | null {
  try {
    preflight(input);
    const row = authorityAssessmentSchema.parse(input);
    const { scope, policy } = row;
    if (policy !== null)
      valid(
        policy.customerId === scope.customerId &&
          policy.projectId === scope.projectId &&
          policy.factType === scope.factType,
      );
    const versions = new Map(
      row.versions.map((version) => [version.id, version]),
    );
    valid(versions.size === row.versions.length);
    for (const version of row.versions) {
      valid(new Set(version.evidenceIds).size === version.evidenceIds.length);
      if (version.visibility === "available")
        valid(
          version.scope.customerId === scope.customerId &&
            version.scope.projectId === scope.projectId &&
            version.scope.factId === scope.factId &&
            version.scope.factType === scope.factType,
        );
    }
    const contributors = new Set<string>();
    for (const conflict of row.conflicts) {
      valid(conflict.versionIds.length >= 2);
      valid(new Set(conflict.versionIds).size === conflict.versionIds.length);
      const evidence = new Set<string>();
      for (const id of conflict.versionIds) {
        const version = versions.get(id);
        valid(version !== undefined);
        contributors.add(id);
        for (const evidenceId of version.evidenceIds) evidence.add(evidenceId);
      }
      valid(
        evidence.size === conflict.evidenceIds.length &&
          conflict.evidenceIds.every((id) => evidence.delete(id)),
      );
    }
    const applicable =
      policy !== null &&
      policy.recordedAt <= row.asOf &&
      policy.effectiveAt <= row.asOf;
    valid((row.conflict === "CONFLICTING") === row.conflicts.length > 0);
    valid(
      row.reconciliationRequired ===
        (row.conflicts.length > 0 &&
          applicable &&
          policy?.conflictBehavior === "REQUEST_RECONCILIATION"),
    );
    valid(
      row.revalidationRequired ===
        row.versions.some((version) => version.visibility === "restricted"),
    );
    const requiredStatus = !row.complete
      ? "INCOMPLETE"
      : row.revalidationRequired
        ? "REVALIDATION_REQUIRED"
        : policy === null
          ? "NO_POLICY"
          : !applicable
            ? "POLICY_NOT_APPLICABLE"
            : row.conflicts.length > 0
              ? "CONFLICTING"
              : null;
    valid(
      requiredStatus === null
        ? ["RESOLVED", "AMBIGUOUS", "UNKNOWN"].includes(row.status)
        : row.status === requiredStatus,
    );
    if (
      !row.complete ||
      row.status !== "CONFLICTING" ||
      row.revalidationRequired ||
      !row.reconciliationRequired ||
      policy === null ||
      !applicable ||
      policy.conflictBehavior !== "REQUEST_RECONCILIATION"
    )
      return null;
    valid(contributors.size >= 2);
    const tuples = sorted([...contributors]).map((id) => {
      const version = versions.get(id)!;
      valid(version.visibility === "available");
      return [
        id,
        version.source.instanceId,
        version.value.type,
        sorted(version.evidenceIds),
      ];
    });
    const identity = JSON.stringify([
      scalarReconciliationRuleRevision,
      scope.customerId,
      scope.projectId,
      scope.factId,
      policy.revisionId,
      tuples,
    ]);
    // IDs and type discriminators are ASCII, so UTF-8 bytes equal JS length.
    valid(identity.length <= 4 * 1024 * 1024);
    return identity;
  } catch {
    throw new Error("Invalid scalar reconciliation assessment");
  }
}
