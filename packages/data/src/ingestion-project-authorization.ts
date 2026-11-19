import { IngestionPersistenceError, type Actor } from "@pdaa/domain";
import type { Prisma } from "./generated/prisma/client.js";

export const ingestionWriteRoles: readonly string[] = ["project_manager", "portfolio_manager", "pmo_admin"];

export function currentRoleMatches(actor: Actor, role: string) {
  return actor.roles.some((candidate) => candidate === role);
}

export async function authorizeIngestionProjects(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Actor,
  projectsInput: readonly string[],
  action: "read" | "write" | "configure",
  projectLimit = 100,
) {
  const projectIds = [...new Set(projectsInput)].sort();
  // Configuration changes must check every historic grant and both scopes.
  if (!projectIds.length || (action !== "configure" && projectIds.length > projectLimit))
    throw new IngestionPersistenceError("DENIED");
  const projects = action === "read"
    ? await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
        SELECT id,"portfolioId" FROM public."Project"
        WHERE "customerId"=${actor.customerId}::uuid AND id=ANY(${projectIds}::uuid[])
        ORDER BY id FOR SHARE`
    : await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
        SELECT id,"portfolioId" FROM public."Project"
        WHERE "customerId"=${actor.customerId}::uuid AND id=ANY(${projectIds}::uuid[])
        ORDER BY id FOR UPDATE`;
  if (projects.length !== projectIds.length)
    throw new IngestionPersistenceError("DENIED");
  const portfolioIds = [...new Set(projects.map((project) => project.portfolioId))].sort();
  const grants = await tx.$queryRaw<
    { id: string; scopeType: string; scopeId: string; role: string }[]
  >`
    SELECT id,"scopeType","scopeId",role FROM public."AccessGrant"
    WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject}
      AND (("scopeType"='project' AND "scopeId"=ANY(${projectIds}::uuid[]))
        OR ("scopeType"='portfolio' AND "scopeId"=ANY(${portfolioIds}::uuid[])))
    ORDER BY id FOR SHARE`;
  const allowed: readonly string[] =
    action === "read"
      ? ["leadership", "project_manager", "portfolio_manager", "pmo_admin"]
      : action === "write"
        ? ingestionWriteRoles
        : ["pmo_admin"];
  const eligible = grants.filter((grant) =>
    allowed.includes(grant.role) && currentRoleMatches(actor, grant.role));
  const allowedProjects = new Set(eligible.filter((grant) => grant.scopeType === "project").map((grant) => grant.scopeId));
  const allowedPortfolios = new Set(eligible.filter((grant) => grant.scopeType === "portfolio").map((grant) => grant.scopeId));
  for (const project of projects)
    if (!allowedProjects.has(project.id) && !allowedPortfolios.has(project.portfolioId))
      throw new IngestionPersistenceError("DENIED");
  return { projectIds, projects, grants };
}
