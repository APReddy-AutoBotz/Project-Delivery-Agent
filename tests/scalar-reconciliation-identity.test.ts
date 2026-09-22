import { describe, expect, it } from "vitest";
import {
  resolveSourceAuthority,
  scalarReconciliationIdentity,
  type SourceAuthoritySnapshot,
} from "../packages/domain/src/index.js";
import {
  scalarId as id,
  scalarSnapshot,
  scalarScope,
  scalarTime,
} from "./fixtures/scalar-reconciliation.js";

const identity = (input = scalarSnapshot()) =>
  scalarReconciliationIdentity(resolveSourceAuthority(input));
describe("FR-EVD-007/009/012 / FR-ADM-005: scalar conflict identity", () => {
  it("serializes the exact revisioned ASCII tuple without changing the frozen proof", () => {
    const result = resolveSourceAuthority(scalarSnapshot());
    const before = JSON.stringify(result);
    expect(scalarReconciliationIdentity(result)).toBe(
      JSON.stringify([
        "scalar-authority-conflict/v1",
        id(1),
        id(2),
        id(3),
        id(5),
        [
          [id(10), id(110), "date", [id(210)]],
          [id(11), id(111), "date", [id(211)]],
        ],
      ]),
    );
    expect(JSON.stringify(result)).toBe(before);
    expect(result.resolvedValue).toBeNull();
  });
  it("ignores input order, new capture time and duplicate recorded conflict representation", () => {
    const input = scalarSnapshot(),
      original = identity(input);
    input.versions.reverse();
    input.sources.reverse();
    input.evidence.reverse();
    input.asOf = "2026-09-14T00:00:00.000Z";
    input.conflicts.push({
      id: id(20),
      scope: scalarScope,
      detectedAt: scalarTime,
      resolvedAt: null,
      versionIds: [id(11), id(10)],
    });
    expect(identity(input)).toBe(original);
    const result = structuredClone(resolveSourceAuthority(input));
    result.conflicts.reverse();
    for (const conflict of result.conflicts) {
      conflict.versionIds.reverse();
      conflict.evidenceIds.reverse();
    }
    expect(scalarReconciliationIdentity(result)).toBe(original);
  });
  it.each(["policy", "version", "source", "evidence", "type"])(
    "changes identity for changed %s binding",
    (kind) => {
      const input = scalarSnapshot(),
        original = identity(input);
      if (kind === "policy") input.policy!.revisionId = id(50);
      if (kind === "version") input.versions[0]!.id = id(50);
      if (kind === "source") {
        input.versions[0]!.source.instanceId = id(50);
        input.sources[0]!.instanceId = id(50);
      }
      if (kind === "evidence") {
        input.versions[0]!.evidenceIds = [id(50)];
        input.evidence[0]!.id = id(50);
      }
      if (kind === "type")
        input.versions[0]!.value = { type: "text", value: "2026-10-01" };
      expect(identity(input)).not.toBe(original);
    },
  );
  it.each([
    { type: "text", value: '非ASCII "quotes" \\ \n' },
    { type: "number", value: 1e-100 },
    { type: "number", value: 1e100 },
    { type: "number", value: -0 },
    { type: "boolean", value: false },
    { type: "empty", value: null },
  ] as const)(
    "does not serialize arbitrary original typed content %j",
    (value) => {
      const input = scalarSnapshot();
      input.versions[0]!.value = value;
      const result = resolveSourceAuthority(input),
        key = scalarReconciliationIdentity(result)!;
      expect(key).toMatch(/^[\x20-\x7e]+$/);
      expect(JSON.parse(key)[5][0]).toEqual([
        id(10),
        id(110),
        value.type,
        [id(210)],
      ]);
      expect(result.versions[0]).toMatchObject({ value });
    },
  );
  it.each([
    "retain",
    "missing",
    "future",
    "incomplete",
    "restricted",
    "resolved",
    "unknown",
  ])("returns no identity for valid %s output", (kind) => {
    const input = scalarSnapshot();
    if (kind === "retain") input.policy!.conflictBehavior = "RETAIN_CONFLICT";
    if (kind === "missing") input.policy = null;
    if (kind === "future")
      input.policy!.effectiveAt = "2026-10-01T00:00:00.000Z";
    if (kind === "incomplete") input.complete = false;
    if (kind === "restricted") input.evidence[0]!.access = "RESTRICTED";
    if (kind === "resolved")
      input.versions[1]!.value = input.versions[0]!.value;
    if (kind === "unknown") {
      input.versions = [];
      input.sources = [];
      input.evidence = [];
    }
    expect(identity(input)).toBeNull();
  });
  it("keeps stale recorded contributors eligible", () => {
    const input = scalarSnapshot(),
      original = identity(input);
    input.asOf = "2026-10-02T00:00:00.000Z";
    input.conflicts = [
      {
        id: id(20),
        scope: scalarScope,
        detectedAt: scalarTime,
        resolvedAt: null,
        versionIds: [id(10), id(11)],
      },
    ];
    const result = resolveSourceAuthority(input);
    expect(result.candidateVersionIds).toEqual([]);
    expect(scalarReconciliationIdentity(result)).toBe(original);
  });
  it("returns no identity for an evaluator-produced ambiguous stream even when values agree", () => {
    const input = scalarSnapshot();
    input.versions[1]!.source = {
      ...input.versions[0]!.source,
      revision: "2",
    };
    input.versions[1]!.value = input.versions[0]!.value;
    input.sources = [input.sources[0]!];
    const result = resolveSourceAuthority(input);
    expect(result).toMatchObject({
      status: "AMBIGUOUS",
      resolvedValue: null,
      reconciliationRequired: false,
      conflicts: [],
    });
    expect(scalarReconciliationIdentity(result)).toBeNull();
  });
  it.each([true, false])(
    "accepts exactly 64,000 aggregate conflict evidence references (eligible=%s)",
    (eligible) => {
      const input = scalarSnapshot();
      input.evidence = [];
      for (const [index, version] of input.versions.entries()) {
        version.evidenceIds = Array.from({ length: 64 }, (_, n) =>
          id(1000 + index * 64 + n),
        );
        input.evidence.push(
          ...version.evidenceIds.map((evidenceId) => ({
            id: evidenceId,
            scope: scalarScope,
            access: "AUTHORIZED" as const,
            verification: "VALID" as const,
          })),
        );
      }
      input.complete = eligible;
      const result = structuredClone(resolveSourceAuthority(input));
      expect(result.status).toBe(eligible ? "CONFLICTING" : "INCOMPLETE");
      const original = scalarReconciliationIdentity(result);
      expect(original === null).toBe(!eligible);
      // Identity preflight only: repeated output groups are not a claim that a
      // native 64-evidence-per-version ledger or the 4 MiB ceiling was reached.
      result.conflicts = Array.from({ length: 500 }, () =>
        structuredClone(result.conflicts[0]!),
      );
      expect(
        result.conflicts.reduce((n, c) => n + c.evidenceIds.length, 0),
      ).toBe(64000);
      expect(scalarReconciliationIdentity(result)).toBe(original);
      result.conflicts.push(structuredClone(result.conflicts[0]!));
      let accesses = 0;
      Object.defineProperty(result.conflicts[0]!.evidenceIds, "0", {
        get() {
          accesses++;
          throw new Error("unbounded evidence traversal");
        },
      });
      expect(() => scalarReconciliationIdentity(result)).toThrow(
        "Invalid scalar reconciliation assessment",
      );
      expect(accesses).toBe(0);
    },
  );
  it("supports 1002 bounded output groups, including recorded/derived duplicates", () => {
    const result = structuredClone(resolveSourceAuthority(scalarSnapshot()));
    result.conflicts = Array.from({ length: 1002 }, () =>
      structuredClone(result.conflicts[0]!),
    );
    expect(scalarReconciliationIdentity(result)).toBe(identity());
  });
  it.each([
    "unknown-version",
    "missing-evidence",
    "duplicate-version",
    "duplicate-evidence",
    "wrong-scope",
    "uppercase",
    "flag",
    "empty-conflict",
    "over-groups",
  ])("rejects malformed %s with one finite error", (kind) => {
    const result = structuredClone(resolveSourceAuthority(scalarSnapshot()));
    if (kind === "unknown-version") result.conflicts[0]!.versionIds[0] = id(99);
    if (kind === "missing-evidence") result.conflicts[0]!.evidenceIds.pop();
    if (kind === "duplicate-version") result.versions.push(result.versions[0]!);
    if (kind === "duplicate-evidence")
      result.versions[0]!.evidenceIds.push(result.versions[0]!.evidenceIds[0]!);
    if (
      kind === "wrong-scope" &&
      result.versions[0]!.visibility === "available"
    )
      result.versions[0]!.scope.factId = id(99);
    if (kind === "uppercase")
      result.scope.factId = result.scope.factId.toUpperCase();
    if (kind === "flag") result.reconciliationRequired = false;
    if (kind === "empty-conflict") result.conflicts = [];
    if (kind === "over-groups")
      result.conflicts = Array(1003).fill(result.conflicts[0]);
    expect(() => scalarReconciliationIdentity(result)).toThrow(
      "Invalid scalar reconciliation assessment",
    );
  });
  it("bounds arrays before parsing their contents, even for negative outcomes", () => {
    const result = {
      ...resolveSourceAuthority(scalarSnapshot()),
      complete: false,
      versions: new Array(1001),
    };
    let accesses = 0;
    Object.defineProperty(result.versions, "0", {
      get() {
        accesses++;
        throw new Error("unbounded traversal");
      },
    });
    expect(() => scalarReconciliationIdentity(result)).toThrow(
      "Invalid scalar reconciliation assessment",
    );
    expect(accesses).toBe(0);
  });
  it("includes all evidence references in sorted unique contributor tuples", () => {
    const input: SourceAuthoritySnapshot = scalarSnapshot();
    input.versions[0]!.evidenceIds.push(id(199));
    input.evidence.push({
      id: id(199),
      scope: scalarScope,
      access: "AUTHORIZED",
      verification: "VALID",
    });
    expect(JSON.parse(identity(input)!)[5][0][3]).toEqual([id(199), id(210)]);
  });
  it("unions disjoint and overlapping groups instead of selecting the first pair", () => {
    const input = scalarSnapshot();
    for (const n of [12, 13]) {
      const version = structuredClone(input.versions[0]!);
      version.id = id(n);
      version.source.instanceId = id(n + 100);
      version.evidenceIds = [id(n + 200)];
      input.versions.push(version);
      input.sources.push({ instanceId: id(n + 100), sourceType: "portfolio" });
      input.evidence.push({
        id: id(n + 200),
        scope: scalarScope,
        access: "AUTHORIZED",
        verification: "VALID",
      });
    }
    input.conflicts = [
      [10, 11],
      [12, 13],
      [11, 12],
    ].map((pair, index) => ({
      id: id(50 + index),
      scope: scalarScope,
      detectedAt: scalarTime,
      resolvedAt: null,
      versionIds: pair.map(id),
    }));
    const original = identity(input)!;
    expect(JSON.parse(original)[5].map((tuple: string[]) => tuple[0])).toEqual(
      [10, 11, 12, 13].map(id),
    );
    input.conflicts.reverse();
    input.versions.reverse();
    expect(identity(input)).toBe(original);
  });
});
