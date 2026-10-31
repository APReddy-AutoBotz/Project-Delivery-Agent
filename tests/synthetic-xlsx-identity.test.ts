import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { syntheticXlsxPreviewIdentity, syntheticXlsxSelectionIdentity } from "../packages/domain/src/synthetic-xlsx-identity.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const sourceId = "10000000-0000-4000-8000-000000000002";
const parentReceiptId = "10000000-0000-4000-8000-000000000003";
const preview = () => ({ customerId, sourceId, workbookDigest: "a".repeat(64), sheet: 'S"\\\né😀',
  parserContract: "synthetic-v1", configRevision: 1, mappingRevision: 2, baseline: { kind: "ABSENT" } });
const selection = () => ({ customerId, sourceId, parentReceiptId, previewDigest: "b".repeat(64), rowOrdinals: [1, 2, 1000] });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("synthetic XLSX identity bytes", () => {
  it("matches independent literal UTF-8 and SHA-256 vectors", () => {
    const p = syntheticXlsxPreviewIdentity(preview()), s = syntheticXlsxSelectionIdentity(selection());
    expect(hex(p)).toBe("5b22706461612e73796e7468657469632e786c73782e707265766965772e7631222c2231303030303030302d303030302d343030302d383030302d303030303030303030303031222c2231303030303030302d303030302d343030302d383030302d303030303030303030303032222c2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22535c225c5c5c6ec3a9f09f9880222c2273796e7468657469632d7631222c312c322c5b22414253454e54225d5d");
    expect(hash(p)).toBe("c44a6bad613a449be7fb7294f796f011ab6dced5d4ce6120160716cb7a3d4223");
    expect(hex(s)).toBe("5b22706461612e73796e7468657469632e786c73782e73656c656374696f6e2e7631222c2231303030303030302d303030302d343030302d383030302d303030303030303030303031222c2231303030303030302d303030302d343030302d383030302d303030303030303030303032222c2231303030303030302d303030302d343030302d383030302d303030303030303030303033222c2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c5b312c322c313030305d5d");
    expect(hash(s)).toBe("2a8bc18e8c4b7cef3368a5037d94b891848435ab6f1cc276cd666d3e07d21c4d");
    const present = syntheticXlsxPreviewIdentity({ ...preview(), baseline: { kind: "PRESENT", digest: "0".repeat(64) } });
    expect(hex(present)).toBe("5b22706461612e73796e7468657469632e786c73782e707265766965772e7631222c2231303030303030302d303030302d343030302d383030302d303030303030303030303031222c2231303030303030302d303030302d343030302d383030302d303030303030303030303032222c2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c22535c225c5c5c6ec3a9f09f9880222c2273796e7468657469632d7631222c312c322c5b2250524553454e54222c2230303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030225d5d");
    expect(hash(present)).toBe("9dbb4826b70b396c5c1aba67020cb2e1876f96da5143ccdb8f9c1d13070d3d64");
    expect(present).not.toEqual(syntheticXlsxPreviewIdentity({ ...preview(), baseline: { kind: "PRESENT", digest: "1".repeat(64) } }));
  });

  it("binds every preview and selection field and distinguishes baseline absence", () => {
    const p = preview(), first = hex(syntheticXlsxPreviewIdentity(p));
    const changed = [
      { customerId: parentReceiptId }, { sourceId: parentReceiptId }, { workbookDigest: "b".repeat(64) },
      { sheet: 's"\\\né😀' }, { parserContract: "synthetic-v2" }, { configRevision: 2 }, { mappingRevision: 3 },
      { baseline: { kind: "PRESENT", digest: "0".repeat(64) } },
    ];
    for (const change of changed) expect(hex(syntheticXlsxPreviewIdentity({ ...p, ...change }))).not.toBe(first);
    const s = selection(), initial = hex(syntheticXlsxSelectionIdentity(s));
    for (const change of [{ customerId: parentReceiptId }, { sourceId: parentReceiptId }, { parentReceiptId: sourceId },
      { previewDigest: "c".repeat(64) }, { rowOrdinals: [1, 3, 1000] }])
      expect(hex(syntheticXlsxSelectionIdentity({ ...s, ...change }))).not.toBe(initial);
    expect(hex(syntheticXlsxPreviewIdentity(p))).not.toBe(initial);
    const reordered = { baseline: p.baseline, mappingRevision: p.mappingRevision, configRevision: p.configRevision,
      parserContract: p.parserContract, sheet: p.sheet, workbookDigest: p.workbookDigest, sourceId: p.sourceId, customerId: p.customerId };
    expect(syntheticXlsxPreviewIdentity(reordered)).toEqual(syntheticXlsxPreviewIdentity(p));
  });

  it("preserves exact Unicode and rejects malformed or noncanonical inputs", () => {
    const p = preview();
    expect(syntheticXlsxPreviewIdentity({ ...p, sheet: "é" })).not.toEqual(syntheticXlsxPreviewIdentity({ ...p, sheet: "e\u0301" }));
    for (const change of [{ sheet: "" }, { sheet: "\ud800" }, { sheet: "\0" }, { sheet: "x".repeat(257) },
      { workbookDigest: "A".repeat(64) }, { customerId: customerId.toUpperCase().replace("100", "ABC") },
      { parserContract: "INVALID" }, { parserContract: "x".repeat(129) }, { configRevision: 0 },
      { configRevision: 1.5 }, { configRevision: "1" }, { configRevision: Infinity }, { configRevision: 2_147_483_648 }, { mappingRevision: NaN },
      { baseline: null }, { baseline: {} }, { baseline: { kind: "ABSENT", digest: "0".repeat(64) } },
      { baseline: { kind: "PRESENT" } }, { extra: true }])
      expect(() => syntheticXlsxPreviewIdentity({ ...p, ...change })).toThrow("INVALID_INPUT");
    expect(syntheticXlsxPreviewIdentity({ ...p, sheet: "x".repeat(256), configRevision: 2_147_483_647 })).toBeInstanceOf(Uint8Array);
  });

  it("requires bounded, ordered and unique one-based data-row ordinals", () => {
    const s = selection();
    for (const rows of [[], [0], [1001], [1, 1], [2, 1], [1.5], Array.from({ length: 1001 }, (_, i) => i + 1)])
      expect(() => syntheticXlsxSelectionIdentity({ ...s, rowOrdinals: rows })).toThrow("INVALID_INPUT");
    expect(syntheticXlsxSelectionIdentity({ ...s, rowOrdinals: Array.from({ length: 1000 }, (_, i) => i + 1) })).toBeInstanceOf(Uint8Array);
    expect(() => syntheticXlsxSelectionIdentity({ ...s, parentReceiptId: sourceId.toUpperCase().replace("100", "ABC") })).toThrow("INVALID_INPUT");
    expect(() => syntheticXlsxSelectionIdentity({ ...s, previewDigest: "B".repeat(64) })).toThrow("INVALID_INPUT");
    const bytes = syntheticXlsxSelectionIdentity(s), original = hex(bytes);
    s.rowOrdinals[0] = 3;
    expect(hex(bytes)).toBe(original);
    bytes[0] = 0;
    expect(hex(syntheticXlsxSelectionIdentity(selection()))).toBe(original);
  });

  it("rejects accessors, holes, symbols and prototypes without invoking getters", () => {
    let calls = 0;
    const root = preview(); Object.defineProperty(root, "sheet", { get() { calls++; return "secret"; } });
    const nested = preview(); Object.defineProperty(nested.baseline, "kind", { get() { calls++; return "ABSENT"; } });
    const array = selection(); Object.defineProperty(array.rowOrdinals, "0", { get() { calls++; return 1; } });
    const sparse = selection(); delete (sparse.rowOrdinals as any)[0];
    const extra = selection(); Object.defineProperty(extra.rowOrdinals, Symbol("extra"), { value: true });
    const inherited = Object.assign(Object.create({ x: 1 }), preview());
    for (const value of [root, nested, inherited]) expect(() => syntheticXlsxPreviewIdentity(value)).toThrow("INVALID_INPUT");
    for (const value of [array, sparse, extra]) expect(() => syntheticXlsxSelectionIdentity(value)).toThrow("INVALID_INPUT");
    expect(calls).toBe(0);
  });
});
