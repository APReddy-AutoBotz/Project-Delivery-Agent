import { expect, it } from "vitest";
import { DatabaseProjectFactRepository } from "../packages/data/dist/index.js";
import { ProjectFactError } from "../packages/domain/dist/index.js";

it("sanitizes a failed denial audit without returning its database exception", async () => {
  const raw = new Error("private SQL connection and statement contents");
  const repository = new DatabaseProjectFactRepository({
    $transaction: async () => {
      throw new ProjectFactError("DENIED");
    },
    auditEvent: {
      create: async () => {
        throw raw;
      },
    },
  } as never);
  const actor = {
    customerId: "10000000-0000-4000-8000-000000000001",
    subject: "manager",
    roles: ["project_manager"] as const,
  };
  await expect(
    repository.appendHumanStatement(
      { ...actor, roles: [...actor.roles] },
      {
        projectId: "30000000-0000-4000-8000-000000000001",
        factType: "project.forecast",
        expectedRevision: 0,
        idempotencyKey: "key",
        originalStatement: "Human statement",
        value: { type: "text", value: "assertion" },
        effectiveAt: "2026-09-09T00:00:00.000Z",
      },
      { correlationId: "denial-audit-error" },
    ),
  ).rejects.toThrow("Project fact audit failed");
});
