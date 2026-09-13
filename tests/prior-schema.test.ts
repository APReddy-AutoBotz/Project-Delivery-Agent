import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  const delegate = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  });
  return {
    projectFact: delegate(),
    factAssessment: delegate(),
    milestoneConsistencyAssessment: delegate(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };
});
vi.mock("../packages/data/dist/index.js", () => ({
  createDatabase: () => mock,
}));
import { createPriorReleaseDatabase } from "../scripts/acceptance/prior-schema.mjs";

// FR-EVD-001/004/012: upgrade evidence uses the released schema's real defaults
// and constraints, never a fixture-only schema or disabled integrity boundary.
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PDAA_ACCEPTANCE", "isolated");
  mock.$queryRawUnsafe.mockResolvedValue([{ id: "retained-row" }]);
  mock.$transaction.mockImplementation((execute) => execute(mock));
});
afterEach(() => vi.unstubAllEnvs());

it("requires the isolated acceptance environment", () => {
  vi.stubEnv("PDAA_ACCEPTANCE", "production");
  expect(() => createPriorReleaseDatabase("unused")).toThrow();
});
it("requires an explicit genuine supported prefix", () => {
  for (const prefix of [undefined, 0, 1, 7, "5"])
    expect(() => createPriorReleaseDatabase("unused", prefix)).toThrow();
});
it("preserves released v5 scalar ownership and binding fields without selecting v7 ownership", async () => {
  const database = createPriorReleaseDatabase("unused", 5);
  const data = { captureKind: "MILESTONE", milestoneAssessmentId: "parent" };
  await database.factAssessment.create({ data });
  expect(mock.$queryRawUnsafe.mock.calls[0]![0]).toContain(
    '"captureKind","milestoneAssessmentId"',
  );
  expect(mock.$queryRawUnsafe.mock.calls[0]![0]).not.toContain(
    "scalarReconciliationCheckId",
  );
  expect(mock.factAssessment.create).not.toHaveBeenCalled();
  await database.projectFact.create({ data: { bindingBirthId: "binding" } });
  expect(mock.projectFact.create).toHaveBeenCalledWith({
    data: { bindingBirthId: "binding" },
  });
  expect(mock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
});
it("omits only v6 ownership from v5 milestone reads and update return projections", async () => {
  const database = createPriorReleaseDatabase("unused", 5);
  const input = { where: { id: "proof" }, include: { targets: true } };
  await database.milestoneConsistencyAssessment.findUnique(input);
  expect(mock.milestoneConsistencyAssessment.findUnique).toHaveBeenCalledWith({
    ...input,
    omit: { reconciliationCheckId: true },
  });
  await database.$transaction((tx) =>
    tx.milestoneConsistencyAssessment.update({
      where: { id: "proof" },
      data: { sealed: true },
    }),
  );
  expect(mock.milestoneConsistencyAssessment.update).toHaveBeenCalledWith({
    where: { id: "proof" },
    data: { sealed: true },
    omit: { reconciliationCheckId: true },
  });
  expect(input).not.toHaveProperty("omit");
});
it("inserts v5 milestone proof through released columns without an ownership column", async () => {
  const database = createPriorReleaseDatabase("unused", 5);
  await database.milestoneConsistencyAssessment.create({
    data: {
      id: "proof",
      reconciliationCheckId: null,
      result: { status: "DISABLED" },
    },
    select: { id: true },
  });
  expect(mock.$queryRawUnsafe).toHaveBeenCalledWith(
    'INSERT INTO "MilestoneConsistencyAssessment" ("id","result") VALUES ($1::uuid,$2::jsonb) RETURNING "id"',
    "proof",
    '{"status":"DISABLED"}',
  );
  expect(mock.milestoneConsistencyAssessment.create).not.toHaveBeenCalled();
});
it("cannot create, adopt or select v6 reconciliation ownership through the v5 adapter", () => {
  const database = createPriorReleaseDatabase("unused", 5);
  for (const operation of ["create", "update"])
    expect(() =>
      database.milestoneConsistencyAssessment[operation]({
        data: { reconciliationCheckId: "forged" },
      }),
    ).toThrow();
  expect(() =>
    database.milestoneConsistencyAssessment.findUnique({
      select: { reconciliationCheckId: true },
    }),
  ).toThrow();
  expect(mock.$queryRawUnsafe).not.toHaveBeenCalled();
  expect(mock.milestoneConsistencyAssessment.update).not.toHaveBeenCalled();
});

it("inserts only released ProjectFact columns with bound values and database defaults", async () => {
  const database = createPriorReleaseDatabase("unused", 4);
  const data = {
    id: "fact",
    customerId: "customer",
    projectId: "project",
    factType: "statement'); DROP TABLE x; --",
  };
  await database.projectFact.create({ data });
  const [sql, ...values] = mock.$queryRawUnsafe.mock.calls[0]!;
  expect(sql).toContain(
    'INSERT INTO "ProjectFact" ("id","customerId","projectId","factType")',
  );
  expect(sql).toContain("$1::uuid,$2::uuid,$3::uuid,$4::text");
  expect(sql).not.toContain("bindingBirthId");
  expect(sql).not.toContain(data.factType);
  expect(values).toEqual(Object.values(data));
  expect(mock.projectFact.create).not.toHaveBeenCalled();
});

it("removes additive scalar defaults from the prior-schema INSERT and respects select", async () => {
  const database = createPriorReleaseDatabase("unused", 4);
  await database.factAssessment.create({
    data: {
      id: "assessment",
      captureKind: "SCALAR",
      milestoneAssessmentId: null,
      result: { status: "UNKNOWN" },
    },
    select: { id: true },
  });
  expect(mock.$queryRawUnsafe).toHaveBeenCalledWith(
    'INSERT INTO "FactAssessment" ("id","result") VALUES ($1::uuid,$2::jsonb) RETURNING "id"',
    "assessment",
    '{"status":"UNKNOWN"}',
  );
  expect(mock.factAssessment.create).not.toHaveBeenCalled();
});

it("adapts released projections without mutating the caller's request", async () => {
  const database = createPriorReleaseDatabase("unused", 4);
  const input = { where: { id: "fact" } };
  await database.projectFact.findUnique(input);
  expect(mock.projectFact.findUnique).toHaveBeenCalledWith({
    ...input,
    omit: { bindingBirthId: true },
  });
  expect(input).toEqual({ where: { id: "fact" } });
});

it("maps scalar idempotency to the exact released identity, including inside transactions", async () => {
  const database = createPriorReleaseDatabase("unused", 4);
  const key = {
    customerId: "customer",
    projectId: "project",
    subject: "pm",
    captureKind: "SCALAR",
    idempotencyKey: "request",
  };
  await database.$transaction((tx) =>
    tx.factAssessment.findUnique({
      where: { customerId_projectId_subject_captureKind_idempotencyKey: key },
    }),
  );
  expect(mock.factAssessment.findFirst).toHaveBeenCalledWith({
    where: {
      customerId: "customer",
      projectId: "project",
      subject: "pm",
      idempotencyKey: "request",
    },
    omit: {
      scalarReconciliationCheckId: true,
      captureKind: true,
      milestoneAssessmentId: true,
    },
  });
});

it.each([2, 3, 4, 5, 6])(
  "excludes new scalar ownership from prefix %s reads and refuses adoption",
  async (prefix) => {
    const database = createPriorReleaseDatabase("unused", prefix);
    await database.factAssessment.findMany({ include: { versions: true } });
    expect(
      mock.factAssessment.findMany.mock.calls[0]![0].omit
        .scalarReconciliationCheckId,
    ).toBe(true);
    for (const operation of ["create", "update"])
      expect(() =>
        database.factAssessment[operation]({
          data: { scalarReconciliationCheckId: "forged" },
        }),
      ).toThrow();
    expect(() =>
      database.factAssessment.findFirst({
        select: { scalarReconciliationCheckId: true },
      }),
    ).toThrow();
    expect(() =>
      database.factAssessment.findFirst({
        omit: { scalarReconciliationCheckId: false },
      }),
    ).toThrow();
  },
);

it.each([5, 6])(
  "adapts nested scalar projections in prefix %s without mutating caller input",
  async (prefix) => {
    const database = createPriorReleaseDatabase("unused", prefix);
    const input = {
      include: { scalarAssessments: { include: { versions: true } } },
    };
    await database.milestoneConsistencyAssessment.findFirst(input);
    expect(
      mock.milestoneConsistencyAssessment.findFirst.mock.calls[0]![0].include
        .scalarAssessments,
    ).toEqual({
      include: { versions: true },
      omit: { scalarReconciliationCheckId: true },
    });
    expect(input).toEqual({
      include: { scalarAssessments: { include: { versions: true } } },
    });
    await database.milestoneConsistencyAssessment.findMany({
      select: { id: true, scalarAssessments: true },
    });
    expect(
      mock.milestoneConsistencyAssessment.findMany.mock.calls[0]![0].select
        .scalarAssessments,
    ).toEqual({ omit: { scalarReconciliationCheckId: true } });
    expect(() =>
      database.milestoneConsistencyAssessment.findFirst({
        include: {
          scalarAssessments: { select: { scalarReconciliationCheckId: true } },
        },
      }),
    ).toThrow();
  },
);

it("preserves genuine v6 milestone request ownership and v5/v6 kind-partitioned retry identity", async () => {
  const database = createPriorReleaseDatabase("unused", 6);
  await database.milestoneConsistencyAssessment.create({
    data: { id: "proof", reconciliationCheckId: "check" },
    select: { id: true },
  });
  expect(mock.$queryRawUnsafe).toHaveBeenCalledWith(
    'INSERT INTO "MilestoneConsistencyAssessment" ("id","reconciliationCheckId") VALUES ($1::uuid,$2::uuid) RETURNING "id"',
    "proof",
    "check",
  );
  for (const prefix of [5, 6]) {
    const key = {
      customerId_projectId_subject_captureKind_idempotencyKey: {
        captureKind: "MILESTONE",
        idempotencyKey: "key",
      },
    };
    await createPriorReleaseDatabase(
      "unused",
      prefix,
    ).factAssessment.findUnique({ where: key });
    expect(mock.factAssessment.findUnique).toHaveBeenLastCalledWith({
      where: key,
      omit: { scalarReconciliationCheckId: true },
    });
  }
});

it("rejects milestone child inserts and unsupported fixture operations", () => {
  const database = createPriorReleaseDatabase("unused", 4);
  expect(() =>
    database.factAssessment.create({
      data: { captureKind: "MILESTONE", milestoneAssessmentId: "parent" },
    }),
  ).toThrow();
  expect(() =>
    database.projectFact.create({ data: { bindingBirthId: "binding" } }),
  ).toThrow();
  expect(() => database.projectFact.count()).toThrow();
  expect(mock.$queryRawUnsafe).not.toHaveBeenCalled();
  expect(mock.projectFact.count).not.toHaveBeenCalled();
});
