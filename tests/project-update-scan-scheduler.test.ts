// AC-HLT-001 / NFR-REL-001: coordinator control flow; native handoff tests prove SQL.
import { describe, expect, it } from "vitest";
import { ProjectUpdateScanCoordinator, isReassessmentContention } from "../packages/data/dist/project-update-scan.js";
const customerId = "10000000-0000-4000-8000-000000000001";
const firstProject = "30000000-0000-4000-8000-000000000001";
const secondProject = "30000000-0000-4000-8000-000000000002";
const now = new Date("2026-01-01T00:00:00.000Z");
describe("unified project update scan", () => {
  it("rotates failures fairly, preserves their backoff and throttles success for an hour", async () => {
    const state = new Map([firstProject, secondProject].map((id) => [id, {
      attempted: null as Date | null, due: null as Date | null, failure: null as Date | null,
      generation: 0, until: null as Date | null,
    }]));
    const tx = {
      async $queryRaw(sql: TemplateStringsArray, ...values: unknown[]) {
        const query = sql.join("?");
        if (query.includes("AS now")) return [{ now }];
        if (query.includes("FOR UPDATE OF p SKIP LOCKED")) {
          expect(query).toContain('"scheduledScanLastAttemptAt" ASC NULLS FIRST');
          expect(query).toContain('"scanFailureNextEligibleAt"');
          expect(query).toContain('w."availableAt"<=');
          const candidate = [...state.entries()].filter(([, h]) => (!h.failure || h.failure <= now) &&
            (!h.due || h.due <= now) && (!h.until || h.until <= now))
            .sort(([a, x], [b, y]) => (x.attempted?.getTime() ?? -1) - (y.attempted?.getTime() ?? -1) || a.localeCompare(b))[0];
          return candidate ? [{ customerId, projectId: candidate[0] }] : [];
        }
        if (query.includes('FROM public."IngestionProjectReassessment"')) return [];
        if (query.includes('FROM public."Project"')) return [{ id: values[1] }];
        const h = state.get(values[1] as string)!;
        if (query.includes("AS generation")) return h.until && h.until > now && h.generation === values[2] ? [{ generation: h.generation }] : [];
        return [{ scanClaimGeneration: h.generation, scanClaimUntil: h.until,
          scanFailureNextEligibleAt: h.failure, scheduledScanNextEligibleAt: h.due }];
      },
      async $executeRaw(sql: TemplateStringsArray, ...values: unknown[]) {
        const query = sql.join("?");
        if (query.includes('"scheduledScanLastAttemptAt"=')) {
          const h = state.get(values[4] as string)!;
          h.generation = values[0] as number; h.until = values[1] as Date; h.attempted = values[2] as Date;
        } else {
          const h = state.get(values[2] as string)!; h.until = null;
          if (query.includes('"scheduledScanNextEligibleAt"=')) { h.due = values[0] as Date; h.failure = null; }
          else h.failure = values[0] as Date;
        }
        return 1;
      },
    };
    const db = { $transaction: <T>(run: (txValue: typeof tx) => Promise<T>) => run(tx) };
    const visited: string[] = [];
    const coordinator = new ProjectUpdateScanCoordinator(db as never, "scanner@example.invalid", async (_tx, _actor, id) => {
      visited.push(id);
      if (id === firstProject) throw new Error("synthetic assessment failure");
      return { assessmentId: "synthetic", view: {} } as never;
    });
    await expect(coordinator.scan()).rejects.toThrow("synthetic assessment failure");
    expect(state.get(firstProject)!.failure).toEqual(new Date(now.getTime() + 300000));
    expect(await coordinator.scan()).toBe(1);
    expect(state.get(secondProject)!.due).toEqual(new Date(now.getTime() + 3600000));
    expect(await coordinator.scan()).toBe(0);
    expect(visited).toEqual([firstProject, secondProject]);
  });
  it("classifies only structured PostgreSQL lock-not-available errors as contention", () => {
    expect(isReassessmentContention({ code: "55P03" })).toBe(true);
    expect(isReassessmentContention({ meta: { code: "55P03" } })).toBe(true);
    expect(isReassessmentContention({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "55P03" } } } })).toBe(true);
    expect(isReassessmentContention(new Error("55P03 private source"))).toBe(false);
    expect(isReassessmentContention({ code: "P2010", meta: { code: "40001" } })).toBe(false);
  });
});
