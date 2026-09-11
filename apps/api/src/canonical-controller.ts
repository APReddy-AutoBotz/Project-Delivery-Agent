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
  CanonicalProjectError,
  canonicalProgrammeCreateSchema,
  canonicalProjectCreateSchema,
  projectFactIdSchema,
  type Actor,
  type CanonicalProjectRepository,
} from "@pdaa/domain";
type Request = {
  headers: Record<string, string | undefined>;
  correlationId: string;
};
export const CANONICAL_REPOSITORY = "CANONICAL_PROJECT_REPOSITORY";
export const unavailableCanonicalRepository: CanonicalProjectRepository = {
  async setup() {
    throw new CanonicalProjectError("UNAVAILABLE");
  },
  async createProgramme() {
    throw new CanonicalProjectError("UNAVAILABLE");
  },
  async createProject() {
    throw new CanonicalProjectError("UNAVAILABLE");
  },
  async detail() {
    throw new CanonicalProjectError("UNAVAILABLE");
  },
};
@ApiTags("Canonical projects")
@ApiBearerAuth()
@Controller("api")
export class CanonicalController {
  constructor(
    @Inject(CANONICAL_REPOSITORY)
    private readonly repository: CanonicalProjectRepository,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}
  private async actor(req: Request): Promise<Actor> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 16384)
      throw new HttpException("", 401);
    try {
      return await this.identity.authenticate(header.slice(7));
    } catch {
      throw new HttpException("", 401);
    }
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CanonicalProjectError)
        throw new HttpException(
          "",
          {
            INVALID_REQUEST: 400,
            DENIED: 404,
            CONFLICT: 409,
            UNAVAILABLE: 503,
          }[error.code],
        );
      throw error;
    }
  }
  @Get("project-setup") async setup(@Req() req: Request) {
    const actor = await this.actor(req);
    return this.run(() => this.repository.setup(actor));
  }
  @Post("portfolios/:id/programmes")
  @HttpCode(201)
  async programme(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(req);
    if (!projectFactIdSchema.safeParse(id).success)
      throw new HttpException("", 404);
    const input = canonicalProgrammeCreateSchema.safeParse(body);
    if (!input.success) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.createProgramme(actor, id, input.data, req.correlationId),
    );
  }
  @Post("projects")
  @HttpCode(201)
  async create(@Req() req: Request, @Body() body: unknown) {
    const actor = await this.actor(req);
    const input = canonicalProjectCreateSchema.safeParse(body);
    if (!input.success) throw new HttpException("", 400);
    return this.run(() =>
      this.repository.createProject(actor, input.data, req.correlationId),
    );
  }
  @Get("projects/:id/canonical") async detail(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const actor = await this.actor(req);
    if (!projectFactIdSchema.safeParse(id).success)
      throw new HttpException("", 404);
    return this.run(() => this.repository.detail(actor, id));
  }
}
