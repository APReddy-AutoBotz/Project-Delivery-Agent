// FR-CON-006/007: synthetic owner-only transaction and retained receipt proof.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  captureXlsxPreviewRequest,
  hashXlsxPreviewContext,
} from "../../packages/data/dist/ingestion-xlsx-binding.js";
import { applyXlsxComparisonObservations } from "../../packages/domain/dist/xlsx-comparison-state.js";
import { assertXlsxPreviewIntegrity } from "../../packages/operations/dist/xlsx-genesis-integrity.js";
import { xlsxContextFunctions } from "../../packages/operations/dist/business-grants.js";

const sha256 = (input) => createHash("sha256").update(input).digest("hex");

export async function verifyXlsxContextPrivileges(
  pool,
  roles,
  { owner, backupRead = false } = {},
) {
  const { rows } = await pool.query(
    `SELECT p.oid,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
    NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
    FROM unnest($1::text[]) names(name) JOIN pg_proc p ON p.oid=to_regprocedure(name)`,
    [xlsxContextFunctions],
  );
  assert.equal(rows.length, xlsxContextFunctions.length);
  for (const fn of rows) {
    assert.equal(fn.prosecdef, false);
    assert.deepEqual(fn.proconfig, ["search_path=pg_catalog"]);
    assert.equal(fn.private, true);
    if (owner !== undefined) assert.equal(fn.owner, owner);
  }
  const denied = await pool.query(
    `SELECT count(*)::integer AS n FROM unnest($1::text[]) roles(role),unnest($2::oid[]) f(id)
    WHERE has_function_privilege(role,id,'EXECUTE')`,
    [roles, rows.map(({ oid }) => oid)],
  );
  assert.deepEqual(denied.rows, [{ n: 0 }]);
  for (const role of roles) {
    const acl = await pool.query(
      `SELECT has_table_privilege($1,'public."IngestionXlsxContext"','SELECT') AS readable,
      has_table_privilege($1,'public."IngestionXlsxContext"','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS writable`,
      [role],
    );
    assert.deepEqual(acl.rows, [
      { readable: role === "pdaa_backup" && backupRead, writable: false },
    ]);
  }
  return { privateFunctions: rows.length, backupRead };
}

export async function proveNativeXlsxPreviews(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE pdaa_migrate");
    await client.query("SET CONSTRAINTS ingestion_outcome_commit IMMEDIATE");
    const { rows: heads } =
      await client.query(`SELECT h.*,c.mapping FROM public."IngestionXlsxHead" h
      JOIN public."IngestionConfigurationRevision" c ON c."customerId"=h."customerId" AND c."sourceId"=h."sourceId"
        AND c.revision=h."activationConfigRevision" AND c."mappingRevision"=h."mappingRevision"`);
    assert.equal(heads.length, 1);
    const head = heads[0];
    assert.equal(head.revision, 0);
    const { customerId, sourceId, mappingRevision, dictionary, mapping } = head;
    const configRevision = head.activationConfigRevision;
    const { rows: readers } = await client.query(
      `SELECT "projectId",subject FROM public."IngestionConfigurationReader"
      WHERE "customerId"=$1 AND "sourceId"=$2 AND "configRevision"=$3`,
      [customerId, sourceId, configRevision],
    );
    assert.equal(readers.length, 1);
    const { projectId, subject } = readers[0];
    await client.query(
      `SELECT id FROM public."Project" WHERE "customerId"=$1 AND id=$2 FOR UPDATE`,
      [customerId, projectId],
    );
    const { rows: grants } = await client.query(
      `SELECT id FROM public."AccessGrant" WHERE "customerId"=$1 AND subject=$2
      AND role='pmo_admin' AND "scopeType"='project' AND "scopeId"=$3 FOR SHARE`,
      [customerId, subject, projectId],
    );
    assert.equal(grants.length, 1);
    const audit = async (actor, event, detail, at) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, customerId, actor, event, randomUUID(), at, detail],
      );
      return id;
    };
    let policy = (
      await client.query(
        `SELECT revision FROM public."IngestionRetentionPolicy" WHERE "customerId"=$1 FOR SHARE`,
        [customerId],
      )
    ).rows[0];
    if (!policy) {
      const administrator = subject + "-retention";
      const at = new Date();
      await client.query(
        `INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role)
        VALUES ($1,$2,$3,'project',$4,'system_admin')`,
        [randomUUID(), customerId, administrator, projectId],
      );
      const id = await audit(
        administrator,
        "ingestion.retention.changed",
        { retentionHours: 24, revision: 1 },
        at,
      );
      await client.query(
        `INSERT INTO public."IngestionRetentionPolicy" ("customerId","retentionHours",revision,"changedBy","auditEventId","changedAt")
        VALUES ($1,24,1,$2,$3,$4)`,
        [customerId, administrator, id, at],
      );
      policy = { revision: 1 };
    }
    await client.query(
      `SELECT id FROM public."IngestionSource" WHERE "customerId"=$1 AND id=$2 FOR UPDATE`,
      [customerId, sourceId],
    );
    const recordId = randomUUID();
    const keySha256 = sha256(
      JSON.stringify(["pdaa.xlsx.row-key.v1", mapping.sheet, "Fixture-1"]),
    );
    await client.query(
      `INSERT INTO public."IngestionExternalRecord" (id,"customerId","sourceId","projectId","recordType","recordKey")
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        recordId,
        customerId,
        sourceId,
        projectId,
        "xlsx:" + mapping.sheet,
        keySha256,
      ],
    );
    for (const [factType] of dictionary)
      await client.query(
        `INSERT INTO public."IngestionFactStream" (id,"customerId","sourceId","recordId","factType")
        VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), customerId, sourceId, recordId, factType],
      );
    const createObservation = async (revision, proposals, operation) => {
      const revisionId = randomUUID(),
        projectionId = randomUUID();
      const sourceContentSha256 = sha256(JSON.stringify(proposals));
      const { rows } = await client.query(
        `SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS hash`,
        [JSON.stringify(proposals)],
      );
      const proposalSha256 = rows[0].hash;
      await client.query(
        `INSERT INTO public."IngestionSourceRevision" (id,"customerId","sourceId","recordId",revision,"sourceContentHash","receivedAt")
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '2 hours')`,
        [
          revisionId,
          customerId,
          sourceId,
          recordId,
          revision,
          sourceContentSha256,
        ],
      );
      const facts = proposals.map(({ factType }) => factType);
      await client.query(
        `INSERT INTO public."IngestionProposalProjection" (id,"customerId","sourceId","recordId","sourceRevisionId","mappingRevision","proposalHash","factTypes")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          projectionId,
          customerId,
          sourceId,
          recordId,
          revisionId,
          mappingRevision,
          proposalSha256,
          facts,
        ],
      );
      await client.query(
        `INSERT INTO public."IngestionProposalContent" ("customerId","sourceId","recordId","projectionId",proposals,"policyRevision")
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          customerId,
          sourceId,
          recordId,
          projectionId,
          JSON.stringify(proposals),
          policy.revision,
        ],
      );
      return {
        operation,
        record: {
          id: recordId,
          revisionId,
          sourceContentSha256,
          projectionId,
          proposalSha256,
        },
        references: facts.map((factType) => [
          String(dictionary.findIndex(([fact]) => fact === factType)),
          projectionId,
        ]),
      };
    };
    let previous = {
      receiptId: null,
      revision: 0,
      stateSha256: head.genesisSha256,
    };
    let state = [
      "pdaa.xlsx.comparison-state.v1",
      customerId,
      sourceId,
      mappingRevision,
      mapping.sheet,
      mapping.parserContract,
      dictionary,
      [],
    ];
    const recordPreview = async (
      commandKey,
      observation,
      invalidOverlay = false,
    ) => {
      const receiptId = randomUUID(),
        createdAt = new Date();
      const { request, requestSha256 } = captureXlsxPreviewRequest(
        {
          customerId,
          sourceId,
          subject,
          commandKey,
          configRevision,
          mappingRevision,
          sheet: mapping.sheet,
          parserContract: mapping.parserContract,
        },
        Buffer.from("synthetic workbook " + commandKey),
      );
      const outcomes = observation
        ? [
            {
              ordinal: 1,
              state: "ACCEPTED",
              operation: observation.operation,
              errorCodes: [],
              projectId,
              keySha256,
              record: observation.record,
            },
          ]
        : [];
      const baseline =
        previous.revision === 0
          ? { kind: "GENESIS" }
          : { kind: "RETAINED", ...previous };
      const contextSha256 = hashXlsxPreviewContext({
        request,
        previewReceiptId: receiptId,
        baseline,
        projectIds: [projectId],
        outcomes,
      });
      const base = invalidOverlay ? state.with(7, []) : state;
      const next = applyXlsxComparisonObservations(
        base,
        observation
          ? [[keySha256, recordId, projectId, observation.references]]
          : [],
      );
      const stateSha256 = sha256(next.text);
      const id = await audit(
        subject,
        "ingestion.xlsx_preview.persisted",
        {
          receiptId,
          kind: "XLSX_PREVIEW",
          sourceId,
          configRevision,
          mappingRevision,
          scopeProjectIds: [projectId],
          requestHash: requestSha256,
          outcomeCount: outcomes.length,
        },
        createdAt,
      );
      await client.query(
        `INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash",
        "configRevision","mappingRevision","outcomeCount","auditEventId","createdAt") VALUES ($1,$2,$3,$4,'XLSX_PREVIEW',$5,$6,$7,$8,$9,$10,$11)`,
        [
          receiptId,
          customerId,
          sourceId,
          subject,
          commandKey,
          requestSha256,
          configRevision,
          mappingRevision,
          outcomes.length,
          id,
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
        VALUES ($1,$2,$3,$4,$5,'pmo_admin','project',$4)`,
        [customerId, sourceId, receiptId, projectId, grants[0].id],
      );
      if (observation)
        await client.query(
          `INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,
        "projectId","recordKey","recordId","sourceRevisionId","projectionId") VALUES ($1,$2,$3,1,'ACCEPTED',$4,$5,$6,$7,$8,$9)`,
          [
            customerId,
            sourceId,
            receiptId,
            observation.operation,
            projectId,
            keySha256,
            recordId,
            observation.record.revisionId,
            observation.record.projectionId,
          ],
        );
      await client.query(
        `INSERT INTO public."IngestionXlsxContext" ("customerId","sourceId","receiptId",revision,"predecessorReceiptId",
        "predecessorRevision","predecessorSha256","workbookBytes","workbookSha256","contextSha256",rows,"canonicalBytes","stateSha256")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          customerId,
          sourceId,
          receiptId,
          previous.revision + 1,
          previous.receiptId,
          previous.revision,
          previous.stateSha256,
          request.workbookBytes,
          request.workbookSha256,
          contextSha256,
          JSON.stringify(next.state[7]),
          next.bytes,
          stateSha256,
        ],
      );
      previous = { receiptId, revision: previous.revision + 1, stateSha256 };
      state = next.state;
      return receiptId;
    };
    const date = (value) => ({
      factType: "project.forecast",
      value: { type: "date", value },
    });
    const first = await createObservation(
      "fixture-1",
      [
        date("2027-01-01"),
        {
          factType: "project.status",
          value: { type: "text", value: "On track" },
        },
      ],
      "CREATE",
    );
    const receipt1 = await recordPreview("fixture-preview-1", first);
    const update = await createObservation(
      "fixture-2",
      [date("2027-02-01")],
      "UPDATE",
    );
    await recordPreview("fixture-preview-2", update);
    assert.deepEqual(state[7][0][3], [
      ["0", update.record.projectionId],
      ["1", first.record.projectionId],
    ]);
    await client.query("SAVEPOINT workbook_overlay");
    await assert.rejects(
      recordPreview("fixture-preview-3", null, true),
      /Invalid workbook preview context/u,
    );
    await client.query(
      "ROLLBACK TO SAVEPOINT workbook_overlay; RELEASE SAVEPOINT workbook_overlay",
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS n FROM public."IngestionOperationReceipt" WHERE "sourceId"=$1`,
          [sourceId],
        )
      ).rows[0].n,
      2,
    );
    await recordPreview("fixture-preview-3", null);
    await client.query("SAVEPOINT workbook_lawful_redaction");
    const retentionSubject = subject + "-expiry-fixture";
    const changedAt = new Date();
    await client.query(
      `INSERT INTO public."AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role)
      VALUES ($1,$2,$3,'project',$4,'system_admin')`,
      [randomUUID(), customerId, retentionSubject, projectId],
    );
    const changed = await audit(
      retentionSubject,
      "ingestion.retention.changed",
      { retentionHours: 1, revision: policy.revision + 1 },
      changedAt,
    );
    await client.query(
      `UPDATE public."IngestionRetentionPolicy" SET "retentionHours"=1,revision=revision+1,"changedBy"=$2,
      "auditEventId"=$3,"changedAt"=$4 WHERE "customerId"=$1`,
      [customerId, retentionSubject, changed, changedAt],
    );
    const purge = await audit(
      retentionSubject,
      "ingestion.content.purged",
      { redactedCount: 2 },
      changedAt,
    );
    await client.query(
      `UPDATE public."IngestionProposalContent" SET proposals=NULL,"redactedAt"=$3,"redactionAuditEventId"=$4
      WHERE "customerId"=$1 AND "sourceId"=$2`,
      [customerId, sourceId, changedAt, purge],
    );
    await client.query("SET CONSTRAINTS ingestion_redaction_commit IMMEDIATE");
    await assertXlsxPreviewIntegrity(client);
    await assert.rejects(
      recordPreview("fixture-expired", null),
      /Workbook comparison content is unavailable/u,
    );
    await client.query(
      "ROLLBACK TO SAVEPOINT workbook_lawful_redaction; RELEASE SAVEPOINT workbook_lawful_redaction",
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await assertXlsxPreviewIntegrity(client);
    assert.equal(
      (
        await client.query(
          `SELECT public.valid_ingestion_xlsx_context($1) AS valid`,
          [receipt1],
        )
      ).rows[0].valid,
      true,
    );
    await client.query("COMMIT");
    return {
      nativeContexts: 3,
      valuedProjectionParity: true,
      partialCarryForward: true,
      forgedOverlayRollback: true,
      supersededReceiptValid: true,
      historicalProofSurvivesRedaction: true,
      freshPreviewRequiresLiveHistory: true,
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

export async function verifyNativeXlsxPreviewRestore(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertXlsxPreviewIntegrity(client);
    const snapshot = `SELECT "receiptId",revision,"contextSha256","stateSha256" FROM public."IngestionXlsxContext" ORDER BY revision`;
    const { rows: before } = await client.query(snapshot);
    assert.equal(before.length, 3);
    await client.query("SAVEPOINT workbook_restore_context");
    await client.query(
      `DELETE FROM public."AccessGrant" g USING public."IngestionReceiptProjectScope" captured
      WHERE captured."receiptId"=$1 AND captured."grantId"=g.id AND captured."customerId"=g."customerId"`,
      [before[0].receiptId],
    );
    await assertXlsxPreviewIntegrity(client);
    await client.query("ROLLBACK TO SAVEPOINT workbook_restore_context");
    await client.query(
      'ALTER TABLE public."IngestionXlsxContext" DISABLE TRIGGER ingestion_xlsx_context_immutable',
    );
    await client.query(
      `UPDATE public."IngestionXlsxContext" SET "contextSha256"=repeat('0',64) WHERE "receiptId"=$1`,
      [before[0].receiptId],
    );
    await assert.rejects(
      assertXlsxPreviewIntegrity(client),
      /Restored workbook previews are invalid/u,
    );
    await client.query("ROLLBACK TO SAVEPOINT workbook_restore_context");
    await client.query(
      'ALTER TABLE public."IngestionReceiptProjectScope" DISABLE TRIGGER ingestion_receipt_scope_guard',
    );
    await client.query(
      `UPDATE public."IngestionReceiptProjectScope" SET "grantScopeId"=$2
      WHERE "receiptId"=$1`,
      [before[0].receiptId, randomUUID()],
    );
    await assert.rejects(
      assertXlsxPreviewIntegrity(client),
      /Restored workbook previews are invalid/u,
    );
    await client.query("ROLLBACK");
    assert.deepEqual((await client.query(snapshot)).rows, before);
    await assertXlsxPreviewIntegrity(client);
    return {
      contextsVerified: 3,
      olderContextCorruptionDenied: true,
      historicalGrantScopeDriftDenied: true,
      historicalProofSurvivesGrantRevocation: true,
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

export async function verifyXlsxPreviewSerialization(pool) {
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    const { rows } =
      await pool.query(`SELECT r."customerId",r."sourceId",r.subject,r."configRevision",r."mappingRevision",r."auditEventId"
      FROM public."IngestionXlsxContext" c JOIN public."IngestionOperationReceipt" r ON r.id=c."receiptId"
      WHERE c.revision=3`);
    assert.equal(rows.length, 1);
    const receipt = rows[0];
    for (const client of [first, second])
      await client.query(
        "BEGIN; SET LOCAL ROLE pdaa_migrate; SET LOCAL statement_timeout='10s'",
      );
    const begin = (client) =>
      client.query(
        `INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,
      "commandKey","requestHash","configRevision","mappingRevision","outcomeCount","auditEventId")
      VALUES ($1,$2,$3,$4,'XLSX_PREVIEW',$5,$6,$7,$8,0,$9)`,
        [
          randomUUID(),
          receipt.customerId,
          receipt.sourceId,
          receipt.subject,
          randomUUID(),
          "a".repeat(64),
          receipt.configRevision,
          receipt.mappingRevision,
          receipt.auditEventId,
        ],
      );
    const firstPid = (await first.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const secondPid = (await second.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    await begin(first);
    const pending = begin(second).then(
      () => true,
      () => false,
    );
    let blocked = false;
    for (let attempt = 0; attempt < 50 && !blocked; attempt++) {
      blocked = (
        await pool.query(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
          [firstPid, secondPid],
        )
      ).rows[0].blocked;
      if (!blocked) await delay(20);
    }
    await first.query("ROLLBACK");
    assert.equal(
      await pending,
      true,
      "Concurrent workbook receipts should proceed serially",
    );
    assert.equal(
      blocked,
      true,
      "The second receipt must acquire the ordered workbook fences before row insertion",
    );
    await second.query("ROLLBACK");
    return { concurrentReceiptBirthSerialized: true };
  } finally {
    try {
      await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
    } finally {
      first.release();
      second.release();
    }
  }
}
