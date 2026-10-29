import { afterEach, expect, it, vi } from "vitest";
import { DatabaseAuthorityRepository, resolveStoredAuthorityPrefix } from "../packages/data/src/authority-persistence.js";
import { DatabaseScalarConflictObservationRepository } from "../packages/data/src/scalar-conflict-observation.js";
import { rawSqlText } from "./fixtures/read-only-sql.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = id(1), projectId = id(2), factId = id(3), factType = "project.forecast", asOf = new Date("2026-10-21T00:00:00.000Z");
const leader = { customerId, subject: "synthetic-leader", roles: ["leadership"] as ("leadership")[] };
function fake() {
  const fact = { id: factId, factType, revision: 3 };
  const versions = [0, 1, 2].map((index) => ({ id: id(index + 10), factId, revision: index + 1,
    sourceId: id(index + 20), evidenceId: id(index + 30), value: { type: "date", value: index === 1 ? "2026-11-02" : "2026-11-01" },
    provenance: "HUMAN_CONFIRMED", effectiveAtValidated: false, effectiveAt: new Date("2026-10-01T00:00:00.000Z"),
    validUntil: new Date("2026-12-01T00:00:00.000Z"), evidence: { observedAt: new Date("2026-10-02T00:00:00.000Z"), source: { sourceType: "human_statement" } } }));
  const access = versions.map((row) => ({ factId, sourceId: row.sourceId, state: "AVAILABLE", readers: [{ subject: leader.subject }] }));
  const event = { id: id(50), customerId, projectId, factType, state: "ENABLED", recordedAt: new Date("2026-10-01T00:00:00.000Z"),
    effectiveAt: new Date("2026-10-01T00:00:00.000Z"), definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
      requiredApproval: "NOT_REQUIRED", validity: null }] }], conflictBehavior: "REQUEST_RECONCILIATION" } };
  const prefix = { event, aggregate: null, versions, conflicts: [] as { id: string; leftVersionId: string; rightVersionId: string; detectedAt: Date }[], access, conflictThroughRevision: 0 };
  const state = { grants: ["leadership"], page: [fact], projectError: false };
  const tx = { $executeRaw: vi.fn(async () => 0), $queryRaw: vi.fn(async (arg: unknown) => {
    const sql = rawSqlText(arg);
    if (sql.includes('FROM public."Project"')) { if (state.projectError) throw new Error("private"); return [{ portfolioId: id(4) }]; }
    if (sql.includes('FROM public."AccessGrant"')) return state.grants.map((role) => ({ role }));
    if (sql.includes("clock_timestamp()")) return [{ now: asOf }];
    throw new Error("Unexpected query");
  }), projectFact: { findMany: vi.fn(async () => state.page) } };
  vi.spyOn(DatabaseAuthorityRepository.prototype, "loadAssessmentPrefixesInTransaction").mockImplementation(async () => new Map([[factId, prefix]]) as never);
  const db = { $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) };
  return { state, tx, prefix, reader: new DatabaseScalarConflictObservationRepository(db as never) };
}
afterEach(() => vi.restoreAllMocks());
it("preserves all authorized associations on three sources and recorded current edges", async () => {
  const f = fake();
  const first = await f.reader.readLeadership(leader, projectId, factId);
  expect(first.positions.map((item) => [item.value, item.supports.map((s) => s.versionId)])).toEqual([
    ["2026-11-01", [id(10), id(12)]], ["2026-11-02", [id(11)]],
  ]);
  f.prefix.conflicts.push({ id: id(60), leftVersionId: id(10), rightVersionId: id(11), detectedAt: new Date("2026-10-20T00:00:00.000Z") });
  expect(await f.reader.readLeadership(leader, projectId, factId)).toEqual(first);
});
it("withholds source revocation, mixed values and expiration of a disputed position", async () => {
  const f = fake();
  f.prefix.access[2]!.readers = [];
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.prefix.access[2]!.readers = [{ subject: leader.subject }];
  f.prefix.versions[2]!.value = { type: "text", value: "private" };
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.prefix.versions[2]!.value = { type: "date", value: "2026-11-01" };
  f.prefix.versions[1]!.validUntil = asOf;
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("conceals missing grants, hidden catalogue IDs and pre-visibility failures", async () => {
  const f = fake(); f.state.grants = [];
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "DENIED" });
  f.state.grants = ["leadership"]; f.state.page = [];
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "DENIED" });
  f.state.projectError = true;
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "DENIED" });
});
it("withholds an ambiguous lower-tier stream even when higher-tier dates disagree", async () => {
  const f = fake();
  f.prefix.versions[2]!.evidence.source.sourceType = "jira_connector";
  f.prefix.versions.push({ ...f.prefix.versions[2]!, id: id(70), evidenceId: id(71), revision: 4 });
  f.state.page[0]!.revision = 4;
  f.prefix.event.definition.tiers.push({ selectors: [{ sourceType: "jira_connector", instanceId: null, requiredApproval: "NOT_REQUIRED", validity: null }] });
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("requires access to an unselected lower-tier source", async () => {
  const f = fake();
  f.prefix.versions[2]!.evidence.source.sourceType = "jira_connector";
  f.prefix.event.definition.tiers.push({ selectors: [{ sourceType: "jira_connector", instanceId: null, requiredApproval: "NOT_REQUIRED", validity: null }] });
  expect((await f.reader.readLeadership(leader, projectId, factId)).positions).toHaveLength(2);
  f.prefix.access[2]!.readers = [];
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("withholds a valid recorded edge involving an unselected lower-tier version", async () => {
  const f = fake();
  f.prefix.versions[2]!.evidence.source.sourceType = "jira_connector";
  f.prefix.event.definition.tiers.push({ selectors: [{ sourceType: "jira_connector", instanceId: null, requiredApproval: "NOT_REQUIRED", validity: null }] });
  f.prefix.conflicts.push({ id: id(60), leftVersionId: id(11), rightVersionId: id(12), detectedAt: new Date("2026-10-20T00:00:00.000Z") });
  const scope = { customerId, projectId, factId, factType };
  const pure = resolveStoredAuthorityPrefix(scope, asOf, f.prefix.event as never, f.prefix.versions as never,
    f.prefix.conflicts as never, f.prefix.access as never, true).result;
  expect(pure.conflicts.map((row) => row.kind).sort()).toEqual(["AUTHORITY_DISAGREEMENT", "RECORDED"]);
  expect(pure.candidateVersionIds).not.toContain(id(12));
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("withholds a higher-authority contradiction even when lower-tier sources disagree", async () => {
  const f = fake();
  f.prefix.versions[2]!.evidence.source.sourceType = "jira_connector";
  f.prefix.versions[2]!.provenance = "SYSTEM_VERIFIED";
  f.prefix.versions[2]!.validUntil = asOf;
  f.prefix.event.definition.tiers.unshift({ selectors: [{ sourceType: "jira_connector", instanceId: null, requiredApproval: "NOT_REQUIRED", validity: null }] });
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("withholds oversized histories before loading them", async () => {
  const f = fake(); f.state.page[0]!.revision = 1001;
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(DatabaseAuthorityRepository.prototype.loadAssessmentPrefixesInTransaction).not.toHaveBeenCalled();
});
it("requires a finite deadline even when the policy uses until-superseded validity", async () => {
  const f = fake(), openedAt = `raid_item.${id(80)}.opened_at`;
  f.state.page[0]!.factType = openedAt; f.prefix.event.factType = openedAt;
  f.prefix.event.definition.tiers[0]!.selectors[0]!.validity = { mode: "UNTIL_SUPERSEDED" } as never;
  f.prefix.versions.forEach((row) => { row.validUntil = null as never; });
  await expect(f.reader.readLeadership(leader, projectId, factId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  f.prefix.versions.forEach((row) => { row.validUntil = new Date("2026-12-01T00:00:00.000Z"); });
  expect((await f.reader.readLeadership(leader, projectId, factId)).positions).toHaveLength(2);
});
