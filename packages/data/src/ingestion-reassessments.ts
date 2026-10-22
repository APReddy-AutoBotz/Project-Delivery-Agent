// EXEC-019 / AC-CON-004: identifiers-only connector causes; no proposal values.
import { randomUUID } from "node:crypto";
import { ProjectUpdateError, type Actor } from "@pdaa/domain";
import type { Prisma } from "./generated/prisma/client.js";

export type ReassessmentTx = Prisma.TransactionClient;
export type ReassessmentCause = {
  id: string; customerId: string; sourceId: string; receiptId: string; projectId: string;
  configRevision: number; mappingRevision: number; createdAt: Date; state: string;
  attemptCount: number; totalAttempts: number; recoveryRevision: number;
  availableAt: Date; lastReason: string; claimedGeneration: number | null;
  assessmentId: string | null; obligationId: string | null; previewId: string | null;
  completedAt: Date | null; auditEventId: string;
};

export async function reassessmentNow(tx: ReassessmentTx): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`
    SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
  if (!row) throw new ProjectUpdateError("UNAVAILABLE");
  return row.now;
}

export async function reassessmentAudit(
  tx: ReassessmentTx,
  cause: Pick<ReassessmentCause, "id" | "customerId" | "projectId" | "sourceId" | "receiptId">,
  actor: string,
  event: "queued" | "claimed" | "completed" | "failed" | "blocked" | "contention" | "retried",
  detail: Record<string, string | number | null>,
  at: Date,
  correlationId: string = randomUUID(),
): Promise<string> {
  const id = randomUUID();
  const payload = JSON.stringify({
    ...detail,
    causeId: cause.id, projectId: cause.projectId,
    sourceId: cause.sourceId, receiptId: cause.receiptId,
  });
  await tx.$executeRaw`
    INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
    VALUES (${id}::uuid,${cause.customerId}::uuid,${actor},${"ingestion.reassessment." + event},${correlationId},${payload}::jsonb,${at})`;
  return id;
}

export async function enqueueConnectorReassessments(
  tx: ReassessmentTx,
  input: { customerId: string; sourceId: string; receiptId: string; configRevision: number; mappingRevision: number; now: Date },
): Promise<void> {
  // The caller holds the source and current sync-project grants. Its receipt,
  // outcomes, cursor and completed job are in this same transaction.
  const projects = await tx.$queryRaw<{ projectId: string }[]>`
    SELECT DISTINCT o."projectId" FROM public."IngestionRowOutcome" o
    JOIN public."ProjectUpdatePolicy" h ON h."customerId"=o."customerId" AND h."projectId"=o."projectId"
    JOIN public."ProjectUpdatePolicyRevision" p ON p."customerId"=h."customerId" AND p."projectId"=h."projectId" AND p.revision=h.revision
    WHERE o."customerId"=${input.customerId}::uuid AND o."sourceId"=${input.sourceId}::uuid AND o."receiptId"=${input.receiptId}::uuid
      AND o.state='ACCEPTED' AND o.operation IN ('CREATE','UPDATE')
      AND p."scheduledScanEnabled" AND p."scheduledServiceSubject" IS NOT NULL
    ORDER BY o."projectId"`;
  for (const project of projects) {
    const previous = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM public."IngestionProjectReassessment" WHERE "customerId"=${input.customerId}::uuid
        AND "sourceId"=${input.sourceId}::uuid AND "receiptId"=${input.receiptId}::uuid AND "projectId"=${project.projectId}::uuid`;
    if (previous.length) continue;
    const cause = { id: randomUUID(), ...input, projectId: project.projectId };
    const auditId = await reassessmentAudit(tx, cause, "connector:jira-runtime", "queued", {}, input.now);
    await tx.$executeRaw`
      INSERT INTO public."IngestionProjectReassessment"
        (id,"customerId","sourceId","receiptId","projectId","configRevision","mappingRevision","createdAt","availableAt","auditEventId")
      VALUES (${cause.id}::uuid,${input.customerId}::uuid,${input.sourceId}::uuid,${input.receiptId}::uuid,${project.projectId}::uuid,
        ${input.configRevision},${input.mappingRevision},${input.now},${input.now},${auditId}::uuid)`;
  }
}

// Source/configuration mutation can hold Source before Project. A caller already
// holding Project must never wait in the opposite order. 55P03 is contention,
// not a permission denial; the coordinator refunds its charge and defers work.
export async function sourceStillMatches(
  tx: ReassessmentTx,
  cause: ReassessmentCause,
): Promise<boolean> {
  const sources = await tx.$queryRaw<{ currentConfigRevision: number | null; mappingRevision: number }[]>`
    SELECT "currentConfigRevision","mappingRevision" FROM public."IngestionSource"
    WHERE "customerId"=${cause.customerId}::uuid AND id=${cause.sourceId}::uuid FOR SHARE NOWAIT`;
  const source = sources[0];
  if (!source || source.currentConfigRevision !== cause.configRevision || source.mappingRevision !== cause.mappingRevision) return false;
  const grants = await tx.$queryRaw<{ id: string }[]>`
    SELECT g.id FROM public."ConnectorSyncGrant" g
    JOIN public."IngestionSyncReceiptProjectScope" s ON s."customerId"=g."customerId" AND s."sourceId"=g."sourceId"
      AND s."projectId"=g."projectId" AND s."syncGrantId"=g.id
    JOIN public."IngestionConfigurationProject" p ON p."customerId"=g."customerId" AND p."sourceId"=g."sourceId"
      AND p."projectId"=g."projectId" AND p."configRevision"=g."configRevision"
    WHERE g."customerId"=${cause.customerId}::uuid AND g."sourceId"=${cause.sourceId}::uuid AND g."projectId"=${cause.projectId}::uuid
      AND s."receiptId"=${cause.receiptId}::uuid AND g."configRevision"=${cause.configRevision} AND g.active
    FOR SHARE OF g NOWAIT`;
  return grants.length === 1;
}

export async function mayReadReassessmentSource(
  tx: ReassessmentTx,
  actor: Actor,
  cause: ReassessmentCause,
): Promise<boolean> {
  const sources = await tx.$queryRaw<{ currentConfigRevision: number | null }[]>`
    SELECT "currentConfigRevision" FROM public."IngestionSource"
    WHERE "customerId"=${actor.customerId}::uuid AND id=${cause.sourceId}::uuid FOR SHARE NOWAIT`;
  const revision = sources[0]?.currentConfigRevision;
  if (revision === null || revision === undefined) return false;
  const readers = await tx.$queryRaw<{ subject: string }[]>`
    SELECT r.subject FROM public."IngestionConfigurationReader" r
    JOIN public."IngestionConfigurationRevision" c ON c."customerId"=r."customerId" AND c."sourceId"=r."sourceId" AND c.revision=r."configRevision" AND c.sealed
    WHERE r."customerId"=${actor.customerId}::uuid AND r."sourceId"=${cause.sourceId}::uuid
      AND r."configRevision"=${revision} AND r."projectId"=${cause.projectId}::uuid AND r.subject=${actor.subject}`;
  return readers.length === 1;
}

export async function blockDisabledPolicyCauses(
  tx: ReassessmentTx, actor: Actor, projectId: string, correlationId: string,
): Promise<void> {
  // The PMO operation already holds Project UPDATE. Record cancellations in two
  // set-based statements, so policy disable never performs one network roundtrip
  // per historical cause. No source content or source lock is needed.
  const at = await reassessmentNow(tx);
  await tx.$executeRaw`
    INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
    SELECT gen_random_uuid(),w."customerId",${actor.subject},'ingestion.reassessment.blocked',${correlationId},
      jsonb_build_object('causeId',w.id::text,'projectId',w."projectId"::text,'sourceId',w."sourceId"::text,
        'receiptId',w."receiptId"::text,'reason','POLICY_DISABLED'),${at}
    FROM public."IngestionProjectReassessment" w WHERE w."customerId"=${actor.customerId}::uuid
      AND w."projectId"=${projectId}::uuid AND w.state='READY'`;
  await tx.$executeRaw`
    UPDATE public."IngestionProjectReassessment" w SET state='BLOCKED',"lastReason"='POLICY_DISABLED',"auditEventId"=a.id
    FROM public."AuditEvent" a WHERE w."customerId"=${actor.customerId}::uuid AND w."projectId"=${projectId}::uuid AND w.state='READY'
      AND a."customerId"=w."customerId" AND a.event='ingestion.reassessment.blocked' AND a."correlationId"=${correlationId}
      AND a."occurredAt"=${at} AND a.detail->>'causeId'=w.id::text AND a.detail->>'reason'='POLICY_DISABLED'`;
  await tx.$executeRaw`
    UPDATE public."ProjectUpdatePolicy" SET "scanClaimGeneration"="scanClaimGeneration"+1,"scanClaimUntil"=NULL
    WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${projectId}::uuid`;
}
