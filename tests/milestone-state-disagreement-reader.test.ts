import { afterEach, expect, it, vi } from "vitest";
import { DatabaseAuthorityRepository } from "../packages/data/src/authority-persistence.js";
import { DatabaseCanonicalProjectRepository } from "../packages/data/src/canonical-project.js";
import { DatabaseMilestoneStateDisagreementRepository } from "../packages/data/src/milestone-state-disagreement.js";
import { rawSqlText } from "./fixtures/read-only-sql.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = id(1), projectId = id(2), milestoneId = id(3), factId = id(4), bindingId = id(5);
const factType = "canonical.state.10000000000040008000000000000003", asOf = new Date("2026-10-21T00:00:00.000Z");
const leader = { customerId, subject: "synthetic-leader", roles: ["leadership"] as ("leadership")[] };

function fixture() {
  const fact = { id: factId, factType, revision: 3 };
  const binding = { id: bindingId, factId, factType, workItemId: null };
  const versions = [0, 1, 2].map((index) => ({ id: id(index + 10), factId, revision: index + 1,
    sourceId: id(index + 20), evidenceId: id(index + 30), value: { type: "text", value: index === 1 ? "COMPLETE" : "OPEN" },
    provenance: "HUMAN_CONFIRMED", effectiveAtValidated: false, effectiveAt: new Date("2026-10-01T00:00:00.000Z"),
    validUntil: new Date("2026-12-01T00:00:00.000Z"), evidence: { observedAt: new Date("2026-10-02T00:00:00.000Z"), source: { sourceType: "human_statement" } } }));
  const access = versions.map((row) => ({ factId, sourceId: row.sourceId, state: "AVAILABLE", readers: [{ subject: leader.subject }] }));
  const event = { id: id(50), customerId, projectId, factType, state: "ENABLED", recordedAt: new Date("2026-10-01T00:00:00.000Z"),
    effectiveAt: new Date("2026-10-01T00:00:00.000Z"), definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
      requiredApproval: "NOT_REQUIRED", validity: null }] }], conflictBehavior: "REQUEST_RECONCILIATION" } };
  const prefix = { event, aggregate: { id: id(51), revision: 1 }, versions, conflicts: [] as { id: string; revision: number; leftVersionId: string; rightVersionId: string; detectedAt: Date }[], access, conflictThroughRevision: 0 };
  const state = { grants: ["leadership"], visible: true, valid: true, policyRows: [{ id: event.id, revision: 1 }], facts: [fact] };
  const tx = { $executeRaw: vi.fn(async (_arg: unknown) => 0), $queryRaw: vi.fn(async (arg: unknown) => {
    const sql = rawSqlText(arg);
    if (sql.includes('FROM public."AccessGrant"')) return state.grants.map((role) => ({ role }));
    if (sql.includes('FROM public."Project"')) return [{ portfolioId: id(6) }];
    if (sql.includes("clock_timestamp()")) return [{ now: asOf }];
    if (sql.includes("valid_canonical_project") || sql.includes("valid_canonical_state_binding") ||
        sql.includes("valid_authority_history") || sql.includes("valid_authority_conflict") || sql.includes("SELECT EXISTS")) return [{ valid: state.valid }];
    throw new Error("Unexpected query");
  }), canonicalProject: { findFirst: vi.fn(async () => ({ canonicalCreationReceipt_project: { id: id(7) } })) },
  canonicalStateBinding: { findMany: vi.fn(async () => [binding]) },
  projectFact: { findFirst: vi.fn(async () => state.facts[0] ?? null) },
  authorityPolicyRevision: { findMany: vi.fn(async () => state.policyRows) } };
  vi.spyOn(DatabaseCanonicalProjectRepository.prototype, "detailInTransaction").mockImplementation(async () =>
    ({ configured: state.visible, milestones: state.visible ? [{ id: milestoneId }] : [] }) as never);
  vi.spyOn(DatabaseAuthorityRepository.prototype, "loadAssessmentPrefixesInTransaction").mockImplementation(async () => new Map([[factId, prefix]]) as never);
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) };
  return { state, tx, prefix, reader: new DatabaseMilestoneStateDisagreementRepository(db as never) };
}
afterEach(() => vi.restoreAllMocks());

it("returns every winning human association without issuing a write", async () => {
  const f = fixture();
  const result = await f.reader.readLeadership(leader, projectId, milestoneId);
  expect(result.positions.map((item) => [item.state, item.supports.map((row) => row.versionId)])).toEqual([
    ["COMPLETE", [id(11)]], ["OPEN", [id(10), id(12)]],
  ]);
  expect(result).not.toHaveProperty("resolvedValue");
  for (const call of f.tx.$executeRaw.mock.calls) expect(rawSqlText(call[0])).toMatch(/^SET LOCAL /);
  for (const call of f.tx.$queryRaw.mock.calls)
    expect(rawSqlText(call[0])).not.toMatch(/FROM public\."ProjectFact"[^;]*FOR (?:SHARE|UPDATE)/);
});
it("fails closed for missing leadership, inaccessible history and unsupported origin", async () => {
  const f = fixture(); f.state.grants = [];
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "DENIED" });
  f.state.grants = ["leadership"]; f.prefix.access[2]!.readers = [];
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.prefix.access[2]!.readers = [{ subject: leader.subject }]; f.prefix.versions[2]!.evidence.source.sourceType = "jira";
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("withholds incomplete policy, invalid graph and noncontiguous prefixes", async () => {
  const f = fixture(); f.state.policyRows = [];
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.state.policyRows = [{ id: f.prefix.event.id, revision: 1 }]; f.state.valid = false;
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.state.valid = true; f.prefix.versions[1]!.revision = 5;
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("withholds a stale third head rather than silently omitting it", async () => {
  const f = fixture(); f.prefix.versions[2]!.validUntil = asOf;
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("does not present absent or disabled authority policy as an authoritative tie", async () => {
  const f = fixture(), event = f.prefix.event;
  f.prefix.event = null as never;
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.prefix.event = event; f.prefix.event.state = "DISABLED";
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("withholds a source whose only reader is not the requesting actor", async () => {
  const f = fixture(); f.prefix.access[1]!.readers = [{ subject: "different-subject" }];
  await expect(f.reader.readLeadership(leader, projectId, milestoneId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
