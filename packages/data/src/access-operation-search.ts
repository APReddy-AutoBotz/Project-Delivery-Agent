import { z } from "zod";
import { accessOperationPositionSchema, accessOperationSearchFiltersSchema, recordedWallTimeSchema,
  type AccessOperationSearchRepository, type AccessOperationSearchFilters, type AccessOperationPosition,
  type AccessOperation, type Actor } from "@pdaa/domain";
import type { PrismaClient as Database } from "./generated/prisma/client.js";
import { sharedAccessOperationAdmission, type AccessOperationAdmission } from "./access-operation-admission.js";

const rowSchema = z.strictObject({ id: z.uuid(), actor: z.string().min(1).max(512),
  event: z.enum(["access.granted", "access.revoked"]), occurredAt: recordedWallTimeSchema });

// Not wired into the application: native concurrency, index and migration
// verification, operational monitoring and process-recovery tests remain gates.
export class DatabaseAccessOperationSearchRepository implements AccessOperationSearchRepository {
  constructor(private readonly db: Database, private readonly admission: AccessOperationAdmission = sharedAccessOperationAdmission) {}

  async search(actor: Actor, input: AccessOperationSearchFilters, after: AccessOperationPosition | null): Promise<AccessOperation[]> {
    if (!actor.roles.includes("system_admin")) throw new Error("Access operation search denied");
    try {
      const customerId = z.uuid().parse(actor.customerId), filters = accessOperationSearchFiltersSchema.parse(input);
      const position = after === null ? null : accessOperationPositionSchema.parse(after);
      if (position && (position.occurredAt < filters.from || position.occurredAt >= filters.until)) throw new Error();
      const lease = this.admission.acquire();
      if (!lease) throw new Error();
      let resolved = false;
      let result: unknown[] | null;
      try {
        result = await this.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3s'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='2s'");
        await tx.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout='5s'");
        // Two-int advisory keys occupy a separate PostgreSQL lock space from
        // this application's existing bigint locks. Keep these namespaces stable.
        const tenant = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
          'SELECT pg_catalog.pg_try_advisory_xact_lock(1346650450,pg_catalog.hashtext($1::text)) AS locked', customerId.toLowerCase());
        if (tenant.length !== 1 || typeof tenant[0]?.locked !== "boolean") throw new Error();
        if (!tenant[0].locked) return null;
        let granted = false;
        for (let slot = 0; slot < 4; slot++) {
          const attempt = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
            'SELECT pg_catalog.pg_try_advisory_xact_lock(1346650451,$1::integer) AS locked', slot);
          if (attempt.length !== 1 || typeof attempt[0]?.locked !== "boolean") throw new Error();
          if (attempt[0].locked) { granted = true; break; }
        }
        if (!granted) return null;
        return tx.$queryRawUnsafe<unknown[]>(
          `SELECT id, actor, event, to_char("occurredAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
           FROM public."AuditEvent"
           WHERE "customerId"=$1::uuid AND event COLLATE "C" IN ('access.granted','access.revoked')
             AND "occurredAt">=$2::timestamp AND "occurredAt"<$3::timestamp
             AND ($4::text IS NULL OR event COLLATE "C"=$4::text COLLATE "C") AND ($5::text IS NULL OR actor COLLATE "C"=$5::text COLLATE "C")
             AND ($6::timestamp IS NULL OR ("occurredAt",id)<($6::timestamp,$7::uuid))
           ORDER BY "occurredAt" DESC, id DESC LIMIT 31`,
          customerId, filters.from.slice(0, -1), filters.until.slice(0, -1), filters.action ?? null,
          filters.actor ?? null, position?.occurredAt.slice(0, -1) ?? null, position?.id ?? null,
        );
        }, { isolationLevel: "ReadCommitted", maxWait: 2000, timeout: 6000 });
        resolved = true; lease.complete();
      } finally { if (!resolved) lease.poison(); }
      if (result === null) throw new Error();
      const rows = z.array(rowSchema).max(31).parse(result);
      const seen = new Set<string>();
      let previous = position;
      for (const row of rows) {
        const id = row.id.toLowerCase();
        if ((filters.actor !== undefined && row.actor !== filters.actor) ||
          (filters.action !== undefined && row.event !== filters.action) ||
          row.occurredAt < filters.from || row.occurredAt >= filters.until || seen.has(id) ||
          (previous && (row.occurredAt > previous.occurredAt ||
            (row.occurredAt === previous.occurredAt && id >= previous.id.toLowerCase())))) throw new Error();
        seen.add(id); previous = { occurredAt: row.occurredAt, id };
      }
      return rows.map((row) => ({ ...row, occurredAt: new Date(row.occurredAt) }));
    } catch { throw new Error("Access operation search unavailable"); }
  }
}
