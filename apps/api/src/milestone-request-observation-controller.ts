import { Controller, Get, HttpException, Inject, Param, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { MilestoneConflictObservationError, milestoneRequestObservationSchema, projectFactIdSchema,
  type Actor, type MilestoneRequestObservationRepository } from "@pdaa/domain";
import { IdentityService } from "@pdaa/platform";

type Request = { headers: Record<string, string | undefined> };
export const MILESTONE_REQUEST_OBSERVATION_REPOSITORY = "MILESTONE_REQUEST_OBSERVATION_REPOSITORY";
export const unavailableMilestoneRequestObservationRepository: MilestoneRequestObservationRepository = {
  async readForLeaderManager() { throw new MilestoneConflictObservationError("UNAVAILABLE"); },
};

@ApiTags("Milestone request observation")
@ApiBearerAuth()
@Controller("api/projects/:id/milestones/:milestoneId")
export class MilestoneRequestObservationController {
  constructor(@Inject(MILESTONE_REQUEST_OBSERVATION_REPOSITORY) private readonly repository: MilestoneRequestObservationRepository,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get("leadership-manager-request-observation")
  async read(@Req() request: Request, @Param("id") projectId: string, @Param("milestoneId") milestoneId: string, @Query() query: unknown) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) throw new HttpException("", 401);
    let actor: Actor;
    try { actor = await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
    if (!projectFactIdSchema.safeParse(projectId).success || !projectFactIdSchema.safeParse(milestoneId).success) throw new HttpException("", 404);
    if (!z.strictObject({}).safeParse(query).success) throw new HttpException("", 400);
    try {
      const result = milestoneRequestObservationSchema.parse(await this.repository.readForLeaderManager(actor, projectId, milestoneId));
      if (result.observation.projectId !== projectId || result.observation.milestoneId !== milestoneId) throw new Error();
      return result;
    } catch (error) {
      if (error instanceof MilestoneConflictObservationError && error.code === "DENIED") throw new HttpException("", 404);
      throw new HttpException("", 503);
    }
  }
}
