import { z } from "zod";
import { projectLeadershipFactsSchema } from "./project-leadership-answer.js";

const projectLabel = z.string().min(1).max(160)
  .refine((value) => value.trim().length > 0 && !/[\p{Cc}\p{Surrogate}]/u.test(value));

export const projectManagementDraftSchema = projectLeadershipFactsSchema.extend({
  project: z.strictObject({ code: projectLabel, name: projectLabel }),
  approvalState: z.literal("DRAFT"),
  reportingPeriod: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
});
export type ProjectManagementDraft = z.infer<typeof projectManagementDraftSchema>;

export const projectManagementDraftOutputSchema = z.strictObject({
  draft: projectManagementDraftSchema,
  highlights: z.array(z.string().min(1).max(400)).min(1).max(4),
  livePath: z.string().min(1).max(64),
  powerpointBase64: z.string().min(1).max(160_000),
});
export type ProjectManagementDraftOutput = z.infer<typeof projectManagementDraftOutputSchema>;
