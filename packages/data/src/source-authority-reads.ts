import type { Actor, VerifiedSourceKind } from "@pdaa/domain";
import type { Prisma } from "./generated/prisma/client.js";

export type SourceOrigin = {
  versionId: string;
  sourceKind: VerifiedSourceKind;
  streamId: string;
  sourceRevisionId: string;
  admittedAt: Date;
  authorized: boolean;
};

// The caller holds the project's authorization lock until delivery completes.
export async function readSourceOrigins(
  tx: Prisma.TransactionClient,
  actor: Actor,
  projectId: string,
  versionIds: string[],
) {
  if (!versionIds.length) return new Map<string, SourceOrigin>();
  const rows = await tx.$queryRaw<SourceOrigin[]>`
    SELECT * FROM public.read_source_authority_origins(
      ${actor.customerId}::uuid,${projectId}::uuid,${actor.subject},${actor.roles}::text[],${versionIds}::uuid[])
  `;
  return new Map(rows.map((row) => [row.versionId, row]));
}

export function sourceOriginReference(instanceId: string, origin: SourceOrigin) {
  return {
    instanceId,
    recordType: origin.sourceKind,
    recordId: origin.streamId,
    revision: origin.sourceRevisionId,
  };
}

export async function assessmentDependenciesReadable(
  tx: Prisma.TransactionClient,
  actor: Actor,
  projectId: string,
  versions: { id: string; factId: string; sourceId: string; provenance: string }[],
) {
  if (!versions.length) return true;
  const sources = await tx.factSourceAccess.findMany({
    where: {
      customerId: actor.customerId,
      projectId,
      sourceId: { in: [...new Set(versions.map(({ sourceId }) => sourceId))] },
      state: "AVAILABLE",
    },
    select: { sourceId: true, factId: true, readers: { where: { subject: actor.subject } } },
  });
  const allowed = new Map(sources.filter((source) => source.readers.length === 1).map((source) => [source.sourceId, source.factId]));
  if (versions.some(({ sourceId, factId }) => allowed.get(sourceId) !== factId)) return false;
  const sourceVersions = versions.filter(({ provenance }) => provenance === "SYSTEM_VERIFIED").map(({ id }) => id);
  const origins = await readSourceOrigins(tx, actor, projectId, sourceVersions);
  return sourceVersions.every((id) => origins.get(id)?.authorized === true);
}
