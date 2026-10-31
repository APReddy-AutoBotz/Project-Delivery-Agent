import { describe, expect, it, vi } from "vitest";
import { findMatchingMilestoneRequest } from "../packages/data/src/milestone-request-proof.js";
import { rawSqlText } from "./fixtures/read-only-sql.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { customerId: id(1), subject: "synthetic-dual-role", roles: ["leadership", "pmo_admin"] as ("leadership" | "pmo_admin")[] };
const observation = { projectId: id(2), milestoneId: id(3), asOf: "2026-10-21T12:00:00.000Z",
  ruleRevision: "milestone-required-state/v1" as const, outcome: "CONFLICTING" as const, positions: [] };
const identity = "synthetic exact contributor identity";

function fixture() {
  const request = { id: id(4), sealed: true, state: "OPEN", contributorIdentity: identity,
    originalAssessmentId: id(5), createdAt: new Date("2026-10-20T12:00:00.000Z") };
  const header = { id: id(5), sealed: true, complete: true, status: "CONFLICTING", milestoneId: observation.milestoneId,
    ruleRevision: observation.ruleRevision, targetCount: 2, requiredLinkCount: 1, versionCount: 2, evidenceCount: 2,
    conflictCount: 0, contributorCount: 2, bytes: 512 };
  const targets = [10, 11].map((n) => ({ id: id(n), scalarAssessmentId: id(n + 10) }));
  const children = [20, 21].map((n) => ({ id: id(n), factId: id(n + 10), sealed: true, complete: true,
    versionCount: 1, conflictCount: 0, policyThroughRevision: 1, conflictThroughRevision: null }));
  const versions = [20, 21].map((n) => ({ assessmentId: id(n), factId: id(n + 10), versionId: id(n + 20),
    version: { id: id(n + 20), factId: id(n + 10), sourceId: id(n + 30), provenance: "HUMAN_CONFIRMED",
      evidence: { source: { id: id(n + 30), factId: id(n + 10), sourceType: "human_statement" } } } }));
  const contributors = [10, 11].map((n) => ({ targetRowId: id(n), versionId: id(n + 30) }));
  const access = [20, 21].map((n) => ({ sourceId: id(n + 30), factId: id(n + 10), state: "AVAILABLE", readers: [{ subject: actor.subject }] }));
  const state = { request: request as typeof request | null, header, targets, children, versions, contributors, access, valid: true,
    bytes: children.map((row) => ({ id: row.id, bytes: 256 })) };
  const tx = {
    milestoneReconciliationRequest: { findUnique: vi.fn(async () => state.request) },
    milestoneConsistencyTarget: { findMany: vi.fn(async () => state.targets) },
    factAssessment: { findMany: vi.fn(async () => state.children) },
    factAssessmentVersion: { findMany: vi.fn(async () => state.versions) },
    factAssessmentConflict: { findMany: vi.fn(async () => []) },
    milestoneConsistencyContributorVersion: { findMany: vi.fn(async () => state.contributors) },
    factSourceAccess: { findMany: vi.fn(async () => state.access) },
    $queryRaw: vi.fn(async (arg: unknown) => {
      const sql = rawSqlText(arg);
      if (sql.includes('FROM public."MilestoneConsistencyAssessment"')) return [state.header];
      if (sql.includes('FROM public."FactAssessment"')) return state.bytes;
      if (sql.includes("valid_milestone_reconciliation_request")) return [{ valid: state.valid }];
      throw new Error("Unexpected query");
    }),
  };
  return { state, tx, run: () => findMatchingMilestoneRequest(tx as never, actor, observation, identity) };
}

describe("matching recorded milestone request proof", () => {
  it("reports absence only for a missing scoped unique key", async () => {
    const f = fixture(); f.state.request = null;
    await expect(f.run()).resolves.toBe("NO_MATCHING_REQUEST_RECORDED");
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    const lookup = f.tx.milestoneReconciliationRequest.findUnique.mock.calls[0]?.[0] as unknown as { where: Record<string, unknown> };
    expect(JSON.stringify(lookup.where)).not.toContain("sealed");
    expect(JSON.stringify(lookup.where)).not.toContain('"state"');
  });
  it("returns a match only after complete bounded human proof and current source access", async () => {
    const f = fixture();
    await expect(f.run()).resolves.toBe("MATCHING_REQUEST_RECORDED");
    expect(f.tx.$queryRaw.mock.calls.some((call) => rawSqlText(call[0]).includes("valid_milestone_reconciliation_request"))).toBe(true);
  });
  it("withholds corrupt, inaccessible, oversized or unsupported matching records", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.state.request!.sealed = false; },
      (f: ReturnType<typeof fixture>) => { f.state.request!.contributorIdentity = "different despite matching hash"; },
      (f: ReturnType<typeof fixture>) => { f.state.request!.createdAt = new Date("2026-10-22T00:00:00.000Z"); },
      (f: ReturnType<typeof fixture>) => { f.state.header.bytes = 4 * 1024 * 1024 + 1; },
      (f: ReturnType<typeof fixture>) => { f.state.children[0]!.versionCount = 2; },
      (f: ReturnType<typeof fixture>) => { f.state.versions[0]!.version.provenance = "SYSTEM_VERIFIED"; },
      (f: ReturnType<typeof fixture>) => { f.state.versions[0]!.version.evidence.source.sourceType = "jira"; },
      (f: ReturnType<typeof fixture>) => { f.state.access[0]!.readers = []; },
      (f: ReturnType<typeof fixture>) => { f.state.valid = false; },
    ]) { const f = fixture(); mutate(f); await expect(f.run()).rejects.toThrow("Milestone request proof unavailable"); }
  });
});
