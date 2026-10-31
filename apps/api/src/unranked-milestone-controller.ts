import { Controller, Get, HttpException, Inject, Param, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { MilestoneStateDisagreementError, projectFactIdSchema, unrankedMilestoneObservationSchema,
  type Actor, type UnrankedMilestoneObservationRepository } from "@pdaa/domain";
import { IdentityService } from "@pdaa/platform";

type Request = { headers: Record<string, string | undefined> };
const pathId = projectFactIdSchema.regex(/^[0-9a-f-]+$/);
export const UNRANKED_MILESTONE_REPOSITORY = "UNRANKED_MILESTONE_REPOSITORY";
export const unavailableUnrankedMilestoneRepository: UnrankedMilestoneObservationRepository = {
  async readUnrankedLeadership() { throw new MilestoneStateDisagreementError("UNAVAILABLE"); },
};

// Deliberately unregistered: this boundary is local work until the complete
// authorization, native, contract and browser evidence has been reviewed.
@ApiTags("Unranked milestone reports")
@ApiBearerAuth()
@Controller("api/projects/:id/milestones/:milestoneId")
export class UnrankedMilestoneController {
  constructor(@Inject(UNRANKED_MILESTONE_REPOSITORY) private readonly repository: UnrankedMilestoneObservationRepository,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get("leadership-unranked-state-reports")
  async read(@Req() request: Request, @Param("id") projectId: string, @Param("milestoneId") milestoneId: string, @Query() query: unknown) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) throw new HttpException("", 401);
    let actor: Actor;
    try { actor = await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
    if (!pathId.safeParse(projectId).success || !pathId.safeParse(milestoneId).success) throw new HttpException("", 404);
    if (!z.strictObject({}).safeParse(query).success) throw new HttpException("", 400);
    try {
      const result = unrankedMilestoneObservationSchema.parse(await this.repository.readUnrankedLeadership(actor, projectId, milestoneId));
      if (result.projectId !== projectId || result.milestoneId !== milestoneId) throw new Error();
      return result;
    } catch (error) {
      if (error instanceof MilestoneStateDisagreementError && error.code === "DENIED") throw new HttpException("", 404);
      throw new HttpException("", 503);
    }
  }
}
