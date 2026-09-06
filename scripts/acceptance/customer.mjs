// DEP-001/002, TR-DEP-003/004. Only the generated disposable customer-mode fixture.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { Pool, secret } from "./common.mjs";
import { loadDatabaseConfig } from "../../packages/platform/dist/index.js";

const env = process.env;
const profile = env.PDAA_CUSTOMER_PROFILE;
assert(["bundled", "external"].includes(profile));
assert.equal(env.PDAA_ACCEPTANCE, "customer-composition");
assert.equal(env.NODE_ENV, "production");
assert.equal(env.DEPLOYMENT_MODE, "customer");
assert.equal(env.DATA_MODE, "customer");
assert.equal(env.CUSTOMER_ID, "10000000-0000-4000-8000-000000000002");
assert.equal(env.CUSTOMER_NAME, "Controlled customer installation");
assert.equal(env.PDAA_DB_NAME, "pdaa");
assert.equal(
  env.PDAA_DB_HOST,
  profile === "bundled" ? "database" : "external-database",
);
assert.match(env.PDAA_ACCEPTANCE_RUN_ID, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
assert.equal(
  env.PDAA_ARTIFACT_DIR,
  `/workspace/artifacts/${env.PDAA_ACCEPTANCE_RUN_ID}/customer-${profile}`,
);
assert.equal(secret("customer-ready"), "isolated customer composition\n");
const output = env.PDAA_ARTIFACT_DIR;
const phase = process.argv[2];
assert(
  [
    "installed",
    "before-upgrade",
    "after-upgrade",
    "restore-target",
    "restored",
  ].includes(phase),
);
const connection = loadDatabaseConfig(env).database;
const db = new Pool({
  ...connection,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000,
});
const base = "https://web:8443";
const projectId = "30000000-0000-4000-8000-000000000003";
const save = (file, value) =>
  writeFileSync(`${output}/${file}.json`, JSON.stringify(value, null, 2));
const read = (file) =>
  JSON.parse(readFileSync(`${output}/${file}.json`, "utf8"));
async function projection(pool) {
  const result = {};
  for (const table of [
    "Customer",
    "Portfolio",
    "Project",
    "AccessGrant",
    "AuditEvent",
    "_prisma_migrations",
  ])
    result[table] = (
      await pool.query(`SELECT * FROM "${table}" ORDER BY 1`)
    ).rows;
  return JSON.parse(JSON.stringify(result));
}
async function ready(after = 0) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/api/health/ready", {
        signal: AbortSignal.timeout(4000),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 200);
      const heartbeat = (
        await db.query(
          'SELECT "occurredAt" FROM "ServiceHeartbeat" WHERE id=\'worker\'',
        )
      ).rows[0];
      if (
        heartbeat &&
        heartbeat.occurredAt.getTime() > after &&
        Date.now() - heartbeat.occurredAt.getTime() < 90000
      )
        return;
    } catch {
      /* Retry only within this isolated startup deadline. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "Customer composition readiness or fresh worker progress missing",
  );
}
async function browserCheck(afterUpgrade) {
  const nss = env.HOME + "/.pki/nssdb";
  mkdirSync(nss, { recursive: true });
  execFileSync("certutil", ["-N", "-d", "sql:" + nss, "--empty-password"], {
    stdio: "pipe",
  });
  execFileSync(
    "certutil",
    [
      "-A",
      "-d",
      "sql:" + nss,
      "-n",
      "pdaa-customer-fixture",
      "-t",
      "C,,",
      "-i",
      "/run/secrets/ca.crt",
    ],
    { stdio: "pipe" },
  );
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    async function login(name) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(base);
      await page
        .getByRole("button", { name: "Sign in with your organization" })
        .click();
      await page.locator("#username").waitFor();
      assert.equal(new URL(page.url()).origin, "https://identity-ingress:8443");
      await page.locator("#username").fill(name);
      await page.locator("#password").fill(secret("login-password"));
      await page.locator("#kc-login").click();
      await page.getByRole("heading", { name: "Your projects" }).waitFor();
      return { context, page };
    }
    const operator = await login("operator");
    await operator.page
      .getByText("No projects are shared with this account")
      .waitFor();
    await operator.page
      .getByRole("button", { name: /Platform & access/ })
      .click();
    await operator.page.getByLabel("Account subject").fill("pm-atlas");
    await operator.page.getByLabel("Scope identifier").fill(projectId);
    await operator.page
      .getByRole("button", {
        name: afterUpgrade ? "Revoke access" : "Grant access",
      })
      .click();
    await operator.page
      .getByRole("status")
      .filter({ hasText: afterUpgrade ? "Access revoked" : "Access granted" })
      .waitFor();
    const logout = operator.page.waitForRequest((request) =>
      request.url().includes("/protocol/openid-connect/logout?"),
    );
    await operator.page.getByRole("button", { name: "Sign out" }).click();
    assert.equal(
      new URL((await logout).url()).origin,
      "https://identity-ingress:8443",
    );
    await operator.page
      .getByRole("heading", { name: "Welcome to your workspace" })
      .waitFor();
    await operator.context.close();
    const pm = await login("pm-atlas");
    if (afterUpgrade)
      await pm.page
        .getByText("No projects are shared with this account")
        .waitFor();
    else
      await pm.page
        .getByRole("button", { name: /Customer installation fixture/ })
        .waitFor();
    await pm.context.close();
  } finally {
    await browser.close();
  }
}
try {
  mkdirSync(output, { recursive: true });
  if (phase === "installed") {
    await ready();
    assert.equal(
      (await db.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"))
        .rows[0].ssl,
      true,
    );
    assert.equal(
      (
        await db.query(
          "SELECT extversion FROM pg_extension WHERE extname='vector'",
        )
      ).rowCount,
      1,
    );
    const state = await projection(db);
    assert.equal(state.Customer.length, 1);
    assert.equal(state.Customer[0].id, env.CUSTOMER_ID);
    assert.equal(state.Customer[0].name, env.CUSTOMER_NAME);
    for (const table of ["Portfolio", "Project", "AccessGrant", "AuditEvent"])
      assert.equal(
        state[table].length,
        0,
        "Customer install must not seed demonstration data",
      );
    assert(state._prisma_migrations.length > 0);
    const configResponse = await fetch(base + "/api/auth/config");
    assert.equal(configResponse.status, 200);
    const publicConfig = await configResponse.text();
    assert(
      publicConfig.includes(
        "https://identity-ingress:8443/identity/realms/pdaa",
      ),
    );
    for (const file of [
      "admin-password",
      "api-password",
      "worker-password",
      "migration-password",
      "backup-password",
      "backup-key",
      "encryption-key",
      "login-password",
    ])
      assert(
        !publicConfig.includes(secret(file)),
        "Customer configuration must not disclose secrets",
      );
    const identityRoute = await fetch(
      base + "/identity/realms/pdaa/.well-known/openid-configuration",
    );
    assert(
      !(await identityRoute.text()).includes('"issuer"'),
      "Customer ingress must not proxy the fixture identity provider",
    );
    const development = await fetch(base + "/api/auth/development", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"persona":"operator"}',
    });
    await development.arrayBuffer();
    assert.equal(development.status, 404);
    save("installed-state", state);
  } else if (phase === "before-upgrade") {
    // Product provisioning was proved empty first. Only this guarded test introduces data.
    assert.deepEqual(await projection(db), read("installed-state"));
    await db.query('INSERT INTO "Portfolio" VALUES ($1,$2,$3)', [
      "20000000-0000-4000-8000-000000000003",
      env.CUSTOMER_ID,
      "Controlled fixture",
    ]);
    await db.query(
      'INSERT INTO "Project" (id,"customerId","portfolioId",code,name,description,"reportedStatus") VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        projectId,
        env.CUSTOMER_ID,
        "20000000-0000-4000-8000-000000000003",
        "FIX",
        "Customer installation fixture",
        "Synthetic acceptance only",
        "GREEN",
      ],
    );
    await browserCheck(false);
    const state = await projection(db);
    assert.equal(state.AccessGrant.length, 1);
    assert(state.AuditEvent.length > 0);
    save("backup-state", state);
  } else if (phase === "after-upgrade") {
    // This phase starts after recreation; an old worker heartbeat cannot satisfy it.
    await ready(Date.now());
    assert.deepEqual(
      await projection(db),
      read("backup-state"),
      "Current-release upgrade must preserve data, grants, audit and migration history",
    );
    await browserCheck(true);
    const state = await projection(db);
    assert(state.AuditEvent.length > read("backup-state").AuditEvent.length);
    save("source-state", state);
  } else if (phase === "restore-target") {
    await db.query("CREATE DATABASE pdaa_restore TEMPLATE template0");
  } else if (phase === "restored") {
    const restored = new Pool({
      ...connection,
      database: "pdaa_restore",
      connectionTimeoutMillis: 5000,
    });
    try {
      assert.deepEqual(await projection(restored), read("backup-state"));
      assert.equal(
        (
          await restored.query(
            "SELECT has_database_privilege('pdaa_api',current_database(),'CONNECT') AS api,has_database_privilege('pdaa_worker',current_database(),'CONNECT') AS worker",
          )
        ).rows[0].api,
        false,
      );
      assert.equal(
        (
          await restored.query(
            "SELECT has_database_privilege('pdaa_worker',current_database(),'CONNECT') AS allowed",
          )
        ).rows[0].allowed,
        false,
      );
    } finally {
      await restored.end();
    }
    assert.deepEqual(
      await projection(db),
      read("source-state"),
      "Restore must preserve the running source",
    );
    await ready();
  }
  save(phase, {
    runId: env.PDAA_ACCEPTANCE_RUN_ID,
    profile,
    phase,
    status: "passed",
  });
  console.log(`PASS: customer ${profile} ${phase}`);
} finally {
  await db.end();
}
