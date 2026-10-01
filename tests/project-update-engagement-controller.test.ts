// NFR-SEC-001 / TR-API-001: identity, bounded inputs and denial responses.
import "../apps/api/dist/app.js";
import { describe, expect, it, vi } from "vitest";
import { ProjectUpdateController, unavailableProjectUpdateRepository } from "../apps/api/dist/project-update-controller.js";
import { ProjectUpdateError } from "../packages/domain/dist/index.js";
const projectId = "30000000-0000-4000-8000-000000000001";
const actor = { customerId: "10000000-0000-4000-8000-000000000001", subject: "operator", roles: ["pmo_admin"] };
const req = { headers: { authorization: "Bearer fixture" }, correlationId: "50000000-0000-4000-8000-000000000001" };
describe("engagement activation controller", () => {
  function fixture() {
    const activate = vi.fn().mockResolvedValue(null);
    const authenticate = vi.fn().mockResolvedValue(actor);
    const controller = new ProjectUpdateController({ ...unavailableProjectUpdateRepository, activateEngagement: activate },
      { authenticate } as never);
    return { controller, activate, authenticate };
  }
  it("passes only the authenticated actor and reviewed revision to the repository", async () => {
    const f = fixture();
    expect(await f.controller.activateEngagement(req, projectId, { expectedPolicyRevision: 1 })).toBeNull();
    expect(f.activate).toHaveBeenCalledWith(actor, projectId, 1, req.correlationId);
  });
  it("requires identity before accepting an activation", async () => {
    const f = fixture();
    await expect(f.controller.activateEngagement({ ...req, headers: {} }, projectId, { expectedPolicyRevision: 1 })).rejects.toMatchObject({ status: 401 });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it.each(["mode", "recipientSubject", "factTypes", "customerTimeZone"])("rejects forged %s without executing", async (key) => {
    const f = fixture();
    await expect(f.controller.activateEngagement(req, projectId, { expectedPolicyRevision: 1, [key]: "forged" })).rejects.toMatchObject({ status: 400 });
    expect(f.activate).not.toHaveBeenCalled();
  });
  it.each([["DENIED", 404], ["FORBIDDEN", 403], ["CONFLICT", 409], ["UNAVAILABLE", 503]] as const)(
    "maps %s to a non-disclosing response", async (code, status) => {
      const f = fixture();
      f.activate.mockRejectedValue(new ProjectUpdateError(code));
      await expect(f.controller.activateEngagement(req, projectId, { expectedPolicyRevision: 1 })).rejects.toMatchObject({ status });
    },
  );
});
