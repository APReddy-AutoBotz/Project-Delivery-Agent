import { createHash, randomUUID } from "node:crypto";
import {
  authorityDefinitionSchema,
  authorityPolicyChangeSchema,
  authorityTargetSchema,
  assessmentCaptureSchema,
  assessmentReadSchema,
  factMutationContextSchema,
  projectFactValueSchema,
  resolveSourceAuthority,
  ProjectFactError,
  type Actor,
  type AuthorityRepository,
  type AuthorityPolicyChange,
  type AuthorityTarget,
  type AssessmentCapture,
  type AssessmentRead,
  type FactMutationContext,
  type AuthorityPolicyEvent,
  type AssessmentDelivery,
  type AuthorityAssessment,
  type SourceAuthoritySnapshot,
  type SourceAuthorityPolicy,
} from "@pdaa/domain";
import {
  actorInput,
  factInput,
  authorizeFactProject,
} from "./fact-authorization.js";
import {
  Prisma,
  type PrismaClient as Database,
} from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
type Event = Prisma.AuthorityPolicyRevisionGetPayload<Record<string, never>>;
type Version = Prisma.ProjectFactVersionGetPayload<{
  include: { evidence: true };
}>;
type Conflict = Prisma.FactAuthorityConflictGetPayload<Record<string, never>>;
type Access = Prisma.FactSourceAccessGetPayload<{ include: { readers: true } }>;
type Scope = SourceAuthoritySnapshot["scope"];
const transactionOptions = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5000,
  timeout: 10000,
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function detached<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown) {
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  }
  freeze(copy);
  return copy;
}
function eventOutput(row: Event): AuthorityPolicyEvent {
  return {
    id: row.id,
    policyId: row.policyId,
    revision: row.revision,
    recordedAt: row.recordedAt.toISOString(),
    recordedBy: row.recordedBy,
    effectiveAt: row.effectiveAt.toISOString(),
    state: row.state === "ENABLED" ? "ENABLED" : "DISABLED",
    definition:
      row.state === "ENABLED"
        ? authorityDefinitionSchema.parse(row.definition)
        : null,
  };
}
function resolverPolicy(row: Event | null): SourceAuthorityPolicy | null {
  if (!row || row.state !== "ENABLED") return null;
  return {
    ...authorityDefinitionSchema.parse(row.definition),
    revisionId: row.id,
    customerId: row.customerId,
    projectId: row.projectId,
    factType: row.factType,
    recordedAt: row.recordedAt.toISOString(),
    effectiveAt: row.effectiveAt.toISOString(),
  };
}
function snapshot(
  scope: Scope,
  asOf: string,
  policy: SourceAuthorityPolicy | null,
  versions: Version[],
  conflicts: Conflict[],
  access: Access[],
  complete: boolean,
): SourceAuthoritySnapshot {
  if (!complete)
    return {
      scope,
      asOf,
      policy,
      complete,
      versions: [],
      conflicts: [],
      sources: [],
      evidence: [],
    };
  const bySource = new Map(access.map((row) => [row.sourceId, row]));
  const sources = [...new Set(versions.map((row) => row.sourceId))].map(
    (instanceId) => ({ instanceId, sourceType: "human_statement" }),
  );
  return {
    scope,
    asOf,
    policy,
    complete,
    sources,
    versions: versions.map((row) => ({
      id: row.id,
      scope,
      source: {
        instanceId: row.sourceId,
        recordType: "human_statement",
        recordId: row.sourceId,
        revision: row.evidenceId,
      },
      value: projectFactValueSchema.parse(row.value),
      provenance: "HUMAN_CONFIRMED",
      effectiveAt: row.effectiveAt.toISOString(),
      observedAt: row.evidence.observedAt.toISOString(),
      validUntil: row.validUntil?.toISOString() ?? null,
      evidenceIds: [row.evidenceId],
      approval: { state: "NOT_REQUIRED", decisionAt: null, decisionId: null },
    })),
    evidence: versions.map((row) => {
      const current = bySource.get(row.sourceId);
      const state = current?.state;
      return {
        id: row.evidenceId,
        scope,
        access: current?.readers.length === 1 ? "AUTHORIZED" : "RESTRICTED",
        verification:
          state === "AVAILABLE"
            ? "VALID"
            : state === "REVOKED" || state === "DELETED"
              ? state
              : "UNVERIFIABLE",
      };
    }),
    conflicts: conflicts.map((row) => ({
      id: row.id,
      scope,
      versionIds: [row.leftVersionId, row.rightVersionId],
      detectedAt: row.detectedAt.toISOString(),
      resolvedAt: null,
    })),
  };
}
// The server owns the clock, complete history, policy, approval and access inputs.
// No route or model tool exposes this repository in this increment.
export class DatabaseAuthorityRepository implements AuthorityRepository {
  constructor(private readonly db: Database) {}

  private async time(tx: Tx): Promise<Date> {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    return rows[0]!.now;
  }
  private async audit(
    tx: Pick<Tx, "auditEvent">,
    actor: Actor,
    projectId: string,
    context: FactMutationContext,
    event: string,
    detail: Prisma.InputJsonObject,
  ) {
    await tx.auditEvent.create({
      data: {
        customerId: actor.customerId,
        actor: actor.subject,
        correlationId: context.correlationId,
        event,
        detail: { projectId, ...detail },
      },
    });
  }
  private async mutate<T>(
    actor: Actor,
    projectId: string,
    context: FactMutationContext,
    action: "policy" | "assessment",
    execute: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeFactProject(
          tx,
          actor,
          projectId,
          action === "policy" ? "access" : "capture",
        );
        return execute(tx);
      }, transactionOptions);
    } catch (error) {
      if (error instanceof ProjectFactError) {
        try {
          await this.audit(
            this.db,
            actor,
            projectId,
            context,
            "authority." + action + ".denied",
            { reason: error.code },
          );
        } catch {
          throw new Error("Authority audit failed");
        }
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Authority persistence failed");
    }
  }
  private async read<T>(
    actor: Actor,
    projectId: string,
    execute: (tx: Tx) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeFactProject(tx, actor, projectId, "read");
        return execute(tx);
      }, transactionOptions);
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Authority history unavailable");
    }
  }
  private async active(
    tx: Tx,
    actor: Actor,
    target: AuthorityTarget,
    asOf: Date,
  ) {
    const scope = { customerId: actor.customerId, ...target };
    const aggregate = await tx.authorityPolicy.findUnique({
      where: { customerId_projectId_factType: scope },
    });
    const event = aggregate
      ? await tx.authorityPolicyRevision.findFirst({
          where: {
            ...scope,
            policyId: aggregate.id,
            revision: { lte: aggregate.revision },
            recordedAt: { lte: asOf },
            effectiveAt: { lte: asOf },
          },
          orderBy: { revision: "desc" },
        })
      : null;
    return { aggregate, event };
  }
  async appendPolicy(
    actorValue: Actor,
    requestValue: AuthorityPolicyChange,
    contextValue: FactMutationContext,
  ) {
    const actor = actorInput(actorValue);
    const request = factInput(() =>
      authorityPolicyChangeSchema.parse(requestValue),
    );
    const context = factInput(() =>
      factMutationContextSchema.parse(contextValue),
    );
    const {
      projectId,
      factType,
      expectedRevision,
      effectiveAt,
      definition,
      idempotencyKey,
    } = request;
    const requestHash = hash({
      projectId,
      factType,
      expectedRevision,
      effectiveAt,
      definition,
    });
    return this.mutate(actor, projectId, context, "policy", async (tx) => {
      const key = {
        customerId: actor.customerId,
        projectId,
        subject: actor.subject,
        idempotencyKey,
      };
      const receipt = await tx.authorityPolicyReceipt.findUnique({
        where: { customerId_projectId_subject_idempotencyKey: key },
        include: { event: true },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
        return detached({ event: eventOutput(receipt.event), replayed: true });
      }
      const scope = { customerId: actor.customerId, projectId, factType };
      let aggregate = await tx.authorityPolicy.findUnique({
        where: { customerId_projectId_factType: scope },
      });
      if ((aggregate?.revision ?? 0) !== expectedRevision)
        throw new ProjectFactError("REVISION_CONFLICT");
      const sourceCheck = await tx.$queryRaw<
        { valid: boolean }[]
      >`SELECT public.valid_authority_sources(${actor.customerId}::uuid,${projectId}::uuid,${factType}::varchar,${JSON.stringify(definition)}::jsonb) AS valid`;
      if (definition !== null && sourceCheck[0]?.valid !== true)
        throw new ProjectFactError("INVALID_REQUEST");
      const recordedAt = await this.time(tx);
      if (aggregate) {
        const previous = await tx.authorityPolicyRevision.findFirstOrThrow({
          where: { policyId: aggregate.id, revision: aggregate.revision },
        });
        if (previous.recordedAt > recordedAt)
          throw new ProjectFactError("INVALID_REQUEST");
      } else
        aggregate = await tx.authorityPolicy.create({
          data: { ...scope, id: randomUUID() },
        });
      const event = await tx.authorityPolicyRevision.create({
        data: {
          ...scope,
          id: randomUUID(),
          policyId: aggregate.id,
          revision: expectedRevision + 1,
          recordedAt,
          recordedBy: actor.subject,
          effectiveAt: new Date(effectiveAt),
          state: definition === null ? "DISABLED" : "ENABLED",
          definition: definition ?? Prisma.DbNull,
        },
      });
      await tx.authorityPolicyReceipt.create({
        data: {
          ...key,
          id: randomUUID(),
          factType,
          requestHash,
          revisionId: event.id,
        },
      });
      await this.audit(
        tx,
        actor,
        projectId,
        context,
        "authority.policy.appended",
        {
          policyId: aggregate.id,
          revisionId: event.id,
          revision: event.revision,
        },
      );
      return detached({ event: eventOutput(event), replayed: false });
    });
  }
  async getActivePolicy(actorValue: Actor, requestValue: AuthorityTarget) {
    const actor = actorInput(actorValue);
    const request = factInput(() => authorityTargetSchema.parse(requestValue));
    return this.read(actor, request.projectId, async (tx) => {
      const asOf = await this.time(tx);
      const { aggregate, event } = await this.active(tx, actor, request, asOf);
      return detached({
        asOf: asOf.toISOString(),
        policyId: aggregate?.id ?? null,
        throughRevision: aggregate?.revision ?? null,
        event: event ? eventOutput(event) : null,
      });
    });
  }
  private async deliver(
    tx: Tx,
    actor: Actor,
    projectId: string,
    assessmentId: string,
    replayed: boolean,
  ): Promise<AssessmentDelivery | null> {
    const row = await tx.factAssessment.findFirst({
      where: {
        id: assessmentId,
        customerId: actor.customerId,
        projectId,
        sealed: true,
      },
      include: { versions: { include: { version: true } } },
    });
    if (!row) return null;
    const valid = await tx.$queryRaw<
      { valid: boolean }[]
    >`SELECT public.valid_fact_assessment(${row.id}::uuid) AS valid`;
    if (valid[0]?.valid !== true)
      throw new Error("Stored assessment integrity failed");
    const access = await tx.factSourceAccess.findMany({
      where: {
        customerId: actor.customerId,
        projectId,
        factId: row.factId,
        sourceId: {
          in: [...new Set(row.versions.map((item) => item.version.sourceId))],
        },
      },
      include: { readers: { where: { subject: actor.subject } } },
    });
    const allowed = new Set(
      access
        .filter(
          (item) => item.state === "AVAILABLE" && item.readers.length === 1,
        )
        .map((item) => item.sourceId),
    );
    const metadata = {
      assessmentId: row.id,
      factId: row.factId,
      asOf: row.asOf.toISOString(),
      historical: true as const,
      replayed,
    };
    if (row.versions.some((item) => !allowed.has(item.version.sourceId)))
      return detached({
        ...metadata,
        visibility: "restricted",
        revalidationRequired: true,
        result: null,
      });
    return detached({
      ...metadata,
      visibility: "available",
      revalidationRequired: false,
      result: row.result as unknown as AuthorityAssessment,
    });
  }
  async captureAssessment(
    actorValue: Actor,
    requestValue: AssessmentCapture,
    contextValue: FactMutationContext,
  ): Promise<AssessmentDelivery> {
    const actor = actorInput(actorValue);
    const request = factInput(() =>
      assessmentCaptureSchema.parse(requestValue),
    );
    const context = factInput(() =>
      factMutationContextSchema.parse(contextValue),
    );
    const { projectId, factType, idempotencyKey } = request;
    const requestHash = hash({ projectId, factType });
    return this.mutate(actor, projectId, context, "assessment", async (tx) => {
      const key = {
        customerId: actor.customerId,
        projectId,
        subject: actor.subject,
        idempotencyKey,
      };
      const previous = await tx.factAssessment.findUnique({
        where: { customerId_projectId_subject_idempotencyKey: key },
      });
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
        const delivery = await this.deliver(
          tx,
          actor,
          projectId,
          previous.id,
          true,
        );
        if (!delivery) throw new Error("Assessment unavailable");
        return delivery;
      }
      const fact = await tx.projectFact.findUnique({
        where: {
          customerId_projectId_factType: {
            customerId: actor.customerId,
            projectId,
            factType,
          },
        },
      });
      if (!fact) throw new ProjectFactError("DENIED");
      const scope = {
        customerId: actor.customerId,
        projectId,
        factId: fact.id,
        factType,
      };
      const asOf = await this.time(tx);
      const { aggregate, event } = await this.active(
        tx,
        actor,
        { projectId, factType },
        asOf,
      );
      const versions = await tx.projectFactVersion.findMany({
        where: {
          customerId: actor.customerId,
          projectId,
          factId: fact.id,
          revision: { lte: fact.revision },
        },
        orderBy: { revision: "asc" },
        take: 1001,
        include: { evidence: true },
      });
      const conflictWhere = {
        customerId: actor.customerId,
        projectId,
        factId: fact.id,
      };
      let conflicts = await tx.factAuthorityConflict.findMany({
        where: conflictWhere,
        orderBy: { id: "asc" },
        take: 1001,
      });
      let complete =
        versions.length <= 1000 &&
        conflicts.length <= 1000 &&
        conflicts.every((row) => row.detectedAt <= asOf);
      const access = complete
        ? await tx.factSourceAccess.findMany({
            where: { customerId: actor.customerId, projectId, factId: fact.id },
            include: { readers: { where: { subject: actor.subject } } },
          })
        : [];
      const policy = resolverPolicy(event);
      let result = resolveSourceAuthority(
        snapshot(
          scope,
          asOf.toISOString(),
          policy,
          versions,
          conflicts,
          access,
          complete,
        ),
      );
      if (
        complete &&
        event &&
        result.conflicts.some((item) => item.kind !== "RECORDED")
      ) {
        const values = new Map(
          versions.map((row) => [
            row.id,
            projectFactValueSchema.parse(row.value),
          ]),
        );
        const valueKey = (id: string) => {
          const value = values.get(id)!;
          return JSON.stringify([value.type, value.value]);
        };
        const pairs = new Map<
          string,
          { leftVersionId: string; rightVersionId: string }
        >();
        for (const group of result.conflicts.filter(
          (item) => item.kind !== "RECORDED",
        )) {
          const first = group.versionIds[0]!;
          const other = group.versionIds.find(
            (id) => valueKey(id) !== valueKey(first),
          );
          if (!other) throw new Error("Conflict has no differing values");
          for (const id of group.versionIds.filter((id) => id !== first)) {
            const anchor = valueKey(id) === valueKey(first) ? other : first;
            const [leftVersionId, rightVersionId] = [id, anchor].sort() as [
              string,
              string,
            ];
            pairs.set(leftVersionId + rightVersionId, {
              leftVersionId,
              rightVersionId,
            });
          }
        }
        const existing = new Set(
          conflicts.map((row) => row.leftVersionId + row.rightVersionId),
        );
        const newPairs = [...pairs.entries()]
          .filter(([pair]) => !existing.has(pair))
          .map(([, pair]) => pair);
        const through = Math.max(0, ...conflicts.map((row) => row.revision));
        if (newPairs.length)
          await tx.factAuthorityConflict.createMany({
            data: newPairs.map((pair, index) => ({
              ...scope,
              ...pair,
              id: randomUUID(),
              revision: through + index + 1,
              policyRevisionId: event.id,
              detectedAt: asOf,
            })),
          });
        conflicts = await tx.factAuthorityConflict.findMany({
          where: conflictWhere,
          orderBy: { id: "asc" },
          take: 1001,
        });
        complete = conflicts.length <= 1000;
        result = resolveSourceAuthority(
          snapshot(
            scope,
            asOf.toISOString(),
            policy,
            versions,
            conflicts,
            access,
            complete,
          ),
        );
      }
      const id = randomUUID();
      const conflictPrefix = await tx.factAuthorityConflict.aggregate({
        where: conflictWhere,
        _max: { revision: true },
      });
      await tx.factAssessment.create({
        data: {
          ...scope,
          ...key,
          id,
          factRevision: fact.revision,
          policyId: aggregate?.id ?? null,
          policyThroughRevision: aggregate?.revision ?? null,
          policyRevisionId: event?.id ?? null,
          asOf,
          requestHash,
          complete,
          versionCount: complete ? versions.length : 0,
          conflictCount: complete ? conflicts.length : 0,
          conflictThroughRevision: conflictPrefix._max.revision,
          result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonObject,
        },
      });
      if (complete && versions.length) {
        const accessRevision = new Map(
          access.map((item) => [item.sourceId, item.revision]),
        );
        await tx.factAssessmentVersion.createMany({
          data: versions.map((row) => ({
            customerId: actor.customerId,
            projectId,
            factId: fact.id,
            assessmentId: id,
            versionId: row.id,
            sourceAccessRevision: accessRevision.get(row.sourceId) ?? 0,
          })),
        });
      }
      if (complete && conflicts.length)
        await tx.factAssessmentConflict.createMany({
          data: conflicts.map((row) => ({
            customerId: actor.customerId,
            projectId,
            factId: fact.id,
            assessmentId: id,
            conflictId: row.id,
          })),
        });
      await tx.factAssessment.update({ where: { id }, data: { sealed: true } });
      await this.audit(
        tx,
        actor,
        projectId,
        context,
        "authority.assessment.captured",
        {
          assessmentId: id,
          factId: fact.id,
          factRevision: fact.revision,
          policyRevisionId: event?.id ?? null,
          status: result.status,
          complete,
        },
      );
      const delivery = await this.deliver(tx, actor, projectId, id, false);
      if (!delivery) throw new Error("Assessment unavailable");
      return delivery;
    });
  }
  async getAssessment(actorValue: Actor, requestValue: AssessmentRead) {
    const actor = actorInput(actorValue);
    const request = factInput(() => assessmentReadSchema.parse(requestValue));
    return this.read(actor, request.projectId, (tx) =>
      this.deliver(tx, actor, request.projectId, request.assessmentId, false),
    );
  }
}
