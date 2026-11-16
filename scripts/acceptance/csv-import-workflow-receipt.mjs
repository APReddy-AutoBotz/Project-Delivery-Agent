// FR-CON-006/007 / AC-CON-005: finite host verification of the native CSV proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { csvStorageTables } from "./csv-import-native.mjs";
import { csvImportFixture } from "./csv-import-fixture.mjs";

export const csvCanonicalTables = Object.freeze([
  "Project",
  "AccessGrant",
  "ProjectFact",
  "FactSource",
  "FactSourceAccess",
  "FactSourceReader",
  "FactEvidence",
  "ProjectFactVersion",
  "FactAppendReceipt",
  "AuthorityPolicy",
  "AuthorityPolicyRevision",
  "AuthorityPolicyReceipt",
  "FactAuthorityConflict",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
  "Programme",
  "CanonicalProject",
  "ProjectResponsibility",
  "Sprint",
  "Milestone",
  "WorkItem",
  "RequiredWorkItem",
  "RaidItem",
  "CanonicalSourceMapping",
  "CanonicalCreationReceipt",
  "RaidReopenReceipt",
  "BlockerAgeThresholdPolicy",
]);
const check = (value) => assert(value, "Invalid CSV workflow proof");
const id = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const sha = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) =>
  object(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function response(value, status, bodyKeys) {
  check(
    keys(value, ["status", "bytes", "sha256", ...(bodyKeys ? ["body"] : [])]),
  );
  check(
    value.status === status &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= 65536 &&
      sha(value.sha256),
  );
  if (bodyKeys) check(keys(value.body, bodyKeys));
}
function acknowledgement(value, kind, replayed, fixture, first = false) {
  const bodyKeys = [
    "receiptId",
    "replayed",
    "rowCount",
    ...(kind === "review" ? ["parentPreviewReceiptId"] : []),
  ];
  if (first) {
    check(
      keys(value, ["status", "bytes", "sha256", "body", "eof", "released"]),
    );
    check(value.eof === true && value.released === true);
    response(
      {
        status: value.status,
        bytes: value.bytes,
        sha256: value.sha256,
        body: value.body,
      },
      201,
      bodyKeys,
    );
  } else response(value, 201, bodyKeys);
  check(
    value.body.receiptId ===
      (kind === "review" ? fixture.reviewReceiptId : fixture.previewReceiptId),
  );
  check(
    value.body.replayed === replayed &&
      value.body.rowCount === (kind === "review" ? 1 : 3),
  );
  if (kind === "review")
    check(value.body.parentPreviewReceiptId === fixture.previewReceiptId);
}
function counts(value, tables) {
  check(keys(value, tables));
  check(Object.values(value).every((n) => Number.isSafeInteger(n) && n >= 0));
}
function canonical(value) {
  check(keys(value, ["before", "after"]));
  for (const projection of [value.before, value.after]) {
    check(keys(projection, ["sha256", "counts"]) && sha(projection.sha256));
    counts(projection.counts, csvCanonicalTables);
    for (const name of [
      "Project",
      "AccessGrant",
      "ProjectFact",
      "ProjectFactVersion",
      "FactEvidence",
      "FactAppendReceipt",
    ])
      check(projection.counts[name] > 0);
  }
  check(equal(value.before, value.after));
}
function native(value, fixture, reviewed = true) {
  check(
    keys(value, [
      "sha256",
      "counts",
      "previewReceiptId",
      "reviewReceiptId",
      "validReceiptIds",
      "auditIds",
      "selectedPreviewOrdinal",
      "selectedReviewedOrdinal",
    ]),
  );
  check(sha(value.sha256));
  counts(value.counts, csvStorageTables);
  for (const name of csvStorageTables) {
    const expected = [
      "IngestionExternalRecord",
      "IngestionFactStream",
      "IngestionSourceRevision",
      "IngestionProposalProjection",
      "IngestionProposalContent",
    ].includes(name)
      ? 2
      : ["IngestionOperationReceipt", "IngestionReceiptProjectScope"].includes(
            name,
          )
        ? reviewed
          ? 2
          : 1
        : name === "IngestionCursorTransition"
          ? 0
          : name === "IngestionRowOutcome"
            ? reviewed
              ? 4
              : 3
            : [
                  "IngestionReviewedImport",
                  "IngestionReviewedImportRow",
                ].includes(name)
              ? reviewed
                ? 1
                : 0
              : 1;
    check(value.counts[name] === expected);
  }
  check(
    value.previewReceiptId === fixture.previewReceiptId &&
      value.reviewReceiptId === (reviewed ? fixture.reviewReceiptId : null),
  );
  const expectedIds = [
    fixture.previewReceiptId,
    ...(reviewed ? [fixture.reviewReceiptId] : []),
  ].sort();
  check(equal(value.validReceiptIds, expectedIds));
  check(
    Array.isArray(value.auditIds) &&
      value.auditIds.length === expectedIds.length &&
      value.auditIds.every(id) &&
      new Set(value.auditIds).size === expectedIds.length,
  );
  check(
    value.selectedPreviewOrdinal === (reviewed ? 3 : null) &&
      value.selectedReviewedOrdinal === (reviewed ? 1 : null),
  );
}
function receipt(value, fixture, reviewed) {
  check(
    keys(value, [
      "id",
      "sourceId",
      "actor",
      "kind",
      "rowCount",
      "parentPreviewReceiptId",
      "configRevision",
      "mappingRevision",
      "outcomes",
    ]),
  );
  check(
    value.id ===
      (reviewed ? fixture.reviewReceiptId : fixture.previewReceiptId) &&
      value.sourceId === fixture.sourceId &&
      value.actor === "pmo-atlas",
  );
  check(
    value.kind === (reviewed ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW") &&
      value.parentPreviewReceiptId ===
        (reviewed ? fixture.previewReceiptId : null),
  );
  check(
    value.configRevision === 1 &&
      value.mappingRevision === 1 &&
      value.rowCount === (reviewed ? 1 : 3),
  );
  check(
    Array.isArray(value.outcomes) && value.outcomes.length === value.rowCount,
  );
  value.outcomes.forEach((row, index) => {
    check(
      keys(row, [
        "ordinal",
        "parentOrdinal",
        "state",
        "operation",
        "projectId",
        "identity",
        "contentAvailable",
        "proposalCount",
      ]),
    );
    const ordinal = reviewed ? 3 : index + 1;
    check(
      row.ordinal === index + 1 &&
        row.parentOrdinal === (reviewed ? 3 : null) &&
        row.projectId === fixture.projectId,
    );
    check(
      row.state === (ordinal === 2 ? "INVALID" : "ACCEPTED") &&
        row.operation === (ordinal === 2 ? "NONE" : "CREATE"),
    );
    check(row.proposalCount === (ordinal === 2 ? 0 : 1));
    check(typeof row.contentAvailable === "boolean");
    if (ordinal === 2)
      check(row.contentAvailable === false && row.identity === null);
    else {
      check(row.contentAvailable === true);
      check(
        equal(row.identity, [
          "spreadsheet:Projects",
          digest(JSON.stringify(["Projects", `DELIVERY-${ordinal}`])),
        ]),
      );
    }
  });
}
export function assertCsvImportWorkflowReceipt(value, expected) {
  check(
    keys(value, [
      "schemaVersion",
      "customerId",
      "projectId",
      "sourceId",
      "profile",
      "runId",
      "previewReceiptId",
      "reviewReceiptId",
      "preview",
      "review",
      "apiReplays",
      "negative",
      "screenshot",
      "sourceReaderDenial",
      "canonical",
      "retentionSetup",
      "storageBeforeBackup",
      "afterRecreation",
      "restored",
    ]),
  );
  check(
    value.schemaVersion === 1 &&
      value.customerId === "10000000-0000-4000-8000-000000000002" &&
      value.projectId === "30000000-0000-4000-8000-000000000003",
  );
  check(
    [value.sourceId, value.previewReceiptId, value.reviewReceiptId].every(id) &&
      new Set([value.sourceId, value.previewReceiptId, value.reviewReceiptId])
        .size === 3,
  );
  check(
    ["bundled", "external"].includes(value.profile) &&
      value.profile === expected.profile &&
      value.runId === expected.runId &&
      /^pdaa-acceptance-\d+-[a-f0-9]{8}$/.test(value.runId),
  );
  check(
    keys(value.retentionSetup, [
      "retentionHours",
      "revision",
      "temporaryGrantRemoved",
    ]) &&
      value.retentionSetup.retentionHours === 24 &&
      value.retentionSetup.revision === 1 &&
      value.retentionSetup.temporaryGrantRemoved === true,
  );
  check(
    keys(value.preview, [
      "commandKey",
      "configRevision",
      "mappingRevision",
      "csvSha256",
      "acknowledgement",
      "receipt",
    ]),
  );
  check(
    id(value.preview.commandKey) &&
      value.preview.configRevision === 1 &&
      value.preview.mappingRevision === 1 &&
      value.preview.csvSha256 === csvImportFixture.csvSha256,
  );
  acknowledgement(value.preview.acknowledgement, "preview", false, value);
  receipt(value.preview.receipt, value, false);
  const review = value.review;
  check(
    keys(review, [
      "posts",
      "attempts",
      "first",
      "retryAck",
      "requestsFinished",
      "requestsFailed",
      "uncertainShown",
      "freshWriteDisabled",
      "completedBeforeRetry",
      "nativeBeforeRetry",
      "nativeAfterRetry",
      "receipt",
    ]),
  );
  check(
    Array.isArray(review.posts) &&
      review.posts.length === 2 &&
      review.posts.every(
        (post) => typeof post === "string" && Buffer.byteLength(post) <= 65536,
      ) &&
      review.posts[0] === review.posts[1],
  );
  let command;
  try {
    command = JSON.parse(review.posts[0]);
  } catch {
    check(false);
  }
  check(
    keys(command, ["previewReceiptId", "rowOrdinals", "commandKey"]) &&
      JSON.stringify(command) === review.posts[0],
  );
  check(
    command.previewReceiptId === value.previewReceiptId &&
      id(command.commandKey) &&
      command.commandKey !== value.preview.commandKey &&
      equal(command.rowOrdinals, [3]),
  );
  check(
    review.attempts === 2 &&
      review.requestsFinished === 2 &&
      review.requestsFailed === 0 &&
      review.uncertainShown === true &&
      review.freshWriteDisabled === true &&
      review.completedBeforeRetry === true,
  );
  acknowledgement(review.first, "review", false, value, true);
  acknowledgement(review.retryAck, "review", true, value);
  native(review.nativeBeforeRetry, value);
  native(review.nativeAfterRetry, value);
  check(equal(review.nativeBeforeRetry, review.nativeAfterRetry));
  receipt(review.receipt, value, true);
  check(keys(value.apiReplays, ["preview", "review"]));
  acknowledgement(value.apiReplays.preview, "preview", true, value);
  acknowledgement(value.apiReplays.review, "review", true, value);
  const negative = value.negative;
  check(
    keys(negative, [
      "invalidRow",
      "nativeBeforeInvalid",
      "nativeAfterInvalid",
      "changedPreview",
      "changedReview",
      "secondCommand",
      "previewUnchangedAfterInvalid",
      "nativeAfterProbes",
    ]),
  );
  for (const name of [
    "invalidRow",
    "changedPreview",
    "changedReview",
    "secondCommand",
  ])
    response(negative[name], 409);
  native(negative.nativeBeforeInvalid, value, false);
  native(negative.nativeAfterInvalid, value, false);
  check(
    equal(negative.nativeBeforeInvalid, negative.nativeAfterInvalid) &&
      negative.previewUnchangedAfterInvalid === true,
  );
  native(negative.nativeAfterProbes, value);
  check(equal(negative.nativeAfterProbes, review.nativeAfterRetry));
  check(
    negative.nativeBeforeInvalid.auditIds.every((auditId) =>
      review.nativeAfterRetry.auditIds.includes(auditId),
    ),
  );
  check(
    keys(value.screenshot, ["file", "sha256"]) &&
      value.screenshot.file === "csv-native-reviewed-import.png" &&
      sha(value.screenshot.sha256),
  );
  const denial = value.sourceReaderDenial;
  check(
    keys(denial, [
      "projectGrantCount",
      "sourceReaderCount",
      "projectRead",
      "response",
    ]) &&
      denial.projectGrantCount === 1 &&
      denial.sourceReaderCount === 0,
  );
  check(
    keys(denial.projectRead, ["status", "bytes", "sha256", "id"]) &&
      denial.projectRead.id === value.projectId,
  );
  response(
    {
      status: denial.projectRead.status,
      bytes: denial.projectRead.bytes,
      sha256: denial.projectRead.sha256,
    },
    200,
  );
  response(denial.response, 404);
  canonical(value.canonical);
  native(value.storageBeforeBackup, value);
  check(
    equal(value.storageBeforeBackup.auditIds, review.nativeAfterRetry.auditIds),
  );
  const recreated = value.afterRecreation;
  check(
    keys(recreated, [
      "method",
      "receipt",
      "preview",
      "review",
      "nativeBefore",
      "nativeAfter",
      "canonical",
    ]) && recreated.method === "AUTHORIZED_API_AFTER_RECREATION",
  );
  receipt(recreated.receipt, value, true);
  acknowledgement(recreated.preview, "preview", true, value);
  acknowledgement(recreated.review, "review", true, value);
  for (const stage of [recreated.nativeBefore, recreated.nativeAfter]) {
    native(stage, value);
    check(equal(stage, value.storageBeforeBackup));
  }
  canonical(recreated.canonical);
  const restored = value.restored;
  check(
    keys(restored, [
      "method",
      "native",
      "apiCanConnect",
      "workerCanConnect",
      "applicationStarted",
    ]) && restored.method === "NATIVE_RETAINED_DATA_BEFORE_PROBES",
  );
  check(
    restored.apiCanConnect === false &&
      restored.workerCanConnect === false &&
      restored.applicationStarted === false,
  );
  native(restored.native, value);
  check(equal(restored.native, value.storageBeforeBackup));
  return true;
}
