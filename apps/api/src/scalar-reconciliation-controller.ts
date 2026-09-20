import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  Inject,
  HttpCode,
  HttpException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { IdentityService } from "@pdaa/platform";
import {
  ProjectFactError,
  humanStatementSchema,
  projectFactIdSchema,
  scalarReconciliationAssignmentRefreshSchema,
  scalarReconciliationCheckRequestSchema,
  scalarReconciliationContextReadSchema,
  scalarReconciliationListSchema,
  scalarReconciliationReadSchema,
  scalarReconciliationResolveSchema,
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
    getContext: unavailable,
    check: unavailable,
    list: unavailable,
    get: unavailable,
    refreshAssignment: unavailable,
    resolve: unavailable,
  };

type Request = {
  headers: Record<string, string | undefined>;
  correlationId: string;
};

// FR-EVD-007/009/012, FR-ADM-005, NFR-REL-001/002: scoped generic scalar reconciliation endpoints.
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

  private factTypeParam(factType: string) {
    if (!humanStatementSchema.shape.factType.safeParse(factType).success)
      throw new HttpException("", 404);
  }

  @Get("facts/:factType/reconciliation-context")
  async getContext(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("factType") factType: string,
  ) {
    this.factTypeParam(factType);
    const actor = await this.actor(req, id);
    return this.run(() =>
      this.repository.getContext(actor, { projectId: id, factType }),
    );
  }

  @Post("facts/:factType/reconciliation-checks")
  @HttpCode(201)
  async check(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("factType") factType: string,
    @Body() body: unknown,
  ) {
    this.factTypeParam(factType);
    const actor = await this.actor(req, id),
      input = this.parse(scalarReconciliationCheckRequestSchema, body);
    if (input.projectId !== id || input.factType !== factType)
      throw new HttpException("", 400);
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

  @Get("scalar-reconciliation-requests/manage")
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
      input = this.parse(scalarReconciliationAssignmentRefreshSchema, body);
    if (input.projectId !== id || input.requestId !== requestId)
      throw new HttpException("", 400);
    return this.run(() =>
      this.repository.refreshAssignment(actor, input, {
        correlationId: req.correlationId,
      }),
    );
  }

  @Post("scalar-reconciliation-requests/:requestId/resolve")
  @HttpCode(201)
  async resolve(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("requestId") requestId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id, requestId),
      input = this.parse(scalarReconciliationResolveSchema, body);
    if (input.projectId !== id || input.requestId !== requestId)
      throw new HttpException("", 400);
    return this.run(() =>
      this.repository.resolve(actor, input, {
        correlationId: req.correlationId,
      }),
    );
  }
}
