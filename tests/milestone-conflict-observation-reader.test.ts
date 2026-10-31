import { afterEach, expect, it, vi } from "vitest";
import { DatabaseCanonicalProjectRepository } from "../packages/data/src/canonical-project.js";
import { DatabaseAuthorityRepository } from "../packages/data/src/authority-persistence.js";
import { milestoneRequestObservationSchema } from "../packages/domain/dist/index.js";
import { DatabaseMilestoneConflictObservationRepository } from "../packages/data/src/milestone-conflict-observation.js";
import { rawSqlText } from "./fixtures/read-only-sql.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { customerId: id(1), subject: "leader", roles: ["leadership"] } as const;
const projectId = id(2), milestoneId = id(3), workId = id(4), portfolioId = id(5);
const actorValue = { ...actor, roles: [...actor.roles] };
function fake() {
  const state = { projectError: false, canonicalError: false, revision: 501, integrityCalls: 0, grants: ["leadership"], policyValid: true, conflictValid: true,
    policyBytes: 32n, policyCount: 1, totalPolicyBytes: 64n, totalPolicyCount: 2 };
  const bindings = [
    { id: id(10), customerId: actor.customerId, projectId, targetKind: "MILESTONE", milestoneId, workItemId: null, factId: id(20), factType: "canonical.state.one" },
    { id: id(11), customerId: actor.customerId, projectId, targetKind: "WORK_ITEM", milestoneId: null, workItemId: workId, factId: id(21), factType: "canonical.state.two" },
  ];
  const tx = { $executeRaw: vi.fn(async () => 0), $queryRaw: vi.fn(async (arg: unknown) => {
    const sql = rawSqlText(arg);
    if (sql.includes('FROM public."Project"')) { if (state.projectError) throw new Error("private timeout"); return [{ portfolioId }]; }
    if (sql.includes('FROM public."AccessGrant"')) return state.grants.map((role) => ({ role }));
    if (sql.includes("valid_canonical_state_binding")) { state.integrityCalls++; return [{ valid: true }]; }
    if (sql.includes('FROM public."AuthorityPolicy" p')) return [{ count: state.totalPolicyCount, bytes: state.totalPolicyBytes }];
    if (sql.includes('FROM public."AuthorityPolicyRevision"')) return [{ count: state.policyCount, bytes: state.policyBytes }];
    if (sql.includes("valid_authority_history")) return [{ valid: state.policyValid }];
    if (sql.includes("valid_authority_conflict")) return [{ valid: state.conflictValid }];
    if (sql.includes("clock_timestamp()")) return [{ now: new Date("2026-10-21T00:00:00.000Z") }];
    if (sql.includes("jsonb_build_object")) return [{ valid: true }];
    throw new Error("Unexpected fake query");
  }), canonicalProject: { findFirst: vi.fn(async () => { if (state.canonicalError) throw new Error("private timeout"); return { canonicalCreationReceipt_project: { id: id(30) } }; }) },
  requiredWorkItem: { findMany: vi.fn(async () => [{ id: id(31), milestoneId, workItemId: workId }]) },
  canonicalStateBinding: { findMany: vi.fn(async () => bindings) },
  projectFact: { findMany: vi.fn(async () => bindings.map((b) => ({ id: b.factId, factType: b.factType, revision: state.revision, bindingBirthId: b.id }))) },
  };
  let inTransaction = false;
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try { return await fn(tx); } finally { inTransaction = false; }
  } };
  vi.spyOn(DatabaseCanonicalProjectRepository.prototype, "detailInTransaction").mockResolvedValue({ configured: true, milestones: [{ id: milestoneId }] } as never);
  return { state, tx, reader: new DatabaseMilestoneConflictObservationRepository(db as never), inTransaction: () => inTransaction };
}
afterEach(() => vi.restoreAllMocks());
it("requires both token-compatible leadership and management grants before the matching-request read", async () => {
  const dual = { ...actor, roles: ["leadership", "pmo_admin"] as ("leadership" | "pmo_admin")[] };
  const f = fake();
  f.state.grants = ["leadership"];
  await expect(f.reader.readForLeaderManager(dual, projectId, milestoneId)).rejects.toMatchObject({ code: "DENIED" });
  f.state.grants = ["pmo_admin"];
  await expect(f.reader.readForLeaderManager(dual, projectId, milestoneId)).rejects.toMatchObject({ code: "DENIED" });
  f.state.grants = ["leadership", "pmo_admin"];
  await expect(f.reader.readForLeaderManager(actorValue, projectId, milestoneId)).rejects.toMatchObject({ code: "DENIED" });
  expect(f.tx.canonicalProject.findFirst).not.toHaveBeenCalled();
});

it("validates the complete request-status response while locked and masks validation errors", async () => {
  const f = fake(); f.state.grants = ["leadership", "pmo_admin"];
  Object.assign(f.tx, { projectResponsibility: { findMany: vi.fn(async () => []) } });
  const internal = f.reader as unknown as { observe: (...args: unknown[]) => Promise<unknown> };
  vi.spyOn(internal, "observe").mockResolvedValue({ observation: { projectId, milestoneId, asOf: "2026-10-21T00:00:00.000Z",
    ruleRevision: "milestone-required-state/v1", outcome: "NOT_DETECTED" }, contributorIdentity: null });
  const parse = milestoneRequestObservationSchema.parse.bind(milestoneRequestObservationSchema);
  const validate = vi.spyOn(milestoneRequestObservationSchema, "parse").mockImplementation((value) => {
    expect(f.inTransaction()).toBe(true); return parse(value);
  });
  const dual = { ...actor, roles: ["leadership", "pmo_admin"] as ("leadership" | "pmo_admin")[] };
  await expect(f.reader.readForLeaderManager(dual, projectId, milestoneId)).resolves.toMatchObject({ requestStatus: null });
  validate.mockImplementation(() => { throw new Error("private validation detail"); });
  await expect(f.reader.readForLeaderManager(dual, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

function guardedPrefix() {
  const f = fake(); f.state.grants = ["leadership", "pmo_admin"]; f.state.revision = 1;
  const version = { revision: 1, provenance: "HUMAN_CONFIRMED", evidence: { source: { sourceType: "human_statement" } } };
  const prefix = { aggregate: { id: id(50), revision: 1 }, event: { id: id(51) }, versions: [version], conflicts: [] as { revision: number }[] };
  const policyRows = [{ id: id(51), revision: 1 }];
  Object.assign(f.tx, { projectResponsibility: { findMany: vi.fn(async () => []) },
    authorityPolicyRevision: { findMany: vi.fn(async () => policyRows) } });
  const load = vi.spyOn(DatabaseAuthorityRepository.prototype, "loadAssessmentPrefixesInTransaction")
    .mockImplementation(async () => new Map([[id(20), prefix], [id(21), prefix]]) as never);
  let evaluated = false;
  const result = { versions: [version], result: { versions: [{ visibility: "available", temporalApplicability: "APPLICABLE", assessment: { freshness: "CURRENT" } }] },
    get complete() { evaluated = true; return false; } };
  const prepare = vi.spyOn(DatabaseAuthorityRepository.prototype, "prepareAssessmentInTransaction").mockResolvedValue(result as never);
  const dual = { ...actor, roles: ["leadership", "pmo_admin"] as ("leadership" | "pmo_admin")[] };
  return { ...f, prefix, policyRows, result, load, prepare, evaluated: () => evaluated,
    read: () => f.reader.readForLeaderManager(dual, projectId, milestoneId) };
}

it("withholds malformed fact, policy and conflict prefixes before producing a request status", async () => {
  for (const mutate of [
    (f: ReturnType<typeof guardedPrefix>) => { f.prefix.versions = []; },
    (f: ReturnType<typeof guardedPrefix>) => { f.prefix.versions[0]!.revision = 2; },
    (f: ReturnType<typeof guardedPrefix>) => { f.policyRows[0]!.revision = 2; },
    (f: ReturnType<typeof guardedPrefix>) => { f.state.policyBytes = 4194305n; },
    (f: ReturnType<typeof guardedPrefix>) => { f.state.policyCount = 0; },
    (f: ReturnType<typeof guardedPrefix>) => { f.state.policyValid = false; },
    (f: ReturnType<typeof guardedPrefix>) => { f.prefix.conflicts = [{ revision: 2 }]; },
    (f: ReturnType<typeof guardedPrefix>) => { f.prefix.conflicts = [{ revision: 1 }]; f.state.conflictValid = false; },
  ]) {
    const f = guardedPrefix(); mutate(f);
    await expect(f.read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.prepare).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
});

it("bounds all policy definitions before loading any current prefix", async () => {
  for (const mutate of [
    (f: ReturnType<typeof guardedPrefix>) => { f.state.totalPolicyBytes = 4194305n; },
    (f: ReturnType<typeof guardedPrefix>) => { f.state.totalPolicyCount = 1001; },
  ]) {
    const f = guardedPrefix(); mutate(f);
    await expect(f.read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.load).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
});

it("withholds stale or ambiguous applicable heads but does not reject accessible superseded history solely for staleness", async () => {
  for (const [temporalApplicability, freshness] of [["APPLICABLE", "STALE"], ["APPLICABLE", "UNKNOWN"], ["AMBIGUOUS", "CURRENT"]]) {
    const f = guardedPrefix(); Object.assign(f.result.result.versions[0]!, { temporalApplicability, assessment: { freshness } });
    await expect(f.read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.evaluated()).toBe(false);
    vi.restoreAllMocks();
  }
  const f = guardedPrefix(); Object.assign(f.result.result.versions[0]!, { temporalApplicability: "SUPERSEDED", assessment: { freshness: "STALE" } });
  await expect(f.read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.evaluated()).toBe(true); // The separate mocked completeness check still withholds the result.
});

it("withholds before the next policy validator when the aggregate history byte budget is exceeded", async () => {
  const f = guardedPrefix(); f.state.policyBytes = 2097153n;
  Object.assign(f.result.versions[0]!, { factId: id(20), sourceId: id(60) });
  Object.assign(f.result, { newConflicts: [], access: [{ factId: id(20), sourceId: id(60), state: "AVAILABLE", readers: [{ subject: actor.subject }] }] });
  Object.defineProperty(f.result, "complete", { get: () => true });
  await expect(f.read()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.tx.$queryRaw.mock.calls.filter((call) => rawSqlText(call[0]).includes("valid_authority_history"))).toHaveLength(1);
});
it("conceals failures before target visibility and reports failures after it", async () => {
  const before = fake(); before.state.projectError = true;
  await expect(before.reader.readLeadership(actorValue, projectId, milestoneId)).rejects.toMatchObject({ code: "DENIED" });
  vi.restoreAllMocks();
  const after = fake(); after.state.canonicalError = true;
  await expect(after.reader.readLeadership(actorValue, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("rejects excessive fact revisions before invoking binding-history integrity checks", async () => {
  const f = fake();
  await expect(f.reader.readLeadership(actorValue, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.state.integrityCalls).toBe(0); expect(f.tx.projectFact.findMany).toHaveBeenCalledOnce();
});

it("derives mapping visibility from the same locked, token-matched grant set", async () => {
  const f = fake(); f.state.canonicalError = true; f.state.grants = ["leadership", "pmo_admin"];
  await expect(f.reader.readLeadership(actorValue, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(DatabaseCanonicalProjectRepository.prototype.detailInTransaction).toHaveBeenLastCalledWith(f.tx, actorValue, projectId, false);
  const dual = { ...actorValue, roles: ["leadership", "pmo_admin"] as ("leadership" | "pmo_admin")[] };
  await expect(f.reader.readLeadership(dual, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(DatabaseCanonicalProjectRepository.prototype.detailInTransaction).toHaveBeenLastCalledWith(f.tx, dual, projectId, true);
  expect(f.tx.$queryRaw.mock.calls.filter((call) => rawSqlText(call[0]).includes('FROM public."AccessGrant"'))).toHaveLength(2);
});
