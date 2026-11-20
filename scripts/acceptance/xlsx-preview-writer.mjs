// FR-CON-006/007: actual API-role transaction with a bounded synthetic decoder.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase, DatabaseIngestionRepository } from "../../packages/data/dist/index.js";
import { CredentialVault } from "../../packages/platform/dist/index.js";
import { xlsxWriterApiFunctions, xlsxWriterCommitFunction, xlsxWriterFunctions } from "../../packages/operations/dist/business-grants.js";

export async function verifyXlsxWriterPrivileges(pool, roles, { owner, apiExecute = false } = {}) {
  for (const signature of xlsxWriterFunctions) {
    const { rows } = await pool.query(`SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
      ARRAY(SELECT a.grantee::regrole::text FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE' ORDER BY a.grantee) AS recipients,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND a.is_grantable) AS grantable
      FROM pg_proc p WHERE p.oid=to_regprocedure($1)`, [signature]);
    assert.equal(rows.length, 1);
    const exposed = xlsxWriterApiFunctions.includes(signature);
    const granted = exposed && apiExecute;
    assert.equal(rows[0].prosecdef, exposed || signature === xlsxWriterCommitFunction);
    assert.deepEqual(rows[0].proconfig, ["search_path=pg_catalog, pg_temp"]);
    assert.equal(rows[0].grantable, false);
    assert.deepEqual(rows[0].recipients, granted ? ["pdaa_api"] : []);
    if (owner !== undefined) assert.equal(rows[0].owner, owner);
    for (const role of roles)
      assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [role, signature])).rows[0].allowed, granted && role === "pdaa_api");
  }
  return { finiteWriterGrant: true };
}

async function verifyWriterCancellation(db, vault, actor, config, workbook, grid) {
  // Signal at specific await boundaries while preserving the real SQL and transaction.
  const cancelledKeys = [];
  for (const boundary of ["decode", "start", "read", "finalize"]) {
    const controller = new AbortController();
    const observed = [];
    let decoded = false;
    let released = false;
    const repository = new DatabaseIngestionRepository(
      new Proxy(db, {
        get(target, name) {
          if (name === "$transaction") return (callback, options) =>
            target.$transaction(async (tx) => {
              if (!decoded) return callback(tx);
              if (boundary === "start") controller.abort();
              return callback({
                async $queryRaw(parts, ...values) {
                  const phase = /public\.(read|finalize)_ingestion_xlsx_preview\(/u.exec(parts.join(""))?.[1];
                  assert(phase);
                  const rows = await tx.$queryRaw(parts, ...values);
                  observed.push([phase, rows[0]?.result?.status]);
                  if (phase === boundary) controller.abort();
                  return rows;
                },
              });
            }, options);
          const value = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      vault,
      {
        tryAcquire: () => ({
          async decode(_input, _workbook, transportSignal) {
            assert.equal(transportSignal, undefined);
            decoded = true;
            if (boundary === "decode") controller.abort();
            return grid;
          },
          release() { released = true; },
        }),
      },
    );
    const commandKey = "fixture-writer-cancel-" + boundary;
    await assert.rejects(
      repository.persistXlsxPreview(actor, { ...config, commandKey }, workbook, randomUUID(), controller.signal),
      { code: "PERSISTENCE_FAILED" },
    );
    assert(controller.signal.aborted && released);
    assert.deepEqual(observed, {
      decode: [],
      start: [],
      read: [["read", "READY"]],
      finalize: [["read", "READY"], ["finalize", "STORED"]],
    }[boundary]);
    cancelledKeys.push(commandKey);
  }
  return cancelledKeys;
}

export async function proveNativeXlsxPreviewWriter(pool, apiConnection) {
  const { rows } = await pool.query(`SELECT s."customerId",s.id AS "sourceId",s."currentConfigRevision" AS "configRevision",
    s."mappingRevision",c.mapping->>'sheet' AS sheet,e."projectId",h.revision,h."currentReceiptId"
    FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" c
      ON c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=s."currentConfigRevision"
    JOIN public."IngestionXlsxHead" h ON h."customerId"=s."customerId" AND h."sourceId"=s.id
    JOIN public."IngestionExternalRecord" e ON e."customerId"=s."customerId" AND e."sourceId"=s.id
    WHERE s."inputFamily"='XLSX'`);
  assert.equal(rows.length, 1);
  const { customerId, projectId, revision, currentReceiptId, ...config } = rows[0];
  assert.equal(revision, 3);
  const actor = { customerId, subject: "synthetic-workbook-pmo", roles: ["pmo_admin"] };
  const grid = { headers: ["Key", "Project", "Status", "Forecast"], rows: [["Fixture-1", projectId, "On track", "2027-02-01"]] };
  const workbook = Buffer.from("synthetic native writer fixture");
  const db = createDatabase(apiConnection);
  const vault = new CredentialVault(Buffer.alloc(32, 23).toString("base64"));
  let admissions = 0;
  let releases = 0;
  const decoder = {
    tryAcquire() {
      admissions++;
      return {
        async decode(request, bytes) {
          assert.deepEqual(request, { sheet: config.sheet, parserContract: "excel-text-v1" });
          assert.deepEqual(bytes, workbook);
          return grid;
        },
        release() { releases++; },
      };
    },
  };
  const fresh = { ...config, commandKey: "fixture-writer-fresh" };
  const race = { ...config, commandKey: "fixture-writer-race" };
  const preview = (metadata, adapter = decoder, bytes = workbook, principal = actor) =>
    new DatabaseIngestionRepository(db, vault, adapter)
      .persistXlsxPreview(principal, metadata, bytes, randomUUID());
  try {
    assert.deepEqual(await db.$queryRaw`SELECT session_user::text AS name`, [{ name: "pdaa_api" }]);
    const saved = await preview(fresh);
    assert.equal(saved.replayed, false);
    assert.equal(saved.rowCount, 1);
    assert.deepEqual(await preview(fresh), { ...saved, replayed: true });
    await assert.rejects(preview(fresh, decoder, Buffer.from("changed")), { code: "CONFLICT" });
    await assert.rejects(preview(race, decoder, workbook, { ...actor, subject: "synthetic-unentitled-writer" }), { code: "DENIED" });
    assert.equal(admissions, 1);
    assert.equal(releases, 1);

    let winner;
    const replay = await preview(race, {
      tryAcquire() {
        return {
          async decode() {
            winner = await preview(race);
            return grid;
          },
          release() { releases++; },
        };
      },
    });
    assert.equal(winner.replayed, false);
    assert.deepEqual(replay, { ...winner, replayed: true });
    assert.equal(admissions, 2);
    assert.equal(releases, 3);

    const firstLockingGrant = (await pool.query(`SELECT id FROM public."AccessGrant"
      WHERE "customerId"=$1 AND subject=$2 AND "scopeType"='project' AND "scopeId"=$3`,
      [customerId, actor.subject, projectId])).rows[0].id;
    try {
      await assert.rejects(preview({ ...config, commandKey: "fixture-writer-revoked" }, {
        tryAcquire() {
          return {
            async decode() {
              await pool.query(`UPDATE public."AccessGrant" SET role='leadership' WHERE id=$1`, [firstLockingGrant]);
              return grid;
            },
            release() {},
          };
        },
      }), { code: "DENIED" });
    } finally {
      await pool.query(`UPDATE public."AccessGrant" SET role='pmo_admin' WHERE id=$1`, [firstLockingGrant]);
    }

    const cancelledKeys = await verifyWriterCancellation(db, vault, actor, config, workbook, grid);
    const failedKey = "fixture-writer-invalid-operation";
    const keyHash = createHash("sha256").update(JSON.stringify(["pdaa.xlsx.row-key.v1",config.sheet,"Fixture-1"])).digest("hex");
    const byteHash = createHash("sha256").update(workbook).digest("hex");
    const proposals = [
      { factType: "project.forecast", value: { type: "date", value: "2027-02-01" } },
      { factType: "project.status", value: { type: "text", value: "On track" } },
    ];
    const malformed = JSON.stringify([{
      state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId, keySha256: keyHash,
      sourceContentSha256: createHash("sha256").update("synthetic failed write").digest("hex"), proposals,
    }]);
    await db.$transaction(async (tx) => {
      const [{ result: snapshot }] = await tx.$queryRaw`SELECT public.read_ingestion_xlsx_preview(
        ${customerId}::uuid,${config.sourceId}::uuid,${actor.subject}::text,${actor.roles}::text[],${failedKey}::text,
        ${config.configRevision}::integer,${config.mappingRevision}::integer,${config.sheet}::text,'excel-text-v1') AS result`;
      assert.equal(snapshot.status, "READY");
      const [{ result }] = await tx.$queryRaw`SELECT public.finalize_ingestion_xlsx_preview(
        ${customerId}::uuid,${config.sourceId}::uuid,${actor.subject}::text,${actor.roles}::text[],${failedKey}::text,
        ${config.configRevision}::integer,${config.mappingRevision}::integer,${config.sheet}::text,'excel-text-v1',
        ${workbook.length}::integer,${byteHash}::text,${randomUUID()}::text,${JSON.stringify(snapshot.witness)}::jsonb,
        ${malformed}::jsonb) AS result`;
      assert.deepEqual(result, { status: "INVALID_PREVIEW" });
    }, { isolationLevel: "ReadCommitted" });
    const rolledBack = await pool.query(`SELECT
      (SELECT count(*)::integer FROM public."IngestionOperationReceipt"
        WHERE "sourceId"=$1 AND "commandKey"=ANY($2::text[])) AS receipts,
      (SELECT count(*)::integer FROM public."IngestionSourceRevision" WHERE "sourceId"=$1) AS revisions,
      (SELECT count(*)::integer FROM public."IngestionProposalProjection" WHERE "sourceId"=$1) AS projections`,
      [config.sourceId, [failedKey, "fixture-writer-revoked", ...cancelledKeys]]);
    assert.deepEqual(rolledBack.rows, [{ receipts: 0, revisions: 3, projections: 3 }]);

    const stored = await pool.query(`SELECT h.revision,h."currentReceiptId",x."predecessorReceiptId",r."commandKey",o.operation,p."factTypes"
      FROM public."IngestionXlsxHead" h JOIN public."IngestionXlsxContext" x ON x."customerId"=h."customerId" AND x."sourceId"=h."sourceId"
      JOIN public."IngestionOperationReceipt" r ON r.id=x."receiptId"
      JOIN public."IngestionRowOutcome" o ON o."receiptId"=r.id JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
      WHERE h."customerId"=$1 AND h."sourceId"=$2 AND r."commandKey"=ANY($3::text[]) ORDER BY x.revision`,
      [customerId, config.sourceId, [fresh.commandKey, race.commandKey]]);
    assert.deepEqual(stored.rows, [
      { revision: 5, currentReceiptId: winner.receiptId, predecessorReceiptId: currentReceiptId,
        commandKey: fresh.commandKey, operation: "UNCHANGED", factTypes: ["project.forecast", "project.status"] },
      { revision: 5, currentReceiptId: winner.receiptId, predecessorReceiptId: saved.receiptId,
        commandKey: race.commandKey, operation: "UNCHANGED", factTypes: ["project.forecast", "project.status"] },
    ]);
    return { apiWroteNativePreview: true, exactRetrySkippedDecoder: true, concurrentDecodeReplayed: true,
      revokedDuringDecodeDenied: true, cancelledWritesRolledBack: true, failedAppendRolledBack: true, retainedContexts: 5 };
  } finally { await db.$disconnect(); }
}
