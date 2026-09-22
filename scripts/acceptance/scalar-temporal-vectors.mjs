// FR-EVD-004/006/007/012: native stale and policy-recording boundary coverage.
// Boundary publication is explicitly synthetic; the real server clock/result
// and public scalar command are never replaced or given a caller timestamp.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseProjectFactRepository,
  DatabaseScalarReconciliationRepository,
} from "../../packages/data/dist/index.js";
import { scalarReconciliationIdentity } from "../../packages/domain/dist/index.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import { assertScalarTemporalVectors } from "./scalar-temporal-vectors-receipt.mjs";
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
  "AuthorityPolicy",
  "AuthorityPolicyReceipt",
];
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clockQuery = "SELECT date_trunc('milliseconds',clock_timestamp()) AS now";
export async function verifyScalarTemporalVectors(
  owner,
  connection,
  customerId,
  referenceProjectId,
) {
  reconciliationAcceptanceGuard();
  assert.equal(connection.user, "pdaa_api");
  const db = createDatabase(connection);
  const authority = new DatabaseAuthorityRepository(db),
    facts = new DatabaseProjectFactRepository(db),
    repository = new DatabaseScalarReconciliationRepository(db);
  const receipt = {
    family: "scalar-temporal-vectors/v1",
    customerId,
    cases: [],
  };
  try {
    let retained;
    for (const name of [
      "recorded-stale",
      "recorded-superseded",
      "higher-stale-contradiction",
      "higher-stale-agreement",
      "recorded-at-equal",
      "recorded-at-after",
    ]) {
      const boundary = name.startsWith("recorded-at-");
      const f =
        name === "recorded-superseded"
          ? retained
          : await reserveScalarFixture(
              owner,
              db,
              customerId,
              referenceProjectId,
              "scalar-temporal",
              {
                optedIn: !boundary,
                ...(name === "higher-stale-agreement"
                  ? {
                      values: [
                        { type: "date", value: "2026-10-01" },
                        { type: "date", value: "2026-10-01" },
                      ],
                    }
                  : {}),
              },
            );
      if (name === "recorded-stale") retained = f;
      const snapshot = async () => {
        const graph = {};
        for (const table of tables) {
          graph[table] = (
            await db.$queryRawUnsafe(
              `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "customerId"=$1::uuid AND ${table === "AuditEvent" ? "detail->>'projectId'=$2" : '"projectId"=$2::uuid'} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 101`,
              customerId,
              f.projectId,
            )
          ).map((r) => r.row);
          assert(graph[table].length < 101);
        }
        return graph;
      };
      const setupBefore = await snapshot();
      const previousPolicy = setupBefore.AuthorityPolicyRevision.find(
        (r) => r.revision === 1,
      );
      if (name === "recorded-stale")
        await authority.captureAssessment(
          f.actor,
          {
            projectId: f.projectId,
            factType: f.factType,
            idempotencyKey: randomUUID(),
          },
          f.context,
        );
      if (name === "recorded-superseded") {
        for (const [index, actor] of [f.actor, f.pm].entries()) {
          const added = await facts.appendHumanStatement(
            actor,
            {
              projectId: f.projectId,
              factType: f.factType,
              expectedRevision: 2 + index,
              idempotencyKey: randomUUID(),
              effectiveAt: new Date(
                Date.parse(previousPolicy.effectiveAt) + 2,
              ).toISOString(),
              validUntil: new Date(Date.now() + 86400000).toISOString(),
              originalStatement: "Synthetic agreeing later scalar head",
              value: { type: "date", value: "2026-10-01" },
            },
            f.context,
          );
          assert.equal(added.entry.sourceId, f.versions[index].sourceId);
        }
      } else if (!boundary) {
        const higher = name.startsWith("higher-");
        await authority.appendPolicy(
          f.actor,
          {
            projectId: f.projectId,
            factType: f.factType,
            expectedRevision: 1,
            idempotencyKey: randomUUID(),
            effectiveAt: new Date(previousPolicy.effectiveAt).toISOString(),
            definition: {
              conflictBehavior: "REQUEST_RECONCILIATION",
              tiers: (higher ? f.versions : [null]).map((version, index) => ({
                selectors: [
                  {
                    sourceType: "human_statement",
                    instanceId: version?.sourceId ?? null,
                    requiredApproval: "NOT_REQUIRED",
                    validity:
                      higher && index === 1
                        ? null
                        : { basis: "effectiveAt", durationMs: 1 },
                  },
                ],
              })),
            },
          },
          f.context,
        );
      }
      const c = {
        name,
        actor: name === "recorded-superseded" ? f.pm : f.actor,
        pm: f.pm,
        projectId: f.projectId,
        factId: f.factId,
        command: { ...f.command, idempotencyKey: randomUUID() },
        context: { correlationId: "scalar-temporal-check-" + randomUUID() },
        setupBefore,
        before: await snapshot(),
        publication: null,
      };
      const wrapped = {
        auditEvent: db.auditEvent,
        $transaction: (callback, options) => {
          assert.equal(c.options, undefined);
          c.options = options;
          return db.$transaction(async (raw) => {
            c.principal = (
              await raw.$queryRaw`SELECT current_user AS role, session_user AS login, pg_backend_pid() AS pid`
            )[0];
            let clockCalls = 0;
            const tx = new Proxy(raw, {
              get(target, key) {
                if (boundary && key === "$queryRaw")
                  return async (...args) => {
                    const rows = await target.$queryRaw(...args);
                    if (
                      args.length === 1 &&
                      Array.isArray(args[0]) &&
                      args[0].length === 1 &&
                      args[0][0] === clockQuery
                    ) {
                      assert.equal(++clockCalls, 1);
                      assert.equal(rows.length, 1);
                      const time = rows[0].now;
                      assert(
                        time instanceof Date && Number.isFinite(time.getTime()),
                      );
                      const offsetMs = name === "recorded-at-equal" ? 0 : 1;
                      assert(
                        Date.parse(previousPolicy.recordedAt) <= time.getTime(),
                      );
                      assert(
                        Date.parse(previousPolicy.effectiveAt) < time.getTime(),
                      );
                      const input = {
                        projectId: f.projectId,
                        factType: f.factType,
                        expectedRevision: 1,
                        effectiveAt: new Date(
                          previousPolicy.effectiveAt,
                        ).toISOString(),
                        definition: {
                          ...previousPolicy.definition,
                          conflictBehavior: "REQUEST_RECONCILIATION",
                        },
                      };
                      const event = await raw.authorityPolicyRevision.create({
                        data: {
                          id: randomUUID(),
                          customerId,
                          projectId: f.projectId,
                          factType: f.factType,
                          policyId: previousPolicy.policyId,
                          revision: 2,
                          recordedAt: new Date(time.getTime() + offsetMs),
                          recordedBy: f.actor.subject,
                          effectiveAt: new Date(input.effectiveAt),
                          state: "ENABLED",
                          definition: input.definition,
                        },
                      });
                      const publicationReceipt =
                        await raw.authorityPolicyReceipt.create({
                          data: {
                            id: randomUUID(),
                            customerId,
                            projectId: f.projectId,
                            factType: f.factType,
                            subject: f.actor.subject,
                            idempotencyKey: randomUUID(),
                            requestHash: hash(input),
                            revisionId: event.id,
                          },
                        });
                      const audit = await raw.auditEvent.create({
                        data: {
                          customerId,
                          actor: f.actor.subject,
                          event: "authority.policy.appended",
                          correlationId:
                            "scalar-temporal-publication-" + randomUUID(),
                          detail: {
                            projectId: f.projectId,
                            policyId: event.policyId,
                            revisionId: event.id,
                            revision: 2,
                          },
                        },
                      });
                      c.publication = {
                        kind: "synthetic-same-transaction-publication",
                        clockCalls,
                        serverTime: time.toISOString(),
                        offsetMs,
                        input,
                        revisionId: event.id,
                        receiptId: publicationReceipt.id,
                        auditId: audit.id,
                      };
                    }
                    return rows; // Actual returned server result is never changed.
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            const result = await callback(tx);
            if (boundary) assert.equal(clockCalls, 1);
            c.callbackReturned = true;
            return result;
          }, options);
        },
      };
      c.result = await new DatabaseScalarReconciliationRepository(
        wrapped,
      ).check(c.actor, c.command, c.context);
      c.settled = true;
      c.tsIdentity = scalarReconciliationIdentity(c.result.assessment.result);
      c.sql = (
        await db.$queryRaw`SELECT public.scalar_reconciliation_identity(${c.result.assessment.assessmentId}::uuid) AS identity, public.valid_fact_assessment(${c.result.assessment.assessmentId}::uuid) AS "proofValid", public.valid_scalar_reconciliation_check(${c.result.checkId}::uuid) AS "checkValid"`
      )[0];
      c.after = await snapshot();
      c.original = c.result.request
        ? await repository.get(f.pm, {
            projectId: f.projectId,
            requestId: c.result.request.id,
          })
        : null;
      c.replay = await repository.check(c.actor, c.command, c.context);
      c.afterReplay = await snapshot();
      receipt.cases.push(c);
    }
    const serialized = JSON.parse(JSON.stringify(receipt));
    writeFileSync(
      join(
        process.env.PDAA_ARTIFACT_DIR,
        "scalar-temporal-vectors-original.json",
      ),
      JSON.stringify(serialized, null, 2),
      { flag: "wx" },
    );
    assertScalarTemporalVectors(serialized, customerId);
    return serialized;
  } finally {
    await db.$disconnect();
  }
}
