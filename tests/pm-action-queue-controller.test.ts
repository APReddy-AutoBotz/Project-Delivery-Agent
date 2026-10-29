import { expect, it, vi } from "vitest";
import { PmActionQueueError } from "../packages/domain/dist/index.js";
import { PmActionQueueController } from "../apps/api/src/pm-action-queue-controller.js";

const actor = { customerId: "10000000-0000-4000-8000-000000000001", subject: "synthetic-pm", roles: ["project_manager"] };
const request = { headers: { authorization: "Bearer token" } };
function fixture() {
  const identity = { authenticate: vi.fn(async () => actor) }, repository = { read: vi.fn(async () => ({ marker: "synthetic" })) };
  return { identity, repository, controller: new PmActionQueueController(repository as never, identity as never) };
}
it("authenticates the server actor and supplies no caller project list", async () => {
  const f = fixture(); await expect(f.controller.read(request, {})).resolves.toEqual({ marker: "synthetic" });
  expect(f.identity.authenticate).toHaveBeenCalledWith("token"); expect(f.repository.read).toHaveBeenCalledWith(actor);
});
it("rejects missing identity and unknown query input before repository reads", async () => {
  const f = fixture(); await expect(f.controller.read({ headers: {} }, {})).rejects.toMatchObject({ status: 401 });
  await expect(f.controller.read({ headers: { authorization: "Bearer " + "x".repeat(16384) } }, {})).rejects.toMatchObject({ status: 401 });
  await expect(f.controller.read({ headers: { authorization: ["Bearer token"] as never } }, {})).rejects.toMatchObject({ status: 401 });
  await expect(f.controller.read(request, { projectId: "other" })).rejects.toMatchObject({ status: 400 });
  expect(f.repository.read).not.toHaveBeenCalled();
});
it("maps denied and unavailable queue errors to private HTTP statuses", async () => {
  const f = fixture(); f.repository.read.mockRejectedValueOnce(new PmActionQueueError("DENIED"));
  await expect(f.controller.read(request, {})).rejects.toMatchObject({ status: 404 });
  f.repository.read.mockRejectedValueOnce(new PmActionQueueError("UNAVAILABLE"));
  await expect(f.controller.read(request, {})).rejects.toMatchObject({ status: 503 });
});
