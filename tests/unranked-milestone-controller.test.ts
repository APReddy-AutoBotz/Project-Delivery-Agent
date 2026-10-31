import { expect, it, vi } from "vitest";
import { MilestoneStateDisagreementError } from "../packages/domain/dist/index.js";
import { UnrankedMilestoneController, unavailableUnrankedMilestoneRepository } from "../apps/api/src/unranked-milestone-controller.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(2), milestoneId = id(3);
const actor = { customerId: id(1), subject: "synthetic-leader", roles: ["leadership"] };
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20),
  provenance: "HUMAN_CONFIRMED" as const, effectiveAt: "2026-10-20T00:00:00.000Z", observedAt: "2026-10-20T00:00:00.000Z",
  versionValidUntil: "2026-10-23T00:00:00.000Z" });
const result = { kind: "UNRANKED_NO_POLICY" as const, projectId, milestoneId, bindingId: id(4), factId: id(5),
  factType: "canonical.state.10000000000040008000000000000003", asOf: "2026-10-21T11:00:00.000Z",
  positions: [{ state: "COMPLETE" as const, supports: [support(30)] }, { state: "OPEN" as const, supports: [support(31)] }] };
const request = { headers: { authorization: "Bearer valid" } };
const setup = () => {
  const repository = { readUnrankedLeadership: vi.fn(async () => result) };
  const identity = { authenticate: vi.fn(async (token: string) => { if (token !== "valid") throw new Error("private-token-detail"); return actor; }) };
  return { repository, identity, controller: new UnrankedMilestoneController(repository as never, identity as never) };
};

it("authenticates and validates the exact scoped unranked response", async () => {
  const { controller, repository } = setup();
  expect(await controller.read(request, projectId, milestoneId, {})).toEqual(result);
  expect(repository.readUnrankedLeadership).toHaveBeenCalledWith(actor, projectId, milestoneId);
});

it("rejects credentials, path and query before accessing the repository", async () => {
  const { controller, repository } = setup();
  await expect(controller.read({ headers: {} }, projectId, milestoneId, {})).rejects.toMatchObject({ status: 401 });
  await expect(controller.read({ headers: { authorization: "Bearer invalid" } }, projectId, milestoneId, {})).rejects.toMatchObject({ status: 401 });
  await expect(controller.read({ headers: { authorization: `Bearer ${"x".repeat(16385)}` } }, projectId, milestoneId, {})).rejects.toMatchObject({ status: 401 });
  await expect(controller.read(request, "invalid", milestoneId, {})).rejects.toMatchObject({ status: 404 });
  await expect(controller.read(request, projectId, "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF", {})).rejects.toMatchObject({ status: 404 });
  await expect(controller.read(request, projectId, milestoneId, { scope: "all" })).rejects.toMatchObject({ status: 400 });
  expect(repository.readUnrankedLeadership).not.toHaveBeenCalled();
});

it("fails closed for denied access, untrusted output and infrastructure errors", async () => {
  const { controller, repository } = setup();
  repository.readUnrankedLeadership.mockRejectedValueOnce(new MilestoneStateDisagreementError("DENIED"));
  repository.readUnrankedLeadership.mockRejectedValueOnce(new MilestoneStateDisagreementError("UNAVAILABLE"));
  repository.readUnrankedLeadership.mockResolvedValueOnce({ ...result, milestoneId: id(99) });
  repository.readUnrankedLeadership.mockResolvedValueOnce({ ...result, projectId: id(99) });
  repository.readUnrankedLeadership.mockResolvedValueOnce({ ...result, privateMarker: "private-marker" } as never);
  repository.readUnrankedLeadership.mockResolvedValueOnce({ ...result, positions: [result.positions[0], result.positions[0]] } as never);
  repository.readUnrankedLeadership.mockRejectedValueOnce(new Error("private-infrastructure-detail"));
  for (const status of [404, 503, 503, 503, 503, 503, 503]) {
    try { await controller.read(request, projectId, milestoneId, {}); throw new Error("unexpected success"); }
    catch (error) {
      expect(error).toMatchObject({ status });
      expect(JSON.stringify(error)).not.toContain("private-marker");
      expect(JSON.stringify(error)).not.toContain("private-infrastructure-detail");
    }
  }
});

it("defaults to unavailable before a reader is configured", async () => {
  const { identity } = setup();
  const controller = new UnrankedMilestoneController(unavailableUnrankedMilestoneRepository, identity as never);
  await expect(controller.read(request, projectId, milestoneId, {})).rejects.toMatchObject({ status: 503 });
});
