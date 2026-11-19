import { expect, it } from "vitest";
import { serializeCsvComparisonState } from "../packages/domain/src/csv-comparison-state.js";
import {
  applyXlsxComparisonObservations,
  serializeXlsxComparisonState,
} from "../packages/domain/src/xlsx-comparison-state.js";

const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = (n: number) => n.toString(16).padStart(64, "0");
const header = [
  "pdaa.xlsx.comparison-state.v1",
  id(1),
  id(2),
  1,
  'Portfolio 🧪 "1"',
  "excel-text-v1",
  [
    ["project.forecast", "date"],
    ["project.status", "text"],
  ],
];
const previous = [
  ...header,
  [
    [
      key(1),
      id(10),
      id(11),
      [
        ["0", id(20)],
        ["1", id(21)],
      ],
    ],
    [key(2), id(12), id(11), [["0", id(22)]]],
  ],
];

it("binds canonical state to workbook scope and measures the exact UTF-8 bytes", () => {
  const initial = [...header, []];
  const encoded = serializeXlsxComparisonState(initial);
  expect(encoded.text).toBe(JSON.stringify(initial));
  expect(encoded.bytes).toBe(Buffer.byteLength(encoded.text));
  expect(encoded.bytes).toBeGreaterThan(encoded.text.length);
  expect(serializeXlsxComparisonState(initial.with(4, "Other")).text).not.toBe(
    encoded.text,
  );
  expect(
    serializeXlsxComparisonState(initial.with(5, "portable-v1")).text,
  ).not.toBe(encoded.text);
  expect(() => serializeCsvComparisonState(initial)).toThrow();
  expect(() =>
    serializeXlsxComparisonState(initial.with(0, "pdaa.csv.state.v1")),
  ).toThrow();
});

it("carries retained references forward and overlays only accepted fields", () => {
  const { state } = applyXlsxComparisonObservations(previous, [
    [key(1), id(10), id(11), [["1", id(25)]]],
    [key(3), id(13), id(11), []],
  ]);
  expect(state[7]).toEqual([
    [
      key(1),
      id(10),
      id(11),
      [
        ["0", id(20)],
        ["1", id(25)],
      ],
    ],
    [key(2), id(12), id(11), [["0", id(22)]]],
    [key(3), id(13), id(11), []],
  ]);
  expect(
    applyXlsxComparisonObservations(state, [[key(1), id(10), id(11), []]])
      .state,
  ).toEqual(state);
  expect(Object.isFrozen(state[7][0]?.[3][0])).toBe(true);
  expect(previous[7]).not.toBe(state[7]);
});

it("rejects a moved project, reused record, invalid refs and an unverified baseline", () => {
  expect(() =>
    applyXlsxComparisonObservations(previous, [[key(1), id(10), id(99), []]]),
  ).toThrow("INVALID_PREVIEW");
  expect(() =>
    applyXlsxComparisonObservations(previous, [[key(3), id(10), id(11), []]]),
  ).toThrow("INVALID_PREVIEW");
  expect(() =>
    applyXlsxComparisonObservations(previous, [
      [key(1), id(10), id(11), [["2", id(25)]]],
    ]),
  ).toThrow("INVALID_PREVIEW");
  expect(() => applyXlsxComparisonObservations(null, [])).toThrow(
    "INVALID_PREVIEW",
  );
  expect(() =>
    serializeXlsxComparisonState(previous.with(4, "A_x0001_")),
  ).toThrow("INVALID_PREVIEW");
  expect(() => serializeXlsxComparisonState(previous.with(3, "1"))).toThrow(
    "INVALID_PREVIEW",
  );
});

it("enforces identity capacity across retained and accepted observations", () => {
  const rows = Array.from({ length: 1000 }, (_, n) => [
    key(n),
    id(n + 100),
    id(11),
    [],
  ]);
  const max = [...header, rows];
  expect(serializeXlsxComparisonState(max).state[7]).toHaveLength(1000);
  expect(() =>
    applyXlsxComparisonObservations(max, [[key(1000), id(1100), id(11), []]]),
  ).toThrow("INVALID_PREVIEW");
});
