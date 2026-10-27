import { expect, it, vi } from "vitest";
import { DatabaseHealthAssessmentRepository } from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const portfolioId = "30000000-0000-4000-8000-000000000001";
const leader: Actor = { customerId, subject: "synthetic-leader", roles: ["leadership"] };

function readerFixture(options: { sealed: boolean; milestoneCount: number }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM public."Project"')) return [{ portfolioId, reportedStatus: "GREEN" }];
    if (sql.includes('FROM public."AccessGrant"')) return [{ role: "leadership" }];
    if (sql.includes('FROM public."ProjectResponsibility"')) return [];
    if (sql.includes("pg_advisory_xact_lock_shared")) return [{ locked: true }];
    if (sql.includes('FROM public."ScheduleHealthPolicyRevision"')) return [];
    if (sql.includes('FROM public."CanonicalProject"')) return [{ revision: 1, sealed: options.sealed }];
    if (sql.includes('FROM public."Milestone"')) return Array.from({ length: options.milestoneCount }, (_, index) => ({
      id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      key: `MILESTONE-${index}`,
      state: "OPEN",
      forecastEnd: null,
      plannedEnd: null,
    }));
    if (sql.includes('FROM public."WorkItem"')) return [];
    if (sql.includes("clock_timestamp()")) return [{ now: new Date("2026-10-21T11:00:00.000Z") }];
    throw new Error("Unexpected query");
  });
  const execute = vi.fn();
  const tx = { $queryRawUnsafe: query, $executeRawUnsafe: execute };
  const db = { $transaction: async (operation: (value: typeof tx) => unknown) => operation(tx) };
  return {
    repository: new DatabaseHealthAssessmentRepository(db as never),
    query,
    execute,
  };
}

it("fails closed for an unsealed canonical graph without reading its children", async () => {
  const { repository, query, execute } = readerFixture({ sealed: false, milestoneCount: 0 });
  await expect(repository.scheduleSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(query.mock.calls.some(([sql]) => sql.includes('FROM public."Milestone"'))).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it("fails closed when the schedule cohort exceeds its bound instead of truncating", async () => {
  const { repository, query, execute } = readerFixture({ sealed: true, milestoneCount: 51 });
  await expect(repository.scheduleSuggestions(leader, projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(query.mock.calls.some(([sql]) => sql.includes("clock_timestamp()"))).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

it("accepts a complete cohort at the configured bound", async () => {
  const { repository, execute } = readerFixture({ sealed: true, milestoneCount: 50 });
  const result = await repository.scheduleSuggestions(leader, projectId);
  expect(result.items).toHaveLength(50);
  expect(result.items.every((item) => item.category === "EVIDENCE_REVIEW")).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});
