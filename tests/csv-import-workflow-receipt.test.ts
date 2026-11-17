// FR-CON-006/007 / AC-CON-005: corrupt independent proof fields and reject incomplete claims.
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  assertCsvImportWorkflowReceipt,
  csvCanonicalTables,
} from "../scripts/acceptance/csv-import-workflow-receipt.mjs";
import { csvImportFixture } from "../scripts/acceptance/csv-import-fixture.mjs";
import { prepareCsvRetention } from "../scripts/acceptance/csv-import-native.mjs";

const uuid = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const customerId = "10000000-0000-4000-8000-000000000002";
const projectId = "30000000-0000-4000-8000-000000000003";
const options = {
  profile: "bundled",
  runId: "pdaa-acceptance-123456-abcdef12",
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sourceId = uuid(1),
  previewReceiptId = uuid(2),
  reviewReceiptId = uuid(3);
function fixture() {
  const response = (status: number, body?: any) => ({
    status,
    bytes: 150,
    sha256: "a".repeat(64),
    ...(body ? { body } : {}),
  });
  const ack = (review: boolean, replayed: boolean) =>
    response(201, {
      receiptId: review ? reviewReceiptId : previewReceiptId,
      replayed,
      rowCount: review ? 1 : 3,
      ...(review ? { parentPreviewReceiptId: previewReceiptId } : {}),
    });
  const native = (review: boolean, sha256 = "b".repeat(64)) => ({
    sha256,
    counts: {
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
      IngestionOperationReceipt: review ? 2 : 1,
      IngestionReceiptProjectScope: review ? 2 : 1,
      IngestionCursorTransition: 0,
      IngestionRowOutcome: review ? 4 : 3,
      IngestionReviewedImport: review ? 1 : 0,
      IngestionReviewedImportRow: review ? 1 : 0,
      IngestionCsvHead: 1,
      IngestionCsvContext: 1,
    },
    previewReceiptId,
    reviewReceiptId: review ? reviewReceiptId : null,
    validReceiptIds: [previewReceiptId, ...(review ? [reviewReceiptId] : [])],
    auditIds: [uuid(6), ...(review ? [uuid(7)] : [])],
    selectedPreviewOrdinal: review ? 3 : null,
    selectedReviewedOrdinal: review ? 1 : null,
  });
  const receipt = (review: boolean) => ({
    id: review ? reviewReceiptId : previewReceiptId,
    sourceId,
    actor: "pmo-atlas",
    kind: review ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW",
    rowCount: review ? 1 : 3,
    parentPreviewReceiptId: review ? previewReceiptId : null,
    configRevision: 1,
    mappingRevision: 1,
    outcomes: (review ? [3] : [1, 2, 3]).map((ordinal, index) => ({
      ordinal: index + 1,
      parentOrdinal: review ? 3 : null,
      projectId,
      state: ordinal === 2 ? "INVALID" : "ACCEPTED",
      operation: ordinal === 2 ? "NONE" : "CREATE",
      identity:
        ordinal === 2
          ? null
          : [
              "spreadsheet:Projects",
              hash(JSON.stringify(["Projects", `DELIVERY-${ordinal}`])),
            ],
      contentAvailable: ordinal !== 2,
      proposalCount: ordinal === 2 ? 0 : 1,
    })),
  });
  const canonical = () => {
    const projection = {
      sha256: "c".repeat(64),
      counts: Object.fromEntries(
        csvCanonicalTables.map((table: string) => [table, 1]),
      ),
    };
    return {
      before: structuredClone(projection),
      after: structuredClone(projection),
    };
  };
  const post = JSON.stringify({
    previewReceiptId,
    rowOrdinals: [3],
    commandKey: uuid(5),
  });
  return {
    schemaVersion: 1,
    customerId,
    projectId,
    sourceId,
    ...options,
    previewReceiptId,
    reviewReceiptId,
    retentionSetup: {
      retentionHours: 24,
      revision: 1,
      temporaryGrantRemoved: true,
    },
    preview: {
      commandKey: uuid(4),
      configRevision: 1,
      mappingRevision: 1,
      csvSha256: csvImportFixture.csvSha256,
      acknowledgement: ack(false, false),
      receipt: receipt(false),
    },
    review: {
      posts: [post, post],
      attempts: 2,
      first: { ...ack(true, false), eof: true, released: true },
      retryAck: ack(true, true),
      requestsFinished: 2,
      requestsFailed: 0,
      uncertainShown: true,
      freshWriteDisabled: true,
      completedBeforeRetry: true,
      nativeBeforeRetry: native(true),
      nativeAfterRetry: native(true),
      receipt: receipt(true),
    },
    apiReplays: { preview: ack(false, true), review: ack(true, true) },
    negative: {
      invalidRow: response(409),
      changedPreview: response(409),
      changedReview: response(409),
      secondCommand: response(409),
      previewUnchangedAfterInvalid: true,
      nativeBeforeInvalid: native(false),
      nativeAfterInvalid: native(false),
      nativeAfterProbes: native(true),
    },
    screenshot: {
      file: "csv-native-reviewed-import.png",
      sha256: "d".repeat(64),
    },
    sourceReaderDenial: {
      projectGrantCount: 1,
      sourceReaderCount: 0,
      projectRead: { ...response(200), id: projectId },
      response: response(404),
    },
    canonical: canonical(),
    storageBeforeBackup: native(true, "e".repeat(64)),
    afterRecreation: {
      method: "AUTHORIZED_API_AFTER_RECREATION",
      receipt: receipt(true),
      preview: ack(false, true),
      review: ack(true, true),
      nativeBefore: native(true, "e".repeat(64)),
      nativeAfter: native(true, "e".repeat(64)),
      canonical: canonical(),
    },
    restored: {
      method: "NATIVE_RETAINED_DATA_BEFORE_PROBES",
      native: native(true, "e".repeat(64)),
      apiCanConnect: false,
      workerCanConnect: false,
      applicationStarted: false,
    },
  };
}
describe("native CSV host proof", () => {
  it("accepts bounded proof for both profiles with later retention fingerprint", () => {
    const proof = fixture();
    expect(assertCsvImportWorkflowReceipt(proof, options)).toBe(true);
    proof.profile = "external";
    expect(
      assertCsvImportWorkflowReceipt(proof, {
        ...options,
        profile: "external",
      }),
    ).toBe(true);
  });
  const mutations: [string, (proof: any) => void][] = [
    [
      "wrong installation",
      (p) => {
        p.customerId = uuid(90);
      },
    ],
    [
      "wrong project",
      (p) => {
        p.projectId = uuid(90);
      },
    ],
    [
      "wrong run",
      (p) => {
        p.runId = "pdaa-acceptance-1-ffffffff";
      },
    ],
    [
      "extra retained content",
      (p) => {
        p.rawCsv = "private";
      },
    ],
    [
      "retention grant left",
      (p) => {
        p.retentionSetup.temporaryGrantRemoved = false;
      },
    ],
    [
      "changed preview input",
      (p) => {
        p.preview.csvSha256 = "f".repeat(64);
      },
    ],
    [
      "missing EOF",
      (p) => {
        p.review.first.eof = false;
      },
    ],
    [
      "failed release",
      (p) => {
        p.review.first.released = false;
      },
    ],
    [
      "raw acknowledgement retained",
      (p) => {
        p.review.first.bodyBase64 = "cHJpdmF0ZQ==";
      },
    ],
    [
      "wrong first status",
      (p) => {
        p.review.first.status = 200;
      },
    ],
    [
      "first already replayed",
      (p) => {
        p.review.first.body.replayed = true;
      },
    ],
    [
      "retry not replayed",
      (p) => {
        p.review.retryAck.body.replayed = false;
      },
    ],
    [
      "different retry",
      (p) => {
        p.review.posts[1] = p.review.posts[1].replace(
          '"rowOrdinals":[3]',
          '"rowOrdinals":[1]',
        );
      },
    ],
    [
      "changed both commands",
      (p) => {
        p.review.posts = p.review.posts.map((s: string) =>
          s.replace("[3]", "[1]"),
        );
      },
    ],
    [
      "failed original request",
      (p) => {
        p.review.requestsFailed = 1;
      },
    ],
    [
      "incomplete retry",
      (p) => {
        p.review.requestsFinished = 1;
      },
    ],
    [
      "fresh write allowed",
      (p) => {
        p.review.freshWriteDisabled = false;
      },
    ],
    [
      "wrong lineage",
      (p) => {
        p.review.receipt.outcomes[0].parentOrdinal = 1;
      },
    ],
    [
      "invalid row claims identity",
      (p) => {
        p.preview.receipt.outcomes[1].identity = [
          "spreadsheet:Projects",
          "f".repeat(64),
        ];
      },
    ],
    [
      "invalid row claims content",
      (p) => {
        p.preview.receipt.outcomes[1].contentAvailable = true;
      },
    ],
    [
      "duplicate native batch",
      (p) => {
        p.review.nativeAfterRetry.counts.IngestionReviewedImport = 2;
      },
    ],
    [
      "missing native table",
      (p) => {
        delete p.review.nativeBeforeRetry.counts.IngestionSourceRevision;
      },
    ],
    [
      "invalid selection persisted",
      (p) => {
        p.negative.nativeAfterInvalid.sha256 = "f".repeat(64);
      },
    ],
    [
      "second command accepted",
      (p) => {
        p.negative.secondCommand.status = 201;
      },
    ],
    [
      "PM lacks positive project read",
      (p) => {
        p.sourceReaderDenial.projectRead.status = 404;
      },
    ],
    [
      "PM is source reader",
      (p) => {
        p.sourceReaderDenial.sourceReaderCount = 1;
      },
    ],
    [
      "unbounded project read metadata",
      (p) => {
        p.sourceReaderDenial.projectRead.raw = "unrequested";
      },
    ],
    [
      "canonical values changed but counts same",
      (p) => {
        p.canonical.after.sha256 = "f".repeat(64);
      },
    ],
    [
      "empty canonical controls",
      (p) => {
        p.canonical.before.counts.ProjectFact = 0;
        p.canonical.after.counts.ProjectFact = 0;
      },
    ],
    [
      "missing canonical table",
      (p) => {
        delete p.canonical.before.counts.CanonicalSourceMapping;
      },
    ],
    [
      "API reuse mislabelled UI",
      (p) => {
        p.afterRecreation.method = "UI_REOPENED";
      },
    ],
    [
      "recreated data drift",
      (p) => {
        p.afterRecreation.nativeBefore.sha256 = "f".repeat(64);
      },
    ],
    [
      "recreated canonical update",
      (p) => {
        p.afterRecreation.canonical.after.sha256 = "f".repeat(64);
      },
    ],
    [
      "restore data drift",
      (p) => {
        p.restored.native.sha256 = "f".repeat(64);
      },
    ],
    [
      "restore audit substitution",
      (p) => {
        p.restored.native.auditIds[1] = uuid(91);
      },
    ],
    [
      "restore API connect",
      (p) => {
        p.restored.apiCanConnect = true;
      },
    ],
    [
      "restore worker connect",
      (p) => {
        p.restored.workerCanConnect = true;
      },
    ],
    [
      "restore application launched",
      (p) => {
        p.restored.applicationStarted = true;
      },
    ],
    [
      "unsafe screenshot path",
      (p) => {
        p.screenshot.file = "../../secret";
      },
    ],
    [
      "nonfinite count",
      (p) => {
        p.storageBeforeBackup.counts.IngestionSource = NaN;
      },
    ],
  ];
  it.each(mutations)("rejects %s", (_, mutate) => {
    const proof = fixture();
    mutate(proof);
    expect(() => assertCsvImportWorkflowReceipt(proof, options)).toThrow();
  });
});

describe("temporary CSV retention grant cleanup", () => {
  it.each(["insert", "setRetention", "both"])(
    "always removes exact grant after %s failure",
    async (mode) => {
      const oldEnv = {
        PDAA_ACCEPTANCE: process.env.PDAA_ACCEPTANCE,
        PDAA_ACCEPTANCE_RUN_ID: process.env.PDAA_ACCEPTANCE_RUN_ID,
        PDAA_CUSTOMER_PROFILE: process.env.PDAA_CUSTOMER_PROFILE,
      };
      Object.assign(process.env, {
        PDAA_ACCEPTANCE: "customer-composition",
        PDAA_ACCEPTANCE_RUN_ID: options.runId,
        PDAA_CUSTOMER_PROFILE: options.profile,
      });
      const queries: { text: string; args: any[] }[] = [];
      let correlation: any[];
      const pool = {
        query: async (text: string, args: any[]) => {
          queries.push({ text, args });
          if (text.startsWith("INSERT")) {
            correlation = args;
            if (mode !== "setRetention")
              throw new Error("insert outcome unknown");
          }
          if (text.startsWith("DELETE")) {
            expect(args).toEqual(correlation!);
            if (mode === "both") throw new Error("cleanup failed");
            return { rowCount: 1, rows: [] };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      try {
        await expect(
          prepareCsvRetention(
            pool,
            { customerId, projectId, ...options },
            async () => {
              throw new Error("retention failure");
            },
          ),
        ).rejects.toThrow(
          mode === "both"
            ? "CSV retention setup and cleanup failed"
            : mode === "insert"
              ? "insert outcome unknown"
              : "retention failure",
        );
        expect(queries.filter((q) => q.text.startsWith("DELETE"))).toHaveLength(
          1,
        );
        expect(
          queries.find((q) => q.text.startsWith("DELETE"))?.text,
        ).toContain("subject=$3");
        expect(
          queries.filter((q) => q.text.startsWith("SELECT to_jsonb")),
        ).toHaveLength(mode === "both" ? 1 : 2);
      } finally {
        for (const [key, value] of Object.entries(oldEnv))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    },
  );
});
