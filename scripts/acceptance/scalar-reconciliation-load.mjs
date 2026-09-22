// FR-EVD-012, NFR-REL-001: complete scalar prefix at the real production deadline.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureScalarLoad } from "./scalar-load-diagnostics.mjs";
import {
  createDatabase,
  DatabaseScalarReconciliationRepository,
  DatabaseProjectFactRepository,
} from "../../packages/data/dist/index.js";
import { scalarReconciliationIdentity } from "../../packages/domain/dist/index.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";

export async function verifyScalarVersionBoundary(
  owner,
  connection,
  customerId,
  referenceProjectId,
) {
  reconciliationAcceptanceGuard();
  assert.equal(connection.user, "pdaa_api");
  const db = createDatabase(connection);
  try {
    assert.equal(
      (await db.$queryRaw`SELECT current_user AS role`)[0].role,
      "pdaa_api",
    );
    const f = await reserveScalarFixture(
      owner,
      db,
      customerId,
      referenceProjectId,
      "scalar-version-boundary",
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='10s'");
      // Setup uses the fixture owner, but every immutable append still passes the
      // installed guards and advances ProjectFact through its normal trigger.
      await client.query(
        "SELECT set_config('pdaa.fixture_fact',$1,true),set_config('pdaa.fixture_source',$2,true),set_config('pdaa.fixture_author',$3,true)",
        [f.factId, f.versions[0].sourceId, f.actor.subject],
      );
      await client.query(`DO $$
        DECLARE f public."ProjectFact"; eid uuid; n integer;
          fid uuid := current_setting('pdaa.fixture_fact')::uuid;
          sid uuid := current_setting('pdaa.fixture_source')::uuid;
          author text := current_setting('pdaa.fixture_author');
        BEGIN
          SELECT * INTO STRICT f FROM public."ProjectFact" WHERE id=fid FOR UPDATE;
          FOR n IN 3..1000 LOOP
            eid := gen_random_uuid();
            INSERT INTO public."FactEvidence" (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
              VALUES(eid,f."customerId",f."projectId",fid,sid,author,date_trunc('milliseconds',clock_timestamp()),'Synthetic bounded scalar evidence');
            INSERT INTO public."ProjectFactVersion" (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,"effectiveAt","validUntil")
              VALUES(gen_random_uuid(),f."customerId",f."projectId",fid,sid,eid,n,'{"type":"date","value":"2026-10-01"}'::jsonb,'2026-09-01'::timestamptz,'2027-09-01'::timestamptz);
          END LOOP;
        END $$`);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Scalar load setup and rollback failed",
          { cause: cleanupError },
        );
      }
      throw error;
    } finally {
      client.release();
    }
    const repository = new DatabaseScalarReconciliationRepository(db);
    const { value: complete, measurement } = await measureScalarLoad(
      () => repository.check(f.actor, f.command, f.context),
      (timing) =>
        writeFileSync(
          join(process.env.PDAA_ARTIFACT_DIR, `scalar-load-${f.factId}.json`),
          JSON.stringify(
            {
              runId: process.env.PDAA_ACCEPTANCE_RUN_ID,
              customerId,
              projectId: f.projectId,
              factId: f.factId,
              correlationId: f.context.correlationId,
              measurement: timing,
            },
            null,
            2,
          ),
          { flag: "wx" },
        ),
    );
    const durationMs = measurement.durationMs;
    assert.equal(complete.outcome, "CREATED");
    assert.equal(complete.assessment.visibility, "available");
    assert.equal(complete.assessment.result.complete, true);
    assert.equal(complete.assessment.result.status, "CONFLICTING");
    assert.equal(complete.assessment.result.versions.length, 1000);
    const completeHeader = await db.factAssessment.findUniqueOrThrow({
      where: { id: complete.assessment.assessmentId },
    });
    assert.equal(completeHeader.factRevision, 1000);
    assert.equal(completeHeader.versionCount, 1000);
    assert.equal(completeHeader.scalarReconciliationCheckId, complete.checkId);
    assert.equal(completeHeader.sealed, true);
    const originalConflicts = await db.factAuthorityConflict.findMany({
      where: { customerId, projectId: f.projectId },
      orderBy: { id: "asc" },
    });
    const identity = scalarReconciliationIdentity(complete.assessment.result);
    assert(identity);
    const sql = (
      await db.$queryRaw`SELECT public.scalar_reconciliation_identity(${complete.assessment.assessmentId}::uuid) AS identity`
    )[0].identity;
    assert.equal(sql, identity);
    await new DatabaseProjectFactRepository(db).appendHumanStatement(
      f.actor,
      {
        projectId: f.projectId,
        factType: f.factType,
        expectedRevision: 1000,
        idempotencyKey: randomUUID(),
        value: { type: "date", value: "2026-10-01" },
        effectiveAt: new Date(Date.now() - 1000).toISOString(),
        validUntil: "2027-09-01T00:00:00.000Z",
        originalStatement: "Synthetic scalar version 1001",
      },
      f.context,
    );
    const overflow = await repository.check(
      f.actor,
      { ...f.command, idempotencyKey: randomUUID() },
      f.context,
    );
    assert.equal(overflow.outcome, "NO_REQUEST");
    assert.equal(overflow.request, null);
    assert.equal(overflow.assessment.visibility, "available");
    assert.equal(overflow.assessment.result.status, "INCOMPLETE");
    assert.equal(overflow.assessment.result.complete, false);
    assert.equal(overflow.assessment.result.versions.length, 0);
    const requests = await db.scalarReconciliationRequest.findMany({
      where: { customerId, projectId: f.projectId },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, complete.request.id);
    assert.equal(requests[0].state, "OPEN");
    const checks = await db.scalarReconciliationCheck.findMany({
      where: { customerId, projectId: f.projectId },
    });
    assert.equal(checks.length, 2);
    assert.equal(
      checks.find((c) => c.id === overflow.checkId).assessmentId,
      overflow.assessment.assessmentId,
    );
    const owned = await db.factAssessment.findUniqueOrThrow({
      where: { id: overflow.assessment.assessmentId },
    });
    assert.equal(owned.scalarReconciliationCheckId, overflow.checkId);
    assert.equal(owned.sealed, true);
    assert.equal(owned.factRevision, 1001);
    assert.equal(owned.versionCount, 0);
    assert.equal(owned.conflictCount, 0);
    assert.deepEqual(
      await db.factAuthorityConflict.findMany({
        where: { customerId, projectId: f.projectId },
        orderBy: { id: "asc" },
      }),
      originalConflicts,
    );
    assert.equal(
      await db.scalarReconciliationAssignment.count({
        where: { customerId, projectId: f.projectId },
      }),
      1,
    );
    assert.equal(
      await db.factAssessmentVersion.count({
        where: { assessmentId: owned.id },
      }),
      0,
    );
    assert.equal(
      await db.factAssessmentConflict.count({
        where: { assessmentId: owned.id },
      }),
      0,
    );
    const replay = await repository.check(f.actor, f.command, f.context);
    assert.equal(replay.checkId, complete.checkId);
    assert.equal(
      replay.assessment.assessmentId,
      complete.assessment.assessmentId,
    );
    assert.deepEqual(replay.assessment.result, complete.assessment.result);
    return {
      family: "scalar-version-boundary/v1",
      runtimeRole: "pdaa_api",
      customerId,
      projectId: f.projectId,
      factId: f.factId,
      durationMs,
      measurement,
      completeVersionCount: 1000,
      incompletePrefix: 1001,
      originalCheckId: complete.checkId,
      originalRequestId: complete.request.id,
      originalAssessmentId: complete.assessment.assessmentId,
      overflowCheckId: overflow.checkId,
      overflowAssessmentId: owned.id,
      exactSqlIdentity: true,
      ownedNegativeCheck: true,
      originalOpenRequestPreserved: true,
      originalReplayPreserved: true,
    };
  } finally {
    await db.$disconnect();
  }
}
