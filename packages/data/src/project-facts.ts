import { createHash, randomUUID } from "node:crypto";
import {
  factHistoryRequestSchema,
  factMutationContextSchema,
  humanStatementSchema,
  projectFactIdSchema,
  projectFactSubjectSchema,
  projectFactValueSchema,
  roleSchema,
  sourceAccessChangeSchema,
  ProjectFactError,
  type Actor,
  type FactHistoryEntry,
  type FactHistoryRequest,
  type FactMutationContext,
  type HumanStatement,
  type ProjectFactRepository,
  type SourceAccessChange,
} from "@pdaa/domain";
import type {
  Prisma,
  PrismaClient as Database,
} from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
const readRoles = ["leadership", "project_manager", "pmo_admin"];
const writeRoles = ["project_manager", "pmo_admin"];
function actorInput(value: Actor): Actor {
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
      value.roles.length > 5
    )
      throw new Error();
    const roles = value.roles.map((role) => roleSchema.parse(role));
    if (new Set(roles).size !== roles.length) throw new Error();
    return { subject, customerId, roles };
  } catch {
    throw new ProjectFactError("INVALID_REQUEST");
  }
}
function input<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new ProjectFactError("INVALID_REQUEST");
  }
}
// The repository owns SQL/transactions. Requests supply neither authentication,
// provenance, a clock nor a DB client. FR-EVD-001/002/003/004/005/009.
export class DatabaseProjectFactRepository implements ProjectFactRepository {
  constructor(private readonly db: Database) {}

  private async authorized(
    tx: Tx,
    actor: Actor,
    projectId: string,
    action: "read" | "append" | "access",
  ) {
    const projects =
      action === "read"
        ? await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
          SELECT id,"portfolioId" FROM "Project"
          WHERE "customerId"=${actor.customerId}::uuid AND id=${projectId}::uuid
          FOR SHARE`
        : await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
          SELECT id,"portfolioId" FROM "Project"
          WHERE "customerId"=${actor.customerId}::uuid AND id=${projectId}::uuid
          FOR UPDATE`;
    if (!projects[0]) throw new ProjectFactError("DENIED");
    // FOR SHARE also blocks non-key role changes; FOR KEY SHARE would not.
    const grants = await tx.$queryRaw<{ role: string }[]>`
      SELECT role FROM "AccessGrant"
      WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject}
        AND (("scopeType"='project' AND "scopeId"=${projectId}::uuid)
          OR ("scopeType"='portfolio' AND "scopeId"=${projects[0].portfolioId}::uuid))
      ORDER BY id FOR SHARE`;
    const allowed =
      action === "read"
        ? readRoles
        : action === "append"
          ? writeRoles
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
  private async audit(
    tx: Pick<Tx, "auditEvent">,
    actor: Actor,
    projectId: string,
    correlationId: string,
    event: string,
    detail: Prisma.InputJsonObject,
  ) {
    await tx.auditEvent.create({
      data: {
        customerId: actor.customerId,
        actor: actor.subject,
        event,
        correlationId,
        detail: { projectId, ...detail },
      },
    });
  }
  private async mutate<T>(
    actor: Actor,
    projectId: string,
    context: FactMutationContext,
    operation: "append" | "access",
    execute: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.$transaction(
        async (tx) => {
          await this.authorized(tx, actor, projectId, operation);
          return execute(tx);
        },
        { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 },
      );
    } catch (error) {
      // Denial audit is separate from the fully rolled-back material write.
      if (error instanceof ProjectFactError) {
        try {
          await this.audit(
            this.db,
            actor,
            projectId,
            context.correlationId,
            "fact." + operation + ".denied",
            { reason: error.code },
          );
        } catch {
          throw new Error("Project fact audit failed");
        }
        throw error;
      }
      // SQL causes may contain statement text and private infrastructure details.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Project fact persistence failed");
    }
  }
  private async entry(
    tx: Tx,
    actor: Actor,
    projectId: string,
    versionId: string,
  ): Promise<FactHistoryEntry> {
    const row = await tx.projectFactVersion.findFirst({
      where: { id: versionId, customerId: actor.customerId, projectId },
      include: { evidence: true },
    });
    if (!row) throw new Error("Project fact result unavailable");
    const access = await tx.factSourceAccess.findFirst({
      where: {
        sourceId: row.sourceId,
        customerId: actor.customerId,
        projectId,
        factId: row.factId,
      },
      include: { readers: { where: { subject: actor.subject } } },
    });
    const metadata = {
      id: row.id,
      revision: row.revision,
      sourceId: row.sourceId,
      evidenceId: row.evidenceId,
      sourceAccessRevision: access?.revision ?? 0,
    };
    if (!access || access.state !== "AVAILABLE" || access.readers.length !== 1)
      return {
        ...metadata,
        visibility: "restricted",
        revalidationRequired: true,
      };
    return {
      ...metadata,
      visibility: "available",
      revalidationRequired: false,
      content: {
        value: projectFactValueSchema.parse(row.value),
        originalStatement: row.evidence.originalStatement,
        providedBy: row.evidence.providedBy,
        provenance: "HUMAN_CONFIRMED",
        effectiveAt: row.effectiveAt.toISOString(),
        observedAt: row.evidence.observedAt.toISOString(),
        confirmedAt: row.evidence.observedAt.toISOString(),
        validUntil: row.validUntil?.toISOString() ?? null,
        source: {
          instanceId: row.sourceId,
          recordType: "human_statement",
          recordId: row.sourceId,
          revision: row.evidenceId,
        },
        evidenceIds: [row.evidenceId],
      },
    };
  }
  async appendHumanStatement(
    actorValue: Actor,
    requestValue: HumanStatement,
    contextValue: FactMutationContext,
  ) {
    const actor = actorInput(actorValue);
    const request = input(() => humanStatementSchema.parse(requestValue));
    const context = input(() => factMutationContextSchema.parse(contextValue));
    const { projectId, factType, expectedRevision, idempotencyKey } = request;
    // Explicit canonical property order and defaults; source assertions remain literal.
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          projectId,
          factType,
          expectedRevision,
          value: { type: request.value.type, value: request.value.value },
          effectiveAt: request.effectiveAt,
          validUntil: request.validUntil,
          originalStatement: request.originalStatement,
        }),
      )
      .digest("hex");
    return this.mutate(actor, projectId, context, "append", async (tx) => {
      const key = {
        customerId: actor.customerId,
        projectId,
        subject: actor.subject,
        idempotencyKey,
      };
      const receipt = await tx.factAppendReceipt.findUnique({
        where: { customerId_projectId_subject_idempotencyKey: key },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
        return {
          factId: receipt.factId,
          replayed: true,
          entry: await this.entry(tx, actor, projectId, receipt.versionId),
        };
      }
      const scope = { customerId: actor.customerId, projectId };
      let fact = await tx.projectFact.findUnique({
        where: { customerId_projectId_factType: { ...scope, factType } },
      });
      if ((fact?.revision ?? 0) !== expectedRevision)
        throw new ProjectFactError("REVISION_CONFLICT");
      if (!fact)
        fact = await tx.projectFact.create({
          data: { ...scope, id: randomUUID(), factType },
        });
      const factScope = { ...scope, factId: fact.id };
      let source = await tx.factSource.findUnique({
        where: {
          customerId_projectId_factId_providedBy: {
            ...factScope,
            providedBy: actor.subject,
          },
        },
      });
      if (!source) {
        source = await tx.factSource.create({
          data: { ...factScope, id: randomUUID(), providedBy: actor.subject },
        });
        await tx.factSourceAccess.create({
          data: { ...factScope, sourceId: source.id, state: "AVAILABLE" },
        });
        await tx.factSourceReader.create({
          data: { ...factScope, sourceId: source.id, subject: actor.subject },
        });
      } else {
        const access = await tx.factSourceAccess.findFirst({
          where: { ...factScope, sourceId: source.id },
          include: { readers: { where: { subject: actor.subject } } },
        });
        if (
          !access ||
          access.state !== "AVAILABLE" ||
          access.readers.length !== 1
        )
          throw new ProjectFactError("SOURCE_RESTRICTED");
      }
      const evidenceId = randomUUID();
      const versionId = randomUUID();
      await tx.factEvidence.create({
        data: {
          ...factScope,
          id: evidenceId,
          sourceId: source.id,
          providedBy: actor.subject,
          observedAt: new Date(),
          originalStatement: request.originalStatement,
        },
      });
      const revision = expectedRevision + 1;
      await tx.projectFactVersion.create({
        data: {
          ...factScope,
          id: versionId,
          sourceId: source.id,
          evidenceId,
          revision,
          value: request.value,
          provenance: "HUMAN_CONFIRMED",
          effectiveAt: new Date(request.effectiveAt),
          validUntil:
            request.validUntil === null ? null : new Date(request.validUntil),
        },
      });
      // The append trigger advances the fact revision in the same transaction.
      await tx.factAppendReceipt.create({
        data: {
          ...key,
          id: randomUUID(),
          requestHash,
          factId: fact.id,
          versionId,
        },
      });
      await this.audit(
        tx,
        actor,
        projectId,
        context.correlationId,
        "fact.appended",
        { factId: fact.id, versionId, evidenceId, revision },
      );
      return {
        factId: fact.id,
        replayed: false,
        entry: await this.entry(tx, actor, projectId, versionId),
      };
    });
  }
  async getHistory(actorValue: Actor, requestValue: FactHistoryRequest) {
    const actor = actorInput(actorValue);
    const request = input(() => factHistoryRequestSchema.parse(requestValue));
    try {
      return await this.db.$transaction(
        async (tx) => {
          await this.authorized(tx, actor, request.projectId, "read");
          const fact = await tx.projectFact.findUnique({
            where: {
              customerId_projectId_factType: {
                customerId: actor.customerId,
                projectId: request.projectId,
                factType: request.factType,
              },
            },
          });
          if (!fact) return null;
          const throughRevision = request.throughRevision ?? fact.revision;
          if (throughRevision > fact.revision)
            throw new ProjectFactError("INVALID_REQUEST");
          const rows = await tx.projectFactVersion.findMany({
            where: {
              customerId: actor.customerId,
              projectId: request.projectId,
              factId: fact.id,
              revision: { gt: request.afterRevision, lte: throughRevision },
            },
            orderBy: { revision: "asc" },
            take: request.limit,
            select: { id: true, revision: true },
          });
          const entries: FactHistoryEntry[] = [];
          for (const row of rows)
            entries.push(
              await this.entry(tx, actor, request.projectId, row.id),
            );
          const afterRevision = rows.at(-1)?.revision ?? request.afterRevision;
          return {
            factId: fact.id,
            factType: fact.factType,
            throughRevision,
            entries,
            next:
              afterRevision < throughRevision
                ? { afterRevision, throughRevision }
                : null,
            historical: true as const,
          };
        },
        { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 },
      );
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // The repository boundary must not expose a raw database cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Project fact history unavailable");
    }
  }
  async setSourceAccess(
    actorValue: Actor,
    requestValue: SourceAccessChange,
    contextValue: FactMutationContext,
  ) {
    const actor = actorInput(actorValue);
    const request = input(() => sourceAccessChangeSchema.parse(requestValue));
    const context = input(() => factMutationContextSchema.parse(contextValue));
    return this.mutate(
      actor,
      request.projectId,
      context,
      "access",
      async (tx) => {
        const access = await tx.factSourceAccess.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            sourceId: request.sourceId,
          },
        });
        if (!access) throw new ProjectFactError("DENIED");
        if (access.revision !== request.expectedRevision)
          throw new ProjectFactError("REVISION_CONFLICT");
        const previousReaders = await tx.factSourceReader.findMany({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            sourceId: access.sourceId,
          },
          orderBy: { subject: "asc" },
          select: { subject: true },
        });
        const scope = {
          customerId: actor.customerId,
          projectId: request.projectId,
          factId: access.factId,
          sourceId: access.sourceId,
        };
        await tx.factSourceAccess.update({
          where: { sourceId: access.sourceId },
          data: { state: request.state, revision: access.revision + 1 },
        });
        await tx.factSourceReader.deleteMany({ where: scope });
        if (request.readers.length)
          await tx.factSourceReader.createMany({
            data: [...request.readers]
              .sort()
              .map((subject) => ({ ...scope, subject })),
          });
        const finalAccess = await tx.factSourceAccess.findUniqueOrThrow({
          where: { sourceId: access.sourceId },
          select: { revision: true },
        });
        await this.audit(
          tx,
          actor,
          request.projectId,
          context.correlationId,
          "fact.source_access.changed",
          {
            sourceId: access.sourceId,
            previousRevision: access.revision,
            revision: finalAccess.revision,
            previousState: access.state,
            state: request.state,
            previousReaders: previousReaders.map((reader) => reader.subject),
            readers: [...request.readers].sort(),
          },
        );
        return { sourceId: access.sourceId, revision: finalAccess.revision };
      },
    );
  }
}
