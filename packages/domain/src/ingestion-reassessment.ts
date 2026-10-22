// AC-CON-004 / NFR-SEC-001: bounded administrative operational metadata only.
import { z } from "zod";
const id = z.uuid().refine((value) => value === value.toLowerCase());
const revision = z.number().int().min(0).max(2147483646);
export const ingestionReassessmentRetrySchema = z.strictObject({
  workId: id,
  expectedRecoveryRevision: revision,
});
export const ingestionReassessmentItemSchema = z.strictObject({
  id, sourceId: id, receiptId: id, projectId: id,
  configRevision: z.number().int().min(1),
  mappingRevision: z.number().int().min(1),
  state: z.enum(["READY", "COMPLETED", "BLOCKED"]),
  reason: z.enum(["QUEUED", "CLAIMED", "FAILED", "LOCK_CONTENDED", "POLICY_DISABLED", "SOURCE_SCOPE_CHANGED", "RETRY_EXHAUSTED", "RETRY_REQUESTED", "COMPLETED"]),
  attemptCount: z.number().int().min(0).max(5),
  totalAttempts: z.number().int().nonnegative(),
  recoveryRevision: z.number().int().min(0).max(2147483647),
  createdAt: z.iso.datetime(),
  availableAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  assessmentId: id.nullable(), obligationId: id.nullable(), previewId: id.nullable(),
});
export const ingestionReassessmentPageSchema = z.strictObject({
  items: z.array(ingestionReassessmentItemSchema).max(25),
  nextCursor: id.nullable(),
});
export type IngestionReassessmentRetry = z.infer<typeof ingestionReassessmentRetrySchema>;
export type IngestionReassessmentItem = z.infer<typeof ingestionReassessmentItemSchema>;
export type IngestionReassessmentPage = z.infer<typeof ingestionReassessmentPageSchema>;
