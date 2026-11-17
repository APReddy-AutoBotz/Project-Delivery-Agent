// FR-CON-006/007 / EXEC-009: native oracles for the guarded customer fixture.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export const csvStorageTables = Object.freeze([
  "IngestionSource",
  "IngestionConfigurationRevision",
  "IngestionConfigurationProject",
  "IngestionConfigurationReader",
  "IngestionRetentionPolicy",
  "IngestionExternalRecord",
  "IngestionFactStream",
  "IngestionSourceRevision",
  "IngestionProposalProjection",
  "IngestionProposalContent",
  "IngestionOperationReceipt",
  "IngestionReceiptProjectScope",
  "IngestionCursorTransition",
  "IngestionRowOutcome",
  "IngestionReviewedImport",
  "IngestionReviewedImportRow",
  "IngestionCsvHead",
  "IngestionCsvContext",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}
export const csvDigest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
const normalized = (value) => JSON.parse(JSON.stringify(value));

export function assertCsvFixture(binding) {
  assert.equal(binding.customerId, "10000000-0000-4000-8000-000000000002");
  assert.equal(binding.projectId, "30000000-0000-4000-8000-000000000003");
  assert(["bundled", "external"].includes(binding.profile));
  assert.match(binding.runId, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
  if (binding.sourceId !== undefined) assert.match(binding.sourceId, uuid);
}

export async function prepareCsvRetention(pool, binding, setRetention) {
  assertCsvFixture(binding);
  assert.equal(process.env.PDAA_ACCEPTANCE, "customer-composition");
  assert.equal(process.env.PDAA_ACCEPTANCE_RUN_ID, binding.runId);
  assert.equal(process.env.PDAA_CUSTOMER_PROFILE, binding.profile);
  const grants = async () =>
    (
      await pool.query(
        'SELECT to_jsonb(g) AS row FROM public."AccessGrant" g WHERE "customerId"=$1::uuid ORDER BY to_jsonb(g)::text',
        [binding.customerId],
      )
    ).rows.map(({ row }) => row);
  const before = await grants();
  const id = randomUUID(),
    subject = "csv-retention-" + randomUUID();
  const failures = [];
  let revision;
  try {
    await pool.query(
      'INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1::uuid,$2::uuid,$3,\'project\',$4::uuid,\'system_admin\')',
      [id, binding.customerId, subject, binding.projectId],
    );
    revision = await setRetention({
      customerId: binding.customerId,
      subject,
      roles: ["system_admin"],
    });
    assert(Number.isSafeInteger(revision) && revision >= 1);
  } catch (error) {
    failures.push(error);
  }
  try {
    const removed = await pool.query(
      'DELETE FROM public."AccessGrant" WHERE id=$1::uuid AND "customerId"=$2::uuid AND subject=$3 AND "scopeType"=\'project\' AND "scopeId"=$4::uuid AND role=\'system_admin\'',
      [id, binding.customerId, subject, binding.projectId],
    );
    assert(
      failures.length
        ? [0, 1].includes(removed.rowCount)
        : removed.rowCount === 1,
    );
    assert.deepEqual(
      await grants(),
      before,
      "CSV retention setup changed existing grants",
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "CSV retention setup and cleanup failed",
    );
  const policy = (
    await pool.query(
      'SELECT "retentionHours",revision,"changedBy" FROM public."IngestionRetentionPolicy" WHERE "customerId"=$1::uuid',
      [binding.customerId],
    )
  ).rows;
  assert.deepEqual(policy, [
    { retentionHours: 24, revision, changedBy: subject },
  ]);
  return { retentionHours: 24, revision, temporaryGrantRemoved: true };
}

export function csvProjectionReceipt(projection) {
  const data = normalized(projection);
  return {
    sha256: csvDigest(data),
    counts: Object.fromEntries(
      Object.entries(data).map(([table, rows]) => {
        assert(Array.isArray(rows));
        return [table, rows.length];
      }),
    ),
  };
}

export async function csvStorageProjection(pool, binding) {
  assertCsvFixture(binding);
  assert.match(binding.sourceId, uuid);
  const result = {};
  for (const table of csvStorageTables) {
    // Identifiers are solely from the finite table inventory above.
    const predicate =
      table === "IngestionRetentionPolicy"
        ? ""
        : table === "IngestionSource"
          ? " AND id=$2::uuid"
          : ' AND "sourceId"=$2::uuid';
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) AS row FROM public."${table}" t WHERE "customerId"=$1::uuid${predicate} ORDER BY to_jsonb(t)::text`,
        table === "IngestionRetentionPolicy"
          ? [binding.customerId]
          : [binding.customerId, binding.sourceId],
      )
    ).rows.map(({ row }) => row);
  }
  return result;
}

export async function inspectCsvNativeBatch(pool, binding, expected) {
  const projection = await csvStorageProjection(pool, binding);
  const reviewed = expected.reviewReceiptId !== undefined;
  const counts = {
    IngestionSource: 1,
    IngestionConfigurationRevision: 1,
    IngestionConfigurationProject: 1,
    IngestionConfigurationReader: 1,
    IngestionRetentionPolicy: 1,
    IngestionExternalRecord: 2,
    IngestionFactStream: 2,
    IngestionSourceRevision: 2,
    IngestionProposalProjection: 2,
    IngestionProposalContent: 2,
    IngestionOperationReceipt: reviewed ? 2 : 1,
    IngestionReceiptProjectScope: reviewed ? 2 : 1,
    IngestionCursorTransition: 0,
    IngestionRowOutcome: reviewed ? 4 : 3,
    IngestionReviewedImport: reviewed ? 1 : 0,
    IngestionReviewedImportRow: reviewed ? 1 : 0,
    IngestionCsvHead: 1,
    IngestionCsvContext: 1,
  };
  assert.deepEqual(csvProjectionReceipt(projection).counts, counts);
  const receipts = projection.IngestionOperationReceipt;
  const preview = receipts.find((row) => row.id === expected.previewReceiptId);
  assert(preview);
  assert.equal(preview.kind, "CSV_PREVIEW");
  assert.equal(preview.outcomeCount, 3);
  assert.equal(preview.commandKey, expected.previewCommandKey);
  assert.equal(
    preview.requestHash,
    csvDigest({
      csvHash: expected.csvSha256,
      configRevision: 1,
      mappingRevision: 1,
      baseline: null,
    }),
  );
  for (const row of receipts) {
    assert.equal(row.customerId, binding.customerId);
    assert.equal(row.sourceId, binding.sourceId);
    assert.equal(row.subject, "pmo-atlas");
    assert.equal(row.configRevision, 1);
    assert.equal(row.mappingRevision, 1);
    assert.match(row.requestHash, digestPattern);
  }
  const outcomes = projection.IngestionRowOutcome;
  const previewRows = outcomes
    .filter((row) => row.receiptId === preview.id)
    .sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(
    previewRows.map(({ ordinal, state, operation }) => ({
      ordinal,
      state,
      operation,
    })),
    [
      { ordinal: 1, state: "ACCEPTED", operation: "CREATE" },
      { ordinal: 2, state: "INVALID", operation: "NONE" },
      { ordinal: 3, state: "ACCEPTED", operation: "CREATE" },
    ],
  );
  assert(previewRows[1].errorCodes.includes("INVALID_VALUE"));
  for (const key of ["recordId", "sourceRevisionId", "projectionId"])
    assert.equal(previewRows[1][key], null);
  for (const [ordinal, identity, value] of [
    [1, "DELIVERY-1", "2027-03-01"],
    [3, "DELIVERY-3", "2027-04-15"],
  ]) {
    const row = previewRows[ordinal - 1];
    const record = projection.IngestionExternalRecord.find(
      (entry) => entry.id === row.recordId,
    );
    const revision = projection.IngestionSourceRevision.find(
      (entry) => entry.id === row.sourceRevisionId,
    );
    const proposal = projection.IngestionProposalProjection.find(
      (entry) => entry.id === row.projectionId,
    );
    const content = projection.IngestionProposalContent.find(
      (entry) => entry.projectionId === row.projectionId,
    );
    assert(record && revision && proposal && content);
    assert.equal(record.projectId, binding.projectId);
    assert.equal(record.recordType, "spreadsheet:Projects");
    assert.equal(record.recordKey, csvDigest(["Projects", identity]));
    assert.equal(row.recordKey, record.recordKey);
    assert.equal(revision.recordId, record.id);
    assert.match(expected.rowSourceHashes[ordinal], digestPattern);
    assert.equal(revision.sourceContentHash, expected.rowSourceHashes[ordinal]);
    assert.equal(
      revision.revision,
      "sha256:" + expected.rowSourceHashes[ordinal],
    );
    assert.equal(revision.remoteObservedAt, null);
    assert.equal(revision.remoteEffectiveAt, null);
    assert.equal(proposal.recordId, record.id);
    assert.equal(proposal.sourceRevisionId, revision.id);
    assert.equal(proposal.mappingRevision, 1);
    assert.match(proposal.proposalHash, digestPattern);
    assert.deepEqual(content.proposals, [
      { factType: "project.forecast", value: { type: "date", value } },
    ]);
  }
  let review = null;
  if (reviewed) {
    review = receipts.find((row) => row.id === expected.reviewReceiptId);
    assert(review);
    assert.equal(review.kind, "CSV_REVIEWED_IMPORT");
    assert.equal(review.commandKey, expected.reviewCommandKey);
    assert.equal(review.outcomeCount, 1);
    assert.equal(
      review.requestHash,
      csvDigest({
        sourceId: binding.sourceId,
        previewReceiptId: preview.id,
        rowOrdinals: [3],
        configRevision: 1,
        mappingRevision: 1,
      }),
    );
    assert.equal(projection.IngestionReviewedImport[0].receiptId, review.id);
    assert.equal(
      projection.IngestionReviewedImport[0].previewReceiptId,
      preview.id,
    );
    assert.deepEqual(
      projection.IngestionReviewedImportRow.map(
        ({ receiptId, ordinal, previewReceiptId, previewOrdinal }) => ({
          receiptId,
          ordinal,
          previewReceiptId,
          previewOrdinal,
        }),
      ),
      [
        {
          receiptId: review.id,
          ordinal: 1,
          previewReceiptId: preview.id,
          previewOrdinal: 3,
        },
      ],
    );
    const selected = outcomes.find((row) => row.receiptId === review.id);
    assert.equal(selected.ordinal, 1);
    for (const key of [
      "state",
      "operation",
      "projectId",
      "recordKey",
      "recordId",
      "sourceRevisionId",
      "projectionId",
    ])
      assert.deepEqual(selected[key], previewRows[2][key]);
  }
  const ids = receipts.map((row) => row.id).sort();
  const validContent = (
    await pool.query(
      'SELECT p.id,public.valid_ingestion_projection_content(p.id,c.proposals) AS valid FROM public."IngestionProposalProjection" p JOIN public."IngestionProposalContent" c ON c."customerId"=p."customerId" AND c."sourceId"=p."sourceId" AND c."projectionId"=p.id WHERE p."customerId"=$1::uuid AND p."sourceId"=$2::uuid ORDER BY p.id',
      [binding.customerId, binding.sourceId],
    )
  ).rows;
  assert.deepEqual(
    validContent,
    projection.IngestionProposalProjection.map(({ id }) => ({
      id,
      valid: true,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  );
  const valid = (
    await pool.query(
      'SELECT id,public.valid_ingestion_receipt(id) AS valid FROM public."IngestionOperationReceipt" WHERE "customerId"=$1::uuid AND "sourceId"=$2::uuid AND id=ANY($3::uuid[]) ORDER BY id',
      [binding.customerId, binding.sourceId, ids],
    )
  ).rows;
  assert.deepEqual(
    valid,
    ids.map((id) => ({ id, valid: true })),
  );
  const auditIds = receipts.map((row) => row.auditEventId).sort();
  const audits = (
    await pool.query(
      'SELECT id,actor,event,detail FROM public."AuditEvent" WHERE "customerId"=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id',
      [binding.customerId, auditIds],
    )
  ).rows;
  assert.deepEqual(
    audits.map((row) => row.id),
    auditIds,
  );
  for (const receipt of receipts) {
    const audit = audits.find((row) => row.id === receipt.auditEventId);
    assert.equal(audit.actor, "pmo-atlas");
    assert.equal(
      audit.event,
      receipt.kind === "CSV_PREVIEW"
        ? "ingestion.csv_preview.persisted"
        : "ingestion.csv_reviewed_import.persisted",
    );
    assert.equal(audit.detail.receiptId, receipt.id);
    assert.equal(audit.detail.requestHash, receipt.requestHash);
    assert.equal(audit.detail.outcomeCount, receipt.outcomeCount);
  }
  const retainedText = JSON.stringify(projection);
  for (const value of [
    "DELIVERY-1",
    "DELIVERY-2",
    "DELIVERY-3",
    "csv-private-one",
    "csv-private-two",
    "csv-private-three",
    "native-import.csv",
  ])
    assert(!retainedText.includes(value), "CSV input-only data was retained");
  return {
    ...csvProjectionReceipt(projection),
    previewReceiptId: preview.id,
    reviewReceiptId: review?.id ?? null,
    validReceiptIds: ids,
    auditIds,
    selectedPreviewOrdinal: reviewed ? 3 : null,
    selectedReviewedOrdinal: reviewed ? 1 : null,
  };
}
