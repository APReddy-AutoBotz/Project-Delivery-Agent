import { describe, expect, it, vi } from "vitest";
import { createTasks } from "../apps/worker/src/tasks.js";

describe("health assessment retention worker task", () => {
  it("runs the scoped database purge callback", async () => {
    const purge = vi.fn(async () => undefined);
    const tasks = createTasks(
      { recordHeartbeat: async () => undefined },
      undefined,
      fetch,
      undefined,
      purge,
    );
    await tasks.health_assessment_retention();
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("fails closed if the privileged purge callback is not wired", async () => {
    const tasks = createTasks({ recordHeartbeat: async () => undefined });
    await expect(tasks.health_assessment_retention()).rejects.toThrow(
      "health_assessment_retention_unavailable",
    );
  });
});
