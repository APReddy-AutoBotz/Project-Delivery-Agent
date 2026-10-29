import { Controller, Get, HttpException, Inject, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { PmActionQueueError, type Actor, type PmActionQueueRepository } from "@pdaa/domain";
import { IdentityService } from "@pdaa/platform";

type Request = { headers: Record<string, string | undefined> };
export const PM_ACTION_QUEUE_REPOSITORY = "PM_ACTION_QUEUE_REPOSITORY";
export const unavailablePmActionQueueRepository: PmActionQueueRepository = {
  async read() { throw new PmActionQueueError("UNAVAILABLE"); },
};

@ApiTags("Action queue")
@ApiBearerAuth()
@Controller("api/pm")
export class PmActionQueueController {
  constructor(@Inject(PM_ACTION_QUEUE_REPOSITORY) private readonly repository: PmActionQueueRepository,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get("action-queue")
  async read(@Req() request: Request, @Query() query: unknown) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) throw new HttpException("", 401);
    let actor: Actor;
    try { actor = await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
    if (!z.strictObject({}).safeParse(query).success) throw new HttpException("", 400);
    try { return await this.repository.read(actor); }
    catch (error) {
      if (error instanceof PmActionQueueError) throw new HttpException("", error.code === "DENIED" ? 404 : 503);
      throw error;
    }
  }
}
