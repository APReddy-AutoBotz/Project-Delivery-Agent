import { createHash, randomUUID } from "node:crypto";
import {
  canonicalActorSchema,
  canonicalProjectCreateSchema,
  canonicalProgrammeCreateSchema,
  canonicalProjectDetailSchema,
  canonicalDateFields,
  emptyCanonicalDates,
  CanonicalProjectError,
  projectFactIdSchema,
  type Actor,
  type CanonicalDates,
  type CanonicalProjectCreate,
  type CanonicalProgrammeCreate,
  type CanonicalProjectDetail,
  type CanonicalProjectRepository,
} from "@pdaa/domain";
import type {
  Prisma,
  PrismaClient as Database,
} from "./generated/prisma/client.js";
type Tx = Prisma.TransactionClient;
const administrators = ["pmo_admin", "portfolio_manager"];
const readers = [...administrators, "leadership", "project_manager"];
const input = <T>(parse: () => T): T => {
  try {
    return parse();
  } catch {
    throw new CanonicalProjectError("INVALID_REQUEST");
  }
};
const wireDates = (
  row: Record<(typeof canonicalDateFields)[number], Date | null>,
): CanonicalDates =>
  Object.fromEntries(
    canonicalDateFields.map((key) => [
      key,
      row[key]?.toISOString().slice(0, 10) ?? null,
    ]),
  ) as CanonicalDates;
const storageDates = (dates: CanonicalDates) =>
  Object.fromEntries(
    canonicalDateFields.map((key) => [
      key,
      dates[key] === null ? null : new Date(dates[key] + "T00:00:00.000Z"),
    ]),
  ) as Record<(typeof canonicalDateFields)[number], Date | null>;
const hash = (operation: string, value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify({ operation, value }))
    .digest("hex");
const counts = (value: CanonicalProjectCreate) => ({
  responsibilitiesCount: value.responsibilities.length,
  sprintsCount: value.sprints.length,
  milestonesCount: value.milestones.length,
  workItemsCount: value.workItems.length,
  requiredWorkItemsCount: value.requiredWorkItems.length,
  raidItemsCount: value.raidItems.length,
  sourceMappingsCount: value.sourceMappings.length,
});
const programmeSelect = { id: true, code: true, name: true } as const;

export class DatabaseCanonicalProjectRepository
  implements CanonicalProjectRepository
{
  constructor(private readonly db: Database) {}
  private async transaction<T>(
    actorValue: Actor,
    operation: (tx: Tx, actor: Actor) => Promise<T>,
  ): Promise<T> {
    const actor = input(() => canonicalActorSchema.parse(actorValue));
    try {
      return await this.db.$transaction((tx) => operation(tx, actor), {
        timeout: 10000,
      });
    } catch (error) {
      if (error instanceof CanonicalProjectError) throw error;
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["P2002", "P2034"].includes(String(error.code))
      )
        throw new CanonicalProjectError("CONFLICT");
      throw new CanonicalProjectError("UNAVAILABLE");
    }
  }
  private async grants(
    tx: Tx,
    actor: Actor,
    portfolioId: string,
    projectId?: string,
  ) {
    const rows = await tx.$queryRaw<
      { role: string }[]
    >`SELECT role FROM "AccessGrant"
      WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject}
      AND (("scopeType"='portfolio' AND "scopeId"=${portfolioId}::uuid)
        OR ("scopeType"='project' AND "scopeId"=${projectId ?? null}::uuid)) ORDER BY id FOR SHARE`;
    return rows
      .filter((row) => actor.roles.some((role) => role === row.role))
      .map((row) => row.role);
  }
  private async authorizeParent(tx: Tx, actor: Actor, portfolioId: string) {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Portfolio" WHERE id=${portfolioId}::uuid AND "customerId"=${actor.customerId}::uuid FOR UPDATE`;
    if (
      !rows.length ||
      !(await this.grants(tx, actor, portfolioId)).some((role) =>
        administrators.includes(role),
      )
    )
      throw new CanonicalProjectError("DENIED");
  }
  async setup(actorValue: Actor) {
    return this.transaction(actorValue, async (tx, actor) => {
      const roles = actor.roles.filter((role) => administrators.includes(role));
      if (!roles.length) return { portfolios: [], truncated: false };
      const grants = await tx.accessGrant.findMany({
        where: {
          customerId: actor.customerId,
          subject: actor.subject,
          scopeType: "portfolio",
          role: { in: roles },
        },
        select: { scopeId: true },
      });
      const selected = await tx.portfolio.findMany({
        where: {
          customerId: actor.customerId,
          id: { in: grants.map((g) => g.scopeId) },
        },
        orderBy: { id: "asc" },
        take: 101,
        select: { id: true },
      });
      const permitted: string[] = [];
      for (const row of selected) {
        const locked = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "Portfolio" WHERE id=${row.id}::uuid AND "customerId"=${actor.customerId}::uuid FOR SHARE`;
        if (
          locked.length &&
          (await this.grants(tx, actor, row.id)).some((role) =>
            administrators.includes(role),
          )
        )
          permitted.push(row.id);
      }
      const rows = await tx.portfolio.findMany({
        where: {
          customerId: actor.customerId,
          id: { in: permitted },
        },
        orderBy: { id: "asc" },
        take: 101,
        select: {
          id: true,
          name: true,
          programme_portfolio: {
            select: programmeSelect,
            orderBy: { code: "asc" },
            take: 101,
          },
        },
      });
      return {
        truncated: selected.length > 100,
        portfolios: rows.slice(0, 100).map((row) => ({
          id: row.id,
          name: row.name,
          programmes: row.programme_portfolio.slice(0, 100),
          programmesTruncated: row.programme_portfolio.length > 100,
        })),
      };
    });
  }
  async createProgramme(
    actorValue: Actor,
    portfolioValue: string,
    value: CanonicalProgrammeCreate,
    correlationId: string,
  ) {
    const portfolioId = input(() => projectFactIdSchema.parse(portfolioValue));
    const data = input(() => canonicalProgrammeCreateSchema.parse(value));
    const requestHash = hash("PROGRAMME", data);
    return this.transaction(actorValue, async (tx, actor) => {
      await this.authorizeParent(tx, actor, portfolioId);
      const key = {
        customerId: actor.customerId,
        portfolioId,
        subject: actor.subject,
        idempotencyKey: data.idempotencyKey,
      };
      const prior = await tx.canonicalCreationReceipt.findUnique({
        where: { customerId_portfolioId_subject_idempotencyKey: key },
      });
      if (prior) {
        if (
          prior.requestHash !== requestHash ||
          prior.operation !== "PROGRAMME" ||
          !prior.programmeId
        )
          throw new CanonicalProjectError("CONFLICT");
        return tx.programme.findUniqueOrThrow({
          where: { id: prior.programmeId },
          select: programmeSelect,
        });
      }
      const row = await tx.programme.create({
        data: {
          id: randomUUID(),
          customerId: actor.customerId,
          portfolioId,
          code: data.code,
          name: data.name,
          createdBy: actor.subject,
        },
        select: programmeSelect,
      });
      await tx.canonicalCreationReceipt.create({
        data: {
          id: randomUUID(),
          ...key,
          operation: "PROGRAMME",
          requestHash,
          programmeId: row.id,
        },
      });
      await tx.auditEvent.create({
        data: {
          customerId: actor.customerId,
          actor: actor.subject,
          event: "programme.created",
          correlationId,
          detail: { portfolioId, programmeId: row.id },
        },
      });
      return row;
    });
  }
  async createProject(
    actorValue: Actor,
    value: CanonicalProjectCreate,
    correlationId: string,
  ) {
    const data = input(() => canonicalProjectCreateSchema.parse(value));
    const requestHash = hash("PROJECT", data);
    return this.transaction(actorValue, async (tx, actor) => {
      await this.authorizeParent(tx, actor, data.portfolioId);
      const key = {
        customerId: actor.customerId,
        portfolioId: data.portfolioId,
        subject: actor.subject,
        idempotencyKey: data.idempotencyKey,
      };
      const prior = await tx.canonicalCreationReceipt.findUnique({
        where: { customerId_portfolioId_subject_idempotencyKey: key },
      });
      if (prior) {
        if (
          prior.requestHash !== requestHash ||
          prior.operation !== "PROJECT" ||
          !prior.projectId
        )
          throw new CanonicalProjectError("CONFLICT");
        return { id: prior.projectId };
      }
      if (
        data.programmeId &&
        !(await tx.programme.findFirst({
          where: {
            id: data.programmeId,
            customerId: actor.customerId,
            portfolioId: data.portfolioId,
          },
          select: { id: true },
        }))
      )
        throw new CanonicalProjectError("DENIED");
      const id = randomUUID();
      const scope = { customerId: actor.customerId, projectId: id };
      await tx.project.create({
        data: {
          id,
          customerId: actor.customerId,
          portfolioId: data.portfolioId,
          code: data.code,
          name: data.name,
          description: data.description,
          reportedStatus: data.reportedStatus,
        },
      });
      await tx.canonicalProject.create({
        data: {
          id,
          customerId: actor.customerId,
          portfolioId: data.portfolioId,
          programmeId: data.programmeId,
          createdBy: actor.subject,
          ...storageDates(data.dates),
          ...counts(data),
        },
      });
      const sprints = new Map(
        data.sprints.map((row) => [row.key, randomUUID()]),
      );
      const milestones = new Map(
        data.milestones.map((row) => [row.key, randomUUID()]),
      );
      const workItems = new Map(
        data.workItems.map((row) => [row.key, randomUUID()]),
      );
      const raidItems = new Map(
        data.raidItems.map((row) => [row.key, randomUUID()]),
      );
      if (data.responsibilities.length)
        await tx.projectResponsibility.createMany({
          data: data.responsibilities.map((row) => ({
            ...scope,
            id: randomUUID(),
            ...row,
          })),
        });
      if (data.sprints.length)
        await tx.sprint.createMany({
          data: data.sprints.map((row) => ({
            ...scope,
            id: sprints.get(row.key)!,
            key: row.key,
            name: row.name,
            ...storageDates(row.dates),
          })),
        });
      if (data.milestones.length)
        await tx.milestone.createMany({
          data: data.milestones.map((row) => ({
            ...scope,
            id: milestones.get(row.key)!,
            key: row.key,
            name: row.name,
            state: row.state,
            ...storageDates(row.dates),
          })),
        });
      if (data.workItems.length)
        await tx.workItem.createMany({
          data: data.workItems.map((row) => ({
            ...scope,
            id: workItems.get(row.key)!,
            key: row.key,
            title: row.title,
            state: row.state,
            sprintId: row.sprintKey ? sprints.get(row.sprintKey)! : null,
            ...storageDates(row.dates),
          })),
        });
      if (data.requiredWorkItems.length)
        await tx.requiredWorkItem.createMany({
          data: data.requiredWorkItems.map((row) => ({
            ...scope,
            id: randomUUID(),
            milestoneId: milestones.get(row.milestoneKey)!,
            workItemId: workItems.get(row.workItemKey)!,
          })),
        });
      if (data.raidItems.length)
        await tx.raidItem.createMany({
          data: data.raidItems.map((row) => ({
            ...scope,
            id: raidItems.get(row.key)!,
            ...row,
          })),
        });
      if (data.sourceMappings.length)
        await tx.canonicalSourceMapping.createMany({
          data: data.sourceMappings.map(({ targetKey, ...row }) => ({
            ...scope,
            id: randomUUID(),
            ...row,
            sprintId:
              row.targetType === "SPRINT" ? sprints.get(targetKey!)! : null,
            milestoneId:
              row.targetType === "MILESTONE"
                ? milestones.get(targetKey!)!
                : null,
            workItemId:
              row.targetType === "WORK_ITEM"
                ? workItems.get(targetKey!)!
                : null,
            raidItemId:
              row.targetType === "RAID_ITEM"
                ? raidItems.get(targetKey!)!
                : null,
          })),
        });
      await tx.canonicalCreationReceipt.create({
        data: {
          id: randomUUID(),
          ...key,
          operation: "PROJECT",
          requestHash,
          projectId: id,
        },
      });
      await tx.canonicalProject.update({
        where: { id },
        data: { sealed: true },
      });
      await tx.auditEvent.create({
        data: {
          customerId: actor.customerId,
          actor: actor.subject,
          event: "project.created",
          correlationId,
          detail: {
            projectId: id,
            portfolioId: data.portfolioId,
            ...counts(data),
          },
        },
      });
      return { id };
    });
  }
  async detail(
    actorValue: Actor,
    idValue: string,
  ): Promise<CanonicalProjectDetail> {
    const id = input(() => projectFactIdSchema.parse(idValue));
    return this.transaction(actorValue, async (tx, actor) => {
      const locked = await tx.$queryRaw<
        { portfolioId: string }[]
      >`SELECT "portfolioId" FROM "Project" WHERE id=${id}::uuid AND "customerId"=${actor.customerId}::uuid FOR SHARE`;
      if (!locked[0]) throw new CanonicalProjectError("DENIED");
      const granted = await this.grants(tx, actor, locked[0].portfolioId, id);
      if (!granted.some((role) => readers.includes(role)))
        throw new CanonicalProjectError("DENIED");
      const mappingsAllowed = granted.some((role) =>
        administrators.includes(role),
      );
      const project = await tx.project.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          reportedStatus: true,
          portfolio: { select: { id: true, name: true } },
        },
      });
      const canonical = await tx.canonicalProject.findUnique({
        where: { id },
        include: { programme: { select: programmeSelect } },
      });
      const empty = {
        ...project,
        configured: false,
        creation: null,
        programme: null,
        dates: emptyCanonicalDates(),
        responsibilities: [],
        sprints: [],
        milestones: [],
        workItems: [],
        requiredWorkItems: [],
        raidItems: [],
        sourceMappings: [],
        sourceMappingsWithheld: !mappingsAllowed,
      };
      if (!canonical) return canonicalProjectDetailSchema.parse(empty);
      if (!canonical.sealed) throw new CanonicalProjectError("UNAVAILABLE");
      const scope = { customerId: actor.customerId, projectId: id };
      // Mapping rows are not loaded for readers who cannot configure them.
      const [
        responsibilities,
        sprints,
        milestones,
        workItems,
        required,
        raidItems,
        mappings,
      ] = await Promise.all([
        tx.projectResponsibility.findMany({
          where: scope,
          orderBy: { id: "asc" },
          take: 51,
        }),
        tx.sprint.findMany({ where: scope, orderBy: { key: "asc" }, take: 51 }),
        tx.milestone.findMany({
          where: scope,
          orderBy: { key: "asc" },
          take: 51,
        }),
        tx.workItem.findMany({
          where: scope,
          orderBy: { key: "asc" },
          take: 51,
        }),
        tx.requiredWorkItem.findMany({
          where: scope,
          orderBy: { id: "asc" },
          take: 51,
        }),
        tx.raidItem.findMany({
          where: scope,
          orderBy: { key: "asc" },
          take: 51,
        }),
        mappingsAllowed
          ? tx.canonicalSourceMapping.findMany({
              where: scope,
              orderBy: { id: "asc" },
              take: 51,
            })
          : [],
      ]);
      const keyOf = (
        rows: { id: string; key: string }[],
        value: string | null,
      ) => (value === null ? null : rows.find((row) => row.id === value)?.key);
      return canonicalProjectDetailSchema.parse({
        ...project,
        configured: true,
        creation: {
          by: canonical.createdBy,
          at: canonical.createdAt.toISOString(),
          revision: canonical.revision,
        },
        programme: canonical.programme,
        dates: wireDates(canonical),
        responsibilities: responsibilities.map(
          ({ id, role, subject, displayName }) => ({
            id,
            role,
            subject,
            displayName,
          }),
        ),
        sprints: sprints.map((row) => ({
          id: row.id,
          key: row.key,
          name: row.name,
          dates: wireDates(row),
        })),
        milestones: milestones.map((row) => ({
          id: row.id,
          key: row.key,
          name: row.name,
          state: row.state,
          dates: wireDates(row),
        })),
        workItems: workItems.map((row) => ({
          id: row.id,
          key: row.key,
          title: row.title,
          state: row.state,
          sprintKey: keyOf(sprints, row.sprintId),
          dates: wireDates(row),
        })),
        requiredWorkItems: required.map((row) => ({
          milestoneKey: keyOf(milestones, row.milestoneId),
          workItemKey: keyOf(workItems, row.workItemId),
        })),
        raidItems: raidItems.map(
          ({ id, key, kind, title, description, state, ownerSubject }) => ({
            id,
            key,
            kind,
            title,
            description,
            state,
            ownerSubject,
          }),
        ),
        sourceMappings: mappings.map(
          ({
            id,
            sourceSystem,
            instanceKey,
            externalType,
            externalId,
            externalRevision,
            url,
            targetType,
            sprintId,
            milestoneId,
            workItemId,
            raidItemId,
          }) => ({
            id,
            sourceSystem,
            instanceKey,
            externalType,
            externalId,
            externalRevision,
            url,
            targetType,
            targetKey: sprintId
              ? keyOf(sprints, sprintId)
              : milestoneId
                ? keyOf(milestones, milestoneId)
                : workItemId
                  ? keyOf(workItems, workItemId)
                  : raidItemId
                    ? keyOf(raidItems, raidItemId)
                    : null,
          }),
        ),
        sourceMappingsWithheld: !mappingsAllowed,
      });
    });
  }
}
