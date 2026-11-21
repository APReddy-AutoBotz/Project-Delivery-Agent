import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect, it } from "vitest";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseIngestionRepository,
  DatabaseMilestoneConsistencyRepository,
  DatabaseProjectFactRepository,
} from "../packages/data/src/index.js";
import type { Prisma } from "../packages/data/src/generated/prisma/client.js";
import { CredentialVault } from "../packages/platform/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import { proveXlsxSourceGenesis } from "../scripts/acceptance/xlsx-source-genesis.mjs";
import { sourceAdmissionSubject } from "../scripts/acceptance/source-admission-role.mjs";

const connection = process.env.PDAA_DATABASE_URL;
const target = connection ? new URL(connection) : null;
if (!connection || !target || !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !/^\/pdaa_test_[0-9]+$/.test(target.pathname)) {
  throw new Error("Source observation tests require an isolated synthetic database");
}
const db = createDatabase(connection);
const { Pool } = createRequire(new URL("../packages/data/package.json", import.meta.url))("pg");
const pool = new Pool({ connectionString: connection });
afterAll(async () => {
  await db.$disconnect();
  await pool.end();
});

it("appends a verified workbook observation and replays its receipt after content purge", async () => {
  const asApi = <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: "ReadCommitted"; maxWait?: number; timeout?: number },
  ) => db.$transaction(async (tx) => {
    // Owned synthetic fixture only. XLSX's native gate checks session_user.
    await tx.$executeRaw`SET LOCAL SESSION AUTHORIZATION pdaa_api`;
    return operation(tx);
  }, options);
  const customerId = randomUUID();
  const portfolioId = randomUUID();
  const pmo = { customerId, subject: "synthetic-binding-pmo", roles: ["pmo_admin" as const] };
  const pm = { customerId, subject: "synthetic-binding-pm", roles: ["project_manager" as const] };
  await db.customer.create({ data: { id: customerId, name: "Synthetic observation tenant" } });
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic observation portfolio" } });
  await db.accessGrant.createMany({ data: [pmo, pm].map((actor) => ({
    customerId, subject: actor.subject, role: actor.roles[0]!, scopeType: "portfolio", scopeId: portfolioId,
  })) });
  const fixture = canonicalFixture(portfolioId);
  fixture.milestones.push(
    { ...fixture.milestones[0]!, key: "MS-2", name: "Source-born milestone" },
    { ...fixture.milestones[0]!, key: "MS-3", name: "Contested milestone" },
  );
  const { id: projectId } = await new DatabaseCanonicalProjectRepository(db)
    .createProject(pmo, fixture, randomUUID());
  const milestone = await db.milestone.findFirstOrThrow({ where: { customerId, projectId }, orderBy: { key: "asc" } });
  const binding = await new DatabaseMilestoneConsistencyRepository(db).createStateBinding(pm, {
    projectId, targetKind: "MILESTONE", targetId: milestone.id,
    idempotencyKey: randomUUID(), initialState: "OPEN", validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    effectiveAt: new Date(Date.now() - 60_000).toISOString(),
    originalStatement: "Initial synthetic milestone status",
  }, { correlationId: randomUUID() });
  const authority = new DatabaseAuthorityRepository({ $transaction: asApi } as never);
  const assessmentRequest = { projectId, factType: binding.factType };
  const assessmentContext = { correlationId: randomUUID() };
  const capture = (reader: { customerId: string; subject: string; roles: ("pmo_admin" | "project_manager")[] }, idempotencyKey = randomUUID()) =>
    authority.captureAssessment(reader, { ...assessmentRequest, idempotencyKey }, assessmentContext);
  const humanRule = await authority.appendPolicy(pmo, {
    projectId, factType: binding.factType, expectedRevision: 0, idempotencyKey: randomUUID(),
    effectiveAt: new Date(Date.now() - 60_000).toISOString(),
    definition: {
      conflictBehavior: "REQUEST_RECONCILIATION",
      tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED", validity: null }] }],
    },
  }, { correlationId: randomUUID() });
  const legacy = await capture(pm);
  expect(legacy).toMatchObject({ visibility: "available", result: { status: "RESOLVED", resolvedValue: { value: "OPEN" } } });
  expect(await db.factAssessment.findUniqueOrThrow({ where: { id: legacy.assessmentId } })).toMatchObject({ evaluatorVersion: 1 });
  const sheet = "Snapshot " + randomUUID().slice(0, 12);
  await proveXlsxSourceGenesis(pool, {
    retain: true, existingCustomer: customerId, existingProject: projectId, sheet, snapshotRequired: true,
    reviewer: sourceAdmissionSubject, reviewerRole: "project_manager",
  });
  const [scope] = await db.$queryRaw<{ customerId: string; sourceId: string; projectId: string }[]>`
    SELECT p."customerId",p."sourceId",p."projectId" FROM public."IngestionConfigurationProject" p
    JOIN public."IngestionConfigurationRevision" c
      ON (c."customerId",c."sourceId",c.revision)=(p."customerId",p."sourceId",p."configRevision")
    WHERE c.mapping->>'sheet'=${sheet} AND c.sealed`;
  expect(scope).toBeDefined();
  expect(scope).toMatchObject({ customerId, projectId });
  const { sourceId } = scope!;
  const actor = { customerId, subject: "synthetic-workbook-pmo", roles: ["pmo_admin" as const] };
  const administrator = { customerId, subject: "synthetic-source-admin", roles: ["system_admin"] as const };
  await db.accessGrant.create({ data: {
    customerId, scopeId: projectId, scopeType: "project",
    subject: administrator.subject, role: administrator.roles[0],
  } });
  const historicalReceipt = new Date(Date.now() - 7_200_000);
  const effectiveAt = new Date(historicalReceipt.getTime() - 30_000).toISOString();
  const inFuture = new Date(Date.now() + 86_400_000).toISOString();
  const repository = new DatabaseIngestionRepository(
    {
      $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) =>
        asApi((tx) => tx.$queryRaw(query, ...values)),
      $transaction: asApi,
      auditEvent: {
        create: (args: Prisma.AuditEventCreateArgs) => asApi((tx) => tx.auditEvent.create(args)),
      },
    } as never,
    new CredentialVault(Buffer.alloc(32, 34).toString("base64")), {
      tryAcquire: () => ({
        decode: async () => ({
          headers: ["Key", "Project", "Status", "Forecast", "Snapshot"],
          rows: [
            ["Current", projectId, "Complete", "2027-01-01", effectiveAt],
            ["Future", projectId, "Complete", "2027-01-01", inFuture],
            ["Birth", projectId, "Complete", "2027-01-01", effectiveAt],
            ["Contested", projectId, "Complete", "2027-01-01", effectiveAt],
          ],
        }),
        release() {},
      }),
    },
  );
  await repository.setRetention({ ...administrator, roles: [...administrator.roles] }, { retentionHours: 24 }, randomUUID());
  const caller = { ...actor, roles: [...actor.roles] };
  const preview = await repository.persistXlsxPreview(caller, {
    sourceId, configRevision: 1, mappingRevision: 1, sheet, commandKey: randomUUID(),
  }, Buffer.from("synthetic workbook bytes"), randomUUID());
  const context = await db.ingestionXlsxContext.findUniqueOrThrow({ where: { receiptId: preview.receiptId } });
  const review = await repository.commitXlsxReviewedImport(caller, {
    sourceId, previewReceiptId: preview.receiptId, previewContextSha256: context.contextSha256,
    rowOrdinals: [1, 2, 3, 4], commandKey: randomUUID(),
  }, randomUUID());
  const laterPreview = await repository.persistXlsxPreview(caller, {
    sourceId, configRevision: 1, mappingRevision: 1, sheet, commandKey: randomUUID(),
  }, Buffer.from("synthetic workbook bytes"), randomUUID());
  const laterContext = await db.ingestionXlsxContext.findUniqueOrThrow({ where: { receiptId: laterPreview.receiptId } });
  const equivalentReview = await repository.commitXlsxReviewedImport(caller, {
    sourceId, previewReceiptId: laterPreview.receiptId, previewContextSha256: laterContext.contextSha256,
    rowOrdinals: [1], commandKey: randomUUID(),
  }, randomUUID());
  expect(equivalentReview.receiptId).not.toBe(review.receiptId);
  const outcomes = await db.ingestionRowOutcome.findMany({
    where: { receiptId: review.receiptId }, orderBy: { ordinal: "asc" },
  });
  expect(outcomes.map((row) => row.state)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED"]);
  const equivalentOutcome = await db.ingestionRowOutcome.findFirstOrThrow({ where: { receiptId: equivalentReview.receiptId, ordinal: 1 } });
  expect(equivalentOutcome).toMatchObject({
    sourceRevisionId: outcomes[0]!.sourceRevisionId, projectionId: outcomes[0]!.projectionId, operation: "UNCHANGED",
  });
  // Age the owned synthetic fixture before admission to exercise normal purge
  // after reducing retention. All admission and replay guards remain active.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE public."IngestionSourceRevision" DISABLE TRIGGER ingestion_revision_guard`;
    try {
      expect(await tx.$executeRaw`UPDATE public."IngestionSourceRevision" SET "receivedAt"=${historicalReceipt}
        WHERE id=${outcomes[0]!.sourceRevisionId}::uuid AND "customerId"=${customerId}::uuid`).toBe(1);
    } finally {
      await tx.$executeRaw`ALTER TABLE public."IngestionSourceRevision" ENABLE TRIGGER ingestion_revision_guard`;
    }
  });
  const streams = await Promise.all(outcomes.map((row) => db.ingestionFactStream.findFirstOrThrow({
    where: { customerId, sourceId, recordId: row.recordId!, factType: "project.status" },
  })));
  const resolve = (receiptId: string, ordinal = 1, streamId = streams[0]!.id,
    snapshotField = "source.snapshot_at", requestedProject = projectId) => db.$queryRaw<{ input: unknown }[]>`
    SELECT public.resolve_source_observation_input(
      ${customerId}::uuid,${requestedProject}::uuid,${sourceId}::uuid,${streamId}::uuid,
      ${receiptId}::uuid,${ordinal}::integer,${snapshotField}::text,'{"Complete":"COMPLETE"}'::jsonb
    ) AS input`;
  const proof = await resolve(review.receiptId);
  expect(proof).toMatchObject([{
    input: {
      sourceKind: "xlsx.row", field: "project.status", snapshotField: "source.snapshot_at",
      receiptId: review.receiptId, rowOrdinal: 1, projectionId: outcomes[0]?.projectionId,
      effectiveAt, observedAt: historicalReceipt.toISOString(), value: { type: "text", value: "COMPLETE" },
      fieldSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  }]);
  expect(await resolve(review.receiptId)).toEqual(proof);
  expect(await resolve(preview.receiptId)).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 2, streams[1]!.id)).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 2)).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 1, streams[0]!.id, "project.forecast")).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 1, streams[0]!.id, "source.snapshot_at", randomUUID())).toEqual([{ input: null }]);
  expect(await db.projectFactVersion.count({ where: { customerId } })).toBe(1);

  const key = randomUUID();
  const correlation = randomUUID();
  type AdmissionResult = { status: "ADMITTED" | "REPLAYED" | "DENIED" | "CONFLICT"; receiptId?: string };
  const append = (
    tx: Prisma.TransactionClient,
    approvalId: string,
    receiptId = review.receiptId,
    ordinal = 1,
    commandKey = key,
    customer = customerId,
  ) => tx.$queryRaw<{ result: AdmissionResult }[]>`
    SELECT public.admit_source_observation(${customer}::uuid,${projectId}::uuid,${approvalId}::uuid,
      ${receiptId}::uuid,${ordinal}::integer,${commandKey},${correlation}::uuid) AS result`;
  const asOperator = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL SESSION AUTHORIZATION pdaa_source_acceptance`;
    return operation(tx);
  });
  const asOwner = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE pdaa_migrate`;
    return operation(tx);
  });
  const factSource = randomUUID();
  const definition = {
    conflictBehavior: "REQUEST_RECONCILIATION",
    tiers: [{ selectors: [{
      sourceType: "xlsx", instanceId: factSource, requiredApproval: "APPROVED",
      validity: { basis: "effectiveAt", durationMs: 86_400_000 },
    }] }],
  };
  const mixedRule = {
    ...definition,
    tiers: [{ selectors: [
      ...definition.tiers[0]!.selectors,
      { sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED", validity: null },
    ] }],
  };
  const configure = (
    tx: Prisma.TransactionClient,
    approver: string,
    stream = streams[0]!.id,
    rule: unknown = mixedRule,
    currentRevision = 1,
  ) =>
    tx.$queryRaw<{ id: string | null }[]>`
      SELECT public.approve_source_observation(
        ${customerId}::uuid,${projectId}::uuid,${binding.id}::uuid,${stream}::uuid,${factSource}::uuid,
        'source.snapshot_at','{"Complete":"COMPLETE"}'::jsonb,
        ${JSON.stringify(rule).replace('"durationMs":86400000', '"durationMs":86400000.0')}::jsonb,
        ${approver},${currentRevision}::integer
      ) AS id`;
  await expect(asApi((tx) => configure(tx, actor.subject))).rejects.toThrow(/permission denied/iu);
  await expect(asOwner((tx) => configure(tx, pm.subject))).rejects.toThrow(/requires a scoped approval/iu);
  await expect(asOwner((tx) => configure(tx, pmo.subject))).rejects.toThrow(/requires current source scope/iu);
  expect(await asOwner((tx) => configure(tx, actor.subject, randomUUID()))).toEqual([{ id: null }]);
  const [approval] = await asOwner((tx) => configure(tx, actor.subject));
  expect(approval?.id).toEqual(expect.any(String));
  const proofId = approval!.id!;
  const bindingApproval = await db.sourceAdmissionBindingRevision.findUniqueOrThrow({ where: { id: proofId } });
  expect(bindingApproval).toMatchObject({ bindingId: binding.id, factSourceId: factSource, streamId: streams[0]!.id, definition: mixedRule });
  expect(bindingApproval.reservationId).toBe(proofId);
  await expect(asOwner((tx) => configure(tx, actor.subject, streams[1]!.id)))
    .rejects.toThrow(/SourceAdmissionBindingRevision_source_reservation_key/iu);
  expect(await db.authorityPolicyRevision.count({ where: { id: bindingApproval.policyRevisionId } })).toBe(0);
  expect(await db.factSource.count({ where: { id: factSource } })).toBe(0);
  await expect(asApi((tx) => append(tx, proofId))).rejects.toThrow(/permission denied/iu);
  await expect(asOperator((tx) => tx.$queryRaw`SELECT id FROM public."SourceAdmissionCommand"`))
    .rejects.toThrow(/permission denied/iu);
  expect(await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE pdaa_source_acceptance`;
    return append(tx, proofId);
  })).toEqual([{ result: { status: "DENIED" } }]);
  expect(await asOperator((tx) => append(tx, randomUUID()))).toEqual([{ result: { status: "DENIED" } }]);
  expect(await asOperator((tx) => append(tx, proofId, preview.receiptId))).toEqual([{ result: { status: "DENIED" } }]);
  expect(await asOperator((tx) => append(tx, proofId, review.receiptId, 2))).toEqual([{ result: { status: "DENIED" } }]);
  expect(await asOperator((tx) => append(tx, proofId, review.receiptId, 1, key, randomUUID())))
    .toEqual([{ result: { status: "DENIED" } }]);
  const [result] = await asOperator((tx) => append(tx, proofId));
  expect(result).toEqual({ result: { status: "ADMITTED", receiptId: expect.any(String) } });
  const receiptId = result!.result.receiptId!;
  const command = await db.sourceAdmissionCommand.findUniqueOrThrow({ where: { id: receiptId } });
  const versionId = command.versionId;
  expect(command).toMatchObject({ commandKey: key, correlationId: correlation, inputReceiptId: review.receiptId, ingestionSourceId: sourceId });
  expect(await asOperator((tx) => append(tx, proofId))).toEqual([{ result: { status: "REPLAYED", receiptId } }]);
  expect(await asOperator((tx) => append(tx, proofId, review.receiptId, 2))).toEqual([{ result: { status: "CONFLICT" } }]);
  const activated = await db.authorityPolicyRevision.findUniqueOrThrow({ where: { id: bindingApproval.policyRevisionId } });
  expect(activated).toMatchObject({ factType: binding.factType, definition: mixedRule, recordedBy: actor.subject, state: "ENABLED", revision: 2 });
  const originalRule = await db.authorityPolicyRevision.findUniqueOrThrow({ where: { id: humanRule.event.id } });
  expect(originalRule).toMatchObject({ revision: 1, definition: humanRule.event.definition });
  await expect(asApi((tx) => tx.$executeRaw`
    INSERT INTO public."AuthorityPolicyRevision"
      (id,"customerId","projectId","factType","policyId",revision,"recordedAt","recordedBy","effectiveAt",state,definition)
      VALUES (${randomUUID()}::uuid,${customerId}::uuid,${projectId}::uuid,${binding.factType},
        ${activated.policyId}::uuid,3,clock_timestamp(),${pmo.subject},clock_timestamp(),'ENABLED',
        ${JSON.stringify(definition)}::jsonb)
  `)).rejects.toThrow(/Source authority activation unavailable/iu);

  const versions = await db.projectFactVersion.findMany({
    where: { factId: binding.factId }, include: { evidence: { include: { source: true } } }, orderBy: { revision: "asc" },
  });
  expect(versions).toMatchObject([
    { revision: 1, provenance: "HUMAN_CONFIRMED", evidence: { providedBy: pm.subject, originalStatement: "Initial synthetic milestone status" } },
    {
      id: versionId, revision: 2, provenance: "SYSTEM_VERIFIED", value: { type: "text", value: "COMPLETE" },
      effectiveAt: new Date(effectiveAt), effectiveAtValidated: true, validUntil: new Date(Date.parse(effectiveAt) + 86_400_000),
      evidence: { originalStatement: null, providedBy: null, source: { sourceType: "xlsx", ingestionStreamId: streams[0]!.id, providedBy: null } },
    },
  ]);
  const witness = await db.sourceObservationWitness.findUniqueOrThrow({ where: { versionId: versionId! } });
  expect(witness.admissionRevisionId).toBe(proofId);
  expect(witness.admittedBy).toBe(sourceAdmissionSubject);
  expect(witness.rootCommandId).toBe(receiptId);
  expect(await db.auditEvent.findUniqueOrThrow({ where: { id: witness.auditEventId } })).toMatchObject({
    actor: sourceAdmissionSubject, correlationId: correlation, detail: { admissionReceiptId: receiptId },
  });
  expect(witness.input).toEqual(proof[0]?.input);
  expect(witness.admittedAt.getTime()).toBeGreaterThanOrEqual(versions[1]!.evidence.observedAt.getTime());
  expect(await asOwner((tx) => tx.$queryRaw`
    SELECT public.valid_source_observation_witness(${versionId}::uuid) AS valid,
      public.valid_canonical_state_binding(${binding.id}::uuid) AS "humanBirthValid"
  `)).toEqual([{ valid: true, humanBirthValid: true }]);

  // The original human rule and both snapshot timestamps predate this
  // detection time. A conflict still requires both versions to be admitted.
  const earlyDetection = new Date(witness.admittedAt.getTime() - 1);
  expect(earlyDetection.getTime()).toBeGreaterThanOrEqual(Date.parse(humanRule.event.recordedAt));
  for (const version of versions)
    expect(earlyDetection.getTime()).toBeGreaterThanOrEqual(version.evidence.observedAt.getTime());
  const [leftVersionId, rightVersionId] = [versions[0]!.id, witness.versionId].sort();
  await expect(asApi((tx) => tx.$executeRaw`
    INSERT INTO public."FactAuthorityConflict"
      (id,"customerId","projectId","factId","factType",revision,"leftVersionId","rightVersionId","policyRevisionId","detectedAt")
    VALUES (${randomUUID()}::uuid,${customerId}::uuid,${projectId}::uuid,${binding.factId}::uuid,${binding.factType},1,
      ${leftVersionId}::uuid,${rightVersionId}::uuid,${humanRule.event.id}::uuid,${earlyDetection})
  `)).rejects.toThrow(/Invalid authority conflict/iu);
  expect(await db.factAuthorityConflict.count({ where: { factId: binding.factId } })).toBe(0);

  const facts = new DatabaseProjectFactRepository({ $transaction: asApi } as never);
  const humanAccess = await db.factSourceAccess.findUniqueOrThrow({ where: { sourceId: versions[0]!.sourceId } });
  await facts.setSourceAccess(pmo, {
    projectId, sourceId: humanAccess.sourceId, expectedRevision: humanAccess.revision,
    state: "AVAILABLE", readers: [actor.subject, pm.subject],
  }, assessmentContext);
  expect(await db.factSourceAccess.findUniqueOrThrow({ where: { sourceId: factSource }, include: { readers: true } }))
    .toMatchObject({ state: "AVAILABLE", revision: 1, readers: [] });
  expect(await capture(actor)).toMatchObject({ visibility: "restricted", revalidationRequired: true, result: null });
  const available = await facts.setSourceAccess(pmo, {
    projectId, sourceId: factSource, expectedRevision: 1, state: "AVAILABLE", readers: [actor.subject, pm.subject],
  }, assessmentContext);
  expect(await capture(pm)).toMatchObject({ visibility: "restricted", revalidationRequired: true, result: null });
  const assessmentKey = randomUUID();
  const mixed = await capture(actor, assessmentKey);
  expect(mixed).toMatchObject({
    visibility: "available",
    result: { status: "CONFLICTING", resolvedValue: null, versions: expect.arrayContaining([
      expect.objectContaining({ provenance: "HUMAN_CONFIRMED", value: { type: "text", value: "OPEN" } }),
      expect.objectContaining({ id: versionId, provenance: "SYSTEM_VERIFIED", value: { type: "text", value: "COMPLETE" },
        source: { instanceId: factSource, recordType: "xlsx.row", recordId: streams[0]!.id, revision: witness.sourceRevisionId } }),
    ]) },
  });
  expect(await db.factAssessment.findUniqueOrThrow({ where: { id: mixed.assessmentId } })).toMatchObject({ evaluatorVersion: 2 });
  const readMixed = () => authority.getAssessment(actor, { projectId, assessmentId: mixed.assessmentId });
  const revoked = await facts.setSourceAccess(pmo, {
    projectId, sourceId: factSource, expectedRevision: available.revision, state: "REVOKED", readers: [],
  }, assessmentContext);
  expect(await readMixed()).toMatchObject({ visibility: "restricted", revalidationRequired: true, result: null });
  await facts.setSourceAccess(pmo, {
    projectId, sourceId: factSource, expectedRevision: revoked.revision, state: "AVAILABLE", readers: [actor.subject, pm.subject],
  }, assessmentContext);

  await repository.setRetention({ ...administrator, roles: [...administrator.roles] }, { retentionHours: 1 }, randomUUID());
  expect(await repository.purgeExpired({ ...administrator, roles: [...administrator.roles] })).toBeGreaterThan(0);
  const redacted = await db.ingestionProposalContent.findUniqueOrThrow({ where: { projectionId: outcomes[0]!.projectionId! } });
  expect(redacted).toMatchObject({ proposals: null, redactedAt: expect.any(Date), redactionAuditEventId: expect.any(String) });
  expect(await resolve(review.receiptId)).toEqual([{ input: null }]);
  expect(await readMixed()).toEqual(mixed);
  expect(await capture(actor, assessmentKey)).toEqual({ ...mixed, replayed: true });
  expect(await asOperator((tx) => append(tx, proofId))).toEqual([{ result: { status: "REPLAYED", receiptId } }]);
  const aliasKey = randomUUID();
  expect(await asOperator((tx) => append(tx, proofId, equivalentReview.receiptId)))
    .toEqual([{ result: { status: "CONFLICT" } }]);
  expect(await asOperator((tx) => append(tx, proofId, equivalentReview.receiptId, 1, aliasKey)))
    .toEqual([{ result: { status: "REPLAYED", receiptId } }]);
  expect(await db.sourceAdmissionCommand.count({ where: { versionId } })).toBe(2);
  expect(await db.sourceAdmissionCommand.findFirstOrThrow({ where: { versionId, commandKey: aliasKey } }))
    .toMatchObject({ inputReceiptId: equivalentReview.receiptId, ingestionSourceId: sourceId });
  expect(await db.sourceObservationWitness.findUniqueOrThrow({ where: { versionId } })).toEqual(witness);
  const operatorGrant = await db.accessGrant.findFirstOrThrow({ where: { customerId, subject: sourceAdmissionSubject } });
  await db.accessGrant.delete({ where: { id: operatorGrant.id } });
  expect(await asOperator((tx) => append(tx, proofId))).toEqual([{ result: { status: "DENIED" } }]);
  await db.accessGrant.create({ data: operatorGrant });

  const changedValidity = structuredClone(definition);
  changedValidity.tiers[0]!.selectors[0]!.validity.durationMs = 3_600_000;
  const [superseding] = await asOwner((tx) => configure(tx, actor.subject, streams[0]!.id, changedValidity, 2));
  expect(superseding?.id).toEqual(expect.any(String));
  expect(await readMixed()).toMatchObject({ visibility: "restricted", revalidationRequired: true, result: null });
  expect(await capture(actor, assessmentKey)).toMatchObject({
    assessmentId: mixed.assessmentId, visibility: "restricted", replayed: true, result: null,
  });
  expect(await authority.getAssessment(pm, { projectId, assessmentId: legacy.assessmentId })).toEqual(legacy);
  expect(await asOperator((tx) => append(tx, proofId))).toEqual([{ result: { status: "DENIED" } }]);
  expect(await asOperator((tx) => append(tx, superseding!.id!, review.receiptId, 1, randomUUID())))
    .toEqual([{ result: { status: "CONFLICT" } }]);
  const pending = await db.sourceAdmissionBindingRevision.findUniqueOrThrow({ where: { id: superseding!.id! } });
  expect(pending.reservationId).toBe(proofId);
  await expect(asOwner(async (tx) => {
    await tx.$executeRaw`
      WITH time AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS at)
      INSERT INTO public."AuthorityPolicyRevision"
        (id,"customerId","projectId","factType","policyId",revision,"recordedAt","recordedBy","effectiveAt",state,definition)
      SELECT ${pending.policyRevisionId}::uuid,${customerId}::uuid,${projectId}::uuid,${binding.factType},
        ${activated.policyId}::uuid,3,time.at,${actor.subject},time.at,'ENABLED',${JSON.stringify(changedValidity)}::jsonb
      FROM time`;
    await tx.$executeRaw`SET CONSTRAINTS source_authority_witness_complete IMMEDIATE`;
  })).rejects.toThrow(/cannot activate without an admitted observation/iu);
  expect(await db.authorityPolicyRevision.count({ where: { id: pending.policyRevisionId } })).toBe(0);
  expect(await db.projectFactVersion.count({ where: { factId: binding.factId } })).toBe(2);

  const targets = await db.milestone.findMany({ where: { customerId, projectId }, orderBy: { key: "asc" } });
  const bornTarget = targets[1]!;
  const contestedTarget = targets[2]!;
  const birthSourceId = randomUUID();
  const birthDefinition = structuredClone(definition);
  birthDefinition.tiers[0]!.selectors[0]!.instanceId = birthSourceId;
  const invalidPolicy = {
    ...birthDefinition,
    tiers: [...birthDefinition.tiers, { selectors: [{
      sourceType: "human_statement", instanceId: randomUUID(), requiredApproval: "NOT_REQUIRED", validity: null,
    }] }],
  };
  const approveBirth = async (targetId: string, streamId: string, source: string, rule: unknown) => {
    const [result] = await asOwner((tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT public.approve_source_observation(${customerId}::uuid,${projectId}::uuid,NULL::uuid,${streamId}::uuid,
        ${source}::uuid,'source.snapshot_at','{"Complete":"COMPLETE"}'::jsonb,
        ${JSON.stringify(rule)}::jsonb,${actor.subject},0,'MILESTONE',${targetId}::uuid) AS id`);
    return db.sourceAdmissionBindingRevision.findUniqueOrThrow({ where: { id: result?.id } });
  };
  const invalidBirth = await approveBirth(bornTarget.id, streams[2]!.id, birthSourceId, invalidPolicy);
  const birthKey = randomUUID();
  const admissionAuditCount = () => db.auditEvent.count({ where: { customerId, event: "fact.source_observation.admitted" } });
  const priorAuditCount = await admissionAuditCount();
  expect(await db.projectFact.count({ where: { id: invalidBirth.factId } })).toBe(0);
  expect(await db.canonicalStateBinding.count({ where: { id: invalidBirth.bindingId } })).toBe(0);
  await expect(asOperator((tx) => append(tx, invalidBirth.id, review.receiptId, 3, birthKey)))
    .rejects.toThrow(/Invalid authority revision/iu);
  expect(await db.projectFact.count({ where: { id: invalidBirth.factId } })).toBe(0);
  expect(await db.canonicalStateBinding.count({ where: { id: invalidBirth.bindingId } })).toBe(0);
  expect(await db.factSource.count({ where: { id: birthSourceId } })).toBe(0);
  expect(await db.sourceAdmissionCommand.count({ where: { commandKey: birthKey } })).toBe(0);
  expect(await db.authorityPolicyRevision.count({ where: { id: invalidBirth.policyRevisionId } })).toBe(0);
  expect(await admissionAuditCount()).toBe(priorAuditCount);

  const validBirth = await approveBirth(bornTarget.id, streams[2]!.id, birthSourceId, birthDefinition);
  expect(validBirth).toMatchObject({
    bindingId: invalidBirth.bindingId, factId: invalidBirth.factId, reservationId: invalidBirth.reservationId,
  });
  const [birthResult] = await asOperator(async (tx) => {
    const results = await append(tx, validBirth.id, review.receiptId, 3, birthKey);
    // A separate connection still sees the pre-admission state while the
    // operation's fact, binding and authority are waiting for commit.
    expect(await db.projectFact.findUnique({ where: { id: validBirth.factId } })).toBeNull();
    expect(await db.canonicalStateBinding.findUnique({ where: { id: validBirth.bindingId } })).toBeNull();
    expect(await db.authorityPolicyRevision.findUnique({ where: { id: validBirth.policyRevisionId } })).toBeNull();
    return results;
  });
  expect(birthResult).toEqual({ result: { status: "ADMITTED", receiptId: expect.any(String) } });
  const birthCommand = await db.sourceAdmissionCommand.findUniqueOrThrow({ where: { id: birthResult!.result.receiptId } });
  const birthWitness = await db.sourceObservationWitness.findUniqueOrThrow({ where: { versionId: birthCommand.versionId } });
  const birthPolicy = await db.authorityPolicyRevision.findUniqueOrThrow({ where: { id: validBirth.policyRevisionId } });
  expect(birthPolicy.recordedAt).toEqual(birthWitness.admittedAt);
  expect(await admissionAuditCount()).toBe(priorAuditCount + 1);
  expect(await db.canonicalStateBinding.findUniqueOrThrow({ where: { id: validBirth.bindingId } })).toMatchObject({
    sealed: true, milestoneId: bornTarget.id, factId: validBirth.factId, sourceBirthCommandId: birthCommand.id,
  });
  expect(await db.canonicalStateBindingReceipt.count({ where: { bindingId: validBirth.bindingId } })).toBe(0);
  expect(await db.projectFactVersion.findUniqueOrThrow({ where: { id: birthCommand.versionId }, include: { evidence: true } }))
    .toMatchObject({ revision: 1, provenance: "SYSTEM_VERIFIED", evidence: { providedBy: null, originalStatement: null } });
  expect(await asApi((tx) => tx.$queryRaw`SELECT public.valid_canonical_state_binding(${validBirth.bindingId}::uuid) AS valid`))
    .toEqual([{ valid: true }]);
  expect(await asOperator((tx) => append(tx, validBirth.id, review.receiptId, 3, birthKey)))
    .toEqual([{ result: { status: "REPLAYED", receiptId: birthCommand.id } }]);

  const contestedSourceId = randomUUID();
  const contestedDefinition = structuredClone(definition);
  contestedDefinition.tiers[0]!.selectors[0]!.instanceId = contestedSourceId;
  const contested = await approveBirth(contestedTarget.id, streams[3]!.id, contestedSourceId, contestedDefinition);
  const humanWinner = await new DatabaseMilestoneConsistencyRepository({ $transaction: asApi } as never).createStateBinding(pm, {
    projectId, targetKind: "MILESTONE", targetId: contestedTarget.id, initialState: "OPEN", validUntil: null,
    effectiveAt, idempotencyKey: randomUUID(), originalStatement: "Human state established before source admission",
  }, { correlationId: randomUUID() });
  expect(await asOperator((tx) => append(tx, contested.id, review.receiptId, 4, randomUUID())))
    .toEqual([{ result: { status: "CONFLICT" } }]);
  expect(await db.projectFact.count({ where: { id: contested.factId } })).toBe(0);
  expect(await db.canonicalStateBinding.findUniqueOrThrow({ where: { id: humanWinner.id } }))
    .toMatchObject({ sealed: true, milestoneId: contestedTarget.id, sourceBirthCommandId: null });
}, 45_000);
