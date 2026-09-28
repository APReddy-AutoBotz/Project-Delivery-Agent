import { describe, expect, it } from "vitest";
import { DatabaseProjectUpdateRepository } from "../packages/data/dist/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const firstProject = "30000000-0000-4000-8000-000000000001";
const secondProject = "30000000-0000-4000-8000-000000000002";
const scanTime = new Date("2026-01-01T00:00:00.000Z");

describe("Project update scheduled scan fairness", () => {
  it("rotates failed candidates, retries them later, and throttles successful snapshots", async () => {
    const attempts = new Map<string, Date | null>([
      [firstProject, null],
      [secondProject, null],
    ]);
    const nextEligible = new Map<string, Date | null>([
      [firstProject, null],
      [secondProject, null],
    ]);
    const applyUpdate = async (
      query: string,
      scopeCustomerId: string,
      projectId: string,
      intervalSeconds: number,
    ) => {
      expect(scopeCustomerId).toBe(customerId);
      if (query.includes('"scheduledScanLastAttemptAt"')) {
        attempts.set(projectId, scanTime);
        nextEligible.set(
          projectId,
          new Date(scanTime.getTime() + intervalSeconds * 1000),
        );
      } else {
        expect(query).toContain('"scheduledScanNextEligibleAt"');
        nextEligible.set(
          projectId,
          new Date(scanTime.getTime() + intervalSeconds * 1000),
        );
      }
      return 1;
    };
    const tx = {
      async $queryRawUnsafe<T>(query: string): Promise<T> {
        expect(query).toContain('"scheduledScanLastAttemptAt" ASC NULLS FIRST');
        expect(query).toContain('"scheduledScanNextEligibleAt"');
        const projectId = [...attempts.entries()]
          .filter(([id]) => {
            const dueAt = nextEligible.get(id) ?? null;
            return dueAt === null || dueAt <= scanTime;
          })
          .sort(([leftId, leftAt], [rightId, rightAt]) => {
            if (leftAt === null && rightAt !== null) return -1;
            if (rightAt === null && leftAt !== null) return 1;
            return (leftAt?.getTime() ?? 0) - (rightAt?.getTime() ?? 0) ||
              leftId.localeCompare(rightId);
          })[0]?.[0];
        return (projectId ? [{ customerId, projectId }] : []) as T;
      },
      $executeRawUnsafe: applyUpdate,
    };
    const db = {
      $executeRawUnsafe: applyUpdate,
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
    expect(attempts.get(firstProject)).toBe(scanTime);
    expect(nextEligible.get(firstProject)).toEqual(
      new Date(scanTime.getTime() + 5 * 60 * 1000),
    );

    await expect(repository.scanScheduledProjects(1)).resolves.toBe(1);
    expect(visited).toEqual([firstProject, secondProject]);
    expect(nextEligible.get(secondProject)).toEqual(
      new Date(scanTime.getTime() + 60 * 60 * 1000),
    );
    await expect(repository.scanScheduledProjects(1)).resolves.toBe(0);
    expect(visited).toEqual([firstProject, secondProject]);
  });
});
