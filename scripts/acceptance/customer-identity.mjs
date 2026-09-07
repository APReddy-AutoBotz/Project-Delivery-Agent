// INT-ADM-001 / AC-ADM-001: one native OIDC token, held only in this verifier's
// memory, survives configuration-only API recreation in the disposable fixture.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { Pool, secret } from "./common.mjs";
import { loadDatabaseConfig } from "../../packages/platform/dist/index.js";
import {
  remappingExchange,
  remainingRemappingTime,
} from "./remapping-exchange.mjs";
import {
  createDisclosureCheck,
  readFixtureSecrets,
  observeBrowserDisclosure,
} from "./disclosure.mjs";

let exchange;
let stage = "initialization";
let deadline;
async function main() {
  const env = process.env;
  assert.equal(env.PDAA_ACCEPTANCE, "customer-composition");
  assert.equal(env.PDAA_CUSTOMER_PROFILE, "bundled");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.DEPLOYMENT_MODE, "customer");
  assert.equal(env.DATA_MODE, "customer");
  assert.equal(env.CUSTOMER_ID, "10000000-0000-4000-8000-000000000002");
  assert.equal(env.PDAA_DB_HOST, "database");
  assert.equal(env.PDAA_DB_NAME, "pdaa");
  assert.match(env.PDAA_ACCEPTANCE_RUN_ID, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
  const output = `/workspace/artifacts/${env.PDAA_ACCEPTANCE_RUN_ID}/customer-bundled`;
  assert.equal(env.PDAA_ARTIFACT_DIR, output);
  assert.equal(secret("customer-ready"), "isolated customer composition\n");
  const identity = {
    runId: env.PDAA_ACCEPTANCE_RUN_ID,
    profile: "bundled",
    session: env.PDAA_IDENTITY_SESSION,
  };
  exchange = remappingExchange(output, identity);
  const input = JSON.parse(
    readFileSync(output + "/identity-input.json", "utf8"),
  );
  assert.deepEqual(input.identity, identity);
  assert.equal(input.deadlineAt, Number(env.PDAA_IDENTITY_DEADLINE));
  deadline = setTimeout(() => {
    console.error("FAIL: INT-ADM-001 verifier deadline");
    process.exit(1);
  }, remainingRemappingTime(input.deadlineAt));
  const disclosure = createDisclosureCheck(readFixtureSecrets("/run/secrets"));
  const db = new Pool({
    ...loadDatabaseConfig(env).database,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  let browser;
  const base = "https://web:8443";
  const projection = async () => {
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
        await db.query(`SELECT * FROM "${table}" ORDER BY 1`)
      ).rows;
    return JSON.parse(JSON.stringify(result));
  };
  const request = async (path, authorization, method = "GET", body) => {
    const response = await fetch(base + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(5000, remainingRemappingTime(input.deadlineAt)),
      ),
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    disclosure.add(
      "identity-api-headers",
      JSON.stringify([...response.headers]),
    );
    disclosure.add("identity-api-bodies", text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const ready = async () => {
    const until = Math.min(Date.now() + 45000, input.deadlineAt);
    do {
      try {
        if ((await request("/api/health/ready")).status === 200) return;
      } catch {
        /* Only retry startup readiness, never permission assertions. */
      }
      await delay(250);
    } while (Date.now() < until);
    throw new Error("Identity configuration API readiness failed");
  };
  try {
    const baseline = await projection();
    const grant = {
      subject: "pm-atlas",
      scopeType: "project",
      scopeId: "30000000-0000-4000-8000-000000000003",
    };
    assert(
      baseline.AccessGrant.some(
        (row) => row.subject === grant.subject && row.scopeId === grant.scopeId,
      ),
    );
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
        "pdaa-config-fixture",
        "-t",
        "C,,",
        "-i",
        "/run/secrets/ca.crt",
      ],
      { stdio: "pipe" },
    );
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    stage = "login";
    const context = await browser.newContext();
    const capture = await observeBrowserDisclosure(
      context,
      base,
      disclosure,
      input.metadata.issuer.split("/identity/")[0],
    );
    const page = await capture.newPage();
    await page.goto(base);
    await capture.settle(page);
    await page
      .getByRole("button", { name: "Sign in with your organization" })
      .click();
    await page.locator("#username").fill("operator");
    await page.locator("#password").fill(secret("login-password"));
    await capture.settle(page);
    const authenticated = page.waitForRequest(
      (r) => r.url() === base + "/api/me" && r.method() === "GET",
    );
    await page.locator("#kc-login").click();
    const authorization = await (
      await authenticated
    ).headerValue("authorization");
    assert.match(authorization, /^Bearer [A-Za-z0-9_.-]+$/);
    const token = authorization.slice(7);
    disclosure.addSecrets([token]);
    const expires = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    ).exp;
    assert(
      Number.isFinite(expires) && expires * 1000 > input.deadlineAt + 60000,
    );
    await page.getByText("No projects are shared with this account").waitFor();
    await capture(page);
    await capture.close();
    await browser.close();
    browser = undefined;
    const phases = [];
    let originalSubject;
    for (const phase of ["mapped", "removed", "restored"]) {
      stage = phase;
      if (phase !== "mapped")
        await exchange.wait(
          "control",
          phase,
          remainingRemappingTime(input.deadlineAt),
        );
      await ready();
      const metadata = await request("/api/auth/config");
      assert.equal(metadata.status, 200);
      assert.deepEqual(metadata.body, input.metadata);
      // A 401/expired token cannot masquerade as successful role revocation.
      assert(expires * 1000 > Date.now());
      const me = await request("/api/me", authorization);
      assert.equal(me.status, 200);
      originalSubject ??= me.body.subject;
      assert.equal(me.body.subject, originalSubject);
      assert.equal(me.body.customerId, env.CUSTOMER_ID);
      assert.deepEqual(
        me.body.roles,
        phase === "removed" ? [] : ["system_admin"],
      );
      const projects = await request("/api/projects", authorization);
      assert.equal(projects.status, 200);
      assert.deepEqual(projects.body, []);
      for (const path of ["/api/platform", "/api/audit"])
        assert.equal(
          (await request(path, authorization)).status,
          phase === "removed" ? 403 : 200,
        );
      if (phase === "removed") {
        assert.equal(
          (
            await request("/api/access-grants", authorization, "POST", {
              ...grant,
              role: "leadership",
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/api/access-grants", authorization, "DELETE", grant))
            .status,
          403,
        );
      }
      assert.deepEqual(await projection(), baseline);
      phases.push(phase);
      if (phase !== "restored") exchange.publish("receipt", phase);
    }
    stage = "evidence";
    const channels = disclosure.verify([
      "browser-response-headers",
      "browser-response-bodies",
      "browser-dom",
      "browser-storage",
      "identity-token-metadata",
      "identity-api-headers",
      "identity-api-bodies",
    ]);
    writeFileSync(
      output + "/identity-remapping.json",
      JSON.stringify(
        {
          ...identity,
          testId: "INT-ADM-001",
          status: "passed",
          phases,
          sameUnexpiredToken: true,
          databaseUnchanged: true,
          metadataMatched: true,
          deniedWrites: 2,
          channels,
        },
        null,
        2,
      ),
    );
    exchange.publish("receipt", "restored");
    console.log("PASS: INT-ADM-001 metadata and configuration role remapping");
  } finally {
    if (browser) await browser.close();
    await db.end();
  }
}
try {
  await main();
} catch {
  try {
    exchange?.publish("receipt", "failed");
  } catch {
    /* Fixed failure below. */
  }
  console.error(
    JSON.stringify({ testId: "INT-ADM-001", status: "failed", stage }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
