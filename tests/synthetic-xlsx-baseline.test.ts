import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { syntheticXlsxBaselineBytes } from "../packages/domain/src/synthetic-xlsx-baseline.js";

const customerId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const binding = { customerId, sourceId, sheet: "Sheet Ω", mappingRevision: 1 };
const row = (key = "a", text = "value") => ({ key, projectId, fields: [{ factType: "summary", value: { type: "text", value: text } }] });
const present = (rows: unknown[]) => ({ ...binding, baseline: { kind: "PRESENT", rows } });
const bytes = (value: unknown) => Buffer.from(syntheticXlsxBaselineBytes(value));
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

it("uses exact ordered JSON/UTF-8 bytes and distinguishes absent from present empty", () => {
  const absent = bytes({ ...binding, baseline: { kind: "ABSENT" } });
  const empty = bytes(present([]));
  const expected = `["pdaa.synthetic.xlsx.baseline.v1","${customerId}","${sourceId}","Sheet Ω",1,["ABSENT"]]`;
  expect(absent.toString("utf8")).toBe(expected);
  expect(digest(absent)).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
  expect(empty.toString("utf8")).toBe(`["pdaa.synthetic.xlsx.baseline.v1","${customerId}","${sourceId}","Sheet Ω",1,["PRESENT",[]]]`);
  expect(absent.equals(empty)).toBe(false);
});

it("binds every value, scope, and ordering without normalizing Unicode", () => {
  const left = row("a", "é\n😀");
  const right = { key: "b", projectId, fields: [
    { factType: "count", value: { type: "number", value: 2.5 } },
    { factType: "enabled", value: { type: "boolean", value: false } },
    { factType: "date", value: { type: "date", value: "2026-01-02" } },
    { factType: "empty", value: { type: "empty", value: null } },
  ] };
  const original = bytes(present([left, right]));
  const expected = JSON.stringify(["pdaa.synthetic.xlsx.baseline.v1", customerId, sourceId, "Sheet Ω", 1,
    ["PRESENT", [["a", projectId, [["summary", ["text", "é\n😀"]]]],
      ["b", projectId, [["count", ["number", 2.5]], ["enabled", ["boolean", false]], ["date", ["date", "2026-01-02"]], ["empty", ["empty", null]]]]]]]);
  expect(original.toString("utf8")).toBe(expected);
  expect(digest(original)).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
  for (const changed of [present([right, left]), present([row("a", "e\u0301\n😀"), right]),
    { ...present([left, right]), sheet: "Sheet ω" }, { ...present([left, right]), mappingRevision: 2 },
    present([left, { ...right, fields: [...right.fields].reverse() }])])
    expect(bytes(changed).equals(original)).toBe(false);
});

it("matches a fixed independent PRESENT byte and SHA-256 vector", () => {
  const encoded = bytes(present([row("a", "é\n😀")]));
  expect(encoded.toString("hex")).toBe("5b22706461612e73796e7468657469632e786c73782e626173656c696e652e7631222c2231313131313131312d313131312d343131312d383131312d313131313131313131313131222c2232323232323232322d323232322d343232322d383232322d323232323232323232323232222c22536865657420cea9222c312c5b2250524553454e54222c5b5b2261222c2233333333333333332d333333332d343333332d383333332d333333333333333333333333222c5b5b2273756d6d617279222c5b2274657874222c22c3a95c6ef09f9880225d5d5d5d5d5d5d");
  expect(digest(encoded)).toBe("34e3fda0c0059758abd233c572afb00170745c6499c378c3a0e925e8d49572f6");
});

it("changes identity for each bound component and does not alias input or output", () => {
  const mutable = row(), value = present([mutable]), original = bytes(value), copy = Buffer.from(original);
  const alternatives = [
    { ...value, customerId: "44444444-4444-4444-8444-444444444444" },
    { ...value, sourceId: "55555555-5555-4555-8555-555555555555" },
    present([row("different")]),
    present([{ ...row(), projectId: "44444444-4444-4444-8444-444444444444" }]),
    present([{ ...row(), fields: [{ factType: "other", value: { type: "text", value: "value" } }] }]),
    present([{ ...row(), fields: [{ factType: "summary", value: { type: "number", value: 12 } }] }]),
    present([row("a", "different")]),
  ];
  for (const alternative of alternatives) expect(bytes(alternative).equals(original)).toBe(false);
  mutable.fields[0]!.value.value = "changed";
  expect(original.equals(copy)).toBe(true);
  original[0] = 0;
  expect(bytes(present([row()])).equals(copy)).toBe(true);
});

it.each([
  [{ type: "text", value: "before" }, { type: "text", value: "after" }],
  [{ type: "number", value: 1e100 }, { type: "number", value: 1e101 }],
  [{ type: "boolean", value: true }, { type: "boolean", value: false }],
  [{ type: "date", value: "2026-01-02" }, { type: "date", value: "2026-01-03" }],
  [{ type: "empty", value: null }, { type: "text", value: "" }],
])("binds each supported synthetic fact value", (before, after) => {
  const outcome = (value: unknown) => present([{ key: "a", projectId, fields: [{ factType: "sample", value }] }]);
  expect(bytes(outcome(before)).equals(bytes(outcome(after)))).toBe(false);
});

it("accepts the revision boundary and rejects noncanonical revision forms", () => {
  expect(bytes({ ...present([]), mappingRevision: 2_147_483_647 }).length).toBeGreaterThan(0);
  for (const mappingRevision of [0, 2_147_483_648, 1.5, "1", "01", NaN])
    expect(() => bytes({ ...present([]), mappingRevision })).toThrow();
});

it("rejects duplicate, malformed, accessor, sparse and negative-zero inputs", () => {
  const hole = new Array(1);
  const accessor = { ...row(), get key() { throw new Error("must not execute"); } };
  const cases: unknown[] = [present([row(), row()]), present(hole), present([accessor]),
    present([{ ...row(), fields: [row().fields[0], row().fields[0]] }]),
    present([{ ...row(), fields: [{ factType: "number", value: { type: "number", value: -0 } }] }]),
    present([{ ...row(), fields: [{ factType: "number", value: { type: "number", value: Infinity } }] }]),
    { ...present([]), mappingRevision: "01" }, { ...present([]), sourceId: sourceId.replace("2", "A") },
    { ...present([]), extra: "unexpected" }, { ...binding, baseline: { kind: "ABSENT", rows: [] } }];
  for (const value of cases) expect(() => bytes(value)).toThrow();
});

it("rejects inherited, hidden, symbol, sparse and accessor shapes at nested boundaries", () => {
  const hidden = { ...row() }; Object.defineProperty(hidden, "key", { value: "a", enumerable: false });
  const symbol = { ...row(), [Symbol("extra")]: true };
  const inherited = Object.assign(Object.create({ inherited: true }), row());
  const sparseFields = new Array(1);
  const accessorValue = { type: "text", get value() { throw new Error("must not execute"); } };
  const cases = [present([hidden]), present([symbol]), present([inherited]),
    present([{ ...row(), fields: sparseFields }]),
    present([{ ...row(), fields: [{ factType: "summary", value: accessorValue }] }]),
    present([{ ...row(), fields: [{ factType: "date", value: { type: "date", value: "2026-02-30" } }] }]),
    present([row("a", "\ud800")]), present(new Array(1001).fill(row()))];
  for (const value of cases) expect(() => bytes(value)).toThrow();
});

it("enforces the exact encoded-byte ceiling including escaping and punctuation", () => {
  let found: unknown;
  for (let count = 200; count < 260 && !found; count++) {
    const rows = Array.from({ length: count }, (_, index) => row(`r${index}`, "x".repeat(4096)));
    const extra = row("last", "");
    const reference = (length: number) => JSON.stringify(["pdaa.synthetic.xlsx.baseline.v1", customerId, sourceId, binding.sheet, 1,
      ["PRESENT", [...rows, { ...extra, fields: [{ factType: "summary", value: { type: "text", value: "x".repeat(length) } }] }]
        .map((item) => [item.key, item.projectId, item.fields.map((field) => [field.factType, [field.value.type, field.value.value]])])]]);
    const needed = 1_048_576 - Buffer.byteLength(reference(0));
    if (needed >= 0 && needed <= 4095) found = { rows, extra, needed, reference };
  }
  expect(found).toBeDefined();
  const { rows, extra, needed, reference } = found as { rows: ReturnType<typeof row>[]; extra: ReturnType<typeof row>; needed: number; reference: (length: number) => string };
  const last = (length: number) => ({ ...extra, fields: [{ factType: "summary", value: { type: "text", value: "x".repeat(length) } }] });
  const exact = bytes(present([...rows, last(needed)]));
  expect(exact.length).toBe(1_048_576);
  expect(exact.toString("utf8")).toBe(reference(needed));
  expect(() => bytes(present([...rows, last(needed + 1)]))).toThrow();
});

it("counts escaped and multibyte text at the exact byte ceiling", () => {
  const prefix = '"\\\nΩ😀';
  let found: { rows: ReturnType<typeof row>[]; needed: number; reference: (length: number) => string } | undefined;
  for (let count = 200; count < 260 && !found; count++) {
    const rows = Array.from({ length: count }, (_, index) => row(`e${index}`, prefix + "x".repeat(4096 - prefix.length)));
    const reference = (length: number) => JSON.stringify(["pdaa.synthetic.xlsx.baseline.v1", customerId, sourceId, binding.sheet, 1,
      ["PRESENT", [...rows, row("last", prefix + "x".repeat(length))]
        .map((item) => [item.key, item.projectId, item.fields.map((field) => [field.factType, [field.value.type, field.value.value]])])]]);
    const needed = 1_048_576 - Buffer.byteLength(reference(0));
    if (needed >= 0 && needed < 4096 - prefix.length) found = { rows, needed, reference };
  }
  expect(found).toBeDefined();
  const { rows, needed, reference } = found!;
  const exact = bytes(present([...rows, row("last", prefix + "x".repeat(needed))]));
  expect(exact.length).toBe(1_048_576);
  expect(exact.toString("utf8")).toBe(reference(needed));
  expect(() => bytes(present([...rows, row("last", prefix + "x".repeat(needed + 1))]))).toThrow();
});
