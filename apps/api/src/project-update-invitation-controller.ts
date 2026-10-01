// FR-UPD-006 / NFR-SEC-001: authenticated locator, never bearer-link access.
import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { ProjectUpdateError, type Actor, type ProjectUpdateRepository } from "@pdaa/domain";
import { PROJECT_UPDATE_REPOSITORY } from "./project-update-controller.js";

@ApiTags("Project update responses")
@ApiBearerAuth()
@Controller("api/project-update-invitations/:locator")
export class ProjectUpdateInvitationController {
  constructor(@Inject(PROJECT_UPDATE_REPOSITORY) private readonly repository: ProjectUpdateRepository) {}

  private async run<T>(actor: Actor | undefined, operation: (actor: Actor) => Promise<T>) {
    if (!actor) throw new HttpException("", 401);
    try { return await operation(actor); }
    catch (error) {
      if (error instanceof ProjectUpdateError)
        throw new HttpException("", { INVALID_REQUEST: 400, DENIED: 404, FORBIDDEN: 403,
          CONFLICT: 409, UNAVAILABLE: 503 }[error.code]);
      throw error;
    }
  }

  @Get()
  invitation(@Req() req: { actor?: Actor }, @Param("locator") locator: string) {
    return this.run(req.actor, (actor) => this.repository.invitation(actor, locator));
  }

  @Post("responses")
  @HttpCode(201)
  submit(@Req() req: { actor?: Actor; correlationId: string }, @Param("locator") locator: string, @Body() body: unknown) {
    // The repository rechecks current permissions before interpreting this body,
    // including for retries of a previously stored submission.
    return this.run(req.actor, (actor) => this.repository.submitResponse(actor, locator, body, req.correlationId));
  }
}
