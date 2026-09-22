// AC-AUTH-001 / SEC-AUTH-001: a real issued token expires without refresh,
// response replacement or clock changes. Tokens and projections stay in memory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";
import { Pool, config, secret, guard } from "./common.mjs";
import {
  createDisclosureCheck,
  readFixtureSecrets,
  observeBrowserDisclosure,
} from "./disclosure.mjs";
import {
  expiryWaitMs,
  validateExpiryReceipt,
  waitForExpiryDenial,
} from "./expiry-evidence.mjs";
import {
  createDatabase,
  DatabaseScalarReconciliationRepository,
} from "../../packages/data/dist/index.js";
import { reserveScalarFixture } from "./scalar-reconciliation-fixture.mjs";

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
  let capture;
  let runtime;
  let receipt;
  let failure;
  let stage = "initialization";
  const scalarTables = [
    "ScalarReconciliationCheck",
    "ScalarReconciliationRequest",
    "ScalarReconciliationAssignment",
    "FactAssessment",
    "FactAssessmentVersion",
    "FactAssessmentConflict",
    "FactAuthorityConflict",
    "ProjectFact",
    "ProjectFactVersion",
    "FactEvidence",
    "FactSource",
    "FactSourceAccess",
    "AuthorityPolicy",
    "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt",
  ];
  const projection = async () => {
    const result = {};
    for (const table of [
      "Customer",
      "Portfolio",
      "Project",
      "AccessGrant",
      "AuditEvent",
      "_prisma_migrations",
      ...scalarTables,
    ])
      result[table] = (
        await db.query(
          `SELECT t.* FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`,
        )
      ).rows;
    return JSON.parse(JSON.stringify(result));
  };
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const observe = async (path, status, bytes, observedAt = Date.now()) => {
    disclosure.add("expiry-api-bodies", bytes.toString("utf8"));
    return {
      path,
      at: observedAt,
      status,
      bytes: bytes.length,
      sha256: hash(bytes),
      bodyBase64: bytes.toString("base64"),
      body: JSON.parse(bytes.toString("utf8")),
    };
  };
  try {
    const projectId = "30000000-0000-4000-8000-000000000001";
    stage = "scalar-fixture";
    runtime = createDatabase(
      config("database", "pdaa_api", "api-password").database,
    );
    const principal = (
      await runtime.$queryRaw`SELECT current_user AS role, session_user AS login`
    )[0];
    assert.deepEqual(principal, { role: "pdaa_api", login: "pdaa_api" });
    const fixture = await reserveScalarFixture(
      db,
      runtime,
      process.env.CUSTOMER_ID,
      projectId,
      "scalar-expiry",
      { pmSubject: "pm-atlas" },
    );
    const created = await new DatabaseScalarReconciliationRepository(
      runtime,
    ).check(fixture.actor, fixture.command, fixture.context);
    assert.equal(created.outcome, "CREATED");
    const scalarProject = await runtime.project.findUniqueOrThrow({
      where: { id: fixture.projectId },
    });
    const prefix = "/api/projects/" + fixture.projectId;
    const scalarPath =
      prefix + "/scalar-reconciliation-requests/" + created.request.id;
    const baseline = await projection();
    await runtime.$disconnect();
    runtime = undefined;
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
    capture = await observeBrowserDisclosure(context, base, disclosure);
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
    const request = async (
      path,
      method = "GET",
      body,
      originalBytes = false,
    ) => {
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
      return originalBytes
        ? observe(path, response.status, Buffer.from(text))
        : { status: response.status, body: JSON.parse(text) };
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
      projects.body.map((project) => project.id).sort(),
      [projectId, fixture.projectId].sort(),
    );
    const card = page.getByRole("button", {
      name: /Atlas · Customer platform/,
    });
    await card.waitFor();
    stage = "loaded-details-listener";
    const loaded = page.waitForResponse(
      (response) =>
        response.url() === base + "/api/projects/" + projectId &&
        response.request().method() === "GET",
    );
    stage = "loaded-details-click";
    await card.click();
    stage = "loaded-details-response";
    const detail = await loaded;
    assert.equal(detail.status(), 200);
    assert.equal(
      await detail.request().headerValue("authorization"),
      authorization,
    );
    stage = "loaded-details-heading";
    await expect(
      page.getByRole("heading", {
        name: "Atlas · Customer platform",
        level: 2,
        exact: true,
      }),
    ).toBeVisible();
    stage = "loaded-details-description";
    await expect(
      page.getByText("Isolated synthetic TLS/OIDC acceptance fixture", {
        exact: true,
      }),
    ).toBeVisible();
    stage = "loaded-details-disclosure";
    await capture(page);
    stage = "loaded-details-return-navigation";
    await page.getByRole("button", { name: "← All projects" }).click();
    stage = "loaded-details-return-card";
    await card.waitFor();
    stage = "loaded-scalar-proof";
    const projectOpened = page.waitForResponse(
      (response) =>
        response.url() === base + prefix &&
        response.request().method() === "GET",
    );
    void projectOpened.catch(() => {});
    await page
      .getByRole("button")
      .filter({
        has: page.getByRole("heading", {
          name: scalarProject.name,
          exact: true,
        }),
      })
      .click();
    assert.equal((await projectOpened).status(), 200);
    const proofOpened = page.waitForResponse(
      (response) =>
        response.url() === base + scalarPath &&
        response.request().method() === "GET",
    );
    void proofOpened.catch(() => {});
    await page
      .getByRole("button", { name: "Open scalar proof", exact: true })
      .click();
    const proofResponse = await proofOpened;
    assert.equal(
      await proofResponse.request().headerValue("authorization"),
      authorization,
    );
    const original = await observe(
      scalarPath,
      proofResponse.status(),
      Buffer.from(await proofResponse.body()),
    );
    assert.equal(original.status, 200);
    assert.deepEqual(original.body.assessment, created.assessment);
    const proofView = page.getByRole("region", {
      name: "PM scalar reconciliation request",
      exact: true,
    });
    await expect(proofView).toContainText("2026-10-01");
    await expect(proofView).toContainText("2026-10-02");
    await expect(proofView).toContainText(created.assessment.asOf);
    await capture(page);
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
    // Arm before waiting: any real protected polling response may clear the
    // entire session first. No mocked response, paused poll, reload or clock.
    const protectedPaths = [
      prefix,
      prefix + "/canonical",
      prefix + "/milestone-assessments",
      prefix + "/reconciliation-requests",
      prefix + "/facts",
      scalarPath,
      prefix + "/scalar-reconciliation-requests",
    ];
    const browserExpired = waitForExpiryDenial(
      page,
      protectedPaths,
      Math.min(remaining(), wait + 30000),
    );
    void browserExpired.catch(() => {});
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
    const denials = [];
    for (const path of [scalarPath, prefix + "/scalar-reconciliation-requests"])
      denials.push(await request(path, "GET", undefined, true));
    const { response, arrivedAt: browserDenialAt } = await browserExpired;
    assert(Number.isSafeInteger(browserDenialAt));
    assert(browserDenialAt >= claims.exp * 1000);
    assert.equal(response.status(), 401);
    assert.equal(
      await response.request().headerValue("authorization"),
      authorization,
    );
    const browserDenial = await observe(
      new URL(response.url()).pathname,
      response.status(),
      Buffer.from(await response.body()),
      browserDenialAt,
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
      scalarProject.name,
    ])
      await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    await expect(proofView).toHaveCount(0);
    await expect(
      page.getByRole("region", {
        name: "Scalar reconciliation queue",
        exact: true,
      }),
    ).toHaveCount(0);
    for (const text of ["2026-10-01", "2026-10-02", created.assessment.asOf])
      await expect(page.locator("body")).not.toContainText(text);
    assert.deepEqual(
      await page.evaluate(() => ({
        local: Object.keys(window.localStorage),
        session: Object.keys(sessionStorage),
      })),
      { local: [], session: [] },
    );
    await capture(page);
    await capture.close();
    capture = undefined;
    context = undefined;
    assert.equal(tokenRequests, 1);
    assert.equal(tokenExchanges, 1);
    const after = await projection();
    assert.deepEqual(after, baseline);
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
        scalar: {
          family: "scalar-natural-expiry/v1",
          runId,
          customerId: process.env.CUSTOMER_ID,
          projectId: fixture.projectId,
          factId: fixture.factId,
          requestId: created.request.id,
          assessmentId: created.assessment.assessmentId,
          principal,
          issuedAt: claims.iat * 1000,
          expiresAt: claims.exp * 1000,
          loadedAt: original.at,
          clearedAt: Date.now(),
          original,
          denials,
          browserDenial,
          projection: {
            before: hash(JSON.stringify(baseline)),
            after: hash(JSON.stringify(after)),
            counts: Object.fromEntries(
              scalarTables.map((table) => [
                table,
                baseline[table].filter(
                  (row) => row.projectId === fixture.projectId,
                ).length,
              ]),
            ),
          },
        },
      },
      runId,
    );
  } catch {
    failure = new Error("SEC-AUTH-001 expiry failed: " + stage);
  } finally {
    try {
      if (capture) await capture.close();
      else if (context) await context.close();
    } catch {
      failure ??= new Error("SEC-AUTH-001 expiry cleanup failed");
    } finally {
      try {
        try {
          if (runtime) await runtime.$disconnect();
        } finally {
          await db.end();
        }
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
