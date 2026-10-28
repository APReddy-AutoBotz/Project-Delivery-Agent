import { expect, it, vi } from "vitest";
import { DatabaseProjectUpdateRepository } from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const portfolioId = "30000000-0000-4000-8000-000000000001";
const leader: Actor = { customerId, subject: "synthetic-leader", roles: ["leadership"] };
function fixture(options: { configured: boolean; grant: boolean; sealed?: boolean; fact?: boolean;
  grantRoles?: string[]; assigned?: boolean; requiredCount?: number }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT id FROM public."Project"')) return [{ id: projectId }];
    if (sql.startsWith('SELECT "portfolioId" FROM public."Project"')) return [{ portfolioId }];
    if (sql.includes('FROM public."AccessGrant"')) return options.grant
      ? (options.grantRoles ?? ["leadership"]).map((role) => ({ role })) : [];
    if (sql.includes('FROM public."CanonicalProject"') && !sql.includes('JOIN')) return [{ sealed: options.sealed ?? true }];
    if (sql.includes('FROM public."ProjectResponsibility"')) return options.assigned ? [{ id: projectId }] : [];
    if (sql.startsWith('SELECT revision FROM public."ProjectUpdatePolicy"')) return options.configured ? [{ revision: 2 }] : [];
    if (sql.includes('FROM public."ProjectUpdatePolicy" p')) return [{ projectId, revision: 2,
      freshnessWindowSeconds: 60, timeZone: "UTC", responsibleSubject: "synthetic-owner",
      requiredFacts: options.requiredCount === undefined ? [{ factType: "delivery.status", label: "Delivery status" }]
        : Array.from({ length: options.requiredCount }, (_, index) => ({ factType: `delivery.fact${index}`, label: `Fact ${index}` })) }];
    if (sql.includes('JOIN public."CanonicalProject"')) return [{ id: projectId, code: "P-1", name: "Synthetic", reportedStatus: "GREEN", createdAt: new Date("2026-10-21T10:59:59.000Z") }];
    if (sql.includes('FROM public."ProjectFact"')) return options.fact
      ? [{ id: "40000000-0000-4000-8000-000000000001", factType: "delivery.status", revision: 1 }] : [];
    if (sql.includes("clock_timestamp()")) return [{ now: new Date("2026-10-21T11:00:00.000Z") }];
    throw new Error(`Unexpected query: ${sql}`);
  });
  const execute = vi.fn();
  const tx = { $queryRawUnsafe: query, $executeRawUnsafe: execute };
  const db = { $transaction: async (operation: (value: typeof tx) => unknown, config: { isolationLevel: string }) => {
    expect(config.isolationLevel).toBe("ReadCommitted");
    return operation(tx);
  } };
  return { repository: new DatabaseProjectUpdateRepository(db as never), query, execute };
}

it("returns unconfigured only after authorization and holds the project gate first", async () => {
  const { repository, query, execute } = fixture({ configured: false, grant: true });
  expect(await repository.updateSuggestions(leader, projectId)).toMatchObject({ availability: "UNCONFIGURED", audience: "leadership" });
  expect(query.mock.calls[0]![0]).toContain('FROM public."Project"');
  expect(query.mock.calls[0]![0]).toContain("FOR SHARE");
  expect(execute).not.toHaveBeenCalled();
});
it("denies a user without a current qualifying grant before returning policy state", async () => {
  const { repository, query } = fixture({ configured: false, grant: false });
  await expect(repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "DENIED" });
  expect(query.mock.calls.some(([sql]) => sql.includes('FROM public."ProjectUpdatePolicy"'))).toBe(false);
});
it("selects PM wording only for a fully qualified assigned PM, otherwise independently qualified leadership", async () => {
  const dual: Actor = { ...leader, roles: ["project_manager", "leadership"] };
  const assigned = fixture({ configured: false, grant: true, assigned: true, grantRoles: ["project_manager", "leadership"] });
  expect(await assigned.repository.updateSuggestions(dual, projectId)).toMatchObject({ audience: "project_manager" });
  const unassigned = fixture({ configured: false, grant: true, assigned: false, grantRoles: ["project_manager", "leadership"] });
  expect(await unassigned.repository.updateSuggestions(dual, projectId)).toMatchObject({ audience: "leadership" });
  const pmOnly = fixture({ configured: false, grant: true, assigned: false, grantRoles: ["project_manager"] });
  await expect(pmOnly.repository.updateSuggestions(dual, projectId)).rejects.toMatchObject({ code: "DENIED" });
});
it("returns missing required information with a creation-time fallback and no writes", async () => {
  const { repository, query, execute } = fixture({ configured: true, grant: true });
  const result = await repository.updateSuggestions(leader, projectId);
  expect(result).toMatchObject({ availability: "AVAILABLE", freshness: { sourceDateField: "project.createdAt" },
    completeness: { state: "INCOMPLETE" }, suggestion: { category: "UPDATE_FOLLOW_UP" } });
  const factIndex = query.mock.calls.findIndex(([sql]) => sql.includes('FROM public."ProjectFact"'));
  const clockIndex = query.mock.calls.findIndex(([sql]) => sql.includes("clock_timestamp()"));
  expect(factIndex).toBeGreaterThan(0);
  expect(clockIndex).toBeGreaterThan(factIndex);
  expect(execute).not.toHaveBeenCalled();
});
it("fails closed on an unsealed canonical graph", async () => {
  const { repository } = fixture({ configured: false, grant: true, sealed: false });
  await expect(repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("does not reveal an unsealed graph to an unauthorized user", async () => {
  const { repository } = fixture({ configured: false, grant: false, sealed: false });
  await expect(repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "DENIED" });
});
it("withholds all details when a required fact contains a restricted version", async () => {
  const { repository, execute } = fixture({ configured: true, grant: true, fact: true });
  const factId = "40000000-0000-4000-8000-000000000001";
  (repository as unknown as { authority: unknown }).authority = {
    loadAssessmentPrefixesInTransaction: async () => new Map([[factId, {}]]),
    prepareAssessmentInTransaction: async () => ({ complete: true, versions: [], access: [],
      result: { status: "REVALIDATION_REQUIRED", conflict: "NONE", versions: [{ id: factId, visibility: "restricted" }] } }),
  };
  await expect(repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(execute).not.toHaveBeenCalled();
});
it("does not fall back to an unbounded authority read when a prefix is missing", async () => {
  const { repository } = fixture({ configured: true, grant: true, fact: true });
  const prepare = vi.fn();
  (repository as unknown as { authority: unknown }).authority = {
    loadAssessmentPrefixesInTransaction: async () => new Map(), prepareAssessmentInTransaction: prepare,
  };
  await expect(repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(prepare).not.toHaveBeenCalled();
});
it("maps a transaction conflict to unavailable for the read-only endpoint", async () => {
  const db = { $transaction: async () => { throw { code: "P2034" }; } };
  const repository = new DatabaseProjectUpdateRepository(db as never);
  await expect(repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("accepts 100 required types and fails closed on an over-budget policy", async () => {
  const bounded = fixture({ configured: true, grant: true, requiredCount: 100 });
  const result = await bounded.repository.updateSuggestions(leader, projectId);
  if (result.availability !== "AVAILABLE") throw new Error("unexpected availability");
  expect(result.completeness.requiredCount).toBe(100);
  expect(result.suggestion?.triggeringFactTypes).toHaveLength(100);
  const over = fixture({ configured: true, grant: true, requiredCount: 101 });
  await expect(over.repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("fails closed when the authority prefix loader reports overflow", async () => {
  const { repository } = fixture({ configured: true, grant: true, fact: true });
  (repository as unknown as { authority: unknown }).authority = {
    loadAssessmentPrefixesInTransaction: async () => null,
  };
  await expect(repository.updateSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
it("uses human observation and validated connector times without serializing fact values", async () => {
  const factId = "40000000-0000-4000-8000-000000000001";
  const versionId = "50000000-0000-4000-8000-000000000001";
  const sourceId = "60000000-0000-4000-8000-000000000001";
  const evidenceId = "70000000-0000-4000-8000-000000000001";
  for (const [sourceType, validated, expectedTime, basis] of [
    ["human_statement", false, "2026-10-21T10:59:50.000Z", "HUMAN_OBSERVED_AT"],
    ["jira_connector", true, "2026-10-21T10:59:40.000Z", "CONNECTOR_EFFECTIVE_AT"],
  ] as const) {
    const { repository } = fixture({ configured: true, grant: true, fact: true });
    const version = { id: versionId, sourceId, evidenceId, effectiveAt: new Date("2026-10-21T10:59:40.000Z"),
      value: { type: "json", value: { secret: "never serialized" } }, evidence: { observedAt: new Date("2026-10-21T10:59:50.000Z") } };
    (repository as unknown as { authority: unknown }).authority = {
      loadAssessmentPrefixesInTransaction: async () => new Map([[factId, {}]]),
      prepareAssessmentInTransaction: async () => ({ complete: true, versions: [version],
        snapshot: { versions: [{ id: versionId, effectiveAtValidated: validated }] },
        access: [{ sourceId, state: "AVAILABLE", revision: 1, readers: [{ subject: leader.subject }] }],
        event: { revision: 1 }, result: { status: "RESOLVED", conflict: "NONE", supportingVersionIds: [versionId],
          selectedTier: 0, policy: { tiers: [{ selectors: [{ sourceType, instanceId: null, validity: { basis: "effectiveAt" } }] }] },
          versions: [{ id: versionId, visibility: "available", sourceType }] } }),
    };
    const result = await repository.updateSuggestions(leader, projectId);
    if (result.availability !== "AVAILABLE") throw new Error("unexpected availability");
    expect(result.freshness.sourceDate).toBe(expectedTime);
    expect(result.evidence[0]?.timestampBasis).toBe(basis);
    expect(JSON.stringify(result)).not.toContain("never serialized");
  }
});
