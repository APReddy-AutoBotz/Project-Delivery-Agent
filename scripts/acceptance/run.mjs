// TR-DEP-003, TR-AUTH-001/002/003, NFR-SEC-003/005/010.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { lookup } from "node:dns/promises";
import {
  loadDatabaseConfig,
  loadConfig,
  IdentityService,
} from "../../packages/platform/dist/index.js";
import { createDatabase } from "../../packages/data/dist/index.js";
import { Pool, config, secret, migrate, guard } from "./common.mjs";
guard();
const passed = [];
async function check(name, fn) {
  await fn();
  passed.push(name);
  console.log("PASS: " + name);
}
async function rejected(fn, message) {
  let denied = false;
  let failure;
  try {
    await fn();
  } catch (error) {
    denied = true;
    failure = error;
  }
  assert(denied, message);
  return failure;
}
await check(
  "TLS: runtime Prisma and worker driver; external database through configuration",
  async () => {
    for (const host of ["database", "external-database"]) {
      const transport = config(host, "pdaa_api", "api-password").database;
      const db = createDatabase(transport);
      try {
        assert.equal(await db.project.count(), 2);
        assert.equal(
          (
            await db.$queryRaw`SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()`
          )[0].ssl,
          true,
        );
        await rejected(
          () =>
            db.$executeRawUnsafe(
              'ALTER TABLE "AuditEvent" DISABLE TRIGGER ALL',
            ),
          "Runtime role must not alter audit protection",
        );
        await rejected(
          () => db.$executeRawUnsafe('TRUNCATE "AuditEvent"'),
          "Runtime role must not truncate audit",
        );
      } finally {
        await db.$disconnect();
      }
      const pool = new Pool(
        config(host, "pdaa_worker", "worker-password").database,
      );
      try {
        assert.equal(
          (
            await pool.query(
              "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
            )
          ).rows[0].ssl,
          true,
        );
        await rejected(
          () => pool.query('SELECT * FROM "ConnectorCredential"'),
          "Worker must not read credentials",
        );
      } finally {
        await pool.end();
      }
    }
  },
);
await check(
  "TLS: wrong CA, hostname mismatch and plaintext fail closed for both runtime drivers",
  async () => {
    const transport = config("database", "pdaa_api", "api-password").database;
    for (const patch of [
      { ssl: { rejectUnauthorized: true, ca: secret("wrong-ca.crt") } },
      config("database-alias", "pdaa_api", "api-password").database,
      { ssl: false },
    ]) {
      const pool = new Pool({
        ...transport,
        ...patch,
        connectionTimeoutMillis: 3000,
      });
      const db = createDatabase({ ...transport, ...patch });
      try {
        await rejected(
          () => pool.query("SELECT 1"),
          "pg must deny unsafe transport",
        );
        await rejected(
          () => db.project.count(),
          "Prisma adapter must deny unsafe transport",
        );
      } finally {
        await pool.end();
        await db.$disconnect();
      }
    }
    const ip = (await lookup("database", { family: 4 })).address;
    const ipConfig = loadDatabaseConfig({
      ...process.env,
      PDAA_DB_HOST: ip,
      PDAA_DB_USER: "pdaa_api",
      PDAA_DB_PASSWORD_FILE: "/run/secrets/api-password",
    }).database;
    const pool = new Pool({ ...ipConfig, connectionTimeoutMillis: 3000 });
    const db = createDatabase(ipConfig);
    try {
      await rejected(
        () => pool.query("SELECT 1"),
        "An IP connection must not verify as localhost",
      );
      await rejected(
        () => db.project.count(),
        "Prisma IP connection must verify the configured IP",
      );
    } finally {
      await pool.end();
      await db.$disconnect();
    }
  },
);
await check(
  "Migration engine rejects wrong trust and hostname; repeat remains valid",
  async () => {
    assert.equal(
      migrate("database", { PDAA_DB_CA_FILE: "/run/secrets/wrong-ca.crt" }),
      false,
    );
    assert.equal(migrate("database-alias"), false);
    assert.equal(migrate("database"), true);
  },
);
// Trust only this test container's browser profile; never install host certificates.
const nss = process.env.HOME + "/.pki/nssdb";
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
    "pdaa-fixture",
    "-t",
    "C,,",
    "-i",
    "/run/secrets/ca.crt",
  ],
  { stdio: "pipe" },
);
const base = "https://gateway:8443";
const readinessDeadline = Date.now() + 90000;
for (;;) {
  try {
    assert(
      (
        await fetch(base + "/api/health/ready", {
          signal: AbortSignal.timeout(2000),
        })
      ).ok,
    );
    assert(
      (
        await fetch(
          base + "/identity/realms/pdaa/.well-known/openid-configuration",
          { signal: AbortSignal.timeout(2000) },
        )
      ).ok,
    );
    break;
  } catch {
    if (Date.now() >= readinessDeadline)
      throw new Error("Production fixture readiness failed");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  let tokenResponse;
  let authorization;
  let exchangedCode;
  page.on("request", (req) => {
    if (req.url().includes("/protocol/openid-connect/auth?"))
      authorization = new URL(req.url());
    if (req.url().endsWith("/protocol/openid-connect/token"))
      exchangedCode = req.postData();
  });
  page.on("response", async (response) => {
    if (
      response.url().endsWith("/protocol/openid-connect/token") &&
      response.ok()
    )
      tokenResponse = await response.json();
  });
  async function login(username) {
    await page.goto(base);
    await page
      .getByRole("button", { name: "Sign in with your organization" })
      .click();
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(secret("login-password"));
    await page.locator("#kc-login").click();
    await page.getByRole("heading", { name: "Your projects" }).waitFor();
  }
  await check(
    "Real OIDC code/PKCE login, configured scope, remote JWKS and scoped API read",
    async () => {
      await login("pm-atlas");
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      assert.equal(authorization.searchParams.get("scope"), "openid pdaa.read");
      await page
        .getByRole("button", { name: /Atlas · Customer platform/ })
        .waitFor();
      assert.equal(await page.getByText(/Draco/).count(), 0);
      assert(tokenResponse?.access_token && tokenResponse?.id_token);
      const publicConfig = await (await fetch(base + "/api/auth/config")).text();
      for (const name of ["encryption-key", "api-password", "worker-password", "migration-password", "login-password"])
        assert(!publicConfig.includes(secret(name)), "Public auth configuration must not disclose secrets");
      const api = (token) =>
        fetch(base + "/api/projects", {
          headers: { Authorization: "Bearer " + token },
        });
      assert.equal(
        (await api(tokenResponse.id_token)).status,
        401,
        "ID token is not an API access token",
      );
      assert.equal((await api(tokenResponse.access_token)).status, 200);
      assert.equal(
        (
          await fetch(base + "/api/auth/development", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: '{"persona":"operator"}',
          })
        ).status,
        404,
      );
      assert.deepEqual(
        await page.evaluate(() => Object.keys(window.localStorage)),
        [],
      );
      assert.deepEqual(
        await page.evaluate(() => Object.keys(sessionStorage)),
        [],
      );
    },
  );
  await check(
    "Provider logout receives hint, clears local data and requires new credentials",
    async () => {
      const ended = page.waitForRequest((req) =>
        req.url().includes("/protocol/openid-connect/logout?"),
      );
      await page.getByRole("button", { name: "Sign out" }).click();
      const request = await ended;
      assert(new URL(request.url()).searchParams.has("id_token_hint"));
      await page
        .getByRole("heading", { name: "Welcome to your workspace" })
        .waitFor();
      await page
        .getByRole("button", { name: "Sign in with your organization" })
        .click();
      await page.locator("#username").waitFor();
    },
  );
  await check(
    "OIDC rejects replayed authorization codes and untrusted JWKS hostname",
    async () => {
      assert(exchangedCode);
      const replay = await fetch(
        base + "/identity/realms/pdaa/protocol/openid-connect/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: exchangedCode,
        },
      );
      assert.equal(replay.status, 400);
    await new IdentityService(loadConfig(process.env)).authenticate(tokenResponse.access_token);
    const identity = new IdentityService(
        loadConfig({
          ...process.env,
          OIDC_JWKS_URI:
            "https://gateway-alias:8443/identity/realms/pdaa/protocol/openid-connect/certs",
        }),
      );
      await rejected(
        () => identity.authenticate(tokenResponse.access_token),
        "JWKS hostname mismatch must deny identity",
      );
    const invalidTlsPage = await context.newPage();
    try {
      const failure = await rejected(
        () => invalidTlsPage.goto("https://gateway-alias:8443"),
        "Browser must reject ingress hostname mismatch",
      );
      assert(String(failure).includes("ERR_CERT_COMMON_NAME_INVALID"), "Ingress denial must be a certificate hostname failure");
    } finally { await invalidTlsPage.close(); }
      await page.goto(
        base + "/auth/callback?code=synthetic-invalid&state=unrecognized",
      );
      await page
        .getByRole("alert")
        .filter({ hasText: "Sign-in could not be verified" })
        .waitFor();
    },
  );
  await context.close();
  const operator = await browser.newContext();
  const op = await operator.newPage();
  await check(
    "OIDC operator has no implicit project access; restricted DB role writes audited grants",
    async () => {
      await op.goto(base);
      await op
        .getByRole("button", { name: "Sign in with your organization" })
        .click();
      await op.locator("#username").fill("operator");
      await op.locator("#password").fill(secret("login-password"));
      await op.locator("#kc-login").click();
      await op.getByText("No projects are shared with this account").waitFor();
      await op.getByRole("button", { name: /Platform & access/ }).click();
      await op.getByLabel("Account subject").fill("acceptance-temporary");
      await op
        .getByLabel("Scope identifier")
        .fill("30000000-0000-4000-8000-000000000001");
      await op.getByRole("button", { name: "Grant access" }).click();
      await op
        .getByRole("status")
        .filter({ hasText: "Access granted" })
        .waitFor();
      await op.getByRole("button", { name: "Revoke access" }).click();
      await op
        .getByRole("status")
        .filter({ hasText: "Access revoked" })
        .waitFor();
    },
  );
  await operator.close();
} finally {
  await browser.close();
}
await check(
  "Worker container writes its heartbeat using its restricted TLS role",
  async () => {
    const db = createDatabase(
      config("database", "pdaa_api", "api-password").database,
    );
    try {
      for (let attempt = 0; ; attempt++) {
        const heartbeat = await db.serviceHeartbeat.findUnique({
          where: { id: "worker" },
        });
        if (heartbeat && Date.now() - heartbeat.occurredAt.getTime() < 90000)
          break;
        if (attempt >= 65) throw new Error("Worker heartbeat missing");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      await db.$disconnect();
    }
  },
);
const output = process.env.PDAA_ARTIFACT_DIR;
if (
  !output ||
  !/^pdaa-acceptance-[0-9]+-[a-f0-9]{8}$/.test(
    process.env.PDAA_ACCEPTANCE_RUN_ID ?? "",
  )
)
  throw new Error("Acceptance evidence identity required");
mkdirSync(output, { recursive: true });
writeFileSync(
  output + "/checks.json",
  JSON.stringify(
    {
      runId: process.env.PDAA_ACCEPTANCE_RUN_ID,
      completedAt: new Date().toISOString(),
      passed,
      distributionAccepted: false,
    },
    null,
    2,
  ),
);
