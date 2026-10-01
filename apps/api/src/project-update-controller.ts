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
import {
  projectFactIdSchema,
  projectUpdatePolicyChangeSchema,
  projectUpdateEngagementActivationSchema,
  projectUpdateCaptureGenerationSchema,
  projectUpdateAssessmentRequestSchema,
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
  async policy() { return null; },
  async setPolicy() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async assess() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async latest() { return null; },
  async schedulePreview() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async scanScheduledProjects() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async activateEngagement() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async processShadowEngagements() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async processEngagements() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async invitation() { throw new ProjectUpdateError("UNAVAILABLE"); },
  async submitResponse() { throw new ProjectUpdateError("UNAVAILABLE"); },
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
}
