// FR-CON-006/007/012 / NFR-SEC-001: finite applied CSV storage boundary.
import assert from "node:assert/strict";
export const csvComparisonFunctions = Object.freeze([
  "valid_ingestion_csv_state(uuid,uuid,integer,jsonb,jsonb)",
  "ingestion_csv_state_text(uuid,uuid,integer,jsonb,jsonb)",
  "valid_ingestion_csv_context(uuid)",
  "valid_ingestion_csv_head(uuid,uuid)",
  "guard_ingestion_csv_head()",
  "initialize_ingestion_csv_head()",
  "guard_ingestion_csv_context()",
  "require_ingestion_csv_complete()",
  "guard_ingestion_receipt()",
  "guard_ingestion_reviewed_import()",
  "require_ingestion_receipt_complete()",
]);
export const csvComparisonApiFunctions = Object.freeze(csvComparisonFunctions.slice(0,4));
const tables = ["IngestionCsvHead","IngestionCsvContext"];
const controls = new Set(["revision","currentReceiptId","stateHash","canonicalHistoryBytes"]);

export async function verifyCsvComparisonPrivileges(pool, roles = ["pdaa_api","pdaa_worker","pdaa_backup"], { owner } = {}) {
  const functions = (await pool.query(`SELECT p.oid::text AS id,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p WHERE p.oid=ANY(SELECT to_regprocedure(name) FROM unnest($1::text[]) signatures(name))`,
    [csvComparisonFunctions.map((name) => "public."+name)])).rows;
  assert.equal(functions.length,csvComparisonFunctions.length,"Missing applied CSV function");
  for (const row of functions) {
    assert.equal(row.prosecdef,false); assert.equal(row.public_execute,false);
    assert.deepEqual(row.proconfig?.map((value) => value.replaceAll(" ","")),["search_path=pg_catalog,public"]);
    if (owner !== undefined) assert.equal(row.owner,owner);
  }
  for (const name of csvComparisonFunctions) {
    for (const role of roles) {
      const expected = role === "pdaa_api" && csvComparisonApiFunctions.includes(name);
      const row = (await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed,has_function_privilege($1,$2,'EXECUTE WITH GRANT OPTION') AS grantable",
        [role,"public."+name])).rows[0];
      assert.deepEqual(row,{allowed:expected,grantable:false},role+"/"+name);
    }
  }
  for (const table of tables) {
    const relation = 'public."'+table+'"';
    const metadata = (await pool.query(`SELECT pg_get_userbyid(c.relowner) AS owner,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access
      FROM pg_class c WHERE c.oid=$1::regclass`,[relation])).rows[0];
    assert(metadata); assert.equal(metadata.public_access,false);
    const publicColumns=(await pool.query(`SELECT count(*)::int AS n FROM pg_attribute att
      CROSS JOIN LATERAL aclexplode(att.attacl) acl WHERE att.attrelid=$1::regclass AND att.attnum>0
        AND NOT att.attisdropped AND acl.grantee=0`,[relation])).rows[0].n;
    assert.equal(publicColumns,0);
    if (owner !== undefined) assert.equal(metadata.owner,owner);
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows;
    assert(columns.length > 0);
    for (const role of roles) {
      for (const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER","MAINTAIN"]) {
        const expected = role === "pdaa_api" && ["SELECT","INSERT"].includes(privilege) || role === "pdaa_backup" && privilege === "SELECT";
        const row = (await pool.query("SELECT has_table_privilege($1,$2,$3) AS allowed,has_table_privilege($1,$2,$3||' WITH GRANT OPTION') AS grantable",[role,relation,privilege])).rows[0];
        assert.deepEqual(row,{allowed:expected,grantable:false},role+"/"+table+"/"+privilege);
      }
      for (const {column_name} of columns) for (const privilege of ["SELECT","INSERT","UPDATE","REFERENCES"]) {
        const expected=role === "pdaa_api" && (["SELECT","INSERT"].includes(privilege) ||
          privilege === "UPDATE" && table === "IngestionCsvHead" && controls.has(column_name)) || role === "pdaa_backup" && privilege === "SELECT";
        const row = (await pool.query("SELECT has_column_privilege($1,$2,$3,$4) AS allowed,has_column_privilege($1,$2,$3,$4||' WITH GRANT OPTION') AS grantable",[role,relation,column_name,privilege])).rows[0];
        assert.deepEqual(row,{allowed:expected,grantable:false},role+"/"+table+"/"+privilege+"/"+column_name);
      }
    }
  }
  return { tables,apiValidators:4,privateGuards:7,workerDenied:true,backupSelectOnly:true,headUpdateColumns:[...controls],publicDenied:true };
}
