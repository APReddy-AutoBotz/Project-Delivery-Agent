import { z } from "zod";
import { projectUpdateAssessmentViewSchema } from "./project-updates.js";

export const projectLeadershipScheduleSchema = z.strictObject({
  revision: z.number().int().min(1),
  baseline: z.iso.date().nullable(),
  forecast: z.iso.date().nullable(),
  movementDays: z.number().int().nullable(),
});
export type ProjectLeadershipSchedule = z.infer<typeof projectLeadershipScheduleSchema>;

export const projectLeadershipQuestionSchema = z.strictObject({ question: z.string().trim().min(1).max(256) });

export const projectLeadershipAnswerSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("CLARIFY") }),
  z.strictObject({
    state: z.literal("ANSWERED"),
    projectId: z.uuid(),
    asOf: z.iso.datetime(),
    schedule: projectLeadershipScheduleSchema.nullable(),
    cause: z.literal("UNKNOWN"),
    updateFreshness: projectUpdateAssessmentViewSchema.shape.freshness.pick({
      state: true, assessedAt: true, sourceDate: true, sourceDateField: true,
    }).extend({ assessmentId: z.uuid(), openObligation: z.boolean() }).nullable(),
  }),
]);
export type ProjectLeadershipAnswer = z.infer<typeof projectLeadershipAnswerSchema>;

export function isCurrentProjectScheduleQuestion(question: string) {
  return /^(?:why is (?:this|the) project delayed|what is (?:this|the) project(?:'s)? schedule status|what is the schedule status of this project)\??$/u
    .test(question.trim().toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'"));
}
