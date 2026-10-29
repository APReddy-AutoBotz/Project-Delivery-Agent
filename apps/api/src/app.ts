import "reflect-metadata";
import { MilestoneConflictObservationController, MILESTONE_CONFLICT_OBSERVATION_REPOSITORY, unavailableMilestoneConflictObservationRepository } from "./milestone-conflict-observation-controller.js";
import { ScalarConflictObservationController, SCALAR_CONFLICT_OBSERVATION_REPOSITORY, unavailableScalarConflictObservationRepository } from "./scalar-conflict-observation-controller.js";
import { ProjectUpdateInvitationController } from "./project-update-invitation-controller.js";
import { PmActionQueueController, PM_ACTION_QUEUE_REPOSITORY, unavailablePmActionQueueRepository } from "./pm-action-queue-controller.js";
import { BlockerAgeAdviceController, BLOCKER_AGE_ADVICE_REPOSITORY, unavailableBlockerAgeAdviceRepository } from "./blocker-age-advice-controller.js";
import { installProjectUpdateInvitationBoundary, isProjectUpdateInvitationPath } from "./project-update-invitation-boundary.js";
import {
  ScalarReconciliationController,
  SCALAR_RECONCILIATION_REPOSITORY,
  unavailableScalarReconciliationRepository,
} from "./scalar-reconciliation-controller.js";
import {
  MilestoneController,
  RECONCILIATION_REPOSITORY,
  unavailableReconciliationRepository,
} from "./milestone-controller.js";
import {
  EvidenceController,
  FACT_REPOSITORY,
  AUTHORITY_REPOSITORY,
  unavailableFactRepository,
  unavailableAuthorityRepository,
} from "./evidence-controller.js";
import {
  HealthAssessmentController,
  HEALTH_ASSESSMENT_REPOSITORY,
  unavailableHealthAssessmentRepository,
} from "./health-assessment-controller.js";
import {
  ProjectUpdateController,
  PROJECT_UPDATE_REPOSITORY,
  unavailableProjectUpdateRepository,
} from "./project-update-controller.js";
import {
  CanonicalController,
  CANONICAL_REPOSITORY,
  unavailableCanonicalRepository,
} from "./canonical-controller.js";
import {
  IngestionController,
  IngestionIdentityGuard,
  INGESTION_REPOSITORY,
  unavailableIngestionRepository,
} from "./ingestion-controller.js";
import {
  completeContract,
  errorMessages,
  grantSchema,
  revokeSchema,
  developmentSchema,
  accessOperationWireSchema,
} from "./contract.js";
import { ResponseContractInterceptor } from "./response-contract.js";
import { ExceptionContractFilter } from "./exception-contract.js";
import { randomUUID } from "node:crypto";
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Inject,
  Module,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  HttpCode,
  HttpException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  SwaggerModule,
  DocumentBuilder,
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";
import {
  type Actor,
  type ProjectRepository,
  type CanonicalProjectRepository,
  type ProjectFactRepository,
  type AuthorityRepository,
  type MilestoneReconciliationRepository,
  type ScalarReconciliationRepository,
  type IngestionRepository,
  type ScheduleAdviceHealthRepository,
  type ProjectUpdateRepository,
  type PmActionQueueRepository,
  type BlockerAgeAdviceRepository,
  type MilestoneConflictObservationRepository,
} from "@pdaa/domain";
import { IdentityService, operationalLog, type Config } from "@pdaa/platform";

type Request = {
  headers: Record<string, string | undefined>;
  actor?: Actor;
  correlationId: string;
  method: string;
};
const REPOSITORY = "PROJECT_REPOSITORY";
const CONFIG = "APP_CONFIG";

// NFR-SEC-001: body-parser 2.4 adds zstd. Preserve the prior encodings on
// requests that would be consumed by these parsers, including their error shape.
type ParserRequest = {
  url?: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  is(type: string): string | false | null;
};
type ParserResponse = { status(code: number): ParserResponse; json(value: unknown): void };
function rejectZstdForParser(
  matches: (request: ParserRequest) => boolean,
) {
  return (request: ParserRequest, response: ParserResponse, next: () => void) => {
    const encoding = request.headers["content-encoding"];
    const hasBody = request.headers["transfer-encoding"] !== undefined ||
      request.headers["content-length"] !== undefined;
    if (hasBody && typeof encoding === "string" && encoding.toLowerCase() === "zstd" && matches(request)) {
      response.status(415).json({ statusCode: 415, message: errorMessages[415] });
      return;
    }
    next();
  };
}
function isInternalTextRequest(request: { url?: string; method?: string }) {
  const pathname = request.url?.split("?", 1)[0] ?? "";
  return request.method === "POST" &&
    (pathname.startsWith("/internal/connectors/") ||
      pathname.startsWith("/internal/project-updates/") ||
      pathname.startsWith("/webhooks/jira/"));
}

@ApiTags("Foundation")
@ApiBearerAuth()
@Controller("api")
class FoundationController {
  constructor(
    @Inject(REPOSITORY) private readonly repository: ProjectRepository,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  private async actor(request: Request): Promise<Actor> {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 16384)
      throw new UnauthorizedException("Sign-in required");
    try {
      return await this.identity.authenticate(header.slice(7));
    } catch {
      throw new UnauthorizedException("Session unavailable");
    }
  }
  private async admin(request: Request): Promise<Actor> {
    const actor = await this.actor(request);
    if (!actor.roles.some((r) => r === "system_admin" || r === "pmo_admin"))
      throw new ForbiddenException("Administrator access required");
    return actor;
  }
  @Get("health/live") live() {
    return { status: "ok" };
  }
  @Get("health/ready") async ready() {
    if (!(await this.repository.ready()))
      throw new HttpException("Database unavailable", 503);
    return { status: "ok" };
  }
  @Get("auth/config") authConfig() {
    return {
      mode: this.config.AUTH_MODE,
      dataMode: this.config.DATA_MODE,
      issuer: this.config.OIDC_ISSUER,
      clientId: this.config.OIDC_CLIENT_ID,
      audience: this.config.OIDC_AUDIENCE,
      scope: this.config.OIDC_SCOPE,
      resource: this.config.OIDC_RESOURCE,
    };
  }
  @Post("auth/development")
  @HttpCode(200)
  async development(@Body() body: unknown) {
    if (this.config.AUTH_MODE !== "development") throw new NotFoundException();
    const input = developmentSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("Invalid persona");
    return { token: await this.identity.developmentToken(input.data.persona) };
  }
  @Get("me") async me(@Req() req: Request) {
    return this.actor(req);
  }
  @Get("projects") async projects(@Req() req: Request) {
    return this.repository.listProjects(await this.actor(req));
  }
  @Get("projects/:id") async project(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const actor = await this.actor(req);
    if (!z.uuid().safeParse(id).success)
      throw new NotFoundException("Project unavailable");
    const project = await this.repository.getProject(actor, id);
    if (!project) throw new NotFoundException("Project unavailable");
    return project;
  }
  @Get("platform") async platform(@Req() req: Request) {
    await this.admin(req);
    const heartbeat = await this.repository.heartbeat();
    return {
      database: (await this.repository.ready()) ? "connected" : "unavailable",
      worker:
        heartbeat && Date.now() - heartbeat.getTime() < 90000
          ? "running"
          : "unavailable",
      heartbeat: heartbeat?.toISOString() ?? null,
      shadowMode: this.config.SHADOW_MODE === "true",
      identityMode: this.config.AUTH_MODE,
      dataMode: this.config.DATA_MODE,
    };
  }
  @ApiOperation({ deprecated: true, description: "Deprecated system-administrator access-operation view. Other audit events and PMO-only access are unavailable." })
  @Get("audit") async audit(@Req() req: Request) {
    // Deprecated alias for the scoped operational view; the old generic feed
    // was not project-scoped and must not disclose other audit event types.
    return this.accessOperations(req, {});
  }
  @Get("access-operations") async accessOperations(@Req() req: Request, @Query() query: unknown) {
    const actor = await this.actor(req);
    if (!actor.roles.includes("system_admin"))
      throw new ForbiddenException("Administrator access required");
    if (!z.strictObject({}).safeParse(query).success)
      throw new BadRequestException("Invalid request");
    try {
      const rows = await this.repository.listAccessOperations(actor);
      const wire = rows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
      if (!accessOperationWireSchema.safeParse(wire).success)
        throw new Error("Invalid access operation history");
      return wire;
    } catch {
      throw new HttpException("Access operation history unavailable", 503);
    }
  }
  @Post("access-grants")
  @HttpCode(204)
  async grant(@Req() req: Request, @Body() body: unknown) {
    const actor = await this.admin(req);
    const input = grantSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("Invalid access grant");
    try {
      await this.repository.setGrant(actor, input.data, req.correlationId);
    } catch (error) {
      if (error instanceof Error && error.message === "Scope unavailable")
        throw new NotFoundException("Scope unavailable");
      throw error;
    }
  }
  @Delete("access-grants")
  @HttpCode(204)
  async revoke(@Req() req: Request, @Body() body: unknown) {
    const actor = await this.admin(req);
    const input = revokeSchema.safeParse(body);
    if (!input.success) throw new BadRequestException("Invalid access grant");
    await this.repository.revokeGrant(actor, input.data, req.correlationId);
  }
}

export async function createApp(
  config: Config,
  repository: ProjectRepository,
  identity = new IdentityService(config),
  canonical: CanonicalProjectRepository = unavailableCanonicalRepository,
  facts: ProjectFactRepository = unavailableFactRepository,
  authority: AuthorityRepository = unavailableAuthorityRepository,
  reconciliation: MilestoneReconciliationRepository = unavailableReconciliationRepository,
  scalarReconciliation: ScalarReconciliationRepository = unavailableScalarReconciliationRepository,
  preJsonBodyParser?: (app: NestExpressApplication) => void,
  ingestion: IngestionRepository = unavailableIngestionRepository,
  healthAssessment: ScheduleAdviceHealthRepository = unavailableHealthAssessmentRepository,
  projectUpdates: ProjectUpdateRepository = unavailableProjectUpdateRepository,
  pmActionQueue: PmActionQueueRepository = unavailablePmActionQueueRepository,
  blockerAgeAdvice: BlockerAgeAdviceRepository = unavailableBlockerAgeAdviceRepository,
  milestoneConflictObservation: MilestoneConflictObservationRepository = unavailableMilestoneConflictObservationRepository,
  scalarConflictObservation: import("@pdaa/domain").ScalarConflictObservationRepository = unavailableScalarConflictObservationRepository,
) {
  @Module({
    controllers: [
      FoundationController,
      CanonicalController,
      EvidenceController,
      MilestoneController,
      ScalarReconciliationController,
      IngestionController,
      HealthAssessmentController,
      ProjectUpdateController,
      ProjectUpdateInvitationController,
      PmActionQueueController,
      BlockerAgeAdviceController,
      MilestoneConflictObservationController,
      ScalarConflictObservationController,
    ],
    providers: [
      { provide: CONFIG, useValue: config },
      { provide: REPOSITORY, useValue: repository },
      { provide: CANONICAL_REPOSITORY, useValue: canonical },
      { provide: FACT_REPOSITORY, useValue: facts },
      { provide: AUTHORITY_REPOSITORY, useValue: authority },
      { provide: RECONCILIATION_REPOSITORY, useValue: reconciliation },
      {
        provide: SCALAR_RECONCILIATION_REPOSITORY,
        useValue: scalarReconciliation,
      },
      { provide: IdentityService, useValue: identity },
      { provide: INGESTION_REPOSITORY, useValue: ingestion },
      { provide: HEALTH_ASSESSMENT_REPOSITORY, useValue: healthAssessment },
      { provide: PROJECT_UPDATE_REPOSITORY, useValue: projectUpdates },
      { provide: PM_ACTION_QUEUE_REPOSITORY, useValue: pmActionQueue },
      { provide: BLOCKER_AGE_ADVICE_REPOSITORY, useValue: blockerAgeAdvice },
      { provide: MILESTONE_CONFLICT_OBSERVATION_REPOSITORY, useValue: milestoneConflictObservation },
      { provide: SCALAR_CONFLICT_OBSERVATION_REPOSITORY, useValue: scalarConflictObservation },
      IngestionIdentityGuard,
    ],
  })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, rawBody: true, bodyParser: false });
  app.useGlobalInterceptors(new ResponseContractInterceptor());
  app.useGlobalFilters(new ExceptionContractFilter(app.getHttpAdapter()));
  app.enableCors({
    origin: config.APP_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  app.use(
    (
      req: Request,
      res: {
        setHeader: (k: string, v: string) => void;
        on: (event: string, fn: () => void) => void;
        statusCode: number;
      },
      next: () => void,
    ) => {
      const start = performance.now();
      req.correlationId = randomUUID();
      res.setHeader("X-Request-Id", req.correlationId);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.on("finish", () =>
        operationalLog("http.request", {
          correlationId: req.correlationId,
          method: req.method,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - start),
        }),
      );
      next();
    },
  );
  app.use(rejectZstdForParser(isInternalTextRequest));
  app.useBodyParser("text", {
    limit: "1mb",
    type: (request) => {
      return isInternalTextRequest(request);
    },
  });
  preJsonBodyParser?.(app);
  installProjectUpdateInvitationBoundary(app, identity, config.APP_ORIGIN);
  app.use(rejectZstdForParser((request) => Boolean(request.is("application/json"))));
  app.useBodyParser("json", { limit: "64kb", inflate: false,
    type: (request) => request.method === "POST" && isProjectUpdateInvitationPath(request.url) });
  app.useBodyParser("json", { limit: "100kb" });
  const spec = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Delivery Assurance Foundation")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build(),
  );
  // Generate the contract locally; interactive endpoint is limited to synthetic development.
  completeContract(spec);
  if (config.NODE_ENV !== "production" && config.DATA_MODE === "synthetic")
    SwaggerModule.setup("api/docs", app, spec);
  return { app, spec };
}
