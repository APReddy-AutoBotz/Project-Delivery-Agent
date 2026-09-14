// FR-EVD-009/012, NFR-SEC-001/REL-001: current authorization versus frozen proof.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "./common.mjs";
import {
  createDatabase,
  DatabaseScalarReconciliationRepository,
  DatabaseProjectFactRepository,
  DatabaseProjectRepository,
  DatabaseAuthorityRepository,
} from "../../packages/data/dist/index.js";
import { ProjectFactError } from "../../packages/domain/dist/index.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import {
  observeTransactions,
  waitForTransactionBlockers,
} from "./transaction-latch.mjs";
import { runWithCleanup, drainAndClose } from "./fixture-cleanup.mjs";
import { assertScalarAccessRaces } from "./scalar-access-races-receipt.mjs";

const historyTables = [
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
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export async function verifyScalarAccessRaces(
  owner,
  connection,
  customerId,
  referenceProjectId,
) {
  reconciliationAcceptanceGuard();
  assert.equal(connection.user, "pdaa_api");
  const setup = createDatabase(connection);
  const pool = new Pool({
    ...connection,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 3000,
  });
  const pending = [],
    releases = [],
    closers = [() => setup.$disconnect(), () => pool.end()];
  return runWithCleanup(
    async () => {
      const observer = await pool.connect();
      closers.unshift(() => observer.release());
      const principal = (
        await observer.query(
          "SELECT current_user AS role, pg_backend_pid() AS pid",
        )
      ).rows[0];
      assert.equal(principal.role, "pdaa_api");
      const receipt = {
        family: "scalar-access-races/v1",
        customerId,
        observer: principal,
        cases: [],
      };
      async function rows(table, projectId) {
        const scope =
          table === "AuditEvent"
            ? "detail->>'projectId'=$2"
            : '"projectId"=$2::uuid';
        const result = (
          await observer.query(
            `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${scope} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 5001`,
            [customerId, projectId],
          )
        ).rows.map((r) => r.row);
        assert(result.length <= 5000, "Scalar access snapshot overflow");
        return result;
      }
      async function snapshot(f) {
        const result = {};
        for (const table of historyTables)
          result[table] = await rows(table, f.projectId);
        return result;
      }
      async function controls(f) {
        const result = {};
        for (const table of [
          "FactSourceAccess",
          "FactSourceReader",
          "AuthorityPolicy",
          "AuthorityPolicyRevision",
          "AuthorityPolicyReceipt",
        ])
          result[table] = await rows(table, f.projectId);
        result.AccessGrant = (
          await observer.query(
            'SELECT to_jsonb(t) AS row FROM "AccessGrant" t WHERE "customerId"=$1 AND subject=ANY($2::text[]) ORDER BY id LIMIT 101',
            [customerId, [f.actor.subject, f.pm.subject]],
          )
        ).rows.map((r) => r.row);
        assert(result.AccessGrant.length <= 100);
        return result;
      }
      function spec(operation, actor, command) {
        return { operation, actor, command, correlationId: randomUUID() };
      }
      function start(s, hold = false) {
        const tag = "pdaa-scalar-access-" + randomUUID();
        const db = createDatabase({ ...connection, application_name: tag });
        const ready = gate(),
          release = gate();
        releases.push(release);
        closers.push(() => db.$disconnect());
        const record = { ...s, tag, pid: null, callbackReturned: false };
        const wrapped = observeTransactions(db, {
          started(pid) {
            assert.equal(record.pid, null);
            record.pid = pid;
          },
          async beforeCommit() {
            record.callbackReturned = true;
            if (hold) {
              ready.resolve();
              assert.equal(
                await release.promise,
                "commit",
                "Aborted scalar access holder",
              );
            }
          },
        });
        const running = (async () => {
          const context = { correlationId: s.correlationId };
          const scalar = new DatabaseScalarReconciliationRepository(wrapped);
          switch (s.operation) {
            case "get":
              return scalar.get(s.actor, s.command);
            case "check":
              return scalar.check(s.actor, s.command, context);
            case "setSourceAccess":
              return new DatabaseProjectFactRepository(wrapped).setSourceAccess(
                s.actor,
                s.command,
                context,
              );
            case "revokeGrant":
              return new DatabaseProjectRepository(wrapped).revokeGrant(
                s.actor,
                s.command,
                s.correlationId,
              );
            case "appendPolicy":
              return new DatabaseAuthorityRepository(wrapped).appendPolicy(
                s.actor,
                s.command,
                context,
              );
            default:
              throw new Error("Unknown scalar access operation");
          }
        })();
        const settled = running.then(
          (value) => ({ status: "fulfilled", value: value ?? null }),
          (reason) => {
            if (
              reason instanceof ProjectFactError &&
              reason.code === "DENIED" &&
              reason.message === "Project fact operation rejected"
            )
              return { status: "rejected", code: reason.code };
            throw reason;
          },
        );
        // Keep rejected transport/internal failures handled until the case drains.
        const drained = settled.then(
          () => undefined,
          () => undefined,
        );
        pending.push(drained);
        return { record, ready, release, settled, drained };
      }
      async function race(specs) {
        const holder = start(specs[0], true),
          peers = [holder];
        let timer;
        try {
          await Promise.race([
            holder.ready.promise,
            holder.settled.then(() => {
              throw new Error("Scalar access holder completed before latch");
            }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Scalar access latch budget exceeded")),
                3000,
              );
            }),
          ]);
          clearTimeout(timer);
          peers.push(...specs.slice(1).map((s) => start(s)));
          await waitForTransactionBlockers(
            observer,
            holder.record.pid,
            peers.slice(1).map((p) => p.record),
          );
          const blocked = (
            await observer.query(
              "SELECT pid,usename,application_name,state,wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[]) ORDER BY pid",
              [peers.map((p) => p.record.pid)],
            )
          ).rows;
          holder.release.resolve("commit");
          const outcomes = await Promise.all(peers.map((p) => p.settled));
          return {
            participants: peers.map((p) => p.record),
            blocked,
            outcomes,
          };
        } finally {
          clearTimeout(timer);
          holder.release.resolve("abort");
          await Promise.all(peers.map((p) => p.drained));
        }
      }
      for (const name of [
        "source-first",
        "read-first",
        "grant-first",
        "policy-first",
        "current-role-loss",
      ]) {
        const f = await reserveScalarFixture(
          owner,
          setup,
          customerId,
          referenceProjectId,
          "scalar-access-" + name,
        );
        const repository = new DatabaseScalarReconciliationRepository(setup);
        // The PM owns the original command, so PM old-key replay is an actual replay.
        const original = await repository.check(f.pm, f.command, {
          correlationId: randomUUID(),
        });
        const read = { projectId: f.projectId, requestId: original.request.id };
        const baseline = await repository.get(f.pm, read);
        const before = await snapshot(f),
          controlBefore = await controls(f);
        const dependencies = (
          await observer.query(
            `SELECT d."versionId",v."sourceId",v."evidenceId" FROM "FactAssessmentVersion" d
        JOIN "ProjectFactVersion" v ON (v."customerId",v."projectId",v."factId",v.id)=(d."customerId",d."projectId",d."factId",d."versionId")
        JOIN "FactEvidence" e ON (e."customerId",e."projectId",e."factId",e."sourceId",e.id)=(v."customerId",v."projectId",v."factId",v."sourceId",v."evidenceId")
        WHERE d."customerId"=$1 AND d."projectId"=$2 AND d."assessmentId"=$3 ORDER BY d."versionId"`,
            [customerId, f.projectId, original.assessment.assessmentId],
          )
        ).rows;
        assert.equal(dependencies.length, 2);
        const selected = dependencies[0];
        const access = controlBefore.FactSourceAccess.find(
          (r) => r.sourceId === selected.sourceId,
        );
        const source = spec("setSourceAccess", f.actor, {
          projectId: f.projectId,
          sourceId: selected.sourceId,
          expectedRevision: access.revision,
          state: "AVAILABLE",
          readers: [f.actor.subject],
        });
        const get = spec("get", f.pm, read);
        const replay = spec("check", f.pm, f.command);
        const fresh = spec("check", f.pm, {
          ...f.command,
          idempotencyKey: randomUUID(),
        });
        let execution;
        if (name === "source-first")
          execution = await race([source, get, replay, fresh]);
        if (name === "read-first") execution = await race([get, source]);
        if (name === "grant-first") {
          const grants = controlBefore.AccessGrant.filter(
            (g) => g.subject === f.pm.subject,
          );
          assert.equal(grants.length, 1);
          execution = await race([
            spec("revokeGrant", f.actor, {
              subject: f.pm.subject,
              scopeType: "project",
              scopeId: f.projectId,
            }),
            replay,
            fresh,
            get,
          ]);
        }
        if (name === "policy-first") {
          const policy = controlBefore.AuthorityPolicyRevision[0];
          assert.equal(controlBefore.AuthorityPolicyRevision.length, 1);
          execution = await race([
            spec("appendPolicy", f.actor, {
              projectId: f.projectId,
              factType: f.factType,
              expectedRevision: 1,
              idempotencyKey: randomUUID(),
              effectiveAt: new Date(Date.now() - 1).toISOString(),
              definition: {
                ...policy.definition,
                conflictBehavior: "RETAIN_CONFLICT",
              },
            }),
            get,
            replay,
            fresh,
          ]);
        }
        if (name === "current-role-loss") {
          const lost = { ...f.pm, roles: ["leadership"] };
          const peers = [
            spec("get", lost, read),
            spec("check", lost, f.command),
            spec("check", lost, fresh.command),
          ].map((s) => start(s));
          execution = {
            participants: peers.map((p) => p.record),
            outcomes: await Promise.all(peers.map((p) => p.settled)),
            blocked: [],
          };
        }
        const after = await snapshot(f),
          controlAfter = await controls(f);
        const audits = (
          await observer.query(
            'SELECT to_jsonb(t) AS row FROM "AuditEvent" t WHERE "customerId"=$1 AND "correlationId"=ANY($2::text[]) ORDER BY id LIMIT 101',
            [customerId, execution.participants.map((p) => p.correlationId)],
          )
        ).rows.map((r) => r.row);
        assert(audits.length <= 100);
        receipt.cases.push({
          name,
          projectId: f.projectId,
          factId: f.factId,
          actor: f.actor,
          pm: f.pm,
          command: f.command,
          original,
          baseline,
          dependencies,
          selected,
          before,
          after,
          controlBefore,
          controlAfter,
          ...execution,
          audits,
          finalDetail: await repository.get(f.pm, read),
        });
      }
      assertScalarAccessRaces(receipt, customerId);
      return receipt;
    },
    async () => {
      releases.forEach((r) => r.resolve("abort"));
      await drainAndClose(pending, closers);
    },
  );
}
