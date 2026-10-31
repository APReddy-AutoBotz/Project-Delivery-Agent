import { z } from "zod";
import type { Actor } from "./actor.js";
import { milestoneConflictObservationSchema } from "./milestone-conflict-observation.js";

// Presentation contract only. A repository must establish both capabilities,
// complete current and historical source access, and the exact stored identity.
// A recorded request is not a claim about its current assignment or delivery.
export const milestoneRequestObservationSchema = z.strictObject({
  observation: milestoneConflictObservationSchema,
  // An explicit null alternative survives the OpenAPI 3.0 enum conversion.
  requestStatus: z.union([z.enum(["MATCHING_REQUEST_RECORDED", "NO_MATCHING_REQUEST_RECORDED"]), z.null()]),
}).superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: "custom", message: "Invalid milestone request observation" });
  if ((value.observation.outcome === "CONFLICTING") !== (value.requestStatus !== null)) invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).length > 262144) invalid();
  if (value.observation.outcome === "CONFLICTING" && value.observation.positions.some((position) =>
    position.supports.some((row) => row.provenance !== "HUMAN_CONFIRMED"))) invalid();
});

export type MilestoneRequestObservation = z.infer<typeof milestoneRequestObservationSchema>;
export interface MilestoneRequestObservationRepository {
  readForLeaderManager(actor: Actor, projectId: string, milestoneId: string): Promise<MilestoneRequestObservation>;
}
