// EXEC-045: real browser traffic through the packaged customer proxy.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

async function exerciseWorkbook(page, { sourceId, profile }) {
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
  assert.equal(multipart.get("sheet"), Buffer.from("Portfolio").toString("base64url"));
  const file = multipart.get("file");
  assert(file instanceof globalThis.File && file.name === "workbook.xlsx");
  assert(Buffer.from(await file.arrayBuffer()).equals(workbook));
  const originalPreview = await preview.response.json();
  const previewReceiptId = originalPreview.receiptId;
  assert.match(previewReceiptId, uuid);
  assert.deepEqual(originalPreview, { receiptId: previewReceiptId, replayed: false, rowCount: 52 });
  await expect(page.getByText("Sealed column mapping")).toBeVisible();
  await expect(page.getByText("Forecast → project.forecast (date, required)")).toBeVisible();
  await expect(page.getByText("INVALID VALUE", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Select Excel row 2", { exact: true })).toBeDisabled();
  await replayWrite(preview, uploadPath, originalPreview);
  await page.getByLabel("Select Excel row 1", { exact: true }).check();
  await page.getByRole("button", { name: "More Excel rows" }).click();
  await page.getByLabel("Select Excel row 51", { exact: true }).check();

  const review = await observeWrite(page, savePath, 4096,
    () => page.getByRole("button", { name: "Save reviewed Excel proposals (2)" }).click());
  assert.equal(review.response.status(), 201);
  const command = JSON.parse(review.body.toString("utf8"));
  assert.match(command.commandKey, uuid);
  assert.equal(command.previewReceiptId, previewReceiptId);
  assert.deepEqual(command.rowOrdinals, [1, 51]);
  assert.match(command.previewContextSha256, /^[a-f0-9]{64}$/u);
  const originalReview = await review.response.json();
  const reviewedReceiptId = originalReview.receiptId;
  assert.match(reviewedReceiptId, uuid);
  assert.notEqual(reviewedReceiptId, previewReceiptId);
  assert.deepEqual(originalReview, {
    receiptId: reviewedReceiptId, parentPreviewReceiptId: previewReceiptId, replayed: false, rowCount: 2,
  });
  await replayWrite(review, savePath, originalReview);
  await expect(page.getByText("Reviewed Excel import saved · 2 selected rows")).toBeVisible();
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

try {
  assert.equal(process.env.PDAA_XLSX_BROWSER_PROOF, "isolated-customer");
  assert.equal(process.env.NODE_ENV, "production");
  assert(["bundled", "external"].includes(process.env.PDAA_CUSTOMER_PROFILE));
  const cases = JSON.parse(readFileSync(join(fixture, "bindings.json"), "utf8"));
  assert.deepEqual(cases.map(({ profile }) => profile).sort(), profiles);
  assert.equal(new Set(cases.map(({ sourceId }) => sourceId)).size, profiles.length);
  for (const { sourceId } of cases) assert.match(sourceId, uuid);
  step = "identity-readiness";
  await waitForIdentity();
  step = "browser-toolchain";
  browser = await chromium.launch({ args: ["--no-sandbox"], env: { ...process.env, HOME: useSyntheticCa() } });
  const toolchain = verifyBrowserToolchain(browser);
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  step = "sign-in";
  await page.goto(base);
  await signIn(page, "pmo-atlas", "pmo_admin");
  await enterImports(page, true);
  step = "workbook-import";
  const results = [];
  for (const binding of cases) results.push(await exerciseWorkbook(page, binding));
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
  await enterImports(unscoped, false);
  await expect(unscoped.getByText("No authorized Excel sources on this page.")).toBeVisible();
  await denyReceipts(authorization, results);
  await browser.close();
  browser = undefined;
  process.stdout.write(JSON.stringify({ results, toolchain }) + "\n");
} catch {
  process.stderr.write("XLSX_CUSTOMER_BROWSER_FAILED " + step + "\n");
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
