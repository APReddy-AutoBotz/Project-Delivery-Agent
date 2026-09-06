import { Pool, config, migrate, guard } from "./common.mjs";
import assert from "node:assert/strict";
guard();
for (const host of ["database", "external-database"]) {
  // Provisioning belongs to the immutable operations image, not this fixture.
  assert(migrate(host), "Prisma must recognize operations-created history");
  const admin = new Pool(
    config(host, "fixture_admin", "admin-password").database,
  );
  try {
    const owner = new Pool(config(host).database);
    try {
      const customer = process.env.CUSTOMER_ID;
      const portfolio = "20000000-0000-4000-8000-000000000001";
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
