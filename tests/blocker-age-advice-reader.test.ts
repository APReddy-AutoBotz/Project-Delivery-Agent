import { afterEach, expect, it, vi } from "vitest";
import { buildBlockerAgeAssessmentInTransaction } from "../packages/data/src/blocker-age-assessment.js";
import { DatabaseAuthorityRepository } from "../packages/data/src/authority-persistence.js";
import { DatabaseBlockerAgeAdviceRepository } from "../packages/data/src/blocker-age-advice.js";
import * as assessment from "../packages/data/src/blocker-age-assessment.js";
import { possibleMutation, rawSqlText } from "./fixtures/read-only-sql.js";

const actor = { customerId: "10000000-0000-4000-8000-000000000001", subject: "synthetic-pm", roles: ["project_manager"] };
const projectId = "20000000-0000-4000-8000-000000000001";
const asOf = new Date("2026-10-21T12:00:00.000Z");
const threshold = { minimumBlockerAgeDays: 5, auditRetentionHours: 720, revision: 1, changedBy: "synthetic-admin", changedAt: asOf };
function transaction() {
  return { $queryRawUnsafe: vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT id,key,kind,state FROM public."RaidItem"')) return [];
    if (sql.startsWith('SELECT id,"factType",revision FROM public."ProjectFact"'))
      return [{ id: "30000000-0000-4000-8000-000000000001", factType: "project.open_blocker_inventory_complete", revision: 1 }];
    if (sql.includes('FROM public."ProjectFactVersion"') || sql.includes('FROM public."FactAuthorityConflict"') ||
        sql.includes('FROM public."AuthorityPolicy"') || sql.includes('FROM public."AuthorityPolicyRevision"')) return [];
    throw new Error("Unexpected fake query");
  }) };
}
afterEach(() => vi.restoreAllMocks());

it("detects raw SQL mutations including data-changing CTEs without flagging row locks", () => {
  for (const sql of ['UPDATE public."Project" SET name=\'x\' RETURNING id', 'WITH changed AS (DELETE FROM public."Project" RETURNING id) SELECT * FROM changed',
    'INSERT INTO public."Project" VALUES (1) RETURNING id', "UPDATE project SET name='x' RETURNING id",
    'UPDATE ONLY public."Project" SET name=\'x\' RETURNING id', 'TRUNCATE "Project"', 'DROP TABLE "Project"', 'CREATE TABLE "x" (id int)'])
    expect(possibleMutation(sql)).toBe(true);
  for (const sql of ['SELECT id FROM public."Project" FOR UPDATE', 'SELECT * FROM public."Project" FOR SHARE', "SET LOCAL lock_timeout='3s'"])
    expect(possibleMutation(sql)).toBe(false);
  expect(possibleMutation(rawSqlText({ sql: 'UPDATE public."Project" SET name=? RETURNING id' }))).toBe(true);
  expect(possibleMutation(rawSqlText({ strings: ['WITH changed AS (DELETE FROM public."Project" WHERE id=', ') SELECT * FROM changed'] }))).toBe(true);
  expect(() => rawSqlText({ unexpected: "SELECT 1" })).toThrow("Unknown raw SQL argument");
});

it("preserves historical assessment behavior while strict advice propagates preparation failures", async () => {
  vi.spyOn(DatabaseAuthorityRepository.prototype, "loadAssessmentPrefixesInTransaction").mockResolvedValue(new Map());
  vi.spyOn(DatabaseAuthorityRepository.prototype, "prepareAssessmentInTransaction").mockRejectedValue(new Error("Synthetic preparation failure"));
  const tx = transaction();
  const ordinary = await buildBlockerAgeAssessmentInTransaction(tx as never, {} as never, actor, projectId, true, threshold, asOf);
  expect(ordinary.coverage).toBe("UNASSESSABLE");
  await expect(buildBlockerAgeAssessmentInTransaction(tx as never, {} as never, actor, projectId, true, threshold, asOf,
    { strictPreparationErrors: true })).rejects.toThrow("Synthetic preparation failure");
});

it("accepts a bounded 50-row RAID read and marks a 51st sentinel as overflow", async () => {
  vi.spyOn(DatabaseAuthorityRepository.prototype, "loadAssessmentPrefixesInTransaction").mockResolvedValue(new Map());
  const make = (count: number) => ({ $queryRawUnsafe: vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT id,key,kind,state FROM public."RaidItem"'))
      return Array.from({ length: count }, (_, index) => ({ id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        key: `ISSUE-${index}`, kind: "ISSUE", state: "OPEN" }));
    return [];
  }) });
  const fifty = await buildBlockerAgeAssessmentInTransaction(make(50) as never, {} as never, actor, projectId, true, threshold, asOf,
    { strictPreparationErrors: true });
  expect(fifty.coverage).toBe("UNASSESSABLE");
  expect(fifty.input).toMatchObject({ gates: { raidSnapshotBounded: true }, candidates: expect.arrayContaining([expect.objectContaining({ key: "ISSUE-0" })]) });
  const sentinel = await buildBlockerAgeAssessmentInTransaction(make(51) as never, {} as never, actor, projectId, true, threshold, asOf,
    { strictPreparationErrors: true });
  expect(sentinel.input).toMatchObject({ reason: "RAID_SNAPSHOT_OVER_LIMIT", gates: { raidSnapshotBounded: false } });
});

it.each(["ProjectFactVersion", "FactAuthorityConflict", "AuthorityPolicyRevision"])("bounds %s history at 1000 with a 1001st sentinel", async (table) => {
  const prefixes = vi.spyOn(DatabaseAuthorityRepository.prototype, "loadAssessmentPrefixesInTransaction").mockResolvedValue(new Map());
  vi.spyOn(DatabaseAuthorityRepository.prototype, "prepareAssessmentInTransaction").mockRejectedValue(new Error("Reached bounded preparation"));
  const make = (count: number) => ({ $queryRawUnsafe: vi.fn(async (sql: string) => {
    if (sql.includes('FROM public."ProjectFact"'))
      return [{ id: "30000000-0000-4000-8000-000000000001", factType: "project.open_blocker_inventory_complete", revision: 1 }];
    if (sql.includes(`FROM public."${table}"`)) return Array.from({ length: count }, (_, index) => ({
      id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`, factId: "30000000-0000-4000-8000-000000000001",
      sourceId: "50000000-0000-4000-8000-000000000001" }));
    return [];
  }) });
  await expect(buildBlockerAgeAssessmentInTransaction(make(1000) as never, {} as never, actor, projectId, true, threshold, asOf,
    { strictPreparationErrors: true })).rejects.toThrow("Reached bounded preparation");
  expect(prefixes).toHaveBeenCalledTimes(1);
  const overflow = await buildBlockerAgeAssessmentInTransaction(make(1001) as never, {} as never, actor, projectId, true, threshold, asOf,
    { strictPreparationErrors: true });
  expect(overflow.input).toMatchObject({ reason: "SOURCE_HISTORY_OVER_LIMIT", gates: { sourceHistoryComplete: false } });
  expect(prefixes).toHaveBeenCalledTimes(1);
});
it("fails on an aggregate prefix budget reported by the authority loader", async () => {
  vi.spyOn(DatabaseAuthorityRepository.prototype, "loadAssessmentPrefixesInTransaction").mockResolvedValue(null);
  const result = await buildBlockerAgeAssessmentInTransaction(transaction() as never, {} as never, actor, projectId, true, threshold, asOf,
    { strictPreparationErrors: true });
  expect(result.input).toMatchObject({ reason: "SOURCE_HISTORY_OVER_LIMIT", gates: { sourceHistoryComplete: false } });
});

function leadershipFixture() {
  const leadership = { ...actor, roles: ["leadership"] };
  const portfolioId = "40000000-0000-4000-8000-000000000001";
  const state = { project: true, grant: true, threshold: true, sealed: true, canonicalPresent: true, malformed: false, broken: false };
  const calls: string[] = [];
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => { calls.push(sql); }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      calls.push(sql);
      if (state.broken) throw new Error("private database failure");
      if (sql.includes('FROM public."Project"')) {
        expect(args).toEqual([actor.customerId, projectId]);
        return state.project ? [{ id: projectId, portfolioId }] : [];
      }
      if (sql.includes('FROM public."AccessGrant"')) {
        expect(sql).toContain("role='leadership'");
        expect(sql).toContain('"scopeType"=\'project\'');
        expect(sql).toContain('"scopeType"=\'portfolio\'');
        expect(args).toEqual([actor.customerId, actor.subject, projectId, portfolioId]);
        return state.grant ? [{ id: "50000000-0000-4000-8000-000000000001" }] : [];
      }
      if (sql.includes("pg_advisory_xact_lock_shared")) {
        expect(args).toEqual(["blocker-age-threshold:" + actor.customerId]); return [{ locked: true }];
      }
      if (sql.includes('FROM public."BlockerAgeThresholdPolicy"'))
        return state.threshold ? [{ ...threshold, minimumBlockerAgeDays: state.malformed ? -1 : 5 }] : [];
      if (sql.includes('FROM public."CanonicalProject"')) return state.canonicalPresent ? [{ sealed: state.sealed }] : [];
      if (sql.includes("clock_timestamp()")) return [{ now: asOf }];
      throw new Error("Unexpected query");
    }),
  };
  const db = { $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 20000 });
    return fn(tx);
  }) };
  const build = vi.spyOn(assessment, "buildBlockerAgeAssessmentInTransaction").mockResolvedValue({
    asOf, coverage: "UNASSESSABLE", input: { reason: "SYNTHETIC" }, newConflicts: [], result: {} } as never);
  return { leadership, state, calls, tx, db, build, repository: new DatabaseBlockerAgeAdviceRepository(db as never) };
}

it("requires both a leadership token and current scoped grant, including for dual-role actors", async () => {
  const f = leadershipFixture();
  await expect(f.repository.readLeadership(actor, projectId)).rejects.toMatchObject({ code: "DENIED" });
  expect(f.db.$transaction).not.toHaveBeenCalled();
  f.state.project = false;
  await expect(f.repository.readLeadership(f.leadership, projectId)).rejects.toMatchObject({ code: "DENIED" });
  f.state.project = true; f.state.grant = false;
  const dual = { ...actor, roles: ["project_manager", "leadership"] };
  await expect(f.repository.readLeadership(dual, projectId)).rejects.toMatchObject({ code: "DENIED" });
  f.state.grant = true;
  expect(await f.repository.readLeadership(dual, projectId)).toMatchObject({ audience: "leadership", coverage: "UNASSESSABLE" });
  await expect(f.repository.readLeadership(f.leadership, "not-a-project")).rejects.toMatchObject({ code: "DENIED" });
});

it("locks project and leadership grant before the threshold gate and canonical state", async () => {
  const f = leadershipFixture();
  await f.repository.readLeadership(f.leadership, projectId);
  const queries = f.calls.filter((sql) => !sql.startsWith("SET LOCAL"));
  expect(queries.map((sql) => sql.includes('FROM public."Project"') ? "project" :
    sql.includes('FROM public."AccessGrant"') ? "grant" : sql.includes("pg_advisory") ? "gate" :
    sql.includes('FROM public."BlockerAgeThresholdPolicy"') ? "policy" : "canonical"))
    .toEqual(["project", "grant", "gate", "policy", "canonical"]);
  expect(queries.filter((sql) => !sql.includes("pg_advisory")).every((sql) => sql.includes("FOR SHARE"))).toBe(true);
  expect(f.build).toHaveBeenCalledWith(f.tx, f.db, f.leadership, projectId, true, threshold, undefined,
    { strictPreparationErrors: true });
  expect(f.calls.slice(0, 2)).toEqual(["SET LOCAL statement_timeout='8s'", "SET LOCAL lock_timeout='3s'"]);
});

it("forwards absent threshold and unsealed state and hides database and malformed-policy failures", async () => {
  const f = leadershipFixture();
  f.state.threshold = false; f.state.sealed = false;
  expect(await f.repository.readLeadership(f.leadership, projectId)).toMatchObject({ coverage: "UNASSESSABLE", items: [], noOpenBlockers: null });
  expect(f.build).toHaveBeenLastCalledWith(f.tx, f.db, f.leadership, projectId, false, null, undefined,
    { strictPreparationErrors: true });
  f.state.threshold = true; f.state.malformed = true;
  await expect(f.repository.readLeadership(f.leadership, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.state.broken = true;
  try { await f.repository.readLeadership(f.leadership, projectId); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toMatchObject({ code: "UNAVAILABLE" }); expect(String(error)).not.toContain("private database failure"); }
});

it("normalizes absent threshold, unsealed and absent canonical rows through the real builder", async () => {
  const f = leadershipFixture(); f.build.mockRestore();
  f.state.threshold = false;
  expect(await f.repository.readLeadership(f.leadership, projectId)).toMatchObject({ coverage: "UNASSESSABLE", noOpenBlockers: null, items: [] });
  f.state.threshold = true; f.state.sealed = false;
  expect(await f.repository.readLeadership(f.leadership, projectId)).toMatchObject({ coverage: "UNASSESSABLE", noOpenBlockers: null, items: [] });
  f.state.canonicalPresent = false;
  expect(await f.repository.readLeadership(f.leadership, projectId)).toMatchObject({ coverage: "UNASSESSABLE", noOpenBlockers: null, items: [] });
});
it.each(["RAID_SNAPSHOT_OVER_LIMIT", "SOURCE_HISTORY_OVER_LIMIT"])("fails the entire leadership response on %s", async (reason) => {
  const f = leadershipFixture();
  f.build.mockResolvedValueOnce({ asOf, coverage: "UNASSESSABLE", input: { reason }, newConflicts: [], result: {} } as never);
  await expect(f.repository.readLeadership(f.leadership, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
