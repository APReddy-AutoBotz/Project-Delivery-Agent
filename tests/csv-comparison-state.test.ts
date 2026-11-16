// FR-CON-006/007/012 / NFR-SEC-001: canonical bytes and complete reference bounds.
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CsvComparisonStateError,
  parseCsvComparisonState,
  serializeCsvComparisonState,
} from "../packages/domain/src/csv-comparison-state.js";

const uuid = (index: number) =>
  "00000000-0000-4000-8000-" + index.toString(16).padStart(12, "0");
const dictionary = [
  ["project.forecast", "date"],
  ["project.status", "text"],
];
const empty = (): any[] => [
  "pdaa.csv.state.v1",
  uuid(1),
  uuid(2),
  "1",
  structuredClone(dictionary),
  [],
];
const nonempty = (): any[] => {
  const state = empty();
  state[5] = [
    [
      "a".repeat(64),
      uuid(16),
      uuid(3),
      [
        ["0", uuid(32)],
        ["1", uuid(33)],
      ],
    ],
  ];
  return state;
};

it.each([
  [
    "empty",
    empty,
    162,
    "8838197404eeea2374fac6f83e03704340884e543b2c55642630ab1be0cbbfab",
  ],
  [
    "two supplied fields",
    nonempty,
    400,
    "d79544a42b54cb5484e6991b0e70b3d66152618e557214876711039a835a0bd6",
  ],
] as const)(
  "pins the approved %s ASCII serializer vector",
  (_name, input, bytes, digest) => {
    const actual = serializeCsvComparisonState(input());
    expect(actual.bytes).toBe(bytes);
    expect(Buffer.byteLength(actual.text, "utf8")).toBe(bytes);
    expect(createHash("sha256").update(actual.text).digest("hex")).toBe(digest);
    expect(JSON.parse(actual.text)).toEqual(input());
  },
);

it("preserves accepted NONE identities with no field references", () => {
  const state = nonempty();
  state[5][0][3] = [];
  expect(parseCsvComparisonState(state)[5]).toHaveLength(1);
  expect(parseCsvComparisonState(state)[5][0]![3]).toEqual([]);
});

it("uses numeric field order rather than lexical order", () => {
  const state = nonempty();
  state[4] = Array.from({ length: 11 }, (_, index) => [
    "field." + String(index).padStart(2, "0"),
    "text",
  ]);
  state[5][0][3] = [
    ["2", uuid(32)],
    ["10", uuid(33)],
  ];
  expect(
    parseCsvComparisonState(state)[5][0]![3].map(([index]) => index),
  ).toEqual(["2", "10"]);
  state[5][0][3].reverse();
  expect(() => parseCsvComparisonState(state)).toThrow(CsvComparisonStateError);
});

const corruptions: [string, (state: any[]) => unknown][] = [
  [
    "wrong version",
    (state) => {
      state[0] = "pdaa.csv.state.v2";
    },
  ],
  ["extra root field", (state) => state.push("extra")],
  [
    "null scope",
    (state) => {
      state[1] = null;
    },
  ],
  [
    "uppercase UUID",
    (state) => {
      state[1] = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
    },
  ],
  [
    "non-UUID scope",
    (state) => {
      state[2] = "source";
    },
  ],
  [
    "numeric revision",
    (state) => {
      state[3] = 1;
    },
  ],
  [
    "leading-zero revision",
    (state) => {
      state[3] = "01";
    },
  ],
  [
    "zero revision",
    (state) => {
      state[3] = "0";
    },
  ],
  [
    "overflow revision",
    (state) => {
      state[3] = "2147483648";
    },
  ],
  [
    "exponent revision",
    (state) => {
      state[3] = "1e3";
    },
  ],
  [
    "empty dictionary",
    (state) => {
      state[4] = [];
    },
  ],
  [
    "object dictionary",
    (state) => {
      state[4] = {};
    },
  ],
  [
    "duplicate fact",
    (state) => {
      state[4][1][0] = state[4][0][0];
    },
  ],
  ["unsorted dictionary", (state) => state[4].reverse()],
  [
    "unknown type",
    (state) => {
      state[4][0][1] = "json";
    },
  ],
  [
    "Unicode fact",
    (state) => {
      state[4][0][0] = "project.café";
    },
  ],
  [
    "space in fact",
    (state) => {
      state[4][0][0] = "project. forecast";
    },
  ],
  ["extra dictionary token", (state) => state[4][0].push("secret")],
  [
    "raw key",
    (state) => {
      state[5][0][0] = "ROW-1";
    },
  ],
  [
    "uppercase hash",
    (state) => {
      state[5][0][0] = "A".repeat(64);
    },
  ],
  ["extra identity token", (state) => state[5][0].push("raw value")],
  [
    "null field array",
    (state) => {
      state[5][0][3] = null;
    },
  ],
  [
    "field object",
    (state) => {
      state[5][0][3][0] = { fact: "project.forecast", value: "private" };
    },
  ],
  [
    "duplicate index",
    (state) => {
      state[5][0][3][1][0] = "0";
    },
  ],
  [
    "index leading zero",
    (state) => {
      state[5][0][3][0][0] = "00";
    },
  ],
  [
    "numeric index",
    (state) => {
      state[5][0][3][0][0] = 0;
    },
  ],
  [
    "unknown index",
    (state) => {
      state[5][0][3][1][0] = "2";
    },
  ],
  [
    "invalid projection",
    (state) => {
      state[5][0][3][0][1] = "projection";
    },
  ],
  ["extra reference token", (state) => state[5][0][3][0].push("private")],
  [
    "duplicate identity",
    (state) => {
      const row = structuredClone(state[5][0]);
      row[1] = uuid(17);
      state[5].push(row);
    },
  ],
  [
    "unsorted identity",
    (state) => {
      const row = structuredClone(state[5][0]);
      row[0] = "0".repeat(64);
      row[1] = uuid(17);
      state[5].push(row);
    },
  ],
  [
    "duplicate record",
    (state) => {
      const row = structuredClone(state[5][0]);
      row[0] = "b".repeat(64);
      state[5].push(row);
    },
  ],
];
it.each(corruptions)(
  "rejects %s before producing canonical bytes",
  (_name, mutate) => {
    const state = nonempty();
    mutate(state);
    expect(() => serializeCsvComparisonState(state)).toThrow(
      CsvComparisonStateError,
    );
  },
);

const suffixTargets: [string, (state: any[], suffix: string) => void][] = [
  [
    "scope UUID",
    (state, suffix) => {
      state[1] += suffix;
    },
  ],
  [
    "record UUID",
    (state, suffix) => {
      state[5][0][1] += suffix;
    },
  ],
  [
    "projection UUID",
    (state, suffix) => {
      state[5][0][3][0][1] += suffix;
    },
  ],
  [
    "identity hash",
    (state, suffix) => {
      state[5][0][0] += suffix;
    },
  ],
  [
    "fact type",
    (state, suffix) => {
      state[4][0][0] += suffix;
    },
  ],
  [
    "mapping revision",
    (state, suffix) => {
      state[3] += suffix;
    },
  ],
  [
    "field index",
    (state, suffix) => {
      state[5][0][3][0][0] += suffix;
    },
  ],
];
for (const [name, mutate] of suffixTargets) {
  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])(
    "rejects a trailing line separator in " + name + " %j",
    (suffix) => {
      const state = nonempty();
      mutate(state, suffix);
      expect(() => serializeCsvComparisonState(state)).toThrow(
        CsvComparisonStateError,
      );
    },
  );
}

it("copies and freezes validated data independently of caller mutation", () => {
  const input = nonempty();
  const result = serializeCsvComparisonState(input);
  input[5][0][3][0][1] = uuid(99);
  input[4][0][0] = "changed.fact";
  expect(result.state[5][0]![3][0]![1]).toBe(uuid(32));
  expect(result.state[4][0]![0]).toBe("project.forecast");
  for (const value of [
    result,
    result.state,
    result.state[4],
    result.state[4][0],
    result.state[5],
    result.state[5][0],
    result.state[5][0]![3],
    result.state[5][0]![3][0],
  ])
    expect(Object.isFrozen(value)).toBe(true);
});

it.each(["accessor", "hole", "symbol", "property", "prototype"])(
  "rejects non-data arrays: %s",
  (mode) => {
    const state = nonempty();
    let reads = 0;
    if (mode === "accessor")
      Object.defineProperty(state, "1", {
        get: () => {
          reads++;
          return uuid(1);
        },
      });
    if (mode === "hole") delete state[1];
    if (mode === "symbol")
      Object.defineProperty(state, Symbol("extra"), { value: true });
    if (mode === "property")
      Object.defineProperty(state, "extra", { value: true });
    if (mode === "prototype") Object.setPrototypeOf(state, null);
    expect(() => parseCsvComparisonState(state)).toThrow(
      CsvComparisonStateError,
    );
    expect(reads).toBe(0);
  },
);

function maximumState(): any[] {
  const state = nonempty();
  state[3] = "2147483647";
  state[4] = Array.from({ length: 32 }, (_, index) => [
    "a" + "z".repeat(93) + String(index).padStart(2, "0"),
    "boolean",
  ]);
  state[5] = Array.from({ length: 1000 }, (_, index) => [
    index.toString(16).padStart(64, "0"),
    uuid(index + 1),
    uuid(10000 + (index % 100)),
    Array.from({ length: 32 }, (_, field) => [
      String(field),
      uuid(20000 + index),
    ]),
  ]);
  return state;
}

it("accepts the independently calculated maximum grammar with all lifetime identities", () => {
  const result = serializeCsvComparisonState(maximumState());
  expect(result.bytes).toBe(1614668);
  expect(result.state[5]).toHaveLength(1000);
  expect(new Set(result.state[5].map((row) => row[2])).size).toBe(100);
});

it.each(["identity", "dictionary", "reference", "project"])(
  "rejects one beyond the %s bound",
  (bound) => {
    const state = maximumState();
    if (bound === "identity")
      state[5].push(["f".repeat(64), uuid(30000), uuid(10000), []]);
    if (bound === "dictionary") state[4].push(["zzzz", "text"]);
    if (bound === "reference") state[5][0][3].push(["32", uuid(30001)]);
    if (bound === "project") state[5][100][2] = uuid(30002);
    expect(() => serializeCsvComparisonState(state)).toThrow(
      CsvComparisonStateError,
    );
  },
);
