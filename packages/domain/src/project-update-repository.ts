// TR-API-001: application port depends on contracts without schema cycles.
import type { Actor } from "./actor.js";
import type { IngestionReassessmentRetry, IngestionReassessmentItem, IngestionReassessmentPage } from "./ingestion-reassessment.js";
import type { ProjectUpdateEngagementView } from "./project-update-engagement.js";
import type { ProjectUpdateCaptureHistory, ProjectUpdateRecipientRequestView, ProjectUpdateResponseReceipt } from "./project-update-capture.js";
import type { ProjectUpdatePolicyView, ProjectUpdatePolicyChange, ProjectUpdateAssessmentView } from "./project-updates.js";
import type { ProjectUpdateSchedulePreview } from "./project-update-schedule.js";
import type { UpdateAdviceSnapshot } from "./update-advice.js";

export interface ProjectUpdateRepository {
  updateSuggestions(actor: Actor, projectId: string): Promise<UpdateAdviceSnapshot>;
  policy(actor: Actor, projectId: string): Promise<ProjectUpdatePolicyView | null>;
  setPolicy(actor: Actor, projectId: string, change: ProjectUpdatePolicyChange, correlationId: string): Promise<ProjectUpdatePolicyView>;
  assess(actor: Actor, projectId: string, correlationId: string): Promise<ProjectUpdateAssessmentView>;
  latest(actor: Actor, projectId: string): Promise<ProjectUpdateAssessmentView | null>;
  schedulePreview(actor: Actor, projectId: string): Promise<ProjectUpdateSchedulePreview>;
  scanScheduledProjects(limit: number): Promise<number>;
  reassessments(actor: Actor, projectId: string, cursor?: string | null): Promise<IngestionReassessmentPage>;
  retryReassessment(actor: Actor, projectId: string, change: IngestionReassessmentRetry, correlationId: string): Promise<IngestionReassessmentItem>;
  activateEngagement(actor: Actor, projectId: string, expectedPolicyRevision: number, correlationId: string): Promise<ProjectUpdateEngagementView | null>;
  processShadowEngagements(limit: number): Promise<number>;
  processEngagements(limit: number): Promise<number>;
  invitation(actor: Actor, locator: string): Promise<ProjectUpdateRecipientRequestView>;
  submitResponse(actor: Actor, locator: string, submission: unknown, correlationId: string): Promise<ProjectUpdateResponseReceipt>;
  captureHistory(actor: Actor, projectId: string, cursor?: string | null): Promise<ProjectUpdateCaptureHistory>;
  purgeCaptureContent(): Promise<number>;
  beginCaptureGeneration(actor: Actor, projectId: string, change: unknown, correlationId: string): Promise<ProjectUpdateEngagementView>;
}
