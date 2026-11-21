import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, expect, it } from "vitest";
import { createDatabase, DatabaseIngestionRepository } from "../packages/data/src/index.js";
import type { Prisma } from "../packages/data/src/generated/prisma/client.js";
import { CredentialVault } from "../packages/platform/src/index.js";
import { proveXlsxSourceGenesis } from "../scripts/acceptance/xlsx-source-genesis.mjs";

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

it("uses the sealed reviewed row and its explicit workbook snapshot time", async () => {
  const sheet = "Snapshot " + randomUUID().slice(0, 12);
  await proveXlsxSourceGenesis(pool, { retain: true, sheet, snapshotRequired: true });
  const [scope] = await db.$queryRaw<{ customerId: string; sourceId: string; projectId: string }[]>`
    SELECT p."customerId",p."sourceId",p."projectId" FROM public."IngestionConfigurationProject" p
    JOIN public."IngestionConfigurationRevision" c
      ON (c."customerId",c."sourceId",c.revision)=(p."customerId",p."sourceId",p."configRevision")
    WHERE c.mapping->>'sheet'=${sheet} AND c.sealed`;
  expect(scope).toBeDefined();
  const { customerId, projectId, sourceId } = scope!;
  const actor = { customerId, subject: "synthetic-workbook-pmo", roles: ["pmo_admin"] as const };
  const administrator = { customerId, subject: "synthetic-source-admin", roles: ["system_admin"] as const };
  await db.accessGrant.create({ data: {
    customerId, scopeId: projectId, scopeType: "project",
    subject: administrator.subject, role: administrator.roles[0],
  } });
  const effectiveAt = new Date(Date.now() - 30_000).toISOString();
  const inFuture = new Date(Date.now() + 86_400_000).toISOString();
  const asApi = <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: "ReadCommitted"; maxWait?: number; timeout?: number },
  ) => db.$transaction(async (tx) => {
    // Owned synthetic fixture only. XLSX's native gate checks session_user,
    // and the change is discarded with this transaction.
    await tx.$executeRaw`SET LOCAL SESSION AUTHORIZATION pdaa_api`;
    return operation(tx);
  }, options);
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
    rowOrdinals: [1, 2], commandKey: randomUUID(),
  }, randomUUID());
  const outcomes = await db.ingestionRowOutcome.findMany({
    where: { receiptId: review.receiptId }, orderBy: { ordinal: "asc" },
  });
  expect(outcomes.map((row) => row.state)).toEqual(["ACCEPTED", "ACCEPTED"]);
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
      effectiveAt, value: { type: "text", value: "COMPLETE" },
      fieldSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  }]);
  expect(await resolve(review.receiptId)).toEqual(proof);
  expect(await resolve(preview.receiptId)).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 2, streams[1]!.id)).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 2)).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 1, streams[0]!.id, "project.forecast")).toEqual([{ input: null }]);
  expect(await resolve(review.receiptId, 1, streams[0]!.id, "source.snapshot_at", randomUUID())).toEqual([{ input: null }]);
  expect(await db.projectFactVersion.count({ where: { customerId } })).toBe(0);
});
