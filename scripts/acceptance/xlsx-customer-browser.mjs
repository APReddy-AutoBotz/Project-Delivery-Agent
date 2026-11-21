// EXEC-045: real browser traffic through the packaged customer proxy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { verifyBrowserToolchain } from "./browser-toolchain.mjs";

const base = "https://web:8443";
const issuer = "https://identity-ingress:8443/identity/realms/pdaa";
const sourcesPath = "/api/ingestion/xlsx/sources";
const fixture = "/xlsx-browser";
const profiles = ["excel-text-v1", "portable-v1"];
const customerId = "10000000-0000-4000-8000-000000000002";
const workbookMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let step = "environment";
let browser;

function useSyntheticCa() {
  const home = mkdtempSync("/tmp/pdaa-xlsx-browser-");
  const nss = join(home, ".pki", "nssdb");
  mkdirSync(nss, { recursive: true });
  execFileSync("certutil", ["-N", "-d", "sql:" + nss, "--empty-password"], { stdio: "pipe" });
  execFileSync("certutil", [
    "-A", "-d", "sql:" + nss, "-n", "pdaa-customer-fixture", "-t", "C,,",
    "-i", "/run/secrets/xlsx-browser-ca.crt",
  ], { stdio: "pipe" });
  return home;
}

async function waitForIdentity() {
  const deadline = performance.now() + 75_000;
  do {
    try {
      const response = await fetch(issuer + "/.well-known/openid-configuration", {
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok && (await response.json()).issuer === issuer) return;
    } catch {
      // The disposable identity service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (performance.now() < deadline);
  throw new Error("Synthetic identity readiness missing");
}

async function observe(page, path, method, action) {
  const [response] = await Promise.all([
    page.waitForResponse((entry) => entry.url() === base + path && entry.request().method() === method),
    action(),
  ]);
  return response;
}

async function signIn(page, subject, role) {
  const signInButton = page.getByRole("button", { name: "Sign in with your organization" });
  await signInButton.waitFor();
  const signedIn = page.waitForResponse((entry) =>
    entry.url() === base + "/api/me" && entry.request().method() === "GET");
  signedIn.catch(() => {});
  await signInButton.click();
  const username = page.locator("#username");
  const needsCredentials = await Promise.race([signedIn.then(() => false), username.waitFor().then(() => true)]);
  if (needsCredentials) {
    assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
    await username.fill(subject);
    await page.locator("#password").fill(readFileSync("/run/secrets/xlsx-browser-login", "utf8"));
    await page.locator("#kc-login").click();
  }
  const response = await signedIn;
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.json(), { customerId, subject, roles: [role] });
  const authorization = await response.request().headerValue("authorization");
  assert.match(authorization ?? "", /^Bearer [A-Za-z0-9_.-]+$/u);
  return authorization;
}

async function enterImports(page, chooseExcel) {
  await page.getByRole("button", { name: "Data imports" }).click();
  if (chooseExcel) await page.getByRole("button", { name: "Excel imports" }).click();
}

async function observeWrite(page, path, maxBytes, action) {
  const url = base + path;
  let requests = 0;
  let body;
  const observeBody = async (route) => {
    const request = route.request();
    if (request.method() === "POST" && ++requests === 1) body = request.postDataBuffer();
    // Chromium's passive request events can omit multipart file bytes.
    await route.continue();
  };
  await page.route(url, observeBody);
  try {
    const response = await observe(page, path, "POST", action);
    assert.equal(requests, 1);
    assert(body?.length && body.length <= maxBytes);
    const contentType = await response.request().headerValue("content-type");
    assert(contentType);
    return { response, body, contentType };
  } finally { await page.unroute(url, observeBody); }
}

async function replayWrite({ response: original, body, contentType }, path, expected) {
  assert.equal(original.status(), 201);
  assert.equal(await original.headerValue("cache-control"), "no-store");
  const request = original.request();
  assert.equal(request.url(), base + path);
  assert.equal(request.method(), "POST");
  const authorization = await request.headerValue("authorization");
  assert.match(authorization ?? "", /^Bearer [A-Za-z0-9_.-]+$/u);
  const replay = await fetch(base + path, {
    method: "POST",
    headers: { authorization, "content-type": contentType },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("cache-control"), "no-store");
  assert.deepEqual(await replay.json(), { ...expected, replayed: true });
}

async function exerciseWorkbook(page, { sourceId, profile, sheet = "Portfolio" }, golden = false) {
  const source = sourcesPath + "/" + sourceId;
  const uploadPath = source + "/previews";
  const savePath = source + "/reviewed-imports";
  const workbook = readFileSync(join(fixture, profile + ".xlsx"));
  await page.getByRole("combobox", { name: "Excel source" }).selectOption(sourceId);
  await page.getByLabel("Excel workbook", { exact: true }).setInputFiles({
    name: "synthetic.xlsx",
    mimeType: workbookMime,
    buffer: workbook,
  });
  const preview = await observeWrite(page, uploadPath, 1_064_960,
    () => page.getByRole("button", { name: "Upload and preview workbook" }).click());
  assert.equal(preview.response.status(), 201);
  const multipart = await new globalThis.Request(base + uploadPath, {
    method: "POST", headers: { "content-type": preview.contentType }, body: preview.body,
  }).formData();
  assert.deepEqual([...multipart.keys()].sort(), ["commandKey", "configRevision", "file", "mappingRevision", "sheet"]);
  assert.match(multipart.get("commandKey"), uuid);
  assert.equal(multipart.get("configRevision"), "1");
  assert.equal(multipart.get("mappingRevision"), "1");
  assert.equal(multipart.get("sheet"), Buffer.from(sheet).toString("base64url"));
  const file = multipart.get("file");
  assert(file instanceof globalThis.File && file.name === "workbook.xlsx");
  assert(Buffer.from(await file.arrayBuffer()).equals(workbook));
  const originalPreview = await preview.response.json();
  const previewReceiptId = originalPreview.receiptId;
  assert.match(previewReceiptId, uuid);
  assert.deepEqual(originalPreview, { receiptId: previewReceiptId, replayed: false, rowCount: golden ? 1 : 52 });
  await expect(page.getByText("Sealed column mapping")).toBeVisible();
  await expect(page.getByText("Forecast → project.forecast (date, required)")).toBeVisible();
  if (golden) {
    await expect(page.getByText("Snapshot → source.snapshot_at (text, required)")).toBeVisible();
  } else {
    await expect(page.getByText("INVALID VALUE", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Select Excel row 2", { exact: true })).toBeDisabled();
  }
  await replayWrite(preview, uploadPath, originalPreview);
  await page.getByLabel("Select Excel row 1", { exact: true }).check();
  if (!golden) {
    await page.getByRole("button", { name: "More Excel rows" }).click();
    await page.getByLabel("Select Excel row 51", { exact: true }).check();
  }
  const selected = golden ? [1] : [1, 51];

  const review = await observeWrite(page, savePath, 4096,
    () => page.getByRole("button", { name: `Save reviewed Excel proposals (${selected.length})` }).click());
  assert.equal(review.response.status(), 201);
  const command = JSON.parse(review.body.toString("utf8"));
  assert.match(command.commandKey, uuid);
  assert.equal(command.previewReceiptId, previewReceiptId);
  assert.deepEqual(command.rowOrdinals, selected);
  assert.match(command.previewContextSha256, /^[a-f0-9]{64}$/u);
  const originalReview = await review.response.json();
  const reviewedReceiptId = originalReview.receiptId;
  assert.match(reviewedReceiptId, uuid);
  assert.notEqual(reviewedReceiptId, previewReceiptId);
  assert.deepEqual(originalReview, {
    receiptId: reviewedReceiptId, parentPreviewReceiptId: previewReceiptId, replayed: false, rowCount: selected.length,
  });
  await replayWrite(review, savePath, originalReview);
  await expect(page.getByText(`Reviewed Excel import saved · ${selected.length} selected rows`)).toBeVisible();
  await expect(page.getByText(reviewedReceiptId, { exact: true })).toBeVisible();
  return { profile, sourceId, previewReceiptId, reviewedReceiptId, previewContextSha256: command.previewContextSha256 };
}

async function reopen(page, { sourceId, previewReceiptId, reviewedReceiptId }) {
  await page.getByRole("combobox", { name: "Excel source" }).selectOption(sourceId);
  await page.getByLabel("Excel preview receipt ID").fill(previewReceiptId);
  await page.getByRole("button", { name: "Open Excel preview" }).click();
  await expect(page.getByText(reviewedReceiptId, { exact: true })).toBeVisible();
  await expect(page.getByLabel("Select Excel row 1", { exact: true })).toBeDisabled();
}

async function denyReceipts(authorization, results) {
  for (const { sourceId, previewReceiptId } of results) {
    const path = sourcesPath + "/" + sourceId + "/previews/" + previewReceiptId;
    for (const suffix of ["", "/review-details"]) {
      const response = await fetch(base + path + suffix, {
        headers: { authorization },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      await response.arrayBuffer();
    }
  }
}

async function goldenSession(subject, role) {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(base);
  return { page, authorization: await signIn(page, subject, role) };
}

async function goldenApi(session, path, status = 200, method = "GET", data) {
  const response = await fetch(base + path, {
    method, redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { authorization: session.authorization, ...(data ? { "content-type": "application/json" } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal(response.status, status, method + " " + path);
  return status === 200 || status === 201 ? response.json() : null;
}

function verifyMixedAssessment(assessment, fixture) {
  assert.equal(assessment.visibility, "available");
  const { result } = assessment;
  assert.equal(result.status, "CONFLICTING");
  assert.equal(result.evaluations.length, 4);
  assert(!Object.hasOwn(result, "resolvedValue"));
  assert.deepEqual(result.contributors.flatMap((item) => item.supportingVersionIds).sort(),
    fixture.positions.map((item) => item.versionId).sort());
  for (const item of fixture.positions) {
    const target = result.evaluations.find(({ targetId }) => targetId === item.targetId);
    assert.equal(target?.targetKind, item.targetKind);
    assert.deepEqual(target.assessment.resolvedValue, { type: "text", value: item.state });
    const evidence = target.assessment.versions.find(({ id }) => id === item.versionId);
    assert.equal(evidence?.provenance, "SYSTEM_VERIFIED");
    assert.equal(evidence.source.recordType, item.type);
    assert.equal(evidence.source.instanceId, item.sourceId);
  }
}

function withheld(delivery) {
  assert.equal(delivery.visibility, "restricted");
  assert.equal(delivery.revalidationRequired, true);
  assert.equal(delivery.result, null);
}

async function goldenHistory(session, project, item, available) {
  const history = await goldenApi(session, project + "/facts/" + encodeURIComponent(item.factType) + "/history");
  assert.equal(history.entries.length, 1);
  const [entry] = history.entries;
  assert.equal(entry.id, item.versionId);
  if (available) {
    assert.equal(entry.visibility, "available");
    assert.equal(entry.content.provenance, "SYSTEM_VERIFIED");
    assert.equal(entry.content.source.recordType, item.type);
    assert.deepEqual(entry.content.value, { type: "text", value: item.state });
  } else {
    assert.equal(entry.visibility, "restricted");
    assert.equal(entry.revalidationRequired, true);
    assert(!Object.hasOwn(entry, "content"));
  }
}

async function goldenAnswer(leader, fixture, status) {
  const path = `/api/projects/${fixture.projectId}/milestones/${fixture.milestoneId}/leadership-conflict-observation`;
  const page = leader.page;
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: /Source-backed milestone disagreement/ }).click();
  await page.getByLabel("Milestone", { exact: true }).selectOption(fixture.milestoneId);
  await page.getByLabel("Question", { exact: true }).fill(
    "Does the selected milestone's recorded completion conflict with required work?",
  );
  const response = await observe(page, path, "GET", () => page.getByRole("button", { name: "Check question" }).click());
  assert.equal(response.status(), status);
  if (status === 200) {
    const result = await response.json();
    assert.equal(result.outcome, "CONFLICTING");
    assert.equal(result.positions.length, 4);
    for (const item of fixture.positions) {
      const target = result.positions.find(({ targetId }) => targetId === item.targetId);
      assert.equal(target?.state, item.state);
      const [evidence] = target.supports;
      assert.equal(target.supports.length, 1);
      assert.equal(evidence.versionId, item.versionId);
      assert.equal(evidence.sourceKind, item.type);
      assert.equal(evidence.provenance, "SYSTEM_VERIFIED");
      assert.equal(evidence.freshness, "CURRENT");
      assert(Date.parse(evidence.assessedValidUntil) > Date.parse(result.asOf));
    }
    assert(!JSON.stringify(result).includes("GOLD-1"));
    await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
    await expect(page.getByText("Reviewed Excel row snapshot", { exact: false })).toBeVisible();
    await expect(page.getByText("Jira issue snapshot", { exact: false })).toHaveCount(3);
  } else {
    await expect(page.getByText("Completion check is unavailable", { exact: false })).toBeVisible();
    await expect(page.getByText("Jira issue snapshot", { exact: false })).toHaveCount(0);
  }
  return path;
}

async function goldenReconciliation(fixture) {
  const project = "/api/projects/" + fixture.projectId;
  const checkPath = project + "/milestone-reconciliation-checks";
  const pmo = await goldenSession("pmo-atlas", "pmo_admin");
  const pm = await goldenSession("pm-atlas", "project_manager");
  const leader = await goldenSession("leader-atlas", "leadership");
  const operator = await goldenSession("operator", "system_admin");
  const command = {
    projectId: fixture.projectId, milestoneId: fixture.milestoneId,
    ruleRevision: "milestone-required-state/v1", enabled: true, idempotencyKey: randomUUID(),
  };
  const checked = await goldenApi(pmo, checkPath, 201, "POST", command);
  assert.equal(checked.outcome, "CREATED");
  assert.equal(checked.replayed, false);
  assert.equal(checked.request.assignment.recipientSubject, "pm-atlas");
  assert.equal(checked.request.assignment.revision, 1);
  verifyMixedAssessment(checked.assessment, fixture);
  const replay = await goldenApi(pmo, checkPath, 201, "POST", command);
  assert.deepEqual(replay, { ...checked, replayed: true, assessment: { ...checked.assessment, replayed: true } });
  const reused = await goldenApi(pmo, checkPath, 201, "POST", { ...command, idempotencyKey: randomUUID() });
  assert.equal(reused.outcome, "REUSED");
  assert.equal(reused.request.id, checked.request.id);
  verifyMixedAssessment(reused.assessment, fixture);
  const requestId = checked.request.id;
  const copied = project + "/reconciliation-requests/" + requestId;
  const delivery = await goldenApi(pm, copied);
  assert.deepEqual(delivery.assessment, checked.assessment);
  assert.deepEqual((await goldenApi(pm, project + "/reconciliation-requests")).requests, [checked.request]);
  await goldenApi(leader, copied, 404);
  await pm.page.goto(`${base}/?project=${fixture.projectId}&reconciliation=${requestId}`);
  pm.authorization = await signIn(pm.page, "pm-atlas", "project_manager");
  const panel = pm.page.getByRole("region", { name: "PM reconciliation request", exact: true });
  await expect(panel.getByText("Reviewed Excel row snapshot", { exact: false })).toBeVisible();
  await expect(panel.getByText("Jira issue snapshot", { exact: false })).toHaveCount(3);
  const savedLink = await panel.getByRole("link", { name: "Open saved reconciliation link" }).getAttribute("href");
  assert.equal(savedLink, `/?project=${fixture.projectId}&reconciliation=${requestId}`);

  const answer = await goldenAnswer(leader, fixture, 200);
  const workbook = fixture.positions.find(({ type }) => type === "xlsx.row");
  await goldenHistory(leader, project, workbook, true);
  const leaderGrant = { subject: "leader-atlas", scopeType: "project", scopeId: fixture.projectId };
  await goldenApi(operator, "/api/access-grants", 204, "DELETE", leaderGrant);
  await goldenApi(leader, project + "/facts/" + encodeURIComponent(workbook.factType) + "/history", 404);
  await goldenApi(leader, answer, 404);
  const refresh = () => leader.page.getByRole("button", { name: "Refresh completion check" }).click();
  assert.equal((await observe(leader.page, answer, "GET", refresh)).status(), 404);
  await expect(leader.page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  await goldenApi(operator, "/api/access-grants", 204, "POST", { ...leaderGrant, role: "leadership" });

  const workbookAccess = project + "/fact-sources/" + workbook.sourceId + "/access";
  const revoke = await goldenApi(pmo, workbookAccess, 200, "POST", {
    projectId: fixture.projectId, sourceId: workbook.sourceId,
    state: "REVOKED", readers: [], expectedRevision: workbook.sourceAccessRevision,
  });
  await goldenHistory(pm, project, workbook, false);
  withheld((await goldenApi(pm, copied)).assessment);
  await pm.page.goto(base + savedLink);
  pm.authorization = await signIn(pm.page, "pm-atlas", "project_manager");
  await expect(panel.getByText("Proof withheld. Source access or verification changed", { exact: false })).toBeVisible();
  await expect(panel.getByText("Reviewed Excel row snapshot", { exact: false })).toHaveCount(0);
  const restrictedReplay = await goldenApi(pmo, checkPath, 201, "POST", command);
  assert.equal(restrictedReplay.checkId, checked.checkId);
  assert.equal(restrictedReplay.replayed, true);
  withheld(restrictedReplay.assessment);
  await goldenApi(leader, answer, 503);
  await goldenApi(pmo, workbookAccess, 200, "POST", {
    projectId: fixture.projectId, sourceId: workbook.sourceId, state: "AVAILABLE",
    readers: ["pmo-atlas", "pm-atlas", "leader-atlas"], expectedRevision: revoke.revision,
  });
  await goldenHistory(pm, project, workbook, true);
  assert.deepEqual((await goldenApi(pm, copied)).assessment, checked.assessment);
  return {
    requestId, assessmentId: checked.assessment.assessmentId, checkId: checked.checkId,
    reusedCheckId: reused.checkId, command, projectAndFactRevocations: true,
  };
}

async function goldenJiraDenial(fixture) {
  const pmo = await goldenSession("pmo-atlas", "pmo_admin");
  const pm = await goldenSession("pm-atlas", "project_manager");
  const leader = await goldenSession("leader-atlas", "leadership");
  const project = "/api/projects/" + fixture.projectId;
  await goldenAnswer(leader, fixture, 503);
  await goldenHistory(pm, project, fixture.positions.find(({ type }) => type === "jira.issue"), false);
  await goldenHistory(pm, project, fixture.positions.find(({ type }) => type === "xlsx.row"), true);
  withheld((await goldenApi(pm, project + "/reconciliation-requests/" + fixture.requestId)).assessment);
  const replay = await goldenApi(pmo, project + "/milestone-reconciliation-checks", 201, "POST", fixture.command);
  assert.equal(replay.checkId, fixture.checkId);
  assert.equal(replay.replayed, true);
  withheld(replay.assessment);
  return { jiraScopeRevocation: true };
}

async function goldenRedelivery(fixture) {
  const pm = await goldenSession("pm-atlas", "project_manager");
  const project = "/api/projects/" + fixture.projectId;
  const delivery = await goldenApi(pm, project + "/reconciliation-requests/" + fixture.requestId);
  assert.equal(delivery.request.id, fixture.requestId);
  assert.equal(delivery.assessment.assessmentId, fixture.assessmentId);
  verifyMixedAssessment(delivery.assessment, fixture);
  return { originalEvidenceRedelivered: true };
}

async function xlsxJourney(toolchain) {
  const cases = JSON.parse(readFileSync(join(fixture, "bindings.json"), "utf8"));
  assert.deepEqual(cases.map(({ profile }) => profile).sort(), profiles);
  assert.equal(new Set(cases.map(({ sourceId }) => sourceId)).size, profiles.length);
  for (const { sourceId } of cases) assert.match(sourceId, uuid);
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  step = "sign-in";
  await page.goto(base);
  await signIn(page, "pmo-atlas", "pmo_admin");
  await enterImports(page, true);
  step = "workbook-import";
  const results = [];
  for (const binding of cases) results.push(await exerciseWorkbook(page, binding));
  step = "golden-workbook";
  const goldenBinding = JSON.parse(readFileSync(join(fixture, "golden.json"), "utf8"));
  assert.match(goldenBinding.sourceId, uuid);
  assert.equal(goldenBinding.sheet, "Portfolio");
  const golden = await exerciseWorkbook(page, { ...goldenBinding, profile: "golden" }, true);
  step = "receipt-reload";
  await page.reload();
  await signIn(page, "pmo-atlas", "pmo_admin");
  await enterImports(page, true);
  for (const result of results) await reopen(page, result);
  await page.close();
  step = "scope-denial";
  const unscoped = await browser.newPage();
  unscoped.setDefaultTimeout(20_000);
  await unscoped.goto(base);
  const authorization = await signIn(unscoped, "pm-atlas", "project_manager");
  await denyReceipts(authorization, results);
  return { results, golden, toolchain };
}

try {
  assert.equal(process.env.PDAA_XLSX_BROWSER_PROOF, "isolated-customer");
  assert.equal(process.env.NODE_ENV, "production");
  assert(["bundled", "external"].includes(process.env.PDAA_CUSTOMER_PROFILE));
  const phase = process.argv[2] ?? "xlsx";
  const checks = {
    "golden-reconciliation": goldenReconciliation,
    "golden-jira-denial": goldenJiraDenial,
    "golden-redelivery": goldenRedelivery,
  };
  assert(phase === "xlsx" || Object.hasOwn(checks, phase));
  step = "identity-readiness";
  await waitForIdentity();
  step = "browser-toolchain";
  browser = await chromium.launch({ args: ["--no-sandbox"], env: { ...process.env, HOME: useSyntheticCa() } });
  const toolchain = verifyBrowserToolchain(browser);
  step = phase;
  const result = phase === "xlsx" ? await xlsxJourney(toolchain) : await checks[phase](JSON.parse(process.argv[3]));
  await browser.close();
  browser = undefined;
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("XLSX_CUSTOMER_BROWSER_FAILED " + step + "\n");
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
