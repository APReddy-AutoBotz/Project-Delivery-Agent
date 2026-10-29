import { Controller, Get, HttpException, Inject, InternalServerErrorException, Param, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { BlockerAgeAdviceError, projectFactIdSchema, type Actor, type BlockerAgeAdviceRepository } from "@pdaa/domain";
import { IdentityService } from "@pdaa/platform";

type Request = { headers: Record<string, string | undefined> };
export const BLOCKER_AGE_ADVICE_REPOSITORY = "BLOCKER_AGE_ADVICE_REPOSITORY";
export const unavailableBlockerAgeAdviceRepository: BlockerAgeAdviceRepository = {
  async readLeadership() { throw new BlockerAgeAdviceError("UNAVAILABLE"); },
};

@ApiTags("Blocker-age review")
@ApiBearerAuth()
@Controller("api/projects/:id")
export class BlockerAgeAdviceController {
  constructor(@Inject(BLOCKER_AGE_ADVICE_REPOSITORY) private readonly repository: BlockerAgeAdviceRepository,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get("leadership-blocker-age-suggestions")
  async read(@Req() request: Request, @Param("id") projectId: string, @Query() query: unknown) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) throw new HttpException("", 401);
    let actor: Actor;
    try { actor = await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
    if (!projectFactIdSchema.safeParse(projectId).success) throw new HttpException("", 404);
    if (!z.strictObject({}).safeParse(query).success) throw new HttpException("", 400);
    try {
      const result = await this.repository.readLeadership(actor, projectId);
      if (result.projectId !== projectId || result.audience !== "leadership") throw new InternalServerErrorException();
      return result;
    }
    catch (error) {
      if (error instanceof BlockerAgeAdviceError) throw new HttpException("", error.code === "DENIED" ? 404 : 503);
      throw error;
    }
  }
}
