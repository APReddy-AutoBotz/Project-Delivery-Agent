import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Pool, config, secret, migrate, guard } from "./common.mjs";
const { makeWorkerUtils, Logger } = createRequire(
  new URL("../../apps/worker/package.json", import.meta.url),
)("graphile-worker");
guard();
for (const host of ["database", "external-database"]) {
  const admin = new Pool(
    config(host, "fixture_admin", "admin-password").database,
  );
  try {
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
        )
      ).rows[0].n,
      0,
      "Fresh isolated database required",
    );
    for (const [role, file] of [
      ["pdaa_migrate", "migration-password"],
      ["pdaa_api", "api-password"],
      ["pdaa_worker", "worker-password"],
    ]) {
      const quoted = "'" + secret(file).replaceAll("'", "''") + "'";
      await admin.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${quoted}`,
      );
    }
    await admin.query(
      "REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO pdaa_migrate; GRANT CONNECT ON DATABASE pdaa TO pdaa_migrate,pdaa_api,pdaa_worker; GRANT CREATE ON DATABASE pdaa TO pdaa_migrate; CREATE SCHEMA graphile_worker AUTHORIZATION pdaa_worker; CREATE EXTENSION vector",
    );
    assert(migrate(host), "Verified TLS forward migration failed");
    assert(migrate(host), "Repeat migration failed");
    // Provision Graphile's schema using its owner, then remove database-wide CREATE.
    await admin.query("GRANT CREATE ON DATABASE pdaa TO pdaa_worker");
    const workerPool = new Pool(
      config(host, "pdaa_worker", "worker-password").database,
    );
    try {
      const utils = await makeWorkerUtils({
        pgPool: workerPool,
        schema: "graphile_worker",
        logger: new Logger(() => () => {}),
      });
      try {
        await utils.migrate();
      } finally {
        await utils.release();
      }
    } finally {
      await workerPool.end();
      await admin.query("REVOKE CREATE ON DATABASE pdaa FROM pdaa_worker");
    }
    const restrictedPool = new Pool(
      config(host, "pdaa_worker", "worker-password").database,
    );
    try {
      assert.equal(
        (
          await restrictedPool.query(
            "SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        Number(
          (
            await restrictedPool.query(
              "SELECT max(id) AS version FROM graphile_worker.migrations",
            )
          ).rows[0].version,
        ),
        19,
      );
      const utils = await makeWorkerUtils({
        pgPool: restrictedPool,
        schema: "graphile_worker",
        logger: new Logger(() => () => {}),
      });
      await utils.release();
    } finally {
      await restrictedPool.end();
    }
    const owner = new Pool(config(host).database);
    try {
      await owner.query(
        'GRANT USAGE ON SCHEMA public TO pdaa_api,pdaa_worker; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO pdaa_api; REVOKE ALL ON "_prisma_migrations" FROM pdaa_api; REVOKE UPDATE,DELETE ON "AuditEvent" FROM pdaa_api; GRANT SELECT,INSERT,UPDATE ON "ServiceHeartbeat" TO pdaa_worker',
      );
      const customer = process.env.CUSTOMER_ID;
      const portfolio = "20000000-0000-4000-8000-000000000001";
      await owner.query('INSERT INTO "Customer" VALUES ($1,$2)', [
        customer,
        "Synthetic acceptance",
      ]);
      await owner.query('INSERT INTO "Portfolio" VALUES ($1,$2,$3)', [
        portfolio,
        customer,
        "Synthetic portfolio",
      ]);
      for (const [id, code, name] of [
        [
          "30000000-0000-4000-8000-000000000001",
          "ATL",
          "Atlas · Customer platform",
        ],
        [
          "30000000-0000-4000-8000-000000000002",
          "DRA",
          "Draco · Data migration",
        ],
      ])
        await owner.query(
          'INSERT INTO "Project" (id,"customerId","portfolioId",code,name,description,"reportedStatus") VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            customer,
            portfolio,
            code,
            name,
            "Isolated synthetic TLS/OIDC acceptance fixture",
            "GREEN",
          ],
        );
      for (const [id, subject, role] of [
        ["40000000-0000-4000-8000-000000000001", "pm-atlas", "project_manager"],
        ["40000000-0000-4000-8000-000000000002", "leader-atlas", "leadership"],
      ])
        await owner.query(
          'INSERT INTO "AccessGrant" (id,"customerId",subject,"scopeType","scopeId",role) VALUES ($1,$2,$3,$4,$5,$6)',
          [
            id,
            customer,
            subject,
            "project",
            "30000000-0000-4000-8000-000000000001",
            role,
          ],
        );
    } finally {
      await owner.end();
    }
    console.log(
      `${host}: verified TLS, restricted roles, vector availability, initial/repeat migration and synthetic fixture passed.`,
    );
  } finally {
    await admin.end();
  }
}
