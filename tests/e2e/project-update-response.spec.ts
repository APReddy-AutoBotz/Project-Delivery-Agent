// FR-UPD-006 / NFR-SEC-005: isolated UI contract fixtures, not native API proof.
import { test, expect, type Page } from "@playwright/test";
const locator = "20000000-0000-4000-8000-000000000001";
const customerId = "10000000-0000-4000-8000-000000000001";
const responseId = "30000000-0000-4000-8000-000000000001";
async function fixture(page: Page, expireSoon = false) {
  const submissions: Array<{ text: string; idempotencyKey: string; correctsResponseId: string | null }> = [];
  let failNext = false;
  let pendingReply: Promise<void> | undefined;
  let releaseReply: (() => void) | undefined;
  let invitationReads = 0;
  const body = "<script>window.sourceExecuted=true</script>\nSynthetic forecast update needed.";
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const response = (json: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
    if (pathname === "/api/auth/config") return response({ mode: "development", dataMode: "synthetic", scope: "openid profile" });
    if (pathname === "/api/auth/development") return response({ token: "synthetic-browser-token" });
    if (pathname === "/api/me") return response({ customerId, subject: "recipient", roles: ["contributor"] });
    if (pathname === "/api/projects") return response([]);
    if (pathname === "/api/project-setup") return response({ truncated: false, portfolios: [] });
    if (pathname === `/api/project-update-invitations/${locator}`) {
      invitationReads += 1;
      expect(route.request().headers().authorization).toBe("Bearer synthetic-browser-token");
      return response({ requestId: locator, project: { id: locator, code: "SYN", name: "Synthetic delivery" },
        stageKind: "REQUEST", dueAt: new Date().toISOString(), capturedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (expireSoon ? 10000 : 3600000)).toISOString(), body,
        requiredFacts: [{ factType: "project.forecast", label: "Forecast" }], rawResponseReaders: ["recipient", "reviewer"],
        responses: [...new Map(submissions.map((entry) => [entry.idempotencyKey, entry])).values()].map((entry) => ({ id: responseId, submittedBy: "recipient", receivedAt: new Date().toISOString(),
          correctsResponseId: null, state: "UNCONFIRMED", contentState: "PRESENT", text: entry.text })) });
    }
    if (pathname.endsWith("/responses")) {
      submissions.push(route.request().postDataJSON());
      if (pendingReply) await pendingReply;
      expect(route.request().headers().authorization).toBe("Bearer synthetic-browser-token");
      if (failNext) { failNext = false; return response({ statusCode: 503, message: "Service unavailable" }, 503); }
      return response({ responseId, requestId: locator, receivedAt: new Date().toISOString(), state: "UNCONFIRMED",
        message: "Response recorded; required facts remain unconfirmed." }, 201);
    }
    return response({ statusCode: 404, message: "Resource unavailable" }, 404);
  });
  await page.goto(`/update-requests/${locator}`);
  await page.getByRole("button", { name: "Project manager", exact: false }).click();
  await expect(page.getByRole("region", { name: "Respond to update request" })).toBeVisible();
  return { submissions, body, fail: () => { failNext = true; }, reads: () => invitationReads,
    delay: () => { pendingReply = new Promise<void>((resolve) => { releaseReply = resolve; }); },
    release: () => releaseReply?.() };
}

test("escaped source/reply text, explicit unconfirmed receipt, retry key and sign-out cleanup", async ({ page }) => {
  const f = await fixture(page);
  await expect(page.getByText(f.body, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sourceExecuted?: unknown }).sourceExecuted)).toBeUndefined();
  const input = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
  await input.fill("<img src=x onerror=window.replyExecuted=true> Unconfirmed forecast.");
  f.fail();
  await page.getByRole("button", { name: "Record response" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be recorded");
  await page.getByRole("button", { name: "Record response" }).click();
  await expect(page.getByRole("status")).toContainText("required facts remain unconfirmed");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[0]?.idempotencyKey).toBe(f.submissions[1]?.idempotencyKey);
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => (window as unknown as { replyExecuted?: unknown }).replyExecuted)).toBeUndefined();
  await input.fill("Private draft removed on sign-out");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("textbox", { name: "Your update (unconfirmed)" })).toHaveCount(0);
  await expect(page.getByText(f.body, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("Private draft");
});

test("invitation expiry clears the body and draft before another submit", async ({ page }) => {
  await page.clock.install();
  const f = await fixture(page, true);
  await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).fill("Private expiring draft");
  await page.clock.fastForward(11000);
  await expect(page.getByRole("alert")).toContainText("unavailable or has expired");
  await expect(page.getByText(f.body, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Your update (unconfirmed)" })).toHaveCount(0);
  expect(f.submissions).toHaveLength(0);
});

test("a delayed response cannot restore protected text after sign-out", async ({ page }) => {
  const f = await fixture(page);
  f.delay();
  await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).fill("Private delayed reply");
  await page.getByRole("button", { name: "Record response" }).click();
  await expect.poll(() => f.submissions.length).toBe(1);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("textbox", { name: "Your update (unconfirmed)" })).toHaveCount(0);
  const reads = f.reads();
  const delivered = page.waitForResponse((response) => response.url().endsWith("/responses"));
  f.release();
  await delivered;
  await expect(page.getByText("Response recorded; required facts remain unconfirmed.", { exact: true })).toHaveCount(0);
  await expect(page.getByText(f.body, { exact: true })).toHaveCount(0);
  expect(f.reads()).toBe(reads);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("Private delayed reply");
});

test("OIDC callback preserves the invitation locator and SDK expiry clears its draft", async ({ page }) => {
  const issuer = "https://synthetic-identity.example";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS" };
  await page.route(issuer + "/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === "/authorize") {
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/auth/callback");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const state = url.searchParams.get("state")!;
      return route.fulfill({ status: 302, headers: { location: "http://localhost:5173/auth/callback?code=synthetic&state=" + encodeURIComponent(state) } });
    }
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify(value) });
    if (url.pathname.endsWith("openid-configuration")) return json({ issuer, authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token", userinfo_endpoint: issuer + "/userinfo", jwks_uri: issuer + "/jwks",
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
    if (url.pathname === "/userinfo") return json({ sub: "recipient" });
    if (url.pathname === "/token") {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const idToken = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({ iss: issuer, aud: "synthetic-client",
        sub: "recipient", iat: now, exp: now + 60 }) + ".synthetic-signature";
      return json({ access_token: "synthetic-oidc-token", id_token: idToken, token_type: "Bearer", expires_in: 60 });
    }
    return route.fulfill({ status: 404 });
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/config") return json({ mode: "oidc", dataMode: "synthetic", issuer, clientId: "synthetic-client", scope: "openid profile" });
    if (path === "/api/me") return json({ customerId, subject: "recipient", roles: ["contributor"] });
    if (path === "/api/projects") return json([]);
    if (path === "/api/project-setup") return json({ truncated: false, portfolios: [] });
    if (path === `/api/project-update-invitations/${locator}`) {
      expect(route.request().headers().authorization).toBe("Bearer synthetic-oidc-token");
      return json({ requestId: locator, project: { id: locator, code: "SYN", name: "OIDC synthetic delivery" }, stageKind: "REQUEST",
        expiresAt: new Date(Date.now() + 3600000).toISOString(), body: "Private authenticated request", rawResponseReaders: ["recipient"], responses: [] });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto(`/update-requests/${locator}`);
  await page.getByRole("button", { name: "Sign in with your organization" }).click();
  await expect(page).toHaveURL(`http://localhost:5173/update-requests/${locator}`);
  await expect(page.getByRole("region", { name: "Respond to update request" })).toBeVisible();
  await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).fill("Private OIDC draft");
  await page.clock.install();
  await page.clock.fastForward(65000);
  await expect(page.getByRole("textbox", { name: "Your update (unconfirmed)" })).toHaveCount(0);
  await expect(page.getByText("Private authenticated request", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("Private OIDC draft");
});
