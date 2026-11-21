// GOLDEN-003 fixture. Only the disposable customer proof image runs this code.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { JiraRuntimeService } from "../../apps/api/dist/jira-runtime.js";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseConnectorRuntimeRepository,
  DatabaseIngestionRepository,
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

export async function prepareGoldenWorkbook(pool, database, customerId) {
  const db = createDatabase(database);
  try {
    const portfolio = await db.portfolio.create({
      data: { id: randomUUID(), customerId, name: "GOLDEN-003 source observations" },
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
    return { projectId, sourceId: rows[0].sourceId, sheet };
  } finally {
    await db.$disconnect();
  }
}

async function readJiraIssues(db, customerId, projectId) {
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
    pmOffice(customerId),
    {
      binding: { customerId, sourceId, sourceType: "jira", origin },
      projects: [{ projectId, readers: [...readers, admissionSubject] }],
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
    actorSubject: pmo,
    credential: {
      cloudId: "golden-cloud",
      selectedUrl: origin,
      accessToken: "synthetic-golden-access",
      refreshToken: "synthetic-golden-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["read:jira-work", "offline_access"],
    },
  });

  const updated = new Date(Date.now() - 30_000).toISOString();
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
          assert(jql.includes('"GOLD"'));
          assert(fields.includes("status"));
          calls.push("issues");
          return {
            isLast: true,
            issues: jiraKeys.map((issue, index) => ({
              id: String(95011 + index),
              key: issue,
              fields: {
                project: { id: "950", key: jiraProject },
                updated,
                status: { name: "To Do" },
              },
            })),
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
  return sourceId;
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
       x."workbookSha256",public.valid_connector_page_dispatch(r.id) AS dispatch
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

async function admitInputs(pool, customerId, projectId, inputs) {
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
          pmo,
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
    const jiraSourceId = await readJiraIssues(
      db,
      customerId,
      fixture.projectId,
    );
    const { jira, workbook } = await projectedInputs(
      pool,
      customerId,
      fixture,
      jiraSourceId,
    );
    const admitted = await admitInputs(pool, customerId, fixture.projectId, [
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
    const legacy = await facts.appendHumanStatement(
      pmOffice(customerId),
      {
        projectId: fixture.projectId,
        factType: "delivery.note",
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        effectiveAt: new Date().toISOString(),
        value: { type: "text", value: "Synthetic earlier human observation" },
        originalStatement: "Synthetic earlier human observation",
      },
      { correlationId: randomUUID() },
    );
    const legacyProof = await new DatabaseAuthorityRepository(
      db,
    ).captureAssessment(
      pmOffice(customerId),
      {
        projectId: fixture.projectId,
        factType: "delivery.note",
        idempotencyKey: randomUUID(),
      },
      { correlationId: randomUUID() },
    );
    return {
      projectId: fixture.projectId,
      milestoneId,
      jiraSourceId,
      positions,
      legacy: { factId: legacy.factId, assessmentId: legacyProof.assessmentId },
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
  return {
    verifiedSourceWitnesses: 4,
    durablePmRequests: 1,
    verifiedChecks: 2,
    legacyProofs: 1,
  };
}
