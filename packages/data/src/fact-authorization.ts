import {
  ProjectFactError,
  projectFactIdSchema,
  projectFactSubjectSchema,
  roleSchema,
  roles as recognizedRoles,
  type Actor,
} from "@pdaa/domain";
import type { Prisma } from "./generated/prisma/client.js";

export function actorInput(value: Actor): Actor {
  try {
    if (
      !value ||
      Object.keys(value).sort().join() !== "customerId,roles,subject"
    )
      throw new Error();
    const subject = projectFactSubjectSchema.parse(value.subject);
    const customerId = projectFactIdSchema.parse(value.customerId);
    if (
      !Array.isArray(value.roles) ||
      !value.roles.length ||
      value.roles.length > recognizedRoles.length
    )
      throw new Error();
    const roles = value.roles.map((role) => roleSchema.parse(role));
    if (new Set(roles).size !== roles.length) throw new Error();
    return { subject, customerId, roles };
  } catch {
    throw new ProjectFactError("INVALID_REQUEST");
  }
}
export function factInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new ProjectFactError("INVALID_REQUEST");
  }
}
// NFR-SEC-001: one project-then-current-grant lock order across fact operations.
export async function authorizeFactProject(
  tx: Prisma.TransactionClient,
  actor: Actor,
  projectId: string,
  action: "read" | "append" | "access" | "capture",
) {
  const projects =
    action === "read"
      ? await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
      SELECT id,"portfolioId" FROM "Project"
      WHERE "customerId"=${actor.customerId}::uuid AND id=${projectId}::uuid FOR SHARE`
      : await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
      SELECT id,"portfolioId" FROM "Project"
      WHERE "customerId"=${actor.customerId}::uuid AND id=${projectId}::uuid FOR UPDATE`;
  if (!projects[0]) throw new ProjectFactError("DENIED");
  const grants = await tx.$queryRaw<{ role: string }[]>`
    SELECT role FROM "AccessGrant"
    WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject}
      AND (("scopeType"='project' AND "scopeId"=${projectId}::uuid)
        OR ("scopeType"='portfolio' AND "scopeId"=${projects[0].portfolioId}::uuid))
    ORDER BY id FOR SHARE`;
  const allowed =
    action === "read" || action === "capture"
      ? ["leadership", "project_manager", "pmo_admin"]
      : action === "append"
        ? ["project_manager", "pmo_admin"]
        : ["pmo_admin"];
  if (
    !grants.some(
      (grant) =>
        allowed.includes(grant.role) &&
        actor.roles.some((role) => role === grant.role),
    )
  )
    throw new ProjectFactError("DENIED");
}
