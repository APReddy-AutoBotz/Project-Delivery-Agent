import { afterEach, expect, it, vi } from "vitest";
import { DatabaseCanonicalProjectRepository } from "../packages/data/src/canonical-project.js";
import { DatabaseMilestoneConflictObservationRepository } from "../packages/data/src/milestone-conflict-observation.js";
import { rawSqlText } from "./fixtures/read-only-sql.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { customerId: id(1), subject: "leader", roles: ["leadership"] } as const;
const projectId = id(2), milestoneId = id(3), workId = id(4), portfolioId = id(5);
const actorValue = { ...actor, roles: [...actor.roles] };
function fake() {
  const state = { projectError: false, canonicalError: false, revision: 501, integrityCalls: 0, grants: ["leadership"] };
  const bindings = [
    { id: id(10), customerId: actor.customerId, projectId, targetKind: "MILESTONE", milestoneId, workItemId: null, factId: id(20), factType: "canonical.state.one" },
    { id: id(11), customerId: actor.customerId, projectId, targetKind: "WORK_ITEM", milestoneId: null, workItemId: workId, factId: id(21), factType: "canonical.state.two" },
  ];
  const tx = { $executeRaw: vi.fn(async () => 0), $queryRaw: vi.fn(async (arg: unknown) => {
    const sql = rawSqlText(arg);
    if (sql.includes('FROM public."Project"')) { if (state.projectError) throw new Error("private timeout"); return [{ portfolioId }]; }
    if (sql.includes('FROM public."AccessGrant"')) return state.grants.map((role) => ({ role }));
    if (sql.includes("valid_canonical_state_binding")) { state.integrityCalls++; return [{ valid: true }]; }
    throw new Error("Unexpected fake query");
  }), canonicalProject: { findFirst: vi.fn(async () => { if (state.canonicalError) throw new Error("private timeout"); return { canonicalCreationReceipt_project: { id: id(30) } }; }) },
  requiredWorkItem: { findMany: vi.fn(async () => [{ id: id(31), milestoneId, workItemId: workId }]) },
  canonicalStateBinding: { findMany: vi.fn(async () => bindings) },
  projectFact: { findMany: vi.fn(async () => bindings.map((b) => ({ id: b.factId, factType: b.factType, revision: state.revision, bindingBirthId: b.id }))) },
  };
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) };
  vi.spyOn(DatabaseCanonicalProjectRepository.prototype, "detailInTransaction").mockResolvedValue({ configured: true, milestones: [{ id: milestoneId }] } as never);
  return { state, tx, reader: new DatabaseMilestoneConflictObservationRepository(db as never) };
}
afterEach(() => vi.restoreAllMocks());
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
