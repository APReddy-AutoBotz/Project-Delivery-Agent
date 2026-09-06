import "reflect-metadata";
import {
  completeContract,
  grantSchema,
  revokeSchema,
  developmentSchema,
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
import {
  SwaggerModule,
  DocumentBuilder,
  ApiBearerAuth,
  ApiTags,
} from "@nestjs/swagger";
import { z } from "zod";
import { type Actor, type ProjectRepository } from "@pdaa/domain";
import { IdentityService, operationalLog, type Config } from "@pdaa/platform";

type Request = {
  headers: Record<string, string | undefined>;
  actor?: Actor;
  correlationId: string;
  method: string;
};
const REPOSITORY = "PROJECT_REPOSITORY";
const CONFIG = "APP_CONFIG";

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
  @Get("audit") async audit(@Req() req: Request) {
    const rows = await this.repository.listAudit(await this.admin(req));
    return rows.map((row) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
    }));
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
) {
  @Module({
    controllers: [FoundationController],
    providers: [
      { provide: CONFIG, useValue: config },
      { provide: REPOSITORY, useValue: repository },
      { provide: IdentityService, useValue: identity },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
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
