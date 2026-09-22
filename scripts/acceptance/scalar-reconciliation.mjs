// FR-EVD-007/012, NFR-SEC-001/REL-001: scalar family recovery and role inventory.
import assert from "node:assert/strict";
import { reconciliationAcceptanceGuard } from "./milestone-reconciliation.mjs";
import { verifyImmutableHistoryMutation } from "./immutable-history.mjs";
import { Pool } from "./common.mjs";

export const scalarReconciliationTables = [
  "ScalarReconciliationRequest",
  "ScalarReconciliationCheck",
  "ScalarReconciliationAssignment",
];
const scalarFunctions = [
  "scalar_reconciliation_identity(uuid)",
  "valid_scalar_reconciliation_assignment(uuid)",
  "valid_scalar_reconciliation_request(uuid)",
  "valid_scalar_reconciliation_check(uuid)",
  "guard_scalar_reconciliation_request()",
  "guard_scalar_reconciliation_check()",
  "guard_scalar_reconciliation_assignment()",
  "require_scalar_reconciliation_complete()",
];

export async function scalarReconciliationProjection(pool) {
  reconciliationAcceptanceGuard();
  const result = {};
  for (const table of scalarReconciliationTables) {
    result[table] = (
      await pool.query(
        `SELECT * FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
  }
  return result;
}

export async function verifyScalarReconciliationPrivileges(owner) {
  reconciliationAcceptanceGuard();
  for (const table of scalarReconciliationTables) {
    const identifier = '"' + table + '"';
    assert.equal(
      (
        await owner.query(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass",
          [identifier],
        )
      ).rows[0].owner,
      "pdaa_migrate",
    );
    const columns = (
      await owner.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [table],
      )
    ).rows;
    assert(columns.length > 0);
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"]) {
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ]) {
        const allowed =
          (role === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege)) ||
          (role === "pdaa_backup" && privilege === "SELECT");
        for (const grantOption of [false, true]) {
          assert.equal(
            (
              await owner.query(
                "SELECT has_table_privilege($1,$2,$3) AS allowed",
                [
                  role,
                  identifier,
                  privilege + (grantOption ? " WITH GRANT OPTION" : ""),
                ],
              )
            ).rows[0].allowed,
            grantOption ? false : allowed,
            `${role}/${table}/${privilege}`,
          );
        }
      }
      for (const { column_name: column } of columns) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          const allowed =
            (role === "pdaa_api" &&
              (["SELECT", "INSERT"].includes(privilege) ||
                (table === "ScalarReconciliationRequest" &&
                  column === "sealed" &&
                  privilege === "UPDATE"))) ||
            (role === "pdaa_backup" && privilege === "SELECT");
          for (const grantOption of [false, true]) {
            assert.equal(
              (
                await owner.query(
                  "SELECT has_column_privilege($1,$2,$3,$4) AS allowed",
                  [
                    role,
                    identifier,
                    column,
                    privilege + (grantOption ? " WITH GRANT OPTION" : ""),
                  ],
                )
              ).rows[0].allowed,
              grantOption ? false : allowed,
              `${role}/${table}/${column}/${privilege}`,
            );
          }
        }
      }
    }
  }
  for (const [index, signature] of scalarFunctions.entries()) {
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"]) {
      for (const grantOption of [false, true]) {
        assert.equal(
          (
            await owner.query(
              "SELECT has_function_privilege($1,$2,$3) AS allowed",
              [
                role,
                "public." + signature,
                "EXECUTE" + (grantOption ? " WITH GRANT OPTION" : ""),
              ],
            )
          ).rows[0].allowed,
          !grantOption && role === "pdaa_api" && index < 4,
          `${role}/${signature}`,
        );
      }
    }
  }
  return true;
}

export async function verifyScalarReconciliationIntegrity(pool) {
  reconciliationAcceptanceGuard();
  const result = await pool.query(`SELECT
    (SELECT count(*) FROM "ScalarReconciliationRequest" WHERE NOT sealed OR public.valid_scalar_reconciliation_request(id) IS NOT TRUE) +
    (SELECT count(*) FROM "ScalarReconciliationCheck" WHERE public.valid_scalar_reconciliation_check(id) IS NOT TRUE) +
    (SELECT count(*) FROM "ScalarReconciliationAssignment" WHERE public.valid_scalar_reconciliation_assignment(id) IS NOT TRUE) +
    (SELECT count(*) FROM "FactAssessment" a WHERE a."captureKind"='SCALAR_REQUEST' AND NOT EXISTS
      (SELECT 1 FROM "ScalarReconciliationCheck" c WHERE c.id=a."scalarReconciliationCheckId" AND c."assessmentId"=a.id
        AND c."customerId"=a."customerId" AND c."projectId"=a."projectId" AND c."factId"=a."factId")) AS invalid`);
  assert.equal(result.rows.length, 1);
  assert([0, "0"].includes(result.rows[0].invalid));
  return true;
}

export async function verifyScalarReconciliationImmutable(database) {
  reconciliationAcceptanceGuard();
  for (const table of scalarReconciliationTables)
    for (const operation of ["UPDATE", "DELETE", "TRUNCATE"])
      await verifyImmutableHistoryMutation(database, table, operation);
  return true;
}

export async function verifyScalarReconciliationWorkerDenials(connection) {
  reconciliationAcceptanceGuard();
  const pool = new Pool({
    ...connection,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  try {
    assert.equal(
      (await pool.query("SELECT current_user AS role")).rows[0].role,
      "pdaa_worker",
    );
    for (const table of scalarReconciliationTables)
      await assert.rejects(
        () => pool.query(`SELECT * FROM "${table}" LIMIT 1`),
        (error) => error.code === "42501",
      );
    return true;
  } finally {
    await pool.end();
  }
}
