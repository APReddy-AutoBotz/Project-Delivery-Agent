// Synthetic source observations for the disposable acceptance databases.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { JiraRuntimeService } from "../../apps/api/dist/jira-runtime.js";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseConnectorRuntimeRepository,
  DatabaseIngestionRepository,
  DatabaseMilestoneReconciliationRepository,
  DatabaseProjectFactRepository,
} from "../../packages/data/dist/index.js";
import {
  CredentialKeyRingVault,
  CredentialVault,
} from "../../packages/platform/dist/index.js";
import { canonicalFixture } from "./canonical-projects.mjs";
import { proveXlsxSourceGenesis } from "./xlsx-source-genesis.mjs";

const manager = "pm-atlas";
const leader = "leader-atlas";
const pmo = "pmo-atlas";
const retentionAdmin = "synthetic-workbook-retention";
const admissionSubject = "synthetic:source-admission";
const readers = [pmo, manager, leader];
const sheet = "Portfolio";
const origin = "https://golden-fixture.atlassian.net";
const jiraProject = "GOLD";
const workKeys = ["WI-1", "WI-2", "WI-3"];
const jiraKeys = ["GOLD-11", "GOLD-12", "GOLD-13"];
const admission =
  "public.admit_source_observation(uuid,uuid,uuid,uuid,integer,text,uuid)";

function pmOffice(customerId) {
  return { customerId, subject: pmo, roles: ["pmo_admin"] };
}

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function captureLegacyProof(db, customerId, projectId) {
  const factType = "delivery.note";
  const context = { correlationId: randomUUID() };
  const fact = await new DatabaseProjectFactRepository(db).appendHumanStatement(
    pmOffice(customerId),
    {
      projectId,
      factType,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      effectiveAt: new Date().toISOString(),
      value: { type: "text", value: "Synthetic earlier human observation" },
      originalStatement: "Synthetic earlier human observation",
    },
    context,
  );
  const proof = await new DatabaseAuthorityRepository(db).captureAssessment(
    pmOffice(customerId),
    {
      projectId,
      factType,
      idempotencyKey: randomUUID(),
    },
    { correlationId: randomUUID() },
  );
  assert.equal(proof.visibility, "available");
  return {
    factId: fact.factId,
    assessmentId: proof.assessmentId,
    resultSha256: digest(proof.result),
  };
}

export async function prepareGoldenWorkbook(pool, database, customerId) {
  const db = createDatabase(database);
  try {
    const portfolio = await db.portfolio.create({
      data: {
        id: randomUUID(),
        customerId,
        name: "GOLDEN-003 source observations",
      },
    });
    await db.accessGrant.create({
      data: {
        customerId,
        subject: pmo,
        scopeType: "portfolio",
        scopeId: portfolio.id,
        role: "pmo_admin",
      },
    });
    const project = canonicalFixture(portfolio.id);
    project.code = "GOLDEN-003-" + randomUUID();
    project.name = "Source-backed milestone disagreement";
    project.responsibilities = [
      {
        role: "PROJECT_MANAGER",
        subject: manager,
        displayName: "Synthetic project manager",
      },
    ];
    project.workItems = workKeys.map((key) => ({
      ...project.workItems[0],
      key,
      title: "Mandatory Jira work " + key,
      state: "OPEN",
    }));
    project.requiredWorkItems = workKeys.map((workItemKey) => ({
      milestoneKey: "MS-1",
      workItemKey,
    }));
    project.raidItems = [];
    project.sourceMappings = [];
    const { id: projectId } = await new DatabaseCanonicalProjectRepository(
      db,
    ).createProject(pmOffice(customerId), project, randomUUID());
    await db.accessGrant.createMany({
      data: [
        { subject: manager, role: "project_manager" },
        { subject: leader, role: "leadership" },
        { subject: admissionSubject, role: "project_manager" },
      ].map((grant) => ({
        customerId,
        scopeType: "project",
        scopeId: projectId,
        ...grant,
      })),
    });

    await proveXlsxSourceGenesis(pool, {
      retain: true,
      existingCustomer: customerId,
      existingProject: projectId,
      sheet,
      parserContract: "portable-v1",
      snapshotRequired: true,
      reviewer: pmo,
      additionalReaders: [manager, leader, admissionSubject],
    });
    const { rows } = await pool.query(
      `SELECT c."sourceId" FROM public."IngestionConfigurationRevision" c
       JOIN public."IngestionConfigurationReader" r USING ("customerId","sourceId")
       WHERE c."customerId"=$1 AND r."projectId"=$2 AND r.subject=$3 AND c.mapping->>'sheet'=$4
         AND c.revision=r."configRevision" AND c.sealed`,
      [customerId, projectId, pmo, sheet],
    );
    assert.equal(rows.length, 1);
    const legacy = await captureLegacyProof(db, customerId, projectId);
    return { projectId, sourceId: rows[0].sourceId, sheet, legacy };
  } finally {
    await db.$disconnect();
  }
}

export async function ingestSyntheticJiraIssues(db, {
  actor, projectId, origin, jiraProject, readers, issues,
}) {
  const { customerId } = actor;
  const sourceId = randomUUID();
  const key = randomBytes(32).toString("base64");
  const keyId = "golden-source-fixture";
  const runtime = new DatabaseConnectorRuntimeRepository(
    db,
    new CredentialKeyRingVault({ currentKeyId: keyId, keys: { [keyId]: key } }),
  );
  const ingestion = new DatabaseIngestionRepository(
    db,
    new CredentialVault(key),
  );
  await ingestion.configure(
    actor,
    {
      binding: { customerId, sourceId, sourceType: "jira", origin },
      projects: [{ projectId, readers }],
      mapping: {
        kind: "CONNECTOR",
        factTypes: ["jira.status"],
        adapterConfiguration: JSON.stringify({
          projects: [{ projectId, projectKey: jiraProject }],
          fields: [
            { jiraField: "status", factType: "jira.status", valueType: "text" },
          ],
        }),
      },
    },
    randomUUID(),
  );
  await runtime.setOAuthCredential({
    customerId,
    sourceId,
    actorSubject: actor.subject,
    credential: {
      cloudId: "golden-cloud",
      selectedUrl: origin,
      accessToken: "synthetic-golden-access",
      refreshToken: "synthetic-golden-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["read:jira-work", "offline_access"],
    },
  });

  const calls = [];
  const service = new JiraRuntimeService(
    { CUSTOMER_ID: customerId },
    runtime,
    ingestion,
    async (url, init) => {
      assert.equal(
        String(url),
        "https://api.atlassian.com/oauth/token/accessible-resources",
      );
      assert.equal(init?.method ?? "GET", "GET");
      calls.push("resources");
      return globalThis.Response.json([
        { id: "golden-cloud", url: origin, scopes: ["read:jira-work"] },
      ]);
    },
    ({ cloudId }) => {
      assert.equal(cloudId, "golden-cloud");
      return {
        async getProject({ projectIdOrKey }) {
          assert.equal(projectIdOrKey, jiraProject);
          calls.push("project");
          return { key: jiraProject };
        },
        async searchIssues({ jql, fields }) {
          assert(jql.includes(JSON.stringify(jiraProject)));
          assert(fields.includes("status"));
          calls.push("issues");
          return {
            isLast: true,
            issues,
          };
        },
      };
    },
  );
  // Match claim eligibility to the database clock in both test profiles.
  const [{ scheduledAt }] = await db.$queryRaw`
    SELECT date_trunc('milliseconds', clock_timestamp()) - interval '1 second' AS "scheduledAt"`;
  const jobs = await runtime.enqueueDueJobs(customerId, 15, 20, scheduledAt);
  assert.equal(jobs.length, 1);
  assert.deepEqual(await service.runOne(), { status: "cursor_reset" });
  const [{ delay }] = await db.$queryRaw`
    SELECT greatest(0, ceil(extract(epoch FROM ("availableAt" - clock_timestamp())) * 1000))::integer AS delay
    FROM public."ConnectorSyncJob"
    WHERE ("customerId","sourceId",id)=(${customerId}::uuid,${sourceId}::uuid,${jobs[0]}::uuid)
      AND "resetCompleted" AND state='READY'`;
  assert(delay <= 5000);
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const nonce = randomUUID();
  assert(
    await runtime.acceptTaskNonce({
      nonce,
      keyId,
      timestampSeconds: String(Math.floor(Date.now() / 1000)),
      body: Buffer.from("{}"),
      dispatchCustomerId: customerId,
    }),
  );
  assert.deepEqual(await service.runOne(nonce), { status: "page_committed" });
  assert.deepEqual(calls, ["resources", "project", "issues"]);
  const [{ receiptId }] = await db.$queryRaw`
    SELECT "lastSuccessReceiptId" AS "receiptId" FROM public."IngestionSource"
    WHERE "customerId"=${customerId}::uuid AND id=${sourceId}::uuid AND "cursorState"='TERMINAL'`;
  assert(receiptId);
  return { sourceId, receiptId };
}

async function requiredTargets(pool, customerId, projectId) {
  const { rows } = await pool.query(
    `SELECT r."milestoneId",w.id AS "workItemId",w.key
     FROM public."RequiredWorkItem" r
     JOIN public."CanonicalProject" canonical ON (canonical."customerId",canonical.id)=(r."customerId",r."projectId")
     JOIN public."Project" p ON (p."customerId",p.id)=(canonical."customerId",canonical.id)
     JOIN public."WorkItem" w ON (w."customerId",w."projectId",w.id)=(r."customerId",r."projectId",r."workItemId")
     WHERE (r."customerId",r."projectId")=($1,$2) AND canonical.sealed AND p.code LIKE 'GOLDEN-003-%'
     ORDER BY w.key`,
    [customerId, projectId],
  );
  assert.deepEqual(
    rows.map(({ key }) => key),
    workKeys,
  );
  assert.equal(new Set(rows.map(({ milestoneId }) => milestoneId)).size, 1);
  return rows;
}

async function projectedInputs(pool, customerId, fixture, jiraSourceId) {
  const { rows } = await pool.query(
    `SELECT r.id AS "receiptId",o.ordinal,r.kind,rec."recordKey",s.id AS "streamId",
       o."sourceRevisionId",x."workbookSha256",public.valid_connector_page_dispatch(r.id) AS dispatch
     FROM public."IngestionOperationReceipt" r
     JOIN public."IngestionRowOutcome" o ON (o."customerId",o."sourceId",o."receiptId")=(r."customerId",r."sourceId",r.id)
     JOIN public."IngestionExternalRecord" rec ON (rec."customerId",rec."sourceId",rec.id)=(o."customerId",o."sourceId",o."recordId")
     JOIN public."IngestionFactStream" s ON (s."customerId",s."sourceId",s."recordId")=(rec."customerId",rec."sourceId",rec.id)
     LEFT JOIN public."IngestionReviewedImport" reviewed
       ON (reviewed."customerId",reviewed."sourceId",reviewed."receiptId")=(r."customerId",r."sourceId",r.id)
     LEFT JOIN public."IngestionXlsxContext" x
       ON (x."customerId",x."sourceId",x."receiptId")=(reviewed."customerId",reviewed."sourceId",reviewed."previewReceiptId")
     WHERE r."customerId"=$1 AND o."projectId"=$2 AND o.state='ACCEPTED'
       AND ((r."sourceId"=$3 AND r.kind='XLSX_REVIEWED_IMPORT' AND r.id=$4 AND s."factType"='project.status')
         OR (r."sourceId"=$5 AND r.kind='CONNECTOR_PAGE' AND s."factType"='jira.status'))
     ORDER BY r.kind,rec."recordKey"`,
    [
      customerId,
      fixture.projectId,
      fixture.sourceId,
      fixture.reviewedReceiptId,
      jiraSourceId,
    ],
  );
  const jira = rows.filter(({ kind }) => kind === "CONNECTOR_PAGE");
  const workbook = rows.filter(({ kind }) => kind === "XLSX_REVIEWED_IMPORT");
  assert.deepEqual(
    jira.map(({ recordKey }) => recordKey),
    jiraKeys,
  );
  assert.equal(new Set(jira.map(({ receiptId }) => receiptId)).size, 1);
  assert(jira.every(({ dispatch }) => dispatch));
  assert.equal(workbook.length, 1);
  assert.equal(workbook[0].ordinal, 1);
  assert.equal(workbook[0].workbookSha256, fixture.workbookSha256);
  return { jira, workbook: workbook[0] };
}

async function ageReviewedWorkbook(pool, customerId, fixture, workbook) {
  const tx = await pool.connect();
  try {
    await tx.query(
      "BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL ROLE pdaa_migrate",
    );
    const revisionGuard = `SELECT tgenabled AS enabled FROM pg_trigger
      WHERE tgrelid='public."IngestionSourceRevision"'::regclass AND tgname='ingestion_revision_guard' AND NOT tgisinternal`;
    assert.deepEqual((await tx.query(revisionGuard)).rows, [{ enabled: "O" }]);
    // Stage the exact reviewed synthetic revision before admission. The schema
    // fence and the timestamp change are atomic, and expiry uses the real clock.
    await tx.query(
      'ALTER TABLE public."IngestionSourceRevision" DISABLE TRIGGER ingestion_revision_guard',
    );
    const changed = await tx.query(
      `UPDATE public."IngestionSourceRevision" v
        SET "receivedAt"=date_trunc('milliseconds',clock_timestamp()-interval '2 hours')
        FROM public."IngestionRowOutcome" o
        WHERE (v."customerId",v."sourceId",v."recordId",v.id)=(o."customerId",o."sourceId",o."recordId",o."sourceRevisionId")
          AND (o."customerId",o."sourceId",o."projectId",o."receiptId",o.ordinal,o."sourceRevisionId")=($1,$2,$3,$4,1,$5)
          AND o.state='ACCEPTED' AND v."receivedAt">clock_timestamp()-interval '1 hour'
          AND NOT EXISTS (SELECT 1 FROM public."SourceObservationWitness" w
            WHERE (w."customerId",w."projectId",w."sourceRevisionId")=(o."customerId",o."projectId",v.id))`,
      [
        customerId,
        fixture.sourceId,
        fixture.projectId,
        workbook.receiptId,
        workbook.sourceRevisionId,
      ],
    );
    assert.equal(changed.rowCount, 1);
    await tx.query(
      'ALTER TABLE public."IngestionSourceRevision" ENABLE TRIGGER ingestion_revision_guard',
    );
    assert.deepEqual((await tx.query(revisionGuard)).rows, [{ enabled: "O" }]);
    await tx.query("COMMIT");
  } finally {
    try {
      await tx.query("ROLLBACK");
    } finally {
      tx.release();
    }
  }
}

export async function admitSyntheticSourceInputs(pool, customerId, projectId, actorSubject, inputs) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN; SET LOCAL ROLE pdaa_migrate");
    const approvals = [];
    for (const input of inputs) {
      const source = randomUUID();
      const { rows } = await tx.query(
        `SELECT public.approve_source_observation(
          $1::uuid,$2::uuid,NULL::uuid,$3::uuid,$4::uuid,$5::text,$6::jsonb,$7::jsonb,$8::text,0,$9::text,$10::uuid
        ) AS id`,
        [
          customerId,
          projectId,
          input.streamId,
          source,
          input.snapshotField,
          JSON.stringify(input.states),
          {
            conflictBehavior: "REQUEST_RECONCILIATION",
            tiers: [
              {
                selectors: [
                  {
                    sourceType: input.type,
                    instanceId: source,
                    requiredApproval: "APPROVED",
                    validity: {
                      basis:
                        input.type === "jira" ? "observedAt" : "effectiveAt",
                      durationMs: 86_400_000,
                    },
                  },
                ],
              },
            ],
          },
          actorSubject,
          input.targetKind,
          input.targetId,
        ],
      );
      assert(rows[0].id);
      approvals.push({ ...input, source, approval: rows[0].id });
    }
    await tx.query("RESET ROLE");
    // This role exists only inside the owned synthetic transaction. All native
    // proof triggers still run, including deferred checks at COMMIT.
    await tx.query(`CREATE ROLE pdaa_source_acceptance NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO pdaa_source_acceptance;
      GRANT EXECUTE ON FUNCTION ${admission} TO pdaa_source_acceptance;
      SET LOCAL SESSION AUTHORIZATION pdaa_source_acceptance`);
    const admitted = [];
    for (const input of approvals) {
      const args = [
        customerId,
        projectId,
        input.approval,
        input.receiptId,
        input.ordinal,
        randomUUID(),
        randomUUID(),
      ];
      const record = `SELECT public.admit_source_observation($1,$2,$3,$4,$5,$6,$7) AS result`;
      const {
        rows: [{ result }],
      } = await tx.query(record, args);
      assert.equal(result.status, "ADMITTED");
      assert.deepEqual((await tx.query(record, args)).rows, [
        { result: { ...result, status: "REPLAYED" } },
      ]);
      admitted.push({ ...input, admissionReceiptId: result.receiptId });
    }
    await tx.query(`RESET SESSION AUTHORIZATION;
      REVOKE ALL ON FUNCTION ${admission} FROM pdaa_source_acceptance;
      REVOKE USAGE ON SCHEMA public FROM pdaa_source_acceptance;
      DROP ROLE pdaa_source_acceptance; COMMIT`);
    return admitted;
  } finally {
    try {
      await tx.query("ROLLBACK");
    } finally {
      tx.release();
    }
  }
}

export async function admitGoldenSources(pool, database, customerId, fixture) {
  assert.match(fixture.workbookSha256, /^[a-f0-9]{64}$/u);
  const targets = await requiredTargets(pool, customerId, fixture.projectId);
  const milestoneId = targets[0].milestoneId;
  const db = createDatabase(database);
  try {
    const updated = new Date(Date.now() - 30_000).toISOString();
    const { sourceId: jiraSourceId } = await ingestSyntheticJiraIssues(db, {
      actor: pmOffice(customerId), projectId: fixture.projectId, origin, jiraProject,
      readers: [...readers, admissionSubject],
      issues: jiraKeys.map((key, index) => ({
        id: String(95011 + index), key,
        fields: { project: { id: "950", key: jiraProject }, updated, status: { name: "To Do" } },
      })),
    });
    const { jira, workbook } = await projectedInputs(
      pool,
      customerId,
      fixture,
      jiraSourceId,
    );
    await ageReviewedWorkbook(pool, customerId, fixture, workbook);
    const admitted = await admitSyntheticSourceInputs(pool, customerId, fixture.projectId, pmo, [
      ...jira.map((input, index) => ({
        ...input,
        targetKind: "WORK_ITEM",
        targetId: targets[index].workItemId,
        type: "jira",
        states: { "To Do": "OPEN" },
        snapshotField: null,
      })),
      {
        ...workbook,
        targetKind: "MILESTONE",
        targetId: milestoneId,
        type: "xlsx",
        states: { Complete: "COMPLETE" },
        snapshotField: "source.snapshot_at",
      },
    ]);
    const facts = new DatabaseProjectFactRepository(db);
    const positions = [];
    for (const entry of admitted) {
      const grant = await facts.setSourceAccess(
        pmOffice(customerId),
        {
          projectId: fixture.projectId,
          sourceId: entry.source,
          expectedRevision: 1,
          state: "AVAILABLE",
          readers,
        },
        { correlationId: randomUUID() },
      );
      const command = await db.sourceAdmissionCommand.findUniqueOrThrow({
        where: { id: entry.admissionReceiptId },
      });
      const version = await db.projectFactVersion.findUniqueOrThrow({
        where: { id: command.versionId },
        include: { fact: { select: { factType: true } } },
      });
      assert.equal(version.provenance, "SYSTEM_VERIFIED");
      assert.equal(command.inputReceiptId, entry.receiptId);
      positions.push({
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        type: entry.type === "jira" ? "jira.issue" : "xlsx.row",
        state: entry.type === "jira" ? "OPEN" : "COMPLETE",
        versionId: command.versionId,
        factType: version.fact.factType,
        sourceId: entry.source,
        sourceAccessRevision: grant.revision,
      });
    }
    return {
      projectId: fixture.projectId,
      milestoneId,
      jiraSourceId,
      positions,
      legacy: fixture.legacy,
    };
  } finally {
    await db.$disconnect();
  }
}

export async function changeGoldenJiraScope(pool, customerId, fixture, active) {
  await requiredTargets(pool, customerId, fixture.projectId);
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN; SET LOCAL SESSION AUTHORIZATION pdaa_api");
    const { rows } = await tx.query(
      `SELECT id,"configRevision",revision,active FROM public."ConnectorSyncGrant"
       WHERE ("customerId","projectId","sourceId")=($1,$2,$3) FOR UPDATE`,
      [customerId, fixture.projectId, fixture.jiraSourceId],
    );
    assert.equal(rows.length, 1);
    const grant = rows[0];
    assert.equal(grant.active, !active);
    const audit = randomUUID();
    const occurredAt = new Date();
    const revision = grant.revision + 1;
    await tx.query(
      `INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        audit,
        customerId,
        pmo,
        active
          ? "ingestion.sync_scope.granted"
          : "ingestion.sync_scope.revoked",
        randomUUID(),
        occurredAt,
        {
          sourceId: fixture.jiraSourceId,
          projectId: fixture.projectId,
          configRevision: grant.configRevision,
          revision,
          active,
        },
      ],
    );
    assert.equal(
      (
        await tx.query(
          `UPDATE public."ConnectorSyncGrant" SET active=$1,revision=$2,"changedAt"=$3,"changedBy"=$4,"auditEventId"=$5
       WHERE ("customerId","projectId","sourceId",id)=($6,$7,$8,$9)`,
          [
            active,
            revision,
            occurredAt,
            pmo,
            audit,
            customerId,
            fixture.projectId,
            fixture.jiraSourceId,
            grant.id,
          ],
        )
      ).rowCount,
      1,
    );
    await tx.query("COMMIT");
    return { active };
  } finally {
    try {
      await tx.query("ROLLBACK");
    } finally {
      tx.release();
    }
  }
}

export async function purgeGoldenWorkbook(pool, database, customerId, fixture) {
  await requiredTargets(pool, customerId, fixture.projectId);
  const db = createDatabase(database);
  try {
    const api = {
      $transaction: (operation, options) =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL SESSION AUTHORIZATION pdaa_api`;
          return operation(tx);
        }, options),
    };
    const repository = new DatabaseIngestionRepository(
      api,
      new CredentialVault(randomBytes(32).toString("base64")),
    );
    const actor = {
      customerId,
      subject: retentionAdmin,
      roles: ["system_admin"],
    };
    assert.equal(await repository.purgeExpired(actor), 0);
    await repository.setRetention(actor, { retentionHours: 1 }, randomUUID());
    assert.equal(await repository.purgeExpired(actor), 1);
    assert.equal(await repository.purgeExpired(actor), 0);
    return { redactedProposals: 1 };
  } finally {
    await db.$disconnect();
  }
}

export async function verifyGoldenProof(pool, customerId, expected) {
  const targets = await requiredTargets(pool, customerId, expected.projectId);
  assert.equal(targets[0].milestoneId, expected.milestoneId);
  const {
    rows: [written],
  } = await pool.query(
    `WITH scoped AS (
       SELECT id,"originalAssessmentId" FROM public."MilestoneReconciliationRequest"
       WHERE ("customerId","projectId","milestoneId")=($1,$2,$3)
     )
     SELECT
      (SELECT array_agg(id) FROM scoped) AS requests,
      (SELECT bool_and(public.valid_milestone_reconciliation_request(id)) FROM scoped) AS request_valid,
      (SELECT array_agg(c.id ORDER BY c.outcome) FROM public."MilestoneReconciliationCheck" c JOIN scoped s ON s.id=c."requestId") AS checks,
      (SELECT bool_and(public.valid_milestone_reconciliation_check(c.id)) FROM public."MilestoneReconciliationCheck" c JOIN scoped s ON s.id=c."requestId") AS checks_valid,
      (SELECT array_agg(a."recipientSubject" ORDER BY a.revision) FROM public."MilestoneReconciliationAssignment" a JOIN scoped s ON s.id=a."requestId") AS recipients,
      (SELECT array_agg(c."versionId" ORDER BY c."versionId") FROM public."MilestoneConsistencyContributorVersion" c JOIN scoped s ON s."originalAssessmentId"=c."assessmentId") AS versions,
      (SELECT count(*)::int FROM public."FactAssessment" f JOIN scoped s ON s."originalAssessmentId"=f."milestoneAssessmentId"
        WHERE f."evaluatorVersion"=2 AND f.sealed AND public.valid_fact_assessment(f.id)) AS mixed,
      (SELECT count(*)::int FROM public."FactAssessment" WHERE id=$4 AND "factId"=$5 AND "evaluatorVersion"=1 AND sealed AND public.valid_fact_assessment(id)) AS legacy,
      (SELECT count(*)::int FROM public."SourceObservationWitness" WHERE ("customerId","projectId")=($1,$2)
        AND public.valid_source_observation_witness("versionId")) AS witnesses,
      NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pdaa_source_acceptance') AS capability_absent`,
    [
      customerId,
      expected.projectId,
      expected.milestoneId,
      expected.legacy.assessmentId,
      expected.legacy.factId,
    ],
  );
  assert.deepEqual(written, {
    requests: [expected.requestId],
    request_valid: true,
    checks: [expected.checkId, expected.reusedCheckId],
    checks_valid: true,
    recipients: [manager],
    versions: expected.positions.map((position) => position.versionId).sort(),
    mixed: 4,
    legacy: 1,
    witnesses: 4,
    capability_absent: true,
  });
  const origins =
    "public.read_source_authority_origins(uuid,uuid,text,text[],uuid[])";
  const { rows: permissions } = await pool.query(
    `SELECT wanted.signature, p.proowner=to_regrole('pdaa_migrate') AS owner,
       ARRAY(SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
         FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
         WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE' ORDER BY a.grantee) AS executors,
       EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
         WHERE a.grantee<>p.proowner AND a.is_grantable) AS grantable
     FROM unnest($1::text[]) WITH ORDINALITY AS wanted(signature, ordinal)
     JOIN pg_proc p ON p.oid=to_regprocedure(wanted.signature) ORDER BY wanted.ordinal`,
    [[admission, origins]],
  );
  assert.deepEqual(permissions, [
    { signature: admission, owner: true, executors: [], grantable: false },
    {
      signature: origins,
      owner: true,
      executors: ["pdaa_api"],
      grantable: false,
    },
  ]);
  const workbook = expected.positions.find(({ type }) => type === "xlsx.row");
  assert(workbook);
  const { rows: purged } = await pool.query(
    `SELECT c.proposals IS NULL AND c."redactedAt" IS NOT NULL AS redacted,
       a.event='ingestion.content.purged' AND a.actor=$4
         AND a.detail=jsonb_build_object('redactedCount',1) AS audited,
       public.resolve_source_observation_input(w."customerId",w."projectId",b."ingestionSourceId",
         w."ingestionStreamId",command."inputReceiptId",command.ordinal,b."snapshotField",b."stateMapping") IS NULL AS no_source_input,
       public.valid_source_observation_witness(w."versionId") AS witness_valid
     FROM public."SourceObservationWitness" w
     JOIN public."SourceAdmissionBindingRevision" b ON b.id=w."admissionRevisionId"
     JOIN public."SourceAdmissionCommand" command ON command.id=w."rootCommandId"
     JOIN public."IngestionProposalContent" c ON (c."customerId",c."sourceId",c."projectionId")
       =(w."customerId",b."ingestionSourceId",(w.input->>'projectionId')::uuid)
     JOIN public."AuditEvent" a ON (a."customerId",a.id)=(c."customerId",c."redactionAuditEventId")
     WHERE (w."customerId",w."projectId",w."versionId")=($1,$2,$3) AND b."sourceKind"='xlsx.row'`,
    [customerId, expected.projectId, workbook.versionId, retentionAdmin],
  );
  assert.deepEqual(purged, [
    {
      redacted: true,
      audited: true,
      no_source_input: true,
      witness_valid: true,
    },
  ]);
  return {
    verifiedSourceWitnesses: 4,
    durablePmRequests: 1,
    verifiedChecks: 2,
    legacyProofs: 1,
    redactedProposals: 1,
  };
}

// Use the API database principal while CONNECT stays revoked and the application stays stopped.
export async function verifyGoldenQuarantineDelivery(
  database,
  customerId,
  fixture,
) {
  const db = createDatabase(database);
  try {
    const api = {
      $transaction: (operation, options) =>
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL SESSION AUTHORIZATION pdaa_api`;
          const [boundary] = await tx.$queryRaw`
        SELECT session_user::text AS principal, has_database_privilege(current_database(), 'CONNECT') AS connect`;
          assert.deepEqual(boundary, { principal: "pdaa_api", connect: false });
          return operation(tx);
        }, options),
    };
    const authorized = {
      customerId,
      subject: manager,
      roles: ["project_manager"],
    };
    const unauthorized = { customerId, subject: leader, roles: ["leadership"] };
    const requests = new DatabaseMilestoneReconciliationRepository(api);
    const target = {
      projectId: fixture.projectId,
      requestId: fixture.requestId,
    };
    const delivery = await requests.get(authorized, target);
    assert.equal(delivery?.request.id, fixture.requestId);
    assert.equal(delivery.assessment.visibility, "available");
    assert.equal(delivery.assessment.result.status, "CONFLICTING");
    assert.deepEqual(
      delivery.assessment.result.contributors
        .flatMap(({ supportingVersionIds }) => supportingVersionIds)
        .sort(),
      fixture.positions.map(({ versionId }) => versionId).sort(),
    );
    assert.equal(await requests.get(unauthorized, target), null);
    const replay = await requests.check(pmOffice(customerId), fixture.command, {
      correlationId: randomUUID(),
    });
    assert.equal(replay.checkId, fixture.checkId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.assessment, {
      ...delivery.assessment,
      replayed: true,
    });
    const legacy = await new DatabaseAuthorityRepository(api).getAssessment(
      pmOffice(customerId),
      {
        projectId: fixture.projectId,
        assessmentId: fixture.legacy.assessmentId,
      },
    );
    assert.equal(legacy?.visibility, "available");
    assert.equal(digest(legacy.result), fixture.legacy.resultSha256);
    return {
      scopedPmRedelivery: true,
      deniedNonRecipient: true,
      exactReplay: true,
      priorLegacyProofUnchanged: true,
    };
  } finally {
    await db.$disconnect();
  }
}
