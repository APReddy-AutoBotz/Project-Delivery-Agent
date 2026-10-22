// EXEC-019: one fenced project claim for periodic and connector-triggered scans.
import { randomUUID } from "node:crypto";
import { ProjectUpdateError, type Actor, type ProjectUpdateAssessmentView } from "@pdaa/domain";
import type { PrismaClient as Database } from "./generated/prisma/client.js";
import {
  reassessmentAudit, reassessmentNow, sourceStillMatches,
  type ReassessmentCause, type ReassessmentTx,
} from "./ingestion-reassessments.js";

export type Claim = {
  customerId: string; projectId: string; generation: number;
  cutoff: Date; correlationId: string; periodicDue: boolean; causes: ReassessmentCause[];
};
type Assessment = { assessmentId: string; view: ProjectUpdateAssessmentView };
type Assessor = (tx: ReassessmentTx, actor: Actor, projectId: string, correlationId: string) => Promise<Assessment>;
class LostClaim extends Error {}
const transactionOptions = { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 20000 } as const;
const PERIOD_SECONDS = 3600;
const RETRY_SECONDS = 300;
const LEASE_SECONDS = 120;
const CONTENTION_SECONDS = 60;
const after = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

export function isReassessmentContention(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; meta?: { code?: unknown;
    driverAdapterError?: { cause?: { originalCode?: unknown } } } };
  return value.code === "55P03" || value.meta?.code === "55P03" ||
    value.meta?.driverAdapterError?.cause?.originalCode === "55P03";
}

export class ProjectUpdateScanCoordinator {
  constructor(private readonly db: Database, private readonly subject: string, private readonly assess: Assessor) {}

  private async live(tx: ReassessmentTx, claim: Claim): Promise<boolean> {
    const rows = await tx.$queryRaw<{ generation: number }[]>`
      SELECT h."scanClaimGeneration" AS generation FROM public."ProjectUpdatePolicy" h
      JOIN public."ProjectUpdatePolicyRevision" r ON r."customerId"=h."customerId" AND r."projectId"=h."projectId" AND r.revision=h.revision
      WHERE h."customerId"=${claim.customerId}::uuid AND h."projectId"=${claim.projectId}::uuid
        AND h."scanClaimGeneration"=${claim.generation} AND h."scanClaimUntil">clock_timestamp()
        AND r."scheduledScanEnabled" AND r."scheduledServiceSubject"=${this.subject}
      FOR UPDATE OF h`;
    return rows.length === 1;
  }

  private async lockProject(tx: ReassessmentTx, claim: Pick<Claim, "customerId" | "projectId">) {
    await tx.$queryRaw`
      SELECT id FROM public."Project" WHERE "customerId"=${claim.customerId}::uuid AND id=${claim.projectId}::uuid FOR UPDATE`;
  }

  private async block(tx: ReassessmentTx, cause: ReassessmentCause, reason: "RETRY_EXHAUSTED" | "SOURCE_SCOPE_CHANGED", now: Date) {
    const auditId = await reassessmentAudit(tx, cause, this.subject, "blocked", { reason }, now);
    await tx.$executeRaw`
      UPDATE public."IngestionProjectReassessment" SET state='BLOCKED',"lastReason"=${reason},"auditEventId"=${auditId}::uuid
      WHERE id=${cause.id}::uuid AND "customerId"=${cause.customerId}::uuid AND "projectId"=${cause.projectId}::uuid AND state='READY'`;
  }

  private async claim(tx: ReassessmentTx): Promise<Claim | null> {
    const cutoff = await reassessmentNow(tx);
    const selected = await tx.$queryRaw<{ customerId: string; projectId: string }[]>`
      SELECT h."customerId",h."projectId" FROM public."ProjectUpdatePolicy" h
      JOIN public."Project" p ON p."customerId"=h."customerId" AND p.id=h."projectId"
      JOIN public."ProjectUpdatePolicyRevision" r ON r."customerId"=h."customerId" AND r."projectId"=h."projectId" AND r.revision=h.revision
      WHERE r."scheduledScanEnabled" AND r."scheduledServiceSubject"=${this.subject}
        AND (h."scanClaimUntil" IS NULL OR h."scanClaimUntil"<=${cutoff})
        AND (h."scanFailureNextEligibleAt" IS NULL OR h."scanFailureNextEligibleAt"<=${cutoff})
        AND (h."scheduledScanNextEligibleAt" IS NULL OR h."scheduledScanNextEligibleAt"<=${cutoff}
          OR EXISTS (SELECT 1 FROM public."IngestionProjectReassessment" w WHERE w."customerId"=h."customerId" AND w."projectId"=h."projectId"
            AND w.state='READY' AND w."availableAt"<=${cutoff}))
      ORDER BY h."scheduledScanLastAttemptAt" ASC NULLS FIRST,h."customerId",h."projectId"
      LIMIT 1 FOR UPDATE OF p SKIP LOCKED`;
    const target = selected[0];
    if (!target) return null;
    const [head] = await tx.$queryRaw<{ scanClaimGeneration: number; scanClaimUntil: Date | null; scanFailureNextEligibleAt: Date | null; scheduledScanNextEligibleAt: Date | null }[]>`
      SELECT "scanClaimGeneration","scanClaimUntil","scanFailureNextEligibleAt","scheduledScanNextEligibleAt"
      FROM public."ProjectUpdatePolicy" WHERE "customerId"=${target.customerId}::uuid AND "projectId"=${target.projectId}::uuid FOR UPDATE`;
    if (!head || (head.scanClaimUntil && head.scanClaimUntil > cutoff) ||
      (head.scanFailureNextEligibleAt && head.scanFailureNextEligibleAt > cutoff)) return null;
    const periodicDue = !head.scheduledScanNextEligibleAt || head.scheduledScanNextEligibleAt <= cutoff;
    const candidates = await tx.$queryRaw<ReassessmentCause[]>`
      SELECT * FROM public."IngestionProjectReassessment" WHERE "customerId"=${target.customerId}::uuid AND "projectId"=${target.projectId}::uuid
        AND state='READY' AND "availableAt"<=${cutoff} ORDER BY "createdAt",id LIMIT 25 FOR UPDATE`;
    if (!periodicDue && candidates.length === 0) return null;
    // Exhaustion is finalized before advancing the head generation. A crashed
    // fifth claim remains charged and cannot obtain a sixth automatic attempt.
    for (const cause of candidates.filter((item) => item.attemptCount === 5))
      await this.block(tx, cause, "RETRY_EXHAUSTED", cutoff);
    const generation = head.scanClaimGeneration + 1;
    const correlationId = randomUUID();
    if (!Number.isSafeInteger(generation) || generation > 2147483647) throw new ProjectUpdateError("UNAVAILABLE");
    await tx.$executeRaw`
      UPDATE public."ProjectUpdatePolicy" SET "scanClaimGeneration"=${generation},"scanClaimUntil"=${after(cutoff, LEASE_SECONDS)},"scheduledScanLastAttemptAt"=${cutoff}
      WHERE "customerId"=${target.customerId}::uuid AND "projectId"=${target.projectId}::uuid`;
    const causes: ReassessmentCause[] = [];
    for (const cause of candidates.filter((item) => item.attemptCount < 5)) {
      const auditId = await reassessmentAudit(tx, cause, this.subject, "claimed", { generation }, cutoff, correlationId);
      await tx.$executeRaw`
        UPDATE public."IngestionProjectReassessment" SET "attemptCount"="attemptCount"+1,"totalAttempts"="totalAttempts"+1,
          "claimedGeneration"=${generation},"lastReason"='CLAIMED',"auditEventId"=${auditId}::uuid
        WHERE id=${cause.id}::uuid AND "customerId"=${target.customerId}::uuid AND "projectId"=${target.projectId}::uuid AND state='READY'`;
      causes.push({ ...cause, attemptCount: cause.attemptCount + 1, totalAttempts: cause.totalAttempts + 1,
        claimedGeneration: generation, lastReason: "CLAIMED", auditEventId: auditId });
    }
    return { ...target, generation, cutoff, correlationId, periodicDue, causes };
  }

  private async cohort(tx: ReassessmentTx, claim: Claim): Promise<ReassessmentCause[]> {
    if (!claim.causes.length) return [];
    const rows = await tx.$queryRaw<ReassessmentCause[]>`
      SELECT * FROM public."IngestionProjectReassessment" WHERE "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid
        AND id=ANY(${claim.causes.map((cause) => cause.id)}::uuid[]) AND state='READY' AND "claimedGeneration"=${claim.generation}
        AND "availableAt"<=${claim.cutoff} ORDER BY "sourceId","createdAt",id FOR UPDATE`;
    if (rows.length !== claim.causes.length) throw new LostClaim();
    return rows;
  }

  private async complete(tx: ReassessmentTx, claim: Claim): Promise<void> {
    await this.lockProject(tx, claim);
    if (!await this.live(tx, claim)) throw new LostClaim();
    const causes = await this.cohort(tx, claim);
    const valid: ReassessmentCause[] = [];
    for (const cause of causes) {
      if (await sourceStillMatches(tx, cause)) valid.push(cause);
      else await this.block(tx, cause, "SOURCE_SCOPE_CHANGED", await reassessmentNow(tx));
    }
    let result: Assessment | null = null;
    if (claim.periodicDue || valid.length > 0) {
      result = await this.assess(tx, { customerId: claim.customerId, subject: this.subject, roles: [] }, claim.projectId, claim.correlationId);
    }
    if (!await this.live(tx, claim)) throw new LostClaim();
    const now = await reassessmentNow(tx);
    for (const cause of valid) {
      if (!result) throw new ProjectUpdateError("UNAVAILABLE");
      const obligationId = result.view.obligation?.id ?? null;
      const previewId = result.view.preview?.id ?? null;
      const auditId = await reassessmentAudit(tx, cause, this.subject, "completed", {
        generation: claim.generation, claimAuditEventId: cause.auditEventId,
        assessmentId: result.assessmentId, obligationId, previewId,
      }, now, claim.correlationId);
      await tx.$executeRaw`
        UPDATE public."IngestionProjectReassessment" SET state='COMPLETED',"lastReason"='COMPLETED',"assessmentId"=${result.assessmentId}::uuid,
          "obligationId"=${obligationId}::uuid,"previewId"=${previewId}::uuid,"completedAt"=${now},"auditEventId"=${auditId}::uuid
        WHERE id=${cause.id}::uuid AND "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid
          AND state='READY' AND "claimedGeneration"=${claim.generation}`;
    }
    if (result) {
      await tx.$executeRaw`
        UPDATE public."ProjectUpdatePolicy" SET "scanClaimUntil"=NULL,"scanFailureNextEligibleAt"=NULL,"scheduledScanNextEligibleAt"=${after(now, PERIOD_SECONDS)}
        WHERE "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid AND "scanClaimGeneration"=${claim.generation}`;
    } else {
      await tx.$executeRaw`
        UPDATE public."ProjectUpdatePolicy" SET "scanClaimUntil"=NULL
        WHERE "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid AND "scanClaimGeneration"=${claim.generation}`;
    }
  }

  private async release(tx: ReassessmentTx, claim: Claim, contention: boolean): Promise<void> {
    await this.lockProject(tx, claim);
    if (!await this.live(tx, claim)) return;
    const causes = await this.cohort(tx, claim);
    const now = await reassessmentNow(tx);
    for (const cause of causes) {
      const event = contention ? "contention" : "failed";
      const reason = contention ? "LOCK_CONTENDED" : cause.attemptCount === 5 ? "RETRY_EXHAUSTED" : "FAILED";
      const auditId = await reassessmentAudit(tx, cause, this.subject, event, { generation: claim.generation, reason }, now);
      if (contention) {
        await tx.$executeRaw`
          UPDATE public."IngestionProjectReassessment" SET "attemptCount"="attemptCount"-1,"claimedGeneration"=NULL,
            "availableAt"=${after(now, CONTENTION_SECONDS)},"lastReason"='LOCK_CONTENDED',"auditEventId"=${auditId}::uuid
          WHERE id=${cause.id}::uuid AND "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid
            AND state='READY' AND "claimedGeneration"=${claim.generation}`;
      } else {
        await tx.$executeRaw`
          UPDATE public."IngestionProjectReassessment" SET state=${cause.attemptCount === 5 ? "BLOCKED" : "READY"},"availableAt"=${after(now, RETRY_SECONDS)},
            "lastReason"=${reason},"auditEventId"=${auditId}::uuid
          WHERE id=${cause.id}::uuid AND "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid
            AND state='READY' AND "claimedGeneration"=${claim.generation}`;
      }
    }
    if (contention) {
      await tx.$executeRaw`
        UPDATE public."ProjectUpdatePolicy" SET "scanClaimUntil"=NULL
        WHERE "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid AND "scanClaimGeneration"=${claim.generation}`;
    } else {
      await tx.$executeRaw`
        UPDATE public."ProjectUpdatePolicy" SET "scanClaimUntil"=NULL,"scanFailureNextEligibleAt"=${after(now, RETRY_SECONDS)}
        WHERE "customerId"=${claim.customerId}::uuid AND "projectId"=${claim.projectId}::uuid AND "scanClaimGeneration"=${claim.generation}`;
    }
  }

  async scan(): Promise<number> {
    const claim = await this.db.$transaction((tx) => this.claim(tx), transactionOptions);
    if (!claim) return 0;
    try {
      await this.db.$transaction((tx) => this.complete(tx, claim), transactionOptions);
    } catch (error) {
      if (error instanceof LostClaim) return 1;
      const contention = isReassessmentContention(error);
      await this.db.$transaction((tx) => this.release(tx, claim, contention), transactionOptions);
      if (!contention) throw error;
    }
    return 1;
  }
}
