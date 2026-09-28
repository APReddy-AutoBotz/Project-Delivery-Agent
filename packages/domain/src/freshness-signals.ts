import { z } from "zod";
import {
  canonicalKeySchema,
  canonicalSubjectSchema,
} from "./canonical-project.js";

// FR-HLT-001 / FR-UPD-001 / AC-HLT-001: internal deterministic calculation.
// Callers must provide an authorized, eligible project, its latest valid update
// time, and the already-resolved obligation policy. This module returns an
// obligation descriptor for persistence by the later update workflow; it does
// not persist facts, send requests, or perform external side effects.
const instant = z
  .string()
  .length(24)
  .refine((value) => {
    const time = Date.parse(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number(value.slice(0, 4)) >= 1 &&
      Number.isFinite(time) &&
      new Date(time).toISOString() === value
    );
  });
const safeText = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) =>
      value.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(value),
  );
const revision = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const requiredFact = z.strictObject({
  factType: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  label: safeText,
});
const project = z.strictObject({
  id: z.uuid(),
  code: canonicalKeySchema,
  name: safeText,
  createdAt: instant,
  latestValidUpdateAt: instant.nullable(),
});
const policy = z.strictObject({
  key: canonicalKeySchema,
  revision,
  freshnessWindowSeconds: z.number().int().min(1).max(315360000),
  responsibleSubject: canonicalSubjectSchema,
  obligationDueAt: instant,
  requiredFacts: z.array(requiredFact).max(100),
});
const requestSchema = z
  .strictObject({
    asOf: instant,
    timeZone: z.string().min(1).max(64),
    timeZoneSource: z.enum(["RECIPIENT", "PROJECT", "CUSTOMER"]),
    project,
    policy,
  })
  .strict();
export type FreshnessAssessmentInput = z.input<typeof requestSchema>;
export type RequiredUpdateFact = z.infer<typeof requiredFact>;
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
function invalid(): never {
  throw new Error("Invalid freshness assessment input");
}
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Assess one configured project's update freshness at an explicit instant.
 * A project becomes stale only when elapsed age is strictly greater than the
 * policy window. When stale, the returned descriptor is suitable for an
 * idempotent caller-owned obligation write. The freshness window uses elapsed
 * seconds; timeZone is retained for the obligation workflow and explanation.
 */
export function assessUpdateFreshness(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const request = parsed.data;
  const asOfTime = Date.parse(request.asOf);
  const createdTime = Date.parse(request.project.createdAt);
  const updateTime =
    request.project.latestValidUpdateAt === null
      ? null
      : Date.parse(request.project.latestValidUpdateAt);
  // Canonical row creation is a storage timestamp, not project inception.
  // A trusted source update may predate it; only future timestamps are invalid.
  if (
    createdTime > asOfTime ||
    (updateTime !== null && updateTime > asOfTime)
  )
    return invalid();
  const required = [...request.policy.requiredFacts].sort((left, right) =>
    compare(left.factType, right.factType),
  );
  if (new Set(required.map((fact) => fact.factType)).size !== required.length)
    return invalid();
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: request.timeZone,
    }).format(new Date(asOfTime));
  } catch {
    return invalid();
  }
  const sourceDateField =
    updateTime === null ? "project.createdAt" : "project.latestValidUpdateAt";
  const sourceDate =
    request.project.latestValidUpdateAt ?? request.project.createdAt;
  const ageMilliseconds = asOfTime - Date.parse(sourceDate);
  const freshnessWindowMilliseconds =
    request.policy.freshnessWindowSeconds * 1000;
  const stale = ageMilliseconds > freshnessWindowMilliseconds;
  const freshness = {
    state: stale ? ("STALE" as const) : ("CURRENT" as const),
    sourceDateField,
    sourceDate,
    ageMilliseconds,
    freshnessWindowSeconds: request.policy.freshnessWindowSeconds,
    exceededByMilliseconds: Math.max(
      0,
      ageMilliseconds - freshnessWindowMilliseconds,
    ),
    policyKey: request.policy.key,
    ruleRevision: request.policy.revision,
    assessedAt: request.asOf,
    timeZone: request.timeZone,
    timeZoneSource: request.timeZoneSource,
  };
  const obligation = stale
    ? {
        kind: "PROJECT_UPDATE" as const,
        deduplicationKey: JSON.stringify([
          "PROJECT_UPDATE",
          request.project.id,
          request.policy.key,
          request.policy.revision,
          sourceDateField,
          sourceDate,
          request.policy.obligationDueAt,
        ]),
        reason:
          updateTime === null
            ? ("NO_VALID_UPDATE" as const)
            : ("UPDATE_OUTSIDE_FRESHNESS_WINDOW" as const),
        project: {
          id: request.project.id,
          code: request.project.code,
          name: request.project.name,
        },
        responsibleSubject: request.policy.responsibleSubject,
        requiredFacts: required,
        dueAt: request.policy.obligationDueAt,
        timeZone: request.timeZone,
        timeZoneSource: request.timeZoneSource,
        freshness,
      }
    : null;
  return freeze({
    asOf: request.asOf,
    project: {
      id: request.project.id,
      code: request.project.code,
      name: request.project.name,
    },
    freshness,
    obligation,
  });
}
