import "../apps/api/dist/app.js";
import { expect, it, vi } from "vitest";
import { renderAtlasManagementSnapshot } from "../apps/api/dist/atlas-management-snapshot.js";
import { ProjectUpdateController, unavailableProjectUpdateRepository } from "../apps/api/dist/project-update-controller.js";
import type { AtlasManagementSnapshot } from "../packages/domain/dist/index.js";

vi.mock("../apps/api/dist/atlas-management-snapshot.js", async (original) => ({
  ...await original<typeof import("../apps/api/dist/atlas-management-snapshot.js")>(),
  renderAtlasManagementSnapshot: vi.fn(),
}));

it("leaves the report awaiting approval when its final PowerPoint cannot be rendered", async () => {
  const projectId = "30000000-0000-4000-8000-000000000001";
  const snapshotId = "30000000-0000-4000-8000-000000000002";
  const requestId = "30000000-0000-4000-8000-000000000003";
  const now = "2026-10-01T12:00:00.000Z";
  const actor = { customerId: "10000000-0000-4000-8000-000000000001", subject: "pm-atlas", roles: ["project_manager"] };
  const req = { headers: { authorization: "Bearer fixture" }, correlationId: "50000000-0000-4000-8000-000000000001" };
  const pending: AtlasManagementSnapshot = {
    id: snapshotId, projectId, asOf: now, reportingPeriod: "2026-10", classification: "SYNTHETIC_INTERNAL",
    approvalState: "PENDING", approval: { requestId, approver: actor.subject, decidedAt: null },
    schedule: { revision: 1, baseline: "2026-10-15", forecast: "2026-10-29", movementDays: 14 },
    ownerReply: { responseId: projectId, receivedAt: now, availableUntil: "2026-10-02T12:00:00.000Z", accessStatus: "ACCESS_PENDING" },
    receipt: { id: projectId, approvalId: projectId, target: "ATLAS-248", fixtureRevision: 1, recordedAt: now, result: "SIMULATED" },
    delayAssessment: null,
  };
  const approved = { ...pending, approvalState: "APPROVED" as const };
  const readReview = vi.fn().mockResolvedValue({ snapshot: pending, distribution: null });
  const recordDecision = vi.fn().mockResolvedValue(approved);
  const render = vi.mocked(renderAtlasManagementSnapshot);
  const actual = await vi.importActual<typeof import("../apps/api/dist/atlas-management-snapshot.js")>(
    "../apps/api/dist/atlas-management-snapshot.js");
  render.mockRejectedValueOnce(new Error("private generator detail"));
  render.mockResolvedValueOnce({ snapshot: approved, highlights: [], livePath: `/?project=${projectId}`, powerpointBase64: "fixture" });
  render.mockImplementationOnce(actual.renderAtlasManagementSnapshot);
  const controller = new ProjectUpdateController({
    ...unavailableProjectUpdateRepository, atlasReportApproval: readReview, decideAtlasReportApproval: recordDecision,
  }, { authenticate: vi.fn().mockResolvedValue(actor) } as never);
  const approve = { snapshotId, requestId, decision: "APPROVED" };

  await expect(controller.decideAtlasReportApproval(req, projectId, approve)).rejects.toMatchObject({ status: 503, response: "" });
  await expect(controller.decideAtlasReportApproval(req, projectId, approve)).rejects.toMatchObject({ status: 503, response: "" });
  expect(recordDecision).not.toHaveBeenCalled();
  expect(await controller.atlasReportApproval(req, projectId)).toMatchObject({ snapshot: pending });
  await expect(controller.decideAtlasReportApproval(req, projectId, approve)).resolves.toMatchObject({ snapshot: approved });
  expect(render).toHaveBeenNthCalledWith(3, approved);
  expect(recordDecision).toHaveBeenCalledExactlyOnceWith(actor, projectId, approve, req.correlationId);
});
