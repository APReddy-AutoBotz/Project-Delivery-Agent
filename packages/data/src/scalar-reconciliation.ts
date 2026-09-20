import { createHash, randomUUID } from "node:crypto";
import {
  ProjectFactError,
  assessmentDeliverySchema,
  factMutationContextSchema,
  reconciliationAssignmentSchema,
  scalarReconciliationAssignmentRefreshSchema,
  scalarReconciliationCheckRequestSchema,
  scalarReconciliationContextReadSchema,
  scalarReconciliationListSchema,
  scalarReconciliationReadSchema,
  scalarReconciliationResolveSchema,
  type Actor,
  type FactMutationContext,
  type ReconciliationAssignment,
  type ReconciliationAssignmentResult,
  type ScalarReconciliationAssignmentRefresh,
  type ScalarReconciliationCheckRequest,
  type ScalarReconciliationCheckResult,
  type ScalarReconciliationContext,
  type ScalarReconciliationContextRead,
  type ScalarReconciliationDelivery,
  type ScalarReconciliationList,
  type ScalarReconciliationPage,
  type ScalarReconciliationRead,
  type ScalarReconciliationRepository,
  type ScalarReconciliationRequestSummary,
  type ScalarReconciliationResolve,
} from "@pdaa/domain";
import type {
  Prisma,
  PrismaClient as Database,
} from "./generated/prisma/client.js";
import { actorInput, factInput } from "./fact-authorization.js";
import { DatabaseAuthorityRepository } from "./authority-persistence.js";
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

const summarySelect = {
  id: true,
  projectId: true,
  factId: true,
  factType: true,
  createdAt: true,
  state: true,
  resolvedAssessmentId: true,
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
} as const satisfies Prisma.ScalarReconciliationRequestSelect;

type AssignmentRow = {
  id: string;
  revision: number;
  occurredAt: Date;
  reason: string;
  recipientSubject: string | null;
};

const assignmentView = (row: AssignmentRow): ReconciliationAssignment =>
  reconciliationAssignmentSchema.parse({
    id: row.id,
    revision: row.revision,
    occurredAt: row.occurredAt.toISOString(),
    reason: row.reason,
    recipientSubject: row.recipientSubject,
  });

// FR-EVD-007/009/012, FR-ADM-005, NFR-REL-001/002: durable generic scalar reconciliation.
export class DatabaseScalarReconciliationRepository
  implements ScalarReconciliationRepository
{
  private readonly authorities: DatabaseAuthorityRepository;
  constructor(
    private readonly db: Database,
    private readonly idFactory: () => string = randomUUID,
  ) {
    this.authorities = new DatabaseAuthorityRepository(db);
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
      throw new Error("Scalar reconciliation denial audit failed");
    }
  }

  private async summary(
    tx: Tx,
    customerId: string,
    projectId: string,
    requestId: string,
  ): Promise<ScalarReconciliationRequestSummary> {
    const row = await tx.scalarReconciliationRequest.findFirst({
      where: { id: requestId, customerId, projectId, sealed: true },
      select: summarySelect,
    });
    if (!row?.assignments[0])
      throw new Error("Scalar reconciliation history unavailable");
    return {
      id: row.id,
      projectId: row.projectId,
      factId: row.factId,
      factType: row.factType,
      createdAt: row.createdAt.toISOString(),
      state: row.state as "OPEN" | "RESOLVED",
      resolvedAssessmentId: row.resolvedAssessmentId,
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
    const row = await tx.scalarReconciliationAssignment.create({
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
        event: "scalar.reconciliation.assigned",
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
  ): Promise<ScalarReconciliationCheckResult> {
    const delivery = await this.authorities.deliverInTransaction(
      tx,
      actor,
      row.projectId,
      row.assessmentId,
      replayed,
    );
    if (!delivery) throw new Error("Scalar reconciliation proof unavailable");
    return {
      checkId: row.id,
      outcome: row.outcome as ScalarReconciliationCheckResult["outcome"],
      replayed,
      assessment: assessmentDeliverySchema.parse(delivery),
      request: row.requestId
        ? await this.summary(tx, actor.customerId, row.projectId, row.requestId)
        : null,
    };
  }

  async getContext(
    actorValue: Actor,
    requestValue: ScalarReconciliationContextRead,
  ): Promise<ScalarReconciliationContext | null> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        scalarReconciliationContextReadSchema.parse(requestValue),
      );
    try {
      return await this.db.$transaction(async (tx) => {
        const access = await authorizeReconciliation(
          tx,
          actor,
          request.projectId,
          "read",
        );
        const fact = await tx.projectFact.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            factType: request.factType,
          },
          select: { id: true },
        });
        return {
          projectId: request.projectId,
          factType: request.factType,
          canAppend: access.canAppend,
          canConfigure: access.canConfigure,
          factId: fact?.id ?? null,
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Scalar reconciliation context unavailable");
    }
  }

  async check(
    actorValue: Actor,
    requestValue: ScalarReconciliationCheckRequest,
    contextValue: FactMutationContext,
  ): Promise<ScalarReconciliationCheckResult> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        scalarReconciliationCheckRequestSchema.parse(requestValue),
      ),
      context = factInput(() => factMutationContextSchema.parse(contextValue));
    const requestHash = hash({
      projectId: request.projectId,
      factType: request.factType,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        const { routing } = await authorizeReconciliation(
          tx,
          actor,
          request.projectId,
          "manage",
        );
        const fact = await tx.projectFact.findUnique({
          where: {
            customerId_projectId_factType: {
              customerId: actor.customerId,
              projectId: request.projectId,
              factType: request.factType,
            },
          },
        });
        if (!fact) throw new ProjectFactError("DENIED");
        const key = {
          customerId: actor.customerId,
          projectId: request.projectId,
          factId: fact.id,
          subject: actor.subject,
          idempotencyKey: request.idempotencyKey,
        };
        const prior = await tx.scalarReconciliationCheck.findUnique({
          where: {
            customerId_projectId_factId_subject_idempotencyKey: key,
          },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
          return this.checkView(tx, actor, prior, true);
        }
        const checkId = this.idFactory();
        const occurredAt = new Date(request.asOf);
        const assessment =
          await this.authorities.captureAssessmentInTransaction(tx, actor, {
            projectId: request.projectId,
            fact,
            asOf: occurredAt,
            subject: actor.subject,
            idempotencyKey: "rc_" + checkId.replaceAll("-", ""),
            requestHash,
            captureKind: "SCALAR",
            milestoneAssessmentId: null,
            reconciliationCheckId: checkId,
          });

        let requestId: string | null = null;
        let outcome: ScalarReconciliationCheckResult["outcome"] = "NO_REQUEST";

        const assessmentDelivery =
          await this.authorities.deliverInTransaction(
            tx,
            actor,
            request.projectId,
            assessment.id,
            false,
          );
        if (!assessmentDelivery)
          throw new Error("Scalar reconciliation assessment unavailable");

        if (
          assessmentDelivery.visibility === "available" &&
          assessmentDelivery.result?.status === "CONFLICTING" &&
          assessmentDelivery.result.reconciliationRequired === true &&
          assessment.event
        ) {
          const conflicts = (assessmentDelivery.result.conflicts ?? [])
            .map((c) => ({
              kind: c.kind,
              recordedConflictId: c.recordedConflictId ?? null,
              versionIds: [...c.versionIds].sort(),
              evidenceIds: [...c.evidenceIds].sort(),
            }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

          const contributorIdentity = JSON.stringify([
            actor.customerId,
            request.projectId,
            fact.id,
            assessment.event.id,
            conflicts,
          ]);
          const contributorHash = identityHash(contributorIdentity);
          const business = {
            customerId: actor.customerId,
            projectId: request.projectId,
            factId: fact.id,
            policyRevisionId: assessment.event.id,
            contributorHash,
          };
          const existing = await tx.scalarReconciliationRequest.findUnique({
            where: {
              customerId_projectId_factId_policyRevisionId_contributorHash:
                business,
            },
            select: { id: true, sealed: true, state: true, contributorIdentity: true },
          });
          if (existing) {
            if (
              !existing.sealed ||
              existing.contributorIdentity !== contributorIdentity
            )
              throw new Error("Scalar reconciliation identity collision");
            requestId = existing.id;
            outcome = "REUSED";
          } else {
            requestId = this.idFactory();
            outcome = "CREATED";
            const auditEventId = this.idFactory();
            await tx.scalarReconciliationRequest.create({
              data: {
                id: requestId,
                ...business,
                factType: fact.factType,
                originalAssessmentId: assessment.id,
                originCommandId: checkId,
                contributorIdentity,
                createdBy: actor.subject,
                createdAt: occurredAt,
                state: "OPEN",
                auditEventId,
                sealed: false,
              },
            });
            await tx.auditEvent.create({
              data: {
                id: auditEventId,
                customerId: actor.customerId,
                actor: actor.subject,
                correlationId: context.correlationId,
                occurredAt,
                event: "scalar.reconciliation.requested",
                detail: {
                  projectId: request.projectId,
                  factId: fact.id,
                  requestId,
                  assessmentId: assessment.id,
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

        const checkAuditEventId = this.idFactory();
        await tx.scalarReconciliationCheck.create({
          data: {
            id: checkId,
            customerId: actor.customerId,
            projectId: request.projectId,
            factId: fact.id,
            subject: actor.subject,
            idempotencyKey: request.idempotencyKey,
            requestHash,
            assessmentId: assessment.id,
            requestId,
            outcome,
            occurredAt,
            auditEventId: checkAuditEventId,
          },
        });
        await tx.auditEvent.create({
          data: {
            id: checkAuditEventId,
            customerId: actor.customerId,
            actor: actor.subject,
            correlationId: context.correlationId,
            occurredAt,
            event: "scalar.reconciliation.checked",
            detail: {
              projectId: request.projectId,
              factId: fact.id,
              checkId,
              outcome,
            },
          },
        });
        if (outcome === "CREATED") {
          await tx.scalarReconciliationRequest.update({
            where: { id: requestId! },
            data: { sealed: true },
          });
        }
        return {
          checkId,
          outcome,
          replayed: false,
          assessment: assessmentDeliverySchema.parse(assessmentDelivery),
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
          "scalar.reconciliation.check",
          error,
        );
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Scalar reconciliation check unavailable");
    }
  }

  async get(
    actorValue: Actor,
    requestValue: ScalarReconciliationRead,
  ): Promise<ScalarReconciliationDelivery | null> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        scalarReconciliationReadSchema.parse(requestValue),
      );
    try {
      return await this.db.$transaction(async (tx) => {
        let isManager = false;
        try {
          await authorizeReconciliation(tx, actor, request.projectId, "manage");
          isManager = true;
        } catch {
          await authorizeReconciliation(
            tx,
            actor,
            request.projectId,
            "recipient",
          );
        }
        const row = await tx.scalarReconciliationRequest.findFirst({
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
          (!isManager &&
            (row.assignments[0]?.reason !== "ASSIGNED" ||
              row.assignments[0].recipientSubject !== actor.subject))
        )
          throw new ProjectFactError("DENIED");
        const valid = await tx.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_scalar_reconciliation_request(${row.id}::uuid) AS valid`;
        if (valid[0]?.valid !== true)
          throw new Error("Scalar reconciliation integrity failed");
        const delivery = await this.authorities.deliverInTransaction(
          tx,
          actor,
          request.projectId,
          row.originalAssessmentId,
          false,
        );
        if (!delivery)
          throw new Error("Scalar reconciliation proof unavailable");
        return {
          request: await this.summary(
            tx,
            actor.customerId,
            request.projectId,
            request.requestId,
          ),
          assessment: assessmentDeliverySchema.parse(delivery),
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Scalar reconciliation request unavailable");
    }
  }

  async list(
    actorValue: Actor,
    requestValue: ScalarReconciliationList,
    mode: "manage" | "recipient",
  ): Promise<ScalarReconciliationPage | null> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        scalarReconciliationListSchema.parse(requestValue),
      );
    if (mode !== "manage" && mode !== "recipient")
      throw new ProjectFactError("INVALID_REQUEST");
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeReconciliation(tx, actor, request.projectId, mode);
        const rows = await tx.scalarReconciliationRequest.findMany({
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
              throw new Error("Scalar reconciliation assignment unavailable");
            return {
              id: row.id,
              projectId: row.projectId,
              factId: row.factId,
              factType: row.factType,
              createdAt: row.createdAt.toISOString(),
              state: row.state as "OPEN" | "RESOLVED",
              resolvedAssessmentId: row.resolvedAssessmentId,
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
      throw new Error("Scalar reconciliation queue unavailable");
    }
  }

  async refreshAssignment(
    actorValue: Actor,
    requestValue: ScalarReconciliationAssignmentRefresh,
    contextValue: FactMutationContext,
  ): Promise<ReconciliationAssignmentResult> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        scalarReconciliationAssignmentRefreshSchema.parse(requestValue),
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
        const row = await tx.scalarReconciliationRequest.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            id: request.requestId,
            sealed: true,
          },
          select: { id: true },
        });
        if (!row) throw new ProjectFactError("DENIED");
        const prior = await tx.scalarReconciliationAssignment.findUnique({
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
        const previous = await tx.scalarReconciliationAssignment.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            requestId: row.id,
          },
          orderBy: { revision: "desc" },
          select: { id: true, revision: true },
        });
        if (!previous)
          throw new Error("Scalar reconciliation assignment unavailable");
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
          "scalar.reconciliation.assignment",
          error,
        );
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Scalar reconciliation assignment unavailable");
    }
  }

  async resolve(
    actorValue: Actor,
    requestValue: ScalarReconciliationResolve,
    contextValue: FactMutationContext,
  ): Promise<ScalarReconciliationCheckResult> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        scalarReconciliationResolveSchema.parse(requestValue),
      ),
      context = factInput(() => factMutationContextSchema.parse(contextValue));
    const requestHash = hash({
      projectId: request.projectId,
      requestId: request.requestId,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeReconciliation(tx, actor, request.projectId, "manage");
        const req = await tx.scalarReconciliationRequest.findFirst({
          where: {
            id: request.requestId,
            customerId: actor.customerId,
            projectId: request.projectId,
            sealed: true,
          },
        });
        if (!req) throw new ProjectFactError("DENIED");
        const fact = await tx.projectFact.findUnique({
          where: {
            customerId_projectId_id: {
              customerId: actor.customerId,
              projectId: request.projectId,
              id: req.factId,
            },
          },
        });
        if (!fact) throw new ProjectFactError("DENIED");
        const key = {
          customerId: actor.customerId,
          projectId: request.projectId,
          factId: fact.id,
          subject: actor.subject,
          idempotencyKey: request.idempotencyKey,
        };
        const prior = await tx.scalarReconciliationCheck.findUnique({
          where: {
            customerId_projectId_factId_subject_idempotencyKey: key,
          },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
          return this.checkView(tx, actor, prior, true);
        }

        const checkId = this.idFactory();
        const occurredAt = request.asOf
          ? new Date(request.asOf)
          : await this.time(tx);
        const assessment =
          await this.authorities.captureAssessmentInTransaction(tx, actor, {
            projectId: request.projectId,
            fact,
            asOf: occurredAt,
            subject: actor.subject,
            idempotencyKey: "rc_" + checkId.replaceAll("-", ""),
            requestHash,
            captureKind: "SCALAR",
            milestoneAssessmentId: null,
            reconciliationCheckId: checkId,
          });

        const assessmentDelivery =
          await this.authorities.deliverInTransaction(
            tx,
            actor,
            request.projectId,
            assessment.id,
            false,
          );
        if (!assessmentDelivery)
          throw new Error("Scalar reconciliation assessment unavailable");

        let outcome: ScalarReconciliationCheckResult["outcome"];
        if (
          assessmentDelivery.visibility === "available" &&
          assessmentDelivery.result?.status !== "CONFLICTING"
        ) {
          outcome = "RESOLVED";
          await tx.scalarReconciliationRequest.update({
            where: { id: req.id },
            data: { state: "RESOLVED", resolvedAssessmentId: assessment.id },
          });
        } else {
          outcome = "REUSED";
        }

        const checkAuditEventId = this.idFactory();
        await tx.scalarReconciliationCheck.create({
          data: {
            id: checkId,
            customerId: actor.customerId,
            projectId: request.projectId,
            factId: fact.id,
            subject: actor.subject,
            idempotencyKey: request.idempotencyKey,
            requestHash,
            assessmentId: assessment.id,
            requestId: req.id,
            outcome,
            occurredAt,
            auditEventId: checkAuditEventId,
          },
        });
        await tx.auditEvent.create({
          data: {
            id: checkAuditEventId,
            customerId: actor.customerId,
            actor: actor.subject,
            correlationId: context.correlationId,
            occurredAt,
            event: "scalar.reconciliation.checked",
            detail: {
              projectId: request.projectId,
              factId: fact.id,
              checkId,
              outcome,
            },
          },
        });

        return {
          checkId,
          outcome,
          replayed: false,
          assessment: assessmentDeliverySchema.parse(assessmentDelivery),
          request: await this.summary(
            tx,
            actor.customerId,
            request.projectId,
            req.id,
          ),
        };
      }, options);
    } catch (error) {
      if (error instanceof ProjectFactError) {
        await this.deniedAudit(
          actor,
          request.projectId,
          context,
          "scalar.reconciliation.resolve",
          error,
        );
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Scalar reconciliation resolve unavailable");
    }
  }
}
