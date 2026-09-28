import { describe, expect, it } from "vitest";
import { DatabaseProjectUpdateRepository } from "../packages/data/dist/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const firstProject = "30000000-0000-4000-8000-000000000001";
const secondProject = "30000000-0000-4000-8000-000000000002";

describe("Project update scheduled scan fairness", () => {
  it("rotates past a candidate whose assessment keeps failing", async () => {
    const attempts = new Map<string, Date | null>([
      [firstProject, null],
      [secondProject, null],
    ]);
    let tick = 0;
    const tx = {
      async $queryRawUnsafe<T>(query: string): Promise<T> {
        expect(query).toContain('"scheduledScanLastAttemptAt" ASC NULLS FIRST');
        const projectId = [...attempts.entries()]
          .sort(([leftId, leftAt], [rightId, rightAt]) => {
            if (leftAt === null && rightAt !== null) return -1;
            if (rightAt === null && leftAt !== null) return 1;
            return (leftAt?.getTime() ?? 0) - (rightAt?.getTime() ?? 0) ||
              leftId.localeCompare(rightId);
          })[0]?.[0];
        return (projectId ? [{ customerId, projectId }] : []) as T;
      },
      async $executeRawUnsafe(query: string, scopeCustomerId: string, projectId: string) {
        expect(query).toContain('"scheduledScanLastAttemptAt"');
        expect(scopeCustomerId).toBe(customerId);
        attempts.set(projectId, new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
        return 1;
      },
    };
    const db = {
      async $transaction<T>(
        operation: (transaction: typeof tx) => Promise<T>,
      ): Promise<T> {
        return operation(tx);
      },
    };
    const repository = new DatabaseProjectUpdateRepository(
      db as never,
      "scanner@example.invalid",
    );
    const visited: string[] = [];
    Object.defineProperty(repository, "assessCore", {
      value: async (_actor: unknown, projectId: string) => {
        visited.push(projectId);
        if (projectId === firstProject)
          throw new Error("simulate an unassessable project");
      },
    });

    await expect(repository.scanScheduledProjects(1))
      .rejects.toThrow("simulate an unassessable project");
    expect(attempts.get(firstProject)).toBeInstanceOf(Date);
    await expect(repository.scanScheduledProjects(1)).resolves.toBe(1);
    expect(visited).toEqual([firstProject, secondProject]);
  });
});
