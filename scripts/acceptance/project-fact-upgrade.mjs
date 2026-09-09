// Genuine immutable-foundation -> current release upgrade in a disposable database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool, config, guard, secret } from "./common.mjs";
import { migrateDatabase } from "../../packages/operations/dist/migrations.js";
import { migrateRelease } from "../../packages/operations/dist/provision.js";
import { applyBusinessTableGrants } from "../../packages/operations/dist/business-grants.js";
import {
  CredentialVault,
  loadConfig,
} from "../../packages/platform/dist/index.js";
import {
  projectFactTables,
  projectFactProjection,
  seedProjectFactHistory,
  verifyProjectFactPrivileges,
  verifyImmutableProjectFacts,
} from "./project-facts.mjs";

export async function verifyFoundationUpgrade(admin, migrations) {
  guard();
  assert.equal(migrations.length, 2);
  assert.equal(migrations[0].name, "202609060001_foundation");
  assert.equal(
    migrations[0].checksum,
    "9738bed726d754be02fb157ce2ee787def280d5e6e4c5319d778080d8b040aca",
  );
  const database = "migration_upgrade",
    customerId = process.env.CUSTOMER_ID;
  const projectId = randomUUID(),
    portfolioId = randomUUID();
  await admin.query(
    "CREATE DATABASE migration_upgrade OWNER pdaa_migrate TEMPLATE template0",
  );
  const maintenance = { ...config().database, database };
  const owner = new Pool(maintenance);
  const supervisor = new Pool({
    ...config("database", "fixture_admin", "admin-password").database,
    database,
  });
  const release = {
    database: maintenance,
    customerId,
    customerName: process.env.CUSTOMER_NAME,
    roleFiles: {},
  };
  try {
    await supervisor.query(`COMMENT ON DATABASE migration_upgrade IS 'pdaa.foundation.v1:${customerId}';
      REVOKE ALL ON DATABASE migration_upgrade FROM PUBLIC;
      GRANT CONNECT ON DATABASE migration_upgrade TO pdaa_migrate,pdaa_api,pdaa_worker,pdaa_backup;
      ALTER SCHEMA public OWNER TO pdaa_migrate;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO pdaa_api,pdaa_worker,pdaa_backup`);
    await migrateDatabase(maintenance, [migrations[0]]);
    await owner.query('INSERT INTO "Customer" VALUES ($1,$2)', [
      customerId,
      process.env.CUSTOMER_NAME,
    ]);
    await owner.query('INSERT INTO "Portfolio" VALUES ($1,$2,$3)', [
      portfolioId,
      customerId,
      "Retained foundation",
    ]);
    await owner.query('INSERT INTO "Project" VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      projectId,
      customerId,
      portfolioId,
      "UPGRADE",
      "Retained project",
      "Synthetic foundation fixture",
      "UNKNOWN",
    ]);
    await owner.query('INSERT INTO "AccessGrant" VALUES ($1,$2,$3,$4,$5,$6)', [
      randomUUID(),
      customerId,
      "foundation-human",
      "project",
      projectId,
      "project_manager",
    ]);
    await owner.query(
      'INSERT INTO "AuditEvent" (id,"customerId",actor,event,"correlationId",detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        customerId,
        "foundation-human",
        "foundation.retained",
        "foundation-upgrade",
        { synthetic: true },
      ],
    );
    const vault = new CredentialVault(loadConfig(process.env).ENCRYPTION_KEY);
    await owner.query(
      'INSERT INTO "ConnectorCredential" (id,"customerId",name,envelope,"keyId") VALUES ($1,$2,$3,$4,$5)',
      [
        randomUUID(),
        customerId,
        "Retained encrypted fixture",
        vault.encrypt(secret("connector-secret"), "foundation-upgrade"),
        "primary",
      ],
    );
    await owner.query('INSERT INTO "ServiceHeartbeat" VALUES ($1,$2)', [
      "foundation-checkpoint",
      "2026-09-09T00:00:00.000Z",
    ]);
    const oldTables = [
      "Customer",
      "Portfolio",
      "Project",
      "AccessGrant",
      "AuditEvent",
      "ConnectorCredential",
      "ServiceHeartbeat",
    ];
    const oldProjection = async () => {
      const result = {};
      for (const table of oldTables)
        result[table] = (
          await owner.query(`SELECT * FROM "${table}" ORDER BY 1`)
        ).rows;
      return result;
    };
    const fullHistory = async () =>
      (
        await owner.query(
          'SELECT * FROM "_prisma_migrations" ORDER BY migration_name,started_at',
        )
      ).rows;
    const before = await oldProjection(),
      initialHistory = await fullHistory();
    assert.equal(initialHistory.length, 1);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
        )
      ).rows[0].n,
      8,
    );
    const applied = await migrateRelease(release, migrations);
    assert.equal(applied.length, 2);
    assert.deepEqual(await oldProjection(), before);
    const upgradedHistory = await fullHistory();
    assert.deepEqual(upgradedHistory[0], initialHistory[0]);
    assert.deepEqual(
      upgradedHistory.map((row) => [row.migration_name, row.checksum]),
      migrations.map((row) => [row.name, row.checksum]),
    );
    for (const table of projectFactTables)
      assert.equal(
        (await owner.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]
          .n,
        0,
      );
    await verifyProjectFactPrivileges(owner);
    const fixture = await seedProjectFactHistory(
      owner,
      { ...config("database", "pdaa_api", "api-password").database, database },
      customerId,
      projectId,
      "upgraded",
    );
    await verifyImmutableProjectFacts(owner);
    const populated = await projectFactProjection(owner);
    const retained = await oldProjection();
    await migrateRelease(release, migrations);
    assert.deepEqual(await fullHistory(), upgradedHistory);
    assert.deepEqual(await oldProjection(), retained);
    assert.deepEqual(await projectFactProjection(owner), populated);
    await assert.rejects(
      () =>
        migrateRelease(
          {
            ...release,
            database: {
              ...config("database", "pdaa_backup", "backup-password").database,
              database,
            },
          },
          migrations,
        ),
      /Migration owner required/,
    );
    await supervisor.query('ALTER TABLE "FactSource" OWNER TO fixture_admin');
    try {
      await assert.rejects(
        () => migrateRelease(release, migrations),
        /Unexpected business table owner/,
      );
    } finally {
      await supervisor.query('ALTER TABLE "FactSource" OWNER TO pdaa_migrate');
    }
    // Owner-issued column grants must be removed as well as whole-table grants.
    await owner.query(
      'GRANT SELECT ("originalStatement") ON "FactEvidence" TO pdaa_worker; GRANT UPDATE ("id") ON "ProjectFact" TO pdaa_api',
    );
    assert.equal(
      (
        await owner.query(
          `SELECT has_column_privilege('pdaa_worker','"FactEvidence"','originalStatement','SELECT') AS allowed`,
        )
      ).rows[0].allowed,
      true,
    );
    await applyBusinessTableGrants(owner);
    assert.equal(
      (
        await owner.query(
          `SELECT has_column_privilege('pdaa_worker','"FactEvidence"','originalStatement','SELECT') AS allowed`,
        )
      ).rows[0].allowed,
      false,
    );
    await verifyProjectFactPrivileges(owner);
    assert.deepEqual(await projectFactProjection(owner), populated);
    assert(
      vault.decrypt(
        (await owner.query('SELECT envelope FROM "ConnectorCredential"'))
          .rows[0].envelope,
        "foundation-upgrade",
      ) === secret("connector-secret"),
      "Retained encrypted credential must match the generated fixture",
    );
    return {
      status: "passed",
      foundationChecksum: migrations[0].checksum,
      migrations: upgradedHistory.map((row) => ({
        name: row.migration_name,
        checksum: row.checksum,
      })),
      retainedFoundationTables: oldTables,
      emptyAddedTablesAfterUpgrade: projectFactTables,
      retainedRows: Object.fromEntries(
        Object.entries(populated).map(([name, rows]) => [name, rows.length]),
      ),
      migrationOwnerUpgrade: true,
      repeatNoReplay: true,
      wrongRoleDenied: true,
      ownershipDriftDenied: true,
      columnGrantDriftRemoved: true,
      encryptedCredentialRetained: true,
      fixture,
    };
  } finally {
    await owner.end();
    await supervisor.end();
  }
}
