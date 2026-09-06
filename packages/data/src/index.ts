import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import type { Actor, Grant, ProjectRepository } from "@pdaa/domain";

export function createDatabase(
  connection: string | import("@pdaa/platform").DatabaseTransport,
) {
  return new PrismaClient({
    adapter: new PrismaPg({
      ...(typeof connection === "string"
        ? { connectionString: connection }
        : connection),
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    }),
  });
}
export type Database = ReturnType<typeof createDatabase>;
const projectSelect = {
  id: true,
  portfolioId: true,
  code: true,
  name: true,
  description: true,
  reportedStatus: true,
} as const;
export class DatabaseProjectRepository implements ProjectRepository {
  constructor(readonly db: Database) {}
  private async scope(actor: Actor) {
    const grants = await this.db.accessGrant.findMany({
      where: { customerId: actor.customerId, subject: actor.subject },
    });
    // Do not rely on ORM normalization of an empty OR nested under AND.
    if (grants.length === 0) return null;
    return {
      customerId: actor.customerId,
      OR: grants.map((g) =>
        g.scopeType === "portfolio"
          ? { portfolioId: g.scopeId }
          : { id: g.scopeId },
      ),
    };
  }
  async listProjects(actor: Actor) {
    const scope = await this.scope(actor);
    if (!scope) return [];
    return this.db.project.findMany({
      where: scope,
      orderBy: { code: "asc" },
      select: projectSelect,
    });
  }
  async getProject(actor: Actor, id: string) {
    const scope = await this.scope(actor);
    if (!scope) return null;
    return this.db.project.findFirst({
      where: { AND: [scope, { id }] },
      select: projectSelect,
    });
  }
  private checkAdministrator(actor: Actor) {
    if (
      !actor.roles.includes("system_admin") &&
      !actor.roles.includes("pmo_admin")
    )
      throw new Error("Access administration denied");
  }
  async setGrant(actor: Actor, grant: Grant, correlationId: string) {
    this.checkAdministrator(actor);
    await this.db.$transaction(async (tx) => {
      const exists =
        grant.scopeType === "project"
          ? await tx.project.findFirst({
              where: { customerId: actor.customerId, id: grant.scopeId },
            })
          : await tx.portfolio.findFirst({
              where: { customerId: actor.customerId, id: grant.scopeId },
            });
      if (!exists) throw new Error("Scope unavailable");
      const key = {
        customerId: actor.customerId,
        subject: grant.subject,
        scopeType: grant.scopeType,
        scopeId: grant.scopeId,
      };
      await tx.accessGrant.upsert({
        where: { customerId_subject_scopeType_scopeId: key },
        create: { ...key, role: grant.role },
        update: { role: grant.role },
      });
      await tx.auditEvent.create({
        data: {
          customerId: actor.customerId,
          actor: actor.subject,
          event: "access.granted",
          correlationId,
          detail: { ...grant },
        },
      });
    });
  }
  async revokeGrant(
    actor: Actor,
    grant: Omit<Grant, "role">,
    correlationId: string,
  ) {
    this.checkAdministrator(actor);
    await this.db.$transaction(async (tx) => {
      await tx.accessGrant.deleteMany({
        where: { customerId: actor.customerId, ...grant },
      });
      await tx.auditEvent.create({
        data: {
          customerId: actor.customerId,
          actor: actor.subject,
          event: "access.revoked",
          correlationId,
          detail: { ...grant },
        },
      });
    });
  }
  async listAudit(actor: Actor) {
    this.checkAdministrator(actor);
    return this.db.auditEvent.findMany({
      where: { customerId: actor.customerId },
      select: { id: true, event: true, actor: true, occurredAt: true },
      orderBy: { occurredAt: "desc" },
      take: 30,
    });
  }
  async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
  async heartbeat() {
    return (
      (await this.db.serviceHeartbeat.findUnique({ where: { id: "worker" } }))
        ?.occurredAt ?? null
    );
  }
}
