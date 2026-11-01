import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { simulateSyntheticXlsxSelection, syntheticXlsxManifestBytes } from "../packages/domain/src/synthetic-xlsx-selection.js";

const scope = { customerId: "11111111-1111-4111-8111-111111111111", sourceId: "22222222-2222-4222-8222-222222222222",
  sheet: "Sheet Ω", configRevision: 1, mappingRevision: 2, parserContract: "synthetic.v1",
  parentId: "33333333-3333-4333-8333-333333333333" };
const project = "44444444-4444-4444-8444-444444444444";
const one = "a".repeat(64), two = "b".repeat(64);
const accepted = (ordinal = 1, operation = "CREATE") => ({ ordinal, state: "ACCEPTED", operation, projectId: project,
  recordKey: `row-${ordinal}`, errors: [], contentAvailable: true,
  proposals: [{ factType: "summary", value: { type: "text", value: "é\n😀" } }] });
const invalidRow = (ordinal = 2) => ({ ordinal, state: "INVALID", operation: "NONE", projectId: null,
  recordKey: null, errors: ["INVALID_INPUT"], contentAvailable: false, proposals: [] });
const manifest = () => ({ ...scope, workbookDigest: one, baseline: { kind: "PRESENT", digest: two },
  projects: [project], outcomes: [accepted(), invalidRow()] });
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const request = (value: unknown, ordinals = [1]) => ({ ...scope, manifestDigest: hash(syntheticXlsxManifestBytes(value)), ordinals });

it("encodes the full asserted manifest, computes its digest and returns only selected synthetic proposals", async () => {
  const input = manifest(), encoded = syntheticXlsxManifestBytes(input);
  const expected = JSON.stringify(["pdaa.synthetic.xlsx.manifest.v1", ...Object.values(scope), one, ["PRESENT", two], [project], [
    [1, "ACCEPTED", "CREATE", project, "row-1", [], true, [["summary", ["text", "é\n😀"]]]],
    [2, "INVALID", "NONE", null, null, ["INVALID_INPUT"], false, []],
  ]]);
  expect(Buffer.from(encoded).toString("utf8")).toBe(expected);
  expect(hash(encoded)).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
  expect(Buffer.from(encoded).toString("hex")).toBe("5b22706461612e73796e7468657469632e786c73782e6d616e69666573742e7631222c2231313131313131312d313131312d343131312d383131312d313131313131313131313131222c2232323232323232322d323232322d343232322d383232322d323232323232323232323232222c22536865657420cea9222c312c322c2273796e7468657469632e7631222c2233333333333333332d333333332d343333332d383333332d333333333333333333333333222c2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c5b2250524553454e54222c2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262225d2c5b2234343434343434342d343434342d343434342d383434342d343434343434343434343434225d2c5b5b312c224143434550544544222c22435245415445222c2234343434343434342d343434342d343434342d383434342d343434343434343434343434222c22726f772d31222c5b5d2c747275652c5b5b2273756d6d617279222c5b2274657874222c22c3a95c6ef09f9880225d5d5d5d2c5b322c22494e56414c4944222c224e4f4e45222c6e756c6c2c6e756c6c2c5b22494e56414c49445f494e505554225d2c66616c73652c5b5d5d5d5d");
  expect(hash(encoded)).toBe("6bf27abe4ec24f20d2f06116ce8fd153301ab075a2cf537d5e69530ab89c1f30");
  expect(await simulateSyntheticXlsxSelection(input, request(input))).toEqual([{ ordinal: 1, projectId: project,
    recordKey: "row-1", operation: "CREATE", proposals: [{ factType: "summary", value: { type: "text", value: "é\n😀" } }] }]);
});

it("binds all outcomes and context, including unselected rows and distinct baseline tags", () => {
  const input = manifest(), original = hash(syntheticXlsxManifestBytes(input));
  const variants = [
    { ...input, workbookDigest: two }, { ...input, baseline: { kind: "ABSENT" } },
    { ...input, sheet: "Other" }, { ...input, configRevision: 2 }, { ...input, mappingRevision: 3 },
    { ...input, parserContract: "synthetic.v2" }, { ...input, parentId: project },
    { ...input, outcomes: [accepted(), { ...invalidRow(), errors: ["INVALID_KEY"] }] },
    { ...input, outcomes: [{ ...accepted(), proposals: [{ factType: "summary", value: { type: "text", value: "other" } }] }, invalidRow()] },
  ];
  for (const value of variants) expect(hash(syntheticXlsxManifestBytes(value))).not.toBe(original);
});

it.each([
  [{ type: "text", value: "before" }, { type: "text", value: "after" }],
  [{ type: "number", value: 1e100 }, { type: "number", value: 1e101 }],
  [{ type: "boolean", value: true }, { type: "boolean", value: false }],
  [{ type: "date", value: "2026-01-02" }, { type: "date", value: "2026-01-03" }],
  [{ type: "empty", value: null }, { type: "text", value: "" }],
])("binds each supported asserted proposal value", (before, after) => {
  const withValue = (value: unknown) => ({ ...manifest(), outcomes: [{ ...accepted(), proposals: [{ factType: "sample", value }] }, invalidRow()] });
  expect(hash(syntheticXlsxManifestBytes(withValue(before)))).not.toBe(hash(syntheticXlsxManifestBytes(withValue(after))));
});

it("fails the entire selection for mismatched context, digest, ordinals or ineligible content", async () => {
  const input = manifest(), valid = request(input);
  for (const selection of [
    { ...valid, customerId: project }, { ...valid, sourceId: project }, { ...valid, parentId: project },
    { ...valid, sheet: "Other" }, { ...valid, mappingRevision: 3 }, { ...valid, configRevision: 2 },
    { ...valid, parserContract: "synthetic.v2" }, { ...valid, manifestDigest: one },
    { ...valid, ordinals: [] }, { ...valid, ordinals: [1, 1] }, { ...valid, ordinals: [2, 1] },
    { ...valid, ordinals: [1, 2] }, { ...valid, ordinals: [3] },
  ]) await expect(simulateSyntheticXlsxSelection(input, selection)).rejects.toThrow(/^INVALID_INPUT$/);
  const unavailable = { ...input, outcomes: [{ ...accepted(), contentAvailable: false, proposals: [] }, invalidRow()] };
  await expect(simulateSyntheticXlsxSelection(unavailable, request(unavailable))).rejects.toThrow(/^INVALID_INPUT$/);
  const changedUnselected = { ...input, outcomes: [accepted(), { ...invalidRow(), errors: ["INVALID_KEY"] }] };
  await expect(simulateSyntheticXlsxSelection(changedUnselected, valid)).rejects.toThrow(/^INVALID_INPUT$/);
});

it("accepts unchanged with empty proposals while rejecting malformed or mixed-scope manifests", async () => {
  const input = { ...manifest(), outcomes: [{ ...accepted(1, "UNCHANGED"), proposals: [] }, invalidRow()] };
  expect(await simulateSyntheticXlsxSelection(input, request(input))).toEqual([{ ordinal: 1, projectId: project, recordKey: "row-1", operation: "UNCHANGED", proposals: [] }]);
  for (const bad of [
    { ...input, outcomes: [{ ...accepted(), operation: "NONE" }, invalidRow()] },
    { ...input, outcomes: [accepted(2), invalidRow(1)] },
    { ...input, outcomes: [accepted(), { ...accepted(2), recordKey: "row-1" }] },
    { ...input, outcomes: [{ ...accepted(), projectId: scope.parentId }, invalidRow()] },
    { ...input, outcomes: [{ ...accepted(), errors: ["INVALID_INPUT"] }, invalidRow()] },
    { ...input, outcomes: [{ ...accepted(), contentAvailable: false }, invalidRow()] },
    { ...input, outcomes: [{ ...accepted(), proposals: [{ factType: "n", value: { type: "number", value: -0 } }] }, invalidRow()] },
    { ...input, outcomes: new Array(1) },
  ]) expect(() => syntheticXlsxManifestBytes(bad)).toThrow(/^INVALID_INPUT$/);
});

it("accepts an ordered mixed CREATE, UPDATE and empty UNCHANGED selection", async () => {
  const input = { ...manifest(), outcomes: [accepted(1, "CREATE"), accepted(2, "UPDATE"), { ...accepted(3, "UNCHANGED"), proposals: [] }, invalidRow(4)] };
  const plan = await simulateSyntheticXlsxSelection(input, request(input, [1, 2, 3]));
  expect(plan.map((row) => row.ordinal)).toEqual([1, 2, 3]);
  expect(plan.map((row) => row.operation)).toEqual(["CREATE", "UPDATE", "UNCHANGED"]);
  expect(plan[2]!.proposals).toEqual([]);
  await expect(simulateSyntheticXlsxSelection(input, request(input, [1, 2, 4]))).rejects.toThrow(/^INVALID_INPUT$/);
});

it("rejects nested accessors, symbols, holes and invalid state combinations without exposing values", () => {
  const secret = "sensitive-synthetic-canary";
  const getter = { factType: "summary", get value() { throw new Error(secret); } };
  const hidden = { ...accepted() }; Object.defineProperty(hidden, "recordKey", { value: "row-1", enumerable: false });
  const symbol = { ...accepted(), [Symbol("extra")]: secret };
  const cases = [
    { ...manifest(), outcomes: [{ ...accepted(), proposals: [getter] }] },
    { ...manifest(), outcomes: [hidden] }, { ...manifest(), outcomes: [symbol] },
    { ...manifest(), outcomes: [{ ...accepted(), errors: new Array(1) }] },
    { ...manifest(), outcomes: [{ ...accepted(), proposals: new Array(1) }] },
    { ...manifest(), outcomes: [{ ...invalidRow(1), state: "REVIEW_REQUIRED", errors: [] }] },
    { ...manifest(), projects: [project, project] },
  ];
  for (const value of cases) {
    try { syntheticXlsxManifestBytes(value); throw new Error("Expected rejection"); }
    catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).toContain("INVALID_INPUT"); }
  }
});

it("enforces the exact manifest-byte ceiling with escaped and multibyte text", () => {
  const prefix = '"\\\nΩ😀';
  const make = (ordinal: number, text: string) => ({ ...accepted(ordinal), proposals: [{ factType: "summary", value: { type: "text", value: text } }] });
  let found: { outcomes: ReturnType<typeof make>[]; needed: number; reference: (length: number) => string } | undefined;
  for (let count = 200; count < 260 && !found; count++) {
    const outcomes = Array.from({ length: count }, (_, index) => make(index + 1, prefix + "x".repeat(4096 - prefix.length)));
    const reference = (length: number) => JSON.stringify(["pdaa.synthetic.xlsx.manifest.v1", ...Object.values(scope), one, ["PRESENT", two], [project],
      [...outcomes, make(count + 1, prefix + "x".repeat(length))].map((row) => [row.ordinal, row.state, row.operation, row.projectId,
        row.recordKey, row.errors, row.contentAvailable, row.proposals.map((field) => [field.factType, [field.value.type, field.value.value]])])]);
    const needed = 1_048_576 - Buffer.byteLength(reference(0));
    if (needed >= 0 && needed < 4096 - prefix.length) found = { outcomes, needed, reference };
  }
  expect(found).toBeDefined();
  const { outcomes, needed, reference } = found!;
  const final = (length: number) => ({ ...manifest(), outcomes: [...outcomes, make(outcomes.length + 1, prefix + "x".repeat(length))] });
  const exact = Buffer.from(syntheticXlsxManifestBytes(final(needed)));
  expect(exact.length).toBe(1_048_576);
  expect(exact.toString("utf8")).toBe(reference(needed));
  expect(() => syntheticXlsxManifestBytes(final(needed + 1))).toThrow(/^INVALID_INPUT$/);
});

it("bounds dense outcome and asserted project inventories", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => invalidRow(index + 1));
  expect(syntheticXlsxManifestBytes({ ...manifest(), outcomes: rows }).length).toBeGreaterThan(0);
  expect(() => syntheticXlsxManifestBytes({ ...manifest(), outcomes: [...rows, invalidRow(1001)] })).toThrow(/^INVALID_INPUT$/);
  expect(() => syntheticXlsxManifestBytes({ ...manifest(), projects: new Array(101).fill(project) })).toThrow(/^INVALID_INPUT$/);
  expect(() => syntheticXlsxManifestBytes({ ...manifest(), outcomes: [{ ...accepted(), proposals: new Array(33).fill(accepted().proposals[0]) }] })).toThrow(/^INVALID_INPUT$/);
});

it("accepts the synthetic project and per-row proposal maxima", async () => {
  const projects = [project, ...Array.from({ length: 99 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`)];
  const proposals = Array.from({ length: 32 }, (_, index) => ({ factType: `field_${index}`, value: { type: "text", value: `v${index}` } }));
  const input = { ...manifest(), projects, outcomes: [{ ...accepted(), proposals }] };
  const plan = await simulateSyntheticXlsxSelection(input, request(input));
  expect(plan[0]!.proposals).toHaveLength(32);
});

it("hashes and selects the same private snapshot despite async input mutation", async () => {
  const input = manifest(), selection = request(input), original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementationOnce(async (algorithm, data) => { entered(); await held; return original(algorithm, data); });
  try {
    const result = simulateSyntheticXlsxSelection(input, selection);
    await started;
    input.outcomes[0]!.recordKey = "changed";
    input.outcomes[0]!.proposals[0]!.value.value = "input-changed";
    selection.ordinals[0] = 2;
    release();
    const plan = await result;
    expect(plan[0]!.recordKey).toBe("row-1");
    expect(plan[0]!.ordinal).toBe(1);
    expect(plan[0]!.proposals[0]!.value.value).toBe("é\n😀");
    plan[0]!.proposals[0]!.value.value = "changed";
    expect(input.outcomes[0]!.proposals[0]!.value.value).toBe("input-changed");
  } finally { release(); spy.mockRestore(); }
});

it("fails closed if the synthetic digest operation fails", async () => {
  const input = manifest(), selection = request(input), canary = "synthetic-private-digest-error";
  const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(new Error(canary));
  try {
    await expect(simulateSyntheticXlsxSelection(input, selection)).rejects.toThrow(/^INVALID_INPUT$/);
  } finally { spy.mockRestore(); }
});
