import { milestoneStateDisagreementSchema, type MilestoneStateDisagreement } from "@pdaa/domain";

export function decodeMilestoneStateDisagreement(value: unknown, projectId: string, milestoneId: string): MilestoneStateDisagreement {
  const result = milestoneStateDisagreementSchema.parse(value);
  if (result.projectId !== projectId || result.milestoneId !== milestoneId) throw new Error("Disagreement unavailable");
  return result;
}
