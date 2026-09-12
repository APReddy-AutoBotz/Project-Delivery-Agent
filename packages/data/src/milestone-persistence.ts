import { createHash, randomUUID } from "node:crypto";
import {
  evaluateMilestoneConsistency,
  factMutationContextSchema,
  milestoneConsistencyCaptureSchema,
  milestoneConsistencyReadSchema,
  projectFactValueSchema,
  stateBindingCreateSchema,
  ProjectFactError,
  type Actor,
  type CanonicalStateBindingView,
  type FactHistoryEntry,
  type FactMutationContext,
  type MilestoneConsistencyCapture,
  type MilestoneConsistencyDelivery,
  type MilestoneConsistencyRead,
  type MilestoneConsistencyRepository,
  type StateBindingCreate,
} from "@pdaa/domain";
import {
  Prisma,
  type PrismaClient as Database,
} from "./generated/prisma/client.js";
import {
  actorInput,
  authorizeFactProject,
  factInput,
} from "./fact-authorization.js";
import { DatabaseAuthorityRepository } from "./authority-persistence.js";

type Tx = Prisma.TransactionClient;
type StoredMilestoneResult = Extract<
  MilestoneConsistencyDelivery,
  { visibility: "available" }
>["result"];
const transactionOptions = {
  isolationLevel: "ReadCommitted" as const,
  maxWait: 5000,
  timeout: 10000,
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const childKey = (assessmentId: string, bindingId: string) =>
  `mc_${assessmentId.replaceAll("-", "")}_${bindingId.replaceAll("-", "")}`;

export class DatabaseMilestoneConsistencyRepository
  implements MilestoneConsistencyRepository
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
    if (!row) throw new Error("Binding version unavailable");
    const access = await tx.factSourceAccess.findFirst({
      where: {
        customerId: actor.customerId,
        projectId,
        factId: row.factId,
        sourceId: row.sourceId,
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

  private async bindingView(
    tx: Tx,
    actor: Actor,
    projectId: string,
    bindingId: string,
    replayed: boolean,
  ): Promise<CanonicalStateBindingView> {
    const row = await tx.canonicalStateBinding.findFirst({
      where: {
        id: bindingId,
        customerId: actor.customerId,
        projectId,
        sealed: true,
      },
      include: { receipt: true },
    });
    if (!row?.receipt) throw new Error("Binding unavailable");
    const valid = await tx.$queryRaw<{ valid: boolean }[]>`
      SELECT public.valid_canonical_state_binding(${bindingId}::uuid) AS valid`;
    if (valid[0]?.valid !== true)
      throw new Error("Stored binding integrity failed");
    return {
      id: row.id,
      projectId,
      targetKind: row.targetKind === "MILESTONE" ? "MILESTONE" : "WORK_ITEM",
      targetId: (row.milestoneId ?? row.workItemId)!,
      field: "state",
      factId: row.factId,
      factType: row.factType,
      createdAt: row.createdAt.toISOString(),
      replayed,
      entry: await this.entry(tx, actor, projectId, row.receipt.versionId),
    };
  }

  private async deniedAudit(
    actor: Actor,
    projectId: string,
    context: FactMutationContext,
    operation: string,
    error: ProjectFactError,
  ) {
    try {
      await this.db.auditEvent.create({
        data: {
          customerId: actor.customerId,
          actor: actor.subject,
          correlationId: context.correlationId,
          event: operation + ".denied",
          detail: { projectId, reason: error.code },
        },
      });
    } catch {
      throw new Error("Milestone persistence audit failed");
    }
  }

  async createStateBinding(
    actorValue: Actor,
    requestValue: StateBindingCreate,
    contextValue: FactMutationContext,
  ): Promise<CanonicalStateBindingView> {
    const actor = actorInput(actorValue);
    const request = factInput(() =>
      stateBindingCreateSchema.parse(requestValue),
    );
    const context = factInput(() =>
      factMutationContextSchema.parse(contextValue),
    );
    const requestHash = digest({
      projectId: request.projectId,
      targetKind: request.targetKind,
      targetId: request.targetId,
      initialState: request.initialState,
      effectiveAt: request.effectiveAt,
      validUntil: request.validUntil,
      originalStatement: request.originalStatement,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeFactProject(tx, actor, request.projectId, "append");
        const key = {
          customerId: actor.customerId,
          projectId: request.projectId,
          subject: actor.subject,
          idempotencyKey: request.idempotencyKey,
        };
        const prior = await tx.canonicalStateBindingReceipt.findUnique({
          where: { customerId_projectId_subject_idempotencyKey: key },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
          return this.bindingView(
            tx,
            actor,
            request.projectId,
            prior.bindingId,
            true,
          );
        }
        const canonical = await tx.canonicalProject.findFirst({
          where: {
            customerId: actor.customerId,
            id: request.projectId,
            sealed: true,
          },
          select: { id: true },
        });
        const target =
          request.targetKind === "MILESTONE"
            ? await tx.milestone.findFirst({
                where: {
                  customerId: actor.customerId,
                  projectId: request.projectId,
                  id: request.targetId,
                },
                select: { id: true },
              })
            : await tx.workItem.findFirst({
                where: {
                  customerId: actor.customerId,
                  projectId: request.projectId,
                  id: request.targetId,
                },
                select: { id: true },
              });
        if (!canonical || !target) throw new ProjectFactError("DENIED");
        const bindingId = this.idFactory();
        let factType: string | null = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const candidate =
            "canonical.state." +
            this.idFactory().replaceAll("-", "").toLowerCase();
          const [fact, policy] = await Promise.all([
            tx.projectFact.findUnique({
              where: {
                customerId_projectId_factType: {
                  customerId: actor.customerId,
                  projectId: request.projectId,
                  factType: candidate,
                },
              },
              select: { id: true },
            }),
            tx.authorityPolicy.findUnique({
              where: {
                customerId_projectId_factType: {
                  customerId: actor.customerId,
                  projectId: request.projectId,
                  factType: candidate,
                },
              },
              select: { id: true },
            }),
          ]);
          if (!fact && !policy) {
            factType = candidate;
            break;
          }
        }
        if (!factType) throw new Error("Binding key allocation exhausted");
        const createdAt = await this.time(tx);
        const factId = this.idFactory();
        const sourceId = this.idFactory();
        const evidenceId = this.idFactory();
        const versionId = this.idFactory();
        const auditEventId = this.idFactory();
        await tx.projectFact.create({
          data: {
            id: factId,
            customerId: actor.customerId,
            projectId: request.projectId,
            factType,
            bindingBirthId: bindingId,
            createdAt,
          },
        });
        await tx.canonicalStateBinding.create({
          data: {
            id: bindingId,
            customerId: actor.customerId,
            projectId: request.projectId,
            targetKind: request.targetKind,
            milestoneId:
              request.targetKind === "MILESTONE" ? request.targetId : null,
            workItemId:
              request.targetKind === "WORK_ITEM" ? request.targetId : null,
            factId,
            factType,
            createdBy: actor.subject,
            createdAt,
          },
        });
        const factScope = {
          customerId: actor.customerId,
          projectId: request.projectId,
          factId,
        };
        await tx.factSource.create({
          data: { ...factScope, id: sourceId, providedBy: actor.subject },
        });
        await tx.factSourceAccess.create({
          data: { ...factScope, sourceId, state: "AVAILABLE" },
        });
        await tx.factSourceReader.create({
          data: { ...factScope, sourceId, subject: actor.subject },
        });
        await tx.factEvidence.create({
          data: {
            ...factScope,
            id: evidenceId,
            sourceId,
            providedBy: actor.subject,
            observedAt: createdAt,
            originalStatement: request.originalStatement,
          },
        });
        await tx.projectFactVersion.create({
          data: {
            ...factScope,
            id: versionId,
            sourceId,
            evidenceId,
            revision: 1,
            value: { type: "text", value: request.initialState },
            effectiveAt: new Date(request.effectiveAt),
            validUntil:
              request.validUntil === null ? null : new Date(request.validUntil),
          },
        });
        await tx.auditEvent.create({
          data: {
            id: auditEventId,
            customerId: actor.customerId,
            actor: actor.subject,
            correlationId: context.correlationId,
            event: "fact.binding.created",
            occurredAt: createdAt,
            detail: {
              projectId: request.projectId,
              bindingId,
              factId,
              versionId,
              evidenceId,
            },
          },
        });
        await tx.canonicalStateBindingReceipt.create({
          data: {
            id: this.idFactory(),
            ...key,
            requestHash,
            bindingId,
            factId,
            sourceId,
            evidenceId,
            versionId,
            initialSourceAccessRevision: 2,
            initialSourceAccessState: "AVAILABLE",
            initialReaderSubject: actor.subject,
            auditEventId,
          },
        });
        await tx.canonicalStateBinding.update({
          where: { id: bindingId },
          data: { sealed: true },
        });
        const valid = await tx.$queryRaw<
          { valid: boolean }[]
        >`SELECT public.valid_canonical_state_binding(${bindingId}::uuid) AS valid`;
        if (valid[0]?.valid !== true)
          throw new Error("Binding integrity failed");
        return this.bindingView(tx, actor, request.projectId, bindingId, false);
      }, transactionOptions);
    } catch (error) {
      if (error instanceof ProjectFactError) {
        await this.deniedAudit(
          actor,
          request.projectId,
          context,
          "fact.binding",
          error,
        );
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Milestone persistence failed");
    }
  }

  private async deliver(
    tx: Tx,
    actor: Actor,
    request: MilestoneConsistencyRead,
    replayed: boolean,
  ): Promise<MilestoneConsistencyDelivery | null> {
    const row = await tx.milestoneConsistencyAssessment.findFirst({
      where: {
        id: request.assessmentId,
        customerId: actor.customerId,
        projectId: request.projectId,
        sealed: true,
      },
      include: {
        scalarAssessments: {
          include: { versions: { include: { version: true } } },
        },
      },
    });
    if (!row) return null;
    const valid = await tx.$queryRaw<
      { valid: boolean }[]
    >`SELECT public.valid_milestone_consistency_assessment(${row.id}::uuid) AS valid`;
    if (valid[0]?.valid !== true)
      throw new Error("Stored milestone assessment integrity failed");
    const dependencies = row.scalarAssessments.flatMap((assessment) =>
      assessment.versions.map((item) => item.version),
    );
    const access = await tx.factSourceAccess.findMany({
      where: {
        customerId: actor.customerId,
        projectId: request.projectId,
        sourceId: {
          in: [...new Set(dependencies.map((item) => item.sourceId))],
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
      projectId: row.projectId,
      milestoneId: row.milestoneId,
      asOf: row.asOf.toISOString(),
      historical: true as const,
      replayed,
    };
    if (dependencies.some((item) => !allowed.has(item.sourceId)))
      return {
        ...metadata,
        visibility: "restricted",
        revalidationRequired: true,
        result: null,
      };
    return {
      ...metadata,
      visibility: "available",
      revalidationRequired: false,
      result: row.result as unknown as StoredMilestoneResult,
    };
  }

  async captureMilestoneConsistency(
    actorValue: Actor,
    requestValue: MilestoneConsistencyCapture,
    contextValue: FactMutationContext,
  ): Promise<MilestoneConsistencyDelivery> {
    const actor = actorInput(actorValue);
    const request = factInput(() =>
      milestoneConsistencyCaptureSchema.parse(requestValue),
    );
    const context = factInput(() =>
      factMutationContextSchema.parse(contextValue),
    );
    const requestHash = digest({
      projectId: request.projectId,
      milestoneId: request.milestoneId,
      ruleRevision: request.ruleRevision,
      enabled: request.enabled,
    });
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeFactProject(tx, actor, request.projectId, "append");
        const key = {
          customerId: actor.customerId,
          projectId: request.projectId,
          subject: actor.subject,
          idempotencyKey: request.idempotencyKey,
        };
        const previous = await tx.milestoneConsistencyAssessment.findUnique({
          where: { customerId_projectId_subject_idempotencyKey: key },
        });
        if (previous) {
          if (previous.requestHash !== requestHash)
            throw new ProjectFactError("IDEMPOTENCY_CONFLICT");
          const delivery = await this.deliver(
            tx,
            actor,
            { projectId: request.projectId, assessmentId: previous.id },
            true,
          );
          if (!delivery) throw new Error("Milestone assessment unavailable");
          return delivery;
        }
        const canonical = await tx.canonicalProject.findFirst({
          where: {
            customerId: actor.customerId,
            id: request.projectId,
            sealed: true,
          },
          include: { canonicalCreationReceipt_project: true },
        });
        const milestone = await tx.milestone.findFirst({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            id: request.milestoneId,
          },
          select: { id: true },
        });
        if (!canonical?.canonicalCreationReceipt_project || !milestone)
          throw new ProjectFactError("DENIED");
        const links = await tx.requiredWorkItem.findMany({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            milestoneId: request.milestoneId,
          },
          orderBy: { id: "asc" },
          take: 51,
        });
        const slots = [
          { targetKind: "MILESTONE" as const, targetId: request.milestoneId },
          ...links.map((row) => ({
            targetKind: "WORK_ITEM" as const,
            targetId: row.workItemId,
          })),
        ];
        const bindings = await tx.canonicalStateBinding.findMany({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            sealed: true,
            OR: [
              { milestoneId: request.milestoneId },
              { workItemId: { in: links.map((row) => row.workItemId) } },
            ],
          },
          orderBy: { id: "asc" },
        });
        const byTarget = new Map(
          bindings.map((row) => [
            `${row.targetKind}:${row.milestoneId ?? row.workItemId}`,
            row,
          ]),
        );
        const facts = await tx.projectFact.findMany({
          where: {
            customerId: actor.customerId,
            projectId: request.projectId,
            id: { in: bindings.map((row) => row.factId) },
          },
          orderBy: { id: "asc" },
        });
        if (facts.length)
          await tx.$queryRaw`SELECT id FROM public."ProjectFact"
            WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${request.projectId}::uuid
              AND id IN (${Prisma.join(facts.map((fact) => Prisma.sql`${fact.id}::uuid`))})
            ORDER BY id FOR UPDATE`;
        const expected = {
          receipt: canonical.canonicalCreationReceipt_project.id,
          milestone: milestone.id,
          links: links.map((row) => [row.id, row.milestoneId, row.workItemId]),
          bindings: bindings.map((row) => [
            row.id,
            row.targetKind,
            row.milestoneId,
            row.workItemId,
            row.factId,
            row.factType,
          ]),
          facts: facts.map((row) => [
            row.id,
            row.factType,
            row.revision,
            row.bindingBirthId,
          ]),
        };
        // One bounded re-read statement, after coordination and before asOf.
        // JSONB equality is structural; neither JSON property order nor hashes
        // are substituted for comparison of the actual database identities.
        const coherent = await tx.$queryRaw<{ valid: boolean }[]>`
          WITH required AS (
            SELECT id,"milestoneId","workItemId" FROM public."RequiredWorkItem"
            WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${request.projectId}::uuid AND "milestoneId"=${request.milestoneId}::uuid ORDER BY id LIMIT 51
          ), bound AS (
            SELECT * FROM public."CanonicalStateBinding" WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${request.projectId}::uuid AND sealed
              AND ("milestoneId"=${request.milestoneId}::uuid OR "workItemId" IN (SELECT "workItemId" FROM required))
          )
          SELECT jsonb_build_object(
            'receipt',(SELECT r.id FROM public."CanonicalProject" p JOIN public."CanonicalCreationReceipt" r ON r."projectId"=p.id AND r."customerId"=p."customerId" WHERE p."customerId"=${actor.customerId}::uuid AND p.id=${request.projectId}::uuid AND p.sealed),
            'milestone',(SELECT id FROM public."Milestone" WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${request.projectId}::uuid AND id=${request.milestoneId}::uuid),
            'links',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,"milestoneId","workItemId") ORDER BY id),'[]'::jsonb) FROM required),
            'bindings',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,"targetKind","milestoneId","workItemId","factId","factType") ORDER BY id),'[]'::jsonb) FROM bound),
            'facts',(SELECT COALESCE(jsonb_agg(jsonb_build_array(id,"factType",revision,"bindingBirthId") ORDER BY id),'[]'::jsonb) FROM public."ProjectFact" WHERE "customerId"=${actor.customerId}::uuid AND "projectId"=${request.projectId}::uuid AND id IN (SELECT "factId" FROM bound))
          )=${JSON.stringify(expected)}::jsonb AS valid`;
        if (coherent[0]?.valid !== true)
          throw new Error("Milestone capture coordination changed");
        const asOf = await this.time(tx);
        const assessmentId = this.idFactory();
        const auditEventId = this.idFactory();
        const minimal = {
          scope: {
            customerId: actor.customerId,
            projectId: request.projectId,
            milestoneId: request.milestoneId,
          },
          asOf: asOf.toISOString(),
          ruleRevision: request.ruleRevision,
          status: "INCOMPLETE" as const,
        };
        const factById = new Map(facts.map((row) => [row.id, row]));
        const prepared = new Map<
          string,
          Awaited<
            ReturnType<
              DatabaseAuthorityRepository["prepareAssessmentInTransaction"]
            >
          >
        >();
        let complete = links.length <= 50 && facts.length === bindings.length;
        const prefixes = complete
          ? await this.authority.loadAssessmentPrefixesInTransaction(
              tx,
              actor,
              request.projectId,
              facts,
              asOf,
            )
          : null;
        complete = complete && prefixes !== null;
        if (complete) {
          for (const binding of [...bindings].sort((a, b) =>
            a.factId.localeCompare(b.factId),
          )) {
            const fact = factById.get(binding.factId)!;
            const plan = await this.authority.prepareAssessmentInTransaction(
              tx,
              actor,
              {
                projectId: request.projectId,
                fact,
                asOf,
                prefix: prefixes!.get(fact.id)!,
              },
            );
            prepared.set(binding.id, plan);
            if (!plan.complete) complete = false;
          }
        }
        const preparedRows = [...prepared.values()];
        const versionCount = preparedRows.reduce(
          (sum, plan) => sum + plan.versions.length,
          0,
        );
        const conflictCount = preparedRows.reduce(
          (sum, plan) => sum + plan.conflicts.length,
          0,
        );
        const sourceCount = preparedRows.reduce(
          (sum, plan) => sum + plan.access.length,
          0,
        );
        const referenceCount = versionCount;
        const derivedCount = 4 * versionCount + 4 * conflictCount;
        complete =
          complete &&
          versionCount <= 1000 &&
          conflictCount <= 1000 &&
          sourceCount <= 1000 &&
          referenceCount <= 64000 &&
          derivedCount <= 64000;
        const result = complete
          ? evaluateMilestoneConsistency({
              scope: minimal.scope,
              asOf: minimal.asOf,
              ruleRevision: request.ruleRevision,
              enabled: request.enabled,
              complete: true,
              requiredWorkItemIds: links.map((row) => row.workItemId),
              targets: slots.map((slot) => {
                const binding = byTarget.get(
                  `${slot.targetKind}:${slot.targetId}`,
                );
                const child = binding ? prepared.get(binding.id) : undefined;
                return {
                  ...slot,
                  binding: binding
                    ? {
                        id: binding.id,
                        customerId: binding.customerId,
                        projectId: binding.projectId,
                        targetKind: slot.targetKind,
                        targetId: slot.targetId,
                        field: "state",
                        factId: binding.factId,
                        factType: binding.factType,
                      }
                    : null,
                  snapshot: child?.snapshot ?? null,
                };
              }),
            })
          : minimal;
        const resultRecord = result as unknown as Record<string, unknown>;
        const contributorCount =
          resultRecord.status === "CONFLICTING"
            ? (
                resultRecord.contributors as Array<{
                  supportingVersionIds: string[];
                }>
              ).reduce(
                (sum, contributor) =>
                  sum + contributor.supportingVersionIds.length,
                0,
              )
            : 0;
        await tx.milestoneConsistencyAssessment.create({
          data: {
            id: assessmentId,
            ...key,
            milestoneId: request.milestoneId,
            canonicalReceiptId: canonical.canonicalCreationReceipt_project.id,
            ruleRevision: request.ruleRevision,
            enabled: request.enabled,
            asOf,
            requestHash,
            status: resultRecord.status as string,
            complete,
            targetCount: complete ? slots.length : 0,
            requiredLinkCount: complete ? links.length : 0,
            versionCount: complete ? versionCount : 0,
            evidenceCount: complete ? versionCount : 0,
            conflictCount: complete ? conflictCount : 0,
            contributorCount: complete ? contributorCount : 0,
            result: json(result),
            auditEventId,
          },
          select: { id: true },
        });
        const captured = new Map<
          string,
          Awaited<
            ReturnType<
              DatabaseAuthorityRepository["persistPreparedAssessmentInTransaction"]
            >
          >
        >();
        if (complete)
          for (const binding of [...bindings].sort((a, b) =>
            a.factId.localeCompare(b.factId),
          )) {
            const child =
              await this.authority.persistPreparedAssessmentInTransaction(
                tx,
                actor,
                {
                  prepared: prepared.get(binding.id)!,
                  subject: actor.subject,
                  idempotencyKey: childKey(assessmentId, binding.id),
                  requestHash: digest({
                    captureKind: "MILESTONE",
                    assessmentId,
                    bindingId: binding.id,
                    projectId: request.projectId,
                    factType: binding.factType,
                    asOf: asOf.toISOString(),
                  }),
                  captureKind: "MILESTONE",
                  milestoneAssessmentId: assessmentId,
                },
              );
            captured.set(binding.id, child);
          }
        const targetRows = slots.map((slot) => {
          const binding = byTarget.get(`${slot.targetKind}:${slot.targetId}`);
          const child = binding ? captured.get(binding.id) : undefined;
          const link =
            slot.targetKind === "WORK_ITEM"
              ? links.find((row) => row.workItemId === slot.targetId)
              : undefined;
          return {
            id: this.idFactory(),
            customerId: actor.customerId,
            projectId: request.projectId,
            assessmentId,
            targetKind: slot.targetKind,
            milestoneId: request.milestoneId,
            workItemId: slot.targetKind === "WORK_ITEM" ? slot.targetId : null,
            requiredWorkItemId: link?.id ?? null,
            bindingId: binding?.id ?? null,
            factId: binding?.factId ?? null,
            factType: binding?.factType ?? null,
            scalarAssessmentId: child?.id ?? null,
          };
        });
        if (complete)
          await tx.milestoneConsistencyTarget.createMany({ data: targetRows });
        const contributorRows: Prisma.MilestoneConsistencyContributorVersionCreateManyInput[] =
          [];
        if (resultRecord.status === "CONFLICTING") {
          const contributors = resultRecord.contributors as Array<{
            bindingId: string;
            supportingVersionIds: string[];
          }>;
          for (const contributor of contributors) {
            const target = targetRows.find(
              (row) => row.bindingId === contributor.bindingId,
            )!;
            const child = captured.get(contributor.bindingId)!;
            for (const versionId of contributor.supportingVersionIds) {
              const version = child.versions.find(
                (row) => row.id === versionId,
              )!;
              contributorRows.push({
                customerId: actor.customerId,
                projectId: request.projectId,
                assessmentId,
                targetRowId: target.id,
                bindingId: contributor.bindingId,
                factId: target.factId!,
                versionId,
                sourceId: version.sourceId,
                evidenceId: version.evidenceId,
              });
            }
          }
          if (contributorRows.length)
            await tx.milestoneConsistencyContributorVersion.createMany({
              data: contributorRows,
            });
        }
        await tx.auditEvent.create({
          data: {
            id: auditEventId,
            customerId: actor.customerId,
            actor: actor.subject,
            correlationId: context.correlationId,
            event: "milestone.consistency.captured",
            occurredAt: asOf,
            detail: {
              projectId: request.projectId,
              assessmentId,
              milestoneId: request.milestoneId,
              status: resultRecord.status as string,
            },
          },
        });
        await tx.milestoneConsistencyAssessment.update({
          where: { id: assessmentId },
          data: { sealed: true },
          select: { id: true },
        });
        const delivery = await this.deliver(
          tx,
          actor,
          { projectId: request.projectId, assessmentId },
          false,
        );
        if (!delivery) throw new Error("Milestone assessment unavailable");
        return delivery;
      }, transactionOptions);
    } catch (error) {
      if (error instanceof ProjectFactError) {
        await this.deniedAudit(
          actor,
          request.projectId,
          context,
          "milestone.consistency",
          error,
        );
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Milestone consistency persistence failed");
    }
  }

  async getMilestoneConsistency(
    actorValue: Actor,
    requestValue: MilestoneConsistencyRead,
  ): Promise<MilestoneConsistencyDelivery | null> {
    const actor = actorInput(actorValue);
    const request = factInput(() =>
      milestoneConsistencyReadSchema.parse(requestValue),
    );
    try {
      return await this.db.$transaction(async (tx) => {
        await authorizeFactProject(tx, actor, request.projectId, "append");
        return this.deliver(tx, actor, request, false);
      }, transactionOptions);
    } catch (error) {
      if (error instanceof ProjectFactError && error.code === "DENIED")
        return null;
      if (error instanceof ProjectFactError) throw error;
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Milestone consistency history unavailable");
    }
  }
}
