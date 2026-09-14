// FR-EVD-007/009/012, FR-ADM-005: native typed identity and policy selection vectors.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseScalarReconciliationRepository,
} from "../../packages/data/dist/index.js";
import { scalarReconciliationIdentity } from "../../packages/domain/dist/index.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import { assertScalarIdentityVectors } from "./scalar-identity-vectors-receipt.mjs";

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
  "AuthorityPolicyRevision",
  "FactSourceAccess",
];
const inputs = [
  [
    { type: "date", value: "2026-10-01" },
    { type: "date", value: "2026-10-02" },
  ],
  [
    { type: "number", value: 1e-100 },
    { type: "number", value: 1e100 },
  ],
  [
    { type: "boolean", value: false },
    { type: "boolean", value: true },
  ],
  [
    { type: "text", value: '非ASCII "quotes" \\ \n🚀' },
    { type: "text", value: "Distinct synthetic value" },
  ],
];
export async function verifyScalarIdentityVectors(
  owner,
  connection,
  customerId,
  referenceProjectId,
) {
  reconciliationAcceptanceGuard();
  assert.equal(connection.user, "pdaa_api");
  const db = createDatabase(connection);
  try {
    const receipt = {
      family: "scalar-identity-vectors/v1",
      customerId,
      cases: [],
    };
    for (const values of inputs) {
      const f = await reserveScalarFixture(
        owner,
        db,
        customerId,
        referenceProjectId,
        "scalar-identity-" + values[0].type,
        { values },
      );
      const snapshot = async () => {
        const result = {};
        for (const table of tables) {
          result[table] = (
            await db.$queryRawUnsafe(
              `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${table === "AuditEvent" ? "detail->>'projectId'=$2" : '"projectId"=$2::uuid'} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 101`,
              customerId,
              f.projectId,
            )
          ).map((r) => r.row);
          assert(result[table].length < 101);
        }
        return result;
      };
      const c = {
        name: values[0].type,
        values,
        actor: f.actor,
        pm: f.pm,
        projectId: f.projectId,
        factId: f.factId,
        steps: [],
        before: await snapshot(),
      };
      for (const [index, name] of [
        "created",
        "recorded-reuse",
        "future-policy-reuse",
        "selected-policy-created",
      ].entries()) {
        if (index >= 2) {
          const originalPolicy = c.before.AuthorityPolicyRevision[0];
          await new DatabaseAuthorityRepository(db).appendPolicy(
            f.actor,
            {
              projectId: f.projectId,
              factType: f.factType,
              expectedRevision: index - 1,
              idempotencyKey: randomUUID(),
              effectiveAt: new Date(
                Date.now() + (index === 2 ? 86400000 : -1000),
              ).toISOString(),
              definition: originalPolicy.definition,
            },
            { correlationId: "scalar-identity-policy-" + randomUUID() },
          );
        }
        const step = {
          name,
          actor: index === 1 ? f.pm : f.actor,
          command: { ...f.command, idempotencyKey: randomUUID() },
          context: { correlationId: "scalar-identity-check-" + randomUUID() },
          before: await snapshot(),
        };
        const wrapped = {
          auditEvent: db.auditEvent,
          $transaction: (callback, options) => {
            assert.equal(step.options, undefined);
            step.options = options;
            return db.$transaction(async (tx) => {
              step.principal = (
                await tx.$queryRaw`SELECT current_user AS role, session_user AS login, pg_backend_pid() AS pid`
              )[0];
              const result = await callback(tx);
              step.callbackReturned = true;
              return result;
            }, options);
          },
        };
        step.result = await new DatabaseScalarReconciliationRepository(
          wrapped,
        ).check(step.actor, step.command, step.context);
        step.settled = true;
        step.tsIdentity = scalarReconciliationIdentity(
          step.result.assessment.result,
        );
        step.sql = (
          await db.$queryRaw`SELECT public.scalar_reconciliation_identity(${step.result.assessment.assessmentId}::uuid) AS identity, public.valid_fact_assessment(${step.result.assessment.assessmentId}::uuid) AS "proofValid", public.valid_scalar_reconciliation_check(${step.result.checkId}::uuid) AS "checkValid", public.valid_scalar_reconciliation_request(${step.result.request.id}::uuid) AS "requestValid"`
        )[0];
        step.after = await snapshot();
        c.steps.push(step);
      }
      const repository = new DatabaseScalarReconciliationRepository(db);
      const first = c.steps[0];
      c.original = await repository.get(f.pm, {
        projectId: f.projectId,
        requestId: first.result.request.id,
      });
      c.replay = await repository.check(
        first.actor,
        first.command,
        first.context,
      );
      c.afterReplay = await snapshot();
      receipt.cases.push(c);
    }
    const serialized = JSON.parse(JSON.stringify(receipt));
    // Preserve original evidence even when the independent reader rejects it.
    writeFileSync(
      join(
        process.env.PDAA_ARTIFACT_DIR,
        "scalar-identity-vectors-original.json",
      ),
      JSON.stringify(serialized, null, 2),
      { flag: "wx" },
    );
    assertScalarIdentityVectors(serialized, customerId);
    return serialized;
  } finally {
    await db.$disconnect();
  }
}
