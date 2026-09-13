// Acceptance-only adaptation of genuinely populated released prefixes. No
// migration, forward column, trigger, role or stored row is bypassed.
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
  milestoneConsistencyAssessment: {
    table: "MilestoneConsistencyAssessment",
    // Exact released-v5 scalar columns. In particular, reconciliationCheckId
    // is not projected or INSERTed, even as SQL NULL.
    columns: {
      id: "uuid",
      customerId: "uuid",
      projectId: "uuid",
      milestoneId: "uuid",
      canonicalReceiptId: "uuid",
      ruleRevision: "text",
      enabled: "boolean",
      asOf: "timestamptz",
      subject: "text",
      idempotencyKey: "text",
      requestHash: "text",
      status: "text",
      complete: "boolean",
      targetCount: "integer",
      requiredLinkCount: "integer",
      versionCount: "integer",
      evidenceCount: "integer",
      conflictCount: "integer",
      contributorCount: "integer",
      result: "jsonb",
      auditEventId: "uuid",
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
  const sql = `INSERT INTO "${table}" (${supplied
    .map((column) => `"${column}"`)
    .join(",")}) VALUES (${supplied
    .map((column, index) => `$${index + 1}::${columns[column]}`)
    .join(",")}) RETURNING ${returned
    .map((column) => `"${column}"`)
    .join(",")}`;
  return target.$queryRawUnsafe(sql, ...values).then((rows) => rows[0]);
}

export function createPriorReleaseDatabase(connection, prefixCount) {
  assert.equal(process.env.PDAA_ACCEPTANCE, "isolated");
  assert(
    [2, 3, 4, 5].includes(prefixCount),
    "A populated prior fixture must name its exact released migration prefix",
  );
  const preMilestone = prefixCount < 5;
  const adaptedModels = preMilestone
    ? ["projectFact", "factAssessment"]
    : ["milestoneConsistencyAssessment"];

  const adapt = (database) =>
    new Proxy(database, {
      get(target, property) {
        if (property === "$transaction") {
          return (execute, options) =>
            target.$transaction((tx) => execute(adapt(tx)), options);
        }
        if (adaptedModels.includes(property)) {
          const model = target[property];
          return new Proxy(model, {
            get(delegate, operation) {
              if (typeof delegate[operation] !== "function")
                return delegate[operation];
              return (input = {}) => {
                assert(
                  [
                    "create",
                    "findUnique",
                    "findFirst",
                    "findMany",
                    "update",
                  ].includes(operation),
                  `Unsupported prior fixture operation: ${String(property)}.${String(operation)}`,
                );
                const args = globalThis.structuredClone(input);
                if (!preMilestone) {
                  // The released fifth schema already has bindingBirthId and
                  // both scalar/MILESTONE assessment kinds and retry keys.
                  // Only this new nullable sixth-migration field is absent.
                  assert(
                    [undefined, false].includes(
                      args.select?.reconciliationCheckId,
                    ),
                    "A v5 fixture cannot select reconciliation ownership",
                  );
                  if (args.data) {
                    assert(
                      args.data.reconciliationCheckId == null,
                      "A v5 fixture cannot create or adopt reconciliation ownership",
                    );
                    delete args.data.reconciliationCheckId;
                  }
                  if (!args.select) {
                    args.omit = { ...args.omit, reconciliationCheckId: true };
                  }
                } else {
                  // Preserve the existing genuine-prefix2-4 adaptations.
                  if (!args.select) {
                    args.omit = {
                      ...args.omit,
                      ...(property === "projectFact"
                        ? { bindingBirthId: true }
                        : { captureKind: true, milestoneAssessmentId: true }),
                    };
                  }
                  if (property === "factAssessment" && args.data) {
                    assert(
                      [undefined, "SCALAR"].includes(args.data.captureKind),
                    );
                    assert(args.data.milestoneAssessmentId == null);
                    delete args.data.captureKind;
                    delete args.data.milestoneAssessmentId;
                  }
                  const retryKey =
                    args.where
                      ?.customerId_projectId_subject_captureKind_idempotencyKey;
                  if (property === "factAssessment" && retryKey) {
                    assert.equal(operation, "findUnique");
                    assert.equal(retryKey.captureKind, "SCALAR");
                    delete retryKey.captureKind;
                    args.where = retryKey;
                    return delegate.findFirst(args);
                  }
                }
                if (operation === "create") {
                  return insertPriorRow(target, property, args);
                }
                return delegate[operation](args);
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
