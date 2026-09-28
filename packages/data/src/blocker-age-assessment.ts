import {
  evaluateBlockerAgeSignals,
  blockerAgeThresholdPolicyViewSchema,
  type Actor,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import { DatabaseAuthorityRepository } from "./authority-persistence.js";
import { hasTrustedBlockerAgeEvidence } from "./blocker-age-proof.js";

type Tx = Prisma.TransactionClient;
type Raid = { id: string; key: string; kind: string; state: string };
type Fact = { id: string; factType: string; revision: number };
type VersionLock = { id: string; factId: string; sourceId: string };
type ConflictLock = { id: string };
type Threshold = {
  minimumBlockerAgeDays: number;
  auditRetentionHours: number;
  revision: number;
  changedBy: string;
  changedAt: Date;
} | null;
type Dependency = { factId: string; sourceId: string };
type Prepared = Awaited<ReturnType<DatabaseAuthorityRepository["prepareAssessmentInTransaction"]>>;
type Resolution = {
  status: string;
  policy?: {
    tiers: { selectors: { validity: { mode?: string } | { basis: string; durationMs: number } | null }[] }[];
  } | null;
  resolvedValue: { type: string; value: unknown } | null;
  supportingVersionIds: string[];
  supportingEvidenceIds: string[];
  versions: {
    id: string;
    visibility?: string;
    provenance?: string;
    sourceType?: string;
    validityMode?: string;
    assessment?: { freshness?: string };
  }[];
};

const unique = (values: string[]) => [...new Set(values)].sort();
const valueReason = (value: unknown) =>
  value && typeof value === "object" && "status" in value
    ? String((value as { status: unknown }).status)
    : "AUTHORITY_UNAVAILABLE";

export function blockerAgeDependencies(inputValue: unknown): Dependency[] | null {
  if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue))
    return [];
  const envelope = inputValue as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(envelope, "blockerAge")) return [];
  const age = envelope.blockerAge;
  if (!age || typeof age !== "object" || Array.isArray(age)) return null;
  const raw = (age as Record<string, unknown>).dependencies;
  if (!Array.isArray(raw)) return null;
  const dependencies = new Map<string, Dependency>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.factId !== "string" ||
      typeof record.sourceId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.factId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.sourceId)
    )
      return null;
    dependencies.set(record.factId + ":" + record.sourceId, {
      factId: record.factId,
      sourceId: record.sourceId,
    });
  }
  return [...dependencies.values()].sort(
    (left, right) =>
      left.factId.localeCompare(right.factId) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}

async function clock(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRawUnsafe<{ now: Date }[]>(
    "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
  );
  if (!rows[0]?.now) throw new Error("Assessment clock unavailable");
  return rows[0].now;
}

function empty(
  asOf: Date,
  reason: string,
  gates: Record<string, boolean>,
  threshold: Threshold,
) {
  const thresholdView = threshold
    ? blockerAgeThresholdPolicyViewSchema.parse({
        minimumBlockerAgeDays: threshold.minimumBlockerAgeDays,
        auditRetentionHours: threshold.auditRetentionHours,
        revision: threshold.revision,
        changedBy: threshold.changedBy,
        changedAt: threshold.changedAt.toISOString(),
      })
    : null;
  return {
    asOf,
    coverage: "UNASSESSABLE" as const,
    input: {
      rule: { key: "blocker-age", revision: "1" },
      asOf: asOf.toISOString(),
      timeZone: "UTC",
      coverage: "UNASSESSABLE",
      reason,
      gates,
      threshold: thresholdView,
      authorityRevisions: [],
      inventoryCompleteness: { status: "UNKNOWN", reason },
      candidates: [],
      dependencies: [],
    },
    result: {
      asOf: asOf.toISOString(),
      timeZone: "UTC",
      ruleRevision: "blocker-age@1",
      thresholdRevision: threshold?.revision ?? null,
      coverage: "UNASSESSABLE",
      noOpenBlockers: null,
      candidateCount: 0,
      assessedBlockerCount: 0,
      unknownCandidateCount: 0,
      agedBlockerCount: 0,
      assessments: [],
    },
    newConflicts: [],
  };
}

export async function buildBlockerAgeAssessmentInTransaction(
  tx: Tx,
  db: Database,
  actor: Actor,
  projectId: string,
  canonicalSealed: boolean,
  threshold: Threshold,
) {
  const thresholdValid = threshold !== null &&
    blockerAgeThresholdPolicyViewSchema.safeParse({
        minimumBlockerAgeDays: threshold.minimumBlockerAgeDays,
        auditRetentionHours: threshold.auditRetentionHours,
        revision: threshold.revision,
        changedBy: threshold.changedBy,
        changedAt: threshold.changedAt.toISOString(),
      }).success;
  if (!canonicalSealed || !thresholdValid) {
    return empty(
      await clock(tx),
      !canonicalSealed ? "CANONICAL_SNAPSHOT_UNAVAILABLE" : "THRESHOLD_NOT_CONFIGURED",
      {
        canonicalSealed,
        raidSnapshotBounded: false,
        inventoryAttested: false,
        thresholdConfigured: thresholdValid,
        sourceHistoryComplete: false,
      },
      thresholdValid ? threshold : null,
    );
  }

  const raids = await tx.$queryRawUnsafe<Raid[]>(
    'SELECT id,key,kind,state FROM public."RaidItem" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND state IN (\'OPEN\',\'IN_PROGRESS\') ORDER BY id LIMIT 51 FOR SHARE',
    actor.customerId,
    projectId,
  );
  if (raids.length > 50) {
    return empty(
      await clock(tx),
      "RAID_SNAPSHOT_OVER_LIMIT",
      {
        canonicalSealed: true,
        raidSnapshotBounded: false,
        inventoryAttested: false,
        thresholdConfigured: true,
        sourceHistoryComplete: false,
      },
      threshold,
    );
  }

  const inventoryType = "project.open_blocker_inventory_complete";
  const requestedTypes = unique([
    inventoryType,
    ...raids.flatMap((raid) => [
      "raid_item." + raid.id.toLowerCase() + ".blocks_delivery",
      "raid_item." + raid.id.toLowerCase() + ".opened_at",
    ]),
  ]);
  const facts = await tx.$queryRawUnsafe<Fact[]>(
    'SELECT id,"factType",revision FROM public."ProjectFact" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factType"=ANY($3::text[]) ORDER BY "factType",id FOR SHARE',
    actor.customerId,
    projectId,
    requestedTypes,
  );
  const factIds = facts.map((fact) => fact.id);
  const versionLocks = factIds.length
    ? await tx.$queryRawUnsafe<VersionLock[]>(
        'SELECT id,"factId","sourceId" FROM public."ProjectFactVersion" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factId"=ANY($3::uuid[]) ORDER BY "factId",revision LIMIT 1001 FOR SHARE',
        actor.customerId,
        projectId,
        factIds,
      )
    : [];
  const conflictLocks = factIds.length
    ? await tx.$queryRawUnsafe<ConflictLock[]>(
        'SELECT id FROM public."FactAuthorityConflict" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factId"=ANY($3::uuid[]) ORDER BY "factId",id LIMIT 1001 FOR SHARE',
        actor.customerId,
        projectId,
        factIds,
      )
    : [];
  await tx.$queryRawUnsafe<{ id: string }[]>(
    'SELECT id FROM public."AuthorityPolicy" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factType"=ANY($3::text[]) ORDER BY "factType",id FOR SHARE',
    actor.customerId,
    projectId,
    requestedTypes,
  );
  const policyRevisionLocks = await tx.$queryRawUnsafe<{ id: string }[]>(
    'SELECT id FROM public."AuthorityPolicyRevision" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factType"=ANY($3::text[]) ORDER BY "factType",revision,id LIMIT 1001 FOR SHARE',
    actor.customerId,
    projectId,
    requestedTypes,
  );
  const sourceIds = unique(versionLocks.map((row) => row.sourceId));
  if (factIds.length && sourceIds.length) {
    await tx.$queryRawUnsafe(
      'SELECT "factId","sourceId" FROM public."FactSourceAccess" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factId"=ANY($3::uuid[]) AND "sourceId"=ANY($4::uuid[]) ORDER BY "factId","sourceId" FOR SHARE',
      actor.customerId,
      projectId,
      factIds,
      sourceIds,
    );
    await tx.$queryRawUnsafe(
      'SELECT "factId","sourceId",subject FROM public."FactSourceReader" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "factId"=ANY($3::uuid[]) AND "sourceId"=ANY($4::uuid[]) AND subject=$5 ORDER BY "factId","sourceId",subject FOR SHARE',
      actor.customerId,
      projectId,
      factIds,
      sourceIds,
      actor.subject,
    );
  }

  const asOf = await clock(tx);
  const overBudget =
    versionLocks.length > 1000 ||
    conflictLocks.length > 1000 ||
    policyRevisionLocks.length > 1000;
  const authority = new DatabaseAuthorityRepository(db);
  const prefixes = overBudget
    ? null
    : await authority.loadAssessmentPrefixesInTransaction(
        tx,
        actor,
        projectId,
        facts,
        asOf,
      );
  if (prefixes === null) {
    return empty(
      asOf,
      "SOURCE_HISTORY_OVER_LIMIT",
      {
        canonicalSealed: true,
        raidSnapshotBounded: true,
        inventoryAttested: false,
        thresholdConfigured: true,
        sourceHistoryComplete: false,
      },
      threshold,
    );
  }

  const factByType = new Map(facts.map((fact) => [fact.factType, fact]));
  const preparedByType = new Map<string, Awaited<ReturnType<
    DatabaseAuthorityRepository["prepareAssessmentInTransaction"]
  >>>();
  const dependencies = new Map<string, Dependency>();
  const authorityRevisions: Record<string, unknown>[] = [];
  const newConflicts = new Map<string, Prepared["newConflicts"][number]>();
  const prepare = async (factType: string) => {
    const fact = factByType.get(factType);
    if (!fact) return null;
    const existing = preparedByType.get(factType);
    if (existing) return existing;
    try {
      const result = await authority.prepareAssessmentInTransaction(
        tx,
        actor,
        {
          projectId,
          fact,
          asOf,
          prefix: prefixes.get(fact.id),
        },
      );
      preparedByType.set(factType, result);
      for (const version of result.versions) {
        dependencies.set(fact.id + ":" + version.sourceId, {
          factId: fact.id,
          sourceId: version.sourceId,
        });
      }
      authorityRevisions.push({
        factId: fact.id,
        factType,
        factRevision: fact.revision,
        policyId: result.aggregate?.id ?? null,
        policyThroughRevision: result.aggregate?.revision ?? null,
        policyRevisionId: result.event?.id ?? null,
        policyRevision: result.event?.revision ?? null,
      });
      for (const conflict of result.newConflicts)
        newConflicts.set(conflict.id, conflict);
      return result;
    } catch {
      return null;
    }
  };
  const proof = async (
    factType: string,
    expectedType: "boolean" | "date",
    requireOpenedPeriod: boolean,
  ) => {
    const prepared = await prepare(factType);
    if (!prepared)
      return {
        status: "UNKNOWN" as const,
        reason: factByType.has(factType) ? "AUTHORITY_UNAVAILABLE" : "FACT_MISSING",
        value: null,
        factId: factByType.get(factType)?.id ?? null,
        versionIds: [],
        evidenceIds: [],
      };
    const result = prepared.result as unknown as Resolution;
    if (
      result.status !== "RESOLVED" ||
      !result.resolvedValue ||
      result.resolvedValue.type !== expectedType
    )
      return {
        status: "UNKNOWN" as const,
        reason: result.status === "RESOLVED" ? "VALUE_TYPE_MISMATCH" : valueReason(result),
        value: null,
        factId: prepared.fact.id,
        versionIds: [],
        evidenceIds: [],
      };
    if (
      !hasTrustedBlockerAgeEvidence(result, factType, requireOpenedPeriod)
    )
      return {
        status: "UNKNOWN" as const,
        reason: "SOURCE_AUTHORITY_NOT_CURRENT",
        value: null,
        factId: prepared.fact.id,
        versionIds: [],
        evidenceIds: [],
      };
    const evidenceIds = unique(result.supportingEvidenceIds);
    return {
      status: "RESOLVED" as const,
      reason: null,
      value: result.resolvedValue.value,
      factId: prepared.fact.id,
      versionIds: result.supportingVersionIds,
      evidenceIds,
    };
  };

  const inventory = await proof(inventoryType, "boolean", false);
  const inventoryAttested =
    inventory.status === "RESOLVED" && inventory.value === true;
  const candidates: Record<string, unknown>[] = [];
  const assessedInputs: {
    raid: Raid;
    openedAt: Awaited<ReturnType<typeof proof>>;
  }[] = [];
  let unknownCandidateCount = 0;
  for (const raid of raids) {
    const classificationType =
      "raid_item." + raid.id.toLowerCase() + ".blocks_delivery";
    const classification = await proof(classificationType, "boolean", false);
    let openedAt: Awaited<ReturnType<typeof proof>> | null = null;
    let outcome: string;
    let reason = classification.reason;
    if (classification.status !== "RESOLVED") {
      outcome = "UNKNOWN_CLASSIFICATION";
      unknownCandidateCount++;
    } else if (classification.value === false) {
      outcome = "EXCLUDED";
      reason = null;
    } else if (classification.value !== true) {
      outcome = "UNKNOWN_CLASSIFICATION";
      reason = "VALUE_TYPE_MISMATCH";
      unknownCandidateCount++;
    } else {
      const openedType =
        "raid_item." + raid.id.toLowerCase() + ".opened_at";
      openedAt = await proof(openedType, "date", true);
      if (openedAt.status !== "RESOLVED") {
        outcome = "UNASSESSABLE_OPENED_AT";
        reason = openedAt.reason;
        unknownCandidateCount++;
      } else if (
        typeof openedAt.value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(openedAt.value) ||
        openedAt.value > asOf.toISOString().slice(0, 10)
      ) {
        outcome = "UNASSESSABLE_OPENED_AT";
        reason =
          typeof openedAt.value === "string" &&
          openedAt.value > asOf.toISOString().slice(0, 10)
            ? "FUTURE_OPENED_AT"
            : "INVALID_OPENED_AT";
        unknownCandidateCount++;
      } else {
        outcome = "PENDING_AGE_ASSESSMENT";
        assessedInputs.push({ raid, openedAt });
        reason = null;
      }
    }
    candidates.push({
      raidItemId: raid.id,
      key: raid.key,
      kind: raid.kind,
      state: raid.state,
      classification: {
        status: classification.status,
        value:
          classification.status === "RESOLVED"
            ? classification.value
            : null,
        factId: classification.factId,
        versionIds: classification.versionIds,
        evidenceIds: classification.evidenceIds,
        reason: classification.reason,
      },
      openedAt: openedAt
        ? {
            status: openedAt.status,
            value: openedAt.status === "RESOLVED" ? openedAt.value : null,
            factId: openedAt.factId,
            versionIds: openedAt.versionIds,
            evidenceIds: openedAt.evidenceIds,
            reason: openedAt.reason,
          }
        : null,
      outcome,
      reason,
    });
  }

  const signalInput = evaluateBlockerAgeSignals({
    asOf: asOf.toISOString(),
    timeZone: "UTC",
    blockerReadComplete: true,
    threshold: {
      ruleKey: "blocker-age",
      ruleRevision: "1",
      minimumBlockerAgeDays: threshold!.minimumBlockerAgeDays,
    },
    blockers: assessedInputs.map(({ raid, openedAt }) => ({
      targetType: "RAID_ITEM" as const,
      targetKey: raid.key,
      state: raid.state as "OPEN" | "IN_PROGRESS",
      sourceDate: openedAt.value as string,
      sourceDateField: "opened_at",
      source: { kind: "canonical_field" as const },
    })),
  });
  const ageByKey = new Map(
    signalInput.assessments.map((assessment) => [
      assessment.targetKey,
      assessment,
    ]),
  );
  for (const candidate of candidates) {
    if (candidate.outcome === "PENDING_AGE_ASSESSMENT") {
      const age = ageByKey.get(String(candidate.key));
      if (!age) throw new Error("Blocker age result missing");
      candidate.outcome = age.status;
      candidate.age = age.ageDays;
      candidate.thresholdExceeded = age.thresholdExceeded;
    }
  }

  const assessedBlockerCount = signalInput.assessments.filter(
    (item) =>
      item.status === "AGED" || item.status === "WITHIN_THRESHOLD",
  ).length;
  const agedBlockerCount = signalInput.assessments.filter(
    (item) => item.status === "AGED",
  ).length;
  const gates = {
    canonicalSealed: true,
    raidSnapshotBounded: true,
    inventoryAttested,
    thresholdConfigured: true,
    sourceHistoryComplete: true,
  };
  const coverage =
    !inventoryAttested
      ? "UNASSESSABLE"
      : unknownCandidateCount === 0
        ? "COMPLETE"
        : assessedBlockerCount > 0
          ? "PARTIAL"
          : "UNASSESSABLE";
  const thresholdView = blockerAgeThresholdPolicyViewSchema.parse({
    minimumBlockerAgeDays: threshold!.minimumBlockerAgeDays,
    auditRetentionHours: threshold!.auditRetentionHours,
    revision: threshold!.revision,
    changedBy: threshold!.changedBy,
    changedAt: threshold!.changedAt.toISOString(),
  });
  const dependencyList = [...dependencies.values()].sort(
    (left, right) =>
      left.factId.localeCompare(right.factId) ||
      left.sourceId.localeCompare(right.sourceId),
  );
  const input = {
    rule: { key: "blocker-age", revision: "1" },
    asOf: asOf.toISOString(),
    timeZone: "UTC",
    coverage,
    gates,
    threshold: thresholdView,
    authorityRevisions,
    inventoryCompleteness: {
      status: inventory.status,
      value: inventory.status === "RESOLVED" ? inventory.value : null,
      factId: inventory.factId,
      versionIds: inventory.versionIds,
      evidenceIds: inventory.evidenceIds,
      reason: inventory.reason,
    },
    candidateCount: raids.length,
    candidates,
    dependencies: dependencyList,
  };
  const result = {
    asOf: asOf.toISOString(),
    timeZone: "UTC",
    ruleRevision: "blocker-age@1",
    thresholdRevision: threshold!.revision,
    minimumBlockerAgeDays: threshold!.minimumBlockerAgeDays,
    coverage,
    noOpenBlockers:
      coverage === "COMPLETE" ? assessedBlockerCount === 0 : null,
    candidateCount: raids.length,
    assessedBlockerCount,
    unknownCandidateCount,
    agedBlockerCount,
    assessments: signalInput.assessments,
  };
  return {
    asOf,
    coverage,
    input,
    result,
    newConflicts: [...newConflicts.values()],
  };
}
