import { z } from "zod";
import {
  resolveSourceAuthority,
  sourceAuthoritySnapshotSchema,
  type SourceAuthoritySnapshot,
} from "./source-authority.js";

// FR-EVD-004/009/010/012: internal, historical computation. The repository must
// establish canonical bindings, complete required links and current source access.
// This function is not an authorization boundary or a durable PM request.
const scalar = sourceAuthoritySnapshotSchema.shape;
const id = scalar.scope.shape.factId;
const kind = z.enum(["MILESTONE", "WORK_ITEM"]);
const state = z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]);
const scopeSchema = z
  .object({
    customerId: id,
    projectId: id,
    milestoneId: id,
  })
  .strict();
const bindingSchema = z
  .object({
    id,
    customerId: id,
    projectId: id,
    targetKind: kind,
    targetId: id,
    field: z.literal("state"),
    factId: id,
    factType: scalar.scope.shape.factType,
  })
  .strict();
// Do not let Zod traverse unbounded arrays before the shared preflight budget.
const array = z.custom<unknown[]>(Array.isArray);
const inputSchema = z
  .object({
    scope: scopeSchema,
    asOf: scalar.asOf,
    ruleRevision: z.literal("milestone-required-state/v1"),
    enabled: z.boolean(),
    complete: z.boolean(),
    requiredWorkItemIds: array,
    targets: array,
  })
  .strict();
const slotSchema = z
  .object({
    targetKind: kind,
    targetId: id,
    binding: bindingSchema.nullable(),
    snapshot: z.unknown(),
  })
  .strict();
const headerSchema = sourceAuthoritySnapshotSchema.extend({
  policy: z.unknown(),
  versions: array,
  conflicts: array,
  sources: array,
  evidence: array,
});
type Binding = z.infer<typeof bindingSchema>;
export type MilestoneConsistencySnapshot = Omit<
  z.infer<typeof inputSchema>,
  "requiredWorkItemIds" | "targets"
> & {
  requiredWorkItemIds: string[];
  targets: {
    targetKind: "MILESTONE" | "WORK_ITEM";
    targetId: string;
    binding: Binding | null;
    snapshot: SourceAuthoritySnapshot | null;
  }[];
};
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
function valid(condition: boolean): asserts condition {
  if (!condition) throw new Error("Invalid milestone consistency snapshot");
}
function record(value: unknown): Record<string, unknown> {
  valid(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (ids: readonly string[]) => [...ids].sort(compare);

export function evaluateMilestoneConsistency(input: unknown) {
  try {
    return evaluate(input);
  } catch {
    throw new Error("Invalid milestone consistency snapshot");
  }
}

function evaluate(input: unknown) {
  const request = inputSchema.parse(input);
  const { scope, asOf, ruleRevision } = request;
  const envelope = { scope, asOf, ruleRevision };
  const incomplete = () =>
    freeze({ ...envelope, status: "INCOMPLETE" as const });
  if (request.requiredWorkItemIds.length > 50 || request.targets.length > 51)
    return incomplete();
  const required = request.requiredWorkItemIds.map((value) => id.parse(value));
  valid(
    new Set(required).size === required.length &&
      !required.includes(scope.milestoneId),
  );
  const expected = new Set([
    "MILESTONE:" + scope.milestoneId,
    ...required.map((key) => "WORK_ITEM:" + key),
  ]);
  const bindings = new Set<string>();
  const facts = new Set<string>();
  const slots = request.targets
    .map((raw) => {
      const slot = slotSchema.parse(raw);
      const key = slot.targetKind + ":" + slot.targetId;
      valid(expected.delete(key));
      if (slot.binding === null) {
        valid(slot.snapshot === null);
        return { ...slot, snapshot: null };
      }
      const b = slot.binding;
      valid(
        b.customerId === scope.customerId &&
          b.projectId === scope.projectId &&
          b.targetId === slot.targetId &&
          b.targetKind === slot.targetKind &&
          !bindings.has(b.id) &&
          !facts.has(b.factId),
      );
      bindings.add(b.id);
      facts.add(b.factId);
      const snapshot = headerSchema.parse(slot.snapshot);
      valid(
        snapshot.scope.customerId === scope.customerId &&
          snapshot.scope.projectId === scope.projectId &&
          snapshot.scope.factId === b.factId &&
          snapshot.scope.factType === b.factType &&
          snapshot.asOf === asOf,
      );
      return { ...slot, snapshot };
    })
    .sort((a, b) =>
      compare(a.targetKind + a.targetId, b.targetKind + b.targetId),
    );
  valid(expected.size === 0);

  let versions = 0,
    conflicts = 0,
    evidence = 0,
    sources = 0,
    references = 0,
    derived = 0;
  // Length checks across every target precede nested traversal or scalar parsing.
  for (const slot of slots) {
    if (!slot.snapshot) continue;
    versions += slot.snapshot.versions.length;
    conflicts += slot.snapshot.conflicts.length;
    evidence += slot.snapshot.evidence.length;
    sources += slot.snapshot.sources.length;
  }
  if (versions > 1000 || conflicts > 1000 || evidence > 64000 || sources > 1000)
    return incomplete();
  const versionIds = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const slot of slots) {
    if (!slot.snapshot) continue;
    const costs = new Map<string, number>();
    for (const raw of slot.snapshot.versions) {
      const row = record(raw);
      const key = id.parse(row.id);
      valid(!versionIds.has(key));
      versionIds.add(key);
      const deps = array.parse(row.evidenceIds);
      if (deps.length > 64) return incomplete();
      references += deps.length;
      costs.set(key, 1 + deps.length);
      derived += 2 * (1 + deps.length);
    }
    for (const raw of slot.snapshot.evidence) {
      const key = id.parse(record(raw).id);
      valid(!evidenceIds.has(key));
      evidenceIds.add(key);
    }
    for (const raw of slot.snapshot.conflicts) {
      const deps = array.parse(record(raw).versionIds);
      if (deps.length > 64) return incomplete();
      for (const dep of deps) {
        const cost = costs.get(id.parse(dep));
        valid(cost !== undefined);
        derived += cost;
      }
    }
  }
  if (references > 64000 || derived > 64000) return incomplete();
  // Deep shape/state validation is now bounded, including superseded versions.
  const parsed = slots.map((slot) => {
    if (!slot.snapshot) return { ...slot, snapshot: null };
    const snapshot = sourceAuthoritySnapshotSchema.parse(slot.snapshot);
    for (const version of snapshot.versions) {
      valid(version.value.type === "text");
      state.parse(version.value.value);
    }
    return { ...slot, snapshot };
  });
  // Still validate scalar semantics when disabled; never return unchecked facts.
  const evaluations = parsed.map((slot) => ({
    targetKind: slot.targetKind,
    targetId: slot.targetId,
    binding: slot.binding,
    assessment: slot.snapshot ? resolveSourceAuthority(slot.snapshot) : null,
  }));
  if (
    !request.complete ||
    parsed.some((slot) => slot.snapshot?.complete === false)
  )
    return incomplete();
  if (!request.enabled)
    return freeze({ ...envelope, status: "DISABLED" as const });
  if (evaluations.some((row) => row.assessment?.revalidationRequired))
    return freeze({ ...envelope, status: "REVALIDATION_REQUIRED" as const });
  const dependencies = evaluations
    .filter((row) => row.assessment !== null)
    .map((row) => ({
      bindingId: row.binding!.id,
      factId: row.binding!.factId,
      versionIds: row.assessment!.versions.map((version) => version.id),
      evidenceIds: sorted([
        ...new Set(
          row.assessment!.versions.flatMap((version) => [
            ...version.evidenceIds,
          ]),
        ),
      ]),
    }));
  const resolved = evaluations.every(
    (row) =>
      row.assessment?.status === "RESOLVED" &&
      row.assessment.resolvedValue?.value !== "CANCELLED",
  );
  if (!required.length || !resolved)
    return freeze({
      ...envelope,
      status: "UNKNOWN" as const,
      evaluations,
      dependencies,
    });
  const milestone = evaluations.find((row) => row.targetKind === "MILESTONE")!;
  const open = evaluations.filter(
    (row) =>
      row.targetKind === "WORK_ITEM" &&
      ["OPEN", "IN_PROGRESS"].includes(
        String(row.assessment!.resolvedValue!.value),
      ),
  );
  if (milestone.assessment!.resolvedValue!.value !== "COMPLETE" || !open.length)
    return freeze({
      ...envelope,
      status: "NOT_DETECTED" as const,
      evaluations,
      dependencies,
    });
  const contributors = [milestone, ...open].map((row) => ({
    targetKind: row.targetKind,
    targetId: row.targetId,
    bindingId: row.binding!.id,
    factId: row.binding!.factId,
    factType: row.binding!.factType,
    supportingVersionIds: [...row.assessment!.supportingVersionIds],
    supportingEvidenceIds: [...row.assessment!.supportingEvidenceIds],
  }));
  // Version/evidence associations, not just their unions, identify the same case.
  const tuples = [milestone, ...open]
    .flatMap((row) =>
      row.assessment!.supportingVersionIds.map((versionId) => {
        const version = row.assessment!.versions.find(
          (candidate) => candidate.id === versionId,
        )!;
        return [
          row.targetKind,
          row.targetId,
          row.binding!.id,
          row.binding!.factId,
          row.binding!.factType,
          versionId,
          sorted(version.evidenceIds),
        ];
      }),
    )
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const contributorIdentity = JSON.stringify([
    scope.customerId,
    scope.projectId,
    scope.milestoneId,
    ruleRevision,
    tuples,
  ]);
  return freeze({
    ...envelope,
    status: "CONFLICTING" as const,
    evaluations,
    dependencies,
    contributors,
    contributorIdentity,
  });
}
