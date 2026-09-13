import { createHash, randomUUID } from "node:crypto";
import {
  ProjectFactError,
  factMutationContextSchema,
  milestoneConsistencyCaptureSchema,
  milestoneConsistencyDeliverySchema,
  reconciliationAssignmentRefreshSchema,
  reconciliationAssignmentSchema,
  reconciliationContextReadSchema,
  reconciliationListSchema,
  reconciliationReadSchema,
  type Actor,
  type FactMutationContext,
  type MilestoneConsistencyCapture,
  type MilestoneReconciliationRepository,
  type ReconciliationAssignmentRefresh,
  type ReconciliationAssignmentResult,
  type ReconciliationCheckResult,
  type ReconciliationContext,
  type ReconciliationDelivery,
  type ReconciliationList,
  type ReconciliationPage,
  type ReconciliationRead,
  type ReconciliationRequestSummary,
  type StateBindingCreate,
} from "@pdaa/domain";
import type {
  Prisma,
  PrismaClient as Database,
} from "./generated/prisma/client.js";
import { actorInput, factInput } from "./fact-authorization.js";
import { DatabaseMilestoneConsistencyRepository } from "./milestone-persistence.js";
import {
  authorizeReconciliation,
  type ReconciliationRouting,
} from "./reconciliation-authorization.js";

type Tx = Prisma.TransactionClient;
const options = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5000,
  timeout: 10000,
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identityHash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
// Queue metadata must not load the frozen contributor identity or grant snapshot.
const summarySelect = {
  id: true,
  projectId: true,
  milestoneId: true,
  createdAt: true,
  assignments: {
    orderBy: { revision: "desc" },
    take: 1,
    select: {
      id: true,
      revision: true,
      occurredAt: true,
      reason: true,
      recipientSubject: true,
    },
  },
} as const satisfies Prisma.MilestoneReconciliationRequestSelect;
type AssignmentRow = {
  id: string;
  revision: number;
  occurredAt: Date;
  reason: string;
  recipientSubject: string | null;
};
const assignmentView = (row: AssignmentRow) =>
  reconciliationAssignmentSchema.parse({
    id: row.id,
    revision: row.revision,
    occurredAt: row.occurredAt.toISOString(),
    reason: row.reason,
    recipientSubject: row.recipientSubject,
  });

// FR-EVD-007/012, FR-HLT-008/009, NFR-REL-001/002: one transaction owns the
// fresh proof and durable command. Saved assignment never substitutes for auth.
export class DatabaseMilestoneReconciliationRepository
  implements MilestoneReconciliationRepository
{
  private readonly milestones: DatabaseMilestoneConsistencyRepository;
  constructor(
    private readonly db: Database,
    private readonly idFactory: () => string = randomUUID,
  ) {
    this.milestones = new DatabaseMilestoneConsistencyRepository(db, idFactory);
  }
  createStateBinding(
    actor: Actor,
    request: StateBindingCreate,
    context: FactMutationContext,
  ) {
    return this.milestones.createStateBinding(actor, request, context);
  }
  private async time(tx: Tx) {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    return rows[0]!.now;
  }
  private async deniedAudit(
    actor: Actor,
    projectId: string,
    context: FactMutationContext,
    event: string,
    error: ProjectFactError,
  ) {
    try {
      await this.db.auditEvent.create({
        data: {
          customerId: actor.customerId,
          actor: actor.subject,
          correlationId: context.correlationId,
          event: event + ".denied",
          detail: { projectId, reason: error.code },
        },
      });
    } catch {
      throw new Error("Reconciliation denial audit failed");
    }
  }
  private async summary(
    tx: Tx,
    customerId: string,
    projectId: string,
    requestId: string,
  ): Promise<ReconciliationRequestSummary> {
    const row = await tx.milestoneReconciliationRequest.findFirst({
      where: { id: requestId, customerId, projectId, sealed: true },
      select: summarySelect,
    });
    if (!row?.assignments[0])
      throw new Error("Reconciliation history unavailable");
    return {
      id: row.id,
      projectId: row.projectId,
      milestoneId: row.milestoneId,
      createdAt: row.createdAt.toISOString(),
      state: "OPEN",
      assignment: assignmentView(row.assignments[0]),
    };
  }
  private async assign(
    tx: Tx,
    actor: Actor,
    projectId: string,
    requestId: string,
    routing: ReconciliationRouting,
    occurredAt: Date,
    context: FactMutationContext,
    previous: { id: string; revision: number } | null,
    command: { idempotencyKey: string; requestHash: string } | null,
  ) {
    const id = this.idFactory(),
      auditEventId = this.idFactory(),
      revision = (previous?.revision ?? 0) + 1;
    const row = await tx.milestoneReconciliationAssignment.create({
      data: {
        id,
        customerId: actor.customerId,
        projectId,
        requestId,
        revision,
        expectedRevision: previous?.revision ?? 0,
        previousAssignmentId: previous?.id ?? null,
        kind: previous ? "REFRESH" : "INITIAL",
        ...routing,
        actor: actor.subject,
        occurredAt,
        auditEventId,
        idempotencyKey: command?.idempotencyKey ?? null,
        requestHash: command?.requestHash ?? null,
      },
    });
    await tx.auditEvent.create({
      data: {
        id: auditEventId,
        customerId: actor.customerId,
        actor: actor.subject,
        correlationId: context.correlationId,
        occurredAt,
        event: "milestone.reconciliation.assigned",
        detail: {
          projectId,
          requestId,
          assignmentId: id,
          revision,
          reason: routing.reason,
        },
      },
    });
    return assignmentView(row);
  }
  private async checkView(
    tx: Tx,
    actor: Actor,
    row: {
      id: string;
      projectId: string;
      assessmentId: string;
      requestId: string | null;
      outcome: string;
    },
    replayed: boolean,
  ): Promise<ReconciliationCheckResult> {
    const delivery = await this.milestones.deliverInTransaction(
      tx,
      actor,
      { projectId: row.projectId, assessmentId: row.assessmentId },
      replayed,
    );
    if (!delivery) throw new Error("Reconciliation proof unavailable");
    return {
      checkId: row.id,
      outcome: row.outcome as ReconciliationCheckResult["outcome"],
      replayed,
      assessment: milestoneConsistencyDeliverySchema.parse(delivery),
      request: row.requestId
        ? await this.summary(tx, actor.customerId, row.projectId, row.requestId)
        : null,
    };
  }
  async check(
    actorValue: Actor,
    requestValue: MilestoneConsistencyCapture,
    contextValue: FactMutationContext,
  ): Promise<ReconciliationCheckResult> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        milestoneConsistencyCaptureSchema.parse(requestValue),
      ),
      context = factInput(() => factMutationContextSchema.parse(contextValue));
    const requestHash = hash({
      projectId: request.projectId,
      milestoneId: request.milestoneId,
      ruleRevision: request.ruleRevision,
      enabled: request.enabled,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        const { routing } = await authorizeReconciliation(
          tx,
          actor,
          request.projectId,
          "manage",
        );
        const key = {
          customerId: actor.customerId,
          projectId: request.projectId,
          subject: actor.subject,
          idempotencyKey: request.idempotencyKey,
        };
        const prior = await tx.milestoneReconciliationCheck.findUnique({
          where: { customerId_projectId_subject_idempotencyKey: key },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
          return this.checkView(tx, actor, prior, true);
        }
        const checkId = this.idFactory();
        const assessment = await this.milestones.captureInTransaction(
          tx,
          actor,
          { ...request, idempotencyKey: "rc_" + checkId.replaceAll("-", "") },
          context,
          checkId,
        );
        const occurredAt = new Date(assessment.asOf);
        let requestId: string | null = null;
        let outcome: ReconciliationCheckResult["outcome"] = "NO_REQUEST";
        if (
          assessment.visibility === "available" &&
          assessment.result.status === "CONFLICTING"
        ) {
          const contributorIdentity = assessment.result.contributorIdentity,
            contributorHash = identityHash(contributorIdentity);
          const business = {
            customerId: actor.customerId,
            projectId: request.projectId,
            milestoneId: request.milestoneId,
            ruleRevision: request.ruleRevision,
            contributorHash,
          };
          const existing = await tx.milestoneReconciliationRequest.findUnique({
            where: {
              customerId_projectId_milestoneId_ruleRevision_contributorHash:
                business,
            },
            select: { id: true, sealed: true, contributorIdentity: true },
          });
          if (existing) {
            if (
              !existing.sealed ||
              existing.contributorIdentity !== contributorIdentity
            )
              throw new Error("Reconciliation identity collision");
            requestId = existing.id;
            outcome = "REUSED";
          } else {
            requestId = this.idFactory();
            outcome = "CREATED";
            const auditEventId = this.idFactory();
            await tx.milestoneReconciliationRequest.create({
              data: {
                id: requestId,
                ...business,
                originalAssessmentId: assessment.assessmentId,
                originCommandId: checkId,
                contributorIdentity,
                createdBy: actor.subject,
                createdAt: occurredAt,
                auditEventId,
              },
            });
            await tx.auditEvent.create({
              data: {
                id: auditEventId,
                customerId: actor.customerId,
                actor: actor.subject,
                correlationId: context.correlationId,
                occurredAt,
                event: "milestone.reconciliation.requested",
                detail: {
                  projectId: request.projectId,
                  requestId,
                  assessmentId: assessment.assessmentId,
                  checkId,
                },
              },
            });
            await this.assign(
              tx,
              actor,
              request.projectId,
              requestId,
              routing,
              occurredAt,
              context,
              null,
              null,
            );
          }
        }
        const auditEventId = this.idFactory();
        await tx.milestoneReconciliationCheck.create({
          data: {
            id: checkId,
            ...key,
            requestHash,
            assessmentId: assessment.assessmentId,
            requestId,
            outcome,
            occurredAt,
            auditEventId,
          },
        });
        await tx.auditEvent.create({
          data: {
            id: auditEventId,
            customerId: actor.customerId,
            actor: actor.subject,
            correlationId: context.correlationId,
            occurredAt,
            event: "milestone.reconciliation.checked",
            detail: {
              projectId: request.projectId,
              checkId,
              assessmentId: assessment.assessmentId,
              requestId,
              outcome,
            },
          },
        });
        if (outcome === "CREATED")
          await tx.milestoneReconciliationRequest.update({
            where: { id: requestId! },
            data: { sealed: true },
          });
        return {
          checkId,
          outcome,
          replayed: false,
          assessment: milestoneConsistencyDeliverySchema.parse(assessment),
          request: requestId
            ? await this.summary(
                tx,
                actor.customerId,
                request.projectId,
                requestId,
              )
            : null,
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError) {
        await this.deniedAudit(
          actor,
          request.projectId,
          context,
          "milestone.reconciliation.check",
          error,
        );
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Reconciliation check unavailable");
    }
  }
  async getContext(
    actorValue: Actor,
    requestValue: { projectId: string; milestoneId: string },
  ): Promise<ReconciliationContext | null> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        reconciliationContextReadSchema.parse(requestValue),
      );
    try {
      return await this.db.$transaction(async (tx) => {
        const access = await authorizeReconciliation(
          tx,
          actor,
          request.projectId,
          "read",
        );
        const milestone = await tx.milestone.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            id: request.milestoneId,
          },
          select: { id: true },
        });
        if (!milestone) throw new ProjectFactError("DENIED");
        const links = await tx.requiredWorkItem.findMany({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            milestoneId: request.milestoneId,
          },
          orderBy: { id: "asc" },
          take: 51,
        });
        if (links.length > 50)
          throw new Error("Reconciliation targets exceed bounds");
        const targets = [
          { targetKind: "MILESTONE" as const, targetId: milestone.id },
          ...links.map((link) => ({
            targetKind: "WORK_ITEM" as const,
            targetId: link.workItemId,
          })),
        ];
        const bindings = await tx.canonicalStateBinding.findMany({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            sealed: true,
            OR: [
              { milestoneId: milestone.id },
              { workItemId: { in: links.map((link) => link.workItemId) } },
            ],
          },
        });
        return {
          ...request,
          canAppend: access.canAppend,
          canConfigure: access.canConfigure,
          targets: targets.map((target) => {
            const bound = bindings.find(
              (binding) =>
                binding.targetKind === target.targetKind &&
                (binding.milestoneId ?? binding.workItemId) === target.targetId,
            );
            return {
              ...target,
              binding: bound
                ? {
                    id: bound.id,
                    factId: bound.factId,
                    factType: bound.factType,
                  }
                : null,
            };
          }),
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Reconciliation context unavailable");
    }
  }
  async get(
    actorValue: Actor,
    requestValue: ReconciliationRead,
  ): Promise<ReconciliationDelivery | null> {
    const actor = actorInput(actorValue),
      request = factInput(() => reconciliationReadSchema.parse(requestValue));
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeReconciliation(
          tx,
          actor,
          request.projectId,
          "recipient",
        );
        const row = await tx.milestoneReconciliationRequest.findFirst({
          where: {
            id: request.requestId,
            customerId: actor.customerId,
            projectId: request.projectId,
            sealed: true,
          },
          select: { ...summarySelect, originalAssessmentId: true },
        });
        if (
          !row ||
          row.assignments[0]?.reason !== "ASSIGNED" ||
          row.assignments[0].recipientSubject !== actor.subject
        )
          throw new ProjectFactError("DENIED");
        const valid = await tx.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_milestone_reconciliation_request(${row.id}::uuid) AS valid`;
        if (valid[0]?.valid !== true)
          throw new Error("Reconciliation integrity failed");
        const delivery = await this.milestones.deliverInTransaction(
          tx,
          actor,
          {
            projectId: request.projectId,
            assessmentId: row.originalAssessmentId,
          },
          false,
        );
        if (!delivery) throw new Error("Reconciliation proof unavailable");
        return {
          request: await this.summary(
            tx,
            actor.customerId,
            request.projectId,
            request.requestId,
          ),
          assessment: milestoneConsistencyDeliverySchema.parse(delivery),
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Reconciliation request unavailable");
    }
  }
  async list(
    actorValue: Actor,
    requestValue: ReconciliationList,
    mode: "manage" | "recipient",
  ): Promise<ReconciliationPage | null> {
    const actor = actorInput(actorValue),
      request = factInput(() => reconciliationListSchema.parse(requestValue));
    if (mode !== "manage" && mode !== "recipient")
      throw new ProjectFactError("INVALID_REQUEST");
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeReconciliation(tx, actor, request.projectId, mode);
        const rows = await tx.milestoneReconciliationRequest.findMany({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            sealed: true,
            ...(request.after
              ? {
                  OR: [
                    { createdAt: { gt: new Date(request.after.createdAt) } },
                    {
                      createdAt: new Date(request.after.createdAt),
                      id: { gt: request.after.id },
                    },
                  ],
                }
              : {}),
            ...(mode === "recipient"
              ? {
                  assignments: {
                    some: {
                      recipientSubject: actor.subject,
                      reason: "ASSIGNED",
                      successors: { none: {} },
                    },
                  },
                }
              : {}),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: request.limit + 1,
          select: summarySelect,
        });
        const page = rows.slice(0, request.limit),
          last = page.at(-1);
        return {
          live: true,
          requests: page.map((row) => {
            if (!row.assignments[0])
              throw new Error("Reconciliation assignment unavailable");
            return {
              id: row.id,
              projectId: row.projectId,
              milestoneId: row.milestoneId,
              createdAt: row.createdAt.toISOString(),
              state: "OPEN" as const,
              assignment: assignmentView(row.assignments[0]),
            };
          }),
          next:
            rows.length > request.limit && last
              ? { createdAt: last.createdAt.toISOString(), id: last.id }
              : null,
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Reconciliation queue unavailable");
    }
  }
  async refreshAssignment(
    actorValue: Actor,
    requestValue: ReconciliationAssignmentRefresh,
    contextValue: FactMutationContext,
  ): Promise<ReconciliationAssignmentResult> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        reconciliationAssignmentRefreshSchema.parse(requestValue),
      ),
      context = factInput(() => factMutationContextSchema.parse(contextValue));
    const requestHash = hash({
      projectId: request.projectId,
      requestId: request.requestId,
      expectedAssignmentRevision: request.expectedAssignmentRevision,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        const { routing } = await authorizeReconciliation(
          tx,
          actor,
          request.projectId,
          "manage",
        );
        const row = await tx.milestoneReconciliationRequest.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            id: request.requestId,
            sealed: true,
          },
          select: { id: true },
        });
        if (!row) throw new ProjectFactError("DENIED");
        const prior = await tx.milestoneReconciliationAssignment.findUnique({
          where: {
            customerId_projectId_requestId_actor_idempotencyKey: {
              customerId: actor.customerId,
              projectId: request.projectId,
              requestId: request.requestId,
              actor: actor.subject,
              idempotencyKey: request.idempotencyKey,
            },
          },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
          return {
            requestId: row.id,
            assignment: assignmentView(prior),
            replayed: true,
          };
        }
        const previous = await tx.milestoneReconciliationAssignment.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            requestId: row.id,
          },
          orderBy: { revision: "desc" },
          select: { id: true, revision: true },
        });
        if (!previous) throw new Error("Reconciliation assignment unavailable");
        if (previous.revision !== request.expectedAssignmentRevision)
          throw new ProjectFactError("REVISION_CONFLICT");
        return {
          requestId: row.id,
          replayed: false,
          assignment: await this.assign(
            tx,
            actor,
            request.projectId,
            row.id,
            routing,
            await this.time(tx),
            context,
            previous,
            { idempotencyKey: request.idempotencyKey, requestHash },
          ),
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError) {
        await this.deniedAudit(
          actor,
          request.projectId,
          context,
          "milestone.reconciliation.assignment",
          error,
        );
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Reconciliation assignment unavailable");
    }
  }
}
