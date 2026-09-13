import { createHash, randomUUID } from "node:crypto";
import {
  ProjectFactError,
  factMutationContextSchema,
  reconciliationAssignmentSchema,
  scalarReconciliationCheckSchema,
  scalarReconciliationCheckResultSchema,
  scalarReconciliationReadSchema,
  scalarReconciliationListSchema,
  scalarReconciliationDeliverySchema,
  scalarReconciliationAssignmentRefreshSchema,
  scalarReconciliationIdentity,
  scalarReconciliationRuleRevision,
  type Actor,
  type FactMutationContext,
  type ScalarReconciliationRepository,
  type ScalarReconciliationCheck,
  type ScalarReconciliationCheckResult,
  type ScalarReconciliationRead,
  type ScalarReconciliationDelivery,
  type ScalarReconciliationList,
  type ScalarReconciliationPage,
  type ScalarReconciliationRequestSummary,
  type ScalarReconciliationAssignmentRefresh,
  type ScalarReconciliationAssignmentResult,
} from "@pdaa/domain";
import type {
  Prisma,
  PrismaClient as Database,
} from "./generated/prisma/client.js";
import { actorInput, factInput } from "./fact-authorization.js";
import {
  authorizeReconciliation,
  type ReconciliationRouting,
} from "./reconciliation-authorization.js";
import { DatabaseAuthorityRepository } from "./authority-persistence.js";

type Tx = Prisma.TransactionClient;
const options = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5000,
  timeout: 10000,
};
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const hash = (value: unknown) => digest(JSON.stringify(value));
const summarySelect = {
  id: true,
  projectId: true,
  factId: true,
  createdAt: true,
  fact: { select: { factType: true } },
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
type SummaryRow = Prisma.ScalarReconciliationRequestGetPayload<{
  select: typeof summarySelect;
}>;
type AssignmentRow = {
  id: string;
  revision: number;
  occurredAt: Date;
  reason: string;
  recipientSubject: string | null;
};
type Routing = ReconciliationRouting & {
  capturedPortfolioId: string;
  configurationReceiptId: string | null;
};
const assignmentView = (row: AssignmentRow) =>
  reconciliationAssignmentSchema.parse({
    id: row.id,
    revision: row.revision,
    occurredAt: row.occurredAt.toISOString(),
    reason: row.reason,
    recipientSubject: row.recipientSubject,
  });
function summaryView(row: SummaryRow): ScalarReconciliationRequestSummary {
  if (!row.assignments[0])
    throw new Error("Scalar reconciliation assignment unavailable");
  return {
    id: row.id,
    projectId: row.projectId,
    factId: row.factId,
    factType: row.fact.factType,
    createdAt: row.createdAt.toISOString(),
    state: "OPEN",
    assignment: assignmentView(row.assignments[0]),
  };
}

// FR-EVD-007/009/012, NFR-SEC-001, NFR-REL-001/002: one fresh owned proof
// per command; business deduplication never replaces original proof or routing.
export class DatabaseScalarReconciliationRepository
  implements ScalarReconciliationRepository
{
  private readonly authority: DatabaseAuthorityRepository;
  constructor(
    private readonly db: Database,
    private readonly idFactory: () => string = randomUUID,
  ) {
    this.authority = new DatabaseAuthorityRepository(db);
  }
  private async time(tx: Tx) {
    const rows = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    return rows[0]!.now;
  }
  private async routing(
    tx: Tx,
    actor: Actor,
    projectId: string,
  ): Promise<Routing> {
    const { routing } = await authorizeReconciliation(
      tx,
      actor,
      projectId,
      "manage",
    );
    // Project remains locked; never fabricate configuration for a legacy fact.
    const project = await tx.project.findFirst({
      where: { id: projectId, customerId: actor.customerId },
      select: { portfolioId: true },
    });
    if (!project) throw new ProjectFactError("DENIED");
    const receipt = await tx.canonicalCreationReceipt.findFirst({
      where: {
        customerId: actor.customerId,
        projectId,
        operation: "PROJECT",
        project: { sealed: true },
      },
      select: { id: true },
    });
    return {
      ...routing,
      capturedPortfolioId: project.portfolioId,
      configurationReceiptId: receipt?.id ?? null,
    };
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
    actor: Actor,
    projectId: string,
    requestId: string,
  ) {
    const row = await tx.scalarReconciliationRequest.findFirst({
      where: {
        id: requestId,
        customerId: actor.customerId,
        projectId,
        sealed: true,
      },
      select: summarySelect,
    });
    if (!row) throw new Error("Scalar reconciliation history unavailable");
    return summaryView(row);
  }
  private async assign(
    tx: Tx,
    actor: Actor,
    projectId: string,
    factId: string,
    requestId: string,
    routing: Routing,
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
        factId,
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
          factId,
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
    const assessment = await this.authority.deliverAssessmentInTransaction(
      tx,
      actor,
      row.projectId,
      row.assessmentId,
      replayed,
    );
    if (!assessment) throw new Error("Scalar reconciliation proof unavailable");
    return scalarReconciliationCheckResultSchema.parse({
      checkId: row.id,
      outcome: row.outcome,
      replayed,
      assessment,
      request: row.requestId
        ? await this.summary(tx, actor, row.projectId, row.requestId)
        : null,
    });
  }
  async check(
    actorValue: Actor,
    requestValue: ScalarReconciliationCheck,
    contextValue: FactMutationContext,
  ): Promise<ScalarReconciliationCheckResult> {
    const actor = actorInput(actorValue),
      request = factInput(() =>
        scalarReconciliationCheckSchema.parse(requestValue),
      ),
      context = factInput(() => factMutationContextSchema.parse(contextValue));
    const requestHash = hash({
      projectId: request.projectId,
      factId: request.factId,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        // Prisma's timestamp parameters and retained assessment guards must use
        // the same UTC convention, irrespective of the connection's timezone.
        // LOCAL expires at transaction end; no pooled-session state is changed.
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        const routing = await this.routing(tx, actor, request.projectId);
        const key = {
          customerId: actor.customerId,
          projectId: request.projectId,
          subject: actor.subject,
          idempotencyKey: request.idempotencyKey,
        };
        const prior = await tx.scalarReconciliationCheck.findUnique({
          where: { customerId_projectId_subject_idempotencyKey: key },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
          return this.checkView(tx, actor, prior, true);
        }
        const facts = await tx.$queryRaw<
          { id: string; factType: string; revision: number }[]
        >`
          SELECT id,"factType",revision FROM public."ProjectFact" WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${request.projectId}::uuid AND id=${request.factId}::uuid FOR UPDATE`;
        const fact = facts[0];
        if (!fact) throw new ProjectFactError("DENIED");
        const asOf = await this.time(tx),
          checkId = this.idFactory();
        const prepared = await this.authority.prepareAssessmentInTransaction(
          tx,
          actor,
          { projectId: request.projectId, fact, asOf },
        );
        const identity = scalarReconciliationIdentity(prepared.result);
        const assessment =
          await this.authority.persistPreparedAssessmentInTransaction(
            tx,
            actor,
            {
              prepared,
              subject: actor.subject,
              idempotencyKey: "sr_" + checkId.replaceAll("-", ""),
              requestHash,
              captureKind: "SCALAR_REQUEST",
              milestoneAssessmentId: null,
              scalarReconciliationCheckId: checkId,
            },
          );
        let requestId: string | null = null;
        let outcome: ScalarReconciliationCheckResult["outcome"] = "NO_REQUEST";
        if (identity !== null) {
          const contributorHash = digest(identity);
          const priorRequest = await tx.scalarReconciliationRequest.findUnique({
            where: {
              customerId_projectId_factId_ruleRevision_contributorHash: {
                customerId: actor.customerId,
                projectId: request.projectId,
                factId: request.factId,
                ruleRevision: scalarReconciliationRuleRevision,
                contributorHash,
              },
            },
          });
          if (priorRequest) {
            if (
              !priorRequest.sealed ||
              priorRequest.contributorIdentity !== identity
            )
              throw new Error(
                "Scalar reconciliation identity integrity failed",
              );
            requestId = priorRequest.id;
            outcome = "REUSED";
          } else {
            requestId = this.idFactory();
            outcome = "CREATED";
            const auditEventId = this.idFactory();
            await tx.scalarReconciliationRequest.create({
              data: {
                id: requestId,
                customerId: actor.customerId,
                projectId: request.projectId,
                factId: request.factId,
                ruleRevision: scalarReconciliationRuleRevision,
                originalAssessmentId: assessment.id,
                originCommandId: checkId,
                contributorHash,
                contributorIdentity: identity,
                createdBy: actor.subject,
                createdAt: asOf,
                auditEventId,
              },
              select: { id: true },
            });
            await tx.auditEvent.create({
              data: {
                id: auditEventId,
                customerId: actor.customerId,
                actor: actor.subject,
                correlationId: context.correlationId,
                occurredAt: asOf,
                event: "scalar.reconciliation.requested",
                detail: {
                  projectId: request.projectId,
                  factId: request.factId,
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
              request.factId,
              requestId,
              routing,
              asOf,
              context,
              null,
              null,
            );
          }
        }
        const auditEventId = this.idFactory();
        const checked = await tx.scalarReconciliationCheck.create({
          data: {
            ...key,
            id: checkId,
            factId: request.factId,
            requestHash,
            assessmentId: assessment.id,
            requestId,
            outcome,
            occurredAt: asOf,
            auditEventId,
          },
        });
        await tx.auditEvent.create({
          data: {
            id: auditEventId,
            customerId: actor.customerId,
            actor: actor.subject,
            correlationId: context.correlationId,
            occurredAt: asOf,
            event: "scalar.reconciliation.checked",
            detail: {
              projectId: request.projectId,
              factId: request.factId,
              checkId,
              assessmentId: assessment.id,
              requestId,
              outcome,
            },
          },
        });
        if (outcome === "CREATED")
          await tx.scalarReconciliationRequest.update({
            where: { id: requestId! },
            data: { sealed: true },
            select: { id: true },
          });
        return this.checkView(tx, actor, checked, false);
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
        await authorizeReconciliation(
          tx,
          actor,
          request.projectId,
          "recipient",
        );
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
          row.assignments[0]?.reason !== "ASSIGNED" ||
          row.assignments[0].recipientSubject !== actor.subject
        )
          throw new ProjectFactError("DENIED");
        const valid = await tx.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_scalar_reconciliation_request(${row.id}::uuid) AS valid`;
        if (valid[0]?.valid !== true)
          throw new Error("Scalar reconciliation integrity failed");
        const assessment = await this.authority.deliverAssessmentInTransaction(
          tx,
          actor,
          request.projectId,
          row.originalAssessmentId,
          false,
        );
        if (!assessment)
          throw new Error("Scalar reconciliation proof unavailable");
        return scalarReconciliationDeliverySchema.parse({
          request: summaryView(row),
          assessment,
        });
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
          requests: page.map(summaryView),
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
  ): Promise<ScalarReconciliationAssignmentResult> {
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
        await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
        const routing = await this.routing(tx, actor, request.projectId);
        const row = await tx.scalarReconciliationRequest.findFirst({
          where: {
            id: request.requestId,
            customerId: actor.customerId,
            projectId: request.projectId,
            sealed: true,
          },
          select: { id: true, factId: true },
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
            row.factId,
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
}
