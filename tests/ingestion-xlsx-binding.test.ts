import { describe, expect, it } from "vitest";
import {
  captureXlsxPreviewRequest,
  hashXlsxPreviewContext,
  hashXlsxReviewedSelection,
} from "../packages/data/src/ingestion-xlsx-binding.js";

const id = (value: number) =>
  "10000000-0000-4000-8000-" + String(value).padStart(12, "0");
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
const outcomes = [
  {
    ordinal: 1,
    state: "ACCEPTED",
    operation: "CREATE",
    errorCodes: [],
    projectId: id(4),
    keySha256: "1".repeat(64),
    record: {
      id: id(8),
      revisionId: id(9),
      sourceContentSha256: "a".repeat(64),
      projectionId: id(10),
      proposalSha256: "b".repeat(64),
    },
  },
  {
    ordinal: 2,
    state: "INVALID",
    operation: "NONE",
    errorCodes: ["INVALID_KEY"],
    projectId: id(4),
    keySha256: null,
    record: null,
  },
  {
    ordinal: 3,
    state: "ACCEPTED",
    operation: "UNCHANGED",
    errorCodes: [],
    projectId: id(5),
    keySha256: "3".repeat(64),
    record: {
      id: id(11),
      revisionId: id(12),
      sourceContentSha256: "c".repeat(64),
      projectionId: id(13),
      proposalSha256: "d".repeat(64),
    },
  },
];

function preview() {
  return {
    request: captureXlsxPreviewRequest(scope, workbook).request,
    previewReceiptId: id(3),
    baseline: { kind: "GENESIS" },
    projectIds: [id(4), id(5)],
    outcomes: structuredClone(outcomes),
  };
}

function selection(parent = preview()) {
  return {
    customerId: scope.customerId,
    sourceId: scope.sourceId,
    subject: "reviewer",
    commandKey: "review-1",
    previewReceiptId: parent.previewReceiptId,
    previewContextSha256: hashXlsxPreviewContext(parent),
    rowOrdinals: [1, 3],
  };
}

const invalidRequest = /INVALID_REQUEST/u;
const invalidPreview = /INVALID_PREVIEW/u;

describe("FR-CON-006/007 original XLSX workbook and reviewed receipt binding", () => {
  it("matches independently encoded UTF-8 request, context and selection vectors", () => {
    const captured = captureXlsxPreviewRequest(scope, workbook);
    expect(captured.request.workbookSha256).toBe(
      "32c5298373643a70f302359fcc0d482269cfe8feedfa635f874bd546a71be65c",
    );
    expect(captured.requestSha256).toBe(
      "c4086a218a35d09492ad6201eb68603cfd3977883cb63cd6aa00c6cdfd146dea",
    );
    const parent = preview();
    const command = selection(parent);
    expect(command.previewContextSha256).toBe(
      "ce5d07acd19946f88bf7e05100bbbc325d5e4ee125e865a8b0461f6f93be6f77",
    );
    expect(
      hashXlsxReviewedSelection(command, JSON.parse(JSON.stringify(parent))),
    ).toBe("625b77b05546ddd046eebd3c61d89a61eeb8f8f5982d85504b720ef158a576d5");
  });

  it("owns exactly the sliced bytes and keeps decoder copies detached", () => {
    const input = Buffer.concat([
      Buffer.from("prefix"),
      workbook,
      Buffer.from("suffix"),
    ]);
    const view = input.subarray(6, 6 + workbook.length);
    Object.defineProperty(view, "buffer", {
      get: () => {
        throw new Error("getter");
      },
    });
    const captured = captureXlsxPreviewRequest(scope, view);
    const first = captured.copyForDecoder();
    const second = captured.copyForDecoder();
    expect(first.byteOffset).toBe(0);
    expect(first.buffer.byteLength).toBe(workbook.length);
    expect(first.buffer).not.toBe(input.buffer);
    expect(first.buffer).not.toBe(second.buffer);
    input.fill(0);
    new Uint8Array(first.buffer).fill(255);
    expect(captured.request.workbookBytes).toBe(workbook.length);
    expect(second).toEqual(workbook);
    expect(captured.copyForDecoder()).toEqual(workbook);
    expect(Object.isFrozen(captured.request)).toBe(true);
  });

  it("rejects shared memory and buffers outside the admission envelope", () => {
    expect(
      captureXlsxPreviewRequest(scope, Buffer.alloc(1_048_576)).request
        .workbookBytes,
    ).toBe(1_048_576);
    for (const input of [
      Buffer.alloc(0),
      Buffer.alloc(1_048_577),
      Buffer.from(new SharedArrayBuffer(16)),
      new Uint8Array(workbook),
    ])
      expect(() => captureXlsxPreviewRequest(scope, input)).toThrow(
        invalidRequest,
      );
    const detached = Buffer.alloc(16);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => captureXlsxPreviewRequest(scope, detached)).toThrow(
      invalidRequest,
    );
  });

  it.each([
    { sheet: "Portfolio /" },
    { sheet: "Portfolio_x0001_" },
    { sheet: "a".repeat(32) },
    { parserContract: "next-unrecognized-version" },
    { workbookSha256: "0".repeat(64) },
  ])("rejects an invalid or asserted input binding %o", (change) => {
    expect(() =>
      captureXlsxPreviewRequest({ ...scope, ...change }, workbook),
    ).toThrow(invalidRequest);
  });

  it("binds exact scope, profile, revisions and raw workbook bytes to the command", () => {
    const original = captureXlsxPreviewRequest(scope, workbook).requestSha256;
    for (const change of [
      { customerId: id(6) },
      { sourceId: id(6) },
      { subject: "pm A" },
      { commandKey: "request-2" },
      { sheet: "portfolio Δ" },
      { parserContract: "portable-v1" },
      { configRevision: 5 },
      { mappingRevision: 8 },
    ])
      expect(
        captureXlsxPreviewRequest({ ...scope, ...change }, workbook)
          .requestSha256,
      ).not.toBe(original);
    const changed = Buffer.from(workbook);
    changed[5] = 0;
    expect(captureXlsxPreviewRequest(scope, changed).requestSha256).not.toBe(
      original,
    );
  });

  it("keeps the original command fingerprint stable as the baseline advances", () => {
    const captured = captureXlsxPreviewRequest(scope, workbook);
    const genesis = preview();
    const previous = {
      kind: "RETAINED",
      receiptId: id(6),
      revision: 1,
      stateSha256: "0".repeat(64),
    };
    const advanced = { ...genesis, baseline: previous };
    expect(captureXlsxPreviewRequest(scope, workbook).requestSha256).toBe(
      captured.requestSha256,
    );
    expect(hashXlsxPreviewContext(advanced)).not.toBe(
      hashXlsxPreviewContext(genesis),
    );
    expect(
      hashXlsxPreviewContext({
        ...advanced,
        baseline: { ...previous, revision: 2 },
      }),
    ).not.toBe(hashXlsxPreviewContext(advanced));
    expect(() =>
      hashXlsxPreviewContext({
        ...genesis,
        baseline: { ...previous, receiptId: genesis.previewReceiptId },
      }),
    ).toThrow(invalidPreview);
  });

  it("binds the complete ordered scope and original row metadata", () => {
    const parent = preview();
    const hash = hashXlsxPreviewContext(parent);
    const changedProjection = structuredClone(parent);
    changedProjection.outcomes[0]!.record!.projectionId = id(14);
    expect(hashXlsxPreviewContext(changedProjection)).not.toBe(hash);
    expect(
      hashXlsxPreviewContext({ ...parent, previewReceiptId: id(14) }),
    ).not.toBe(hash);
    expect(
      hashXlsxPreviewContext({
        ...parent,
        projectIds: [...parent.projectIds, id(6)],
      }),
    ).not.toBe(hash);
    expect(
      hashXlsxPreviewContext({
        ...parent,
        outcomes: parent.outcomes.slice(0, 2),
      }),
    ).not.toBe(hash);
    expect(() =>
      hashXlsxPreviewContext({
        ...parent,
        projectIds: [...parent.projectIds].reverse(),
      }),
    ).toThrow(invalidPreview);
    expect(() =>
      hashXlsxPreviewContext({
        ...parent,
        outcomes: [...parent.outcomes].reverse(),
      }),
    ).toThrow(invalidPreview);
  });

  it("keeps a header-only preview but bounds and validates the full outcome list", () => {
    const parent = preview();
    const base = {
      ...parent.outcomes[1],
      state: "INVALID",
      errorCodes: ["INVALID_KEY"],
    };
    const bounded = Array.from({ length: 1000 }, (_, index) => ({
      ...base,
      ordinal: index + 1,
    }));
    expect(hashXlsxPreviewContext({ ...parent, outcomes: [] })).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(hashXlsxPreviewContext({ ...parent, outcomes: bounded })).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(() =>
      hashXlsxPreviewContext({ ...parent, outcomes: [...bounded, base] }),
    ).toThrow(invalidPreview);
    expect(() =>
      hashXlsxPreviewContext({
        ...parent,
        outcomes: [{ ...base, ordinal: 1, errorCodes: [] }],
      }),
    ).toThrow(invalidPreview);
    expect(() =>
      hashXlsxPreviewContext({
        ...parent,
        outcomes: [
          { ...base, ordinal: 1, errorCodes: ["INVALID_KEY", "INVALID_KEY"] },
        ],
      }),
    ).toThrow(invalidPreview);
  });

  it.each([
    { ordinal: 2 },
    { operation: "NONE" },
    { projectId: id(17) },
    { projectId: null },
    { record: null },
    { contentAvailable: true },
    { errorCodes: ["INVALID_INPUT"] },
    { keySha256: "3".repeat(64) },
  ])(
    "rejects malformed, foreign or ambiguous accepted metadata %o",
    (change) => {
      const parent = preview();
      expect(() =>
        hashXlsxPreviewContext({
          ...parent,
          outcomes: [
            { ...parent.outcomes[0], ...change },
            ...parent.outcomes.slice(1),
          ],
        }),
      ).toThrow(invalidPreview);
    },
  );

  it("pins the exact parent proof, reviewer and sorted eligible selection", () => {
    const parent = preview();
    const original = selection(parent);
    const hash = hashXlsxReviewedSelection(original, parent);
    expect(
      hashXlsxReviewedSelection(
        { ...original, subject: "another reviewer" },
        parent,
      ),
    ).not.toBe(hash);
    expect(
      hashXlsxReviewedSelection({ ...original, rowOrdinals: [3] }, parent),
    ).not.toBe(hash);
    for (const change of [
      { previewReceiptId: id(7) },
      { previewContextSha256: "0".repeat(64) },
      { customerId: id(7) },
      { sourceId: id(7) },
      { rowOrdinals: [2] },
      { rowOrdinals: [4] },
    ])
      expect(() =>
        hashXlsxReviewedSelection({ ...original, ...change }, parent),
      ).toThrow(invalidPreview);
    for (const ordinals of [[], [3, 1], [1, 1], [0], [1001]]) {
      expect(() =>
        hashXlsxReviewedSelection(
          { ...original, rowOrdinals: ordinals },
          parent,
        ),
      ).toThrow(invalidRequest);
    }
  });
});
