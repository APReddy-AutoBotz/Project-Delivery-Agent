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

it("inserts only released ProjectFact columns with bound values and database defaults", async () => {
  const database = createPriorReleaseDatabase("unused");
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
  const database = createPriorReleaseDatabase("unused");
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
  const database = createPriorReleaseDatabase("unused");
  const input = { where: { id: "fact" } };
  await database.projectFact.findUnique(input);
  expect(mock.projectFact.findUnique).toHaveBeenCalledWith({
    ...input,
    omit: { bindingBirthId: true },
  });
  expect(input).toEqual({ where: { id: "fact" } });
});

it("maps scalar idempotency to the exact released identity, including inside transactions", async () => {
  const database = createPriorReleaseDatabase("unused");
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
    omit: { captureKind: true, milestoneAssessmentId: true },
  });
});

it("rejects milestone child inserts and unsupported fixture operations", () => {
  const database = createPriorReleaseDatabase("unused");
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
