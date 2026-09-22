// FR-EVD-004/012, NFR-REL-001/002: exhaustively verify the isolated restore
// without putting every retained proof into one application-deadline query.
import assert from "node:assert/strict";

const checks = [
  ["AuthorityPolicy", "public.valid_authority_history(a.id)"],
  ["FactAuthorityConflict", "public.valid_authority_conflict(a.id)"],
  [
    "FactAssessment",
    `a.sealed AND public.valid_fact_assessment(a.id) AND
      (a."captureKind" <> 'SCALAR_REQUEST' OR EXISTS (
        SELECT 1 FROM public."ScalarReconciliationCheck" c
        WHERE c.id=a."scalarReconciliationCheckId" AND c."assessmentId"=a.id
          AND c."customerId"=a."customerId" AND c."projectId"=a."projectId"
          AND c."factId"=a."factId"))`,
  ],
  ["Programme", "public.valid_canonical_programme(a.id)"],
  ["CanonicalProject", "a.sealed AND public.valid_canonical_project(a.id)"],
  [
    "CanonicalStateBinding",
    "a.sealed AND public.valid_canonical_state_binding(a.id)",
  ],
  [
    "MilestoneConsistencyAssessment",
    `a.sealed AND public.valid_milestone_consistency_assessment(a.id) AND
      (a."reconciliationCheckId" IS NULL OR EXISTS (
        SELECT 1 FROM public."MilestoneReconciliationCheck" c
        WHERE c.id=a."reconciliationCheckId" AND c."assessmentId"=a.id
          AND c."customerId"=a."customerId" AND c."projectId"=a."projectId"))`,
  ],
  [
    "MilestoneReconciliationRequest",
    "a.sealed AND public.valid_milestone_reconciliation_request(a.id)",
  ],
  [
    "MilestoneReconciliationCheck",
    "public.valid_milestone_reconciliation_check(a.id)",
  ],
  [
    "MilestoneReconciliationAssignment",
    "public.valid_milestone_reconciliation_assignment(a.id)",
  ],
  [
    "ScalarReconciliationRequest",
    "a.sealed AND public.valid_scalar_reconciliation_request(a.id)",
  ],
  [
    "ScalarReconciliationCheck",
    "public.valid_scalar_reconciliation_check(a.id)",
  ],
  [
    "ScalarReconciliationAssignment",
    "public.valid_scalar_reconciliation_assignment(a.id)",
  ],
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function verifyRestoredProofIntegrity(database) {
  const counts = {};
  // The restore is isolated: no application is started against it. Counts and
  // strict keyset progress additionally reject incomplete or duplicated pages.
  // Do not wrap the complete history in a new ten-second interactive transaction.
  for (const [table, predicate] of checks) {
    const countRows = await database.$queryRawUnsafe(
      `SELECT count(*)::int AS count FROM public."${table}"`,
    );
    assert.equal(countRows.length, 1);
    const expected = countRows[0].count;
    assert(Number.isSafeInteger(expected) && expected >= 0);
    const pageSize = table === "FactAuthorityConflict" ? 32 : 1;
    let cursor = null;
    let checked = 0;
    while (true) {
      const rows = await database.$queryRawUnsafe(
        `WITH page AS MATERIALIZED (
          SELECT * FROM public."${table}"
          WHERE ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id LIMIT $2::int
        ) SELECT a.id::text AS id, (${predicate}) AS valid
          FROM page a ORDER BY a.id`,
        cursor,
        pageSize,
      );
      assert(Array.isArray(rows) && rows.length <= pageSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        assert(typeof row.id === "string" && uuid.test(row.id));
        assert(
          cursor === null || row.id > cursor,
          "Restore page did not advance",
        );
        assert.equal(
          row.valid,
          true,
          "Restored " + table + " proof is invalid",
        );
        cursor = row.id;
        checked += 1;
        assert(
          checked <= expected,
          "Restore family changed during verification",
        );
      }
    }
    assert.equal(
      checked,
      expected,
      "Incomplete restored " + table + " verification",
    );
    counts[table] = checked;
  }
  const drift = await database.$queryRawUnsafe(`SELECT count(*)::int AS invalid
    FROM (SELECT "factId" FROM public."FactAuthorityConflict"
      GROUP BY "factId" HAVING count(*)<>max(revision)) drift`);
  assert.equal(drift.length, 1);
  assert.equal(
    drift[0].invalid,
    0,
    "Restored conflict history has revision gaps",
  );
  return counts;
}
