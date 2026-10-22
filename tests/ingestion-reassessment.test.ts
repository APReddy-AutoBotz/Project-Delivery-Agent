// EXEC-019 / AC-CON-004 / NFR-SEC-001: bounded operator contract.
import { expect, it, vi } from "vitest";
import { ingestionReassessmentRetrySchema, ingestionReassessmentPageSchema, ProjectUpdateError } from "../packages/domain/dist/index.js";
import { ProjectUpdateController, unavailableProjectUpdateRepository } from "../apps/api/dist/project-update-controller.js";
const id = "30000000-0000-4000-8000-000000000001";
const actor = { customerId: id, subject: "operator", roles: ["pmo_admin"] };
const request = { headers: { authorization: "Bearer synthetic" }, correlationId: "retry-correlation" };
it("rejects caller-owned timing, scope, counters and completion references", () => {
  const valid = { workId: id, expectedRecoveryRevision: 0 };
  expect(ingestionReassessmentRetrySchema.safeParse(valid).success).toBe(true);
  for (const field of ["customerId", "projectId", "sourceId", "availableAt", "attemptCount", "assessmentId", "generation"])
    expect(ingestionReassessmentRetrySchema.safeParse({ ...valid, [field]: id }).success).toBe(false);
  for (const expectedRecoveryRevision of [-1, 1.5, "0", 2147483647])
    expect(ingestionReassessmentRetrySchema.safeParse({ ...valid, expectedRecoveryRevision }).success).toBe(false);
  expect(ingestionReassessmentPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  expect(ingestionReassessmentPageSchema.safeParse({ items: [], nextCursor: null, values: ["private"] }).success).toBe(false);
});
it("authenticates operator requests, rejects extra query/body input and calls only the narrow repository", async () => {
  const read = vi.fn(async () => ({ items: [], nextCursor: null }));
  const retry = vi.fn(async () => { throw new ProjectUpdateError("CONFLICT"); });
  const authenticate = vi.fn(async () => actor);
  const controller = new ProjectUpdateController({ ...unavailableProjectUpdateRepository,
    reassessments: read, retryReassessment: retry }, { authenticate } as never);
  expect(await controller.reassessments(request, id, {})).toEqual({ items: [], nextCursor: null });
  expect(read).toHaveBeenCalledWith(actor, id, undefined);
  for (const query of [{ cursor: [id] }, { cursor: "bad" }, { limit: 1000 }, { customerId: id }])
    await expect(controller.reassessments(request, id, query)).rejects.toMatchObject({ status: 400 });
  expect(read).toHaveBeenCalledTimes(1);
  await expect(controller.retryReassessment(request, id, { workId: id, expectedRecoveryRevision: 0, reset: true })).rejects.toMatchObject({ status: 400 });
  expect(retry).not.toHaveBeenCalled();
  await expect(controller.retryReassessment(request, id, { workId: id, expectedRecoveryRevision: 0 })).rejects.toMatchObject({ status: 409 });
  expect(retry).toHaveBeenCalledWith(actor, id, { workId: id, expectedRecoveryRevision: 0 }, request.correlationId);
  await expect(controller.reassessments({ ...request, headers: {} }, id, {})).rejects.toMatchObject({ status: 401 });
  expect(read).toHaveBeenCalledTimes(1);
});
