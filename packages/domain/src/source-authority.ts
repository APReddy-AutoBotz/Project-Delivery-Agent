import { z } from "zod";
import { assessFact } from "./fact-state.js";
import {
  assessTemporalFactHistory,
  temporalFactSnapshotSchema,
} from "./temporal-facts.js";

// FR-ADM-005, FR-EVD-003/004/006/007/009/010/012. Internal trusted snapshots
// only: this function neither authorizes a caller nor selects a current policy.
const temporal = temporalFactSnapshotSchema.shape;
const id = temporal.scope.shape.factId;
const instant = temporal.asOf;
const sourceType = temporal.scope.shape.factType;
const selectorSchema = z
  .object({
    sourceType,
    instanceId: id.nullable(),
    requiredApproval: z.enum(["APPROVED", "NOT_REQUIRED"]),
    validity: temporal.validityPolicy.shape.validity,
  })
  .strict();
export const sourceAuthorityPolicySchema = z
  .object({
    revisionId: id,
    customerId: id,
    projectId: id,
    factType: temporal.scope.shape.factType,
    recordedAt: instant,
    effectiveAt: instant,
    tiers: z
      .array(
        z
          .object({ selectors: z.array(selectorSchema).min(1).max(32) })
          .strict(),
      )
      .min(1)
      .max(16),
    conflictBehavior: z.enum(["RETAIN_CONFLICT", "REQUEST_RECONCILIATION"]),
  })
  .strict();
const approvalSchema = z
  .object({
    state: z.enum(["APPROVED", "PENDING", "REJECTED", "NOT_REQUIRED"]),
    decisionId: id.nullable(),
    decisionAt: instant.nullable(),
  })
  .strict()
  .refine((approval) =>
    approval.state === "APPROVED" || approval.state === "REJECTED"
      ? approval.decisionId !== null && approval.decisionAt !== null
      : approval.decisionId === null && approval.decisionAt === null,
  );
export const sourceAuthoritySnapshotSchema = z
  .object({
    scope: temporal.scope,
    asOf: instant,
    complete: z.boolean(),
    policy: sourceAuthorityPolicySchema.nullable(),
    versions: z
      .array(temporal.versions.element.extend({ approval: approvalSchema }))
      .max(1000),
    conflicts: temporal.conflicts,
    sources: z
      .array(z.object({ instanceId: id, sourceType }).strict())
      .max(1000),
    evidence: z
      .array(
        z
          .object({
            id,
            scope: temporal.scope,
            access: z.enum(["AUTHORIZED", "RESTRICTED"]),
            verification: z.enum([
              "VALID",
              "REVOKED",
              "DELETED",
              "UNVERIFIABLE",
            ]),
          })
          .strict(),
      )
      .max(64000),
  })
  .strict();
export type SourceAuthoritySnapshot = z.infer<
  typeof sourceAuthoritySnapshotSchema
>;
export type SourceAuthorityPolicy = z.infer<typeof sourceAuthorityPolicySchema>;
type Selector = z.infer<typeof selectorSchema>;
type Reason =
  | "NO_AUTHORITY_RULE"
  | "NOT_APPLICABLE"
  | "AMBIGUOUS_STREAM"
  | "APPROVAL_REQUIRED"
  | "REJECTED"
  | "STALE"
  | "UNKNOWN_VALIDITY"
  | "UNVERIFIED_ORIGIN";
type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function requireValid(condition: boolean): asserts condition {
  if (!condition) throw new Error("Invalid source authority snapshot");
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedIds = (values: string[]) => [...new Set(values)].sort(compare);
const scopeKey = (scope: SourceAuthoritySnapshot["scope"]) =>
  JSON.stringify([
    scope.customerId,
    scope.projectId,
    scope.factId,
    scope.factType,
  ]);
const valueKey = (
  value: SourceAuthoritySnapshot["versions"][number]["value"],
) => JSON.stringify([value.type, value.value]);

/**
 * Resolve one complete, explicit historical policy snapshot. The server must
 * authenticate/authorize the fact scope, acquire trusted source/approval/access
 * metadata and prove completeness before calling. Paginated/redacted history is
 * not an input adapter. Frozen results require current reauthorization on delivery.
 * Approval represents one immutable initial decision, not mutable latest state;
 * unsupported later revocation requires UNVERIFIABLE evidence, never a rewrite.
 */
export function resolveSourceAuthority(input: unknown) {
  // Do not propagate Zod issues, values, source text or nested parser errors.
  try {
    return resolveSnapshot(input);
  } catch {
    throw new Error("Invalid source authority snapshot");
  }
}

function resolveSnapshot(input: unknown) {
  const snapshot = sourceAuthoritySnapshotSchema.parse(input);
  const { scope, asOf, policy } = snapshot;
  const selectors: { tier: number; selector: Selector }[] = [];
  if (policy !== null) {
    requireValid(
      policy.customerId === scope.customerId &&
        policy.projectId === scope.projectId &&
        policy.factType === scope.factType,
    );
    for (const [tier, entry] of policy.tiers.entries()) {
      for (const selector of entry.selectors) {
        requireValid(
          !selectors.some(
            (prior) =>
              prior.selector.sourceType === selector.sourceType &&
              (prior.selector.instanceId === null ||
                selector.instanceId === null ||
                prior.selector.instanceId === selector.instanceId),
          ),
        );
        selectors.push({ tier, selector });
      }
    }
  }
  const policyApplicable =
    policy !== null && policy.recordedAt <= asOf && policy.effectiveAt <= asOf;
  const sourceTypes = new Map<string, string>();
  for (const source of snapshot.sources) {
    requireValid(!sourceTypes.has(source.instanceId));
    sourceTypes.set(source.instanceId, source.sourceType);
  }
  const evidence = new Map<
    string,
    SourceAuthoritySnapshot["evidence"][number]
  >();
  for (const item of snapshot.evidence) {
    requireValid(
      !evidence.has(item.id) && scopeKey(item.scope) === scopeKey(scope),
    );
    evidence.set(item.id, item);
  }
  const usedSources = new Set<string>();
  const usedEvidence = new Set<string>();
  for (const version of snapshot.versions) {
    requireValid(sourceTypes.has(version.source.instanceId));
    usedSources.add(version.source.instanceId);
    for (const evidenceId of version.evidenceIds) {
      requireValid(evidence.has(evidenceId));
      usedEvidence.add(evidenceId);
    }
    requireValid(
      version.approval.decisionAt === null ||
        version.approval.decisionAt >= version.observedAt,
    );
  }
  requireValid(
    usedSources.size === sourceTypes.size &&
      usedEvidence.size === evidence.size,
  );

  // ALL versions participate in supersession, before permission/validity/approval
  // exclusion. A restricted or unapproved new head cannot revive an older value.
  const history = assessTemporalFactHistory({
    scope,
    asOf,
    validityPolicy: {
      // Temporal plumbing only; a null authority policy stays null in output.
      // This surrogate is never returned as an authority policy revision.
      revisionId: policy?.revisionId ?? scope.factId,
      customerId: scope.customerId,
      projectId: scope.projectId,
      factType: scope.factType,
      validity: null,
    },
    versions: snapshot.versions.map(
      ({ approval: _approval, ...version }) => version,
    ),
    conflicts: snapshot.conflicts,
  });
  const original = new Map(
    snapshot.versions.map((version) => [version.id, version]),
  );
  const rows = history.versions.map((version) => {
    const approval = original.get(version.id)!.approval;
    const type = sourceTypes.get(version.source.instanceId)!;
    const match = policyApplicable
      ? selectors.find(
          ({ selector }) =>
            selector.sourceType === type &&
            (selector.instanceId === null ||
              selector.instanceId === version.source.instanceId),
        )
      : undefined;
    const allowed = version.evidenceIds.every((evidenceId) => {
      const item = evidence.get(evidenceId)!;
      return item.access === "AUTHORIZED" && item.verification === "VALID";
    });
    const approvalState =
      approval.decisionAt !== null && approval.decisionAt > asOf
        ? "PENDING"
        : approval.state;
    const approved =
      approvalState !== "REJECTED" &&
      match !== undefined &&
      (match.selector.requiredApproval === "NOT_REQUIRED" ||
        approvalState === "APPROVED");
    let expiry = version.assessedValidUntil;
    if (match?.selector.validity) {
      const { basis, durationMs } = match.selector.validity;
      const time = Date.parse(version[basis]) + durationMs;
      requireValid(Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15);
      const deadline = new Date(time).toISOString();
      requireValid(instant.safeParse(deadline).success);
      if (expiry === null || deadline < expiry) expiry = deadline;
    }
    const head =
      version.temporalApplicability === "APPLICABLE" ||
      version.temporalApplicability === "AMBIGUOUS";
    const known =
      version.temporalApplicability !== "NOT_YET_OBSERVED" &&
      version.temporalApplicability !== "NOT_YET_EFFECTIVE";
    const assessment = assessFact(
      {
        provenance: version.provenance,
        validUntil: known ? expiry : null,
        conflicting: version.unresolvedConflictIds.length > 0,
      },
      new Date(asOf),
    );
    const trustedOrigin =
      version.provenance === "SYSTEM_VERIFIED" ||
      version.provenance === "HUMAN_CONFIRMED";
    const reasons: Reason[] = [];
    if (!match) reasons.push("NO_AUTHORITY_RULE");
    if (!head) reasons.push("NOT_APPLICABLE");
    if (version.temporalApplicability === "AMBIGUOUS")
      reasons.push("AMBIGUOUS_STREAM");
    if (approvalState === "REJECTED") reasons.push("REJECTED");
    else if (match && !approved) reasons.push("APPROVAL_REQUIRED");
    if (assessment.freshness === "STALE") reasons.push("STALE");
    if (assessment.freshness === "UNKNOWN") reasons.push("UNKNOWN_VALIDITY");
    if (!trustedOrigin) reasons.push("UNVERIFIED_ORIGIN");
    return {
      version,
      approval,
      approvalState,
      sourceType: type,
      tier: match?.tier ?? null,
      allowed,
      approved,
      head,
      trustedOrigin,
      expiry,
      assessment,
      reasons,
      valueKey: valueKey(version.value),
    };
  });
  const eligible = rows.filter(
    (row) =>
      row.tier !== null &&
      row.allowed &&
      row.approved &&
      row.head &&
      row.trustedOrigin &&
      row.assessment.freshness === "CURRENT",
  );
  const selectedTier = eligible.length
    ? Math.min(...eligible.map((row) => row.tier!))
    : null;
  const selected = eligible.filter((row) => row.tier === selectedTier);
  const conflicts: {
    kind:
      | "RECORDED"
      | "AUTHORITY_DISAGREEMENT"
      | "HIGHER_AUTHORITY_CONTRADICTION";
    recordedConflictId: string | null;
    versionIds: string[];
    evidenceIds: string[];
  }[] = [];
  let conflictEvidenceReferences = 0;
  function addConflict(
    kind: (typeof conflicts)[number]["kind"],
    versionIds: string[],
    recordedConflictId: string | null = null,
  ) {
    const evidenceIds = new Set<string>();
    for (const versionId of versionIds) {
      for (const evidenceId of original.get(versionId)!.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          // Bound aggregate output before allocating expanded dependency arrays.
          requireValid(++conflictEvidenceReferences <= 64000);
          evidenceIds.add(evidenceId);
        }
      }
    }
    conflicts.push({
      kind,
      recordedConflictId,
      versionIds: sortedIds(versionIds),
      evidenceIds: [...evidenceIds].sort(compare),
    });
  }
  for (const conflict of history.conflicts) {
    if (
      conflict.detectedAt <= asOf &&
      (conflict.resolvedAt === null || asOf < conflict.resolvedAt)
    )
      addConflict("RECORDED", [...conflict.versionIds], conflict.id);
  }
  if (new Set(selected.map((row) => row.valueKey)).size > 1)
    addConflict(
      "AUTHORITY_DISAGREEMENT",
      selected.map((row) => row.version.id),
    );
  // Expiring a higher source must not silently promote a contradictory human
  // fallback, even when the contradiction has never been recorded before.
  const higherConflictIds = new Set<string>();
  for (const human of selected.filter(
    (row) => row.version.provenance === "HUMAN_CONFIRMED",
  )) {
    const higher = rows.filter(
      (row) =>
        row.tier !== null &&
        row.tier < selectedTier! &&
        row.allowed &&
        row.approved &&
        row.head &&
        row.trustedOrigin &&
        row.valueKey !== human.valueKey,
    );
    if (higher.length) {
      higherConflictIds.add(human.version.id);
      for (const row of higher) higherConflictIds.add(row.version.id);
    }
  }
  if (higherConflictIds.size)
    addConflict("HIGHER_AUTHORITY_CONTRADICTION", [...higherConflictIds]);
  conflicts.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const conflictingIds = new Set(
    conflicts.flatMap((conflict) => conflict.versionIds),
  );
  const revalidationRequired = rows.some((row) => !row.allowed);
  const ambiguous = selected.some(
    (row) => row.version.temporalApplicability === "AMBIGUOUS",
  );
  const status = !snapshot.complete
    ? "INCOMPLETE"
    : revalidationRequired
      ? "REVALIDATION_REQUIRED"
      : policy === null
        ? "NO_POLICY"
        : !policyApplicable
          ? "POLICY_NOT_APPLICABLE"
          : conflicts.length
            ? "CONFLICTING"
            : ambiguous
              ? "AMBIGUOUS"
              : selected.length
                ? "RESOLVED"
                : "UNKNOWN";
  return freeze({
    scope,
    asOf,
    mode: "HISTORICAL" as const,
    policy,
    complete: snapshot.complete,
    status,
    revalidationRequired,
    selectedTier,
    resolvedValue: status === "RESOLVED" ? selected[0]!.version.value : null,
    candidateVersionIds: selected.map((row) => row.version.id),
    supportingVersionIds:
      status === "RESOLVED" ? selected.map((row) => row.version.id) : [],
    supportingEvidenceIds:
      status === "RESOLVED"
        ? sortedIds(selected.flatMap((row) => [...row.version.evidenceIds]))
        : [],
    conflict: conflicts.length ? ("CONFLICTING" as const) : ("NONE" as const),
    conflicts,
    reconciliationRequired:
      conflicts.length > 0 &&
      policyApplicable &&
      policy?.conflictBehavior === "REQUEST_RECONCILIATION",
    versions: rows.map((row) => {
      if (!row.allowed)
        return {
          id: row.version.id,
          evidenceIds: [...row.version.evidenceIds],
          visibility: "restricted" as const,
          revalidationRequired: true as const,
        };
      return {
        ...row.version,
        visibility: "available" as const,
        revalidationRequired: false as const,
        sourceType: row.sourceType,
        approval: row.approval,
        approvalStateAsOf: row.approvalState,
        authorityTier: row.tier,
        eligibilityReasons: row.reasons,
        assessedValidUntil: row.expiry,
        assessment: assessFact(
          {
            provenance: row.version.provenance,
            validUntil:
              row.version.temporalApplicability === "NOT_YET_OBSERVED" ||
              row.version.temporalApplicability === "NOT_YET_EFFECTIVE"
                ? null
                : row.expiry,
            conflicting: conflictingIds.has(row.version.id),
          },
          new Date(asOf),
        ),
      };
    }),
  });
}
