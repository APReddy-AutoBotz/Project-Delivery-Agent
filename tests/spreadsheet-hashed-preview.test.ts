// FR-CON-006/007/012, FAIL-006: compare hashed identities without raw-key history.
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { IngestionInputError } from "../packages/domain/src/connector.js";
import {
  previewSpreadsheetCsv,
  previewSpreadsheetCsvHashedBaseline,
} from "../packages/domain/src/spreadsheet-preview.js";

const id = (value: number) =>
  `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const config = {
  customerId: id(1),
  sourceId: id(2),
  sheet: "Projects",
  mappingRevision: "1",
  fileName: "plan.csv",
  identityColumn: "key",
  projectColumn: "project",
  projectIds: [id(3), id(4)],
  fields: [
    {
      column: "status",
      factType: "project.status",
      type: "text",
      required: true,
    },
  ],
};
const hash = (sheet: string, key: string) =>
  createHash("sha256")
    .update(JSON.stringify([sheet, key]))
    .digest("hex");
const csv = (...rows: string[]) =>
  ["key,project,status,unmapped", ...rows].join("\n");
const row = (
  key: string,
  status = "Open",
  project = id(3),
  unmapped = "private",
) => `${key},${project},${status},${unmapped}`;
const baseline = (keys = ["a"], cfg = config) => ({
  customerId: cfg.customerId,
  sourceId: cfg.sourceId,
  sheet: cfg.sheet,
  mappingRevision: cfg.mappingRevision,
  rows: keys.map((key) => ({
    keyHash: hash(cfg.sheet, key),
    projectId: id(3),
    fields: [
      { factType: "project.status", value: { type: "text", value: "Open" } },
    ],
  })),
});
const optional = {
  ...config,
  fields: config.fields.map((field) => ({ ...field, required: false })),
};

it.each([
  ["CREATE", [], row("a")],
  ["UNCHANGED", ["a"], row("a")],
  ["UPDATE", ["a"], row("a", "Closed")],
] as const)(
  "computes %s from hashed prior observations",
  (operation, keys, input) => {
    const result = previewSpreadsheetCsvHashedBaseline(
      csv(input),
      config,
      baseline([...keys]),
      hash,
    );
    expect(result.rows[0]).toMatchObject({
      status: "VALID",
      operation,
      keyHash: hash(config.sheet, "a"),
    });
    expect(result.comparison).toBe("BASELINE_SUPPLIED");
    expect(result).not.toHaveProperty("missingPreviousKeys");
    expect(result.missingPreviousKeyHashes).toEqual([]);
  },
);

it("records a new blank-only optional row as NONE with a valid hashed identity", () => {
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row("a", "")),
    optional,
    baseline([]),
    hash,
  );
  expect(result.rows[0]).toMatchObject({
    status: "VALID",
    operation: "NONE",
    keyHash: hash(config.sheet, "a"),
    proposals: [],
  });
});

it("compares optional blanks and a returning value against the cumulative carried baseline", () => {
  const carried = baseline();
  const frozen = structuredClone(carried);
  const omitted = previewSpreadsheetCsvHashedBaseline(
    csv(row("a", "")),
    optional,
    carried,
    hash,
  );
  const returned = previewSpreadsheetCsvHashedBaseline(
    csv(row("a")),
    optional,
    carried,
    hash,
  );
  expect(omitted.rows[0]).toMatchObject({
    operation: "UNCHANGED",
    proposals: [],
  });
  expect(omitted.rows[0]!.fields[0]!.state).toBe("MISSING");
  expect(returned.rows[0]!.operation).toBe("UNCHANGED");
  expect(carried).toEqual(frozen);
  // This is comparison against supplied carried state, not a persistence test.
});

it("keeps an observed unselected identity comparable when another identity is absent", () => {
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row("b")),
    config,
    baseline(["a", "b"]),
    hash,
  );
  expect(result.rows[0]).toMatchObject({
    status: "VALID",
    operation: "UNCHANGED",
  });
  expect(result.missingPreviousKeyHashes).toEqual([hash(config.sheet, "a")]);
});

it("requires review for a renamed key rather than inferring deletion or identity", () => {
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row("renamed")),
    config,
    baseline(),
    hash,
  );
  expect(result.rows[0]).toMatchObject({
    status: "REVIEW_REQUIRED",
    operation: "NONE",
    proposals: [],
    errors: ["ROW_IDENTITY_REVIEW"],
  });
  expect(result.missingPreviousKeyHashes).toEqual([hash(config.sheet, "a")]);
});

it("rejects moving a known hashed identity to a different configured project", () => {
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row("a", "Open", id(4))),
    config,
    baseline(),
    hash,
  );
  expect(result.rows[0]!.status).toBe("INVALID");
  expect(result.rows[0]!.errors).toContain("PROJECT_CHANGED");
  expect(result.rows[0]!.proposals).toEqual([]);
});

it("does not propose a change for an unmapped-only file change", () => {
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row("a", "Open", id(3), "different-unmapped")),
    config,
    baseline(),
    hash,
  );
  expect(result.rows[0]!.operation).toBe("UNCHANGED");
  expect(result.rows[0]!.proposals).toEqual([
    { factType: "project.status", value: { type: "text", value: "Open" } },
  ]);
});

it.each([
  ["text", "Open", "Open", "Closed"],
  ["number", 42, "42", "43"],
  ["boolean", true, "true", "false"],
  ["date", "2027-03-01", "2027-03-01", "2027-03-02"],
] as const)(
  "compares typed %s values without coercion",
  (type, value, same, changed) => {
    const cfg = {
      ...config,
      fields: config.fields.map((field) => ({ ...field, type })),
    };
    const prior = {
      ...baseline(),
      rows: [
        {
          ...baseline().rows[0]!,
          fields: [{ factType: "project.status", value: { type, value } }],
        },
      ],
    };
    expect(
      previewSpreadsheetCsvHashedBaseline(csv(row("a", same)), cfg, prior, hash)
        .rows[0]!.operation,
    ).toBe("UNCHANGED");
    expect(
      previewSpreadsheetCsvHashedBaseline(
        csv(row("a", changed)),
        cfg,
        prior,
        hash,
      ).rows[0]!.operation,
    ).toBe("UPDATE");
  },
);

it("hashes each distinct valid raw key once, including duplicate and otherwise invalid rows", () => {
  const calls: [string, string][] = [];
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(
      row("a"),
      row("a"),
      row("b", "Open", "invalid-project"),
      row("c", "=invalid"),
    ),
    config,
    baseline([]),
    (sheet, key) => {
      calls.push([sheet, key]);
      return hash(sheet, key);
    },
  );
  expect(calls).toEqual([
    [config.sheet, "a"],
    [config.sheet, "b"],
    [config.sheet, "c"],
  ]);
  expect(result.rows[0]!.errors).toContain("DUPLICATE_KEY");
  expect(result.rows[1]!.errors).toContain("DUPLICATE_KEY");
  expect(result.rows[2]!.errors).toContain("INVALID_PROJECT");
  expect(result.rows[3]!.errors).toContain("INVALID_FIELDS");
});

it("does not hash invalid empty, whitespace-only or overlong raw keys", () => {
  const calls: string[] = [];
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row(""), row("  "), row("x".repeat(257))),
    config,
    baseline([]),
    (sheet, key) => {
      calls.push(key);
      return hash(sheet, key);
    },
  );
  expect(calls).toEqual([]);
  expect(result.rows.map((item) => item.keyHash)).toEqual([null, null, null]);
  for (const item of result.rows) expect(item.errors).toContain("INVALID_KEY");
});

it("hashes a raw 64-hex key once instead of treating it as a stored digest", () => {
  const raw = hash(config.sheet, "a"),
    calls: string[] = [];
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row(raw)),
    config,
    baseline(),
    (sheet, key) => {
      calls.push(key);
      return hash(sheet, key);
    },
  );
  expect(calls).toEqual([raw]);
  expect(result.rows[0]!.keyHash).toBe(hash(config.sheet, raw));
  expect(result.rows[0]!.keyHash).not.toBe(raw);
  expect(result.rows[0]!.status).toBe("REVIEW_REQUIRED");
  expect(result.missingPreviousKeyHashes).toEqual([raw]);
});

it("passes exact untrimmed Unicode sheet/key tokens to the server hasher", () => {
  const cfg = { ...config, sheet: "  Projécts 🧭  " },
    key = "  café 🧭  ";
  const calls: [string, string][] = [];
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(row(key)),
    cfg,
    baseline([key], cfg),
    (sheet, raw) => {
      calls.push([sheet, raw]);
      return hash(sheet, raw);
    },
  );
  expect(calls).toEqual([[cfg.sheet, key]]);
  expect(result.rows[0]!.operation).toBe("UNCHANGED");
});

it("returns only missing hashes for a header-only file and never infers deletion", () => {
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(),
    config,
    baseline(),
    hash,
  );
  expect(result.rows).toEqual([]);
  expect(result.missingPreviousKeyHashes).toEqual([hash(config.sheet, "a")]);
});

it("compares the full1000-row boundary with one hash per distinct valid key", () => {
  let calls = 0;
  const result = previewSpreadsheetCsvHashedBaseline(
    csv(...Array.from({ length: 1000 }, (_, index) => row("key-" + index))),
    config,
    baseline([]),
    (sheet, key) => {
      calls++;
      return hash(sheet, key);
    },
  );
  expect(result.rows).toHaveLength(1000);
  expect(
    result.rows.every(
      (item) => item.status === "VALID" && item.operation === "CREATE",
    ),
  ).toBe(true);
  expect(calls).toBe(1000);
});

it("rejects an oversized baseline before hashing current data", () => {
  let calls = 0;
  expect(() =>
    previewSpreadsheetCsvHashedBaseline(
      csv(row("a")),
      config,
      baseline(Array.from({ length: 1001 }, (_, index) => "key-" + index)),
      (sheet, key) => {
        calls++;
        return hash(sheet, key);
      },
    ),
  ).toThrow("INVALID_BASELINE");
  expect(calls).toBe(0);
});

it("rejects distinct-key collisions without returning partial proposals", () => {
  expect(() =>
    previewSpreadsheetCsvHashedBaseline(
      csv(row("a"), row("b")),
      config,
      baseline([]),
      () => "a".repeat(64),
    ),
  ).toThrow("INVALID_BASELINE");
});

const malformed: [string, (value: any) => unknown][] = [
  [
    "customer",
    (value) => {
      value.customerId = id(8);
    },
  ],
  [
    "source",
    (value) => {
      value.sourceId = id(8);
    },
  ],
  [
    "sheet",
    (value) => {
      value.sheet = "other";
    },
  ],
  [
    "mapping",
    (value) => {
      value.mappingRevision = "2";
    },
  ],
  [
    "project",
    (value) => {
      value.rows[0].projectId = id(8);
    },
  ],
  [
    "duplicate hash",
    (value) => value.rows.push(structuredClone(value.rows[0])),
  ],
  [
    "raw-key-shaped row",
    (value) => {
      value.rows[0].key = "a";
      delete value.rows[0].keyHash;
    },
  ],
  [
    "unknown fact",
    (value) => {
      value.rows[0].fields[0].factType = "other.fact";
    },
  ],
  [
    "wrong type",
    (value) => {
      value.rows[0].fields[0].value = { type: "boolean", value: true };
    },
  ],
  [
    "missing required field",
    (value) => {
      value.rows[0].fields = [];
    },
  ],
  [
    "duplicate field",
    (value) =>
      value.rows[0].fields.push(structuredClone(value.rows[0].fields[0])),
  ],
  [
    "extra baseline property",
    (value) => {
      value.extra = "not retained";
    },
  ],
];
it.each(malformed)(
  "rejects baseline %s before invoking the hasher",
  (_name, mutate) => {
    const value = baseline(),
      calls: string[] = [];
    mutate(value);
    expect(() =>
      previewSpreadsheetCsvHashedBaseline(
        csv(row("a")),
        config,
        value,
        (_sheet, key) => {
          calls.push(key);
          return "a".repeat(64);
        },
      ),
    ).toThrow("INVALID_BASELINE");
    expect(calls).toEqual([]);
  },
);

it.each([undefined, null])(
  "requires an explicit hashed baseline: %j",
  (value) => {
    expect(() =>
      previewSpreadsheetCsvHashedBaseline(csv(row("a")), config, value, hash),
    ).toThrow("INVALID_BASELINE");
  },
);

it.each([
  () => "raw",
  () => "A".repeat(64),
  () => "a".repeat(64) + "\n",
  () => 1,
  () => null,
  () => new String("a".repeat(64)),
  () => Promise.resolve("a".repeat(64)),
  () => Promise.reject(new Error("private-rejection")),
  () => {
    throw new Error("private-callback-reason");
  },
])(
  "rejects callback failure or malformed output with a fixed safe error %$",
  async (callback) => {
    let caught: unknown;
    try {
      previewSpreadsheetCsvHashedBaseline(
        csv(row("a")),
        config,
        baseline([]),
        callback as unknown as typeof hash,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IngestionInputError);
    expect((caught as Error).message).toBe("INVALID_BASELINE");
    expect((caught as Error).cause).toBeUndefined();
    await Promise.resolve();
  },
);

it.each([
  [row("a")],
  [row("a", "Closed")],
  [row("renamed")],
  [row("a", "Open", id(4))],
  [row("a"), row("b")],
  [row("a"), row("a")],
  [row("a"), row("b", "=invalid")],
])(
  "preserves raw-helper operation and proposal semantics for %j",
  (...input) => {
    const rawBaseline = {
      ...baseline(),
      rows: [
        { key: "a", projectId: id(3), fields: baseline().rows[0]!.fields },
      ],
    };
    const original = previewSpreadsheetCsv(csv(...input), config, rawBaseline);
    const actual = previewSpreadsheetCsvHashedBaseline(
      csv(...input),
      config,
      baseline(),
      hash,
    );
    expect(actual.rows.map(({ keyHash: _keyHash, ...item }) => item)).toEqual(
      original.rows,
    );
    expect(actual.missingPreviousKeyHashes).toEqual(
      original.missingPreviousKeys.map((key) => hash(config.sheet, key)),
    );
  },
);
