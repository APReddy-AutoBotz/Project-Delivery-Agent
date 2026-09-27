import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Inject,
  HttpCode,
  HttpException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IdentityService } from "@pdaa/platform";
import {
  HealthAssessmentError,
  healthAssessmentCommandSchema,
  healthAssessmentRetentionPolicySchema,
  blockerAgeThresholdPolicyChangeSchema,
  projectFactIdSchema,
  type Actor,
  type HealthAssessmentRepository,
} from "@pdaa/domain";

type Request = {
  headers: Record<string, string | undefined>;
  correlationId: string;
};
export const HEALTH_ASSESSMENT_REPOSITORY = "HEALTH_ASSESSMENT_REPOSITORY";
export const unavailableHealthAssessmentRepository: HealthAssessmentRepository = {
  async create() { throw new HealthAssessmentError("UNAVAILABLE"); },
  async latest() { throw new HealthAssessmentError("UNAVAILABLE"); },
  async retention() { throw new HealthAssessmentError("UNAVAILABLE"); },
  async setRetention() { throw new HealthAssessmentError("UNAVAILABLE"); },
  async blockerAgeThresholdPolicy() { throw new HealthAssessmentError("UNAVAILABLE"); },
  async setBlockerAgeThresholdPolicy() { throw new HealthAssessmentError("UNAVAILABLE"); },
};
@ApiTags("Health assessments")
@ApiBearerAuth()
@Controller("api")
export class HealthAssessmentController {
  constructor(
    @Inject(HEALTH_ASSESSMENT_REPOSITORY)
    private readonly repository: HealthAssessmentRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  private async actor(req: Request): Promise<Actor> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 16384)
      throw new HttpException("", 401);
    try { return await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
  }
  private async pmoAdmin(req: Request) {
    const actor = await this.actor(req);
    if (!actor.roles.includes("pmo_admin")) throw new HttpException("", 403);
    return actor;
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof HealthAssessmentError) {
        const status = {
          INVALID_REQUEST: 400,
          DENIED: 404,
          FORBIDDEN: 403,
          CONFLICT: 409,
          IDEMPOTENCY_RESULT_EXPIRED: 409,
          RETENTION_REQUIRED: 503,
          UNAVAILABLE: 503,
        }[error.code];
        throw new HttpException("", status);
      }
      throw error;
    }
  }
  @Post("projects/:id/health-assessments")
  @HttpCode(201)
  async create(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const actor = await this.actor(req);
    if (!projectFactIdSchema.safeParse(id).success) throw new HttpException("", 404);
    const command = healthAssessmentCommandSchema.safeParse(body);
    if (!command.success) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.create(actor, id, command.data.commandKey, req.correlationId),
    );
  }
  @Get("projects/:id/health-assessments/latest")
  async latest(@Req() req: Request, @Param("id") id: string) {
    const actor = await this.actor(req);
    if (!projectFactIdSchema.safeParse(id).success) throw new HttpException("", 404);
    return this.run(() => this.repository.latest(actor, id));
  }
  @Get("admin/health-assessment-retention")
  async retention(@Req() req: Request) {
    const actor = await this.pmoAdmin(req);
    return this.run(() => this.repository.retention(actor));
  }
  @Post("admin/health-assessment-retention")
  @HttpCode(200)
  async setRetention(@Req() req: Request, @Body() body: unknown) {
    const actor = await this.pmoAdmin(req);
    const policy = healthAssessmentRetentionPolicySchema.safeParse(body);
    if (!policy.success) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.setRetention(actor, policy.data, req.correlationId),
    );
  }
  @Get("admin/blocker-age-threshold-policy")
  async blockerAgeThresholdPolicy(@Req() req: Request) {
    const actor = await this.pmoAdmin(req);
    return this.run(() => this.repository.blockerAgeThresholdPolicy(actor));
  }
  @Post("admin/blocker-age-threshold-policy")
  @HttpCode(200)
  async setBlockerAgeThresholdPolicy(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const actor = await this.pmoAdmin(req);
    const policy = blockerAgeThresholdPolicyChangeSchema.safeParse(body);
    if (!policy.success) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.setBlockerAgeThresholdPolicy(
        actor,
        policy.data,
        req.correlationId,
      ),
    );
  }
}
