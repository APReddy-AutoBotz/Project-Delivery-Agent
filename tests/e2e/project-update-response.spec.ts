// FR-UPD-006 / NFR-SEC-005: isolated UI contract fixtures, not native API proof.
import { test, expect, type Page } from "@playwright/test";
import { projectUpdateClarificationQuestion, type ProjectUpdateResponseSubmission } from "../../packages/domain/src/project-update-capture.js";
const locator = "20000000-0000-4000-8000-000000000001";
const customerId = "10000000-0000-4000-8000-000000000001";
const responseId = "30000000-0000-4000-8000-000000000001";
const correctedResponseId = "30000000-0000-4000-8000-000000000002";
async function fixture(page: Page, { expireSoon = false, history = false, responseChoices }:
  { expireSoon?: boolean; history?: boolean; responseChoices?: string[] } = {}) {
  const submissions: ProjectUpdateResponseSubmission[] = [];
  const saved = new Map<string, ProjectUpdateResponseSubmission>();
  let choices = responseChoices;
  let failNext = false;
  let pendingReply: Promise<void> | undefined;
  let releaseReply: (() => void) | undefined;
  let invitationReads = 0;
  let denied = false;
  let clarificationPending = false;
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
      if (denied) return response({ statusCode: 403, message: "Resource unavailable" }, 403);
      const now = Date.now();
      return response({ requestId: locator, project: { id: locator, code: "SYN", name: "Synthetic delivery" },
        stageKind: history ? "ESCALATION" : "REQUEST", dueAt: new Date(now).toISOString(), capturedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + (expireSoon ? 10000 : 3600000)).toISOString(), body,
        ...(history ? { escalationContext: { asOf: new Date(now).toISOString(), state: "AVAILABLE",
          impact: { revision: 1, baseline: "2026-10-15", forecast: "2026-10-29", movementDays: 14,
            citation: { sourceId: locator, receiptId: correctedResponseId,
              reviewedAt: new Date(now - 2000).toISOString(), availableUntil: new Date(now + 10000).toISOString() } },
          originalRequestId: responseId, entries: [
            { requestId: responseId, stageId: "40000000-0000-4000-8000-000000000001", stageKind: "REQUEST",
              generation: 1, ordinal: 0, capturedAt: new Date(now - 1000).toISOString(),
              contentExpiresAt: new Date(now + 10000).toISOString(), contentState: "PRESENT",
              bodyProjection: "REVIEWER_NAMES_WITHHELD", body: "<script>window.historyExecuted=true</script> Historical request near its retention deadline." },
            { requestId: "30000000-0000-4000-8000-000000000002", stageId: "40000000-0000-4000-8000-000000000002",
              stageKind: "REMINDER", generation: 1, ordinal: 1, capturedAt: new Date(now).toISOString(),
              contentExpiresAt: new Date(now + 3600000).toISOString(), contentState: "PRESENT",
              bodyProjection: "REVIEWER_NAMES_WITHHELD", body: "Retained historical reminder." },
          ] } } : {}),
        requiredFacts: [{ factType: "project.status", label: "Project status" }], rawResponseReaders: ["recipient", "reviewer"],
        responseChoices: choices,
        ...(clarificationPending ? { clarification: { responseId, question: projectUpdateClarificationQuestion } } : {}),
        responses: [...saved.values()].reverse().map((entry) => ({
          id: entry.correctsResponseId ? correctedResponseId : responseId, submittedBy: "recipient", receivedAt: new Date().toISOString(),
          correctsResponseId: entry.correctsResponseId, state: "UNCONFIRMED", contentState: "PRESENT", text: entry.text })) });
    }
    if (pathname.endsWith("/responses")) {
      const submission = route.request().postDataJSON() as ProjectUpdateResponseSubmission;
      submissions.push(submission);
      if (pendingReply) await pendingReply;
      expect(route.request().headers().authorization).toBe("Bearer synthetic-browser-token");
      if (failNext) { failNext = false; return response({ statusCode: 503, message: "Service unavailable" }, 503); }
      if (!saved.has(submission.idempotencyKey) && submission.responseType === "CONFIGURED_CHOICE" && !choices?.includes(submission.text))
        return response({ statusCode: 400, message: "Invalid request" }, 400);
      saved.set(submission.idempotencyKey, submission);
      clarificationPending = false;
      return response({ responseId: submissions.at(-1)?.correctsResponseId ? correctedResponseId : responseId,
        requestId: locator, receivedAt: new Date().toISOString(), state: "UNCONFIRMED",
        message: "Response recorded; required facts remain unconfirmed." }, 201);
    }
    return response({ statusCode: 404, message: "Resource unavailable" }, 404);
  });
  await page.goto(`/update-requests/${locator}`);
  await page.getByRole("button", { name: "Project manager", exact: false }).click();
  await expect(page.getByRole("region", { name: "Respond to update request" })).toBeVisible();
  return { submissions, body, fail: () => { failNext = true; }, reads: () => invitationReads, deny: () => { denied = true; },
    requestClarification: () => { clarificationPending = true; },
    setChoices: (value: string[]) => { choices = value; },
    delay: () => { pendingReply = new Promise<void>((resolve) => { releaseReply = resolve; }); },
    release: () => releaseReply?.() };
}

test("GOLDEN-006: the owner sees the clarification on their invitation and can answer it", async ({ page }) => {
  const updated = "Casey owns the fix and expects it on 6 December 2026. Work remains blocked.";
  const withdrawn = "Status: Work has resumed.";
  const f = await fixture(page, { responseChoices: [withdrawn, updated] });
  const input = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
  const record = page.getByRole("button", { name: "Record response" });
  await input.fill("It should be fine next week once they sort it.");
  await record.click();
  await expect(page.getByText("It should be fine next week once they sort it.")).toBeVisible();
  f.requestClarification();
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  const question = page.getByRole("region", { name: "Clarification requested" });
  await expect(question).toContainText(projectUpdateClarificationQuestion);
  const choicesControl = page.getByRole("combobox", { name: "Response choice (optional)" });
  const correction = page.getByRole("combobox", { name: "Correct an earlier response (optional)" });
  await choicesControl.selectOption(withdrawn);
  await expect(input).toHaveCount(0);
  await correction.selectOption(responseId);
  f.fail();
  await record.click();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  f.setChoices([updated]);
  await record.click();
  await expect(page.getByRole("alert")).toContainText("could not be recorded");
  expect(f.submissions[2]).toEqual(f.submissions[1]);
  await expect(choicesControl.getByRole("option", { name: withdrawn })).toHaveCount(0);
  await expect(correction).toHaveValue(responseId);
  await choicesControl.selectOption(updated);
  await record.click();
  await expect(page.getByRole("listitem").filter({ hasText: "Correction to an earlier response" })).toContainText(updated);
  await expect(question).toHaveCount(0);
  expect(f.submissions.at(-1)).toMatchObject({ text: updated, responseType: "CONFIGURED_CHOICE", correctsResponseId: responseId });
});

test("PMO can use a reply suggestion while confirmation remains a separate action", async ({ page }) => {
  const project = { id: locator, portfolioId: customerId, code: "REPLY-CHECK", name: "Synthetic reply interpretation",
    description: "Synthetic fixture", reportedStatus: "GREEN" };
  const path = `/api/projects/${project.id}`;
  const status = "Integration is progressing.";
  const now = new Date();
  let confirmations = 0;
  await page.route("**/api/**", async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    const json = (body: unknown, code = 200) => route.fulfill({ status: code, json: body });
    if (endpoint === "/api/auth/config") return json({ mode: "development", dataMode: "synthetic", scope: "openid profile" });
    if (endpoint === "/api/auth/development") return json({ token: "synthetic-reviewer" });
    if (endpoint === "/api/me") return json({ customerId, subject: "pmo-portfolio", roles: ["pmo_admin"] });
    if (endpoint === "/api/projects") return json([project]);
    if (endpoint === path) return json(project);
    if (endpoint === `${path}/project-update-policy` || endpoint === `${path}/project-update-assessments/latest`) return json(null);
    if (endpoint === `${path}/project-update-capture-history`) return json({ projectId: project.id, engagement: null, nextCursor: null,
      entries: [{ requestId: locator, stageId: locator, stageKind: "REQUEST", recipientSubject: "synthetic-owner",
        capturedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), status: "ACTIVE",
        contentState: "PRESENT", body: "Share an update.", recipientPath: null, interpretationAvailable: true,
        responses: [{ id: responseId, submittedBy: "synthetic-owner", receivedAt: now.toISOString(), correctsResponseId: null,
          state: "UNCONFIRMED", contentState: "PRESENT", text: status }],
        statusReview: { state: "PENDING", responseId, expectedRevision: 0 } }] });
    if (endpoint === `${path}/project-update-reply-interpretations`) {
      expect(route.request().postDataJSON()).toEqual({ requestId: locator, responseId });
      return json({ requestId: locator, responseId, classification: "AGENT_INFERENCE",
        suggestions: [{ factType: "project.status", value: status }] });
    }
    if (endpoint === `${path}/project-update-fact-confirmations`) confirmations++;
    return json({ statusCode: 404, message: "Resource unavailable" }, 404);
  });
  await page.goto("/");
  await page.getByRole("button", { name: /PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reply interpretation/ }).click();
  const review = page.getByRole("region", { name: "Manual project update review" });
  const value = review.getByRole("textbox", { name: "Confirmed project status" });
  await review.getByRole("button", { name: "Interpret reply" }).click();
  await expect(review).toContainText(`Agent inference for status. ${status}`);
  await expect(value).toHaveValue("");
  await review.getByRole("button", { name: "Use status suggestion" }).click();
  await expect(value).toHaveValue(status);
  await expect(review.getByRole("button", { name: "Confirm project status" })).toBeEnabled();
  expect(confirmations).toBe(0);
});

test("historical body and cited schedule expire while the invitation remains open", async ({ page }) => {
  // Both evidence deadlines precede the PM invitation deadline.
  await page.clock.install();
  const f = await fixture(page, { history: true });
  const context = page.getByRole("region", { name: "Escalation request history" });
  await expect(context).toContainText("Historical request near its retention deadline.");
  await expect(context).toContainText("The forecast is 14 days later than the baseline.");
  await expect(context).toContainText(`Reviewed CSV receipt ${correctedResponseId}.`);
  expect(await page.evaluate(() => (window as unknown as { historyExecuted?: unknown }).historyExecuted)).toBeUndefined();
  await page.clock.fastForward(11000);
  await expect(context).not.toContainText("Historical request near its retention deadline.");
  await expect(context).toContainText("Delivery impact: unknown");
  await expect(context).not.toContainText(correctedResponseId);
  await expect(context).toContainText("Request content has expired.");
  await expect(context).toContainText("Retained historical reminder.");
  await expect(page.getByText(f.body, { exact: true })).toBeVisible();
  const reads = f.reads();
  f.deny();
  await page.evaluate(() => window.dispatchEvent(new window.Event("visibilitychange")));
  await expect.poll(f.reads).toBeGreaterThan(reads);
  await expect(page.getByRole("alert")).toContainText("unavailable or has expired");
  await expect(context).toHaveCount(0);
  await expect(page.getByText(f.body, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Your update (unconfirmed)" })).toHaveCount(0);
  const deniedReads = f.reads();
  await page.evaluate(() => window.dispatchEvent(new window.Event("visibilitychange")));
  await page.clock.fastForward(1000);
  expect(f.reads()).toBe(deniedReads);
});

test("escaped source/reply text, explicit unconfirmed receipt, retry key and sign-out cleanup", async ({ page }) => {
  const f = await fixture(page);
  await expect(page.getByText(f.body, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sourceExecuted?: unknown }).sourceExecuted)).toBeUndefined();
  const input = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
  await input.fill("<img src=x onerror=window.replyExecuted=true> Unconfirmed forecast.");
  f.fail();
  await page.getByRole("button", { name: "Record response" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
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
  const f = await fixture(page, { expireSoon: true });
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
  // Install before the SDK creates timers; installing afterward can leave its
  // native expiry timer outside Playwright's virtual clock on Linux.
  await page.clock.install();
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
        dueAt: new Date(Date.now()).toISOString(), capturedAt: new Date(Date.now()).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(), body: "Private authenticated request",
        requiredFacts: [{ factType: "project.forecast", label: "Forecast" }], rawResponseReaders: ["recipient"], responses: [] });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.goto(`/update-requests/${locator}`);
  await page.getByRole("button", { name: "Sign in with your organization" }).click();
  await expect(page).toHaveURL(`http://localhost:5173/update-requests/${locator}`);
  await expect(page.getByRole("region", { name: "Respond to update request" })).toBeVisible();
  await page.getByRole("textbox", { name: "Your update (unconfirmed)" }).fill("Private OIDC draft");
  await page.clock.fastForward(65000);
  await expect(page.getByRole("textbox", { name: "Your update (unconfirmed)" })).toHaveCount(0);
  await expect(page.getByText("Private authenticated request", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("Private OIDC draft");
});
