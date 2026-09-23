import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseIngestionRepository,
} from "../packages/data/src/index.js";
import { CredentialVault } from "../packages/platform/dist/index.js";
import type { Prisma } from "../packages/data/src/generated/prisma/client.js";
import type { Actor } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Ingestion tests require an isolated synthetic database");
const db = createDatabase(url);
const customerId = process.env.CUSTOMER_ID!;
const repository = new DatabaseIngestionRepository(
  db,
  new CredentialVault(Buffer.alloc(32, 17).toString("base64")),
);
afterAll(() => db.$disconnect());

function actor(role: Actor["roles"][number], label: string): Actor {
  return { customerId, subject: `${label}-${randomUUID()}`, roles: [role] };
}

describe("durable ingestion persistence", () => {
  it("persists bounded proposals with fenced cursors and current permission checks", async () => {
    const portfolioId = randomUUID();
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const pmo = actor("pmo_admin", "ingestion-pmo");
    const manager = actor("project_manager", "ingestion-pm");
    const nonReader = actor("project_manager", "ingestion-other-pm");
    const systemAdmin = actor("system_admin", "ingestion-admin");

    await db.portfolio.create({
      data: { id: portfolioId, customerId, name: "Ingestion fixture" },
    });
    await db.project.create({
      data: {
        id: projectId,
        customerId,
        portfolioId,
        code: "ING-" + projectId,
        name: "Ingestion fixture",
        description: "Synthetic persistence fixture",
        reportedStatus: "UNKNOWN",
      },
    });
    for (const [who, role] of [
      [pmo, "pmo_admin"],
      [manager, "project_manager"],
      [nonReader, "project_manager"],
      [systemAdmin, "system_admin"],
    ] as const)
      await db.accessGrant.create({
        data: {
          customerId,
          subject: who.subject,
          scopeType: "project",
          scopeId: projectId,
          role,
        },
      });

    await repository.setRetention(
      systemAdmin,
      { retentionHours: 24 },
      "ingestion-test-retention",
    );
    const configuration = {
      binding: {
        customerId,
        sourceId,
        sourceType: "test.tracker",
        origin: "https://tracker.example",
      },
      projects: [{ projectId, readers: [manager.subject] }],
      mapping: { kind: "CONNECTOR" as const, factTypes: ["project.forecast"] },
    };
    const firstConfig = await repository.configure(
      pmo,
      configuration,
      "ingestion-test-config-1",
    );
    expect(firstConfig).toMatchObject({ configRevision: 1, mappingRevision: 1 });

    const initial = await db.$queryRaw<
      { cursorRevision: bigint; syncGeneration: bigint }[]
    >`SELECT "cursorRevision","syncGeneration" FROM public."IngestionSource" WHERE id=${sourceId}::uuid`;
    const reset = await repository.resetSync(
      manager,
      {
        sourceId,
        configRevision: 1,
        expectedCursorRevision: Number(initial[0]!.cursorRevision),
        expectedGeneration: Number(initial[0]!.syncGeneration),
        commandKey: "initial-reset",
      },
      "ingestion-test-reset-1",
    );
    expect(reset.generation).toBe(Number(initial[0]!.syncGeneration) + 1);

    const page = {
      binding: configuration.binding,
      inputCursor: null,
      nextCursor: "opaque-next-cursor",
      terminal: false,
      records: [
        {
          ref: {
            customerId,
            sourceId,
            projectId,
            recordType: "issue",
            recordId: "CASE-17",
          },
          revision: "remote-revision-1",
          sourceContentHash: createHash("sha256")
            .update("source fields before mapping")
            .digest("hex"),
          observedAt: "2026-09-23T00:00:00.000Z",
          effectiveAt: "2026-09-22T00:00:00.000Z",
          deepLink: null,
          observations: [
            {
              factType: "project.forecast",
              value: { type: "date", value: "2026-11-01" },
            },
          ],
        },
      ],
    };
    const pageCommand = {
      sourceId,
      configRevision: 1,
      mappingRevision: 1,
      expectedCursorRevision: reset.cursorRevision,
      expectedGeneration: reset.generation,
      commandKey: "page-1",
      page,
    };
    const persisted = await repository.persistConnectorPage(
      manager,
      pageCommand,
      "ingestion-test-page-1",
    );
    const replay = await repository.persistConnectorPage(
      manager,
      pageCommand,
      "ingestion-test-page-1-replay",
    );
    expect(replay).toMatchObject({ receiptId: persisted.receiptId, replayed: true });

    const cursor = await db.$queryRaw<
      { cursorEnvelope: string; cursorRevision: bigint; syncGeneration: bigint }[]
    >`SELECT "cursorEnvelope","cursorRevision","syncGeneration" FROM public."IngestionSource" WHERE id=${sourceId}::uuid`;
    expect(cursor[0]!.cursorEnvelope).not.toContain("opaque-next-cursor");
    expect(cursor[0]!.cursorEnvelope).toMatch(/^v1\./);
    expect(cursor[0]!.cursorRevision).toBe(BigInt(persisted.cursorRevision));
    const pageScopeGrant = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM public."AccessGrant" WHERE "customerId"=${customerId}::uuid AND subject=${manager.subject} AND role='project_manager' AND "scopeType"='project' AND "scopeId"=${projectId}::uuid`;
    await expect(
      db.$transaction(async (tx) => {
        const insertDuplicatePage = async () => {
          const receiptId = randomUUID();
          const auditEventId = randomUUID();
          const createdAt = new Date();
          const cursorRevisionAfter = cursor[0]!.cursorRevision + 1n;
          await tx.auditEvent.create({
            data: {
              id: auditEventId,
              customerId,
              actor: manager.subject,
              event: "ingestion.connector_page.persisted",
              correlationId: "ingestion-duplicate-cursor-page-probe",
              detail: { receiptId, kind: "CONNECTOR_PAGE", outcomeCount: 0 },
              occurredAt: createdAt,
            },
          });
          await tx.$executeRaw`
            INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","configRevision","mappingRevision","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","outcomeCount","auditEventId","createdAt")
            VALUES (${receiptId}::uuid,${customerId}::uuid,${sourceId}::uuid,${manager.subject},'CONNECTOR_PAGE',${"duplicate-page-" + receiptId},${"d".repeat(64)},1,1,${cursor[0]!.syncGeneration},${cursor[0]!.syncGeneration},${cursor[0]!.cursorRevision},${cursorRevisionAfter},0,${auditEventId}::uuid,${createdAt})`;
          await tx.$executeRaw`
            INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
            VALUES (${customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,${projectId}::uuid,${pageScopeGrant[0]!.id}::uuid,'project_manager','project',${projectId}::uuid)`;
          await tx.$executeRaw`
            INSERT INTO public."IngestionCursorTransition" ("customerId","sourceId","receiptId","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","stateAfter","cursorEnvelopeHash")
            VALUES (${customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,${cursor[0]!.syncGeneration},${cursor[0]!.syncGeneration},${cursor[0]!.cursorRevision},${cursorRevisionAfter},'READY',${"e".repeat(64)})`;
        };
        await insertDuplicatePage();
        await insertDuplicatePage();
      }),
    ).rejects.toThrow(); // two page receipts cannot claim the same cursor revision

    const receipt = (await repository.readReceipt(manager, {
      sourceId,
      receiptId: persisted.receiptId,
    })) as { outcomes: { contentAvailable: boolean; proposals: unknown[] }[] };
    expect(receipt.outcomes).toHaveLength(1);
    expect(receipt.outcomes[0]).toMatchObject({
      contentAvailable: true,
      proposals: [
        {
          factType: "project.forecast",
          value: { type: "date", value: "2026-11-01" },
        },
      ],
    });
    const receiptCount = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public."IngestionOperationReceipt" WHERE "sourceId"=${sourceId}::uuid`;
    expect(receiptCount[0]!.n).toBe(2); // reset and page; replay added no receipt

    const racePage = { ...page, inputCursor: "opaque-next-cursor", nextCursor: "opaque-race-cursor" };
    const raceBase = {
      ...pageCommand,
      expectedCursorRevision: persisted.cursorRevision,
      expectedGeneration: reset.generation,
      page: racePage,
    };
    const racingPages = await Promise.allSettled([
      repository.persistConnectorPage(
        manager,
        { ...raceBase, commandKey: "page-race-a" },
        "ingestion-test-page-race-a",
      ),
      repository.persistConnectorPage(
        manager,
        { ...raceBase, commandKey: "page-race-b" },
        "ingestion-test-page-race-b",
      ),
    ]);
    expect(racingPages.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winningPage = racingPages.find((result) => result.status === "fulfilled");
    if (winningPage?.status !== "fulfilled") throw new Error("Expected one winning cursor page");
    expect(racingPages.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CURSOR_CONFLICT" },
    });

    await expect(
      repository.persistConnectorEvent(
        manager,
        {
          sourceId,
          configRevision: 1,
          mappingRevision: 1,
          commandKey: "conflicting-source-revision",
          eventId: "event-conflicting-source-revision",
          record: {
            ...page.records[0]!,
            sourceContentHash: "b".repeat(64),
          },
        },
        "ingestion-test-conflicting-source-revision",
      ),
    ).rejects.toMatchObject({ code: "INTEGRITY_CONFLICT" });
    await expect(
      repository.persistConnectorEvent(
        manager,
        {
          sourceId,
          configRevision: 1,
          mappingRevision: 1,
          commandKey: "conflicting-projection",
          eventId: "event-conflicting-projection",
          record: {
            ...page.records[0]!,
            observations: [
              {
                factType: "project.forecast",
                value: { type: "date", value: "2026-12-01" },
              },
            ],
          },
        },
        "ingestion-test-conflicting-projection",
      ),
    ).rejects.toMatchObject({ code: "INTEGRITY_CONFLICT" });

    await expect(
      repository.persistConnectorEvent(
        nonReader,
        {
          sourceId,
          configRevision: 1,
          mappingRevision: 1,
          commandKey: "non-reader-event",
          eventId: "event-1",
          record: page.records[0],
        },
        "ingestion-test-denied-write",
      ),
    ).rejects.toMatchObject({ code: "DENIED" });
    await expect(
      repository.persistConnectorEvent(
        nonReader,
        {
          sourceId,
          configRevision: 1,
          mappingRevision: 1,
          commandKey: "non-reader-invalid-event",
          eventId: "event-invalid-1",
          record: null,
        },
        "ingestion-test-denied-before-validation",
      ),
    ).rejects.toMatchObject({ code: "DENIED" });

    const changed = await repository.configure(
      pmo,
      {
        ...configuration,
        mapping: {
          kind: "CONNECTOR",
          factTypes: ["project.forecast", "project.status"],
        },
      },
      "ingestion-test-config-2",
    );
    expect(changed).toMatchObject({ configRevision: 2, mappingRevision: 2 });
    const fenced = await db.$queryRaw<
      { cursorState: string; cursorEnvelope: string | null }[]
    >`SELECT "cursorState","cursorEnvelope" FROM public."IngestionSource" WHERE id=${sourceId}::uuid`;
    expect(fenced[0]).toEqual({ cursorState: "RESET_REQUIRED", cursorEnvelope: null });

    const current = await db.$queryRaw<
      { cursorRevision: bigint; syncGeneration: bigint }[]
    >`SELECT "cursorRevision","syncGeneration" FROM public."IngestionSource" WHERE id=${sourceId}::uuid`;
    const resetAfterConfig = await repository.resetSync(
      manager,
      {
        sourceId,
        configRevision: 2,
        expectedCursorRevision: Number(current[0]!.cursorRevision),
        expectedGeneration: Number(current[0]!.syncGeneration),
        commandKey: "config-reset",
      },
      "ingestion-test-reset-2",
    );
    expect(resetAfterConfig.generation).toBe(Number(current[0]!.syncGeneration) + 1);
    const lastSuccessfulSync = await db.$queryRaw<
      { lastSuccessReceiptId: string | null }[]
    >`SELECT "lastSuccessReceiptId" FROM public."IngestionSource" WHERE id=${sourceId}::uuid`;
    expect(lastSuccessfulSync[0]!.lastSuccessReceiptId).toBe(winningPage.value.receiptId);

    const eventRecord = page.records[0]!;
    const event = await repository.persistConnectorEvent(
      manager,
      {
        sourceId,
        configRevision: 2,
        mappingRevision: 2,
        commandKey: "event-command-1",
        eventId: "webhook-event-1",
        record: eventRecord,
      },
      "ingestion-test-event-1",
    );
    const eventReplay = await repository.persistConnectorEvent(
      manager,
      {
        sourceId,
        configRevision: 2,
        mappingRevision: 2,
        commandKey: "event-command-2",
        eventId: "webhook-event-1",
        record: eventRecord,
      },
      "ingestion-test-event-replay",
    );
    expect(eventReplay).toMatchObject({ receiptId: event.receiptId, replayed: true });
    const revisions = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public."IngestionSourceRevision" WHERE "sourceId"=${sourceId}::uuid`;
    const projections = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public."IngestionProposalProjection" WHERE "sourceId"=${sourceId}::uuid`;
    expect(revisions[0]!.n).toBe(1);
    expect(projections[0]!.n).toBe(2); // mapping revision 2 has its own projection

    const configRev3 = await repository.configure(
      pmo,
      {
        ...configuration,
        projects: [{ projectId, readers: [manager.subject] }],
        mapping: {
          kind: "CONNECTOR",
          factTypes: ["project.forecast", "project.status"],
        },
      },
      "ingestion-test-config-3",
    );
    expect(configRev3).toMatchObject({ configRevision: 3, mappingRevision: 2 });
    await expect(
      repository.persistConnectorEvent(
        manager,
        {
          sourceId,
          configRevision: 2,
          mappingRevision: 2,
          commandKey: "stale-event-replay",
          eventId: "webhook-event-1",
          record: eventRecord,
        },
        "ingestion-test-stale-event-replay",
      ),
    ).rejects.toMatchObject({ code: "STALE_CONFIGURATION" });

    const csvConfig = await repository.configure(
      pmo,
      {
        ...configuration,
        mapping: {
          kind: "CSV",
          sheet: "Exact Sheet",
          identityColumn: "Issue ID",
          projectColumn: "Project",
          fields: [
            {
              column: "Forecast",
              factType: "project.forecast",
              type: "date",
              required: true,
            },
          ],
        },
      },
      "ingestion-test-config-csv",
    );
    expect(csvConfig).toMatchObject({ configRevision: 4, mappingRevision: 3 });
    const csv = `Issue ID,Project,Forecast,Private Note\nCASE-CSV,${projectId},2026-12-01,private-cell-value`;
    const preview = await repository.persistCsvPreview(
      manager,
      {
        sourceId,
        configRevision: csvConfig.configRevision,
        mappingRevision: csvConfig.mappingRevision,
        commandKey: "csv-preview-1",
        fileName: "private-upload-name.csv",
        csv,
      },
      "ingestion-test-csv-preview",
    );
    expect(preview.rowCount).toBe(1);
    const csvReceipt = (await repository.readReceipt(manager, {
      sourceId,
      receiptId: preview.receiptId,
    })) as { outcomes: { identity: string[]; proposals: unknown[] }[] };
    expect(csvReceipt.outcomes).toHaveLength(1);
    expect(csvReceipt.outcomes[0]!.identity[0]).toBe("spreadsheet:Exact Sheet");
    expect(csvReceipt.outcomes[0]!.identity[1]).not.toBe("CASE-CSV");
    expect(JSON.stringify(csvReceipt)).not.toContain("CASE-CSV");
    expect(JSON.stringify(csvReceipt)).not.toContain("private-cell-value");
    expect(JSON.stringify(csvReceipt)).not.toContain("private-upload-name.csv");
    const persistedCsv = await db.$queryRaw<
      { recordType: string; recordKey: string; proposals: unknown; proposalHash: string; computedProposalHash: string }[]
    >`
      SELECT e."recordType",e."recordKey",c.proposals,p."proposalHash",
        encode(sha256(convert_to(c.proposals::text,'UTF8')),'hex') AS "computedProposalHash"
      FROM public."IngestionExternalRecord" e
      JOIN public."IngestionProposalContent" c ON c."customerId"=e."customerId" AND c."sourceId"=e."sourceId" AND c."recordId"=e.id
      JOIN public."IngestionProposalProjection" p ON p."customerId"=c."customerId" AND p."sourceId"=c."sourceId" AND p."recordId"=c."recordId" AND p.id=c."projectionId"
      WHERE e."customerId"=${customerId}::uuid AND e."sourceId"=${sourceId}::uuid AND e."recordType"='spreadsheet:Exact Sheet'`;
    expect(persistedCsv).toHaveLength(1);
    expect(persistedCsv[0]!.recordKey).toMatch(/^[a-f0-9]{64}$/);
    expect(persistedCsv[0]!.proposalHash).toBe(persistedCsv[0]!.computedProposalHash);
    expect(JSON.stringify(persistedCsv[0]!.proposals)).not.toContain("private-cell-value");
    expect(JSON.stringify(persistedCsv[0]!.proposals)).not.toContain("CASE-CSV");
    const persistedCsvOutcome = await db.$queryRaw<
      { recordId: string; sourceRevisionId: string; projectionId: string; projectId: string; recordKey: string }[]
    >`
      SELECT "recordId","sourceRevisionId","projectionId","projectId","recordKey"
      FROM public."IngestionRowOutcome"
      WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid AND "receiptId"=${preview.receiptId}::uuid AND state='ACCEPTED'`;
    expect(persistedCsvOutcome).toHaveLength(1);

    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`
        INSERT INTO public."IngestionExternalRecord" (id,"customerId","sourceId","projectId","recordType","recordKey")
          VALUES (${randomUUID()}::uuid,${customerId}::uuid,${sourceId}::uuid,${projectId}::uuid,'spreadsheet:Exact Sheet',${"a".repeat(64)})`;
      }),
    ).rejects.toThrow(); // a valid hashed CSV identity still needs a revision/projection/receipt graph at COMMIT
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO public."IngestionExternalRecord" (id,"customerId","sourceId","projectId","recordType","recordKey")
          VALUES (${randomUUID()}::uuid,${customerId}::uuid,${sourceId}::uuid,${projectId}::uuid,'spreadsheet:Exact Sheet','CASE-CSV')`;
      }),
    ).rejects.toThrow(); // CSV record keys are hashed at the database boundary

    const outsideProjectId = randomUUID();
    await db.project.create({
      data: {
        id: outsideProjectId,
        customerId,
        portfolioId,
        code: "ING-OUTSIDE-" + outsideProjectId,
        name: "Outside ingestion scope",
        description: "Synthetic scope guard fixture",
        reportedStatus: "UNKNOWN",
      },
    });
    const managerGrant = await db.$queryRaw<
      { id: string; scopeType: string; scopeId: string }[]
    >`SELECT id,"scopeType","scopeId" FROM public."AccessGrant" WHERE "customerId"=${customerId}::uuid AND subject=${manager.subject} AND "scopeType"='project' AND "scopeId"=${projectId}::uuid`;
    async function directReceipt(
      tx: Prisma.TransactionClient,
      kind: "CSV_PREVIEW",
      outcomeCount: number,
      auditEvent: string,
      auditCount = outcomeCount,
      auditRequestHash = "a".repeat(64),
    ) {
      const receiptId = randomUUID();
      const auditEventId = randomUUID();
      const createdAt = new Date();
      const requestHash = "a".repeat(64);
      await tx.auditEvent.create({
        data: {
          id: auditEventId,
          customerId,
          actor: manager.subject,
          event: auditEvent,
          correlationId: "ingestion-direct-receipt-probe",
          detail: {
            receiptId,
            kind,
            sourceId,
            configRevision: 4,
            mappingRevision: 3,
            scopeProjectIds: [projectId],
            requestHash: auditRequestHash,
            outcomeCount: auditCount,
          },
          occurredAt: createdAt,
        },
      });
      await tx.$executeRaw`
        INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","configRevision","mappingRevision","outcomeCount","auditEventId","createdAt")
        VALUES (${receiptId}::uuid,${customerId}::uuid,${sourceId}::uuid,${manager.subject},${kind},${"direct-" + receiptId},${requestHash},4,3,${outcomeCount},${auditEventId}::uuid,${createdAt})`;
      await tx.$executeRaw`
        INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
        VALUES (${customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,${projectId}::uuid,${managerGrant[0]!.id}::uuid,${"project_manager"},${managerGrant[0]!.scopeType},${managerGrant[0]!.scopeId}::uuid)`;
      return receiptId;
    }
    const cursorState = await db.$queryRaw<
      { syncGeneration: bigint; cursorRevision: bigint; configRevision: number; mappingRevision: number; lastSuccessReceiptId: string | null }[]
    >`
      SELECT s."syncGeneration",s."cursorRevision",s."currentConfigRevision" AS "configRevision",s."mappingRevision",s."lastSuccessReceiptId"
      FROM public."IngestionSource" s WHERE s."customerId"=${customerId}::uuid AND s.id=${sourceId}::uuid`;
    const cursorBefore = cursorState[0]!;
    await expect(
      db.$transaction(async (tx) => {
        const receiptId = randomUUID();
        const auditEventId = randomUUID();
        const createdAt = new Date();
        const generationAfter = cursorBefore.syncGeneration + 1n;
        const cursorRevisionAfter = cursorBefore.cursorRevision + 1n;
        await tx.auditEvent.create({
          data: {
            id: auditEventId,
            customerId,
            actor: manager.subject,
            event: "ingestion.sync_reset",
            correlationId: "ingestion-missing-cursor-cas-probe",
            detail: { receiptId, kind: "SYNC_RESET", outcomeCount: 0 },
            occurredAt: createdAt,
          },
        });
        await tx.$executeRaw`
          INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","configRevision","mappingRevision","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","outcomeCount","auditEventId","createdAt")
          VALUES (${receiptId}::uuid,${customerId}::uuid,${sourceId}::uuid,${manager.subject},'SYNC_RESET',${"missing-cas-" + receiptId},${"c".repeat(64)},${cursorBefore.configRevision},${cursorBefore.mappingRevision},${cursorBefore.syncGeneration},${generationAfter},${cursorBefore.cursorRevision},${cursorRevisionAfter},0,${auditEventId}::uuid,${createdAt})`;
        await tx.$executeRaw`
          INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
          VALUES (${customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,${projectId}::uuid,${managerGrant[0]!.id}::uuid,'project_manager',${managerGrant[0]!.scopeType},${managerGrant[0]!.scopeId}::uuid)`;
        await tx.$executeRaw`
          INSERT INTO public."IngestionCursorTransition" ("customerId","sourceId","receiptId","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","stateAfter","cursorEnvelopeHash")
          VALUES (${customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,${cursorBefore.syncGeneration},${generationAfter},${cursorBefore.cursorRevision},${cursorRevisionAfter},'READY',NULL)`;
      }),
    ).rejects.toThrow(); // cursor receipts cannot commit unless the source CAS reaches their after-state
    const cursorStateAfterProbe = await db.$queryRaw<
      { syncGeneration: bigint; cursorRevision: bigint; lastSuccessReceiptId: string | null }[]
    >`
      SELECT "syncGeneration","cursorRevision","lastSuccessReceiptId" FROM public."IngestionSource"
      WHERE "customerId"=${customerId}::uuid AND id=${sourceId}::uuid`;
    expect(cursorStateAfterProbe).toEqual([
      {
        syncGeneration: cursorBefore.syncGeneration,
        cursorRevision: cursorBefore.cursorRevision,
        lastSuccessReceiptId: cursorBefore.lastSuccessReceiptId,
      },
    ]);
    await expect(
      db.$transaction(async (tx) => {
        await directReceipt(tx, "CSV_PREVIEW", 1, "ingestion.csv_preview.persisted");
      }),
    ).rejects.toThrow(); // incomplete outcome count is rejected at COMMIT
    await expect(
      db.$transaction(async (tx) => {
        await directReceipt(tx, "CSV_PREVIEW", 0, "ingestion.connector_event.persisted");
      }),
    ).rejects.toThrow(); // a mismatched audit receipt is rejected at COMMIT
    await expect(
      db.$transaction(async (tx) => {
        await directReceipt(
          tx,
          "CSV_PREVIEW",
          0,
          "ingestion.csv_preview.persisted",
          0,
          "b".repeat(64),
        );
      }),
    ).rejects.toThrow(); // the audited digest must equal the immutable receipt digest
    await expect(
      db.$transaction(async (tx) => {
        const receiptId = await directReceipt(
          tx,
          "CSV_PREVIEW",
          1,
          "ingestion.csv_preview.persisted",
        );
        await tx.$executeRaw`
          INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes","projectId")
        VALUES (${customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,1,'INVALID','NONE',ARRAY['INVALID_INPUT']::text[],${outsideProjectId}::uuid)`;
      }),
    ).rejects.toThrow(); // receipt outcomes cannot name projects outside the authorized snapshot
    await expect(
      db.$transaction(async (tx) => {
        const receiptId = await directReceipt(
          tx,
          "CSV_PREVIEW",
          1,
          "ingestion.csv_preview.persisted",
        );
        const outcome = persistedCsvOutcome[0]!;
        await tx.$executeRaw`
          INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes","projectId","recordKey","recordId","sourceRevisionId","projectionId")
          VALUES (${customerId}::uuid,${sourceId}::uuid,${receiptId}::uuid,1,'ACCEPTED','UNCHANGED',ARRAY[]::text[],${outcome.projectId}::uuid,${"forged-record-key"},${outcome.recordId}::uuid,${outcome.sourceRevisionId}::uuid,${outcome.projectionId}::uuid)`;
      }),
    ).rejects.toThrow(); // accepted receipt identities must match their referenced external record

    const currentCsvConfiguration = {
      ...configuration,
      mapping: {
        kind: "CSV" as const,
        sheet: "Exact Sheet",
        identityColumn: "Issue ID",
        projectColumn: "Project",
        fields: [
          {
            column: "Forecast",
            factType: "project.forecast",
            type: "date" as const,
            required: true,
          },
        ],
      },
    };
    const readerRevoked = await repository.configure(
      pmo,
      {
        ...currentCsvConfiguration,
        projects: [{ projectId, readers: [nonReader.subject] }],
      },
      "ingestion-test-reader-revoked",
    );
    expect(readerRevoked).toMatchObject({ configRevision: 5, mappingRevision: 3 });
    await expect(
      repository.readReceipt(manager, { sourceId, receiptId: preview.receiptId }),
    ).rejects.toMatchObject({ code: "DENIED" });
    const readerRestored = await repository.configure(
      pmo,
      currentCsvConfiguration,
      "ingestion-test-reader-restored",
    );
    expect(readerRestored).toMatchObject({ configRevision: 6, mappingRevision: 3 });

    const remap = await repository.configure(
      pmo,
      {
        ...configuration,
        projects: [{ projectId, readers: [manager.subject] }],
        mapping: {
          kind: "CONNECTOR",
          factTypes: ["project.forecast", "project.status"],
        },
      },
      "ingestion-test-expired-remap-config",
    );
    expect(remap).toMatchObject({ configRevision: 7, mappingRevision: 4 });
    const sourceRecord = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM public."IngestionExternalRecord"
      WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid
        AND "recordType"=${eventRecord.ref.recordType} AND "recordKey"=${eventRecord.ref.recordId}`;
    expect(sourceRecord).toHaveLength(1);
    const sourceRevision = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM public."IngestionSourceRevision"
      WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid
        AND "recordId"=${sourceRecord[0]!.id}::uuid AND revision=${eventRecord.revision}`;
    expect(sourceRevision).toHaveLength(1);
    const setSyntheticReceivedAt = async (receivedAt: Date) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE public."IngestionSourceRevision" DISABLE TRIGGER ingestion_revision_guard');
        try {
          await tx.$executeRaw`UPDATE public."IngestionSourceRevision" SET "receivedAt"=${receivedAt} WHERE id=${sourceRevision[0]!.id}::uuid`;
        } finally {
          await tx.$executeRawUnsafe('ALTER TABLE public."IngestionSourceRevision" ENABLE TRIGGER ingestion_revision_guard');
        }
      });
    await setSyntheticReceivedAt(new Date(Date.now() - 25 * 60 * 60 * 1000));
    const beforeExpiredRemap = await db.$queryRaw<{ projections: number; content: number }[]>`
      SELECT count(DISTINCT p.id)::int AS projections,count(DISTINCT c."projectionId")::int AS content
      FROM public."IngestionSourceRevision" r
      LEFT JOIN public."IngestionProposalProjection" p ON p."sourceRevisionId"=r.id
      LEFT JOIN public."IngestionProposalContent" c ON c."projectionId"=p.id
      WHERE r.id=${sourceRevision[0]!.id}::uuid`;
    await expect(
      repository.persistConnectorEvent(
        manager,
        {
          sourceId,
          configRevision: remap.configRevision,
          mappingRevision: remap.mappingRevision,
          commandKey: "expired-revision-remap",
          eventId: "expired-revision-remap-event",
          record: eventRecord,
        },
        "ingestion-test-expired-revision-remap",
      ),
    ).rejects.toThrow();
    const expiredRemapState = await db.$queryRaw<{ projections: number; content: number }[]>`
      SELECT count(DISTINCT p.id)::int AS projections,count(DISTINCT c."projectionId")::int AS content
      FROM public."IngestionSourceRevision" r
      LEFT JOIN public."IngestionProposalProjection" p ON p."sourceRevisionId"=r.id
      LEFT JOIN public."IngestionProposalContent" c ON c."projectionId"=p.id
      WHERE r.id=${sourceRevision[0]!.id}::uuid`;
    expect(expiredRemapState).toEqual(beforeExpiredRemap);

    await setSyntheticReceivedAt(new Date(Date.now() - 24 * 60 * 60 * 1000 + 5000));
    const availableBeforeExpiry = (await repository.readReceipt(manager, {
      sourceId,
      receiptId: persisted.receiptId,
    })) as { outcomes: { contentAvailable: boolean }[] };
    expect(availableBeforeExpiry.outcomes[0]?.contentAvailable).toBe(true);
    let lockDelayedRead: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public."IngestionSource" WHERE "customerId"=${customerId}::uuid AND id=${sourceId}::uuid FOR UPDATE`;
      lockDelayedRead = repository.readReceipt(manager, { sourceId, receiptId: persisted.receiptId });
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }, { timeout: 15_000 });
    const afterExpiryRead = (await lockDelayedRead) as { outcomes: { contentAvailable: boolean; proposals: unknown }[] };
    expect(afterExpiryRead.outcomes[0]).toMatchObject({ contentAvailable: false, proposals: null });

    await db.accessGrant.deleteMany({
      where: { customerId, subject: manager.subject, scopeType: "project", scopeId: projectId },
    });
    await expect(
      repository.readReceipt(manager, { sourceId, receiptId: persisted.receiptId }),
    ).rejects.toMatchObject({ code: "DENIED" });
  });
});
