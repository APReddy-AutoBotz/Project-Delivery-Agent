// Acceptance-only adapter for genuinely populated pre-Stage-2 databases. It
// adapts additive column projections, INSERTs and the renamed unique lookup;
// all statements still execute against the unchanged released schema and its
// real runtime-role constraints. No migration, trigger or data is bypassed.
import assert from "node:assert/strict";
import { createDatabase } from "../../packages/data/dist/index.js";

const priorColumns = {
  projectFact: {
    table: "ProjectFact",
    columns: {
      id: "uuid",
      customerId: "uuid",
      projectId: "uuid",
      factType: "text",
      revision: "integer",
      createdAt: "timestamptz",
    },
  },
  factAssessment: {
    table: "FactAssessment",
    columns: {
      id: "uuid",
      customerId: "uuid",
      projectId: "uuid",
      factId: "uuid",
      factType: "text",
      factRevision: "integer",
      policyId: "uuid",
      policyThroughRevision: "integer",
      policyRevisionId: "uuid",
      asOf: "timestamptz",
      subject: "text",
      idempotencyKey: "text",
      requestHash: "text",
      evaluatorVersion: "integer",
      complete: "boolean",
      versionCount: "integer",
      conflictCount: "integer",
      conflictThroughRevision: "integer",
      result: "jsonb",
      sealed: "boolean",
    },
  },
};

function insertPriorRow(target, property, args) {
  const { table, columns } = priorColumns[property];
  assert(
    Object.keys(args).every((key) => ["data", "select", "omit"].includes(key)),
  );
  assert(
    Object.keys(args.data).every((column) => Object.hasOwn(columns, column)),
  );
  const supplied = Object.keys(args.data).filter(
    (column) => args.data[column] !== undefined,
  );
  const returned = args.select
    ? Object.keys(args.select).filter((column) => args.select[column])
    : Object.keys(columns);
  assert(returned.length > 0);
  assert(
    returned.every(
      (column) =>
        Object.hasOwn(columns, column) &&
        (!args.select || args.select[column] === true),
    ),
  );
  const values = supplied.map((column) =>
    column === "result" ? JSON.stringify(args.data[column]) : args.data[column],
  );
  const placeholders = supplied.map(
    (column, index) => "$" + (index + 1) + "::" + columns[column],
  );
  // All identifiers and casts come from the released-column allowlist above;
  // values remain bound parameters. Database defaults and triggers still run.
  return target
    .$queryRawUnsafe(
      `INSERT INTO "${table}" (${supplied.map((column) => '"' + column + '"').join(",")}) VALUES (${placeholders.join(",")}) RETURNING ${returned.map((column) => '"' + column + '"').join(",")}`,
      ...values,
    )
    .then((rows) => rows[0]);
}

export function createPriorReleaseDatabase(connection) {
  assert.equal(process.env.PDAA_ACCEPTANCE, "isolated");
  const adapt = (database) =>
    new Proxy(database, {
      get(target, property) {
        if (property === "$transaction")
          return (execute, options) =>
            target.$transaction((tx) => execute(adapt(tx)), options);
        if (["projectFact", "factAssessment"].includes(property)) {
          const delegate = target[property];
          return new Proxy(delegate, {
            get(model, operation) {
              if (typeof model[operation] !== "function")
                return model[operation];
              return (input = {}) => {
                // Do not silently adapt aggregate/count/nested operations that
                // these released-history fixtures have never exercised.
                assert(
                  [
                    "create",
                    "findUnique",
                    "findFirst",
                    "findMany",
                    "update",
                  ].includes(operation),
                );
                const args = globalThis.structuredClone(input);
                if (!args.select)
                  args.omit = {
                    ...args.omit,
                    ...(property === "projectFact"
                      ? { bindingBirthId: true }
                      : { captureKind: true, milestoneAssessmentId: true }),
                  };
                if (property === "factAssessment" && args.data) {
                  assert([undefined, "SCALAR"].includes(args.data.captureKind));
                  assert(args.data.milestoneAssessmentId == null);
                  delete args.data.captureKind;
                  delete args.data.milestoneAssessmentId;
                }
                const key =
                  args.where
                    ?.customerId_projectId_subject_captureKind_idempotencyKey;
                if (key) {
                  assert.equal(operation, "findUnique");
                  assert.equal(key.captureKind, "SCALAR");
                  const priorKey = { ...key };
                  delete priorKey.captureKind;
                  args.where = priorKey;
                  return model.findFirst(args);
                }
                if (operation === "create") {
                  // The current Prisma model has a new non-null default column;
                  // an ORM INSERT may materialize that default even when omitted.
                  // Insert only the explicit released columns in this fixture.
                  return insertPriorRow(target, property, args);
                }
                return model[operation](args);
              };
            },
          });
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return adapt(createDatabase(connection));
}
