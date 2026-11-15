// FR-CON-006/007 / AC-CON-005: real API-role CSV commit and exact retry.
import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseIngestionRepository,
} from "../packages/data/src/index.js";
import { CredentialVault } from "../packages/platform/dist/index.js";
import type { Prisma } from "../packages/data/src/generated/prisma/client.js";
import type { Actor } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname))
  throw new Error("CSV API-role test requires an isolated synthetic database");
const owner = createDatabase(url);
afterAll(() => owner.$disconnect());

it("commits and replays one reviewed selection without receipt UPDATE privileges", async () => {
  const customerId = randomUUID(),
    portfolioId = randomUUID(),
    projectId = randomUUID(),
    sourceId = randomUUID();
  const subject = "csv-api-" + randomUUID();
  await owner.customer.create({
    data: { id: customerId, name: "Synthetic CSV API role" },
  });
  await owner.portfolio.create({
    data: { id: portfolioId, customerId, name: "CSV role fixture" },
  });
  await owner.project.create({
    data: {
      id: projectId,
      customerId,
      portfolioId,
      code: "CSV-API",
      name: "CSV role fixture",
      description: "Synthetic only",
      reportedStatus: "UNKNOWN",
    },
  });
  await owner.accessGrant.createMany({
    data: [
      {
        customerId,
        subject,
        scopeType: "project",
        scopeId: projectId,
        role: "pmo_admin",
      },
      {
        customerId,
        subject: subject + "-retention",
        scopeType: "project",
        scopeId: projectId,
        role: "system_admin",
      },
    ],
  });

  type Options = {
    isolationLevel?: "ReadCommitted";
    maxWait?: number;
    timeout?: number;
  };
  const asApi = <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: Options,
  ) =>
    owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect(
        (
          await tx.$queryRaw<
            { role: string; superuser: boolean }[]
          >`SELECT current_user::text AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`
        )[0],
      ).toEqual({ role: "pdaa_api", superuser: false });
      return operation(tx);
    }, options);
  // Every operation is a real native query/transaction under the restricted role.
  const api = new DatabaseIngestionRepository(
    {
      $queryRaw: (sql: TemplateStringsArray, ...values: unknown[]) =>
        asApi((tx) => tx.$queryRaw(sql, ...values)),
      $transaction: asApi,
      auditEvent: {
        create: (args: Prisma.AuditEventCreateArgs) =>
          asApi((tx) => tx.auditEvent.create(args)),
      },
    } as never,
    new CredentialVault(Buffer.alloc(32, 57).toString("base64")),
  );
  const actor: Actor = {
    customerId,
    subject,
    roles: ["pmo_admin"],
  };
  await api.setRetention(
    { customerId, subject: subject + "-retention", roles: ["system_admin"] },
    { retentionHours: 24 },
    randomUUID(),
  );
  const configured = await api.configure(
    actor,
    {
      binding: {
        customerId,
        sourceId,
        sourceType: "spreadsheet",
        origin: "https://csv.example",
      },
      projects: [{ projectId, readers: [subject] }],
      mapping: {
        kind: "CSV",
        sheet: "Projects",
        identityColumn: "Key",
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
    randomUUID(),
  );
  const preview = await api.persistCsvPreview(
    actor,
    {
      sourceId,
      configRevision: configured.configRevision,
      mappingRevision: configured.mappingRevision,
      commandKey: randomUUID(),
      fileName: "role.csv",
      csv: `Key,Project,Forecast\nROW-1,${projectId},2027-03-01\nROW-2,${projectId},not-a-date\nROW-3,${projectId},2027-04-15\n`,
    },
    randomUUID(),
  );
  const privileges = await owner.$queryRaw<
    { select: boolean; insert: boolean; update: boolean }[]
  >`
    SELECT has_table_privilege('pdaa_api','public."IngestionOperationReceipt"','SELECT') AS select,
      has_table_privilege('pdaa_api','public."IngestionOperationReceipt"','INSERT') AS insert,
      has_table_privilege('pdaa_api','public."IngestionOperationReceipt"','UPDATE') AS update`;
  expect(privileges).toEqual([{ select: true, insert: true, update: false }]);
  let lockError: unknown;
  try {
    await asApi(
      (tx) =>
        tx.$queryRaw`SELECT id FROM public."IngestionOperationReceipt" WHERE id=${preview.receiptId}::uuid FOR SHARE`,
    );
  } catch (error) {
    lockError = error;
  }
  const metadata = (
    lockError as {
      meta?: {
        code?: string;
        driverAdapterError?: { cause?: { originalCode?: string } };
      };
    }
  )?.meta;
  expect(
    metadata?.code ?? metadata?.driverAdapterError?.cause?.originalCode,
  ).toBe("42501");

  await expect(
    api.commitCsvReviewedImport(
      actor,
      {
        sourceId,
        previewReceiptId: preview.receiptId,
        rowOrdinals: [2],
        commandKey: randomUUID(),
      },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "INVALID_PREVIEW" });
  expect(
    await owner.ingestionReviewedImport.count({
      where: { customerId, sourceId },
    }),
  ).toBe(0);
  const command = {
    sourceId,
    previewReceiptId: preview.receiptId,
    rowOrdinals: [3],
    commandKey: randomUUID(),
  };
  const first = await api.commitCsvReviewedImport(actor, command, randomUUID());
  expect(first).toMatchObject({
    parentPreviewReceiptId: preview.receiptId,
    replayed: false,
    rowCount: 1,
  });
  expect(
    await api.commitCsvReviewedImport(actor, command, randomUUID()),
  ).toEqual({ ...first, replayed: true });
  const read = await api.readReceipt(actor, {
    sourceId,
    receiptId: first.receiptId,
  });
  expect(read.outcomes).toMatchObject([
    {
      ordinal: 1,
      parentOrdinal: 3,
      state: "ACCEPTED",
      operation: "CREATE",
      contentAvailable: true,
    },
  ]);
  expect(
    await owner.ingestionReviewedImport.count({
      where: { customerId, sourceId },
    }),
  ).toBe(1);
  expect(
    await owner.ingestionReviewedImportRow.count({
      where: { customerId, sourceId },
    }),
  ).toBe(1);
  expect(
    await owner.ingestionOperationReceipt.count({
      where: { customerId, sourceId },
    }),
  ).toBe(2);
  expect(
    await owner.auditEvent.count({
      where: { customerId, event: "ingestion.csv_reviewed_import.persisted" },
    }),
  ).toBe(1);
});
