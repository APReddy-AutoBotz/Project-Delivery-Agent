// TR-API-001: application port depends on contracts without schema cycles.
import type { Actor } from "./actor.js";
import type { AtlasApprovalView, AtlasCommentReceipt, AtlasDelayAssessment, AtlasDelayClarification, AtlasLeadershipAnswer, AtlasManagementSnapshot, AtlasReportDistributionReceipt } from "./atlas-update-approval.js";
import type { IngestionReassessmentRetry, IngestionReassessmentItem, IngestionReassessmentPage } from "./ingestion-reassessment.js";
import type { ProjectUpdateEngagementView } from "./project-update-engagement.js";
import type { ProjectUpdateCaptureHistory, ProjectUpdateRecipientRequestView, ProjectUpdateResponseReceipt,
  ProjectUpdateClarificationReceipt, ProjectUpdateFactConfirmationReceipt, ProjectUpdateStatusConfirmationReceipt } from "./project-update-capture.js";
import type { ProjectUpdatePolicyView, ProjectUpdatePolicyChange, ProjectUpdateAssessmentView } from "./project-updates.js";
import type { ProjectUpdateSchedulePreview } from "./project-update-schedule.js";
import type { ProjectLeadershipAnswer } from "./project-leadership-answer.js";
import type { ProjectManagementDraft } from "./project-management-draft.js";
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
  requestCapturedStatusClarification(actor: Actor, projectId: string, request: unknown, correlationId: string): Promise<ProjectUpdateClarificationReceipt>;
  confirmCapturedStatus(actor: Actor, projectId: string, confirmation: unknown, correlationId: string): Promise<ProjectUpdateStatusConfirmationReceipt>;
  confirmCapturedFacts(actor: Actor, projectId: string, confirmation: unknown, correlationId: string): Promise<ProjectUpdateFactConfirmationReceipt>;
  confirmAtlasReply(actor: Actor, locator: string, confirmation: unknown, correlationId: string): Promise<{ approvalId: string }>;
  atlasApproval(actor: Actor, projectId: string): Promise<AtlasApprovalView | null>;
  decideAtlasApproval(actor: Actor, projectId: string, decision: unknown, correlationId: string): Promise<AtlasApprovalView>;
  recordAtlasComment(actor: Actor, projectId: string, command: unknown, correlationId: string): Promise<AtlasCommentReceipt>;
  confirmAtlasDelay(actor: Actor, projectId: string, command: unknown, correlationId: string): Promise<AtlasDelayAssessment>;
  atlasDelayClarification(actor: Actor, projectId: string): Promise<AtlasDelayClarification | null>;
  requestAtlasDelayClarification(actor: Actor, projectId: string, command: unknown, correlationId: string): Promise<AtlasDelayClarification>;
  atlasLeadershipAnswer(actor: Actor, projectId: string, priorSnapshotId?: string): Promise<AtlasLeadershipAnswer>;
  projectLeadershipAnswer(actor: Actor, projectId: string, question: unknown): Promise<ProjectLeadershipAnswer>;
  projectManagementDraft(actor: Actor, projectId: string): Promise<ProjectManagementDraft>;
  atlasManagementSnapshot(actor: Actor, projectId: string, snapshotId?: string): Promise<AtlasManagementSnapshot | null>;
  createAtlasManagementSnapshot(actor: Actor, projectId: string, correlationId: string): Promise<AtlasManagementSnapshot>;
  requestAtlasReportApproval(actor: Actor, projectId: string, request: unknown, correlationId: string): Promise<AtlasManagementSnapshot>;
  atlasReportApproval(actor: Actor, projectId: string): Promise<{ snapshot: AtlasManagementSnapshot; distribution: AtlasReportDistributionReceipt | null } | null>;
  decideAtlasReportApproval(actor: Actor, projectId: string, command: unknown, correlationId: string): Promise<AtlasManagementSnapshot>;
  distributeAtlasReport(actor: Actor, projectId: string, command: unknown, correlationId: string): Promise<AtlasReportDistributionReceipt>;
  atlasDistributedReport(actor: Actor, projectId: string): Promise<{ snapshot: AtlasManagementSnapshot; distribution: AtlasReportDistributionReceipt } | null>;
  captureHistory(actor: Actor, projectId: string, cursor?: string | null): Promise<ProjectUpdateCaptureHistory>;
  purgeCaptureContent(): Promise<number>;
  beginCaptureGeneration(actor: Actor, projectId: string, change: unknown, correlationId: string): Promise<ProjectUpdateEngagementView>;
}
