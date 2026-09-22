// FR-EVD-004/009, NFR-REL-001: bounded access projections keep full native checks.
import { expect, it, vi } from "vitest";
import {
  DatabaseAuthorityRepository,
  DatabaseMilestoneConsistencyRepository,
} from "../packages/data/dist/index.js";
const actor = {
  customerId: "customer",
  subject: "pm",
  roles: ["project_manager"],
};
const dependency = { version: { sourceId: "source" } };
const versions = { select: { version: { select: { sourceId: true } } } };

it.each(["scalar", "milestone"])(
  "%s delivery fetches only source dependencies and still rechecks native integrity/access",
  async (kind) => {
    const result = { retained: "complete frozen proof" };
    const row = {
      id: "proof",
      factId: "fact",
      projectId: "project",
      milestoneId: "milestone",
      asOf: new Date("2026-09-22T00:00:00Z"),
      result,
      versions: [dependency],
      scalarAssessments: [{ versions: [dependency] }],
    };
    const findFirst = vi.fn(async () => row);
    const findMany = vi.fn(async () => [
      {
        sourceId: "source",
        state: "AVAILABLE",
        readers: [{ subject: actor.subject }],
      },
    ]);
    const integrity = vi.fn(async () => [{ valid: true }]);
    const tx = {
      factAssessment: { findFirst },
      milestoneConsistencyAssessment: { findFirst },
      factSourceAccess: { findMany },
      $queryRaw: integrity,
    };
    const deliver = () =>
      kind === "scalar"
        ? new DatabaseAuthorityRepository(
            {} as never,
          ).deliverAssessmentInTransaction(
            tx as never,
            actor as never,
            "project",
            "proof",
            false,
          )
        : new DatabaseMilestoneConsistencyRepository(
            {} as never,
          ).deliverInTransaction(
            tx as never,
            actor as never,
            { projectId: "project", assessmentId: "proof" },
            false,
          );
    expect((await deliver())?.result).toEqual(result);
    expect(findFirst.mock.calls[0]![0]).toEqual({
      where: {
        id: "proof",
        customerId: "customer",
        projectId: "project",
        sealed: true,
      },
      include:
        kind === "scalar"
          ? { versions }
          : { scalarAssessments: { select: { versions } } },
    });
    expect(integrity).toHaveBeenCalledOnce();
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        customerId: "customer",
        projectId: "project",
        sourceId: { in: ["source"] },
      },
      include: { readers: { where: { subject: "pm" } } },
    });
    findMany.mockResolvedValueOnce([]);
    expect(await deliver()).toMatchObject({
      visibility: "restricted",
      revalidationRequired: true,
      result: null,
    });
    integrity.mockResolvedValueOnce([{ valid: false }]);
    findMany.mockClear();
    await expect(deliver()).rejects.toThrow(/integrity failed/);
    expect(findMany).not.toHaveBeenCalled();
  },
);
