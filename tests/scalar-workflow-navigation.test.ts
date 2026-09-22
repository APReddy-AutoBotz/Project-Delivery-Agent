import { expect, it, vi } from "vitest";
import { openInstalledScalarProject } from "../scripts/acceptance/scalar-reconciliation-workflow.mjs";

const projectId = "10000000-0000-4000-8000-000000000001";
function fixture(returnedId = projectId, status = 200) {
  const events: string[] = [];
  const response = {
    url: () => "https://fixture/api/projects/" + projectId,
    request: () => ({ method: () => "GET" }),
    status: () => status,
    body: async () => Buffer.from(JSON.stringify({ id: returnedId })),
    headersArray: async () => [],
  };
  const heading = { selected: "exact project heading" };
  const click = vi.fn(async () => {
    events.push("click");
  });
  const filter = vi.fn(() => ({ click }));
  const page = {
    // This must never be invoked: a document reload drops the in-memory token.
    goto: vi.fn(() => {
      throw new Error("Unexpected session reload");
    }),
    waitForResponse: vi.fn((select: (response: any) => boolean) => {
      events.push("observe");
      expect(select(response)).toBe(true);
      expect(
        select({ ...response, request: () => ({ method: () => "POST" }) }),
      ).toBe(false);
      expect(
        select({
          ...response,
          url: () => "https://fixture/api/projects/another",
        }),
      ).toBe(false);
      return Promise.resolve(response);
    }),
    getByRole: vi.fn((role: string) =>
      role === "heading" ? heading : { filter },
    ),
  };
  const session = {
    page,
    disclosure: { add: vi.fn() },
    capture: { settle: vi.fn() },
  };
  return { session, events, filter, heading, click };
}
it("NFR-SEC-001: packaged scalar navigation observes the exact card GET without reloading its memory-only session", async () => {
  const f = fixture();
  await openInstalledScalarProject(
    f.session,
    projectId,
    "Exact fixture project",
  );
  expect(f.events).toEqual(["observe", "click"]);
  expect(f.session.page.goto).not.toHaveBeenCalled();
  expect(f.session.page.getByRole).toHaveBeenCalledWith("heading", {
    name: "Exact fixture project",
    exact: true,
  });
  expect(f.filter).toHaveBeenCalledWith({ has: f.heading });
  expect(f.click).toHaveBeenCalledOnce();
  expect(f.session.capture.settle).toHaveBeenCalledWith(f.session.page);
});
it("rejects a mismatched project response rather than opening another project", async () => {
  const f = fixture("20000000-0000-4000-8000-000000000002");
  await expect(
    openInstalledScalarProject(f.session, projectId, "Fixture"),
  ).rejects.toThrow();
  expect(f.session.capture.settle).not.toHaveBeenCalled();
});
it("does not treat a denied project navigation as ready", async () => {
  const f = fixture(projectId, 401);
  await expect(
    openInstalledScalarProject(f.session, projectId, "Fixture"),
  ).rejects.toThrow();
  expect(f.session.capture.settle).not.toHaveBeenCalled();
});
