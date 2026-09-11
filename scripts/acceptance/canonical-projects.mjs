// INT-MOD-001 synthetic aggregate shared by executable database and packaged checks.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
export const canonicalTables = [
  "Programme",
  "CanonicalProject",
  "ProjectResponsibility",
  "Sprint",
  "Milestone",
  "WorkItem",
  "RequiredWorkItem",
  "RaidItem",
  "CanonicalSourceMapping",
  "CanonicalCreationReceipt",
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
export async function canonicalProjection(pool) {
  const rows = {};
  for (const table of canonicalTables)
    rows[table] = (
      await pool.query(
        `SELECT * FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
      )
    ).rows;
  return rows;
}
export async function verifyCanonicalIntegrity(pool) {
  guard();
  assert.equal(
    (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM "Programme" WHERE NOT valid_canonical_programme(id))+(SELECT count(*)::int FROM "CanonicalProject" WHERE NOT sealed OR NOT valid_canonical_project(id)) AS invalid`,
      )
    ).rows[0].invalid,
    0,
  );
  return true;
}
export async function verifyCanonicalPrivileges(pool) {
  guard();
  for (const table of canonicalTables) {
    assert.equal(
      (
        await pool.query(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid=$1::regclass",
          ['"' + table + '"'],
        )
      ).rows[0].owner,
      "pdaa_migrate",
    );
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
          role === "pdaa_backup"
            ? privilege === "SELECT"
            : role === "pdaa_api" && ["SELECT", "INSERT"].includes(privilege);
        assert.equal(
          (
            await pool.query(
              "SELECT has_table_privilege($1,$2,$3) AS allowed",
              [role, '"' + table + '"', privilege],
            )
          ).rows[0].allowed,
          allowed,
          role + "/" + table + "/" + privilege,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT has_table_privilege($1,$2,$3) AS allowed",
              [role, '"' + table + '"', privilege + " WITH GRANT OPTION"],
            )
          ).rows[0].allowed,
          false,
        );
      }
      const columns = (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
          [table],
        )
      ).rows;
      for (const { column_name } of columns)
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          const allowed =
            role === "pdaa_backup"
              ? privilege === "SELECT"
              : role === "pdaa_api" &&
                (["SELECT", "INSERT"].includes(privilege) ||
                  (privilege === "UPDATE" &&
                    table === "CanonicalProject" &&
                    column_name === "sealed"));
          assert.equal(
            (
              await pool.query(
                "SELECT has_column_privilege($1,$2,$3,$4) AS allowed",
                [role, '"' + table + '"', column_name, privilege],
              )
            ).rows[0].allowed,
            allowed,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT has_column_privilege($1,$2,$3,$4) AS allowed",
                [
                  role,
                  '"' + table + '"',
                  column_name,
                  privilege + " WITH GRANT OPTION",
                ],
              )
            ).rows[0].allowed,
            false,
          );
        }
    }
  }
  const names = [
    "valid_canonical_programme",
    "valid_canonical_project",
    "reject_canonical_mutation",
    "guard_canonical_child_insert",
    "guard_canonical_receipt_insert",
    "guard_canonical_project",
    "check_canonical_commit",
    "guard_canonical_base_project",
  ];
  const functions = (
    await pool.query(
      "SELECT p.proname,p.prosecdef,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1)",
      [names],
    )
  ).rows;
  assert.equal(functions.length, names.length);
  assert(
    functions.every((row) => !row.prosecdef && row.owner === "pdaa_migrate"),
  );
  return true;
}
async function rejected(pool, sql, args = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(() => client.query(sql, args));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
export async function verifyCanonicalImmutable(pool) {
  guard();
  for (const table of canonicalTables) {
    assert(
      (await pool.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]
        .n > 0,
    );
    await rejected(pool, `UPDATE "${table}" SET id=id`);
    await rejected(pool, `DELETE FROM "${table}"`);
    await rejected(pool, `TRUNCATE "${table}" CASCADE`);
  }
  const parent = (
    await pool.query('SELECT * FROM "CanonicalProject" ORDER BY id LIMIT 1')
  ).rows[0];
  await rejected(
    pool,
    'UPDATE "CanonicalProject" SET sealed=false WHERE id=$1',
    [parent.id],
  );
  await rejected(pool, "UPDATE \"Project\" SET name='Changed' WHERE id=$1", [
    parent.id,
  ]);
  await rejected(
    pool,
    'INSERT INTO "Sprint" (id,"customerId","projectId",key,name) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), parent.customerId, parent.id, "LATE", "Late insert"],
  );
  return true;
}
export async function verifyCanonicalWorkerDenials(connection) {
  guard();
  const { Pool } = await import("./common.mjs");
  const pool = new Pool(connection);
  try {
    assert.equal(
      (await pool.query("SELECT current_user AS role")).rows[0].role,
      "pdaa_worker",
    );
    for (const table of canonicalTables)
      await assert.rejects(
        () => pool.query(`SELECT count(*) FROM "${table}"`),
        (error) => error.code === "42501",
      );
    return true;
  } finally {
    await pool.end();
  }
}
export async function seedCanonicalHistory(
  owner,
  connection,
  customerId,
  existingProjectId,
  prefix,
) {
  guard();
  const { createDatabase, DatabaseCanonicalProjectRepository } = await import(
    "../../packages/data/dist/index.js"
  );
  const portfolioId = (
    await owner.query(
      'SELECT "portfolioId" FROM "Project" WHERE id=$1 AND "customerId"=$2',
      [existingProjectId, customerId],
    )
  ).rows[0].portfolioId;
  const subject = prefix + "-canonical-" + randomUUID();
  const actor = { customerId, subject, roles: ["portfolio_manager"] };
  const insertGrant = async (who, scopeType, scopeId, role) =>
    owner.query(
      'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), customerId, who, scopeType, scopeId, role],
    );
  await insertGrant(subject, "portfolio", portfolioId, "portfolio_manager");
  const db = createDatabase(connection);
  try {
    const runtimeRole = (await db.$queryRaw`SELECT current_user AS role`)[0]
      .role;
    assert.equal(runtimeRole, "pdaa_api");
    const repository = new DatabaseCanonicalProjectRepository(db),
      context = randomUUID();
    const programmeInput = {
      code: "P-" + randomUUID(),
      name: "Synthetic canonical programme",
      idempotencyKey: randomUUID(),
    };
    const programme = await repository.createProgramme(
      actor,
      portfolioId,
      programmeInput,
      context,
    );
    assert.deepEqual(
      await repository.createProgramme(
        actor,
        portfolioId,
        programmeInput,
        context,
      ),
      programme,
    );
    const input = canonicalFixture(portfolioId, programme.id);
    const created = await repository.createProject(actor, input, context);
    assert.deepEqual(
      await repository.createProject(actor, input, context),
      created,
    );
    const detail = await repository.detail(actor, created.id);
    assert.equal(detail.configured, true);
    assert.deepEqual(detail.dates, input.dates);
    for (const key of ["code", "name", "description", "reportedStatus"])
      assert.equal(detail[key], input[key]);
    assert.equal(detail.programme.id, programme.id);
    assert.equal(detail.sourceMappingsWithheld, false);
    const collections = [
      "responsibilities",
      "sprints",
      "milestones",
      "workItems",
      "requiredWorkItems",
      "raidItems",
      "sourceMappings",
    ];
    const ordered = (rows) =>
      rows
        .map(({ id: _id, ...row }) => row)
        .sort((a, b) =>
          String(
            a.key ?? a.role ?? a.externalId ?? a.milestoneKey,
          ).localeCompare(
            String(b.key ?? b.role ?? b.externalId ?? b.milestoneKey),
          ),
        );
    for (const key of collections)
      assert.deepEqual(
        ordered(detail[key]),
        ordered(input[key]),
        key + " complete content and dates",
      );
    assert.deepEqual(detail.requiredWorkItems, input.requiredWorkItems);
    assert.equal(detail.workItems[0].sprintKey, "SPR-1");
    assert.deepEqual(
      detail.raidItems.map((r) => r.kind).sort(),
      input.raidItems.map((r) => r.kind).sort(),
    );
    assert.deepEqual(
      detail.sourceMappings
        .map(({ id: _id, ...row }) => row)
        .sort((a, b) => a.externalId.localeCompare(b.externalId)),
      [...input.sourceMappings].sort((a, b) =>
        a.externalId.localeCompare(b.externalId),
      ),
    );
    await assert.rejects(
      () =>
        repository.createProject(actor, { ...input, name: "Changed" }, context),
      (error) => error.code === "CONFLICT",
    );
    await assert.rejects(
      () => repository.detail({ ...actor, roles: ["pmo_admin"] }, created.id),
      (error) => error.code === "DENIED",
    );
    const projectOnly = { ...actor, subject: subject + "-project" };
    await insertGrant(
      projectOnly.subject,
      "project",
      created.id,
      "portfolio_manager",
    );
    await assert.rejects(
      () =>
        repository.createProject(
          projectOnly,
          canonicalFixture(portfolioId),
          context,
        ),
      (error) => error.code === "DENIED",
    );
    const reader = {
      ...actor,
      subject: subject + "-reader",
      roles: ["leadership"],
    };
    await insertGrant(reader.subject, "project", created.id, "leadership");
    const withheld = await repository.detail(reader, created.id);
    assert.equal(withheld.sourceMappingsWithheld, true);
    assert.deepEqual(withheld.sourceMappings, []);
    assert.equal(
      (
        await owner.query(
          'SELECT count(*)::int AS n FROM "CanonicalCreationReceipt" WHERE subject=$1',
          [subject],
        )
      ).rows[0].n,
      2,
    );
    assert.deepEqual(
      (
        await owner.query(
          "SELECT event,count(*)::int AS n FROM \"AuditEvent\" WHERE \"customerId\"=$1 AND actor=$2 AND event IN ('programme.created','project.created') GROUP BY event ORDER BY event",
          [customerId, subject],
        )
      ).rows,
      [
        { event: "programme.created", n: 1 },
        { event: "project.created", n: 1 },
      ],
    );
    await owner.query(
      'DELETE FROM "AccessGrant" WHERE "customerId"=$1 AND subject=$2',
      [customerId, subject],
    );
    await assert.rejects(
      () => repository.createProject(actor, input, context),
      (error) => error.code === "DENIED",
    );
    await assert.rejects(
      () => repository.detail(actor, created.id),
      (error) => error.code === "DENIED",
    );
    const runtimePoolModule = await import("./common.mjs");
    const runtimePool = new runtimePoolModule.Pool(connection);
    try {
      await verifyCanonicalImmutable(runtimePool);
    } finally {
      await runtimePool.end();
    }
    return {
      runtimeRole,
      projectId: created.id,
      programmeId: programme.id,
      portfolioId,
      customerId,
      collections: Object.fromEntries(
        collections.map((key) => [key, input[key].length]),
      ),
      strictRoles: true,
      projectOnlyCreateDenied: true,
      sourceMappingsWithheld: true,
      revokedReplayDenied: true,
      atomicReceipt: true,
      completeContentAndDates: true,
      noDuplicateAudit: true,
    };
  } finally {
    await db.$disconnect();
  }
}
export async function verifyCanonicalCommitGuards(pool) {
  guard();
  const source = (
    await pool.query(
      'SELECT * FROM "CanonicalProject" WHERE sealed ORDER BY id LIMIT 1',
    )
  ).rows[0];
  assert(source);
  const probes = [];
  for (const operation of ["PROGRAMME", "PROJECT"]) {
    const rejectedId = randomUUID(),
      acceptedId = randomUUID();
    for (const [id, valid] of [
      [rejectedId, false],
      [acceptedId, true],
    ]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (operation === "PROGRAMME")
          await client.query(
            'INSERT INTO "Programme" (id,"customerId","portfolioId",code,name,"createdBy") VALUES ($1,$2,$3,$4,$5,$6)',
            [
              id,
              source.customerId,
              source.portfolioId,
              "P-" + id,
              "Commit probe",
              source.createdBy,
            ],
          );
        else {
          await client.query(
            'INSERT INTO "Project" (id,"customerId","portfolioId",code,name,description,"reportedStatus") VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [
              id,
              source.customerId,
              source.portfolioId,
              "C-" + id,
              "Commit probe",
              "",
              "UNKNOWN",
            ],
          );
          await client.query(
            'INSERT INTO "CanonicalProject" (id,"customerId","portfolioId","createdBy","responsibilitiesCount","sprintsCount","milestonesCount","workItemsCount","requiredWorkItemsCount","raidItemsCount","sourceMappingsCount") VALUES ($1,$2,$3,$4,0,0,0,0,0,0,0)',
            [id, source.customerId, source.portfolioId, source.createdBy],
          );
        }
        if (valid || operation === "PROJECT") {
          await client.query(
            'INSERT INTO "CanonicalCreationReceipt" (id,"customerId","portfolioId",subject,"idempotencyKey",operation,"requestHash","programmeId","projectId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              randomUUID(),
              source.customerId,
              source.portfolioId,
              source.createdBy,
              randomUUID(),
              operation,
              "0".repeat(64),
              operation === "PROGRAMME" ? id : null,
              operation === "PROJECT" ? id : null,
            ],
          );
        }
        if (valid) {
          if (operation === "PROJECT")
            await client.query(
              'UPDATE "CanonicalProject" SET sealed=true WHERE id=$1',
              [id],
            );
          await client.query("COMMIT");
        } else
          await assert.rejects(
            () => client.query("COMMIT"),
            (error) => error.code === "P0001",
          );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    const table = operation === "PROJECT" ? "CanonicalProject" : "Programme";
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM "${table}" WHERE id=$1`,
          [rejectedId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM "${table}" WHERE id=$1`,
          [acceptedId],
        )
      ).rows[0].n,
      1,
    );
    probes.push({
      operation,
      rejectedId,
      acceptedId,
      rejectedCommit: true,
      acceptedCommit: true,
    });
  }
  await verifyCanonicalIntegrity(pool);
  return { actualCommit: true, probes };
}
export function canonicalFixture(portfolioId, programmeId = null) {
  const tag = randomUUID();
  const dates = {
    baselineStart: "2026-01-01",
    baselineEnd: "2026-06-30",
    plannedStart: "2026-01-05",
    plannedEnd: "2026-07-01",
    forecastStart: "2026-01-06",
    forecastEnd: "2026-07-15",
    actualStart: "2026-01-07",
    actualEnd: null,
  };
  return {
    portfolioId,
    programmeId,
    code: "CAN-" + tag,
    name: "Synthetic canonical project",
    description: "Manual configuration fixture, not verified source evidence",
    reportedStatus: "GREEN",
    dates,
    responsibilities: [
      "SPONSOR",
      "PROJECT_MANAGER",
      "SCRUM_MASTER",
      "TEAM_LEAD",
      "RESPONSIBLE_OWNER",
    ].map((role, index) => ({
      role,
      subject: "synthetic-owner-" + index,
      displayName: "Synthetic responsible person " + index,
    })),
    sprints: [{ key: "SPR-1", name: "First sprint", dates }],
    milestones: [
      { key: "MS-1", name: "Release milestone", state: "OPEN", dates },
    ],
    workItems: [
      {
        key: "WI-1",
        title: "Delivery work",
        state: "IN_PROGRESS",
        sprintKey: "SPR-1",
        dates,
      },
    ],
    requiredWorkItems: [{ milestoneKey: "MS-1", workItemKey: "WI-1" }],
    raidItems: [
      "RISK",
      "ASSUMPTION",
      "ISSUE",
      "DEPENDENCY",
      "DECISION",
      "ACTION",
    ].map((kind, index) => ({
      key: "RAID-" + index,
      kind,
      title: "Synthetic " + kind,
      description: "Unverified manual assertion",
      state: "OPEN",
      ownerSubject: "synthetic-owner-1",
    })),
    sourceMappings: [
      ["PROJECT", null],
      ["SPRINT", "SPR-1"],
      ["MILESTONE", "MS-1"],
      ["WORK_ITEM", "WI-1"],
      ["RAID_ITEM", "RAID-0"],
    ].map(([targetType, targetKey], index) => ({
      sourceSystem: "Synthetic tracker",
      instanceKey: "instance-" + tag,
      externalType: "record",
      externalId: "external-" + index,
      externalRevision: "1",
      url: "https://tracker.example.test/" + tag + "/" + index,
      targetType,
      targetKey,
    })),
    idempotencyKey: tag,
  };
}
