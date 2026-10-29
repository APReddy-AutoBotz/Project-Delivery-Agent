import { Controller, Get, HttpException, Inject, Param, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { ScalarConflictObservationError, scalarConflictObservationSchema, projectFactIdSchema,
  type Actor, type ScalarConflictObservationRepository } from "@pdaa/domain";
import { IdentityService } from "@pdaa/platform";

type Request = { headers: Record<string, string | undefined> };
export const SCALAR_CONFLICT_OBSERVATION_REPOSITORY = "SCALAR_CONFLICT_OBSERVATION_REPOSITORY";
export const unavailableScalarConflictObservationRepository: ScalarConflictObservationRepository = {
  async readLeadership() { throw new ScalarConflictObservationError("UNAVAILABLE"); },
};

@ApiTags("Scalar conflict observation")
@ApiBearerAuth()
@Controller("api/projects/:id/fact-observations/:factId")
export class ScalarConflictObservationController {
  constructor(@Inject(SCALAR_CONFLICT_OBSERVATION_REPOSITORY) private readonly repository: ScalarConflictObservationRepository,
    @Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get("leadership-conflict")
  async read(@Req() request: Request, @Param("id") projectId: string, @Param("factId") factId: string, @Query() query: unknown) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 16384) throw new HttpException("", 401);
    let actor: Actor;
    try { actor = await this.identity.authenticate(header.slice(7)); }
    catch { throw new HttpException("", 401); }
    if (!projectFactIdSchema.safeParse(projectId).success || !projectFactIdSchema.safeParse(factId).success) throw new HttpException("", 404);
    if (!z.strictObject({}).safeParse(query).success) throw new HttpException("", 400);
    try {
      const result = scalarConflictObservationSchema.parse(await this.repository.readLeadership(actor, projectId, factId));
      if (result.projectId !== projectId || result.factId !== factId) throw new Error();
      return result;
    } catch (error) {
      if (error instanceof ScalarConflictObservationError && error.code === "DENIED") throw new HttpException("", 404);
      throw new HttpException("", 503);
    }
  }
}
