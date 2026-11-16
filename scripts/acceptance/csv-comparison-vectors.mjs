// FR-CON-006/007/012 / NFR-SEC-001: synthetic pure-SQL prototype controls.
const uuid = (index) =>
  "00000000-0000-4000-8000-" + index.toString(16).padStart(12, "0");
export function csvStateVector() {
  return [
    "pdaa.csv.state.v1",
    uuid(1),
    uuid(2),
    "1",
    [
      ["project.forecast", "date"],
      ["project.status", "text"],
    ],
    [
      [
        "a".repeat(64),
        uuid(16),
        uuid(3),
        [
          ["0", uuid(32)],
          ["1", uuid(33)],
        ],
      ],
    ],
  ];
}
export function maximumCsvStateVector() {
  const state = csvStateVector();
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
export function csvPositiveVectors() {
  const empty = csvStateVector();
  empty[5] = [];
  const zeroFields = csvStateVector();
  zeroFields[5][0][3] = [];
  const numeric = csvStateVector();
  numeric[4] = Array.from({ length: 11 }, (_, i) => [
    "field." + String(i).padStart(2, "0"),
    "text",
  ]);
  numeric[5][0][3] = [
    ["2", uuid(32)],
    ["10", uuid(33)],
  ];
  return [
    {
      name: "empty",
      state: empty,
      bytes: 162,
      digest:
        "8838197404eeea2374fac6f83e03704340884e543b2c55642630ab1be0cbbfab",
    },
    {
      name: "two-fields",
      state: csvStateVector(),
      bytes: 400,
      digest:
        "d79544a42b54cb5484e6991b0e70b3d66152618e557214876711039a835a0bd6",
    },
    { name: "zero-fields", state: zeroFields },
    { name: "numeric-index-order", state: numeric },
    { name: "maximum", state: maximumCsvStateVector(), bytes: 1614668 },
  ];
}
export function csvNativeCorruptions() {
  const cases = [];
  const add = (name, mutate, create = csvStateVector) => {
    const state = create();
    mutate(state);
    cases.push({ name, state });
  };
  for (const [name, index] of [
    ["customer", 1],
    ["source", 2],
    ["mapping", 3],
  ])
    add(name + "-sql-null", (s) => {
      s[index] = null;
    });
  for (const value of ["0", "-1"])
    add("mapping-" + value, (s) => {
      s[3] = value;
    });
  for (const [name, value] of [
    ["sql-null", undefined],
    ["json-null", null],
    ["object", {}],
    ["scalar", 1],
  ]) {
    add("dictionary-" + name, (s) => {
      s[4] = value;
    });
    add("rows-" + name, (s) => {
      s[5] = value;
    });
  }
  add("dictionary-empty", (s) => {
    s[4] = [];
  });
  for (const [name, value] of [
    ["null", null],
    ["object", {}],
    ["scalar", 1],
    ["short", ["project.forecast"]],
    ["extra", ["project.forecast", "date", "private"]],
  ])
    add("dictionary-entry-" + name, (s) => {
      s[4][0] = value;
    });
  for (const [name, value] of [
    ["null", null],
    ["number", 1],
    ["empty", ""],
    ["long", "a".repeat(97)],
    ["unicode", "project.café"],
    ["space", "project. forecast"],
    ["digit", "1fact"],
    ["uppercase", "Project.forecast"],
    ["escape", 'project."x'],
    ["tab", "project.\tx"],
  ])
    add("fact-" + name, (s) => {
      s[4][0][0] = value;
    });
  for (const [name, value] of [
    ["unknown", "json"],
    ["case", "Date"],
    ["null", null],
    ["number", 1],
  ])
    add("type-" + name, (s) => {
      s[4][0][1] = value;
    });
  add("dictionary-duplicate", (s) => {
    s[4][1][0] = s[4][0][0];
  });
  add("dictionary-unsorted", (s) => {
    s[4].reverse();
  });
  for (const [name, value] of [
    ["null", null],
    ["object", {}],
    ["scalar", 1],
  ])
    add("row-" + name, (s) => {
      s[5][0] = value;
    });
  add("row-short", (s) => {
    s[5][0].pop();
  });
  add("row-extra", (s) => {
    s[5][0].push("private");
  });
  for (const [name, value] of [
    ["null", null],
    ["number", 1],
    ["short", "a".repeat(63)],
    ["long", "a".repeat(65)],
    ["raw", "ROW-1"],
    ["uppercase", "A".repeat(64)],
  ])
    add("hash-" + name, (s) => {
      s[5][0][0] = value;
    });
  for (const [kind, index] of [
    ["record", 1],
    ["project", 2],
  ])
    for (const [name, value] of [
      ["null", null],
      ["number", 1],
      ["invalid", "x".repeat(36)],
      ["uppercase", "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"],
      ["short", "record"],
    ])
      add(kind + "-" + name, (s) => {
        s[5][0][index] = value;
      });
  for (const [name, value] of [
    ["null", null],
    ["object", {}],
    ["scalar", 1],
  ])
    add("references-" + name, (s) => {
      s[5][0][3] = value;
    });
  for (const [name, value] of [
    ["null", null],
    ["object", {}],
    ["scalar", 1],
    ["short", ["0"]],
    ["extra", ["0", uuid(32), "private"]],
  ])
    add("reference-" + name, (s) => {
      s[5][0][3][0] = value;
    });
  for (const [name, value] of [
    ["null", null],
    ["number", 0],
    ["empty", ""],
    ["leading-zero", "00"],
    ["exponent", "0e0"],
    ["negative", "-1"],
    ["long", "100"],
    ["unknown", "2"],
  ])
    add("index-" + name, (s) => {
      s[5][0][3][0][0] = value;
    });
  for (const [name, value] of [
    ["null", null],
    ["number", 1],
    ["invalid", "x".repeat(36)],
    ["uppercase", "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"],
    ["short", "projection"],
  ])
    add("projection-" + name, (s) => {
      s[5][0][3][0][1] = value;
    });
  add("index-duplicate", (s) => {
    s[5][0][3][1][0] = "0";
  });
  add("index-unsorted", (s) => {
    s[5][0][3].reverse();
  });
  add("key-duplicate", (s) => {
    const r = globalThis.structuredClone(s[5][0]);
    r[1] = uuid(17);
    s[5].push(r);
  });
  add("key-unsorted", (s) => {
    const r = globalThis.structuredClone(s[5][0]);
    r[0] = "0".repeat(64);
    r[1] = uuid(17);
    s[5].push(r);
  });
  add("record-duplicate", (s) => {
    const r = globalThis.structuredClone(s[5][0]);
    r[0] = "b".repeat(64);
    s[5].push(r);
  });
  const suffixes = ["\n", "\r", "\r\n", "\u2028", "\u2029"];
  const tokens = [
    [
      "fact",
      (s, suffix) => {
        s[4][0][0] += suffix;
      },
    ],
    [
      "hash",
      (s, suffix) => {
        s[5][0][0] += suffix;
      },
    ],
    [
      "record",
      (s, suffix) => {
        s[5][0][1] += suffix;
      },
    ],
    [
      "project",
      (s, suffix) => {
        s[5][0][2] += suffix;
      },
    ],
    [
      "index",
      (s, suffix) => {
        s[5][0][3][0][0] += suffix;
      },
    ],
    [
      "projection",
      (s, suffix) => {
        s[5][0][3][0][1] += suffix;
      },
    ],
  ];
  for (const [name, mutate] of tokens)
    suffixes.forEach((suffix, i) =>
      add(name + "-separator-" + i, (s) => mutate(s, suffix)),
    );
  add(
    "identities-bound",
    (s) => {
      s[5].push(["f".repeat(64), uuid(30000), uuid(10000), []]);
    },
    maximumCsvStateVector,
  );
  add(
    "dictionary-bound",
    (s) => {
      s[4].push(["zzzz", "text"]);
    },
    maximumCsvStateVector,
  );
  add(
    "references-bound",
    (s) => {
      s[5][0][3].push(["32", uuid(30001)]);
    },
    maximumCsvStateVector,
  );
  add(
    "projects-bound",
    (s) => {
      s[5][100][2] = uuid(30002);
    },
    maximumCsvStateVector,
  );
  return cases;
}

// These fail casts/JSON input conversion before function entry, unlike the
// dictionary/row grammar denials above. UUID/revision normalization is separate.
export function csvNativeCastDenials() {
  return [
    {
      name: "customer-cast",
      mutate: (s) => {
        s[1] = "not-a-uuid";
      },
      sqlstate: "22P02",
    },
    {
      name: "source-cast",
      mutate: (s) => {
        s[2] = "not-a-uuid";
      },
      sqlstate: "22P02",
    },
    {
      name: "mapping-cast",
      mutate: (s) => {
        s[3] = "1e3";
      },
      sqlstate: "22P02",
    },
    {
      name: "mapping-overflow",
      mutate: (s) => {
        s[3] = "2147483648";
      },
      sqlstate: "22003",
    },
    {
      name: "json-nul",
      mutate: (s) => {
        s[4][0][0] = "project.\0forecast";
      },
      sqlstate: "22P05",
    },
  ].map(({ name, mutate, sqlstate }) => {
    const state = csvStateVector();
    mutate(state);
    return { name, state, sqlstate };
  });
}
