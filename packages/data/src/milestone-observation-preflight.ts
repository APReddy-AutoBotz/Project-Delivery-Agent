import type { Prisma } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
type CanonicalCounts = {
  sealed: boolean;
  responsibilitiesCount: number; sprintsCount: number; milestonesCount: number;
  workItemsCount: number; requiredWorkItemsCount: number; raidItemsCount: number;
  sourceMappingsCount: number;
  responsibilitiesActual: number; sprintsActual: number; milestonesActual: number;
  workItemsActual: number; requiredWorkItemsActual: number; raidItemsActual: number;
  sourceMappingsActual: number; projectReceipt: boolean; programmeReceipt: boolean;
};

// Call only after the caller has authenticated and locked the scoped Project
// and a token-compatible grant. This metadata check does not authorize a user,
// validate the native project proof, or guarantee bounded database scan time.
// It is not wired into an endpoint by itself.
export async function preflightMilestoneCanonicalProject(
  tx: Tx, customerId: string, projectId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<CanonicalCounts[]>`
    SELECT p.sealed, p."responsibilitiesCount", p."sprintsCount", p."milestonesCount",
      p."workItemsCount", p."requiredWorkItemsCount", p."raidItemsCount", p."sourceMappingsCount",
      (SELECT count(*)::int FROM (SELECT 1 FROM public."ProjectResponsibility" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id LIMIT 51) q) AS "responsibilitiesActual",
      (SELECT count(*)::int FROM (SELECT 1 FROM public."Sprint" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id LIMIT 51) q) AS "sprintsActual",
      (SELECT count(*)::int FROM (SELECT 1 FROM public."Milestone" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id LIMIT 51) q) AS "milestonesActual",
      (SELECT count(*)::int FROM (SELECT 1 FROM public."WorkItem" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id LIMIT 51) q) AS "workItemsActual",
      (SELECT count(*)::int FROM (SELECT 1 FROM public."RequiredWorkItem" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id LIMIT 51) q) AS "requiredWorkItemsActual",
      (SELECT count(*)::int FROM (SELECT 1 FROM public."RaidItem" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id LIMIT 51) q) AS "raidItemsActual",
      (SELECT count(*)::int FROM (SELECT 1 FROM public."CanonicalSourceMapping" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id LIMIT 51) q) AS "sourceMappingsActual",
      EXISTS (SELECT 1 FROM public."CanonicalCreationReceipt" r WHERE r."projectId"=p.id AND r."customerId"=p."customerId"
        AND r."portfolioId"=p."portfolioId" AND r.subject=p."createdBy" AND r.operation='PROJECT') AS "projectReceipt",
      (p."programmeId" IS NULL OR EXISTS (SELECT 1 FROM public."Programme" g
        JOIN public."CanonicalCreationReceipt" r ON r."programmeId"=g.id AND r."customerId"=g."customerId" AND r."portfolioId"=g."portfolioId"
        WHERE g.id=p."programmeId" AND g."customerId"=p."customerId" AND g."portfolioId"=p."portfolioId"
          AND r.operation='PROGRAMME' AND r.subject=g."createdBy")) AS "programmeReceipt"
    FROM public."CanonicalProject" p WHERE p."customerId"=${customerId}::uuid AND p.id=${projectId}::uuid`;
  if (rows.length !== 1 || rows[0]!.sealed !== true || rows[0]!.projectReceipt !== true || rows[0]!.programmeReceipt !== true) return false;
  const row = rows[0]!;
  const pairs = [[row.responsibilitiesCount, row.responsibilitiesActual], [row.sprintsCount, row.sprintsActual],
    [row.milestonesCount, row.milestonesActual], [row.workItemsCount, row.workItemsActual],
    [row.requiredWorkItemsCount, row.requiredWorkItemsActual], [row.raidItemsCount, row.raidItemsActual],
    [row.sourceMappingsCount, row.sourceMappingsActual]];
  return pairs.every(([declared, actual]) => Number.isInteger(declared) && declared! >= 0 && declared! <= 50 && declared === actual) &&
    pairs.reduce((sum, [declared]) => sum + declared!, 0) <= 200;
}

type VersionMetadata = {
  id: string; customerId: string; projectId: string; factId: string;
  revision: number; evidenceId: string; sourceId: string; valueBytes: number;
};

// The caller must authenticate, hold the project/grant writer fence, check the
// actual fact and binding and compare this complete metadata with the later
// loaded snapshot. This admits materialization; it is not proof of access,
// validity or bounded SQL scan/decompression work.
export async function preflightMilestoneFactVersions(
  tx: Tx, scope: { customerId: string; projectId: string; factId: string; revision: number },
): Promise<VersionMetadata[] | null> {
  if (!Number.isInteger(scope.revision) || scope.revision < 1 || scope.revision > 1000) return null;
  const versions = await tx.$queryRaw<VersionMetadata[]>`
    SELECT id,"customerId","projectId","factId",revision,"evidenceId","sourceId",
      octet_length(value::text)::int AS "valueBytes"
    FROM public."ProjectFactVersion" WHERE "factId"=${scope.factId}::uuid
    ORDER BY revision,id LIMIT 1001`;
  if (versions.length !== scope.revision) return null;
  const versionIds = new Set<string>(), evidenceIds = new Set<string>();
  let bytes = 0;
  for (const [index, version] of versions.entries()) {
    if (version.customerId !== scope.customerId || version.projectId !== scope.projectId ||
        version.factId !== scope.factId || version.revision !== index + 1 ||
        typeof version.id !== "string" || !version.id || versionIds.has(version.id) ||
        typeof version.evidenceId !== "string" || !version.evidenceId || evidenceIds.has(version.evidenceId) ||
        typeof version.sourceId !== "string" || !version.sourceId ||
        !Number.isSafeInteger(version.valueBytes) || version.valueBytes <= 0) return null;
    versionIds.add(version.id); evidenceIds.add(version.evidenceId);
    bytes += version.valueBytes;
    if (bytes > 1_048_576) return null;
  }
  return versions;
}

// Admission for the unranked path additionally requires actual policy and
// conflict absence. The caller must recheck head and absence under a proven
// writer fence, verify every historical source's current access and validate
// the stored graph and temporal proof before presentation. A null result means
// unavailable, never evidence that there is no disagreement.
export async function preflightUnrankedFactPrefix(
  tx: Tx, scope: { customerId: string; projectId: string; factId: string; factType: string; revision: number },
): Promise<VersionMetadata[] | null> {
  const versions = await preflightMilestoneFactVersions(tx, scope);
  if (!versions) return null;
  const policies = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public."AuthorityPolicy"
    WHERE "customerId"=${scope.customerId}::uuid AND "projectId"=${scope.projectId}::uuid
      AND "factType"=${scope.factType} LIMIT 1`;
  if (policies.length !== 0) return null;
  const conflicts = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public."FactAuthorityConflict" WHERE "factId"=${scope.factId}::uuid LIMIT 1`;
  if (conflicts.length !== 0) return null;
  return versions;
}

// This comparison is necessary after materialization but does not authorize the
// sources, validate evidence content, or recheck the fact head/policy fences.
export function matchesUnrankedFactPrefix(
  expected: readonly VersionMetadata[],
  loaded: readonly Pick<VersionMetadata, "id" | "customerId" | "projectId" | "factId" | "revision" | "sourceId" | "evidenceId">[],
): boolean {
  if (expected.length === 0 || expected.length !== loaded.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (!Object.hasOwn(expected, index) || !Object.hasOwn(loaded, index)) return false;
    const version = expected[index];
    const actual = loaded[index];
    if (!version || !actual || actual.id !== version.id || actual.customerId !== version.customerId ||
        actual.projectId !== version.projectId || actual.factId !== version.factId || actual.revision !== version.revision ||
        actual.sourceId !== version.sourceId || actual.evidenceId !== version.evidenceId) return false;
  }
  return true;
}

type PolicyMetadata = {
  id: string; customerId: string; projectId: string; policyId: string; factType: string;
  revision: number; state: string; definitionBytes: number | null;
};

// Equal-tier policy admission only. The caller must first authorize and fence
// writers, establish the actual aggregate/head, then later compare all loaded
// identities, validate the native history and select the as-of event. SQL NULL
// is kept distinct from JSON null. Byte limits do not bound SQL work.
export async function preflightMilestonePolicyHistory(
  tx: Tx, scope: { customerId: string; projectId: string; policyId: string; factType: string; revision: number },
): Promise<PolicyMetadata[] | null> {
  if (!Number.isInteger(scope.revision) || scope.revision < 1 || scope.revision > 1000) return null;
  const policies = await tx.$queryRaw<PolicyMetadata[]>`
    SELECT id,"customerId","projectId","policyId","factType",revision,state,
      CASE WHEN definition IS NULL THEN NULL ELSE octet_length(definition::text)::int END AS "definitionBytes"
    FROM public."AuthorityPolicyRevision" WHERE "policyId"=${scope.policyId}::uuid
    ORDER BY revision,id LIMIT 1001`;
  if (policies.length !== scope.revision) return null;
  const ids = new Set<string>();
  let bytes = 0;
  for (const [index, policy] of policies.entries()) {
    if (policy.customerId !== scope.customerId || policy.projectId !== scope.projectId ||
        policy.policyId !== scope.policyId || policy.factType !== scope.factType || policy.revision !== index + 1 ||
        typeof policy.id !== "string" || !policy.id || ids.has(policy.id)) return null;
    if (policy.state === "DISABLED") {
      if (policy.definitionBytes !== null) return null;
    } else if (policy.state === "ENABLED") {
      if (!Number.isSafeInteger(policy.definitionBytes) || policy.definitionBytes! <= 0) return null;
      bytes += policy.definitionBytes!;
      if (bytes > 4_194_304) return null;
    } else return null;
    ids.add(policy.id);
  }
  return policies;
}

// This identity comparison relies on the caller's immutable-row/writer fence;
// it does not compare definition contents or determine the applicable event.
export function matchesMilestonePolicyHistory(
  expected: readonly PolicyMetadata[],
  loaded: readonly Pick<PolicyMetadata, "id" | "customerId" | "projectId" | "policyId" | "factType" | "revision" | "state">[],
): boolean {
  if (expected.length === 0 || expected.length !== loaded.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (!Object.hasOwn(expected, index) || !Object.hasOwn(loaded, index)) return false;
    const policy = expected[index], actual = loaded[index];
    if (!policy || !actual || actual.id !== policy.id || actual.customerId !== policy.customerId ||
        actual.projectId !== policy.projectId || actual.policyId !== policy.policyId || actual.factType !== policy.factType ||
        actual.revision !== policy.revision || actual.state !== policy.state) return false;
  }
  return true;
}
