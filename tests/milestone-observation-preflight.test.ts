import { describe, expect, it } from "vitest";
import type { Prisma } from "../packages/data/src/generated/prisma/client.js";
import { matchesMilestonePolicyHistory, matchesUnrankedFactPrefix, preflightMilestoneCanonicalProject as preflight, preflightMilestoneFactVersions, preflightMilestonePolicyHistory,
  preflightUnrankedFactPrefix } from "../packages/data/src/milestone-observation-preflight.js";

const customer = "10000000-0000-4000-8000-000000000002";
const project = "10000000-0000-4000-8000-000000000003";
const row = () => ({ sealed: true, projectReceipt: true, programmeReceipt: true,
  responsibilitiesCount: 0, sprintsCount: 0, milestonesCount: 1, workItemsCount: 0,
  requiredWorkItemsCount: 0, raidItemsCount: 0, sourceMappingsCount: 0,
  responsibilitiesActual: 0, sprintsActual: 0, milestonesActual: 1, workItemsActual: 0,
  requiredWorkItemsActual: 0, raidItemsActual: 0, sourceMappingsActual: 0 });
const tx = (rows: unknown[]) => ({ $queryRaw: async () => rows }) as unknown as Prisma.TransactionClient;

describe("canonical milestone preflight metadata", () => {
  it("accepts consistent bounded counts and rejects missing or unsealed project proofs", async () => {
    expect(await preflight(tx([row()]), customer, project)).toBe(true);
    for (const change of [{ sealed: false }, { projectReceipt: false }, { programmeReceipt: false },
      { sealed: null }, { projectReceipt: null }, { programmeReceipt: null }])
      expect(await preflight(tx([{ ...row(), ...change }]), customer, project)).toBe(false);
    expect(await preflight(tx([]), customer, project)).toBe(false);
  });
  it("rejects a changed count, sentinel overflow, invalid count and aggregate overflow", async () => {
    for (const change of [{ milestonesActual: 2 }, { milestonesActual: 51 },
      { milestonesCount: -1 }, { milestonesCount: 1.5 }])
      expect(await preflight(tx([{ ...row(), ...change }]), customer, project)).toBe(false);
    const large = { ...row(), responsibilitiesCount: 50, responsibilitiesActual: 50,
      sprintsCount: 50, sprintsActual: 50, milestonesCount: 50, milestonesActual: 50,
      workItemsCount: 50, workItemsActual: 50, raidItemsCount: 1, raidItemsActual: 1 };
    expect(await preflight(tx([large]), customer, project)).toBe(false);
    large.raidItemsCount = 0; large.raidItemsActual = 0;
    expect(await preflight(tx([large]), customer, project)).toBe(true);
  });
  it("propagates database failure to the authorized caller's error boundary", async () => {
    const failed = { $queryRaw: async () => { throw new Error("database failed"); } } as unknown as Prisma.TransactionClient;
    await expect(preflight(failed, customer, project)).rejects.toThrow("database failed");
  });
});

describe("milestone policy history metadata admission", () => {
  const scope = { customerId: customer, projectId: project, policyId: "policy-id", factType: "project.status", revision: 2 };
  const revision = (number: number) => ({ id: `policy-revision-${number}`, customerId: customer,
    projectId: project, policyId: scope.policyId, factType: scope.factType, revision: number,
    state: "ENABLED", definitionBytes: 25 as number | null });
  it("admits complete enabled and disabled history without selecting an event", async () => {
    const rows = [revision(1), { ...revision(2), state: "DISABLED", definitionBytes: null }];
    expect(await preflightMilestonePolicyHistory(tx(rows), scope)).toEqual(rows);
  });
  it("rejects gaps, duplicates, scope drift and inconsistent state/SQL-null combinations", async () => {
    const first = revision(1), second = revision(2);
    const cases = [[first], [first, revision(3)], [first, { ...second, id: first.id }],
      [first, { ...second, customerId: "other" }], [first, { ...second, projectId: "other" }],
      [first, { ...second, policyId: "other" }], [first, { ...second, factType: "other" }],
      [first, { ...second, state: "UNKNOWN" }], [first, { ...second, state: "DISABLED" }],
      [first, { ...second, definitionBytes: null }], [first, { ...second, definitionBytes: 0 }],
      [first, { ...second, definitionBytes: Number.NaN }]];
    for (const rows of cases) expect(await preflightMilestonePolicyHistory(tx(rows), scope)).toBeNull();
  });
  it("enforces history and aggregate byte limits using synthetic metadata", async () => {
    expect(await preflightMilestonePolicyHistory(tx([]), { ...scope, revision: 0 })).toBeNull();
    expect(await preflightMilestonePolicyHistory(tx([]), { ...scope, revision: 1001 })).toBeNull();
    const rows = [revision(1), { ...revision(2), definitionBytes: 4_194_279 }];
    expect(await preflightMilestonePolicyHistory(tx(rows), scope)).toEqual(rows);
    rows[1]!.definitionBytes!++;
    expect(await preflightMilestonePolicyHistory(tx(rows), scope)).toBeNull();
    const thousand = Array.from({ length: 1000 }, (_, i) => ({ ...revision(i + 1), state: "DISABLED", definitionBytes: null }));
    expect((await preflightMilestonePolicyHistory(tx(thousand), { ...scope, revision: 1000 }))?.length).toBe(1000);
    expect(await preflightMilestonePolicyHistory(tx([...thousand, revision(1001)]), { ...scope, revision: 1000 })).toBeNull();
  });
  it("compares the complete ordered policy identity and state after loading", () => {
    const expected = [revision(1), revision(2)];
    expect(matchesMilestonePolicyHistory(expected, expected.map((item) => ({ ...item })))).toBe(true);
    expect(matchesMilestonePolicyHistory(expected, [expected[0]!])).toBe(false);
    expect(matchesMilestonePolicyHistory(expected, [...expected, revision(3)])).toBe(false);
    expect(matchesMilestonePolicyHistory(expected, [expected[1]!, expected[0]!])).toBe(false);
    for (const change of [{ id: "other" }, { customerId: "other" }, { projectId: "other" },
      { policyId: "other" }, { factType: "other" }, { revision: 3 }, { state: "DISABLED" }])
      expect(matchesMilestonePolicyHistory(expected, [expected[0]!, { ...expected[1]!, ...change }])).toBe(false);
    expect(matchesMilestonePolicyHistory(new Array(1), [expected[0]!])).toBe(false);
    expect(matchesMilestonePolicyHistory([expected[0]!], new Array(1))).toBe(false);
  });
});

describe("unranked fact-prefix metadata admission", () => {
  const scope = { customerId: customer, projectId: project,
    factId: "10000000-0000-4000-8000-000000000004", factType: "canonical.state.00000000000040008000000000000002", revision: 2 };
  const version = (revision: number) => ({ id: `version-${revision}`, customerId: customer, projectId: project,
    factId: scope.factId, revision, evidenceId: `evidence-${revision}`, sourceId: `source-${revision}`, valueBytes: 10 });
  const queryResults = (results: unknown[][]) => {
    let index = 0;
    return { $queryRaw: async () => results[index++] } as unknown as Prisma.TransactionClient;
  };
  it("returns the exact complete prefix only with no policy or conflicts", async () => {
    const rows = [version(1), version(2)];
    expect(await preflightMilestoneFactVersions(queryResults([rows]), scope)).toEqual(rows);
    expect(await preflightUnrankedFactPrefix(queryResults([rows, [], []]), scope)).toEqual(rows);
    expect(await preflightUnrankedFactPrefix(queryResults([rows, [{ id: "policy" }]]), scope)).toBeNull();
    expect(await preflightUnrankedFactPrefix(queryResults([rows, [], [{ id: "conflict" }]]), scope)).toBeNull();
  });
  it("rejects missing, noncontiguous, duplicated and foreign-scope metadata", async () => {
    const cases = [[version(1)], [version(1), version(3)], [version(1), version(1)],
      [version(1), { ...version(2), id: version(1).id }],
      [version(1), { ...version(2), evidenceId: version(1).evidenceId }],
      [version(1), { ...version(2), customerId: "other" }],
      [version(1), { ...version(2), projectId: "other" }],
      [version(1), { ...version(2), factId: "other" }],
      [version(1), { ...version(2), sourceId: "" }]];
    for (const rows of cases) expect(await preflightUnrankedFactPrefix(queryResults([rows]), scope)).toBeNull();
  });
  it("enforces the revision and aggregate byte admission limits with synthetic metadata", async () => {
    expect(await preflightUnrankedFactPrefix(queryResults([]), { ...scope, revision: 0 })).toBeNull();
    expect(await preflightUnrankedFactPrefix(queryResults([]), { ...scope, revision: 1001 })).toBeNull();
    const rows = [version(1), { ...version(2), valueBytes: 1_048_566 }];
    expect(await preflightUnrankedFactPrefix(queryResults([rows, [], []]), scope)).toEqual(rows);
    rows[1]!.valueBytes++;
    expect(await preflightUnrankedFactPrefix(queryResults([rows]), scope)).toBeNull();
    rows[1]!.valueBytes = -1;
    expect(await preflightUnrankedFactPrefix(queryResults([rows]), scope)).toBeNull();
    rows[1]!.valueBytes = 0;
    expect(await preflightUnrankedFactPrefix(queryResults([rows]), scope)).toBeNull();
    rows[1]!.valueBytes = Number.NaN;
    expect(await preflightUnrankedFactPrefix(queryResults([rows]), scope)).toBeNull();
    const thousand = Array.from({ length: 1000 }, (_, i) => version(i + 1));
    expect((await preflightUnrankedFactPrefix(queryResults([thousand, [], []]), { ...scope, revision: 1000 }))?.length).toBe(1000);
    expect(await preflightUnrankedFactPrefix(queryResults([[...thousand, version(1001)]]), { ...scope, revision: 1000 })).toBeNull();
  });
  it("compares every preflight identity and revision against the complete ordered load", () => {
    const expected = [version(1), version(2)];
    expect(matchesUnrankedFactPrefix(expected, expected.map((row) => ({ ...row })))).toBe(true);
    expect(matchesUnrankedFactPrefix(expected, [expected[0]!])).toBe(false);
    expect(matchesUnrankedFactPrefix(expected, [...expected, version(3)])).toBe(false);
    expect(matchesUnrankedFactPrefix(expected, [expected[1]!, expected[0]!])).toBe(false);
    for (const change of [{ id: "other" }, { customerId: "other" }, { projectId: "other" },
      { factId: "other" }, { revision: 3 }, { sourceId: "other" }, { evidenceId: "other" }])
      expect(matchesUnrankedFactPrefix(expected, [expected[0]!, { ...expected[1]!, ...change }])).toBe(false);
    expect(matchesUnrankedFactPrefix([], [])).toBe(false);
    expect(matchesUnrankedFactPrefix(new Array(1), [expected[0]!])).toBe(false);
    expect(matchesUnrankedFactPrefix([expected[0]!], new Array(1))).toBe(false);
  });
});
