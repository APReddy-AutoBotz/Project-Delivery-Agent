// FR-CON-006/007: genuine CSV HTTP/browser proof in the disposable customer profiles.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { closeCustomerBrowserSession } from "./customer-session.mjs";
import { csvImportFixture } from "./csv-import-fixture.mjs";
import {
  assertCsvFixture,
  csvProjectionReceipt,
  inspectCsvNativeBatch,
} from "./csv-import-native.mjs";
import {
  installCsvDeliveryLoss,
  readCsvDeliveryLoss,
  restoreCsvDeliveryLoss,
} from "./csv-import-delivery-loss.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");

async function csvApi(session, base, path, status, options = {}) {
  session.assertCsvActive?.();
  assert(
    /^\/(?:ingestion\/sources\/[0-9a-f-]{36}\/|projects\/[0-9a-f-]{36}$)/.test(
      path,
    ),
  );
  let response;
  try {
    response = await session.context.request.fetch(base + "/api" + path, {
      method: options.method ?? "GET",
      timeout: 15000,
      maxRedirects: 0,
      headers: {
        Authorization: "Bearer " + session.token,
        ...(options.data === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.data === undefined ? {} : { data: options.data }),
      ...(options.multipart === undefined
        ? {}
        : { multipart: options.multipart }),
    });
  } catch {
    throw new Error("CSV HTTP proof unavailable");
  }
  let bytes, responseHeaders, responseStatus, responseUrl;
  try {
    bytes = await response.body();
    responseHeaders = response.headersArray();
    responseStatus = response.status();
    responseUrl = response.url();
  } finally {
    await response.dispose();
  }
  assert.equal(responseUrl, base + "/api" + path, "CSV HTTP proof endpoint");
  assert(
    bytes.length > 0 && bytes.length <= 65536,
    "CSV HTTP proof body bound",
  );
  session.disclosure.add("csv-api-headers", JSON.stringify(responseHeaders));
  session.disclosure.add("csv-api-bodies", bytes.toString("utf8"));
  assert.equal(responseStatus, status, "CSV HTTP proof status");
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("CSV HTTP proof encoding");
  }
  return {
    evidence: { status, bytes: bytes.length, sha256: hash(bytes) },
    body,
  };
}

function waitCsvResponse(page, predicate) {
  const promise = page.waitForResponse(predicate);
  promise.catch(() => {});
  return promise;
}
function waitCsvFinished(page, predicate) {
  const promise = page.waitForEvent("requestfinished", predicate);
  promise.catch(() => {});
  return promise;
}

async function originalAck(response, url, kind, replayed) {
  assert.equal(response.url(), url);
  assert.equal(response.request().method(), "POST");
  assert.equal(response.status(), 201);
  const bytes = await response.body();
  assert(bytes.length > 0 && bytes.length <= 65536);
  const body = JSON.parse(bytes.toString("utf8"));
  assertAck(body, kind, replayed);
  return { status: 201, bytes: bytes.length, sha256: hash(bytes), body };
}
function assertAck(body, kind, replayed, parent) {
  assert(
    keys(
      body,
      kind === "preview"
        ? ["receiptId", "replayed", "rowCount"]
        : ["receiptId", "parentPreviewReceiptId", "replayed", "rowCount"],
    ),
  );
  assert.match(body.receiptId, uuid);
  assert.equal(body.replayed, replayed);
  assert.equal(body.rowCount, kind === "preview" ? 3 : 1);
  if (kind === "review") {
    assert.match(body.parentPreviewReceiptId, uuid);
    if (parent !== undefined) assert.equal(body.parentPreviewReceiptId, parent);
  }
}
function previewCommand(request) {
  const contentType = request.headers()["content-type"];
  const match =
    /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\r\n]+))$/i.exec(
      contentType ?? "",
    );
  assert(match, "Original CSV multipart boundary unavailable");
  const boundary = match[1] ?? match[2];
  assert(boundary.length > 0 && boundary.length <= 128);
  const bytes = request.postDataBuffer();
  assert(bytes && bytes.length < 1048576 + 8192);
  const parts = bytes.toString("utf8").split("--" + boundary);
  const field = (name) => {
    const prefix = `\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`;
    const values = parts.filter((part) => part.startsWith(prefix));
    assert.equal(values.length, 1);
    assert(values[0].endsWith("\r\n"));
    return values[0].slice(prefix.length, -2);
  };
  const commandKey = field("commandKey");
  assert.match(commandKey, uuid);
  assert.equal(field("configRevision"), "1");
  assert.equal(field("mappingRevision"), "1");
  return {
    commandKey,
    configRevision: 1,
    mappingRevision: 1,
    csvSha256: csvImportFixture.csvSha256,
  };
}
function receiptSummary(value, binding, receiptId, kind, parent) {
  assert(
    value &&
      typeof value === "object" &&
      value.receipt &&
      Array.isArray(value.outcomes),
  );
  const receipt = value.receipt;
  assert.equal(receipt.id, receiptId);
  assert.equal(receipt.sourceId, binding.sourceId);
  assert.equal(receipt.actor, "pmo-atlas");
  assert.equal(receipt.kind, kind);
  assert.equal(receipt.configRevision, 1);
  assert.equal(receipt.mappingRevision, 1);
  assert.equal(receipt.parentPreviewReceiptId, parent);
  assert.equal(receipt.rowCount, kind === "CSV_PREVIEW" ? 3 : 1);
  assert.equal(value.outcomes.length, receipt.rowCount);
  const outcomes = value.outcomes.map((row) => {
    assert.equal(row.projectId, binding.projectId);
    const sourceOrdinal =
      kind === "CSV_PREVIEW" ? row.ordinal : row.parentOrdinal;
    if (sourceOrdinal === 2) {
      assert.equal(row.state, "INVALID");
      assert.equal(row.operation, "NONE");
      assert(row.errorCodes.includes("INVALID_VALUE"));
      assert.equal(row.proposals, null);
      assert.equal(row.identity, null);
      assert.equal(row.contentAvailable, false);
    } else {
      assert([1, 3].includes(sourceOrdinal));
      assert.equal(row.state, "ACCEPTED");
      assert.equal(row.operation, "CREATE");
      assert.equal(row.contentAvailable, true);
      assert.deepEqual(row.errorCodes, []);
      assert.deepEqual(row.identity, [
        "spreadsheet:Projects",
        hash(JSON.stringify(["Projects", `DELIVERY-${sourceOrdinal}`])),
      ]);
      assert.deepEqual(row.proposals, [
        {
          factType: "project.forecast",
          value: {
            type: "date",
            value: sourceOrdinal === 1 ? "2027-03-01" : "2027-04-15",
          },
        },
      ]);
    }
    return {
      ordinal: row.ordinal,
      parentOrdinal: row.parentOrdinal,
      state: row.state,
      operation: row.operation,
      projectId: row.projectId,
      identity: row.identity,
      contentAvailable: row.contentAvailable,
      proposalCount: row.proposals?.length ?? 0,
    };
  });
  assert.deepEqual(
    outcomes.map(({ ordinal, parentOrdinal, state, operation }) => ({
      ordinal,
      parentOrdinal,
      state,
      operation,
    })),
    kind === "CSV_PREVIEW"
      ? [
          {
            ordinal: 1,
            parentOrdinal: null,
            state: "ACCEPTED",
            operation: "CREATE",
          },
          {
            ordinal: 2,
            parentOrdinal: null,
            state: "INVALID",
            operation: "NONE",
          },
          {
            ordinal: 3,
            parentOrdinal: null,
            state: "ACCEPTED",
            operation: "CREATE",
          },
        ]
      : [
          {
            ordinal: 1,
            parentOrdinal: 3,
            state: "ACCEPTED",
            operation: "CREATE",
          },
        ],
  );
  return {
    id: receiptId,
    sourceId: binding.sourceId,
    actor: receipt.actor,
    kind,
    rowCount: receipt.rowCount,
    parentPreviewReceiptId: parent,
    configRevision: 1,
    mappingRevision: 1,
    outcomes,
  };
}
function nativeExpected(fixture) {
  return {
    csvSha256: csvImportFixture.csvSha256,
    rowSourceHashes: csvImportFixture.rowSourceHashes,
    previewReceiptId: fixture.previewReceiptId,
    previewCommandKey: fixture.preview.commandKey,
    reviewReceiptId: fixture.reviewReceiptId,
    reviewCommandKey: JSON.parse(fixture.review.posts[0]).commandKey,
  };
}
function canonicalReceipt(value) {
  const receipt = csvProjectionReceipt(value);
  for (const table of [
    "Project",
    "AccessGrant",
    "ProjectFact",
    "ProjectFactVersion",
    "FactEvidence",
    "FactAppendReceipt",
  ])
    assert(
      receipt.counts[table] > 0,
      "CSV canonical control must be populated",
    );
  return receipt;
}
async function previewReplay(
  session,
  base,
  fixture,
  csv = csvImportFixture.csv,
  status = 201,
) {
  const response = await csvApi(
    session,
    base,
    `/ingestion/sources/${fixture.sourceId}/csv-previews`,
    status,
    {
      method: "POST",
      multipart: {
        commandKey: fixture.preview.commandKey,
        configRevision: "1",
        mappingRevision: "1",
        file: {
          name: csvImportFixture.fileName,
          mimeType: "text/csv",
          buffer: Buffer.from(csv, "utf8"),
        },
      },
    },
  );
  if (status === 201) {
    assertAck(response.body, "preview", true);
    assert.equal(response.body.receiptId, fixture.previewReceiptId);
  }
  return {
    ...response.evidence,
    ...(status === 201 ? { body: response.body } : {}),
  };
}
async function reviewReplay(session, base, fixture) {
  const response = await csvApi(
    session,
    base,
    `/ingestion/sources/${fixture.sourceId}/reviewed-imports`,
    201,
    { method: "POST", data: JSON.parse(fixture.review.posts[0]) },
  );
  assertAck(response.body, "review", true, fixture.previewReceiptId);
  assert.equal(response.body.receiptId, fixture.reviewReceiptId);
  return { ...response.evidence, body: response.body };
}

export async function exerciseCsvImportWorkflow({
  login,
  base,
  pool,
  binding: initialBinding,
  output,
  canonicalSnapshot,
}) {
  assertCsvFixture(initialBinding);
  assert.equal(
    hash(Buffer.from(csvImportFixture.csv)),
    csvImportFixture.csvSha256,
  );
  const session = await login("pmo-atlas");
  const { page, capture } = session;
  page.setDefaultTimeout(15000);
  let canonicalBefore,
    result,
    failure,
    deadline,
    expired = false;
  const active = () => assert(!expired, "CSV browser proof expired");
  session.assertCsvActive = active;
  const work = (async () => {
    canonicalBefore = await canonicalSnapshot(pool);
    canonicalReceipt(canonicalBefore);
    active();
    await page.getByRole("button", { name: /Data imports/ }).click();
    await expect(
      page.getByRole("heading", { name: "Review a CSV import", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Sheet label", { exact: true }).fill("Projects");
    await page.getByLabel("Identity column", { exact: true }).fill("Issue ID");
    await page
      .getByLabel("Project ID column", { exact: true })
      .fill("Project ID");
    await page.getByLabel("CSV column", { exact: true }).fill("Forecast");
    await page
      .getByLabel("Proposal field", { exact: true })
      .fill("project.forecast");
    await page.getByLabel("Value type", { exact: true }).selectOption("date");
    await page.getByLabel("Required", { exact: true }).check();
    await page.getByLabel(/Customer installation fixture/).check();
    const configured = waitCsvResponse(
      page,
      (response) =>
        response.url() === base + "/api/ingestion/sources/configuration" &&
        response.request().method() === "POST",
    );
    active();
    await page
      .getByRole("button", { name: "Create mapping", exact: true })
      .click();
    const configuredResponse = await configured;
    assert.equal(configuredResponse.status(), 201);
    const configuration = await configuredResponse.json();
    assert(
      keys(configuration, ["sourceId", "configRevision", "mappingRevision"]),
    );
    assert.match(configuration.sourceId, uuid);
    assert.equal(configuration.configRevision, 1);
    assert.equal(configuration.mappingRevision, 1);
    const binding = { ...initialBinding, sourceId: configuration.sourceId };
    const submitted = configuredResponse.request().postDataJSON();
    assert.deepEqual(submitted.projects, [
      { projectId: binding.projectId, readers: ["pmo-atlas"] },
    ]);
    assert.equal(submitted.binding.customerId, binding.customerId);
    assert.equal(submitted.binding.sourceId, binding.sourceId);
    await expect(
      page.getByRole("status").filter({ hasText: "Mapping saved." }),
    ).toBeVisible();
    const previewUrl =
      base + `/api/ingestion/sources/${binding.sourceId}/csv-previews`;
    active();
    await page.getByLabel("CSV file", { exact: true }).setInputFiles({
      name: csvImportFixture.fileName,
      mimeType: "text/csv",
      buffer: Buffer.from(csvImportFixture.csv),
    });
    const previewResponse = waitCsvResponse(
      page,
      (response) =>
        response.url() === previewUrl && response.request().method() === "POST",
    );
    active();
    await page
      .getByRole("button", { name: "Upload and preview", exact: true })
      .click();
    const previewOriginal = await previewResponse;
    const acknowledgement = await originalAck(
      previewOriginal,
      previewUrl,
      "preview",
      false,
    );
    const preview = previewCommand(previewOriginal.request());
    const previewReceiptId = acknowledgement.body.receiptId;
    await expect(
      page.getByRole("heading", {
        name: `Preview ${previewReceiptId.slice(0, 8)}`,
        exact: true,
      }),
    ).toBeVisible();
    const tableRows = page.getByRole("row");
    await expect(tableRows).toHaveCount(4);
    await expect(tableRows.nth(1)).toContainText("CREATE");
    await expect(tableRows.nth(2)).toContainText("INVALID VALUE");
    await expect(tableRows.nth(3)).toContainText("CREATE");
    await expect(
      page.getByRole("checkbox", { name: "Select row 2", exact: true }),
    ).toBeDisabled();
    const readPreview = await csvApi(
      session,
      base,
      `/ingestion/sources/${binding.sourceId}/receipts/${previewReceiptId}`,
      200,
    );
    const previewRead = receiptSummary(
      readPreview.body,
      binding,
      previewReceiptId,
      "CSV_PREVIEW",
      null,
    );
    const beforeInvalid = await inspectCsvNativeBatch(pool, binding, {
      ...preview,
      previewReceiptId,
      previewCommandKey: preview.commandKey,
      rowSourceHashes: csvImportFixture.rowSourceHashes,
    });
    const invalid = await csvApi(
      session,
      base,
      `/ingestion/sources/${binding.sourceId}/reviewed-imports`,
      409,
      {
        method: "POST",
        data: { previewReceiptId, rowOrdinals: [2], commandKey: randomUUID() },
      },
    );
    const afterInvalid = await inspectCsvNativeBatch(pool, binding, {
      ...preview,
      previewReceiptId,
      previewCommandKey: preview.commandKey,
      rowSourceHashes: csvImportFixture.rowSourceHashes,
    });
    assert.deepEqual(afterInvalid, beforeInvalid);
    active();
    await page
      .getByRole("checkbox", { name: "Select row 3", exact: true })
      .check();
    await expect(
      page.getByRole("checkbox", { name: "Select row 1", exact: true }),
    ).not.toBeChecked();
    await installCsvDeliveryLoss(page, {
      base,
      sourceId: binding.sourceId,
      previewReceiptId,
      rowOrdinals: [3],
    });
    const target =
      base + `/api/ingestion/sources/${binding.sourceId}/reviewed-imports`;
    const finished = new Set(),
      failed = new Set();
    const finishedListener = (request) => {
      if (request.url() === target && request.method() === "POST")
        finished.add(request);
    };
    const failedListener = (request) => {
      if (request.url() === target && request.method() === "POST")
        failed.add(request);
    };
    page.on("requestfinished", finishedListener);
    page.on("requestfailed", failedListener);
    try {
      const firstFinished = waitCsvFinished(
        page,
        (request) => request.url() === target && request.method() === "POST",
      );
      active();
      await page
        .getByRole("button", { name: "Save 1 reviewed proposal", exact: true })
        .click();
      await expect(
        page.getByText(
          "The reviewed import could not be confirmed. Retry the original selection.",
          { exact: true },
        ),
      ).toBeVisible();
      await firstFinished;
      await capture.settle(page);
      const withheld = await readCsvDeliveryLoss(page);
      assert.equal(withheld.failure, null);
      assert.equal(withheld.posts.length, 1);
      assert.equal(withheld.first?.eof, true);
      assert.equal(withheld.first?.released, true);
      assert.equal(finished.size, 1);
      assert.equal(failed.size, 0);
      await expect(
        page.getByRole("button", { name: "Upload and preview", exact: true }),
      ).toBeDisabled();
      const fixture = {
        ...binding,
        preview,
        previewReceiptId,
        reviewReceiptId: withheld.first.body.receiptId,
        review: { posts: withheld.posts },
      };
      const beforeRetry = await inspectCsvNativeBatch(
        pool,
        binding,
        nativeExpected(fixture),
      );
      const retried = waitCsvResponse(
        page,
        (response) =>
          response.url() === target && response.request().method() === "POST",
      );
      const retryFinished = waitCsvFinished(
        page,
        (request) => request.url() === target && request.method() === "POST",
      );
      active();
      await page
        .getByRole("button", {
          name: "Retry original reviewed selection",
          exact: true,
        })
        .click();
      const retryAck = await originalAck(await retried, target, "review", true);
      assert.equal(retryAck.body.receiptId, fixture.reviewReceiptId);
      assert.equal(retryAck.body.parentPreviewReceiptId, previewReceiptId);
      await retryFinished;
      await expect(
        page.getByText("Reviewed import receipt saved", { exact: true }),
      ).toBeVisible();
      await capture.settle(page);
      const delivery = await readCsvDeliveryLoss(page);
      assert.equal(delivery.failure, null);
      assert.deepEqual(delivery.posts, [withheld.posts[0], withheld.posts[0]]);
      assert.equal(finished.size, 2);
      assert.equal(failed.size, 0);
      const afterRetry = await inspectCsvNativeBatch(
        pool,
        binding,
        nativeExpected(fixture),
      );
      assert.deepEqual(afterRetry, beforeRetry);
      const readReview = await csvApi(
        session,
        base,
        `/ingestion/sources/${binding.sourceId}/receipts/${fixture.reviewReceiptId}`,
        200,
      );
      const reviewRead = receiptSummary(
        readReview.body,
        binding,
        fixture.reviewReceiptId,
        "CSV_REVIEWED_IMPORT",
        previewReceiptId,
      );
      const previewReplayed = await previewReplay(session, base, fixture);
      const reviewReplayed = await reviewReplay(session, base, fixture);
      const changedPreview = await previewReplay(
        session,
        base,
        fixture,
        csvImportFixture.csv.replace("2027-03-01", "2027-03-02"),
        409,
      );
      const changedReview = await csvApi(
        session,
        base,
        `/ingestion/sources/${binding.sourceId}/reviewed-imports`,
        409,
        {
          method: "POST",
          data: { ...JSON.parse(delivery.posts[0]), rowOrdinals: [1] },
        },
      );
      const secondCommand = await csvApi(
        session,
        base,
        `/ingestion/sources/${binding.sourceId}/reviewed-imports`,
        409,
        {
          method: "POST",
          data: {
            previewReceiptId,
            rowOrdinals: [1],
            commandKey: randomUUID(),
          },
        },
      );
      const afterProbes = await inspectCsvNativeBatch(
        pool,
        binding,
        nativeExpected(fixture),
      );
      assert.deepEqual(afterProbes, afterRetry);
      const filename = "csv-native-reviewed-import.png";
      await page.screenshot({ path: join(output, filename), fullPage: true });
      result = {
        schemaVersion: 1,
        ...binding,
        previewReceiptId,
        reviewReceiptId: fixture.reviewReceiptId,
        preview: { ...preview, acknowledgement, receipt: previewRead },
        review: {
          posts: delivery.posts,
          attempts: delivery.attempts,
          first: delivery.first,
          retryAck,
          requestsFinished: finished.size,
          requestsFailed: failed.size,
          uncertainShown: true,
          freshWriteDisabled: true,
          completedBeforeRetry: true,
          nativeBeforeRetry: beforeRetry,
          nativeAfterRetry: afterRetry,
          receipt: reviewRead,
        },
        apiReplays: { preview: previewReplayed, review: reviewReplayed },
        negative: {
          invalidRow: invalid.evidence,
          nativeBeforeInvalid: beforeInvalid,
          nativeAfterInvalid: afterInvalid,
          changedPreview,
          changedReview: changedReview.evidence,
          secondCommand: secondCommand.evidence,
          previewUnchangedAfterInvalid:
            beforeInvalid.sha256 === afterInvalid.sha256,
          nativeAfterProbes: afterProbes,
        },
        screenshot: {
          file: filename,
          sha256: hash(readFileSync(join(output, filename))),
        },
      };
    } finally {
      page.off("requestfinished", finishedListener);
      page.off("requestfailed", failedListener);
      await restoreCsvDeliveryLoss(page);
    }
  })();
  work.catch(() => {});
  try {
    await Promise.race([
      work,
      new Promise((_, reject) => {
        deadline = setTimeout(() => {
          expired = true;
          reject(new Error("CSV browser proof deadline"));
        }, 90000);
      }),
    ]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    if (expired) {
      // Keep strict drain/completeness failures; context closure terminates the
      // losing browser/API operations. Do not race sign-out against late work.
      try {
        await capture.close();
      } catch (error) {
        failure = new AggregateError(
          [failure, error],
          "CSV expired proof and capture cleanup failed",
        );
      }
      await work.catch(() => {});
    } else {
      try {
        await restoreCsvDeliveryLoss(page);
      } catch (error) {
        failure ??= error;
      }
      try {
        await closeCustomerBrowserSession(session, base);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
  const denied = await login("pm-atlas");
  try {
    const grants = (
      await pool.query(
        'SELECT count(*)::int AS count FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=\'pm-atlas\' AND role=\'project_manager\' AND "scopeType"=\'project\' AND "scopeId"=$2::uuid',
        [result.customerId, result.projectId],
      )
    ).rows[0].count;
    assert.equal(grants, 1);
    await expect(
      denied.page.getByRole("button", {
        name: /Customer installation fixture/,
      }),
    ).toBeVisible();
    const projectRead = await csvApi(
      denied,
      base,
      `/projects/${result.projectId}`,
      200,
    );
    assert.equal(projectRead.body.id, result.projectId);
    const readers = (
      await pool.query(
        'SELECT count(*)::int AS count FROM public."IngestionConfigurationReader" WHERE "customerId"=$1::uuid AND "sourceId"=$2::uuid AND "configRevision"=1 AND "projectId"=$3::uuid AND subject=\'pm-atlas\'',
        [result.customerId, result.sourceId, result.projectId],
      )
    ).rows[0].count;
    assert.equal(readers, 0);
    const response = await csvApi(
      denied,
      base,
      `/ingestion/sources/${result.sourceId}/receipts/${result.reviewReceiptId}`,
      404,
    );
    result.sourceReaderDenial = {
      projectGrantCount: grants,
      sourceReaderCount: readers,
      projectRead: { ...projectRead.evidence, id: result.projectId },
      response: response.evidence,
    };
  } finally {
    await closeCustomerBrowserSession(denied, base);
  }
  const canonicalAfter = await canonicalSnapshot(pool);
  assert.deepEqual(
    canonicalAfter,
    canonicalBefore,
    "CSV proposal workflow changed canonical/project rows",
  );
  result.canonical = {
    before: canonicalReceipt(canonicalBefore),
    after: canonicalReceipt(canonicalAfter),
  };
  return result;
}

export async function replayCsvImportAfterRecreation({
  login,
  base,
  pool,
  fixture,
  canonicalSnapshot,
}) {
  assertCsvFixture(fixture);
  const session = await login("pmo-atlas");
  try {
    const beforeCanonical = await canonicalSnapshot(pool);
    const before = await inspectCsvNativeBatch(
      pool,
      fixture,
      nativeExpected(fixture),
    );
    assert.equal(before.sha256, fixture.storageBeforeBackup.sha256);
    const read = await csvApi(
      session,
      base,
      `/ingestion/sources/${fixture.sourceId}/receipts/${fixture.reviewReceiptId}`,
      200,
    );
    const receipt = receiptSummary(
      read.body,
      fixture,
      fixture.reviewReceiptId,
      "CSV_REVIEWED_IMPORT",
      fixture.previewReceiptId,
    );
    const preview = await previewReplay(session, base, fixture);
    const review = await reviewReplay(session, base, fixture);
    const after = await inspectCsvNativeBatch(
      pool,
      fixture,
      nativeExpected(fixture),
    );
    assert.deepEqual(after, before);
    const afterCanonical = await canonicalSnapshot(pool);
    assert.deepEqual(afterCanonical, beforeCanonical);
    await session.capture.settle(session.page);
    return {
      method: "AUTHORIZED_API_AFTER_RECREATION",
      receipt,
      preview,
      review,
      nativeBefore: before,
      nativeAfter: after,
      canonical: {
        before: canonicalReceipt(beforeCanonical),
        after: canonicalReceipt(afterCanonical),
      },
    };
  } finally {
    await closeCustomerBrowserSession(session, base);
  }
}

export async function snapshotCsvBeforeBackup(pool, fixture) {
  return inspectCsvNativeBatch(pool, fixture, nativeExpected(fixture));
}
export async function verifyRestoredCsvImport(pool, fixture) {
  const native = await inspectCsvNativeBatch(
    pool,
    fixture,
    nativeExpected(fixture),
  );
  assert.deepEqual(native, fixture.storageBeforeBackup);
  const connect = (
    await pool.query(
      "SELECT has_database_privilege('pdaa_api',current_database(),'CONNECT') AS api,has_database_privilege('pdaa_worker',current_database(),'CONNECT') AS worker",
    )
  ).rows[0];
  assert.deepEqual(connect, { api: false, worker: false });
  return {
    method: "NATIVE_RETAINED_DATA_BEFORE_PROBES",
    native,
    apiCanConnect: false,
    workerCanConnect: false,
    applicationStarted: false,
  };
}
