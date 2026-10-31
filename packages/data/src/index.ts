import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
export { DatabasePmActionQueueRepository } from "./pm-action-queue.js";
export { DatabaseBlockerAgeAdviceRepository } from "./blocker-age-advice.js";
export { DatabaseAccessOperationSearchRepository } from "./access-operation-search.js";
export { createAccessOperationAdmission } from "./access-operation-admission.js";
export { DatabaseProjectFactRepository } from "./project-facts.js";
export { DatabaseAuthorityRepository } from "./authority-persistence.js";
export { DatabaseMilestoneConsistencyRepository } from "./milestone-persistence.js";
export { DatabaseMilestoneReconciliationRepository } from "./milestone-reconciliation.js";
export { DatabaseScalarReconciliationRepository } from "./scalar-reconciliation.js";
export { DatabaseCanonicalProjectRepository } from "./canonical-project.js";
export { DatabaseIngestionRepository } from "./ingestion-persistence.js";
export { DatabaseHealthAssessmentRepository } from "./health-assessment.js";
export { DatabaseProjectUpdateRepository } from "./project-updates.js";
export { IngestionPersistenceError } from "@pdaa/domain";
export { DatabaseConnectorRuntimeRepository } from "./connector-runtime.js";
export type { JiraOAuthAccess, JiraOAuthCredential, JiraCredentialRotation } from "./connector-runtime.js";
export { ConnectorRuntimeError } from "./connector-runtime.js";
import type {
  Actor,
  Grant,
  AccessOperation,
  ProjectRepository,
  WorkerHeartbeatRepository,
} from "@pdaa/domain";

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
      query_timeout: 10000,
      idleTimeoutMillis: 10000,
    }),
  });
}
export type Database = ReturnType<typeof createDatabase>;
export class DatabaseWorkerHeartbeatRepository
  implements WorkerHeartbeatRepository
{
  constructor(private readonly db: Database) {}
  async recordHeartbeat(occurredAt: Date): Promise<void> {
    await this.db.serviceHeartbeat.upsert({
      where: { id: "worker" },
      create: { id: "worker", occurredAt },
      update: { occurredAt },
    });
  }
}
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
    // Deprecated compatibility entry: retain the same scoped role boundary.
    return this.listAccessOperations(actor);
  }
  async listAccessOperations(actor: Actor): Promise<AccessOperation[]> {
    // Identity administration is an operational system-administrator function.
    // This role is scoped to the authenticated customer, not a project grant.
    if (!actor.roles.includes("system_admin"))
      throw new Error("Access operation history denied");
    const rows = await this.db.auditEvent.findMany({
      where: { customerId: actor.customerId, event: { in: ["access.granted", "access.revoked"] } },
      select: { id: true, event: true, actor: true, occurredAt: true },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 30,
    });
    return rows.map((row) => {
      if (row.event !== "access.granted" && row.event !== "access.revoked")
        throw new Error("Invalid access operation");
      return { ...row, event: row.event };
    });
  }
  async ready() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.db.$queryRaw`SELECT 1`.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 3000);
        }),
      ]);
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
  async heartbeat() {
    return (
      (await this.db.serviceHeartbeat.findUnique({ where: { id: "worker" } }))
        ?.occurredAt ?? null
    );
  }
}
export * from "./milestone-conflict-observation.js";
export * from "./scalar-conflict-observation.js";
export * from "./milestone-state-disagreement.js";
