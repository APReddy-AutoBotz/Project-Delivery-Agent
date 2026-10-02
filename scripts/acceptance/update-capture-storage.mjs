// EXEC-015 / TR-DATA-001 / NFR-REL-002: native transaction fixtures, no sends.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeUpdateIssuance, updateIssuanceStatus, readUpdateIssuanceChange } from "../../packages/operations/dist/update-engagement-issuance.js";
export const updateCaptureTables = ["ProjectUpdateIssuanceGate", "ProjectUpdateCapturedRequest",
  "ProjectUpdateInvitation", "ProjectUpdateResponse", "ProjectUpdateRequestContent", "ProjectUpdateResponseContent"];
const guards = ["guard_update_issuance_gate()", "guard_update_capture_birth()", "guard_update_invitation_birth()",
  "guard_update_response_birth()", "guard_update_capture_content()", "require_update_capture_complete()"];
const narrow = ["lock_update_issuance_gate(uuid)", "purge_update_capture_content(uuid)"];
const digest = (text) => createHash("sha256").update(text).digest("hex");

// Caller supplies only its already-guarded disposable acceptance connection.
export async function verifyCaptureOperatorControls(pool, databaseConnection, customerId) {
  const customer = (await pool.query('SELECT id,name FROM public."Customer"')).rows;
  assert.equal(customer.length, 1);
  assert.equal(customer[0].id, customerId);
  const database = typeof databaseConnection === "string" ? (() => {
    const url = new URL(databaseConnection);
    return { host: url.hostname, port: Number(url.port), database: url.pathname.slice(1),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false };
  })() : databaseConnection;
  const config = { database, customerId, customerName: customer[0].name, roleFiles: {} };
  const identity = (await pool.query("SELECT current_database() AS name,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.match(identity.name, /^(pdaa_test_[0-9]+|pdaa)$/);
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const comment = async (marker) => pool.query('COMMENT ON DATABASE "' + identity.name + '" IS ' + (marker === null ? "NULL" : quote(marker)));
  const directory = mkdtempSync(join(tmpdir(), "pdaa-capture-operator-"));
  const capturePath = join(directory, "capture.json");
  try {
    let status = await updateIssuanceStatus(config);
    assert.equal(status.enabled, true);
    assert.throws(() => readUpdateIssuanceChange({}, true));
    assert.throws(() => readUpdateIssuanceChange({ PDAA_UPDATE_ISSUANCE_EXPECTED_REVISION: "01",
      PDAA_UPDATE_ISSUANCE_EXPECTED_EPOCH: status.epoch }, true));
    const disable = readUpdateIssuanceChange({ PDAA_UPDATE_ISSUANCE_EXPECTED_REVISION: String(status.revision),
      PDAA_UPDATE_ISSUANCE_EXPECTED_EPOCH: status.epoch }, false);
    const prior = status;
    status = await changeUpdateIssuance(config, disable);
    assert.equal(status.enabled, false);
    assert.notEqual(status.epoch, prior.epoch);
    assert.equal(status.revision, prior.revision + 1);
    const auditCount = (await pool.query('SELECT count(*)::int AS n FROM public."AuditEvent"')).rows[0].n;
    await assert.rejects(() => changeUpdateIssuance(config, disable));
    assert.deepEqual(await updateIssuanceStatus(config), status);
    const enable = { enable: true, expectedRevision: status.revision, expectedEpoch: status.epoch };
    await assert.rejects(() => changeUpdateIssuance(config, enable));
    writeFileSync(capturePath, JSON.stringify({ customerId, mode: "CAPTURE", issuanceEpoch: status.epoch,
      invitationLifetimeSeconds: 3600, contentRetentionSeconds: 86400, responseReviewerSubjects: [] }), { mode: 0o600 });
    await comment("pdaa.restore.quarantine." + customerId);
    await assert.rejects(() => changeUpdateIssuance(config, enable, capturePath));
    assert.deepEqual(await updateIssuanceStatus(config), status);
    await comment("pdaa.foundation.v1:" + customerId);
    await assert.rejects(() => changeUpdateIssuance(config, { ...enable, expectedEpoch: prior.epoch }, capturePath));
    await assert.rejects(() => changeUpdateIssuance({ ...config, customerId: randomUUID() }, enable, capturePath));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public."AuditEvent"')).rows[0].n, auditCount,
      "Rejected operator actions must not commit an audit or gate change");
    status = await changeUpdateIssuance(config, enable, capturePath);
    assert.equal(status.enabled, true);
    assert.equal(status.epoch, enable.expectedEpoch);
    assert.equal(status.revision, enable.expectedRevision + 1);
    await assert.rejects(() => changeUpdateIssuance(config, { ...enable, expectedRevision: status.revision }, capturePath));
    assert.deepEqual(await updateIssuanceStatus(config), status);
    return { statusAndExplicitEnable: true, disableRotatesEpoch: true, staleChangeDenied: true,
      quarantinedEnableDenied: true, rejectedActionsAtomic: true };
  } finally {
    await comment(identity.marker);
    if (existsSync(capturePath)) unlinkSync(capturePath);
    rmdirSync(directory);
  }
}

// Packaged restore permits verified issuance quarantine and a bounded purge of
// already-expired bodies. Metadata, locators and every unaffected row stay exact.
export function assertUpdateCaptureRestoreProjection(actual, expected) {
  const result = { ...actual };
  const gates = actual.ProjectUpdateIssuanceGate;
  assert(Array.isArray(gates) && gates.length === expected.ProjectUpdateIssuanceGate.length);
  const auditIds = new Set();
  for (const prior of expected.ProjectUpdateIssuanceGate) {
    const restored = gates.find((row) => row.customerId === prior.customerId);
    assert(restored && !restored.issuanceEnabled && restored.issuanceEpoch !== prior.issuanceEpoch);
    assert.match(restored.issuanceEpoch, /^[0-9a-f-]{36}$/i);
    assert.equal(restored.revision, prior.revision + 1);
    assert(Date.parse(restored.changedAt) >= Date.parse(prior.changedAt));
    const gateChanges = new Set(["issuanceEnabled", "issuanceEpoch", "revision", "changedAt", "auditEventId"]);
    assert.deepEqual(Object.fromEntries(Object.entries(restored).filter(([key]) => !gateChanges.has(key))),
      Object.fromEntries(Object.entries(prior).filter(([key]) => !gateChanges.has(key))));
    const audit = actual.AuditEvent.find((row) => row.id === restored.auditEventId);
    assert(audit && audit.customerId === prior.customerId && audit.actor === "restore:quarantine" &&
      audit.event === "project_update.issuance.changed" && audit.correlationId === "project-update-restore-quarantine");
    assert.deepEqual(audit.detail, { enabled: false, revision: restored.revision });
    assert(!expected.AuditEvent.some((row) => row.id === audit.id));
    auditIds.add(audit.id);
  }
  result.ProjectUpdateIssuanceGate = expected.ProjectUpdateIssuanceGate;
  for (const [table, metadataTable, idField, contentKind] of [
    ["ProjectUpdateRequestContent", "ProjectUpdateCapturedRequest", "requestId", "REQUEST"],
    ["ProjectUpdateResponseContent", "ProjectUpdateResponse", "responseId", "RESPONSE"],
  ]) {
    if (!expected[table]) continue;
    assert(Array.isArray(actual[table]) && actual[table].length === expected[table].length);
    const perCustomer = new Map();
    assert.equal(new Set(actual[table].map((row) => row.customerId + ":" + row[idField])).size, actual[table].length,
      "Restore content identities must remain unique");
    result[table] = actual[table].map((row) => {
      const prior = expected[table].find((entry) => entry[idField] === row[idField] && entry.customerId === row.customerId);
      assert(prior, "Restore cannot invent capture content");
      if (JSON.stringify(row) === JSON.stringify(prior)) return prior;
      const metadata = expected[metadataTable]?.find((entry) => entry.id === row[idField] &&
        entry.customerId === row.customerId && entry.projectId === row.projectId);
      const gate = gates.find((entry) => entry.customerId === row.customerId);
      assert(metadata && gate && prior.state === "PRESENT" && row.state === "PURGED" &&
        row.body === null && prior.purgedAt === null && prior.purgeAuditEventId === null);
      assert.equal(digest(prior.body), metadata.contentDigest);
      assert(Date.parse(row.purgedAt) >= Date.parse(gate.changedAt) && Date.parse(row.purgedAt) >= Date.parse(metadata.purgeAfter));
      assert(Date.parse(row.purgedAt) <= Date.now(), "A restore purge cannot use a future timestamp");
      const mutable = new Set(["body", "state", "purgedAt", "purgeAuditEventId"]);
      assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([key]) => !mutable.has(key))),
        Object.fromEntries(Object.entries(prior).filter(([key]) => !mutable.has(key))));
      const audit = actual.AuditEvent.find((entry) => entry.id === row.purgeAuditEventId);
      assert(audit && audit.customerId === row.customerId && audit.actor === "system:update-engagement-retention" &&
        audit.event === "project_update.content.purged" && audit.correlationId === "project-update-retention");
      assert.deepEqual(audit.detail, { contentKind });
      assert(!expected.AuditEvent.some((entry) => entry.id === audit.id) && !auditIds.has(audit.id));
      auditIds.add(audit.id);
      const count = (perCustomer.get(row.customerId) ?? 0) + 1;
      assert(count <= 50, "Restore purge must retain its fixed per-kind bound");
      perCustomer.set(row.customerId, count);
      return prior;
    }).sort((left, right) => expected[table].indexOf(left) - expected[table].indexOf(right));
  }
  result.AuditEvent = result.AuditEvent.filter((row) => !auditIds.has(row.id));
  assert.deepEqual(result, expected, "Restore preserves all rows except verified issuance quarantine and its audit");
  return true;
}

export async function verifyUpdateCapturePrivileges(pool) {
  for (const table of updateCaptureTables)
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"])
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"])
        assert.equal((await pool.query("SELECT has_table_privilege($1,$2,$3) AS allowed",
          [role, 'public."' + table + '"', privilege])).rows[0].allowed,
          privilege === "SELECT" && ["pdaa_api", "pdaa_backup"].includes(role) ||
            role === "pdaa_api" && privilege === "INSERT" && table !== "ProjectUpdateIssuanceGate",
          role + "/" + table + "/" + privilege);
  for (const signature of [...guards, ...narrow])
    for (const role of ["pdaa_api", "pdaa_worker", "pdaa_backup"])
      assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [role, "public." + signature])).rows[0].allowed,
        role === "pdaa_api" && narrow.includes(signature), role + "/" + signature);
  const functionNames = [...guards, ...narrow].map((name) => name.split("(")[0]);
  const rows = (await pool.query(`SELECT p.proname,p.prosecdef,pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1)`, [functionNames])).rows;
  assert.equal(rows.length, guards.length + narrow.length);
  for (const row of rows) {
    assert.equal(row.owner, "pdaa_migrate");
    assert.equal(row.prosecdef, narrow.some((name) => name.startsWith(row.proname + "(")));
  }
}

// Run only from verifyUpdateEngagementStorage's guarded, isolated cluster.
// Complete request/invitation/content/outbox/automatic receipt commit together.
export async function completeCapturedFixture(pool, { customerId, projectId, outboxId, audit }) {
  await pool.query('INSERT INTO "ProjectUpdateIssuanceGate"("customerId") VALUES($1) ON CONFLICT DO NOTHING', [customerId]);
  const gate = (await pool.query('SELECT * FROM "ProjectUpdateIssuanceGate" WHERE "customerId"=$1', [customerId])).rows[0];
  if (!gate.issuanceEnabled) {
    const gateAudit = randomUUID();
    await pool.query(`INSERT INTO "AuditEvent"(id,"customerId",actor,event,"correlationId",detail)
      VALUES($1,$2,'capture-storage-fixture','project_update.issuance.changed',$3,'{"fixture":true}'::jsonb)`,
      [gateAudit, customerId, randomUUID()]);
    await pool.query(`UPDATE "ProjectUpdateIssuanceGate" SET "issuanceEnabled"=true,
      revision=revision+1,"changedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2
      WHERE "customerId"=$1`, [customerId, gateAudit]);
  }
  const connection = await pool.connect();
  const requestId = randomUUID(), invitationId = randomUUID(), responseId = randomUUID(), locator = randomUUID();
  const body = "Synthetic storage request; no external message was sent.";
  const responseText = "Synthetic unconfirmed response <script>untrusted()</script>.";
  try {
    await connection.query("BEGIN");
    const stage = (await connection.query(`SELECT s.*,a.dependencies FROM "ProjectUpdateStage" s
      JOIN "ProjectUpdateOutbox" o ON o."stageId"=s.id
      JOIN "ProjectUpdateAssessment" a ON a.id=s."assessmentId" AND a."customerId"=s."customerId" AND a."projectId"=s."projectId"
      WHERE o.id=$1 AND s."customerId"=$2 AND s."projectId"=$3`, [outboxId, customerId, projectId])).rows[0];
    assert(stage?.mode === "CAPTURE");
    const capturedAt = (await connection.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now;
    const auditId = await audit(connection);
    await connection.query(`INSERT INTO "ProjectUpdateCapturedRequest"(id,"customerId","projectId","stageId",
      "sourceAssessmentId","issuanceEpoch","recipientSubject","reviewerSubjects","requiredFacts",dependencies,
      "rendererRevision","contentDigest","capturedAt","invitationLifetimeSeconds","contentRetentionSeconds","purgeAfter","auditEventId")
      VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY[]::text[],$8::jsonb,$9::jsonb,'project-update-capture@1',$10,$11,3600,86400,$11::timestamptz+interval '1 day',$12)`,
      [requestId, customerId, projectId, stage.id, stage.assessmentId, gate.issuanceEpoch, stage.recipientSubject,
        JSON.stringify([{ factType: "project.status", label: "Current status" }]), JSON.stringify(stage.dependencies), digest(body), capturedAt, auditId]);
    await connection.query(`INSERT INTO "ProjectUpdateInvitation"(id,locator,"customerId","projectId","requestId",
      "recipientSubject","issuanceEpoch","issuedAt","expiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8::timestamptz+interval '1 hour')`,
      [invitationId, locator, customerId, projectId, requestId, stage.recipientSubject, gate.issuanceEpoch, capturedAt]);
    await connection.query('INSERT INTO "ProjectUpdateRequestContent"("requestId","customerId","projectId",body) VALUES($1,$2,$3,$4)',
      [requestId, customerId, projectId, body]);
    await connection.query(`UPDATE "ProjectUpdateOutbox" SET state='CAPTURED',"leaseUntil"=NULL,
      "completedAt"=date_trunc('milliseconds',clock_timestamp()),"auditEventId"=$2 WHERE id=$1`, [outboxId, auditId]);
    await connection.query(`INSERT INTO "ProjectUpdateResponse"(id,"customerId","projectId","requestId","invitationId",
      "submittedBy","idempotencyKey","payloadDigest","contentDigest","receivedAt","contentRetentionSeconds","purgeAfter","auditEventId")
      VALUES($1,$2,$3,$4,$5,$6,'storage-response',$7,$7,$8,86400,$8::timestamptz+interval '1 day',$9)`,
      [responseId, customerId, projectId, requestId, invitationId, stage.recipientSubject, digest(responseText), capturedAt, await audit(connection)]);
    await connection.query('INSERT INTO "ProjectUpdateResponseContent"("responseId","customerId","projectId",body) VALUES($1,$2,$3,$4)',
      [responseId, customerId, projectId, responseText]);
    await connection.query("COMMIT");
    return { requestId, invitationId, responseId, locator, issuanceEpoch: gate.issuanceEpoch, contentDigest: digest(body), responseDigest: digest(responseText) };
  } catch (error) { await connection.query("ROLLBACK"); throw error; }
  finally { connection.release(); }
}

export async function verifyRestoredCaptureRows(database, evidence) {
  assert(evidence?.requestId && evidence?.invitationId && evidence?.responseId);
  for (const table of updateCaptureTables)
    assert((await database.$queryRawUnsafe(`SELECT count(*)::int AS n FROM public."${table}"`))[0].n > 0,
      "Populated capture recovery requires " + table);
  const rows = await database.$queryRawUnsafe(`SELECT r."customerId",r."issuanceEpoch",r."contentDigest",r."purgeAfter",c.body,
    c.state AS "requestContentState",c."purgedAt" AS "requestPurgedAt",c."purgeAuditEventId" AS "requestPurgeAuditEventId",
    rc.state AS "responseContentState",rc."purgedAt" AS "responsePurgedAt",rc."purgeAuditEventId" AS "responsePurgeAuditEventId",
    response."purgeAfter" AS "responsePurgeAfter",clock_timestamp() AS "databaseNow",
    i.locator,i."issuanceEpoch" AS "invitationEpoch",response."contentDigest" AS "responseDigest",rc.body AS "responseBody",
    g."issuanceEnabled",g."issuanceEpoch" AS "currentEpoch"
    FROM public."ProjectUpdateCapturedRequest" r
    JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."requestId"=r.id
    JOIN public."ProjectUpdateInvitation" i ON i."customerId"=r."customerId" AND i."projectId"=r."projectId" AND i."requestId"=r.id
    JOIN public."ProjectUpdateResponse" response ON response."customerId"=r."customerId" AND response."projectId"=r."projectId" AND response."requestId"=r.id AND response."invitationId"=i.id
    JOIN public."ProjectUpdateResponseContent" rc ON rc."customerId"=response."customerId" AND rc."projectId"=response."projectId" AND rc."responseId"=response.id
    JOIN public."ProjectUpdateIssuanceGate" g ON g."customerId"=r."customerId"
    WHERE r.id=$1::uuid AND i.id=$2::uuid AND response.id=$3::uuid`, evidence.requestId, evidence.invitationId, evidence.responseId);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.issuanceEpoch, evidence.issuanceEpoch);
  assert.equal(row.invitationEpoch, evidence.issuanceEpoch);
  assert.equal(row.locator, evidence.locator);
  assert.equal(row.contentDigest, evidence.contentDigest);
  assert.equal(row.responseDigest, evidence.responseDigest);
  for (const [kind, state, body, purgedAt, purgeAfter, auditId, expectedDigest] of [
    ["REQUEST", row.requestContentState, row.body, row.requestPurgedAt, row.purgeAfter, row.requestPurgeAuditEventId, evidence.contentDigest],
    ["RESPONSE", row.responseContentState, row.responseBody, row.responsePurgedAt, row.responsePurgeAfter, row.responsePurgeAuditEventId, evidence.responseDigest],
  ]) {
    if (state === "PRESENT") {
      assert.equal(typeof body, "string");
      assert.equal(digest(body), expectedDigest);
      assert.equal(purgedAt, null);
      assert.equal(auditId, null);
    } else {
      assert.equal(state, "PURGED");
      assert.equal(body, null);
      assert(purgedAt instanceof Date && purgedAt >= purgeAfter && purgedAt <= row.databaseNow);
      const audits = await database.$queryRawUnsafe('SELECT event,detail FROM public."AuditEvent" WHERE "customerId"=$1::uuid AND id=$2::uuid',
        row.customerId, auditId);
      assert.equal(audits.length, 1);
      assert.equal(audits[0].event, "project_update.content.purged");
      assert.deepEqual(audits[0].detail, { contentKind: kind });
    }
  }
  const marker = (await database.$queryRawUnsafe("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()"))[0].marker;
  if (marker?.startsWith("pdaa.restore.quarantine.")) {
    assert.equal(row.issuanceEnabled, false);
    assert.notEqual(row.currentEpoch, evidence.issuanceEpoch);
  }
  return { requestAndRawResponseRetained: true, originalInvitationEpochRetained: true,
    contentDigestsVerified: true, quarantinedRestore: Boolean(marker?.startsWith("pdaa.restore.quarantine.")) };
}
