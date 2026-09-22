// FR-EVD-004/007/009/012, NFR-REL-001/002: fresh graph seal integrity.
// Acceptance-only delegate interception changes initial fixture data, never runtime code.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "./common.mjs";
import {
  createDatabase,
  DatabaseScalarReconciliationRepository,
} from "../../packages/data/dist/index.js";
import { PrismaClient } from "../../packages/data/dist/generated/prisma/client.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import { watchCommits } from "./reconciliation-commit-probes.mjs";
import { runWithCleanup, drainAndClose } from "./fixture-cleanup.mjs";
import { assertScalarSealReceipt } from "./scalar-seal-receipt.mjs";
const { PrismaPg } = createRequire(
  new URL("../../packages/data/package.json", import.meta.url),
)("@prisma/adapter-pg");
const tables = [
  "ScalarReconciliationRequest",
  "ScalarReconciliationCheck",
  "ScalarReconciliationAssignment",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
  "FactAuthorityConflict",
  "AuditEvent",
  "ProjectFact",
  "ProjectFactVersion",
  "FactEvidence",
];
const modes = [
  "positive-full-seal",
  "coherent-wrong-identity",
  "missing-initial-assignment-seal",
  "missing-version-dependency",
  "coherent-missing-version",
  "coherent-missing-evidence",
];
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (text) => createHash("sha256").update(text).digest("hex");

export async function verifyScalarSeals(
  owner,
  connection,
  customerId,
  referenceProjectId,
) {
  reconciliationAcceptanceGuard();
  assert.equal(connection.user, "pdaa_api");
  const setup = createDatabase(connection);
  const config = {
    ...connection,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 10000,
  };
  const writerPool = new Pool(config),
    observerPool = new Pool(config);
  let observer, db, active;
  watchCommits(
    writerPool,
    () => active,
    () => observer,
  );
  // Observe original transport promises, preserving SQL, parameters and failures.
  writerPool.on("connect", (client) => {
    const query = client.query;
    client.query = function (...args) {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
      const c = active;
      if (!c) return query.apply(this, args);
      if (/\bSET\s+CONSTRAINTS\b/i.test(sql ?? "")) c.forcedConstraints += 1;
      const match =
        /^\s*UPDATE\s+(?:"public"\.)?"(FactAssessment|ScalarReconciliationRequest)"\s+SET\s+"sealed"\s*=/i.exec(
          sql ?? "",
        );
      const rollback = /^\s*ROLLBACK\s*;?\s*$/i.test(sql ?? "");
      const entry = match
        ? {
            table: match[1],
            pid: client.processID,
            sql,
            values: clone(
              typeof args[0] === "string" ? args[1] : args[0].values,
            ),
          }
        : null;
      if (entry) c.sealStatements.push(entry);
      const result = query.apply(this, args);
      if (!entry && !rollback) return result;
      assert(
        result && typeof result.then === "function",
        "Unsupported seal transport",
      );
      return result.then(
        (value) => {
          if (entry) entry.command = value.command;
          if (rollback) c.rollbackCommand = value.command;
          return value;
        },
        (error) => {
          const failure = {
            code: error.code,
            message: error.message,
            ...(error.constraint ? { constraint: error.constraint } : {}),
          };
          if (entry) entry.error = failure;
          if (rollback) c.rollbackError = failure;
          throw error;
        },
      );
    };
  });
  return runWithCleanup(
    async () => {
      observer = await observerPool.connect();
      db = new PrismaClient({
        adapter: new PrismaPg(writerPool, { disposeExternalPool: false }),
      });
      async function snapshot(f, tx) {
        const result = {};
        for (const table of tables) {
          const predicate =
            table === "AuditEvent"
              ? "detail->>'projectId'=$2"
              : '"projectId"=$2::uuid';
          const sql = `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${predicate} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 5001`;
          const rows = tx
            ? await tx.$queryRawUnsafe(sql, customerId, f.projectId)
            : (await observer.query(sql, [customerId, f.projectId])).rows;
          assert(rows.length <= 5000, "Scalar seal snapshot overflow");
          result[table] = rows.map((row) => row.row);
        }
        return result;
      }
      const receipt = { family: "scalar-seals/v1", customerId, cases: [] };
      for (const name of modes) {
        const f = await reserveScalarFixture(
          owner,
          setup,
          customerId,
          referenceProjectId,
          "scalar-seal-" + name,
        );
        const c = {
          name,
          customerId,
          projectId: f.projectId,
          factId: f.factId,
          actor: f.actor.subject,
          correlationId: randomUUID(),
          command: { ...f.command, idempotencyKey: randomUUID() },
          nativeCommitAttempts: 0,
          callbackReturned: false,
          forcedConstraints: 0,
          sealStatements: [],
          proposals: [],
        };
        c.before = await snapshot(f);
        let transactionFailure;
        // The unchanged repository supplies authorization/lock ordering, the single
        // server clock and its unchanged ReadCommitted/5000/10000 transaction options.
        const adapter = new Proxy(db, {
          get(target, key) {
            if (key !== "$transaction") {
              const member = Reflect.get(target, key);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            }
            return async (body, options) => {
              assert.deepEqual(options, {
                isolationLevel: "ReadCommitted",
                maxWait: 5000,
                timeout: 10000,
              });
              c.options = clone(options);
              try {
                return await db.$transaction(async (tx) => {
                  Object.assign(
                    c,
                    (
                      await tx.$queryRaw`SELECT current_user AS role,session_user AS "sessionUser",pg_backend_pid()::int AS pid`
                    )[0],
                  );
                  assert.equal(c.role, "pdaa_api");
                  assert.equal(c.sessionUser, "pdaa_api");
                  const wrapped = new Proxy(tx, {
                    get(base, model) {
                      const delegate = Reflect.get(base, model);
                      if (
                        ![
                          "factAssessment",
                          "factAssessmentVersion",
                          "scalarReconciliationRequest",
                          "scalarReconciliationAssignment",
                          "scalarReconciliationCheck",
                          "auditEvent",
                          "factAssessmentConflict",
                          "factAuthorityConflict",
                        ].includes(model)
                      )
                        return typeof delegate === "function"
                          ? delegate.bind(base)
                          : delegate;
                      return new Proxy(delegate, {
                        get(entity, operation) {
                          const method = Reflect.get(entity, operation);
                          if (
                            !["create", "createMany", "update"].includes(
                              operation,
                            )
                          )
                            return typeof method === "function"
                              ? method.bind(entity)
                              : method;
                          return async (input) => {
                            // Clone only JSON fields being changed; Date values in real
                            // Prisma create arguments retain their native representation.
                            let args = {
                              ...input,
                              data: Array.isArray(input.data)
                                ? input.data.map((row) => ({ ...row }))
                                : { ...input.data },
                            };
                            if (
                              model === "factAssessment" &&
                              operation === "create"
                            ) {
                              c.originalHeader = clone(args.data);
                              c.assessmentId = args.data.id;
                              if (name === "coherent-missing-version") {
                                args.data.result = clone(args.data.result);
                                c.omittedVersionId =
                                  args.data.result.versions[0].id;
                                args.data.result.versions =
                                  args.data.result.versions.slice(1);
                                args.data.versionCount -= 1;
                              }
                              if (name === "coherent-missing-evidence") {
                                args.data.result = clone(args.data.result);
                                const version = args.data.result.versions.find(
                                  (row) => row.evidenceIds.length > 0,
                                );
                                assert(version);
                                c.omittedVersionId = version.id;
                                c.omittedEvidenceIds = [...version.evidenceIds];
                                version.evidenceIds = [];
                                for (const group of args.data.result
                                  .conflicts) {
                                  group.evidenceIds = [
                                    ...new Set(
                                      group.versionIds.flatMap(
                                        (id) =>
                                          args.data.result.versions.find(
                                            (row) => row.id === id,
                                          ).evidenceIds,
                                      ),
                                    ),
                                  ].sort();
                                }
                              }
                            }
                            if (
                              model === "factAssessmentVersion" &&
                              operation === "createMany"
                            ) {
                              c.originalDependencies = clone(args.data);
                              if (
                                [
                                  "missing-version-dependency",
                                  "coherent-missing-version",
                                ].includes(name)
                              ) {
                                c.omittedVersionId ??= args.data[0].versionId;
                                args.data = args.data.filter(
                                  (row) => row.versionId !== c.omittedVersionId,
                                );
                              }
                            }
                            if (
                              model === "scalarReconciliationRequest" &&
                              operation === "create"
                            ) {
                              c.originalRequest = clone(args.data);
                              c.requestId = args.data.id;
                              if (name === "coherent-wrong-identity") {
                                const identity = JSON.parse(
                                  args.data.contributorIdentity,
                                );
                                c.changedSourceId = randomUUID();
                                identity[5][0][1] = c.changedSourceId;
                                args.data.contributorIdentity =
                                  JSON.stringify(identity);
                                args.data.contributorHash = digest(
                                  args.data.contributorIdentity,
                                );
                              }
                            }
                            if (
                              operation === "create" ||
                              operation === "createMany"
                            )
                              c.proposals.push({
                                model,
                                operation,
                                data: clone(args.data),
                              });
                            if (
                              model === "scalarReconciliationAssignment" &&
                              operation === "create" &&
                              name === "missing-initial-assignment-seal"
                            ) {
                              c.omittedAssignment = clone(args.data);
                              return args.data;
                            }
                            if (
                              operation === "update" &&
                              [
                                "factAssessment",
                                "scalarReconciliationRequest",
                              ].includes(model)
                            ) {
                              assert.deepEqual(args.data, { sealed: true });
                              c.preSeals ??= [];
                              c.preSeals.push({
                                table:
                                  model === "factAssessment"
                                    ? "FactAssessment"
                                    : "ScalarReconciliationRequest",
                                id: args.where.id,
                                state: await snapshot(f, tx),
                              });
                            }
                            return method.call(entity, args);
                          };
                        },
                      });
                    },
                  });
                  const result = await body(wrapped);
                  // Never COMMIT an unexpectedly accepted corruption control.
                  if (name !== "positive-full-seal")
                    throw new Error(
                      "Expected scalar seal rejection did not occur",
                    );
                  c.pending = await snapshot(f, tx);
                  c.callbackReturned = true;
                  return result;
                }, options);
              } catch (error) {
                transactionFailure = error;
                throw error;
              }
            };
          },
        });
        active = c;
        let failure;
        try {
          const result = await new DatabaseScalarReconciliationRepository(
            adapter,
          ).check(f.actor, c.command, { correlationId: c.correlationId });
          c.returnedOutcome = result.outcome;
        } catch (error) {
          failure = error;
        } finally {
          active = null;
        }
        c.rejected = failure !== undefined;
        c.transactionRejected = transactionFailure !== undefined;
        c.after = await snapshot(f);
        c.auditAfter = (
          await observer.query(
            'SELECT to_jsonb(t) AS row FROM "AuditEvent" t WHERE "customerId"=$1::uuid AND "correlationId"=$2 ORDER BY id',
            [customerId, c.correlationId],
          )
        ).rows.map((row) => row.row);
        const oldIds = new Set(
          tables.flatMap((table) =>
            c.before[table].map((row) => row.id).filter(Boolean),
          ),
        );
        const ids = new Set();
        for (const proposal of c.proposals)
          for (const row of Array.isArray(proposal.data)
            ? proposal.data
            : [proposal.data])
            for (const key of [
              "id",
              "assessmentId",
              "scalarReconciliationCheckId",
              "auditEventId",
            ])
              if (row[key] && !oldIds.has(row[key])) ids.add(row[key]);
        c.generatedIds = [...ids].sort();
        c.generatedAbsence = {};
        if (name !== "positive-full-seal")
          for (const table of tables)
            c.generatedAbsence[table] = (
              await observer.query(
                `SELECT count(*)::int AS n FROM "${table}" t WHERE "customerId"=$1::uuid AND (to_jsonb(t)->>'id'=ANY($2::text[]) OR to_jsonb(t)->>'assessmentId'=ANY($2::text[]) OR to_jsonb(t)->>'scalarReconciliationCheckId'=ANY($2::text[]))`,
                [customerId, c.generatedIds],
              )
            ).rows[0].n;
        receipt.cases.push(c);
      }
      assertScalarSealReceipt(receipt, customerId);
      return receipt;
    },
    () =>
      drainAndClose(
        [],
        [
          () => {
            observer?.release();
          },
          () => db?.$disconnect(),
          () => setup.$disconnect(),
          () => writerPool.end(),
          () => observerPool.end(),
        ],
      ),
  );
}
