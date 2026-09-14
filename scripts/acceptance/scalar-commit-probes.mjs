// FR-EVD-009/012, NFR-REL-001/002: real API-role COMMIT completeness controls.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Pool } from "./common.mjs";
import {
  createDatabase,
  DatabaseAuthorityRepository,
} from "../../packages/data/dist/index.js";
import { PrismaClient } from "../../packages/data/dist/generated/prisma/client.js";
import { authorizeReconciliation } from "../../packages/data/dist/reconciliation-authorization.js";
import { scalarReconciliationIdentity } from "../../packages/domain/dist/index.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import { watchCommits } from "./reconciliation-commit-probes.mjs";
import { runWithCleanup, drainAndClose } from "./fixture-cleanup.mjs";
import { assertScalarCommitReceipt } from "./scalar-commit-receipt.mjs";
const { PrismaPg } = createRequire(
  new URL("../../packages/data/package.json", import.meta.url),
)("@prisma/adapter-pg");
const options = {
  isolationLevel: "ReadCommitted",
  maxWait: 5000,
  timeout: 10000,
};
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
const digest = (value) => createHash("sha256").update(value).digest("hex");
const wrongHash = (value) => (value[0] === "0" ? "1" : "0") + value.slice(1);

export async function verifyScalarCommitGuards(
  owner,
  connection,
  customerId,
  referenceProjectId,
) {
  reconciliationAcceptanceGuard();
  assert.equal(connection.user, "pdaa_api");
  const setup = createDatabase(connection);
  const poolOptions = {
    ...connection,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    idleTimeoutMillis: 10000,
  };
  const writerPool = new Pool(poolOptions),
    observerPool = new Pool(poolOptions);
  let active = null,
    observer,
    db;
  watchCommits(
    writerPool,
    () => active,
    () => observer,
  );
  return runWithCleanup(
    async () => {
      observer = await observerPool.connect();
      db = new PrismaClient({
        adapter: new PrismaPg(writerPool, { disposeExternalPool: false }),
      });
      const authority = new DatabaseAuthorityRepository(db);
      async function snapshot(f, tx = null) {
        const state = {};
        for (const table of tables) {
          const predicate =
            table === "AuditEvent"
              ? "detail->>'projectId'=$2"
              : '"projectId"=$2::uuid';
          const sql = `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${predicate} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 5001`;
          const rows = tx
            ? await tx.$queryRawUnsafe(sql, customerId, f.projectId)
            : (await observer.query(sql, [customerId, f.projectId])).rows;
          assert(rows.length <= 5000, "Scalar COMMIT snapshot overflow");
          state[table] = rows.map((r) => r.row);
        }
        return state;
      }
      async function routing(tx, f) {
        const { routing: route } = await authorizeReconciliation(
          tx,
          f.actor,
          f.projectId,
          "manage",
        );
        const project = await tx.project.findUniqueOrThrow({
          where: { id: f.projectId },
          select: { portfolioId: true },
        });
        const receipt = await tx.canonicalCreationReceipt.findFirst({
          where: {
            customerId,
            projectId: f.projectId,
            operation: "PROJECT",
            project: { sealed: true },
          },
          select: { id: true },
        });
        return {
          ...route,
          capturedPortfolioId: project.portfolioId,
          configurationReceiptId: receipt?.id ?? null,
        };
      }
      async function time(tx) {
        return (
          await tx.$queryRaw`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`
        )[0].now;
      }
      async function audit(
        tx,
        f,
        r,
        id,
        occurredAt,
        event,
        detail,
        actor = f.actor.subject,
      ) {
        await tx.auditEvent.create({
          data: {
            id,
            customerId,
            actor,
            correlationId: r.correlationId,
            occurredAt,
            event,
            detail,
          },
        });
      }
      async function assignment(
        tx,
        f,
        r,
        route,
        requestId,
        occurredAt,
        previous = null,
      ) {
        const id = randomUUID(),
          auditEventId = randomUUID(),
          revision = (previous?.revision ?? 0) + 1;
        const command = {
          projectId: f.projectId,
          requestId,
          expectedAssignmentRevision: previous?.revision ?? 0,
        };
        let requestHash = previous ? hash(command) : null;
        if (r.name === "wrong-refresh-hash")
          requestHash = wrongHash(requestHash);
        if (r.name === "wrong-refresh-time")
          occurredAt = new Date(previous.occurredAt.getTime() - 1);
        const row = await tx.scalarReconciliationAssignment.create({
          data: {
            ...route,
            id,
            customerId,
            projectId: f.projectId,
            factId: f.factId,
            requestId,
            revision,
            expectedRevision: previous?.revision ?? 0,
            previousAssignmentId: previous?.id ?? null,
            kind: previous ? "REFRESH" : "INITIAL",
            actor: f.actor.subject,
            occurredAt,
            auditEventId,
            idempotencyKey: previous ? randomUUID() : null,
            requestHash,
          },
        });
        await audit(
          tx,
          f,
          r,
          auditEventId,
          occurredAt,
          r.name === "wrong-refresh-audit"
            ? "scalar.reconciliation.assigned.invalid"
            : "scalar.reconciliation.assigned",
          {
            projectId: f.projectId,
            factId: f.factId,
            requestId,
            assignmentId: id,
            revision,
            reason: route.reason,
          },
        );
        r.assignmentId = row.id;
        return row;
      }
      async function capture(tx, f, r, prior = null) {
        const route = await routing(tx, f);
        const [fact] =
          await tx.$queryRaw`SELECT id,"factType",revision FROM "ProjectFact" WHERE "customerId"=${customerId}::uuid AND "projectId"=${f.projectId}::uuid AND id=${f.factId}::uuid FOR UPDATE`;
        assert(fact);
        const asOf = await time(tx),
          checkId = randomUUID();
        r.checkId = checkId;
        const canonicalHash = hash({
          projectId: f.projectId,
          factId: f.factId,
        });
        const requestHash =
          r.name === "wrong-check-hash"
            ? wrongHash(canonicalHash)
            : canonicalHash;
        const prepared = await authority.prepareAssessmentInTransaction(
          tx,
          f.actor,
          { projectId: f.projectId, fact, asOf },
        );
        const identity = scalarReconciliationIdentity(prepared.result);
        r.identity = identity;
        const assessment =
          await authority.persistPreparedAssessmentInTransaction(tx, f.actor, {
            prepared,
            subject: f.actor.subject,
            idempotencyKey: "sr_" + checkId.replaceAll("-", ""),
            requestHash,
            captureKind: "SCALAR_REQUEST",
            milestoneAssessmentId: null,
            scalarReconciliationCheckId: checkId,
          });
        r.assessmentId = assessment.id;
        r.identitySql = (
          await tx.$queryRaw`SELECT public.scalar_reconciliation_identity(${assessment.id}::uuid) AS identity`
        )[0].identity;
        assert.equal(r.identitySql, identity);
        if (r.name === "orphan-owned-assessment") return;
        let requestId = null,
          outcome = "NO_REQUEST";
        if (identity !== null && r.name !== "wrong-no-request-semantics") {
          requestId = prior?.requestId ?? randomUUID();
          outcome = prior ? "REUSED" : "CREATED";
          if (!prior) {
            const auditEventId = randomUUID();
            await tx.scalarReconciliationRequest.create({
              data: {
                id: requestId,
                customerId,
                projectId: f.projectId,
                factId: f.factId,
                ruleRevision: "scalar-authority-conflict/v1",
                originalAssessmentId: assessment.id,
                originCommandId: checkId,
                contributorHash: digest(identity),
                contributorIdentity: identity,
                createdBy: f.actor.subject,
                createdAt: asOf,
                auditEventId,
              },
            });
            await audit(
              tx,
              f,
              r,
              auditEventId,
              asOf,
              "scalar.reconciliation.requested",
              {
                projectId: f.projectId,
                factId: f.factId,
                requestId,
                assessmentId: assessment.id,
                checkId,
              },
            );
            if (r.name !== "missing-initial-assignment")
              await assignment(tx, f, r, route, requestId, asOf);
          }
        }
        r.requestId = requestId;
        const subject =
          r.name === "wrong-check-subject" ? f.pm.subject : f.actor.subject;
        const occurredAt =
          r.name === "wrong-check-time" ? new Date(asOf.getTime() + 1) : asOf;
        const auditEventId = randomUUID();
        await tx.scalarReconciliationCheck.create({
          data: {
            id: checkId,
            customerId,
            projectId: f.projectId,
            factId: f.factId,
            subject,
            idempotencyKey: randomUUID(),
            requestHash,
            assessmentId: assessment.id,
            requestId,
            outcome,
            occurredAt,
            auditEventId,
          },
        });
        const detail = {
          projectId: f.projectId,
          factId: f.factId,
          checkId,
          assessmentId: assessment.id,
          requestId,
          outcome,
        };
        if (r.name === "wrong-check-audit-detail") detail.factId = randomUUID();
        if (r.name === "wrong-check-audit-scope")
          detail.projectId = referenceProjectId;
        await audit(
          tx,
          f,
          r,
          auditEventId,
          r.name === "wrong-check-audit-time"
            ? new Date(occurredAt.getTime() + 1)
            : occurredAt,
          r.name === "wrong-check-audit-event"
            ? "scalar.reconciliation.checked.invalid"
            : "scalar.reconciliation.checked",
          detail,
          r.name === "wrong-check-audit-actor" ? f.pm.subject : subject,
        );
        if (
          outcome === "CREATED" &&
          !["unsealed-request", "missing-initial-assignment"].includes(r.name)
        )
          await tx.scalarReconciliationRequest.update({
            where: { id: requestId },
            data: { sealed: true },
          });
      }
      const fixtures = {};
      for (const [kind, optedIn] of [
        ["positive", true],
        ["negative", true],
        ["optout", false],
      ])
        fixtures[kind] = await reserveScalarFixture(
          owner,
          setup,
          customerId,
          referenceProjectId,
          "scalar-commit-" + kind,
          { optedIn },
        );
      const receipt = {
        family: "scalar-native-commit/v1",
        customerId,
        cases: [],
      };
      async function run(name, f, body) {
        const before = await snapshot(f);
        const record = {
          name,
          customerId,
          projectId: f.projectId,
          factId: f.factId,
          actor: f.actor.subject,
          correlationId: randomUUID(),
          nativeCommitAttempts: 0,
          callbackReturned: false,
        };
        active = record;
        let failure;
        try {
          await db.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
            const [session] =
              await tx.$queryRaw`SELECT current_user AS role,session_user AS "sessionUser",pg_backend_pid()::int AS pid`;
            assert.equal(session.role, "pdaa_api");
            assert.equal(session.sessionUser, "pdaa_api");
            Object.assign(record, session);
            await body(tx, record);
            record.pending = await snapshot(f, tx);
            // Wrong audit project scope intentionally falls outside the project projection.
            record.attemptAudits =
              await tx.$queryRaw`SELECT to_jsonb(t) AS row FROM "AuditEvent" t WHERE "customerId"=${customerId}::uuid AND "correlationId"=${record.correlationId} ORDER BY id`;
            record.attemptAudits = record.attemptAudits.map((r) => r.row);
            record.predicates = {};
            if (record.checkId)
              record.predicates.check = (
                await tx.$queryRaw`SELECT public.valid_scalar_reconciliation_check(${record.checkId}::uuid) AS valid`
              )[0].valid;
            if (record.requestId)
              record.predicates.request = (
                await tx.$queryRaw`SELECT public.valid_scalar_reconciliation_request(${record.requestId}::uuid) AS valid`
              )[0].valid;
            if (record.assignmentId)
              record.predicates.assignment = (
                await tx.$queryRaw`SELECT public.valid_scalar_reconciliation_assignment(${record.assignmentId}::uuid) AS valid`
              )[0].valid;
            record.callbackReturned = true;
          }, options);
        } catch (error) {
          failure = error;
        } finally {
          active = null;
        }
        assert.equal(
          record.callbackReturned,
          true,
          `${name}: callback failed before native COMMIT (${failure?.message ?? "no error"})`,
        );
        record.rejected = failure !== undefined;
        record.before = before;
        record.after = await snapshot(f);
        record.auditAfter = (
          await observer.query(
            'SELECT to_jsonb(t) AS row FROM "AuditEvent" t WHERE "customerId"=$1 AND "correlationId"=$2 ORDER BY id',
            [customerId, record.correlationId],
          )
        ).rows.map((r) => r.row);
        const ids = new Set(
          [record.checkId, record.assessmentId, record.assignmentId].filter(
            Boolean,
          ),
        );
        for (const row of record.attemptAudits) ids.add(row.id);
        for (const table of tables)
          for (const row of record.pending[table]) {
            if (
              !before[table].some(
                (old) => JSON.stringify(old) === JSON.stringify(row),
              )
            ) {
              for (const key of ["id", "assessmentId"])
                if (row[key]) ids.add(row[key]);
            }
          }
        record.generatedIds = [...ids].sort();
        record.generatedAbsence = {};
        if (!name.startsWith("positive-")) {
          for (const table of tables) {
            const counts = (
              await observer.query(
                `SELECT count(*)::int AS n FROM "${table}" t WHERE "customerId"=$1 AND
            (to_jsonb(t)->>'id'=ANY($2::text[]) OR to_jsonb(t)->>'assessmentId'=ANY($2::text[]) OR to_jsonb(t)->>'scalarReconciliationCheckId'=ANY($2::text[]))`,
                [customerId, record.generatedIds],
              )
            ).rows;
            record.generatedAbsence[table] = counts[0].n;
          }
        }
        receipt.cases.push(record);
        return record;
      }
      const positive = await run(
        "positive-created",
        fixtures.positive,
        (tx, r) => capture(tx, fixtures.positive, r),
      );
      await run("positive-reused", fixtures.positive, (tx, r) =>
        capture(tx, fixtures.positive, r, positive),
      );
      for (const name of [
        "orphan-owned-assessment",
        "wrong-no-request-semantics",
        "unsealed-request",
        "missing-initial-assignment",
      ])
        await run(name, fixtures.negative, (tx, r) =>
          capture(tx, fixtures.negative, r),
        );
      await run("positive-no-request", fixtures.optout, (tx, r) =>
        capture(tx, fixtures.optout, r),
      );
      for (const name of [
        "wrong-check-hash",
        "wrong-check-subject",
        "wrong-check-time",
        "wrong-check-audit-event",
        "wrong-check-audit-actor",
        "wrong-check-audit-time",
        "wrong-check-audit-detail",
        "wrong-check-audit-scope",
      ])
        await run(name, fixtures.optout, (tx, r) =>
          capture(tx, fixtures.optout, r),
        );
      for (const name of [
        "wrong-refresh-hash",
        "wrong-refresh-audit",
        "wrong-refresh-time",
        "positive-refresh",
      ])
        await run(name, fixtures.positive, async (tx, r) => {
          const route = await routing(tx, fixtures.positive);
          const previous =
            await tx.scalarReconciliationAssignment.findFirstOrThrow({
              where: { requestId: positive.requestId },
              orderBy: { revision: "desc" },
            });
          r.requestId = positive.requestId;
          await assignment(
            tx,
            fixtures.positive,
            r,
            route,
            positive.requestId,
            await time(tx),
            previous,
          );
        });
      assertScalarCommitReceipt(receipt, customerId);
      return receipt;
    },
    () =>
      drainAndClose(
        [],
        [
          () => db?.$disconnect(),
          async () => {
            observer?.release();
            await observerPool.end();
          },
          () => writerPool.end(),
          () => setup.$disconnect(),
        ],
      ),
  );
}
