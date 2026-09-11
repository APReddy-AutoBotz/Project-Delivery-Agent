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
  projectFactIdSchema,
  humanStatementSchema,
  factHistoryRequestSchema,
  factCatalogueRequestSchema,
  sourceAccessChangeSchema,
  authorityPolicyChangeSchema,
  assessmentCaptureSchema,
  type Actor,
  type ProjectFactRepository,
  type AuthorityRepository,
} from "@pdaa/domain";

export const FACT_REPOSITORY = "PROJECT_FACT_REPOSITORY";
export const AUTHORITY_REPOSITORY = "AUTHORITY_REPOSITORY";
const unavailable = async (): Promise<never> => {
  throw new Error("Evidence repository unavailable");
};
export const unavailableFactRepository: ProjectFactRepository = {
  listFacts: unavailable,
  getHistory: unavailable,
  appendHumanStatement: unavailable,
  getSourceAccess: unavailable,
  setSourceAccess: unavailable,
};
export const unavailableAuthorityRepository: AuthorityRepository = {
  appendPolicy: unavailable,
  getActivePolicy: unavailable,
  captureAssessment: unavailable,
  getAssessment: unavailable,
};
const integerQuery = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})$/)
  .transform(Number);
export const catalogueQuerySchema = z.strictObject({
  afterFactType: humanStatementSchema.shape.factType.optional(),
  limit: integerQuery.optional(),
});
export const historyQuerySchema = z.strictObject({
  afterRevision: integerQuery.optional(),
  throughRevision: integerQuery.optional(),
  limit: integerQuery.optional(),
});
type Request = {
  headers: Record<string, string | undefined>;
  correlationId: string;
};

@ApiTags("Project evidence")
@ApiBearerAuth()
@Controller("api/projects/:id")
export class EvidenceController {
  constructor(
    @Inject(FACT_REPOSITORY) private readonly facts: ProjectFactRepository,
    @Inject(AUTHORITY_REPOSITORY)
    private readonly authority: AuthorityRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  private async actor(req: Request, id: string): Promise<Actor> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 16384)
      throw new HttpException("", 401);
    let actor: Actor;
    try {
      actor = await this.identity.authenticate(header.slice(7));
    } catch {
      throw new HttpException("", 401);
    }
    if (!projectFactIdSchema.safeParse(id).success)
      throw new HttpException("", 404);
    // A valid OIDC identity can have no configured business role. It is a
    // denied capability, not an invalid client-supplied fact request.
    if (actor.roles.length === 0) throw new HttpException("", 404);
    return actor;
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new HttpException("", 400);
    return result.data;
  }
  private target(factType: string) {
    if (!humanStatementSchema.shape.factType.safeParse(factType).success)
      throw new HttpException("", 404);
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
            REVISION_CONFLICT: 409,
            IDEMPOTENCY_CONFLICT: 409,
            SOURCE_RESTRICTED: 404,
          }[error.code],
        );
      throw new HttpException("", 503);
    }
    if (result === null) throw new HttpException("", 404);
    return result;
  }
  @Get("facts") async catalogue(
    @Req() req: Request,
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    const actor = await this.actor(req, id);
    const request = this.parse(factCatalogueRequestSchema, {
      projectId: id,
      ...this.parse(catalogueQuerySchema, query),
    });
    return this.run(() => this.facts.listFacts(actor, request));
  }
  @Get("facts/:factType/history") async history(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("factType") factType: string,
    @Query() query: unknown,
  ) {
    const actor = await this.actor(req, id);
    this.target(factType);
    const request = this.parse(factHistoryRequestSchema, {
      projectId: id,
      factType,
      ...this.parse(historyQuerySchema, query),
    });
    return this.run(() => this.facts.getHistory(actor, request));
  }
  @Post("fact-statements")
  @HttpCode(201)
  async statement(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id),
      request = this.parse(humanStatementSchema, body);
    if (request.projectId !== id) throw new HttpException("", 400);
    return this.run(() =>
      this.facts.appendHumanStatement(actor, request, {
        correlationId: req.correlationId,
      }),
    );
  }
  @Get("fact-sources/:sourceId/access") async access(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("sourceId") sourceId: string,
  ) {
    const actor = await this.actor(req, id);
    if (!projectFactIdSchema.safeParse(sourceId).success)
      throw new HttpException("", 404);
    return this.run(() =>
      this.facts.getSourceAccess(actor, { projectId: id, sourceId }),
    );
  }
  @Post("fact-sources/:sourceId/access")
  @HttpCode(200)
  async changeAccess(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("sourceId") sourceId: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id),
      request = this.parse(sourceAccessChangeSchema, body);
    if (request.projectId !== id || request.sourceId !== sourceId)
      throw new HttpException("", 400);
    return this.run(() =>
      this.facts.setSourceAccess(actor, request, {
        correlationId: req.correlationId,
      }),
    );
  }
  @Get("facts/:factType/authority") async policy(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("factType") factType: string,
  ) {
    const actor = await this.actor(req, id);
    this.target(factType);
    return this.run(() =>
      this.authority.getActivePolicy(actor, { projectId: id, factType }),
    );
  }
  @Post("authority-policies")
  @HttpCode(201)
  async changePolicy(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id),
      request = this.parse(authorityPolicyChangeSchema, body);
    if (request.projectId !== id) throw new HttpException("", 400);
    return this.run(() =>
      this.authority.appendPolicy(actor, request, {
        correlationId: req.correlationId,
      }),
    );
  }
  @Post("assessments")
  @HttpCode(201)
  async capture(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req, id),
      request = this.parse(assessmentCaptureSchema, body);
    if (request.projectId !== id) throw new HttpException("", 400);
    return this.run(() =>
      this.authority.captureAssessment(actor, request, {
        correlationId: req.correlationId,
      }),
    );
  }
  @Get("assessments/:assessmentId") async assessment(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("assessmentId") assessmentId: string,
  ) {
    const actor = await this.actor(req, id);
    if (!projectFactIdSchema.safeParse(assessmentId).success)
      throw new HttpException("", 404);
    return this.run(() =>
      this.authority.getAssessment(actor, { projectId: id, assessmentId }),
    );
  }
}
