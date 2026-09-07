// AC-AUTH-001 / SEC-AUTH-001: a real issued token expires without refresh,
// response replacement or clock changes. Tokens and projections stay in memory.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";
import { Pool, config, secret, guard } from "./common.mjs";
import {
  createDisclosureCheck,
  readFixtureSecrets,
  observeBrowserDisclosure,
} from "./disclosure.mjs";
import { expiryWaitMs, validateExpiryReceipt } from "./expiry-evidence.mjs";

export async function checkIdentityExpiry(browser) {
  guard();
  const runId = process.env.PDAA_ACCEPTANCE_RUN_ID;
  assert.match(runId, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
  assert.equal(process.env.PDAA_ARTIFACT_DIR, "/workspace/artifacts/" + runId);
  const base = "https://gateway:8443";
  const issuer = base + "/identity/realms/pdaa";
  assert.equal(process.env.OIDC_ISSUER, issuer);
  const deadlineAt = Date.now() + 240000;
  const deadline = setTimeout(() => {
    console.error("FAIL: SEC-AUTH-001 expiry deadline");
    process.exit(1);
  }, 240000);
  const remaining = () => {
    const ms = deadlineAt - Date.now();
    if (ms <= 0) throw new Error("Identity expiry deadline reached");
    return ms;
  };
  const disclosure = createDisclosureCheck(readFixtureSecrets("/run/secrets"));
  const db = new Pool({
    ...config().database,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  let context;
  let receipt;
  let failure;
  let stage = "initialization";
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
  try {
    const baseline = await projection();
    const projectId = "30000000-0000-4000-8000-000000000001";
    const grant = {
      subject: "pm-atlas",
      scopeType: "project",
      scopeId: projectId,
    };
    assert(
      baseline.AccessGrant.some(
        (row) => row.subject === grant.subject && row.scopeId === projectId,
      ),
    );
    context = await browser.newContext();
    context.setDefaultTimeout(30000);
    const capture = await observeBrowserDisclosure(context, base, disclosure);
    const page = await capture.newPage();
    const tokenEndpoint = issuer + "/protocol/openid-connect/token";
    let tokenRequests = 0;
    let tokenExchanges = 0;
    page.on("request", (request) => {
      if (request.url() === tokenEndpoint) tokenRequests++;
    });
    page.on("response", (response) => {
      if (response.url() === tokenEndpoint && response.ok()) tokenExchanges++;
    });
    stage = "login";
    await page.goto(base);
    await capture.settle(page);
    await page
      .getByRole("button", { name: "Sign in with your organization" })
      .click();
    await page.locator("#username").fill("pm-atlas");
    await page.locator("#password").fill(secret("login-password"));
    await capture.settle(page);
    const authenticated = page.waitForRequest(
      (request) =>
        request.url() === base + "/api/me" && request.method() === "GET",
    );
    await page.locator("#kc-login").click();
    const authorization = await (
      await authenticated
    ).headerValue("authorization");
    assert.match(authorization, /^Bearer [A-Za-z0-9_.-]+$/);
    const token = authorization.slice(7);
    disclosure.addSecrets([token]);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    assert.equal(claims.iss, issuer);
    assert.equal(typeof claims.sub, "string");
    assert(claims.sub.length > 0);
    expiryWaitMs(claims);
    const request = async (path, method = "GET", body) => {
      const response = await fetch(base + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(5000, remaining())),
        headers: {
          Authorization: authorization,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      disclosure.add(
        "expiry-api-headers",
        JSON.stringify([...response.headers]),
      );
      disclosure.add("expiry-api-bodies", text);
      return { status: response.status, body: JSON.parse(text) };
    };
    const writes = [
      ["POST", { ...grant, role: "leadership" }],
      ["DELETE", grant],
    ];
    stage = "authenticated";
    const me = await request("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.subject, claims.sub);
    assert.equal(me.body.customerId, process.env.CUSTOMER_ID);
    assert.deepEqual(me.body.roles, ["project_manager"]);
    const projects = await request("/api/projects");
    assert.equal(projects.status, 200);
    assert.deepEqual(
      projects.body.map((project) => project.id),
      [projectId],
    );
    const card = page.getByRole("button", {
      name: /Atlas · Customer platform/,
    });
    await card.waitFor();
    stage = "loaded-details";
    const loaded = page.waitForResponse(
      (response) =>
        response.url() === base + "/api/projects/" + projectId &&
        response.request().method() === "GET",
    );
    await card.click();
    const detail = await loaded;
    assert.equal(detail.status(), 200);
    assert.equal(
      await detail.request().headerValue("authorization"),
      authorization,
    );
    await expect(
      page.getByRole("heading", {
        name: "Atlas · Customer platform",
        level: 2,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Isolated synthetic TLS/OIDC acceptance fixture", {
        exact: true,
      }),
    ).toBeVisible();
    await capture(page);
    await page.getByRole("button", { name: "← All projects" }).click();
    await card.waitFor();
    // This manager has business read scope but never had grant authority.
    // Identical valid payloads move from authorization 403 to authentication 401.
    stage = "pre-expiry-denials";
    for (const [method, body] of writes)
      assert.deepEqual(await request("/api/access-grants", method, body), {
        status: 403,
        body: { statusCode: 403, message: "Access denied" },
      });
    assert.deepEqual(await projection(), baseline);
    assert.equal(tokenRequests, 1);
    assert.equal(tokenExchanges, 1);
    stage = "waiting";
    const wait = expiryWaitMs(claims);
    assert(wait < remaining());
    console.log("Waiting for natural fixture access-token expiry");
    await delay(wait);
    assert(Date.now() > claims.exp * 1000);
    stage = "expired";
    const denied = {
      status: 401,
      body: { statusCode: 401, message: "Sign-in required" },
    };
    for (const path of [
      "/api/me",
      "/api/projects",
      "/api/projects/" + projectId,
    ])
      assert.deepEqual(await request(path), denied);
    for (const [method, body] of writes)
      assert.deepEqual(
        await request("/api/access-grants", method, body),
        denied,
      );
    assert.deepEqual(await projection(), baseline);
    stage = "browser";
    const refreshed = page.waitForResponse(
      (response) =>
        response.url() === base + "/api/projects/" + projectId &&
        response.request().method() === "GET",
    );
    await card.click();
    const response = await refreshed;
    assert.equal(response.status(), 401);
    assert.equal(
      await response.request().headerValue("authorization"),
      authorization,
    );
    await expect(page.getByRole("alert")).toContainText(
      "Your session has ended",
    );
    await expect(
      page.getByRole("button", { name: "Sign in with your organization" }),
    ).toBeEnabled();
    for (const text of [
      "Atlas · Customer platform",
      "Draco · Data migration",
      "Isolated synthetic TLS/OIDC acceptance fixture",
    ])
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    assert.deepEqual(
      await page.evaluate(() => ({
        local: Object.keys(window.localStorage),
        session: Object.keys(sessionStorage),
      })),
      { local: [], session: [] },
    );
    await capture(page);
    await capture.close();
    context = undefined;
    assert.equal(tokenRequests, 1);
    assert.equal(tokenExchanges, 1);
    assert.deepEqual(await projection(), baseline);
    stage = "evidence";
    const channels = disclosure.verify([
      "browser-response-headers",
      "browser-response-bodies",
      "browser-dom",
      "browser-storage",
      "identity-token-metadata",
      "expiry-api-headers",
      "expiry-api-bodies",
    ]);
    receipt = validateExpiryReceipt(
      {
        runId,
        testId: "SEC-AUTH-001",
        status: "passed",
        phases: ["authenticated", "expired", "cleared"],
        authorizedBeforeExpiry: true,
        sameToken: true,
        naturalExpiry: true,
        databaseUnchanged: true,
        browserSessionCleared: true,
        deniedReads: 3,
        deniedWrites: 2,
        tokenExchanges,
        channels,
      },
      runId,
    );
  } catch {
    failure = new Error("SEC-AUTH-001 expiry failed: " + stage);
  } finally {
    try {
      if (context) await context.close();
    } catch {
      failure ??= new Error("SEC-AUTH-001 expiry cleanup failed");
    } finally {
      try {
        await db.end();
      } catch {
        failure ??= new Error("SEC-AUTH-001 expiry cleanup failed");
      } finally {
        clearTimeout(deadline);
      }
    }
  }
  if (failure) throw failure;
  return receipt;
}
