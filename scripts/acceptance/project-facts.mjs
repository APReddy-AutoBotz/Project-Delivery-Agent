// Synthetic acceptance fixtures only. Never called by product provisioning.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "./common.mjs";
import {
  createDatabase,
  DatabaseProjectFactRepository,
} from "../../packages/data/dist/index.js";
export const projectFactTables = [
  "ProjectFact",
  "FactSource",
  "FactSourceAccess",
  "FactSourceReader",
  "FactEvidence",
  "ProjectFactVersion",
  "FactAppendReceipt",
];
function guard() {
  assert(
    ["isolated", "customer-composition"].includes(process.env.PDAA_ACCEPTANCE),
  );
  assert.match(
    process.env.PDAA_ACCEPTANCE_RUN_ID,
    /^pdaa-acceptance-\d+-[a-f0-9]{8}$/,
  );
}
export async function projectFactProjection(pool) {
  const result = {};
  for (const table of projectFactTables)
    result[table] = (
      await pool.query(
        `SELECT * FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
  // Live worker time is checked separately with before/restore/after bounds.
  result.stableHeartbeats = (
    await pool.query(
      'SELECT * FROM "ServiceHeartbeat" WHERE id <> $1 ORDER BY id',
      ["worker"],
    )
  ).rows;
  return result;
}
export async function workerCheckpoint(pool) {
  const rows = (
    await pool.query(
      'SELECT id,"occurredAt" FROM "ServiceHeartbeat" WHERE id=$1',
      ["worker"],
    )
  ).rows;
  assert.equal(rows.length, 1);
  return { id: rows[0].id, occurredAt: rows[0].occurredAt.toISOString() };
}
export async function verifyRestoredWorker(source, restored, before) {
  const restoredRow = await workerCheckpoint(restored),
    after = await workerCheckpoint(source);
  assert.equal(before.id, "worker");
  assert.equal(restoredRow.id, before.id);
  assert(Date.parse(restoredRow.occurredAt) >= Date.parse(before.occurredAt));
  assert(Date.parse(restoredRow.occurredAt) <= Date.parse(after.occurredAt));
  return { before, restored: restoredRow, after, status: "passed" };
}
export async function verifyProjectFactPrivileges(pool) {
  guard();
  for (const table of projectFactTables) {
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"]) {
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        const allowed = (
          await pool.query("SELECT has_table_privilege($1,$2,$3) AS allowed", [
            role,
            '"' + table + '"',
            privilege,
          ])
        ).rows[0].allowed;
        const expected =
          role === "pdaa_backup"
            ? privilege === "SELECT"
            : role === "pdaa_worker"
              ? false
              : ["SELECT", "INSERT"].includes(privilege) ||
                (table === "FactSourceReader" && privilege === "DELETE");
        assert.equal(allowed, expected, role + "/" + table + "/" + privilege);
      }
      const columns = (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
          [table],
        )
      ).rows;
      for (const { column_name } of columns) {
        const allowed = (
          await pool.query(
            "SELECT has_column_privilege($1,$2,$3,'UPDATE') AS allowed",
            [role, '"' + table + '"', column_name],
          )
        ).rows[0].allowed;
        assert.equal(
          allowed,
          role === "pdaa_api" &&
            ((table === "ProjectFact" && column_name === "revision") ||
              (table === "FactSourceAccess" &&
                ["state", "revision"].includes(column_name))),
        );
      }
    }
    assert.equal(
      (
        await pool.query(
          "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename=$1",
          [table],
        )
      ).rows[0].tableowner,
      "pdaa_migrate",
    );
  }
  const protectedFunctions = [
    "valid_project_fact_value",
    "nonblank_fact_text",
    "reject_fact_history_mutation",
    "preserve_project_scope",
    "guard_project_fact_revision",
    "guard_fact_version_append",
    "advance_project_fact_revision",
    "guard_fact_source_access",
    "guard_fact_source_reader",
    "advance_fact_reader_revision",
  ];
  const functions = (
    await pool.query(
      `
    SELECT p.proname,p.prosecdef,pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)
  `,
      [protectedFunctions],
    )
  ).rows;
  assert.equal(functions.length, protectedFunctions.length);
  assert(functions.every((fn) => !fn.prosecdef && fn.owner === "pdaa_migrate"));
}
async function deniedSql(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(() => client.query(sql));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
export async function verifyImmutableProjectFacts(pool, runtime = false) {
  guard();
  for (const table of [
    "FactSource",
    "FactEvidence",
    "ProjectFactVersion",
    "FactAppendReceipt",
  ]) {
    await deniedSql(pool, `UPDATE "${table}" SET id=id`);
    await deniedSql(pool, `DELETE FROM "${table}"`);
    await deniedSql(pool, `TRUNCATE "${table}" CASCADE`);
    if (runtime)
      await deniedSql(pool, `ALTER TABLE "${table}" DISABLE TRIGGER ALL`);
  }
}
export async function verifyWorkerFactDenials(connection) {
  guard();
  const worker = new Pool(connection);
  try {
    assert.equal(
      (await worker.query("SELECT current_user AS name")).rows[0].name,
      "pdaa_worker",
    );
    for (const sql of [
      'SELECT * FROM "FactEvidence"',
      'INSERT INTO "ProjectFact" DEFAULT VALUES',
    ])
      await assert.rejects(
        () => worker.query(sql),
        (error) => error.code === "42501",
      );
  } finally {
    await worker.end();
  }
  return true;
}
export async function seedProjectFactHistory(
  owner,
  runtimeConnection,
  customerId,
  projectId,
  prefix,
  databaseFactory = createDatabase,
) {
  guard();
  const actor = {
    customerId,
    subject: prefix + "-human",
    roles: ["project_manager"],
  };
  const administrator = {
    customerId,
    subject: prefix + "-evidence-admin",
    roles: ["pmo_admin"],
  };
  for (const person of [actor, administrator])
    await owner.query(
      'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        customerId,
        person.subject,
        "project",
        projectId,
        person.roles[0],
      ],
    );
  await owner.query(
    'INSERT INTO "ServiceHeartbeat" (id,"occurredAt") VALUES ($1,$2)',
    [prefix + "-restore-checkpoint", "2026-09-09T00:00:00.000Z"],
  );
  const database = databaseFactory(runtimeConnection);
  const api = new Pool(runtimeConnection);
  try {
    const repository = new DatabaseProjectFactRepository(database);
    const request = {
      projectId,
      factType: "project.forecast",
      expectedRevision: 0,
      idempotencyKey: prefix + "-first",
      value: { type: "date", value: "2026-10-01" },
      effectiveAt: "2026-09-09T00:00:00.000Z",
      originalStatement: "Synthetic retained human forecast.",
    };
    const context = { correlationId: prefix + "-fact-fixture" };
    const first = await repository.appendHumanStatement(
      actor,
      request,
      context,
    );
    const second = await repository.appendHumanStatement(
      actor,
      {
        ...request,
        expectedRevision: 1,
        idempotencyKey: prefix + "-second",
        value: { type: "date", value: "2026-10-08" },
        originalStatement: "Synthetic revised human forecast.",
      },
      context,
    );
    assert.equal(first.entry.sourceId, second.entry.sourceId);
    assert.notEqual(first.entry.evidenceId, second.entry.evidenceId);
    const revoked = await repository.setSourceAccess(
      administrator,
      {
        projectId,
        sourceId: first.entry.sourceId,
        expectedRevision: second.entry.sourceAccessRevision,
        state: "REVOKED",
        readers: [actor.subject],
      },
      context,
    );
    const replay = await repository.appendHumanStatement(
      actor,
      request,
      context,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.entry.id, first.entry.id);
    assert.equal(replay.entry.visibility, "restricted");
    assert.equal(Object.hasOwn(replay.entry, "content"), false);
    const history = await repository.getHistory(actor, {
      projectId,
      factType: request.factType,
    });
    assert.equal(history.entries.length, 2);
    assert(
      history.entries.every(
        (entry) =>
          entry.visibility === "restricted" && !Object.hasOwn(entry, "content"),
      ),
    );
    await verifyImmutableProjectFacts(api, true);
    return {
      projectId,
      factId: first.factId,
      sourceId: first.entry.sourceId,
      versions: [first.entry.id, second.entry.id],
      evidence: [first.entry.evidenceId, second.entry.evidenceId],
      sourceAccessRevision: revoked.revision,
      redactedReplay: true,
      runtimeImmutableDenials: true,
    };
  } finally {
    await api.end();
    await database.$disconnect();
  }
}
