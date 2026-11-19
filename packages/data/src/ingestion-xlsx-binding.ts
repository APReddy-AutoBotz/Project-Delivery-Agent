import { createHash } from "node:crypto";
import { types } from "node:util";
import {
  IngestionPersistenceError,
  ingestionArray,
  ingestionCommandKeySchema,
  ingestionReviewedImportRequestSchema,
  ingestionRowOperationSchema,
  ingestionRowStateSchema,
  ingestionSafeErrorSchema,
  ingestionText,
  projectFactIdSchema,
  projectFactSubjectSchema,
} from "@pdaa/domain";
import { z } from "zod";

// FR-CON-006/007: immutable receipt inputs only. The repository must establish
// source scope, locked comparison state and retained content separately.
const maxWorkbookBytes = 1_048_576;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);
const id = projectFactIdSchema;
const subject = projectFactSubjectSchema;
const sheet = ingestionText(31).refine(
  (value) => !/[\\/*?:[\]]|_x[0-9a-f]{4}_/iu.test(value),
);
// Recognition of a historic profile does not authorize a new decode.
const parserContract = z.enum(["portable-v1", "excel-text-v1"]);
const scopeFields = {
  customerId: id,
  sourceId: id,
  subject,
  commandKey: ingestionCommandKeySchema,
};
const requestScope = z.strictObject({
  ...scopeFields,
  sheet,
  parserContract,
  configRevision: revision,
  mappingRevision: revision,
});
const requestBinding = requestScope.extend({
  workbookSha256: digest,
  workbookBytes: z.number().int().min(1).max(maxWorkbookBytes),
});
const baseline = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("GENESIS") }),
  z.strictObject({
    kind: z.literal("RETAINED"),
    receiptId: id,
    revision,
    stateSha256: digest,
  }),
]);
const record = z.strictObject({
  id,
  revisionId: id,
  sourceContentSha256: digest,
  projectionId: id,
  proposalSha256: digest,
});
const outcome = z.strictObject({
  ordinal: z.number().int().min(1).max(1000),
  state: ingestionRowStateSchema,
  operation: ingestionRowOperationSchema,
  errorCodes: ingestionArray(ingestionSafeErrorSchema, 16),
  projectId: id.nullable(),
  keySha256: digest.nullable(),
  record: record.nullable(),
});
const previewContext = z.strictObject({
  request: requestBinding,
  previewReceiptId: id,
  baseline,
  projectIds: ingestionArray(id, 100),
  outcomes: ingestionArray(outcome, 1000),
});
const selection = z.strictObject({
  ...scopeFields,
  previewReceiptId: id,
  previewContextSha256: digest,
  rowOrdinals: ingestionReviewedImportRequestSchema.shape.rowOrdinals,
});

function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
  code: "INVALID_REQUEST" | "INVALID_PREVIEW",
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new IngestionPersistenceError(code);
  return result.data;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
const emptyProposalSha256 = sha256("[]");

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
  typedArray,
  "byteLength",
)!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(
  typedArray,
  "byteOffset",
)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;

function copyWithOwnBacking(input: Uint8Array): Buffer {
  // Small pooled Buffer copies can expose the same backing allocation.
  const owned = Buffer.alloc(input.byteLength);
  owned.set(input);
  return owned;
}

function copyBoundedWorkbook(input: unknown): Buffer {
  try {
    if (!Buffer.isBuffer(input)) throw new Error();
    const length: number = byteLength.call(input);
    const backing: ArrayBufferLike = buffer.call(input);
    if (
      length < 1 ||
      length > maxWorkbookBytes ||
      types.isSharedArrayBuffer(backing)
    ) {
      throw new Error();
    }
    return copyWithOwnBacking(
      new Uint8Array(backing, byteOffset.call(input), length),
    );
  } catch {
    throw new IngestionPersistenceError("INVALID_REQUEST");
  }
}

function requestHash(binding: z.infer<typeof requestBinding>): string {
  return sha256(
    JSON.stringify([
      "pdaa.xlsx.preview-request.v1",
      binding.customerId,
      binding.sourceId,
      binding.subject,
      binding.commandKey,
      binding.configRevision,
      binding.mappingRevision,
      binding.sheet,
      binding.parserContract,
      binding.workbookBytes,
      binding.workbookSha256,
    ]),
  );
}

// The decoder receives a fresh copy of the same bytes owned by this closure.
// Callers must authorize and reserve capacity before entering this function.
export function captureXlsxPreviewRequest(
  scopeInput: unknown,
  originalBytes: unknown,
) {
  const scope = parse(requestScope, scopeInput, "INVALID_REQUEST");
  const original = copyBoundedWorkbook(originalBytes);
  const request = Object.freeze({
    ...scope,
    workbookSha256: sha256(original),
    workbookBytes: original.length,
  });
  return Object.freeze({
    request,
    requestSha256: requestHash(request),
    copyForDecoder: () => copyWithOwnBacking(original),
  });
}

function checkedContext(input: unknown): z.infer<typeof previewContext> {
  const context = parse(previewContext, input, "INVALID_PREVIEW");
  const { projectIds, outcomes } = context;
  const invalid = () => {
    throw new IngestionPersistenceError("INVALID_PREVIEW");
  };
  if (
    !projectIds.length ||
    projectIds.some((project, i) => i > 0 && projectIds[i - 1]! >= project)
  ) {
    invalid();
  }
  if (
    context.baseline.kind === "RETAINED" &&
    context.baseline.receiptId === context.previewReceiptId
  ) {
    invalid();
  }
  const projects = new Set(projectIds);
  const acceptedKeys = new Set<string>();
  for (const [index, row] of outcomes.entries()) {
    if (
      row.ordinal !== index + 1 ||
      (row.projectId !== null && !projects.has(row.projectId)) ||
      (row.keySha256 !== null && row.projectId === null) ||
      new Set(row.errorCodes).size !== row.errorCodes.length
    )
      invalid();
    if (row.state === "ACCEPTED") {
      if (
        row.errorCodes.length !== 0 ||
        row.keySha256 === null ||
        row.record === null ||
        (row.operation === "NONE" &&
          row.record.proposalSha256 !== emptyProposalSha256) ||
        acceptedKeys.has(row.keySha256)
      )
        invalid();
      acceptedKeys.add(row.keySha256!);
    } else if (
      row.operation !== "NONE" ||
      row.errorCodes.length === 0 ||
      row.record !== null
    ) {
      invalid();
    }
  }
  return context;
}

function contextHash(context: z.infer<typeof previewContext>): string {
  const { baseline: previous, outcomes } = context;
  return sha256(
    JSON.stringify([
      "pdaa.xlsx.preview-context.v1",
      context.previewReceiptId,
      requestHash(context.request),
      previous.kind === "GENESIS"
        ? ["GENESIS"]
        : [
            "RETAINED",
            previous.receiptId,
            previous.revision,
            previous.stateSha256,
          ],
      context.projectIds,
      outcomes.map(
        ({
          ordinal,
          state,
          operation,
          errorCodes,
          projectId,
          keySha256,
          record,
        }) => [
          ordinal,
          state,
          operation,
          errorCodes,
          projectId,
          keySha256,
          record === null
            ? null
            : [
                record.id,
                record.revisionId,
                record.sourceContentSha256,
                record.projectionId,
                record.proposalSha256,
              ],
        ],
      ),
    ]),
  );
}

export function hashXlsxPreviewContext(input: unknown): string {
  return contextHash(checkedContext(input));
}

// Both values are trusted repository inputs. New saves must separately prove
// current grants and live content for every selected ordinal under lock.
export function hashXlsxReviewedSelection(
  input: unknown,
  retainedPreview: unknown,
): string {
  const command = parse(selection, input, "INVALID_REQUEST");
  const parent = checkedContext(retainedPreview);
  if (
    parent.request.customerId !== command.customerId ||
    parent.request.sourceId !== command.sourceId ||
    parent.previewReceiptId !== command.previewReceiptId ||
    contextHash(parent) !== command.previewContextSha256 ||
    command.rowOrdinals.some((ordinal) => {
      const row = parent.outcomes[ordinal - 1];
      return row?.state !== "ACCEPTED" || row.operation === "NONE";
    })
  ) {
    throw new IngestionPersistenceError("INVALID_PREVIEW");
  }
  return sha256(
    JSON.stringify([
      "pdaa.xlsx.reviewed-selection.v1",
      command.customerId,
      command.sourceId,
      command.subject,
      command.commandKey,
      command.previewReceiptId,
      command.previewContextSha256,
      command.rowOrdinals,
    ]),
  );
}
