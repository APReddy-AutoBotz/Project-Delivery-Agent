import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IdentityService } from "@pdaa/platform";
import { z } from "zod";
import { atlasManagementPreview, renderAtlasManagementSnapshot } from "./atlas-management-snapshot.js";
import {
  atlasReportDecisionSchema,
  projectFactIdSchema,
  projectUpdatePolicyChangeSchema,
  projectUpdateEngagementActivationSchema,
  projectUpdateCaptureGenerationSchema,
  projectUpdateClarificationRequestSchema,
  projectUpdateFactConfirmationSchema,
  projectUpdateStatusConfirmationSchema,
  projectUpdateAssessmentRequestSchema,
  ingestionReassessmentRetrySchema,
  ingestionReassessmentPageRequestSchema,
  ProjectUpdateError,
  type Actor,
  type ProjectUpdateRepository,
} from "@pdaa/domain";

type Request = {
  headers: Record<string, string | undefined>;
  correlationId: string;
};
export const PROJECT_UPDATE_REPOSITORY = "PROJECT_UPDATE_REPOSITORY";
export const unavailableProjectUpdateRepository: ProjectUpdateRepository = {
  async updateSuggestions() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async policy() { return null; },
  async setPolicy() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async assess() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async latest() { return null; },
  async schedulePreview() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async scanScheduledProjects() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async reassessments() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async retryReassessment() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async activateEngagement() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async processShadowEngagements() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async processEngagements() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async invitation() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async submitResponse() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async requestCapturedStatusClarification() { throw new ProjectUpdateError("DENIED"); },
  async confirmCapturedStatus() { throw new ProjectUpdateError("DENIED"); },
  async confirmCapturedFacts() { throw new ProjectUpdateError("DENIED"); },
  async confirmAtlasReply() { throw new ProjectUpdateError("DENIED"); },
  async atlasApproval() { throw new ProjectUpdateError("DENIED"); },
  async decideAtlasApproval() { throw new ProjectUpdateError("DENIED"); },
  async recordAtlasComment() { throw new ProjectUpdateError("DENIED"); },
  async confirmAtlasDelay() { throw new ProjectUpdateError("DENIED"); },
  async atlasLeadershipAnswer() { throw new ProjectUpdateError("DENIED"); },
  async atlasManagementSnapshot() { throw new ProjectUpdateError("DENIED"); },
  async createAtlasManagementSnapshot() { throw new ProjectUpdateError("DENIED"); },
  async requestAtlasReportApproval() { throw new ProjectUpdateError("DENIED"); },
  async atlasReportApproval() { throw new ProjectUpdateError("DENIED"); },
  async decideAtlasReportApproval() { throw new ProjectUpdateError("DENIED"); },
  async distributeAtlasReport() { throw new ProjectUpdateError("DENIED"); },
  async atlasDistributedReport() { throw new ProjectUpdateError("DENIED"); },
  async captureHistory() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async purgeCaptureContent() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async beginCaptureGeneration() { throw new ProjectUpdateError("UNAVAILABLE"); },
};

@ApiTags("Project updates")
@ApiBearerAuth()
@Controller("api/projects/:id")
export class ProjectUpdateController {
  constructor(
    @Inject(PROJECT_UPDATE_REPOSITORY)
    private readonly repository: ProjectUpdateRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async actor(req: Request): Promise<Actor> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 16384)
      throw new HttpException("", 401);
    try { return await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
  }

  private projectId(id: string) {
    if (!projectFactIdSchema.safeParse(id).success)
      throw new HttpException("", 404);
    return id;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof ProjectUpdateError) {
        const status = {
          INVALID_REQUEST: 400,
          DENIED: 404,
          FORBIDDEN: 403,
          CONFLICT: 409,
          UNAVAILABLE: 503,
        }[error.code];
        throw new HttpException("", status);
      }
      throw error;
    }
  }

  @Get("project-update-policy")
  async policy(@Req() req: Request, @Param("id") rawId: string) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    return this.run(() => this.repository.policy(actor, id));
  }

  @Get("atlas-approval")
  async atlasApproval(@Req() req: Request, @Param("id") rawId: string) {
    const actor = await this.actor(req);
    return this.run(() => this.repository.atlasApproval(actor, this.projectId(rawId)));
  }

  @Post("atlas-approval")
  @HttpCode(200)
  async decideAtlasApproval(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    return this.run(() => this.repository.decideAtlasApproval(actor, this.projectId(rawId), body, req.correlationId));
  }

  @Post("atlas-comment-receipt")
  @HttpCode(200)
  async recordAtlasComment(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    return this.run(() => this.repository.recordAtlasComment(actor, this.projectId(rawId), body, req.correlationId));
  }

  @Post("atlas-delay-confirmation")
  @HttpCode(200)
  async confirmAtlasDelay(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    return this.run(() => this.repository.confirmAtlasDelay(actor, this.projectId(rawId), body, req.correlationId));
  }

  @Get("atlas-leadership-answer")
  async atlasLeadershipAnswer(@Req() req: Request, @Param("id") rawId: string, @Query("priorSnapshotId") priorSnapshotId?: string) {
    const actor = await this.actor(req);
    if (!z.uuid().optional().safeParse(priorSnapshotId).success) throw new HttpException("", 400);
    return this.run(() => this.repository.atlasLeadershipAnswer(actor, this.projectId(rawId), priorSnapshotId));
  }

  @Get("atlas-management-snapshot")
  async atlasManagementSnapshot(@Req() req: Request, @Param("id") rawId: string, @Query("snapshotId") snapshotId?: string) {
    const actor = await this.actor(req);
    if (!z.uuid().optional().safeParse(snapshotId).success) throw new HttpException("", 400);
    const snapshot = await this.run(() => this.repository.atlasManagementSnapshot(actor, this.projectId(rawId), snapshotId));
    return snapshot ? renderAtlasManagementSnapshot(snapshot) : null;
  }

  @Post("atlas-management-snapshot")
  @HttpCode(200)
  async createAtlasManagementSnapshot(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    if (!z.strictObject({}).safeParse(body).success) throw new HttpException("", 400);
    const snapshot = await this.run(() => this.repository.createAtlasManagementSnapshot(actor, this.projectId(rawId), req.correlationId));
    return renderAtlasManagementSnapshot(snapshot);
  }

  @Post("atlas-management-snapshot/approval-request")
  @HttpCode(200)
  async requestAtlasReportApproval(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    const snapshot = await this.run(() => this.repository.requestAtlasReportApproval(actor, this.projectId(rawId), body, req.correlationId));
    return atlasManagementPreview(snapshot);
  }

  @Get("atlas-report-approval")
  async atlasReportApproval(@Req() req: Request, @Param("id") rawId: string) {
    const actor = await this.actor(req);
    const review = await this.run(() => this.repository.atlasReportApproval(actor, this.projectId(rawId)));
    return review ? { ...atlasManagementPreview(review.snapshot), distribution: review.distribution } : null;
  }

  @Post("atlas-report-approval")
  @HttpCode(200)
  async decideAtlasReportApproval(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    const command = atlasReportDecisionSchema.safeParse(body);
    if (!command.success) throw new HttpException("", 400);
    if (command.data.decision === "APPROVED") {
      const review = await this.run(() => this.repository.atlasReportApproval(actor, id));
      const report = review?.snapshot;
      if (report?.id !== command.data.snapshotId || report.approval?.requestId !== command.data.requestId)
        throw new HttpException("", 409);
      if (report.approvalState === "PENDING") {
        try { await renderAtlasManagementSnapshot({ ...report, approvalState: "APPROVED" }); }
        catch { throw new HttpException("", 503); }
      }
    }
    // The write rechecks the request and authorization after rendering outside the project lock.
    const snapshot = await this.run(() => this.repository.decideAtlasReportApproval(actor, id, command.data, req.correlationId));
    return atlasManagementPreview(snapshot);
  }

  @Post("atlas-report-distribution")
  @HttpCode(200)
  async distributeAtlasReport(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    return this.run(() => this.repository.distributeAtlasReport(actor, this.projectId(rawId), body, req.correlationId));
  }

  @Get("atlas-report-distribution")
  async atlasDistributedReport(@Req() req: Request, @Param("id") rawId: string) {
    const actor = await this.actor(req);
    const delivered = await this.run(() => this.repository.atlasDistributedReport(actor, this.projectId(rawId)));
    return delivered ? { ...await renderAtlasManagementSnapshot(delivered.snapshot), distribution: delivered.distribution } : null;
  }

  @Get("update-suggestions")
  async updateSuggestions(@Req() req: Request, @Param("id") rawId: string) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    return this.run(() => this.repository.updateSuggestions(actor, id));
  }

  @Post("project-update-policy")
  @HttpCode(200)
  async setPolicy(
    @Req() req: Request,
    @Param("id") rawId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    const parsed = projectUpdatePolicyChangeSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.setPolicy(actor, id, parsed.data, req.correlationId),
    );
  }

  @Post("project-update-assessments")
  @HttpCode(201)
  async assess(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    if (!projectUpdateAssessmentRequestSchema.safeParse(body).success)
      throw new HttpException("", 400);
    return this.run(() =>
      this.repository.assess(actor, id, req.correlationId),
    );
  }

  @Get("project-update-assessments/latest")
  async latest(@Req() req: Request, @Param("id") rawId: string) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    return this.run(() => this.repository.latest(actor, id));
  }

  @Post("project-update-engagements")
  @HttpCode(200)
  async activateEngagement(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    const parsed = projectUpdateEngagementActivationSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("", 400);
    return this.run(() => this.repository.activateEngagement(
      actor, id, parsed.data.expectedPolicyRevision, req.correlationId,
    ));
  }

  @Get("project-update-schedule-preview")
  async schedulePreview(@Req() req: Request, @Param("id") rawId: string) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    return this.run(() => this.repository.schedulePreview(actor, id));
  }

  @Get("ingestion-reassessments")
  async reassessments(@Req() req: Request, @Param("id") rawId: string, @Query() query: Record<string, unknown>) {
    const actor = await this.actor(req), id = this.projectId(rawId);
    if (Object.keys(query).some((key) => key !== "cursor") ||
        (query.cursor !== undefined && !projectFactIdSchema.safeParse(query.cursor).success))
      throw new HttpException("", 400);
    return this.run(() => this.repository.reassessments(actor, id, query.cursor as string | undefined));
  }

  // Read-only page: the cursor is a position, not a source-access grant.
  @Post("ingestion-reassessment-pages")
  @HttpCode(200)
  async reassessmentPage(@Req() req: Request, @Param("id") rawId: string,
    @Query() query: Record<string, unknown>, @Body() body: unknown) {
    const actor = await this.actor(req), id = this.projectId(rawId);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpException("", 415);
    const parsed = ingestionReassessmentPageRequestSchema.safeParse(body);
    if (Object.keys(query).length !== 0 || !parsed.success) throw new HttpException("", 400);
    return this.run(() => this.repository.reassessments(actor, id, parsed.data.cursor));
  }

  @Post("ingestion-reassessment-retries")
  @HttpCode(200)
  async retryReassessment(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req), id = this.projectId(rawId);
    const parsed = ingestionReassessmentRetrySchema.safeParse(body);
    if (!parsed.success) throw new HttpException("", 400);
    return this.run(() => this.repository.retryReassessment(actor, id, parsed.data, req.correlationId));
  }

  @Get("project-update-capture-history")
  async captureHistory(@Req() req: Request, @Param("id") rawId: string, @Query() query: Record<string, unknown>) {
    const actor = await this.actor(req);
    const id = this.projectId(rawId);
    if (Object.keys(query).some((key) => key !== "cursor") ||
        (query.cursor !== undefined && !projectFactIdSchema.safeParse(query.cursor).success))
      throw new HttpException("", 400);
    return this.run(() => this.repository.captureHistory(actor, id, query.cursor as string | undefined));
  }

  @Post("project-update-capture-generations")
  @HttpCode(201)
  async beginCaptureGeneration(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req), id = this.projectId(rawId);
    const parsed = projectUpdateCaptureGenerationSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("", 400);
    return this.run(() => this.repository.beginCaptureGeneration(actor, id, parsed.data, req.correlationId));
  }

  @Post("project-update-status-confirmations")
  @HttpCode(200)
  async confirmCapturedStatus(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req), id = this.projectId(rawId);
    const parsed = projectUpdateStatusConfirmationSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("", 400);
    return this.run(() => this.repository.confirmCapturedStatus(actor, id, parsed.data, req.correlationId));
  }

  @Post("project-update-fact-confirmations")
  @HttpCode(200)
  async confirmCapturedFacts(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req), id = this.projectId(rawId);
    const parsed = projectUpdateFactConfirmationSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("", 400);
    return this.run(() => this.repository.confirmCapturedFacts(actor, id, parsed.data, req.correlationId));
  }

  @Post("project-update-status-clarifications")
  @HttpCode(200)
  async requestCapturedStatusClarification(@Req() req: Request, @Param("id") rawId: string, @Body() body: unknown) {
    const actor = await this.actor(req), id = this.projectId(rawId);
    const parsed = projectUpdateClarificationRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("", 400);
    return this.run(() => this.repository.requestCapturedStatusClarification(actor, id, parsed.data, req.correlationId));
  }
}
