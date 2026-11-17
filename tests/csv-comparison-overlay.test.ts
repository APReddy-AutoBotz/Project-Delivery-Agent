// FR-CON-006/007/012 / NFR-SEC-001: cumulative accepted-reference transitions.
import { expect, it } from "vitest";
import { applyCsvComparisonObservations } from "../packages/domain/src/csv-comparison-overlay.js";
import {
  CsvComparisonStateError,
  parseCsvComparisonState,
} from "../packages/domain/src/csv-comparison-state.js";

type Field = [string, string];
type Row = [string, string, string, Field[]];
type State = [string, string, string, string, [string, string][], Row[]];
const uuid = (i: number) =>
  "00000000-0000-4000-8000-" + i.toString(16).padStart(12, "0");
const key = (i: number) => i.toString(16).padStart(64, "0");
const row = (
  i: number,
  fields: Field[] = [["0", uuid(20000 + i)]],
  project = 1,
): Row => [key(i), uuid(1000 + i), uuid(100 + project), fields];
const state = (rows: Row[] = []): State => [
  "pdaa.csv.state.v1",
  uuid(1),
  uuid(2),
  "1",
  [
    ["project.forecast", "date"],
    ["project.status", "text"],
  ],
  rows,
];

it("keeps verified empty input empty without inventing an identity", () => {
  const before = state();
  const result = applyCsvComparisonObservations(before, []);
  expect(result).toEqual(before);
  expect(result).not.toBe(before);
  expect(result[5]).not.toBe(before[5]);
});
it("keeps all prior identities and references when observations are empty", () => {
  const before = state([row(1), row(2)]);
  expect(applyCsvComparisonObservations(before, [])).toEqual(before);
});
it("sorts the complete union while preserving absent identities and unsupplied fields", () => {
  const before = state([row(2), row(8)]);
  const result = applyCsvComparisonObservations(before, [
    row(1),
    row(8, [["1", uuid(30000)]]),
    row(9),
  ]);
  expect(result[5].map((r) => r[0])).toEqual([1, 2, 8, 9].map(key));
  expect(result[5][1]).toEqual(before[5][0]);
  expect(result[5][2]![3]).toEqual([
    ["0", uuid(20008)],
    ["1", uuid(30000)],
  ]);
  expect(result.slice(0, 5)).toEqual(before.slice(0, 5));
});
it("carries unselected and absent observations across files when they return later", () => {
  const first = applyCsvComparisonObservations(state(), [row(1), row(2)]);
  const second = applyCsvComparisonObservations(first, [
    row(1, [["1", uuid(30001)]]),
  ]);
  expect(second[5][1]).toEqual(first[5][1]);
  const third = applyCsvComparisonObservations(second, [
    row(2, [["0", uuid(30002)]]),
  ]);
  expect(third[5]).toEqual([
    row(1, [
      ["0", uuid(20001)],
      ["1", uuid(30001)],
    ]),
    row(2, [["0", uuid(30002)]]),
  ]);
});
it("keeps known-row references through optional blanks and replaces only a later supplied field", () => {
  const before = state([
    row(1, [
      ["0", uuid(30000)],
      ["1", uuid(30001)],
    ]),
  ]);
  const omitted = applyCsvComparisonObservations(before, [row(1, [])]);
  expect(omitted).toEqual(before);
  const supplied = applyCsvComparisonObservations(omitted, [
    row(1, [["1", uuid(30002)]]),
  ]);
  expect(supplied[5][0]![3]).toEqual([
    ["0", uuid(30000)],
    ["1", uuid(30002)],
  ]);
});
it("includes a new accepted NONE identity with no field references", () => {
  const result = applyCsvComparisonObservations(state([row(1)]), [row(2, [])]);
  expect(result[5]).toEqual([row(1), row(2, [])]);
});
it("sorts merged field indexes numerically", () => {
  const before = state([row(1, [["10", uuid(30010)]])]);
  before[4] = Array.from({ length: 11 }, (_, i) => [
    "field." + String(i).padStart(2, "0"),
    "text",
  ]);
  const result = applyCsvComparisonObservations(before, [
    row(1, [["2", uuid(30002)]]),
  ]);
  expect(result[5][0]![3]).toEqual([
    ["2", uuid(30002)],
    ["10", uuid(30010)],
  ]);
});
it.each(["record", "project"])(
  "rejects known-key %s rebinding without changing either input",
  (kind) => {
    const before = state([row(1)]);
    const observations = [row(1, [["1", uuid(30001)]])];
    observations[0]![kind === "record" ? 1 : 2] = uuid(40000);
    const beforeCopy = structuredClone(before),
      observedCopy = structuredClone(observations);
    expect(() => applyCsvComparisonObservations(before, observations)).toThrow(
      CsvComparisonStateError,
    );
    expect(before).toEqual(beforeCopy);
    expect(observations).toEqual(observedCopy);
  },
);
it("rejects record reuse across separately valid prior and new-key observations", () => {
  const before = state([row(1)]),
    observations = [row(2)];
  observations[0]![1] = before[5][0]![1];
  const copy = structuredClone([before, observations]);
  expect(() => applyCsvComparisonObservations(before, observations)).toThrow(
    CsvComparisonStateError,
  );
  expect([before, observations]).toEqual(copy);
});
it("accepts the cumulative 1000-identity boundary across two individually bounded inputs", () => {
  const before = state(Array.from({ length: 500 }, (_, i) => row(i)));
  const incoming = Array.from({ length: 500 }, (_, i) => row(i + 500));
  expect(applyCsvComparisonObservations(before, incoming)[5]).toHaveLength(
    1000,
  );
});
it("rejects cumulative identity overflow without dropping absent identities", () => {
  const before = state(Array.from({ length: 600 }, (_, i) => row(i)));
  const incoming = Array.from({ length: 401 }, (_, i) => row(i + 600));
  parseCsvComparisonState(before);
  parseCsvComparisonState(state(incoming));
  const copy = structuredClone([before, incoming]);
  expect(() => applyCsvComparisonObservations(before, incoming)).toThrow(
    CsvComparisonStateError,
  );
  expect([before, incoming]).toEqual(copy);
});
it("accepts 100 cumulative projects spread across separately bounded inputs", () => {
  const before = state(Array.from({ length: 50 }, (_, i) => row(i, [], i + 1)));
  const incoming = Array.from({ length: 50 }, (_, i) =>
    row(i + 50, [], i + 51),
  );
  expect(
    new Set(
      applyCsvComparisonObservations(before, incoming)[5].map((r) => r[2]),
    ).size,
  ).toBe(100);
});
it("rejects cumulative project overflow when both individual inputs are valid", () => {
  const before = state(Array.from({ length: 50 }, (_, i) => row(i, [], i + 1)));
  const incoming = Array.from({ length: 51 }, (_, i) =>
    row(i + 50, [], i + 51),
  );
  parseCsvComparisonState(before);
  parseCsvComparisonState(state(incoming));
  const copy = structuredClone([before, incoming]);
  expect(() => applyCsvComparisonObservations(before, incoming)).toThrow(
    CsvComparisonStateError,
  );
  expect([before, incoming]).toEqual(copy);
});
it.each(["unsorted", "duplicate", "raw-key", "object"])(
  "refuses %s observations through the strict reference grammar",
  (kind) => {
    let observations: unknown = [row(1), row(2)];
    if (kind === "unsorted") observations = [row(2), row(1)];
    if (kind === "duplicate") observations = [row(1), row(1)];
    if (kind === "raw-key") {
      const invalid = row(1);
      invalid[0] = "PRIVATE-RAW-KEY";
      observations = [invalid];
    }
    if (kind === "object") observations = { rows: [row(1)] };
    expect(() => applyCsvComparisonObservations(state(), observations)).toThrow(
      "INVALID_CSV_COMPARISON_STATE",
    );
  },
);
it("rejects a malformed predecessor before producing a successor", () => {
  const before = state();
  before[0] = "pdaa.csv.state.v2";
  expect(() => applyCsvComparisonObservations(before, [row(1)])).toThrow(
    CsvComparisonStateError,
  );
});
it("copies and freezes the complete result independently of mutable caller arrays", () => {
  const before = state([row(1)]),
    incoming = [row(1, [["1", uuid(30001)]]), row(2, [])];
  const result = applyCsvComparisonObservations(before, incoming);
  const expected = structuredClone(result);
  before[4][0]![0] = "changed.fact";
  before[5][0]![3][0]![1] = uuid(40000);
  incoming[0]![3][0]![1] = uuid(40001);
  incoming[1]![3].push(["0", uuid(40002)]);
  expect(result).toEqual(expected);
  const frozen = (value: unknown): boolean =>
    !Array.isArray(value) || (Object.isFrozen(value) && value.every(frozen));
  expect(frozen(result)).toBe(true);
});
