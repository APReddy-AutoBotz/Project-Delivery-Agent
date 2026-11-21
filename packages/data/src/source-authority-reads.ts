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
