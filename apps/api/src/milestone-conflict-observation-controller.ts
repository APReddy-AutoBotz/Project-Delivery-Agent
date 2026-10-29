import { Controller, Get, HttpException, Inject, Param, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { MilestoneConflictObservationError, milestoneConflictObservationSchema, projectFactIdSchema,
  type Actor, type MilestoneConflictObservationRepository } from "@pdaa/domain";
import { IdentityService } from "@pdaa/platform";

type Request = { headers: Record<string, string | undefined> };
export const MILESTONE_CONFLICT_OBSERVATION_REPOSITORY = "MILESTONE_CONFLICT_OBSERVATION_REPOSITORY";
export const unavailableMilestoneConflictObservationRepository: MilestoneConflictObservationRepository = {
  async readLeadership() { throw new MilestoneConflictObservationError("UNAVAILABLE"); },
};

@ApiTags("Milestone conflict observation")
@ApiBearerAuth()
@Controller("api/projects/:id/milestones/:milestoneId")
export class MilestoneConflictObservationController {
  constructor(@Inject(MILESTONE_CONFLICT_OBSERVATION_REPOSITORY) private readonly repository: MilestoneConflictObservationRepository,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get("leadership-conflict-observation")
  async read(@Req() request: Request, @Param("id") projectId: string, @Param("milestoneId") milestoneId: string, @Query() query: unknown) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) throw new HttpException("", 401);
    let actor: Actor;
    try { actor = await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
    if (!projectFactIdSchema.safeParse(projectId).success || !projectFactIdSchema.safeParse(milestoneId).success) throw new HttpException("", 404);
    if (!z.strictObject({}).safeParse(query).success) throw new HttpException("", 400);
    try {
      const result = milestoneConflictObservationSchema.parse(await this.repository.readLeadership(actor, projectId, milestoneId));
      if (result.projectId !== projectId || result.milestoneId !== milestoneId) throw new Error();
      return result;
    } catch (error) {
      if (error instanceof MilestoneConflictObservationError && error.code === "DENIED") throw new HttpException("", 404);
      throw new HttpException("", 503);
    }
  }
}
