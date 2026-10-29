import { afterEach, expect, it, vi } from "vitest";
import { DatabasePmActionQueueRepository } from "../packages/data/src/pm-action-queue.js";
import { DatabaseHealthAssessmentRepository } from "../packages/data/src/health-assessment.js";
import { DatabaseProjectUpdateRepository } from "../packages/data/src/project-updates.js";
import { buildScheduleAdviceSnapshot } from "../packages/domain/src/delivery-advice.js";

const customerId = "10000000-0000-4000-8000-000000000001", portfolioId = "20000000-0000-4000-8000-000000000001";
const id = (i: number) => `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const actor = { customerId, subject: "synthetic-pm", roles: ["project_manager"] as const };
const asOf = "2026-10-21T11:00:00.000Z";
function schedule(projectId: string) {
  return buildScheduleAdviceSnapshot({ asOf, recipient: { subject: actor.subject, audience: "project_manager" },
    snapshot: { projectId, projectRevision: 1, reportedStatus: "UNKNOWN", assessedAt: asOf,
      scheduleHealthPolicy: { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] },
      milestones: [], workItems: [] } });
}
function fixture(options: { initial?: string[]; final?: string[]; noGrant?: boolean; noAssignment?: boolean; failLock?: boolean } = {}) {
  const initial = options.initial ?? [id(1), id(2)], final = options.final ?? initial, trace: string[] = [];
  let discoveries = 0;
  const tx = {
    $executeRawUnsafe: vi.fn(async (sql: string) => { trace.push(sql); return 0; }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      if (sql.startsWith('SELECT p.id FROM public."Project" p')) {
        expect(params).toEqual([customerId, actor.subject]); expect(sql).toContain("EXISTS");
        trace.push("discover"); return (++discoveries === 1 ? initial : final).map((value) => ({ id: value }));
      }
      if (sql.startsWith('SELECT id FROM public."Project"')) {
        expect(params[0]).toBe(customerId); trace.push("lock:" + params[1]);
        return options.failLock ? [] : [{ id: params[1] }];
      }
      if (sql.startsWith('SELECT name,"portfolioId"')) return [{ name: "Synthetic", portfolioId }];
      if (sql.startsWith('SELECT id FROM public."AccessGrant"')) {
        trace.push("grant:" + params[2]); expect(params).toEqual([customerId, actor.subject, params[2], portfolioId]);
        return options.noGrant ? [] : [{ id: "grant-1" }, { id: "grant-2" }];
      }
      if (sql.startsWith('SELECT r.id FROM public."ProjectResponsibility"')) {
        expect(params).toEqual([customerId, params[1], actor.subject]); return options.noAssignment ? [] : [{ id: "assignment" }];
      }
      throw new Error("Unexpected fake query");
    }),
  };
  const db = { $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>, options: unknown) => {
    expect(options).toMatchObject({ isolationLevel: "ReadCommitted", timeout: 20000 }); return fn(tx);
  }) };
  const health = vi.spyOn(DatabaseHealthAssessmentRepository.prototype, "scheduleSuggestionsInTransaction")
    .mockImplementation(async (received, who, projectId) => { expect(received).toBe(tx); expect(who.subject).toBe(actor.subject); trace.push("schedule:" + projectId); return schedule(projectId); });
  const update = vi.spyOn(DatabaseProjectUpdateRepository.prototype, "updateSuggestionsInTransaction")
    .mockImplementation(async (received, who, projectId) => { expect(received).toBe(tx); expect(who.subject).toBe(actor.subject); trace.push("update:" + projectId);
      return { availability: "UNCONFIGURED", asOf, projectId, audience: "project_manager", approvalItems: "UNAVAILABLE" }; });
  return { repository: new DatabasePmActionQueueRepository(db as never), tx, trace, health, update, db };
}
afterEach(() => vi.restoreAllMocks());

it("locks all candidate projects before reading facets and rechecks membership", async () => {
  const f = fixture(), result = await f.repository.read({ ...actor, roles: [...actor.roles] });
  expect(result.projects.map((project) => project.projectId)).toEqual([id(1), id(2)]);
  expect(f.trace.slice(2, 5)).toEqual(["discover", "lock:" + id(1), "lock:" + id(2)]);
  expect(f.trace.indexOf("grant:" + id(1))).toBeLessThan(f.trace.indexOf("schedule:" + id(1)));
  expect(f.trace.at(-1)).toBe("discover");
  expect(f.tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual(["SET LOCAL statement_timeout='8s'", "SET LOCAL lock_timeout='3s'"]);
});
it("denies a non-PM before opening a transaction", async () => {
  const f = fixture(); await expect(f.repository.read({ ...actor, roles: ["leadership"] })).rejects.toMatchObject({ code: "DENIED" });
  expect(f.db.$transaction).not.toHaveBeenCalled();
});
it.each(["noGrant", "noAssignment", "failLock"] as const)("fails closed on %s", async (key) => {
  const f = fixture({ [key]: true }); await expect(f.repository.read({ ...actor, roles: [...actor.roles] })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.health).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
});
it("rejects a changed membership set without returning earlier results", async () => {
  const f = fixture({ final: [id(1), id(2), id(3)] });
  await expect(f.repository.read({ ...actor, roles: [...actor.roles] })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.health).toHaveBeenCalledTimes(2); expect(f.update).toHaveBeenCalledTimes(2);
});
it("rejects duplicate, unsorted and overflow project sets before reading facets", async () => {
  for (const initial of [[id(1), id(1)], [id(2), id(1)], Array.from({ length: 26 }, (_, i) => id(i + 1))]) {
    const f = fixture({ initial }); await expect(f.repository.read({ ...actor, roles: [...actor.roles] })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.health).not.toHaveBeenCalled(); vi.restoreAllMocks();
  }
});
it("fails the whole response on a facet error or leadership fallback", async () => {
  const f = fixture(); f.update.mockRejectedValueOnce(new Error("private source error"));
  await expect(f.repository.read({ ...actor, roles: [...actor.roles] })).rejects.toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
  vi.restoreAllMocks();
  const g = fixture(); g.update.mockResolvedValueOnce({ availability: "UNCONFIGURED", asOf, projectId: id(1), audience: "leadership", approvalItems: "UNAVAILABLE" });
  await expect(g.repository.read({ ...actor, roles: [...actor.roles] })).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
