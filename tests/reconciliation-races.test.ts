// FR-EVD-009/012, NFR-REL-001/002: pure harness controls; not SQL execution evidence.
import { describe, expect, it, vi } from "vitest";
import {
  assertRaceSnapshot,
  assertHistoryDelta,
  verifyReconciliationRaces,
  assertProofTopology,
  normalizeReconciliationOutcome,
  selectReconciliationContributor,
} from "../scripts/acceptance/reconciliation-races.mjs";

const tables = [
  "MilestoneConsistencyAssessment",
  "MilestoneConsistencyTarget",
  "MilestoneConsistencyContributorVersion",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
  "FactAuthorityConflict",
  "MilestoneReconciliationRequest",
  "MilestoneReconciliationCheck",
  "MilestoneReconciliationAssignment",
  "AuditEvent",
];
const history = () =>
  Object.fromEntries(
    tables.map((t) => [t, { count: 2, sha256: "a".repeat(64) }]),
  );
const holder = { pid: 11, tag: "holder" };
const contenders = [
  { pid: 12, tag: "first" },
  { pid: 13, tag: "second" },
];
const activity = () => [
  {
    pid: 11,
    usename: "pdaa_api",
    application_name: "holder",
    state: "idle in transaction",
    wait_event_type: "Client",
    blockers: [],
  },
  {
    pid: 12,
    usename: "pdaa_api",
    application_name: "first",
    state: "active",
    wait_event_type: "Lock",
    blockers: [11],
  },
  {
    pid: 13,
    usename: "pdaa_api",
    application_name: "second",
    state: "active",
    wait_event_type: "Lock",
    blockers: [12],
  },
];

describe("observed reconciliation race receipt controls (not SQL evidence)", () => {
  it("accepts a concrete indirect blocker chain to the exact holder", () => {
    expect(() =>
      assertRaceSnapshot(activity(), holder, contenders, 10),
    ).not.toThrow();
  });
  it.each([
    [
      "wrong login role",
      (rows: ReturnType<typeof activity>) => {
        rows[1]!.usename = "pdaa_migrate";
      },
    ],
    [
      "wrong application tag",
      (rows: ReturnType<typeof activity>) => {
        rows[1]!.application_name = "other";
      },
    ],
    [
      "missing lock wait",
      (rows: ReturnType<typeof activity>) => {
        rows[1]!.wait_event_type = "Client";
      },
    ],
    [
      "already completed contender",
      (rows: ReturnType<typeof activity>) => {
        rows[1]!.state = "idle";
      },
    ],
    [
      "already completed holder",
      (rows: ReturnType<typeof activity>) => {
        rows[0]!.state = "idle";
      },
    ],
    [
      "unrelated blocker",
      (rows: ReturnType<typeof activity>) => {
        rows[1]!.blockers = [99];
      },
    ],
    [
      "cycle without holder",
      (rows: ReturnType<typeof activity>) => {
        rows[1]!.blockers = [13];
      },
    ],
    [
      "duplicate activity row",
      (rows: ReturnType<typeof activity>) => {
        rows[2] = { ...rows[1]! };
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const rows = activity();
    mutate(rows);
    expect(() => assertRaceSnapshot(rows, holder, contenders, 10)).toThrow();
  });
  it("rejects absent, extra, duplicate or observer-alias PIDs", () => {
    expect(() =>
      assertRaceSnapshot(activity().slice(0, 2), holder, contenders, 10),
    ).toThrow();
    expect(() =>
      assertRaceSnapshot(
        [...activity(), { ...activity()[0]!, pid: 99 }],
        holder,
        contenders,
        10,
      ),
    ).toThrow();
    expect(() =>
      assertRaceSnapshot(
        activity(),
        holder,
        [contenders[0], contenders[0]],
        10,
      ),
    ).toThrow();
    expect(() =>
      assertRaceSnapshot(activity(), holder, contenders, 12),
    ).toThrow();
  });
  it("accepts only the declared exact append delta", () => {
    const before = history(),
      after = history();
    after.MilestoneReconciliationAssignment = {
      count: 3,
      sha256: "b".repeat(64),
    };
    after.AuditEvent = { count: 3, sha256: "c".repeat(64) };
    expect(
      assertHistoryDelta(before, after, {
        MilestoneReconciliationAssignment: 1,
        AuditEvent: 1,
      }),
    ).toMatchObject({
      MilestoneReconciliationAssignment: 1,
      AuditEvent: 1,
      FactAuthorityConflict: 0,
    });
  });
  it("requires FactAuthorityConflict in both bounded fingerprints", () => {
    const before = history();
    delete before.FactAuthorityConflict;
    expect(() => assertHistoryDelta(before, history(), {})).toThrow();
    const after = history();
    delete after.FactAuthorityConflict;
    expect(() => assertHistoryDelta(history(), after, {})).toThrow();
  });
  it("rejects a changed existing footprint even if its count is unchanged", () => {
    const after = history();
    after.FactAssessment!.sha256 = "b".repeat(64);
    expect(() => assertHistoryDelta(history(), after, {})).toThrow();
  });
  it("rejects an extra durable receipt, unknown expectation, and malformed count", () => {
    const after = history();
    after.MilestoneReconciliationCheck!.count++;
    expect(() => assertHistoryDelta(history(), after, {})).toThrow();
    expect(() =>
      assertHistoryDelta(history(), history(), { MisspeltTable: 0 }),
    ).toThrow();
    const malformed = history();
    malformed.AuditEvent!.count = Number.NaN;
    expect(() => assertHistoryDelta(history(), malformed, {})).toThrow();
  });
  it("calls the real acceptance guard before constructing a connection or reserving a fixture", async () => {
    const guardError = new Error("not the controlled acceptance composition");
    const Pool = vi.fn(),
      createDatabase = vi.fn(),
      reserveFixture = vi.fn();
    await expect(
      verifyReconciliationRaces({
        allowRun: () => {
          throw guardError;
        },
        Pool,
        createDatabase,
        reserveFixture,
      } as never),
    ).rejects.toBe(guardError);
    expect(Pool).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(reserveFixture).not.toHaveBeenCalled();
  });
  it.each([
    { user: "pdaa_migrate", host: "database", database: "pdaa" },
    { user: "pdaa_api", host: "database" },
    { user: "pdaa_api", database: "pdaa" },
  ])(
    "rejects owner credentials or an implicit connection before any DB work: %o",
    async (connection) => {
      const Pool = vi.fn(),
        createDatabase = vi.fn(),
        reserveFixture = vi.fn();
      await expect(
        verifyReconciliationRaces({
          allowRun: () => undefined,
          connection,
          Pool,
          createDatabase,
          reserveFixture,
        } as never),
      ).rejects.toThrow();
      expect(Pool).not.toHaveBeenCalled();
      expect(createDatabase).not.toHaveBeenCalled();
      expect(reserveFixture).not.toHaveBeenCalled();
    },
  );
});

const id = (n: number) =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const topologyFixture = {
  projectId: id(1),
  milestoneId: id(2),
  canonicalBefore: [{ canonicalReceiptId: id(3) }],
};
const topology = () => ({
  canonicalProjectId: id(1),
  canonicalReceiptId: id(3),
  milestoneId: id(2),
  requiredWorkItems: [0, 1, 2].map((n) => ({
    id: id(20 + n),
    milestoneId: id(2),
    workItemId: id(10 + n),
  })),
  targets: [0, 1, 2, 3].map((n) => ({
    targetKind: n === 0 ? "MILESTONE" : "WORK_ITEM",
    targetId: n === 0 ? id(2) : id(9 + n),
    requiredWorkItemId: n === 0 ? null : id(19 + n),
    bindingId: id(40 + n * 5),
    factId: id(41 + n * 5),
    factType: "state-" + n,
    sourceId: id(42 + n * 5),
    versionId: id(43 + n * 5),
    evidenceId: id(44 + n * 5),
  })),
});
class FixtureProjectFactError extends Error {
  code: string;
  constructor(code: string) {
    super("Project fact operation rejected");
    this.name = "ProjectFactError";
    this.code = code;
  }
}

describe("original topology and rejection projections (not SQL evidence)", () => {
  it("accepts only the scoped one-milestone/three-required-work topology", () => {
    expect(() =>
      assertProofTopology(topology(), topologyFixture),
    ).not.toThrow();
  });
  it.each([
    [
      "other canonical project",
      (t: ReturnType<typeof topology>) => {
        t.canonicalProjectId = id(99);
      },
    ],
    [
      "other creation receipt",
      (t: ReturnType<typeof topology>) => {
        t.canonicalReceiptId = id(99);
      },
    ],
    [
      "other focal milestone",
      (t: ReturnType<typeof topology>) => {
        t.milestoneId = id(99);
      },
    ],
    [
      "other required milestone",
      (t: ReturnType<typeof topology>) => {
        t.requiredWorkItems[0]!.milestoneId = id(99);
      },
    ],
    [
      "missing required row",
      (t: ReturnType<typeof topology>) => {
        t.requiredWorkItems.pop();
      },
    ],
    [
      "duplicate required work",
      (t: ReturnType<typeof topology>) => {
        t.requiredWorkItems[1]!.workItemId = t.requiredWorkItems[0]!.workItemId;
      },
    ],
    [
      "missing target",
      (t: ReturnType<typeof topology>) => {
        t.targets.pop();
      },
    ],
    [
      "wrong required-link pairing",
      (t: ReturnType<typeof topology>) => {
        t.targets[1]!.requiredWorkItemId = t.targets[2]!.requiredWorkItemId;
      },
    ],
    [
      "wrong target kind",
      (t: ReturnType<typeof topology>) => {
        t.targets[0]!.targetKind = "WORK_ITEM";
      },
    ],
    [
      "duplicate source",
      (t: ReturnType<typeof topology>) => {
        t.targets[1]!.sourceId = t.targets[0]!.sourceId;
      },
    ],
    [
      "cross-kind identity alias",
      (t: ReturnType<typeof topology>) => {
        t.targets[1]!.versionId = t.targets[0]!.evidenceId;
      },
    ],
    [
      "invalid evidence identity",
      (t: ReturnType<typeof topology>) => {
        t.targets[1]!.evidenceId = "not-a-uuid";
      },
    ],
    [
      "unexpected hidden metadata",
      (t: ReturnType<typeof topology>) => {
        Object.assign(t.targets[0]!, {
          originalStatement: "must not be retained",
        });
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const value = topology();
    mutate(value);
    expect(() => assertProofTopology(value, topologyFixture)).toThrow();
  });
  it("selects an independent exact contributor copy bound to source, fact and project", () => {
    const value = topology(),
      selected = value.targets[0]!;
    const control = {
      projectId: value.canonicalProjectId,
      sourceId: selected.sourceId,
      factId: selected.factId,
    };
    const copy = selectReconciliationContributor(value, control);
    expect(copy).toEqual(selected);
    expect(copy).not.toBe(selected);
    for (const changed of [
      { projectId: id(99) },
      { sourceId: id(99) },
      { factId: id(99) },
    ]) {
      expect(() =>
        selectReconciliationContributor(value, { ...control, ...changed }),
      ).toThrow();
    }
  });
  it("retains the actual finite domain error fields, not stack, cause or other metadata", () => {
    const error = new FixtureProjectFactError("DENIED");
    Object.assign(error, {
      cause: new Error("private driver diagnostic"),
      connection: "private",
    });
    const copied = normalizeReconciliationOutcome(
      { status: "rejected", reason: error },
      FixtureProjectFactError,
    );
    expect(copied).toEqual({
      status: "rejected",
      error: {
        name: "ProjectFactError",
        code: "DENIED",
        message: "Project fact operation rejected",
      },
    });
    error.code = "REVISION_CONFLICT";
    expect(copied.error.code).toBe("DENIED");
    expect(
      normalizeReconciliationOutcome(
        { status: "rejected", reason: error },
        FixtureProjectFactError,
      ).error.code,
    ).toBe("REVISION_CONFLICT");
  });
  it("does not copy successful response contents into the status observation", () => {
    expect(
      normalizeReconciliationOutcome(
        { status: "fulfilled", value: { private: "proof content" } },
        FixtureProjectFactError,
      ),
    ).toEqual({ status: "fulfilled" });
  });
  it("rejects timeout errors and spoofed fields without accepting them as a domain instance", () => {
    const spoof = Object.assign(new Error("Project fact operation rejected"), {
      name: "ProjectFactError",
      code: "DENIED",
    });
    for (const reason of [
      new Error("query timeout"),
      spoof,
      {
        name: "ProjectFactError",
        code: "DENIED",
        message: "Project fact operation rejected",
      },
    ]) {
      expect(() =>
        normalizeReconciliationOutcome(
          { status: "rejected", reason },
          FixtureProjectFactError,
        ),
      ).toThrow();
    }
  });
  it("rejects changed name/code/message and unknown status without exposing unstable error text", () => {
    for (const change of [
      { name: "OtherError" },
      { code: "IDEMPOTENCY_CONFLICT" },
      { message: "private unexpected diagnostic" },
    ]) {
      const error = Object.assign(
        new FixtureProjectFactError("DENIED"),
        change,
      );
      expect(() =>
        normalizeReconciliationOutcome(
          { status: "rejected", reason: error },
          FixtureProjectFactError,
        ),
      ).toThrow(/Unexpected domain error/);
    }
    expect(() =>
      normalizeReconciliationOutcome(
        { status: "cancelled" },
        FixtureProjectFactError,
      ),
    ).toThrow("Unexpected settlement status");
  });
});
