import { describe, expect, it } from "vitest";
import {
  assessTemporalFactHistory,
  type TemporalFactSnapshot,
} from "../packages/domain/src/index.js";

const id = (n: number) =>
  `abcdefab-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = (day: number) =>
  `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`;
const scope = {
  customerId: id(1),
  projectId: id(2),
  factId: id(3),
  factType: "milestone.status",
};
const dayMs = 86400000;
type Version = TemporalFactSnapshot["versions"][number];
const version = (n: number, overrides: Partial<Version> = {}): Version => ({
  id: id(n),
  scope: { ...scope },
  source: {
    instanceId: id(4),
    recordType: "milestone",
    recordId: "MS-1",
    revision: String(n),
  },
  value: { type: "text", value: "Complete" },
  provenance: "HUMAN_CONFIRMED",
  effectiveAt: time(1),
  observedAt: time(1),
  validUntil: time(10),
  evidenceIds: [id(900)],
  ...overrides,
});
const snapshot = (
  versions: Version[] = [version(10)],
): TemporalFactSnapshot => ({
  scope: { ...scope },
  asOf: time(5),
  validityPolicy: {
    revisionId: id(5),
    customerId: id(1),
    projectId: id(2),
    factType: scope.factType,
    validity: null,
  },
  versions,
  conflicts: [],
});
const conflict = (versionIds = [id(10), id(11)]) => ({
  id: id(700),
  scope: { ...scope },
  versionIds,
  detectedAt: time(2),
  resolvedAt: null,
});
const row = (result: ReturnType<typeof assessTemporalFactHistory>, n: number) =>
  result.versions.find((v) => v.id === id(n))!;

describe("FR-EVD-001/002/003/004/006/007/010/012: internal temporal history", () => {
  it("keeps values, source identity, both dates and evidence dependencies without an authority decision", () => {
    const input = snapshot();
    const out = assessTemporalFactHistory(input);
    expect(out.versions[0]).toMatchObject(input.versions[0]!);
    expect(row(out, 10)).toMatchObject({
      temporalApplicability: "APPLICABLE",
      assessment: {
        provenance: "HUMAN_CONFIRMED",
        freshness: "CURRENT",
        conflict: "NONE",
      },
    });
    expect(out.applicableVersionIds).toEqual([id(10)]);
    expect(out).not.toHaveProperty("settled");
    expect(out).not.toHaveProperty("authoritativeValue");
  });

  it("preserves a newer effective value when an older update arrives later", () => {
    const a = version(10, { effectiveAt: time(3), observedAt: time(3) });
    const b = version(11, {
      effectiveAt: time(2),
      observedAt: time(4),
      value: { type: "text", value: "Open" },
    });
    const out = assessTemporalFactHistory(snapshot([b, a]));
    expect(out.applicableVersionIds).toEqual([id(10)]);
    expect(row(out, 11).temporalApplicability).toBe("SUPERSEDED");
    expect(row(out, 11).value.value).toBe("Open");
  });

  it("uses observation time to order revisions with the same effective time", () => {
    const out = assessTemporalFactHistory(
      snapshot([version(10), version(11, { observedAt: time(2) })]),
    );
    expect(out.applicableVersionIds).toEqual([id(11)]);
  });

  it("does not use a future observation or future-effective revision to replace historical truth", () => {
    const input = snapshot([
      version(10),
      version(11, { observedAt: time(6), effectiveAt: time(3) }),
      version(12, { observedAt: time(4), effectiveAt: time(7) }),
    ]);
    const out = assessTemporalFactHistory(input);
    expect(out.applicableVersionIds).toEqual([id(10)]);
    expect(row(out, 11).temporalApplicability).toBe("NOT_YET_OBSERVED");
    expect(row(out, 12).temporalApplicability).toBe("NOT_YET_EFFECTIVE");
    expect(row(out, 11).assessment.freshness).toBe("UNKNOWN");
    expect(row(out, 12).assessment.freshness).toBe("UNKNOWN");
    input.asOf = time(6);
    expect(assessTemporalFactHistory(input).applicableVersionIds).toEqual([
      id(11),
    ]);
    input.asOf = time(7);
    expect(assessTemporalFactHistory(input).applicableVersionIds).toEqual([
      id(12),
    ]);
  });

  it("retains identical-time alternatives as ambiguous, independently of input order and identifier", () => {
    const input = snapshot([version(11), version(10)]);
    const out = assessTemporalFactHistory(input);
    expect(out.applicableVersionIds).toEqual([]);
    expect(out.ambiguousStreams).toEqual([
      {
        instanceId: id(4),
        recordType: "milestone",
        recordId: "MS-1",
        versionIds: [id(10), id(11)],
      },
    ]);
    expect(
      out.versions.every((v) => v.temporalApplicability === "AMBIGUOUS"),
    ).toBe(true);
    input.versions.reverse();
    expect(assessTemporalFactHistory(input)).toEqual(out);
  });

  it.each(["instanceId", "recordType", "recordId"] as const)(
    "separates streams by %s",
    (key) => {
      const second = version(11);
      second.source[key] = key === "instanceId" ? id(8) : "different";
      second.source.revision = "10";
      expect(
        assessTemporalFactHistory(snapshot([version(10), second]))
          .applicableVersionIds,
      ).toEqual([id(10), id(11)]);
    },
  );

  it("never revives an older revision when the latest version expires", () => {
    const out = assessTemporalFactHistory(
      snapshot([
        version(10, { validUntil: time(20) }),
        version(11, {
          effectiveAt: time(2),
          observedAt: time(2),
          validUntil: time(4),
        }),
      ]),
    );
    expect(out.applicableVersionIds).toEqual([id(11)]);
    expect(row(out, 11).assessment.freshness).toBe("STALE");
    expect(row(out, 10).temporalApplicability).toBe("SUPERSEDED");
  });

  it.each(["effectiveAt", "observedAt"] as const)(
    "uses the configured %s validity basis",
    (basis) => {
      const input = snapshot([
        version(10, { observedAt: time(3), validUntil: null }),
      ]);
      input.validityPolicy.validity = { basis, durationMs: 3 * dayMs };
      const out = assessTemporalFactHistory(input);
      expect(row(out, 10).assessedValidUntil).toBe(
        basis === "effectiveAt" ? time(4) : time(6),
      );
      expect(row(out, 10).assessment.freshness).toBe(
        basis === "effectiveAt" ? "STALE" : "CURRENT",
      );
    },
  );

  it("does not invent validity; source and configured deadlines can only shorten each other", () => {
    const input = snapshot([version(10, { validUntil: null })]);
    expect(row(assessTemporalFactHistory(input), 10).assessment.freshness).toBe(
      "UNKNOWN",
    );
    input.versions[0]!.validUntil = time(10);
    input.validityPolicy.validity = { basis: "observedAt", durationMs: dayMs };
    expect(row(assessTemporalFactHistory(input), 10).assessedValidUntil).toBe(
      time(2),
    );
    input.validityPolicy.validity.durationMs = 20 * dayMs;
    expect(row(assessTemporalFactHistory(input), 10).assessedValidUntil).toBe(
      time(10),
    );
  });

  it("expires exactly at the deadline", () => {
    const input = snapshot([version(10, { validUntil: time(5) })]);
    input.asOf = new Date(Date.parse(time(5)) - 1).toISOString();
    expect(row(assessTemporalFactHistory(input), 10).assessment.freshness).toBe(
      "CURRENT",
    );
    input.asOf = time(5);
    expect(row(assessTemporalFactHistory(input), 10).assessment.freshness).toBe(
      "STALE",
    );
  });

  it("retains human origin and an unresolved conflict after expiry and supersession", () => {
    const input = snapshot([
      version(10, { validUntil: time(2) }),
      version(11, {
        effectiveAt: time(2),
        observedAt: time(2),
        provenance: "SYSTEM_VERIFIED",
        value: { type: "text", value: "Open" },
      }),
    ]);
    input.conflicts = [conflict()];
    const out = assessTemporalFactHistory(input);
    expect(row(out, 10)).toMatchObject({
      temporalApplicability: "SUPERSEDED",
      unresolvedConflictIds: [id(700)],
      assessment: {
        provenance: "HUMAN_CONFIRMED",
        freshness: "STALE",
        conflict: "CONFLICTING",
        classification: "CONFLICTING",
      },
    });
    expect(row(out, 11).assessment.conflict).toBe("CONFLICTING");
  });

  it("applies conflict detection and resolution at the requested historical time", () => {
    const input = snapshot([version(10), version(11)]);
    input.conflicts = [
      { ...conflict(), detectedAt: time(3), resolvedAt: time(6) },
    ];
    for (const [day, expected] of [
      [2, "NONE"],
      [3, "CONFLICTING"],
      [5, "CONFLICTING"],
      [6, "NONE"],
    ] as const) {
      input.asOf = time(day);
      expect(
        row(assessTemporalFactHistory(input), 10).assessment.conflict,
      ).toBe(expected);
    }
  });

  it("freezes detached nested values, evidence and policy while later input changes leave historical output intact", () => {
    const input = snapshot();
    const before = structuredClone(input);
    const out = assessTemporalFactHistory(input);
    const saved = JSON.stringify(out);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input.versions[0]!.value)).toBe(false);
    input.versions[0]!.value = { type: "text", value: "Changed" };
    input.versions[0]!.evidenceIds.push(id(901));
    input.validityPolicy.revisionId = id(999);
    input.asOf = time(20);
    expect(JSON.stringify(out)).toBe(saved);
    expect(Object.isFrozen(out.versions[0]!.value)).toBe(true);
    expect(Object.isFrozen(out.versions[0]!.evidenceIds)).toBe(true);
    expect(Object.isFrozen(out.validityPolicy)).toBe(true);
    expect(() =>
      Reflect.set(out.versions[0]!.value, "value", "Tampered"),
    ).not.toThrow();
    expect(JSON.stringify(out)).toBe(saved);
    expect(row(assessTemporalFactHistory(input), 10).assessment.freshness).toBe(
      "STALE",
    );
  });

  it.each([
    "SYSTEM_VERIFIED",
    "HUMAN_CONFIRMED",
    "AGENT_INFERENCE",
    "UNKNOWN",
  ] as const)("preserves %s origin when freshness is unknown", (provenance) => {
    const out = assessTemporalFactHistory(
      snapshot([version(10, { provenance, validUntil: null })]),
    );
    expect(row(out, 10).assessment).toMatchObject({
      provenance,
      freshness: "UNKNOWN",
      classification: "UNKNOWN",
    });
  });

  it.each([
    { type: "text", value: "" },
    { type: "number", value: 12.5 },
    { type: "boolean", value: false },
    { type: "date", value: "2024-02-29" },
    { type: "empty", value: null },
  ] as const)("retains a typed $type value losslessly", (value) => {
    expect(
      row(assessTemporalFactHistory(snapshot([version(10, { value })])), 10)
        .value,
    ).toEqual(value);
  });

  it("accepts an empty history without inventing a version", () => {
    const out = assessTemporalFactHistory(snapshot([]));
    expect(out.versions).toEqual([]);
    expect(out.applicableVersionIds).toEqual([]);
  });

  const invalid: [string, (input: TemporalFactSnapshot) => void][] = [
    [
      "uppercase version ID",
      (s) => {
        s.versions[0]!.id = id(10).toUpperCase();
      },
    ],
    [
      "uppercase source instance",
      (s) => {
        s.versions[0]!.source.instanceId = id(4).toUpperCase();
      },
    ],
    [
      "uppercase evidence ID",
      (s) => {
        s.versions[0]!.evidenceIds = [id(900).toUpperCase()];
      },
    ],
    [
      "uppercase policy revision",
      (s) => {
        s.validityPolicy.revisionId = id(5).toUpperCase();
      },
    ],
    [
      "uppercase conflict ID",
      (s) => {
        s.versions.push(version(11));
        s.conflicts = [{ ...conflict(), id: id(700).toUpperCase() }];
      },
    ],
    [
      "UUID case split across duplicate source revisions",
      (s) => {
        const v = version(11);
        v.source.instanceId = id(4).toUpperCase();
        v.source.revision = "10";
        s.versions.push(v);
      },
    ],
    [
      "UUID case split across duplicate evidence",
      (s) => {
        s.versions[0]!.evidenceIds.push(id(900).toUpperCase());
      },
    ],
    [
      "cross-customer version",
      (s) => {
        s.versions[0]!.scope.customerId = id(999);
      },
    ],
    [
      "cross-project version",
      (s) => {
        s.versions[0]!.scope.projectId = id(999);
      },
    ],
    [
      "different fact",
      (s) => {
        s.versions[0]!.scope.factId = id(999);
      },
    ],
    [
      "different fact type",
      (s) => {
        s.versions[0]!.scope.factType = "another.field";
      },
    ],
    [
      "wrong policy customer",
      (s) => {
        s.validityPolicy.customerId = id(999);
      },
    ],
    [
      "wrong policy project",
      (s) => {
        s.validityPolicy.projectId = id(999);
      },
    ],
    [
      "wrong policy fact type",
      (s) => {
        s.validityPolicy.factType = "another.field";
      },
    ],
    [
      "duplicate version ID",
      (s) => {
        s.versions.push(version(10));
      },
    ],
    [
      "duplicate source revision",
      (s) => {
        const v = version(11);
        v.source.revision = "10";
        s.versions.push(v);
      },
    ],
    [
      "missing evidence",
      (s) => {
        s.versions[0]!.evidenceIds = [];
      },
    ],
    [
      "duplicate evidence",
      (s) => {
        s.versions[0]!.evidenceIds.push(id(900));
      },
    ],
    [
      "expiry before effect",
      (s) => {
        s.versions[0]!.validUntil = "2026-08-31T12:00:00.000Z";
      },
    ],
    [
      "calendar rollover",
      (s) => {
        s.asOf = "2026-02-30T12:00:00.000Z";
      },
    ],
    [
      "noncanonical offset",
      (s) => {
        s.asOf = "2026-09-05T12:00:00+00:00";
      },
    ],
    [
      "invalid time",
      (s) => {
        s.versions[0]!.observedAt = "invalid";
      },
    ],
    [
      "infinite number",
      (s) => {
        s.versions[0]!.value = { type: "number", value: Infinity };
      },
    ],
    [
      "invalid date value",
      (s) => {
        s.versions[0]!.value = { type: "date", value: "2026-02-29" };
      },
    ],
    [
      "oversized value",
      (s) => {
        s.versions[0]!.value = { type: "text", value: "x".repeat(4097) };
      },
    ],
    [
      "zero duration",
      (s) => {
        s.validityPolicy.validity = { basis: "observedAt", durationMs: 0 };
      },
    ],
    [
      "date overflow",
      (s) => {
        s.validityPolicy.validity = {
          basis: "observedAt",
          durationMs: Number.MAX_SAFE_INTEGER,
        };
      },
    ],
    [
      "duplicate conflict",
      (s) => {
        s.versions.push(version(11));
        s.conflicts = [conflict(), conflict()];
      },
    ],
    [
      "unknown conflict version",
      (s) => {
        s.conflicts = [conflict()];
      },
    ],
    [
      "cross-project conflict",
      (s) => {
        s.versions.push(version(11));
        s.conflicts = [conflict()];
        s.conflicts[0]!.scope.projectId = id(999);
      },
    ],
    [
      "duplicate conflict reference",
      (s) => {
        s.conflicts = [conflict([id(10), id(10)])];
      },
    ],
    [
      "conflict before observation",
      (s) => {
        s.versions.push(version(11, { observedAt: time(3) }));
        s.conflicts = [conflict()];
      },
    ],
    [
      "conflict before effect",
      (s) => {
        s.versions.push(version(11, { effectiveAt: time(3) }));
        s.conflicts = [conflict()];
      },
    ],
    [
      "resolution before detection",
      (s) => {
        s.versions.push(version(11));
        s.conflicts = [{ ...conflict(), resolvedAt: time(1) }];
      },
    ],
    [
      "too many versions",
      (s) => {
        s.versions = Array.from({ length: 1001 }, (_, i) => version(i + 10));
      },
    ],
  ];
  it.each(invalid)(
    "rejects %s with a fixed content-free error",
    (_, mutate) => {
      const input = snapshot();
      mutate(input);
      expect(() => assessTemporalFactHistory(input)).toThrow(
        /^Invalid temporal fact snapshot$/,
      );
    },
  );

  it.each(["authorized", "settled", "selectedValue"])(
    "rejects a caller %s assertion",
    (field) => {
      expect(() =>
        assessTemporalFactHistory({ ...snapshot(), [field]: true }),
      ).toThrow("Invalid temporal fact snapshot");
    },
  );
});
