import { z } from "zod";
import { assessFact, provenanceSchema } from "./fact-state.js";

// FR-EVD-001/002/003/004/006/007/010/012. Internal temporal computation only:
// callers must provide complete, currently authorized evidence dependencies.
// This is neither source authority selection nor a public authorization boundary.
// PostgreSQL UUID equality is case-insensitive; never create separate temporal
// streams or duplicate identities through alternative textual representations.
const id = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const instant = z
  .string()
  .length(24)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(time) &&
      new Date(time).toISOString() === value
    );
  });
const calendarDate = z
  .string()
  .length(10)
  .refine((value) => {
    const time = Date.parse(value + "T00:00:00.000Z");
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  });
const factType = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/);
const scopeSchema = z
  .object({
    customerId: id,
    projectId: id,
    factId: id,
    factType,
  })
  .strict();
const valueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string().max(4096) }).strict(),
  z.object({ type: z.literal("number"), value: z.number().finite() }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ type: z.literal("date"), value: calendarDate }).strict(),
  z.object({ type: z.literal("empty"), value: z.null() }).strict(),
]);
const versionSchema = z
  .object({
    id,
    scope: scopeSchema,
    source: z
      .object({
        instanceId: id,
        recordType: z.string().min(1).max(96),
        recordId: z.string().min(1).max(256),
        revision: z.string().min(1).max(128),
      })
      .strict(),
    value: valueSchema,
    provenance: provenanceSchema,
    effectiveAt: instant,
    observedAt: instant,
    validUntil: instant.nullable(),
    evidenceIds: z.array(id).min(1).max(64),
  })
  .strict();

export const temporalFactSnapshotSchema = z
  .object({
    scope: scopeSchema,
    asOf: instant,
    validityPolicy: z
      .object({
        revisionId: id,
        customerId: id,
        projectId: id,
        factType,
        validity: z
          .object({
            basis: z.enum(["effectiveAt", "observedAt"]),
            durationMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    versions: z.array(versionSchema).max(1000),
    conflicts: z
      .array(
        z
          .object({
            id,
            scope: scopeSchema,
            versionIds: z.array(id).min(2).max(64),
            detectedAt: instant,
            resolvedAt: instant.nullable(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type TemporalFactSnapshot = z.infer<typeof temporalFactSnapshotSchema>;
type Version = TemporalFactSnapshot["versions"][number];
type Applicability =
  | "NOT_YET_OBSERVED"
  | "NOT_YET_EFFECTIVE"
  | "SUPERSEDED"
  | "AMBIGUOUS"
  | "APPLICABLE";
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
  if (!condition) throw new Error("Invalid temporal fact snapshot");
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const streamKey = (v: Version) =>
  JSON.stringify([v.source.instanceId, v.source.recordType, v.source.recordId]);
const scopeKey = (s: TemporalFactSnapshot["scope"]) =>
  JSON.stringify([s.customerId, s.projectId, s.factId, s.factType]);

/**
 * Assess an explicit historical snapshot, never an authoritative current claim.
 * Zod detaches the complete typed input; deeply frozen output retains evidence
 * dependencies and policy/as-of pins. Delivery must recheck access even for a
 * previously authorized assessment. No persisted version or conflict is changed.
 */
export function assessTemporalFactHistory(input: unknown) {
  const parsed = temporalFactSnapshotSchema.safeParse(input);
  requireValid(parsed.success);
  const snapshot = parsed.data;
  const { scope, validityPolicy, asOf } = snapshot;
  requireValid(
    validityPolicy.customerId === scope.customerId &&
      validityPolicy.projectId === scope.projectId &&
      validityPolicy.factType === scope.factType,
  );
  const versions = [...snapshot.versions].sort((a, b) => compare(a.id, b.id));
  const byId = new Map<string, Version>();
  const revisions = new Set<string>();
  const streams = new Map<string, Version[]>();
  const applicability = new Map<string, Applicability>();
  for (const version of versions) {
    requireValid(scopeKey(version.scope) === scopeKey(scope));
    requireValid(!byId.has(version.id));
    requireValid(
      new Set(version.evidenceIds).size === version.evidenceIds.length,
    );
    requireValid(
      version.validUntil === null || version.validUntil >= version.effectiveAt,
    );
    const revisionKey = JSON.stringify([
      streamKey(version),
      version.source.revision,
    ]);
    requireValid(!revisions.has(revisionKey));
    byId.set(version.id, version);
    revisions.add(revisionKey);
    if (version.observedAt > asOf)
      applicability.set(version.id, "NOT_YET_OBSERVED");
    else if (version.effectiveAt > asOf)
      applicability.set(version.id, "NOT_YET_EFFECTIVE");
    else {
      const key = streamKey(version);
      const group = streams.get(key) ?? [];
      group.push(version);
      streams.set(key, group);
    }
  }

  const ambiguousStreams: {
    instanceId: string;
    recordType: string;
    recordId: string;
    versionIds: string[];
  }[] = [];
  for (const group of streams.values()) {
    group.sort(
      (a, b) =>
        compare(b.effectiveAt, a.effectiveAt) ||
        compare(b.observedAt, a.observedAt) ||
        compare(a.id, b.id),
    );
    const latest = group[0]!;
    const tied = group.filter(
      (v) =>
        v.effectiveAt === latest.effectiveAt &&
        v.observedAt === latest.observedAt,
    );
    for (const version of group) {
      applicability.set(
        version.id,
        !tied.includes(version)
          ? "SUPERSEDED"
          : tied.length > 1
            ? "AMBIGUOUS"
            : "APPLICABLE",
      );
    }
    if (tied.length > 1)
      ambiguousStreams.push({
        instanceId: latest.source.instanceId,
        recordType: latest.source.recordType,
        recordId: latest.source.recordId,
        versionIds: tied.map((v) => v.id).sort(compare),
      });
  }
  ambiguousStreams.sort((a, b) =>
    compare(
      JSON.stringify([a.instanceId, a.recordType, a.recordId]),
      JSON.stringify([b.instanceId, b.recordType, b.recordId]),
    ),
  );

  const conflictIds = new Set<string>();
  const activeByVersion = new Map<string, string[]>();
  for (const conflict of snapshot.conflicts) {
    requireValid(scopeKey(conflict.scope) === scopeKey(scope));
    requireValid(!conflictIds.has(conflict.id));
    conflictIds.add(conflict.id);
    requireValid(
      new Set(conflict.versionIds).size === conflict.versionIds.length,
    );
    requireValid(
      conflict.resolvedAt === null ||
        conflict.resolvedAt >= conflict.detectedAt,
    );
    for (const versionId of conflict.versionIds) {
      const version = byId.get(versionId);
      requireValid(version !== undefined);
      requireValid(
        conflict.detectedAt >= version.observedAt &&
          conflict.detectedAt >= version.effectiveAt,
      );
      if (
        conflict.detectedAt <= asOf &&
        (conflict.resolvedAt === null || asOf < conflict.resolvedAt)
      ) {
        const active = activeByVersion.get(versionId) ?? [];
        active.push(conflict.id);
        activeByVersion.set(versionId, active);
      }
    }
  }

  const assessed = versions.map((version) => {
    const expiries: string[] =
      version.validUntil === null ? [] : [version.validUntil];
    if (validityPolicy.validity !== null) {
      const { basis, durationMs } = validityPolicy.validity;
      const expiry = Date.parse(version[basis]) + durationMs;
      requireValid(Number.isSafeInteger(expiry) && Math.abs(expiry) <= 8.64e15);
      const formatted = new Date(expiry).toISOString();
      requireValid(instant.safeParse(formatted).success);
      expiries.push(formatted);
    }
    // Neither an explicit deadline nor a policy may extend the other's validity.
    const validUntil = expiries.sort(compare)[0] ?? null;
    const temporalApplicability = applicability.get(version.id)!;
    const known =
      temporalApplicability !== "NOT_YET_OBSERVED" &&
      temporalApplicability !== "NOT_YET_EFFECTIVE";
    const unresolvedConflictIds = (activeByVersion.get(version.id) ?? []).sort(
      compare,
    );
    return {
      ...version,
      evidenceIds: [...version.evidenceIds].sort(compare),
      temporalApplicability,
      assessedValidUntil: validUntil,
      unresolvedConflictIds,
      assessment: assessFact(
        {
          provenance: version.provenance,
          validUntil: known ? validUntil : null,
          conflicting: unresolvedConflictIds.length > 0,
        },
        new Date(asOf),
      ),
    };
  });
  return freeze({
    scope,
    asOf,
    validityPolicy,
    versions: assessed,
    applicableVersionIds: assessed
      .filter((v) => v.temporalApplicability === "APPLICABLE")
      .map((v) => v.id),
    ambiguousStreams,
    conflicts: [...snapshot.conflicts]
      .sort((a, b) => compare(a.id, b.id))
      .map((c) => ({ ...c, versionIds: [...c.versionIds].sort(compare) })),
  });
}
