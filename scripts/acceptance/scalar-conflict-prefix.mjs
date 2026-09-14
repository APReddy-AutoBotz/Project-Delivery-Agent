// FR-EVD-004/007/009/012, NFR-REL-001/002: true prefix beyond UUID take1001.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
import {
  runWithCleanup,
  drainAndClose,
  rollbackProbe,
} from "./fixture-cleanup.mjs";
import { assertScalarConflictPrefix } from "./scalar-conflict-prefix-receipt.mjs";
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
const clone = (value) => JSON.parse(JSON.stringify(value));

export async function verifyScalarConflictPrefix(
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
  let db, observer, active;
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
      const principal = (
        await observer.query(
          'SELECT current_user AS role,session_user AS "sessionUser",pg_backend_pid()::int AS pid',
        )
      ).rows[0];
      assert.equal(principal.role, "pdaa_api");
      assert.equal(principal.sessionUser, "pdaa_api");
      const f = await reserveScalarFixture(
        owner,
        setup,
        customerId,
        referenceProjectId,
        "scalar-conflict-prefix",
      );
      async function snapshot() {
        const result = {};
        for (const table of tables) {
          const predicate =
            table === "AuditEvent"
              ? "detail->>'projectId'=$2"
              : '"projectId"=$2::uuid';
          const rows = (
            await observer.query(
              `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${predicate}
           ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 5001`,
              [customerId, f.projectId],
            )
          ).rows;
          assert(
            rows.length <= 5000,
            "Scalar conflict prefix snapshot overflow",
          );
          result[table] = rows.map((r) => r.row);
        }
        return result;
      }
      const commands = [];
      async function run(name, operation, command) {
        const record = {
          name,
          operation,
          actor: f.pm,
          command: clone(command),
          correlationId: randomUUID(),
          nativeCommitAttempts: 0,
          callbackReturned: false,
        };
        let transactions = 0;
        const wrapped = new Proxy(db, {
          get(target, key) {
            if (key !== "$transaction") {
              const member = Reflect.get(target, key);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            }
            return (body, options) => {
              assert.equal(++transactions, 1);
              assert.deepEqual(options, {
                isolationLevel: "ReadCommitted",
                maxWait: 5000,
                timeout: 10000,
              });
              record.options = clone(options);
              return db.$transaction(async (tx) => {
                Object.assign(
                  record,
                  (
                    await tx.$queryRaw`
                SELECT current_user AS role,session_user AS "sessionUser",pg_backend_pid()::int AS pid`
                  )[0],
                );
                assert.equal(record.role, "pdaa_api");
                assert.equal(record.sessionUser, "pdaa_api");
                const result = await body(tx);
                record.callbackReturned = true;
                return result;
              }, options);
            };
          },
        });
        active = record;
        try {
          const repository = new DatabaseScalarReconciliationRepository(
            wrapped,
          );
          const result =
            operation === "check"
              ? await repository.check(f.pm, command, {
                  correlationId: record.correlationId,
                })
              : await repository.get(f.pm, command);
          assert.equal(transactions, 1);
          record.result = clone(result);
          commands.push(record);
          return result;
        } finally {
          active = undefined;
        }
      }
      const original = await run("original-check", "check", f.command);
      assert.equal(original.outcome, "CREATED");
      const read = { projectId: f.projectId, requestId: original.request.id };
      const baseline = await run("baseline-get", "get", read);
      const retained = await snapshot();
      assert.equal(retained.ProjectFactVersion.length, 2);
      assert.equal(retained.FactAuthorityConflict.length, 1);
      const originalProof = retained.FactAssessment.find(
        (r) => r.id === original.assessment.assessmentId,
      );
      const highestId =
        "ffffffff-ffff-4fff-bfff-" +
        randomUUID().replaceAll("-", "").slice(-12);
      const client = await owner.connect();
      let setupPrincipal;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout='10s'");
        setupPrincipal = (
          await client.query(
            'SELECT current_user AS role,session_user AS "sessionUser",pg_backend_pid()::int AS pid',
          )
        ).rows[0];
        // Owner-only setup, not a public append claim. Ordinary guards remain
        // installed; no TEMP function/grant, trigger disable or old-row rewrite.
        await client.query(
          `SELECT set_config('pdaa.conflict_fact',$1,true),set_config('pdaa.conflict_source',$2,true),
          set_config('pdaa.conflict_author',$3,true),set_config('pdaa.conflict_policy',$4,true),
          set_config('pdaa.conflict_highest',$5,true),set_config('pdaa.conflict_customer',$6,true),
          set_config('pdaa.conflict_project',$7,true)`,
          [
            f.factId,
            f.versions[0].sourceId,
            f.actor.subject,
            originalProof.policyRevisionId,
            highestId,
            customerId,
            f.projectId,
          ],
        );
        await client.query(`DO $$
      DECLARE f public."ProjectFact"; item record; eid uuid; cid uuid; n integer;
        observed timestamptz; detected timestamptz;
        fid uuid := current_setting('pdaa.conflict_fact')::uuid;
        sid uuid := current_setting('pdaa.conflict_source')::uuid;
        author text := current_setting('pdaa.conflict_author');
        policy_id uuid := current_setting('pdaa.conflict_policy')::uuid;
        highest uuid := current_setting('pdaa.conflict_highest')::uuid;
        customer_id uuid := current_setting('pdaa.conflict_customer')::uuid;
        project_id uuid := current_setting('pdaa.conflict_project')::uuid;
      BEGIN
        PERFORM 1 FROM public."Project" WHERE "customerId"=customer_id AND id=project_id FOR UPDATE;
        SELECT * INTO STRICT f FROM public."ProjectFact"
          WHERE "customerId"=customer_id AND "projectId"=project_id AND id=fid FOR UPDATE;
        IF f.revision<>2 THEN RAISE EXCEPTION 'Expected fresh two-version conflict fixture'; END IF;
        FOR n IN 3..64 LOOP
          eid:=gen_random_uuid(); observed:=date_trunc('milliseconds',clock_timestamp());
          INSERT INTO public."FactEvidence"
            (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
            VALUES(eid,customer_id,project_id,fid,sid,author,observed,'Synthetic stored conflict prefix');
          INSERT INTO public."ProjectFactVersion"
            (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,"effectiveAt","validUntil")
            VALUES(gen_random_uuid(),customer_id,project_id,fid,sid,eid,n,
              jsonb_build_object('type','date','value',(ARRAY['2026-10-01','2026-10-02','2026-10-03','2026-10-04'])[((n-1)%4)+1]),
              observed-interval '1 second',observed+interval '1 day');
        END LOOP;
        n:=1; detected:=date_trunc('milliseconds',clock_timestamp());
        FOR item IN
          SELECT l.id AS left_id,r.id AS right_id FROM public."ProjectFactVersion" l
          JOIN public."ProjectFactVersion" r
            ON (r."customerId",r."projectId",r."factId")=(l."customerId",l."projectId",l."factId")
              AND l.id<r.id AND l.value IS DISTINCT FROM r.value
          WHERE l."customerId"=customer_id AND l."projectId"=project_id AND l."factId"=fid
            AND NOT EXISTS (SELECT 1 FROM public."FactAuthorityConflict" c
              WHERE c."customerId"=customer_id AND c."projectId"=project_id AND c."factId"=fid
                AND c."leftVersionId"=l.id AND c."rightVersionId"=r.id)
          ORDER BY l.revision,r.revision LIMIT 1001
        LOOP
          n:=n+1; cid:=CASE WHEN n=1002 THEN highest ELSE gen_random_uuid() END;
          INSERT INTO public."FactAuthorityConflict"
            (id,"customerId","projectId","factId","factType","leftVersionId","rightVersionId","policyRevisionId","detectedAt",revision)
            VALUES(cid,customer_id,project_id,fid,f."factType",item.left_id,item.right_id,policy_id,detected,n);
        END LOOP;
        IF n<>1002 THEN RAISE EXCEPTION 'Fixture did not produce 1002 conflicts'; END IF;
        IF (SELECT id FROM public."FactAuthorityConflict" WHERE "customerId"=customer_id
            AND "projectId"=project_id AND "factId"=fid ORDER BY id DESC LIMIT 1)<>highest
          THEN RAISE EXCEPTION 'Highest revision must be outside the UUID sample'; END IF;
      END $$`);
        await client.query("COMMIT");
      } catch (error) {
        await rollbackProbe(client, error);
        throw error;
      } finally {
        client.release();
      }
      const before = await snapshot();
      const prefix = (
        await observer.query(
          `SELECT count(*)::int AS count,max(revision)::int AS "throughRevision"
       FROM "FactAuthorityConflict" WHERE "customerId"=$1 AND "projectId"=$2 AND "factId"=$3`,
          [customerId, f.projectId, f.factId],
        )
      ).rows[0];
      const sample = (
        await observer.query(
          `SELECT id,revision FROM "FactAuthorityConflict"
       WHERE "customerId"=$1 AND "projectId"=$2 AND "factId"=$3 ORDER BY id LIMIT 1001`,
          [customerId, f.projectId, f.factId],
        )
      ).rows;
      const overflowCommand = { ...f.command, idempotencyKey: randomUUID() };
      await run("overflow-check", "check", overflowCommand);
      await run("original-replay", "check", f.command);
      await run("original-get", "get", read);
      const after = await snapshot();
      const overflow = commands[2].result;
      const integrity = (
        await observer.query(
          `SELECT $1::uuid AS "originalRequestId",$2::uuid AS "originalProofId",
        $3::uuid AS "overflowCheckId",$4::uuid AS "overflowProofId",
        public.valid_scalar_reconciliation_request($1::uuid) AS "originalRequestValid",
        public.valid_fact_assessment($2::uuid) AS "originalProofValid",
        public.valid_scalar_reconciliation_check($3::uuid) AS "overflowCheckValid",
        public.valid_fact_assessment($4::uuid) AS "overflowProofValid"`,
          [
            original.request.id,
            original.assessment.assessmentId,
            overflow.checkId,
            overflow.assessment.assessmentId,
          ],
        )
      ).rows[0];
      const receipt = {
        family: "scalar-conflict-prefix/v1",
        customerId,
        projectId: f.projectId,
        factId: f.factId,
        actor: f.actor,
        pm: f.pm,
        command: f.command,
        observer: principal,
        setup: {
          method: "guarded-owner-append",
          principal: setupPrincipal,
          highestId,
        },
        retained,
        before,
        after,
        prefix,
        sample,
        commands,
        baseline,
        integrity,
      };
      writeFileSync(
        join(
          process.env.PDAA_ARTIFACT_DIR,
          "scalar-conflict-prefix-original.json",
        ),
        JSON.stringify(receipt, null, 2),
        { flag: "wx" },
      );
      assertScalarConflictPrefix(receipt, customerId);
      return receipt;
    },
    () =>
      drainAndClose(
        [],
        [
          () => observer?.release(),
          () => db?.$disconnect(),
          () => setup.$disconnect(),
          () => writerPool.end(),
          () => observerPool.end(),
        ],
      ),
  );
}
