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
import {
  ProjectFactError,
  projectFactIdSchema,
  projectFactInstantSchema,
  stateBindingCreateSchema,
  milestoneConsistencyCaptureSchema,
  reconciliationAssignmentRefreshSchema,
  reconciliationListSchema,
  type Actor,
  type MilestoneReconciliationRepository,
} from "@pdaa/domain";

export const RECONCILIATION_REPOSITORY = "MILESTONE_RECONCILIATION_REPOSITORY";
const unavailable = async (): Promise<never> => {
  throw new Error("Reconciliation repository unavailable");
};
export const unavailableReconciliationRepository: MilestoneReconciliationRepository =
  {
    createStateBinding: unavailable,
    getContext: unavailable,
    check: unavailable,
    list: unavailable,
    get: unavailable,
    refreshAssignment: unavailable,
  };
export const reconciliationQuerySchema = z
  .strictObject({
    afterCreatedAt: projectFactInstantSchema.optional(),
    afterId: projectFactIdSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|1[0-9]|20)$/)
      .optional(),
  })
  .refine(
    (query) =>
      (query.afterCreatedAt === undefined) === (query.afterId === undefined),
  );
type Request = {
  headers: Record<string, string | undefined>;
  correlationId: string;
};

// FR-EVD-009 / NFR-SEC-001: identity comes only from the validated bearer token.
@ApiTags("Milestone reconciliation")
@ApiBearerAuth()
@Controller("api/projects/:id")
export class MilestoneController {
  constructor(
    @Inject(RECONCILIATION_REPOSITORY)
    private readonly repository: MilestoneReconciliationRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  private async actor(req: Request, ...ids: string[]): Promise<Actor> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 16384)
      throw new HttpException("", 401);
    let actor: Actor;
    try {
      actor = await this.identity.authenticate(header.slice(7));
    } catch {
      throw new HttpException("", 401);
    }
    if (
      !actor.roles.length ||
      ids.some((id) => !projectFactIdSchema.safeParse(id).success)
    )
      throw new HttpException("", 404);
    return actor;
  }
  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new HttpException("", 400);
    return result.data;
  }
  private async run<T>(operation: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
      result = await operation();
    } catch (error) {
      if (error instanceof ProjectFactError)
        throw new HttpException(
          "",
          {
            INVALID_REQUEST: 400,
            DENIED: 404,
            SOURCE_RESTRICTED: 404,
            REVISION_CONFLICT: 409,
            IDEMPOTENCY_CONFLICT: 409,
          }[error.code],
        );
      throw new HttpException("", 503);
    }
    if (result === null) throw new HttpException("", 404);
    return result;
  }
  @Post("state-bindings")
  @HttpCode(201)
  async binding(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id),
      input = this.parse(stateBindingCreateSchema, body);
    if (input.projectId !== id) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.createStateBinding(actor, input, {
        correlationId: req.correlationId,
      }),
    );
  }
  @Get("milestones/:milestoneId/reconciliation-context")
  async context(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("milestoneId") milestoneId: string,
  ) {
    const actor = await this.actor(req, id, milestoneId);
    return this.run(() =>
      this.repository.getContext(actor, { projectId: id, milestoneId }),
    );
  }
  @Post("milestone-reconciliation-checks")
  @HttpCode(201)
  async check(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id),
      input = this.parse(milestoneConsistencyCaptureSchema, body);
    if (input.projectId !== id) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.check(actor, input, { correlationId: req.correlationId }),
    );
  }
  private async queue(
    req: Request,
    id: string,
    query: unknown,
    mode: "manage" | "recipient",
  ) {
    const actor = await this.actor(req, id),
      input = this.parse(reconciliationQuerySchema, query);
    const list = this.parse(reconciliationListSchema, {
      projectId: id,
      limit: input.limit ? Number(input.limit) : 20,
      after:
        input.afterCreatedAt && input.afterId
          ? { createdAt: input.afterCreatedAt, id: input.afterId }
          : null,
    });
    return this.run(() => this.repository.list(actor, list, mode));
  }
  // Static manage route must precede the dynamic request UUID route.
  @Get("reconciliation-requests/manage")
  manage(
    @Req() req: Request,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    return this.queue(req, id, query, "manage");
  }
  @Get("reconciliation-requests")
  list(@Req() req: Request, @Param("id") id: string, @Query() query: unknown) {
    return this.queue(req, id, query, "recipient");
  }
  @Get("reconciliation-requests/:requestId")
  async detail(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("requestId") requestId: string,
  ) {
    const actor = await this.actor(req, id, requestId);
    return this.run(() =>
      this.repository.get(actor, { projectId: id, requestId }),
    );
  }
  @Post("reconciliation-requests/:requestId/assignment")
  @HttpCode(201)
  async assignment(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id, requestId),
      input = this.parse(reconciliationAssignmentRefreshSchema, body);
    if (input.projectId !== id || input.requestId !== requestId)
      throw new HttpException("", 400);
    return this.run(() =>
      this.repository.refreshAssignment(actor, input, {
        correlationId: req.correlationId,
      }),
    );
  }
}
