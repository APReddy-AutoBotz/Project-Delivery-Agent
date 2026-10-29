import { buildPmActionQueue, PmActionQueueError, projectFactIdSchema,
  type Actor, type PmActionQueue, type PmActionQueueRepository } from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import { actorInput } from "./fact-authorization.js";
import { DatabaseHealthAssessmentRepository } from "./health-assessment.js";
import { DatabaseProjectUpdateRepository } from "./project-updates.js";
import { blockerThresholdInTransaction, observeBlockerAgeAdviceInTransaction } from "./blocker-age-advice.js";

type Tx = Prisma.TransactionClient;
const discoverSql = `SELECT p.id FROM public."Project" p
  WHERE p."customerId"=$1::uuid
    AND EXISTS (SELECT 1 FROM public."CanonicalProject" c WHERE c."customerId"=p."customerId" AND c.id=p.id AND c."portfolioId"=p."portfolioId")
    AND EXISTS (SELECT 1 FROM public."ProjectResponsibility" r WHERE r."customerId"=p."customerId" AND r."projectId"=p.id AND r.role='PROJECT_MANAGER' AND r.subject=$2)
    AND EXISTS (SELECT 1 FROM public."AccessGrant" g WHERE g."customerId"=p."customerId" AND g.subject=$2 AND g.role='project_manager'
      AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
  ORDER BY p.id LIMIT 26`;

// EXEC-026 / FR-RPT-002 / NFR-SEC-001: the actor is authenticated by the
// application. No caller can supply a project list or an evidence snapshot.
export class DatabasePmActionQueueRepository implements PmActionQueueRepository {
  private readonly health: DatabaseHealthAssessmentRepository;
  private readonly updates: DatabaseProjectUpdateRepository;
  constructor(private readonly db: Database) {
    this.health = new DatabaseHealthAssessmentRepository(db);
    this.updates = new DatabaseProjectUpdateRepository(db);
  }

  private async discover(tx: Tx, actor: Actor): Promise<string[]> {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(discoverSql, actor.customerId, actor.subject);
    if (rows.length > 25) throw new PmActionQueueError("UNAVAILABLE");
    const ids = rows.map((row) => projectFactIdSchema.parse(row.id));
    if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]! >= id))
      throw new PmActionQueueError("UNAVAILABLE");
    return ids;
  }

  async read(value: Actor): Promise<PmActionQueue> {
    let actor: Actor;
    try { actor = actorInput(value); }
    catch { throw new PmActionQueueError("DENIED"); }
    if (!actor.roles.includes("project_manager")) throw new PmActionQueueError("DENIED");
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='8s'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
        const ids = await this.discover(tx, actor);
        // Separate ordered lock statements prevent a wait from fixing the
        // snapshot of any dependent authorization or observation query.
        for (const id of ids) {
          const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
            'SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE', actor.customerId, id);
          if (rows.length !== 1 || rows[0]!.id !== id) throw new PmActionQueueError("UNAVAILABLE");
        }
        const authorized: { id: string; name: string }[] = [];
        for (const id of ids) {
          const rows = await tx.$queryRawUnsafe<{ name: string; portfolioId: string }[]>(
            'SELECT name,"portfolioId" FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid', actor.customerId, id);
          const current = rows[0];
          if (!current || rows.length !== 1) throw new PmActionQueueError("UNAVAILABLE");
          // Lock the actual qualifying grant before either reader can fall back
          // to a leadership audience. Assignment membership is immutable once
          // its canonical parent is sealed under the project gate.
          const grants = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=$2 AND role='project_manager'
              AND (("scopeType"='project' AND "scopeId"=$3::uuid) OR ("scopeType"='portfolio' AND "scopeId"=$4::uuid)) ORDER BY id FOR SHARE`,
            actor.customerId, actor.subject, id, current.portfolioId);
          const assignment = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT r.id FROM public."ProjectResponsibility" r JOIN public."CanonicalProject" c
              ON c."customerId"=r."customerId" AND c.id=r."projectId"
              WHERE r."customerId"=$1::uuid AND r."projectId"=$2::uuid AND r.role='PROJECT_MANAGER' AND r.subject=$3 AND c.sealed ORDER BY r.id LIMIT 1`,
            actor.customerId, id, actor.subject);
          if (!grants.length || assignment.length !== 1) throw new PmActionQueueError("UNAVAILABLE");
          authorized.push({ id, name: current.name });
        }
        // The shared customer threshold gate precedes every schedule policy
        // gate, and all project and grant locks are acquired in ID order.
        const threshold = ids.length ? await blockerThresholdInTransaction(tx, actor.customerId) : null;
        const projects = [];
        for (const { id, name } of authorized) {
          const schedule = await this.health.scheduleSuggestionsInTransaction(tx, actor, id);
          const update = await this.updates.updateSuggestionsInTransaction(tx, actor, id);
          const blockerAge = await observeBlockerAgeAdviceInTransaction(tx, this.db, actor, id, "project_manager", threshold, true);
          if (schedule.audience !== "project_manager" || update.audience !== "project_manager") throw new PmActionQueueError("UNAVAILABLE");
          projects.push({ projectId: id, name, schedule, update, blockerAge });
        }
        const final = await this.discover(tx, actor);
        if (JSON.stringify(ids) !== JSON.stringify(final)) throw new PmActionQueueError("UNAVAILABLE");
        return buildPmActionQueue(projects);
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 20000 });
    } catch { throw new PmActionQueueError("UNAVAILABLE"); }
  }
}
