import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "./common.mjs";
import { runWithCleanup, drainAndClose } from "./fixture-cleanup.mjs";
import { canonicalFixture } from "./canonical-projects.mjs";
import {
  observeTransactions,
  waitForTransactionBlockers,
} from "./transaction-latch.mjs";
import {
  createDatabase,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
  DatabaseMilestoneConsistencyRepository,
} from "../../packages/data/dist/index.js";

const trackedTables = [
  "ProjectFact",
  "FactSource",
  "FactSourceAccess",
  "FactSourceReader",
  "FactEvidence",
  "ProjectFactVersion",
  "FactAppendReceipt",
  "AuthorityPolicy",
  "AuthorityPolicyRevision",
  "AuthorityPolicyReceipt",
  "FactAuthorityConflict",
  "FactAssessment",
  "FactAssessmentVersion",
  "FactAssessmentConflict",
  "CanonicalStateBinding",
  "CanonicalStateBindingReceipt",
  "MilestoneConsistencyAssessment",
  "MilestoneConsistencyTarget",
  "MilestoneConsistencyContributorVersion",
];
const authorityDefinition = {
  tiers: [
    {
      selectors: [
        {
          sourceType: "human_statement",
          instanceId: null,
          requiredApproval: "NOT_REQUIRED",
          validity: null,
        },
      ],
    },
  ],
  conflictBehavior: "REQUEST_RECONCILIATION",
};
const effectiveAt = "2026-09-01T00:00:00.000Z";
const validUntil = "2027-09-01T00:00:00.000Z";
const fulfilled = (outcome) => {
  assert.equal(
    outcome.status,
    "fulfilled",
    "Contended API command must succeed",
  );
  return outcome.value;
};
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function held(promise) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("API writer did not reach its commit latch")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Actual API credentials are mandatory: denial audits occur outside the command
// transaction and would otherwise accidentally run with the fixture owner's role.
export async function verifyMilestoneConcurrency(
  owner,
  connection,
  customerId,
  existingProjectId,
  observerConnection,
) {
  assert.equal(process.env.PDAA_ACCEPTANCE, "isolated");
  assert.match(
    process.env.PDAA_ACCEPTANCE_RUN_ID,
    /^pdaa-acceptance-\d+-[a-f0-9]{8}$/,
  );
  assert.equal(connection.user, "pdaa_api");
  assert.equal(observerConnection.user, "fixture_admin");
  const setup = createDatabase(connection);
  let observer;
  return runWithCleanup(
    async () => {
      observer = new Pool({
        ...observerConnection,
        max: 1,
        connectionTimeoutMillis: 3000,
        query_timeout: 3000,
      });
      const authority = new DatabaseAuthorityRepository(setup);
      const milestones = new DatabaseMilestoneConsistencyRepository(setup);
      const portfolioId = (
        await owner.query(
          'SELECT "portfolioId" FROM "Project" WHERE id=$1 AND "customerId"=$2',
          [existingProjectId, customerId],
        )
      ).rows[0].portfolioId;
      const creator = {
        customerId,
        subject: "race-creator-" + randomUUID(),
        roles: ["portfolio_manager"],
      };
      await owner.query(
        'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'portfolio\',$4,\'portfolio_manager\')',
        [randomUUID(), customerId, creator.subject, portfolioId],
      );
      const fixture = async (bound = false) => {
        const project = await new DatabaseCanonicalProjectRepository(
          setup,
        ).createProject(creator, canonicalFixture(portfolioId), randomUUID());
        const link = (
          await owner.query(
            'SELECT "milestoneId","workItemId" FROM "RequiredWorkItem" WHERE "projectId"=$1',
            [project.id],
          )
        ).rows;
        assert.equal(link.length, 1);
        const actor = {
          customerId,
          subject: "race-actor-" + randomUUID(),
          roles: ["pmo_admin"],
        };
        const grantId = randomUUID();
        await owner.query(
          'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,\'project\',$4,\'pmo_admin\')',
          [grantId, customerId, actor.subject, project.id],
        );
        const f = {
          projectId: project.id,
          actor,
          grantId,
          ...link[0],
          context: { correlationId: "race-" + randomUUID() },
          bindings: [],
        };
        if (bound)
          for (const work of [false, true]) {
            const binding = await milestones.createStateBinding(
              actor,
              bindingRequest(f, work),
              f.context,
            );
            await authority.appendPolicy(
              actor,
              {
                projectId: f.projectId,
                factType: binding.factType,
                expectedRevision: 0,
                idempotencyKey: randomUUID(),
                effectiveAt,
                definition: authorityDefinition,
              },
              f.context,
            );
            f.bindings.push(binding);
          }
        return f;
      };
      const bindingRequest = (f, work = false) => ({
        projectId: f.projectId,
        targetKind: work ? "WORK_ITEM" : "MILESTONE",
        targetId: work ? f.workItemId : f.milestoneId,
        initialState: work ? "OPEN" : "COMPLETE",
        idempotencyKey: randomUUID(),
        effectiveAt,
        validUntil,
        originalStatement: "Synthetic contended state birth",
      });
      const captureRequest = (f) => ({
        projectId: f.projectId,
        milestoneId: f.milestoneId,
        ruleRevision: "milestone-required-state/v1",
        enabled: true,
        idempotencyKey: randomUUID(),
      });
      const footprint = async (f) =>
        (
          await owner.query(
            "SELECT " +
              trackedTables
                .map(
                  (table) =>
                    `(SELECT count(*)::int FROM "${table}" WHERE "projectId"=$1) AS "${table}"`,
                )
                .join(","),
            [f.projectId],
          )
        ).rows[0];
      const assertDelta = async (f, before, expected) => {
        const after = await footprint(f);
        for (const table of trackedTables)
          assert.equal(
            after[table] - before[table],
            expected[table] ?? 0,
            table + " exact committed delta",
          );
      };
      const audit = async (f, context) =>
        (
          await owner.query(
            'SELECT event,detail FROM "AuditEvent" WHERE "customerId"=$1 AND actor=$2 AND "correlationId"=$3 ORDER BY event',
            [customerId, f.actor.subject, context.correlationId],
          )
        ).rows;
      const contenders = async (f, commands, revoke = false) => {
        const controlPool = new Pool({
          ...connection,
          connectionTimeoutMillis: 3000,
          query_timeout: 3000,
        });
        let control;
        const clients = commands.map(() => ({
          tag: "pdaa-race-" + randomUUID().slice(0, 8),
          pid: null,
        }));
        let outcomes,
          pending,
          reached = false;
        return runWithCleanup(
          async () => {
            control = await controlPool.connect();
            for (const item of clients)
              item.db = createDatabase({
                ...connection,
                application_name: item.tag,
              });
            await control.query("BEGIN");
            const meta = (
              await control.query(
                "SELECT current_user AS role, pg_backend_pid()::int AS pid",
              )
            ).rows[0];
            assert.equal(meta.role, "pdaa_api");
            const locked = revoke
              ? await control.query(
                  'DELETE FROM "AccessGrant" WHERE id=$1 RETURNING id',
                  [f.grantId],
                )
              : await control.query(
                  'SELECT id FROM "Project" WHERE "customerId"=$1 AND id=$2 FOR UPDATE',
                  [customerId, f.projectId],
                );
            assert.equal(locked.rows.length, 1);
            pending = Promise.allSettled(
              commands.map((command, index) => {
                const item = clients[index];
                return Promise.resolve().then(() =>
                  command(
                    observeTransactions(item.db, {
                      started: (pid) => {
                        item.pid = pid;
                      },
                    }),
                  ),
                );
              }),
            );
            await runWithCleanup(
              async () => {
                await waitForTransactionBlockers(observer, meta.pid, clients);
                reached = true;
              },
              () => control.query(revoke && reached ? "COMMIT" : "ROLLBACK"),
            );
            outcomes = await pending;
            return outcomes;
          },
          async () => {
            let rollbackFailure;
            try {
              if (control) await control.query("ROLLBACK");
            } catch (error) {
              rollbackFailure = error;
            }
            const failures = rollbackFailure ? [rollbackFailure] : [];
            try {
              if (control) control.release(rollbackFailure);
            } catch (error) {
              failures.push(error);
            }
            await drainAndClose(
              pending ? [pending] : [],
              [
                () => controlPool.end(),
                ...clients
                  .filter((item) => item.db)
                  .map((item) => () => item.db.$disconnect()),
              ],
              failures,
            );
          },
        );
      };
      const captureAfterWriter = async (f, write) => {
        const writer = {
          tag: "pdaa-write-" + randomUUID().slice(0, 8),
          pid: null,
        };
        const reader = {
          tag: "pdaa-read-" + randomUUID().slice(0, 8),
          pid: null,
        };
        let writerDb, readerDb;
        const ready = gate(),
          release = gate();
        let writePending, readPending;
        return runWithCleanup(
          async () => {
            writerDb = createDatabase({
              ...connection,
              application_name: writer.tag,
            });
            readerDb = createDatabase({
              ...connection,
              application_name: reader.tag,
            });
            writePending = Promise.allSettled([
              Promise.resolve().then(() =>
                write(
                  observeTransactions(writerDb, {
                    started: (pid) => {
                      writer.pid = pid;
                    },
                    beforeCommit: async () => {
                      ready.resolve();
                      await release.promise;
                    },
                  }),
                ),
              ),
            ]);
            await held(ready.promise);
            readPending = Promise.allSettled([
              new DatabaseMilestoneConsistencyRepository(
                observeTransactions(readerDb, {
                  started: (pid) => {
                    reader.pid = pid;
                  },
                }),
              ).captureMilestoneConsistency(
                f.actor,
                captureRequest(f),
                f.context,
              ),
            ]);
            await waitForTransactionBlockers(observer, writer.pid, [reader]);
            release.resolve();
            return [
              fulfilled((await writePending)[0]),
              fulfilled((await readPending)[0]),
            ];
          },
          async () => {
            release.resolve();
            await drainAndClose(
              [
                ...(writePending ? [writePending] : []),
                ...(readPending ? [readPending] : []),
              ],
              [
                ...(writerDb ? [() => writerDb.$disconnect()] : []),
                ...(readerDb ? [() => readerDb.$disconnect()] : []),
              ],
            );
          },
        );
      };
      const birthDelta = {
        ProjectFact: 1,
        FactSource: 1,
        FactSourceAccess: 1,
        FactSourceReader: 1,
        FactEvidence: 1,
        ProjectFactVersion: 1,
      };
      const receipts = {};
      assert.equal(
        (await setup.$queryRaw`SELECT current_user AS role`)[0].role,
        "pdaa_api",
      );
      for (const kind of ["append", "policy", "binding", "capture"]) {
        const f = await fixture(kind === "capture");
        const context = { correlationId: "duplicate-" + randomUUID() };
        const request =
          kind === "append"
            ? {
                projectId: f.projectId,
                factType: "race." + randomUUID(),
                expectedRevision: 0,
                idempotencyKey: randomUUID(),
                value: { type: "text", value: "OPEN" },
                effectiveAt,
                validUntil,
                originalStatement: "Synthetic identical append",
              }
            : kind === "policy"
              ? {
                  projectId: f.projectId,
                  factType: "race." + randomUUID(),
                  expectedRevision: 0,
                  idempotencyKey: randomUUID(),
                  effectiveAt,
                  definition: null,
                }
              : kind === "binding"
                ? bindingRequest(f)
                : captureRequest(f);
        const command = (db) =>
          kind === "append"
            ? new DatabaseProjectFactRepository(db).appendHumanStatement(
                f.actor,
                request,
                context,
              )
            : kind === "policy"
              ? new DatabaseAuthorityRepository(db).appendPolicy(
                  f.actor,
                  request,
                  context,
                )
              : kind === "binding"
                ? new DatabaseMilestoneConsistencyRepository(
                    db,
                  ).createStateBinding(f.actor, request, context)
                : new DatabaseMilestoneConsistencyRepository(
                    db,
                  ).captureMilestoneConsistency(f.actor, request, context);
        const before = await footprint(f);
        const [a, b] = (await contenders(f, [command, command])).map(fulfilled);
        assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
        assert.deepEqual({ ...a, replayed: false }, { ...b, replayed: false });
        await assertDelta(
          f,
          before,
          kind === "append"
            ? { ...birthDelta, FactAppendReceipt: 1 }
            : kind === "policy"
              ? {
                  AuthorityPolicy: 1,
                  AuthorityPolicyRevision: 1,
                  AuthorityPolicyReceipt: 1,
                }
              : kind === "binding"
                ? {
                    ...birthDelta,
                    CanonicalStateBinding: 1,
                    CanonicalStateBindingReceipt: 1,
                  }
                : {
                    MilestoneConsistencyAssessment: 1,
                    FactAssessment: 2,
                    FactAssessmentVersion: 2,
                    MilestoneConsistencyTarget: 2,
                    MilestoneConsistencyContributorVersion: 2,
                  },
        );
        const events = await audit(f, context);
        assert.deepEqual(
          events.map((row) => row.event),
          [
            {
              append: "fact.appended",
              policy: "authority.policy.appended",
              binding: "fact.binding.created",
              capture: "milestone.consistency.captured",
            }[kind],
          ],
        );
        if (kind === "capture") assert.equal(a.result.status, "CONFLICTING");
        receipts[kind] = {
          contended: true,
          oneCommitOneReplay: true,
          exactRowsAndAudit: true,
        };
      }
      {
        const f = await fixture();
        const commonCandidate = randomUUID();
        const queues = [false, true].map((work) => ({
          work,
          ids: [
            randomUUID(),
            commonCandidate,
            ...Array.from({ length: 7 }, () => randomUUID()),
          ],
          used: 0,
          request: bindingRequest(f, work),
        }));
        const before = await footprint(f);
        const results = (
          await contenders(
            f,
            queues.map(
              (item) => (db) =>
                new DatabaseMilestoneConsistencyRepository(db, () => {
                  assert(item.used < item.ids.length);
                  return item.ids[item.used++];
                }).createStateBinding(f.actor, item.request, f.context),
            ),
          )
        ).map(fulfilled);
        assert.deepEqual(queues.map((item) => item.used).sort(), [8, 9]);
        assert.equal(new Set(results.map((row) => row.factId)).size, 2);
        assert.equal(new Set(results.map((row) => row.factType)).size, 2);
        for (const [index, result] of results.entries()) {
          const item = queues[index];
          assert.equal(result.id, item.ids[0]);
          assert.equal(
            result.factType,
            "canonical.state." +
              item.ids[item.used === 8 ? 1 : 2].replaceAll("-", ""),
          );
          assert.equal(result.replayed, false);
        }
        await assertDelta(
          f,
          before,
          Object.fromEntries(
            Object.entries({
              ...birthDelta,
              CanonicalStateBinding: 1,
              CanonicalStateBindingReceipt: 1,
            }).map(([key, value]) => [key, value * 2]),
          ),
        );
        assert.deepEqual(
          (await audit(f, f.context)).map((row) => row.event),
          ["fact.binding.created", "fact.binding.created"],
        );
        receipts.distinctBindingCollision = {
          contended: true,
          skippedOccupiedCandidate: true,
          distinctFreshFacts: true,
          noAdoptionOrPolicy: true,
        };
      }
      {
        const f = await fixture(true),
          work = f.bindings[1];
        f.context = { correlationId: "append-wins-" + randomUUID() };
        const before = await footprint(f);
        const [appended, captured] = await captureAfterWriter(f, (db) =>
          new DatabaseProjectFactRepository(db).appendHumanStatement(
            f.actor,
            {
              projectId: f.projectId,
              factType: work.factType,
              expectedRevision: 1,
              idempotencyKey: randomUUID(),
              value: { type: "text", value: "COMPLETE" },
              effectiveAt: "2026-09-02T00:00:00.000Z",
              validUntil,
              originalStatement: "Synthetic append committed before capture",
            },
            f.context,
          ),
        );
        assert.equal(captured.result.status, "NOT_DETECTED");
        const pinned = (
          await owner.query(
            'SELECT a."factRevision",a."asOf",v.id AS "versionId",e."observedAt" FROM "FactAssessment" a JOIN "FactAssessmentVersion" av ON av."assessmentId"=a.id JOIN "ProjectFactVersion" v ON v.id=av."versionId" JOIN "FactEvidence" e ON e.id=v."evidenceId" WHERE a."milestoneAssessmentId"=$1 AND a."factId"=$2 AND v.revision=2',
            [captured.assessmentId, work.factId],
          )
        ).rows;
        assert.equal(pinned.length, 1);
        assert.equal(pinned[0].factRevision, 2);
        assert.equal(pinned[0].versionId, appended.entry.id);
        assert(pinned[0].asOf >= pinned[0].observedAt);
        const commonTimes = (
          await owner.query(
            'SELECT a."asOf"=m."asOf" AS same FROM "FactAssessment" a JOIN "MilestoneConsistencyAssessment" m ON m.id=a."milestoneAssessmentId" WHERE m.id=$1',
            [captured.assessmentId],
          )
        ).rows;
        assert.deepEqual(commonTimes, [{ same: true }, { same: true }]);
        await assertDelta(f, before, {
          FactEvidence: 1,
          ProjectFactVersion: 1,
          FactAppendReceipt: 1,
          MilestoneConsistencyAssessment: 1,
          FactAssessment: 2,
          FactAssessmentVersion: 3,
          MilestoneConsistencyTarget: 2,
        });
        assert.deepEqual(
          (await audit(f, f.context)).map((row) => row.event),
          ["fact.appended", "milestone.consistency.captured"],
        );
        receipts.appendWinsCapture = {
          contended: true,
          winningRevisionPinned: true,
          commonAsOf: true,
        };
      }
      for (const kind of ["policy", "source"]) {
        const f = await fixture(true),
          work = f.bindings[1];
        f.context = { correlationId: kind + "-wins-" + randomUUID() };
        const before = await footprint(f);
        const [changed, captured] = await captureAfterWriter(f, (db) =>
          kind === "policy"
            ? new DatabaseAuthorityRepository(db).appendPolicy(
                f.actor,
                {
                  projectId: f.projectId,
                  factType: work.factType,
                  expectedRevision: 1,
                  idempotencyKey: randomUUID(),
                  effectiveAt,
                  definition: null,
                },
                f.context,
              )
            : new DatabaseProjectFactRepository(db).setSourceAccess(
                f.actor,
                {
                  projectId: f.projectId,
                  sourceId: work.entry.sourceId,
                  expectedRevision: work.entry.sourceAccessRevision,
                  state: "REVOKED",
                  readers: [f.actor.subject],
                },
                f.context,
              ),
        );
        assert.equal(
          captured.visibility,
          kind === "policy" ? "available" : "restricted",
        );
        assert.equal(captured.revalidationRequired, kind === "source");
        if (kind === "policy") assert.equal(captured.result.status, "UNKNOWN");
        else assert.equal(captured.result, null);
        const parent = (
          await owner.query(
            'SELECT enabled,complete,sealed,status,"targetCount","requiredLinkCount","versionCount","evidenceCount","conflictCount","contributorCount",public.valid_milestone_consistency_assessment(id) AS valid FROM "MilestoneConsistencyAssessment" WHERE id=$1',
            [captured.assessmentId],
          )
        ).rows[0];
        assert.deepEqual(parent, {
          enabled: true,
          complete: true,
          sealed: true,
          valid: true,
          status: kind === "policy" ? "UNKNOWN" : "REVALIDATION_REQUIRED",
          targetCount: 2,
          requiredLinkCount: 1,
          versionCount: 2,
          evidenceCount: 2,
          conflictCount: 0,
          contributorCount: 0,
        });
        const children = (
          await owner.query(
            'SELECT a.*,a."asOf"=m."asOf" AS "commonAsOf" FROM "FactAssessment" a JOIN "MilestoneConsistencyAssessment" m ON m.id=a."milestoneAssessmentId" WHERE m.id=$1',
            [captured.assessmentId],
          )
        ).rows;
        assert.equal(children.length, 2);
        for (const child of children) {
          assert.equal(child.captureKind, "MILESTONE");
          assert.equal(
            child.complete && child.sealed && child.commonAsOf,
            true,
          );
          assert.equal(child.factRevision, 1);
          assert.equal(child.versionCount, 1);
          assert.equal(child.conflictCount, 0);
        }
        const child = children.find((row) => row.factId === work.factId);
        if (kind === "policy") {
          assert.equal(child.result.status, "NO_POLICY");
          assert.equal(child.result.policy, null);
          assert.equal(child.policyId, changed.event.policyId);
          assert.equal(child.policyRevisionId, changed.event.id);
          assert.equal(child.policyThroughRevision, 2);
        } else {
          assert.equal(child.result.status, "REVALIDATION_REQUIRED");
          const dependencies = (
            await owner.query(
              'SELECT "sourceAccessRevision" FROM "FactAssessmentVersion" WHERE "assessmentId"=$1',
              [child.id],
            )
          ).rows;
          assert.deepEqual(dependencies, [
            { sourceAccessRevision: changed.revision },
          ]);
        }
        await assertDelta(f, before, {
          ...(kind === "policy"
            ? { AuthorityPolicyRevision: 1, AuthorityPolicyReceipt: 1 }
            : {}),
          MilestoneConsistencyAssessment: 1,
          FactAssessment: 2,
          FactAssessmentVersion: 2,
          MilestoneConsistencyTarget: 2,
        });
        assert.deepEqual(
          (await audit(f, f.context)).map((row) => row.event),
          [
            kind === "policy"
              ? "authority.policy.appended"
              : "fact.source_access.changed",
            "milestone.consistency.captured",
          ],
        );
        receipts[kind + "WinsCapture"] = {
          contended: true,
          winningRevisionPinned: true,
          commonAsOf: true,
          exactProofAndAudit: true,
        };
      }
      {
        const f = await fixture(true);
        f.context = { correlationId: "grant-wins-" + randomUUID() };
        const before = await footprint(f);
        const [denied] = await contenders(
          f,
          [
            (db) =>
              new DatabaseMilestoneConsistencyRepository(
                db,
              ).captureMilestoneConsistency(
                f.actor,
                captureRequest(f),
                f.context,
              ),
          ],
          true,
        );
        assert.equal(denied.status, "rejected");
        assert.equal(denied.reason.code, "DENIED");
        await assertDelta(f, before, {});
        assert.deepEqual(await audit(f, f.context), [
          {
            event: "milestone.consistency.denied",
            detail: { projectId: f.projectId, reason: "DENIED" },
          },
        ]);
        receipts.grantRevocationWinsCapture = {
          contended: true,
          denied: true,
          noProofOrScalarWrites: true,
          exactDenialAudit: true,
        };
      }
      return { executedAs: "pdaa_api", ...receipts };
    },
    () =>
      drainAndClose(
        [],
        [
          () => setup.$disconnect(),
          ...(observer ? [() => observer.end()] : []),
        ],
      ),
  );
}
