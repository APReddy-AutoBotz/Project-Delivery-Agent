// FR-CON-006/007: compare the applied SQL with the actual TypeScript binding.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  captureXlsxPreviewRequest,
  hashXlsxPreviewContext,
  hashXlsxReviewedSelection,
} from "../../packages/data/dist/ingestion-xlsx-binding.js";
import { xlsxReceiptCodecFunctions } from "../../packages/operations/dist/business-grants.js";

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = {
  customerId: id(1),
  sourceId: id(2),
  subject: "pm Å",
  commandKey: "request-1",
  configRevision: 4,
  mappingRevision: 7,
  sheet: "Portfolio Δ",
  parserContract: "excel-text-v1",
};
const workbook = Buffer.from("504b030400ff", "hex");
const record = {
  id: id(8),
  revisionId: id(9),
  sourceContentSha256: "a".repeat(64),
  projectionId: id(10),
  proposalSha256: "b".repeat(64),
};
const accepted = (ordinal, projectId = id(4)) => ({
  ordinal,
  state: "ACCEPTED",
  operation: "CREATE",
  errorCodes: [],
  projectId,
  keySha256: ordinal.toString(16).padStart(64, "0"),
  record,
});
const invalid = {
  ordinal: 2,
  state: "INVALID",
  operation: "NONE",
  errorCodes: ["REQUIRED_VALUE", "INVALID_VALUE"],
  projectId: id(4),
  keySha256: null,
  record: null,
};
const genesis = (request) => ({
  request,
  previewReceiptId: id(3),
  baseline: { kind: "GENESIS" },
  projectIds: [id(4), id(5)],
  outcomes: [accepted(1), invalid, accepted(3, id(5))],
});
const retained = {
  kind: "RETAINED",
  receiptId: id(12),
  revision: 2147483647,
  stateSha256: "c".repeat(64),
};
const none = {
  ...accepted(3),
  operation: "NONE",
  record: {
    ...record,
    proposalSha256: createHash("sha256").update("[]").digest("hex"),
  },
};
const select = (preview, rowOrdinals) => ({
  customerId: preview.request.customerId,
  sourceId: preview.request.sourceId,
  subject: 'reviewer "2"\t🧪',
  commandKey: "selection-1",
  previewReceiptId: preview.previewReceiptId,
  previewContextSha256: hashXlsxPreviewContext(preview),
  rowOrdinals,
});

const sql = {
  request: "SELECT public.ingestion_xlsx_v1_request_hash($1::jsonb) AS digest",
  context: "SELECT public.ingestion_xlsx_v1_context_hash($1::jsonb) AS digest",
  selection:
    "SELECT public.ingestion_xlsx_v1_selection_hash($1::jsonb,$2::jsonb) AS digest",
};

export async function verifyXlsxReceiptCodec(
  pool,
  {
    roles = ["pdaa_api", "pdaa_worker", "pdaa_backup"],
    owner,
    exhaustive = false,
  } = {},
) {
  const functions = (
    await pool.query(
      `SELECT p.oid,p.prosecdef,p.proisstrict,p.provolatile,p.proconfig,
    pg_get_userbyid(p.proowner) AS owner,
    NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>p.proowner) AS owner_only
    FROM unnest($1::text[]) AS signatures(name) JOIN pg_proc p ON p.oid=to_regprocedure(name)`,
      [xlsxReceiptCodecFunctions],
    )
  ).rows;
  assert.equal(
    functions.length,
    xlsxReceiptCodecFunctions.length,
    "Incomplete XLSX codec",
  );
  for (const fn of functions) {
    assert.equal(fn.prosecdef, false);
    assert.equal(fn.proisstrict, true);
    assert.equal(fn.provolatile, "i");
    assert.deepEqual(fn.proconfig, ["search_path=pg_catalog"]);
    assert.equal(fn.owner_only, true);
    if (owner !== undefined) assert.equal(fn.owner, owner);
  }
  const effective = (
    await pool.query(
      `SELECT count(*)::int AS n FROM unnest($1::text[]) r(role),
    unnest($2::oid[]) f(id) WHERE has_function_privilege(role,id,'EXECUTE')`,
      [roles, functions.map((fn) => fn.oid)],
    )
  ).rows[0];
  assert.equal(effective.n, 0, "Unexpected effective XLSX codec access");

  const check = async (kind, expected, ...values) => {
    const { rows } = await pool.query(
      sql[kind],
      values.map((value) => JSON.stringify(value)),
    );
    assert.deepEqual(rows, [{ digest: expected }], `XLSX ${kind} hash drift`);
  };
  const first = captureXlsxPreviewRequest(scope, workbook);
  const preview = genesis(first.request);
  const command = select(preview, [1, 3]);
  const checkPreview = async (context, rowOrdinals) => {
    await check("context", hashXlsxPreviewContext(context), context);
    if (rowOrdinals) {
      const chosen = select(context, rowOrdinals);
      await check(
        "selection",
        hashXlsxReviewedSelection(chosen, context),
        chosen,
        context,
      );
    }
  };
  await check("request", first.requestSha256, first.request);
  await checkPreview(preview, [1, 3]);
  if (!exhaustive)
    return { ownerOnly: true, requestContextSelectionParity: true };

  const unicode = captureXlsxPreviewRequest(
    {
      ...scope,
      customerId: "00000000-0000-0000-0000-000000000000",
      sourceId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      subject: '\ufeff"\\\b\f\n\r\t\u0001\u2028\u2029 e\u0301 🧪',
      sheet: "🧪".repeat(15) + '"',
      configRevision: 2147483647,
      mappingRevision: 1,
      parserContract: "portable-v1",
    },
    Buffer.alloc(1048576),
  );
  const subjectBoundary = captureXlsxPreviewRequest(
    { ...scope, subject: "🧪".repeat(128) },
    workbook,
  );
  await check("request", unicode.requestSha256, unicode.request);
  await check(
    "request",
    subjectBoundary.requestSha256,
    subjectBoundary.request,
  );
  const scaledRevision = JSON.stringify(first.request).replace(
    '"configRevision":4',
    '"configRevision":4.00',
  );
  assert.deepEqual((await pool.query(sql.request, [scaledRevision])).rows, [
    { digest: first.requestSha256 },
  ]);
  await checkPreview({
    ...genesis(unicode.request),
    baseline: retained,
    outcomes: [],
  });
  const maximum = {
    ...genesis(unicode.request),
    baseline: retained,
    projectIds: Array.from({ length: 100 }, (_, i) => id(i + 100)),
    outcomes: Array.from({ length: 1000 }, (_, i) =>
      accepted(i + 1, id(100 + (i % 100))),
    ),
  };
  await checkPreview(
    maximum,
    maximum.outcomes.map(({ ordinal }) => ordinal),
  );
  const nonePreview = { ...preview, outcomes: [accepted(1), invalid, none] };
  await checkPreview(nonePreview, [1]);

  const invalidRequest = [
    null,
    [],
    { ...first.request, extra: true },
    { ...first.request, subject: "\ufeff\u00a0\t" },
    { ...first.request, subject: "🧪".repeat(129) },
    { ...first.request, sheet: "🧪".repeat(16) },
    { ...first.request, sheet: "invalid_x00Ff_" },
    { ...first.request, sheet: "invalid\\sheet" },
    { ...first.request, commandKey: "two words" },
    { ...first.request, configRevision: 4.25 },
    { ...first.request, workbookBytes: "6" },
    { ...first.request, parserContract: "legacy" },
  ];
  const invalidContext = [
    null,
    [],
    { ...preview, projectIds: preview.projectIds.toReversed() },
    { ...preview, projectIds: [id(4), id(4)] },
    {
      ...preview,
      baseline: { ...retained, receiptId: preview.previewReceiptId },
    },
    { ...preview, baseline: { kind: "GENESIS", receiptId: null } },
    { ...preview, outcomes: [invalid] },
    { ...preview, outcomes: [accepted(1, id(6))] },
    { ...preview, outcomes: [{ ...accepted(1), keySha256: null }] },
    { ...preview, outcomes: [accepted(1), { ...accepted(1), ordinal: 2 }] },
    {
      ...preview,
      outcomes: [
        accepted(1),
        { ...invalid, errorCodes: ["INVALID_INPUT", "INVALID_INPUT"] },
      ],
    },
    {
      ...preview,
      outcomes: [accepted(1), { ...invalid, errorCodes: ["UNKNOWN"] }],
    },
    { ...preview, outcomes: [accepted(1), { ...invalid, record: undefined }] },
    {
      ...preview,
      outcomes: [accepted(1), { ...invalid, projectId: undefined }],
    },
    { ...preview, outcomes: [accepted(1), invalid, { ...none, record }] },
    { ...maximum, outcomes: [...maximum.outcomes, accepted(1001)] },
    { ...maximum, projectIds: [...maximum.projectIds, id(200)] },
  ];
  const invalidSelection = [
    null,
    [],
    { ...command, extra: true },
    { ...command, customerId: id(2) },
    { ...command, previewContextSha256: "0".repeat(64) },
    { ...command, rowOrdinals: [] },
    { ...command, rowOrdinals: [3, 1] },
    { ...command, rowOrdinals: [1, 1] },
    { ...command, rowOrdinals: [1, 2] },
    { ...command, rowOrdinals: [4] },
    { ...command, rowOrdinals: ["1"] },
    { ...command, rowOrdinals: [1.25] },
  ];
  for (const value of invalidRequest) await check("request", null, value);
  for (const value of invalidContext) {
    assert.throws(() => hashXlsxPreviewContext(value));
    await check("context", null, value);
  }
  for (const value of invalidSelection) {
    assert.throws(() => hashXlsxReviewedSelection(value, preview));
    await check("selection", null, value, preview);
  }
  await check("selection", null, select(nonePreview, [3]), nonePreview);
  return {
    ownerOnly: true,
    requestContextSelectionParity: true,
    maxProjects: 100,
    maxOutcomesAndSelection: 1000,
    denialVectors:
      invalidRequest.length +
      invalidContext.length +
      invalidSelection.length +
      1,
  };
}
