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
  scalarReconciliationCheckBodySchema,
  scalarReconciliationAssignmentBodySchema,
  scalarReconciliationListSchema,
  type Actor,
  type ScalarReconciliationRepository,
} from "@pdaa/domain";
import { reconciliationQuerySchema } from "./milestone-controller.js";

export const SCALAR_RECONCILIATION_REPOSITORY =
  "SCALAR_RECONCILIATION_REPOSITORY";
const unavailable = async (): Promise<never> => {
  throw new Error("Scalar reconciliation repository unavailable");
};
export const unavailableScalarReconciliationRepository: ScalarReconciliationRepository =
  {
    check: unavailable,
    list: unavailable,
    get: unavailable,
    refreshAssignment: unavailable,
  };
type Request = {
  headers: Record<string, string | undefined>;
  correlationId: string;
};

// FR-EVD-009 / NFR-SEC-001: route scope and validated identity are server-owned.
@ApiTags("Scalar reconciliation")
@ApiBearerAuth()
@Controller("api/projects/:id")
export class ScalarReconciliationController {
  constructor(
    @Inject(SCALAR_RECONCILIATION_REPOSITORY)
    private readonly repository: ScalarReconciliationRepository,
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
  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
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
      throw new HttpException("", 500);
    }
    if (result === null) throw new HttpException("", 404);
    return result;
  }
  @Post("scalar-reconciliation-checks")
  @HttpCode(201)
  async check(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id),
      input = this.parse(scalarReconciliationCheckBodySchema, body);
    return this.run(() =>
      this.repository.check(
        actor,
        { projectId: id, ...input },
        { correlationId: req.correlationId },
      ),
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
    const list = this.parse(scalarReconciliationListSchema, {
      projectId: id,
      limit: input.limit ? Number(input.limit) : 20,
      after:
        input.afterCreatedAt && input.afterId
          ? { createdAt: input.afterCreatedAt, id: input.afterId }
          : null,
    });
    return this.run(() => this.repository.list(actor, list, mode));
  }
  @Get("managed-scalar-reconciliation-requests")
  manage(
    @Req() req: Request,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    return this.queue(req, id, query, "manage");
  }
  @Get("scalar-reconciliation-requests")
  list(@Req() req: Request, @Param("id") id: string, @Query() query: unknown) {
    return this.queue(req, id, query, "recipient");
  }
  @Get("scalar-reconciliation-requests/:requestId")
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
  @Post("scalar-reconciliation-requests/:requestId/assignment")
  @HttpCode(201)
  async assignment(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id, requestId),
      input = this.parse(scalarReconciliationAssignmentBodySchema, body);
    return this.run(() =>
      this.repository.refreshAssignment(
        actor,
        { projectId: id, requestId, ...input },
        { correlationId: req.correlationId },
      ),
    );
  }
}
