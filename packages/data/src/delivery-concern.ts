import { z } from "zod";
import {
  HealthAssessmentError,
  buildDeliveryConcernAssessment,
  type Actor,
  type CriticalBlockerObservation,
  type CriticalDeliveryTargets,
  type ScheduleHealthAssessment,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import type { buildBlockerAgeAssessmentInTransaction } from "./blocker-age-assessment.js";
import { DatabaseProjectUpdateRepository } from "./project-updates.js";

type Tx = Prisma.TransactionClient;
type BlockerAge = Awaited<ReturnType<typeof buildBlockerAgeAssessmentInTransaction>>;
const raidRow = z.object({
  id: z.uuid(),
  key: z.string(),
  state: z.enum(["OPEN", "IN_PROGRESS", "COMPLETE", "CANCELLED"]),
});
const classification = z.object({
  status: z.literal("RESOLVED"),
  value: z.literal(false),
});

// The caller has already checked the actor and holds the Project gate for all
// schedule, source and configured-target reads.
export async function buildDeliveryConcernInTransaction(
  tx: Tx,
  db: Database,
  actor: Actor,
  projectId: string,
  schedule: ScheduleHealthAssessment,
  criticalTargets: CriticalDeliveryTargets,
  blockerAge: BlockerAge,
) {
  const rows = criticalTargets.raidItemIds.length === 0
    ? []
    : await tx.$queryRawUnsafe<unknown[]>(
        'SELECT id,key,state FROM public."RaidItem" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=ANY($3::uuid[]) ORDER BY id',
        actor.customerId, projectId, criticalTargets.raidItemIds,
      );
  const raids = raidRow.array().parse(rows);
  const blockers = raids.map((raid): CriticalBlockerObservation => {
    if (raid.state === "COMPLETE" || raid.state === "CANCELLED")
      return { ...raid, status: "CLEAR" };
    if (blockerAge.input.gates.inventoryAttested !== true)
      return { ...raid, status: "UNASSESSABLE" };
    const candidate = blockerAge.input.candidates.find((item) => item.raidItemId === raid.id);
    if (!candidate || candidate.state !== raid.state || candidate.key !== raid.key)
      throw new HealthAssessmentError("UNAVAILABLE");
    if (classification.safeParse(candidate.classification).success)
      return { ...raid, status: "CLEAR" };
    const age = blockerAge.result.assessments.find((item) => item.targetKey === raid.key);
    const thresholdRevision = blockerAge.result.thresholdRevision;
    if (!age || age.sourceDate === null || age.ageDays === null || thresholdRevision === null)
      return { ...raid, status: "UNASSESSABLE" };
    return {
      ...raid,
      status: "ACTIVE",
      openedAt: age.sourceDate,
      ageDays: age.ageDays,
      minimumBlockerAgeDays: age.threshold.minimumBlockerAgeDays,
      thresholdRevision,
    };
  });
  const freshness = await new DatabaseProjectUpdateRepository(db)
    .deliveryFreshnessInTransaction(tx, actor, projectId, blockerAge.asOf);
  const policyRevision = schedule.scheduleHealthPolicy.revision;
  const { input, result } = buildDeliveryConcernAssessment({
    schedule: schedule.input,
    criticalTargets,
    policyRevision,
    blockers,
    update: freshness.observation,
  });
  return {
    input: {
      evaluation: input,
      criticalTargets,
      criticalTargetsPolicyRevision: policyRevision,
      updateEvidence: freshness.evidence,
      dependencies: freshness.dependencies,
    },
    result,
  };
}
