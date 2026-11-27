import { Controller, Get, HttpException, Inject, InternalServerErrorException, Param, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { BlockerAgeAdviceError, projectFactIdSchema, type Actor, type BlockerAgeAdviceRepository } from "@pdaa/domain";
import { IdentityService } from "@pdaa/platform";

type Request = { headers: Record<string, string | undefined> };
export const BLOCKER_AGE_ADVICE_REPOSITORY = "BLOCKER_AGE_ADVICE_REPOSITORY";
export const unavailableBlockerAgeAdviceRepository: BlockerAgeAdviceRepository = {
  async readLeadership() { throw new BlockerAgeAdviceError("UNAVAILABLE"); },
  async readScrumMaster() { throw new BlockerAgeAdviceError("UNAVAILABLE"); },
};

@ApiTags("Blocker-age review")
@ApiBearerAuth()
@Controller("api/projects/:id")
export class BlockerAgeAdviceController {
  constructor(@Inject(BLOCKER_AGE_ADVICE_REPOSITORY) private readonly repository: BlockerAgeAdviceRepository,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get("leadership-blocker-age-suggestions")
  read(@Req() request: Request, @Param("id") projectId: string, @Query() query: unknown) {
    return this.readAudience(request, projectId, query, "leadership");
  }

  @Get("scrum-master-blocker-age-suggestions")
  readScrumMaster(@Req() request: Request, @Param("id") projectId: string, @Query() query: unknown) {
    return this.readAudience(request, projectId, query, "scrum_master");
  }

  private async readAudience(request: Request, projectId: string, query: unknown, audience: "leadership" | "scrum_master") {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) throw new HttpException("", 401);
    let actor: Actor;
    try { actor = await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
    if (!projectFactIdSchema.safeParse(projectId).success) throw new HttpException("", 404);
    if (!z.strictObject({}).safeParse(query).success) throw new HttpException("", 400);
    try {
      const result = audience === "leadership" ? await this.repository.readLeadership(actor, projectId)
        : await this.repository.readScrumMaster(actor, projectId);
      if (result.projectId !== projectId || result.audience !== audience) throw new InternalServerErrorException();
      return result;
    }
    catch (error) {
      if (error instanceof BlockerAgeAdviceError) throw new HttpException("", error.code === "DENIED" ? 404 : 503);
      throw error;
    }
  }
}
