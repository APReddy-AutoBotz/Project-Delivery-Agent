import { expect, it, vi } from "vitest";
import { DatabaseProjectRepository } from "../packages/data/src/index.js";
import type { Actor } from "../packages/domain/src/index.js";

const actor: Actor = { customerId: "10000000-0000-4000-8000-000000000001", subject: "operator", roles: ["system_admin"] };

it("applies the customer and event filters before limiting the operation projection", async () => {
  const findMany = vi.fn(async () => [{
    id: "50000000-0000-4000-8000-000000000001", event: "access.granted",
    actor: "synthetic", occurredAt: new Date("2026-09-06T00:00:00.000Z"),
  }]);
  const repository = new DatabaseProjectRepository({ auditEvent: { findMany } } as never);
  expect(await repository.listAccessOperations(actor)).toHaveLength(1);
  expect(findMany).toHaveBeenCalledWith({
    where: { customerId: actor.customerId, event: { in: ["access.granted", "access.revoked"] } },
    select: { id: true, event: true, actor: true, occurredAt: true },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 30,
  });
  expect(await repository.listAudit(actor)).toHaveLength(1);
  expect(findMany).toHaveBeenCalledTimes(2);
});

it("rejects unsupported roles and unexpected event kinds", async () => {
  const findMany = vi.fn(async () => [{ id: "id", event: "health.assessed", actor: "synthetic", occurredAt: new Date() }]);
  const repository = new DatabaseProjectRepository({ auditEvent: { findMany } } as never);
  await expect(repository.listAccessOperations({ ...actor, roles: ["pmo_admin"] })).rejects.toThrow();
  await expect(repository.listAudit({ ...actor, roles: ["pmo_admin"] })).rejects.toThrow();
  expect(findMany).not.toHaveBeenCalled();
  await expect(repository.listAccessOperations(actor)).rejects.toThrow();
});
