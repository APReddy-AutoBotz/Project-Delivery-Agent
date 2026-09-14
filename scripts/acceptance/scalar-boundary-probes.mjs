// FR-EVD-009/012, NFR-SEC-001/REL-001: scoped ownership and immediate SQL boundaries.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "./common.mjs";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseScalarReconciliationRepository,
} from "../../packages/data/dist/index.js";
import { authorizeReconciliation } from "../../packages/data/dist/reconciliation-authorization.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import { watchCommits } from "./reconciliation-commit-probes.mjs";
import {
  runWithCleanup,
  drainAndClose,
  rollbackProbe,
} from "./fixture-cleanup.mjs";
import { assertScalarBoundaryReceipt } from "./scalar-boundary-receipt.mjs";
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
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function verifyScalarBoundaries(
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
  let writer, observer, active;
  watchCommits(
    writerPool,
    () => active,
    () => observer,
  );
  return runWithCleanup(
    async () => {
      observer = await observerPool.connect();
      writer = await writerPool.connect();
      const f = await reserveScalarFixture(
        owner,
        setup,
        customerId,
        referenceProjectId,
        "scalar-boundary-positive",
      );
      const b = await reserveScalarFixture(
        owner,
        setup,
        customerId,
        referenceProjectId,
        "scalar-boundary-borrowed",
        { optedIn: false },
      );
      const foreign = await reserveScalarFixture(
        owner,
        setup,
        customerId,
        referenceProjectId,
        "scalar-boundary-foreign",
        { optedIn: false },
      );
      const repository = new DatabaseScalarReconciliationRepository(setup),
        authority = new DatabaseAuthorityRepository(setup);
      const original = await repository.check(f.actor, f.command, {
        correlationId: randomUUID(),
      });
      await repository.refreshAssignment(
        f.actor,
        {
          projectId: f.projectId,
          requestId: original.request.id,
          expectedAssignmentRevision: 1,
          idempotencyKey: randomUUID(),
        },
        { correlationId: randomUUID() },
      );
      const standalone = [];
      for (const target of [b, foreign]) {
        const proof = await setup.$transaction(
          async (tx) => {
            assert.equal(
              (await tx.$queryRaw`SELECT current_user AS role`)[0].role,
              "pdaa_api",
            );
            await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
            await authorizeReconciliation(tx, b.actor, b.projectId, "manage");
            const [fact] =
              await tx.$queryRaw`SELECT id,"factType",revision FROM "ProjectFact" WHERE id=${b.factId}::uuid AND "customerId"=${customerId}::uuid AND "projectId"=${b.projectId}::uuid FOR UPDATE`;
            const asOf = (
              await tx.$queryRaw`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`
            )[0].now;
            const prepared = await authority.prepareAssessmentInTransaction(
              tx,
              b.actor,
              { projectId: b.projectId, fact, asOf },
            );
            assert.equal(prepared.result.reconciliationRequired, false);
            return authority.persistPreparedAssessmentInTransaction(
              tx,
              b.actor,
              {
                prepared,
                subject: b.actor.subject,
                idempotencyKey: randomUUID(),
                requestHash: hash({
                  projectId: target.projectId,
                  factId: target.factId,
                }),
                captureKind: "SCALAR",
                milestoneAssessmentId: null,
              },
            );
          },
          { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 },
        );
        standalone.push(proof.id);
      }
      const projectIds = [f.projectId, b.projectId, foreign.projectId].sort();
      async function snapshot(client) {
        const result = {};
        for (const table of tables) {
          const scope =
            table === "AuditEvent"
              ? "detail->>'projectId'=ANY($2::text[])"
              : '"projectId"=ANY($2::uuid[])';
          const rows = (
            await client.query(
              `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1 AND ${scope} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 5001`,
              [customerId, projectIds],
            )
          ).rows;
          assert(rows.length <= 5000);
          result[table] = rows.map((r) => r.row);
        }
        return result;
      }
      const before = await snapshot(observer);
      const request = before.ScalarReconciliationRequest.find(
        (r) => r.id === original.request.id,
      );
      const assignments = before.ScalarReconciliationAssignment.filter(
        (a) => a.requestId === request.id,
      ).sort((a, b) => a.revision - b.revision);
      assert.equal(assignments.length, 2);
      const initial = assignments[0],
        head = assignments[1];
      const proof = before.FactAssessment.find(
        (a) => a.id === request.originalAssessmentId,
      );
      const alternateGrant = (
        await observer.query(
          'SELECT id FROM "AccessGrant" WHERE "customerId"=$1 AND subject=$2 ORDER BY id',
          [customerId, f.actor.subject],
        )
      ).rows[0];
      const receipt = {
        family: "scalar-boundaries/v1",
        customerId,
        projectIds,
        requestId: request.id,
        proofId: proof.id,
        standalone,
        cases: [],
      };
      async function insert(table, row) {
        assert(tables.includes(table));
        return writer.query(
          `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}",$1::jsonb)`,
          [JSON.stringify(row)],
        );
      }
      const cases = [
        "borrowed-standalone",
        "cross-project-proof",
        "request-reseal",
        "late-version",
        "late-conflict",
        "request-born-sealed",
        "request-adopt-standalone",
        "check-cross-request",
        "assignment-late-initial",
        "assignment-stale-revision",
        "assignment-wrong-configuration",
        "assignment-wrong-grant",
        "assignment-wrong-routing",
        "assignment-wrong-predecessor",
        "assignment-year-range",
        "proof-wrong-kind",
        "request-wrong-digest",
      ];
      for (const operation of ["update", "delete", "truncate", "trigger"])
        for (const suffix of ["request", "check", "assignment"])
          cases.push("api-" + operation + "-" + suffix);
      cases.push("api-update-owner");
      for (const name of cases) {
        const deferred = [
          "borrowed-standalone",
          "cross-project-proof",
        ].includes(name);
        const r = {
          name,
          phase: deferred ? "commit" : "statement",
          correlationId: randomUUID(),
          nativeCommitAttempts: 0,
          callbackReturned: false,
          before: await snapshot(observer),
          prepared: null,
          attempt: null,
        };
        assert.deepEqual(r.before, before);
        await writer.query("BEGIN");
        let failure;
        try {
          await writer.query("SET LOCAL TIME ZONE 'UTC'");
          await writer.query("SET LOCAL statement_timeout='10s'");
          await writer.query("SET LOCAL lock_timeout='5s'");
          const session = (
            await writer.query(
              'SELECT current_user AS role,session_user AS "sessionUser",pg_backend_pid()::int AS pid',
            )
          ).rows[0];
          assert.equal(session.role, "pdaa_api");
          assert.equal(session.sessionUser, "pdaa_api");
          Object.assign(r, session);
          await writer.query(
            'SELECT id FROM "Project" WHERE "customerId"=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
            [customerId, projectIds],
          );
          assert.equal(
            (
              await writer.query(
                "SELECT public.valid_scalar_reconciliation_request($1::uuid) AS valid",
                [request.id],
              )
            ).rows[0].valid,
            true,
          );
          active = r;
          if (deferred) {
            const cross = name === "cross-project-proof",
              target = cross ? foreign : b;
            const borrowed = before.FactAssessment.find(
              (a) => a.id === standalone[cross ? 1 : 0],
            );
            const check = {
              id: randomUUID(),
              customerId,
              projectId: target.projectId,
              factId: target.factId,
              subject: borrowed.subject,
              idempotencyKey: randomUUID(),
              requestHash: borrowed.requestHash,
              assessmentId: borrowed.id,
              requestId: null,
              outcome: "NO_REQUEST",
              occurredAt: borrowed.asOf,
              auditEventId: randomUUID(),
            };
            const audit = {
              id: check.auditEventId,
              customerId,
              actor: check.subject,
              correlationId: r.correlationId,
              occurredAt: check.occurredAt,
              event: "scalar.reconciliation.checked",
              detail: {
                projectId: check.projectId,
                factId: check.factId,
                checkId: check.id,
                assessmentId: check.assessmentId,
                requestId: null,
                outcome: "NO_REQUEST",
              },
            };
            r.attempt = {
              table: "ScalarReconciliationCheck",
              row: check,
              borrowedProofId: borrowed.id,
            };
            r.prepared = audit;
            await insert("AuditEvent", audit);
            await insert("ScalarReconciliationCheck", check);
            r.pending = await snapshot(writer);
            r.callbackReturned = true;
            await writer.query("COMMIT");
          } else {
            let table, row;
            if (name.startsWith("assignment-")) {
              table = "ScalarReconciliationAssignment";
              row = {
                ...head,
                id: randomUUID(),
                auditEventId: randomUUID(),
                revision: 3,
                expectedRevision: 2,
                previousAssignmentId: head.id,
                idempotencyKey: randomUUID(),
                requestHash: hash({
                  projectId: f.projectId,
                  requestId: request.id,
                  expectedAssignmentRevision: 2,
                }),
                occurredAt: new Date().toISOString(),
              };
              if (name === "assignment-late-initial")
                Object.assign(row, {
                  kind: "INITIAL",
                  revision: 1,
                  expectedRevision: 0,
                  previousAssignmentId: null,
                  idempotencyKey: null,
                  requestHash: null,
                });
              if (name === "assignment-stale-revision")
                Object.assign(row, {
                  revision: 2,
                  expectedRevision: 1,
                  previousAssignmentId: initial.id,
                  requestHash: hash({
                    projectId: f.projectId,
                    requestId: request.id,
                    expectedAssignmentRevision: 1,
                  }),
                });
              if (name === "assignment-wrong-configuration")
                row.configurationReceiptId = null;
              if (name === "assignment-wrong-grant")
                row.grantId = alternateGrant.id;
              if (name === "assignment-wrong-routing") {
                row.reason = "PM_SCOPE_UNAVAILABLE";
                for (const field of [
                  "recipientSubject",
                  "responsibilityId",
                  "grantId",
                  "grantCustomerId",
                  "grantSubject",
                  "grantScopeType",
                  "grantScopeId",
                  "grantRole",
                ])
                  row[field] = null;
              }
              if (name === "assignment-wrong-predecessor")
                row.previousAssignmentId = initial.id;
              if (name === "assignment-year-range")
                row.occurredAt = "10000-01-01T00:00:00Z";
              const audit = {
                id: row.auditEventId,
                customerId,
                actor: row.actor,
                correlationId: r.correlationId,
                occurredAt: row.occurredAt,
                event: "scalar.reconciliation.assigned",
                detail: {
                  projectId: f.projectId,
                  factId: f.factId,
                  requestId: request.id,
                  assignmentId: row.id,
                  revision: row.revision,
                  reason: row.reason,
                },
              };
              r.prepared = audit;
              await insert("AuditEvent", audit);
            } else if (name === "late-version" || name === "late-conflict") {
              table =
                name === "late-version"
                  ? "FactAssessmentVersion"
                  : "FactAssessmentConflict";
              row = before[table].find((a) => a.assessmentId === proof.id);
            } else if (
              name.startsWith("request-") &&
              name !== "request-reseal"
            ) {
              table = "ScalarReconciliationRequest";
              row = {
                ...request,
                id: randomUUID(),
                auditEventId: randomUUID(),
                sealed: name === "request-born-sealed",
              };
              if (name === "request-adopt-standalone") {
                const borrowed = before.FactAssessment.find(
                  (a) => a.id === standalone[0],
                );
                Object.assign(row, {
                  projectId: borrowed.projectId,
                  factId: borrowed.factId,
                  originalAssessmentId: borrowed.id,
                  originCommandId: randomUUID(),
                });
              }
              if (name === "request-wrong-digest")
                row.contributorHash =
                  (request.contributorHash[0] === "0" ? "1" : "0") +
                  request.contributorHash.slice(1);
            } else if (name === "check-cross-request") {
              table = "ScalarReconciliationCheck";
              row = {
                ...before.ScalarReconciliationCheck.find(
                  (c) => c.id === request.originCommandId,
                ),
                id: randomUUID(),
                projectId: foreign.projectId,
                factId: foreign.factId,
                outcome: "REUSED",
                idempotencyKey: randomUUID(),
                auditEventId: randomUUID(),
              };
            } else if (name === "proof-wrong-kind") {
              table = "FactAssessment";
              row = {
                ...proof,
                id: randomUUID(),
                captureKind: "SCALAR",
                idempotencyKey: randomUUID(),
                sealed: false,
              };
            }
            if (row) {
              r.attempt = { table, row };
              await insert(table, row);
            } else {
              let sql,
                values = [];
              const byName = {
                request: "ScalarReconciliationRequest",
                check: "ScalarReconciliationCheck",
                assignment: "ScalarReconciliationAssignment",
                owner: "FactAssessment",
              };
              if (name === "request-reseal") {
                table = byName.request;
                sql =
                  'UPDATE "ScalarReconciliationRequest" SET sealed=true WHERE id=$1';
                values = [request.id];
              } else {
                const [, operation, suffix] = name.split("-");
                table = byName[suffix];
                assert(table);
                const id =
                  table === "FactAssessment"
                    ? proof.id
                    : before[table].find((a) => a.projectId === f.projectId).id;
                if (operation === "update") {
                  const column =
                    suffix === "owner" ? "scalarReconciliationCheckId" : "id";
                  sql = `UPDATE "${table}" SET "${column}"="${column}" WHERE id=$1`;
                  values = [id];
                }
                if (operation === "delete") {
                  sql = `DELETE FROM "${table}" WHERE id=$1`;
                  values = [id];
                }
                if (operation === "truncate") sql = `TRUNCATE "${table}"`;
                if (operation === "trigger")
                  sql = `ALTER TABLE "${table}" DISABLE TRIGGER USER`;
              }
              r.attempt = { table, sql, values };
              await writer.query(sql, values);
            }
            r.callbackReturned = true;
          }
        } catch (error) {
          failure = error;
          r.error = {
            code: error.code,
            message: error.message,
            constraint: error.constraint,
          };
        } finally {
          active = null;
          // All unexpected successes remain rollback-only, including trigger/DDL probes.
          r.rollbackCommand = (await rollbackProbe(writer, failure)).command;
        }
        assert(failure, name + ": invalid write unexpectedly succeeded");
        r.after = await snapshot(observer);
        const generated = new Set();
        for (const id of [
          r.attempt?.row?.id,
          r.attempt?.row?.auditEventId,
          r.prepared?.id,
        ]) {
          if (
            id &&
            !tables.some((table) => before[table].some((row) => row.id === id))
          )
            generated.add(id);
        }
        r.generatedIds = [...generated].sort();
        r.generatedAbsence = {};
        for (const table of tables) {
          r.generatedAbsence[table] = (
            await observer.query(
              `SELECT count(*)::int AS n FROM "${table}" t WHERE "customerId"=$1 AND
            (to_jsonb(t)->>'id'=ANY($2::text[]) OR to_jsonb(t)->>'assessmentId'=ANY($2::text[]) OR to_jsonb(t)->>'scalarReconciliationCheckId'=ANY($2::text[]))`,
              [customerId, r.generatedIds],
            )
          ).rows[0].n;
        }
        r.auditAfter = (
          await observer.query(
            'SELECT id FROM "AuditEvent" WHERE "customerId"=$1 AND "correlationId"=$2',
            [customerId, r.correlationId],
          )
        ).rows;
        receipt.cases.push(r);
      }
      assertScalarBoundaryReceipt(receipt, customerId);
      return receipt;
    },
    () =>
      drainAndClose(
        [],
        [
          () => setup.$disconnect(),
          async () => {
            writer?.release();
            await writerPool.end();
          },
          async () => {
            observer?.release();
            await observerPool.end();
          },
        ],
      ),
  );
}
