import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstatSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  book,
  excelTextParts,
  fixtureParts,
  matrix,
} from "../../tests/fixtures/xlsx-test-worksheet.ts";
import {
  assertBoundary,
  assertSocketOwner,
  callerUid,
  linkDirectory,
  sharedGid,
} from "./boundary.mjs";
import { jobMs, socketPath } from "./server.mjs";
import {
  decodeResult,
  encodeRequest,
  readOneFrame,
  requestLimit,
  responseLimit,
} from "./wire.mjs";

const portable = book(fixtureParts());
const normalized = book(excelTextParts());
const expected = { headers: matrix[0], rows: matrix.slice(1) };
const receiptDeadlines = new WeakMap();

async function connected(path) {
  const expires = performance.now() + jobMs;
  const socket = createConnection({ path, allowHalfOpen: true });
  receiptDeadlines.set(socket, expires);
  // Allow the test to observe server termination after its own acceptance deadline.
  const timer = setTimeout(
    () => socket.destroy(new Error("XLSX_FIXTURE_DEADLINE")),
    jobMs + 2_000,
  );
  socket.on("error", () => {});
  socket.once("close", () => clearTimeout(timer));
  await once(socket, "connect");
  return socket;
}

export async function exchange(path, input, existingSocket) {
  const socket = existingSocket ?? (await connected(path));
  try {
    const read = readOneFrame(socket, responseLimit);
    socket.end(input);
    const frame = await read;
    if (performance.now() >= receiptDeadlines.get(socket)) {
      throw new Error("XLSX_FIXTURE_LATE_RESPONSE");
    }
    return frame;
  } finally {
    socket.destroy();
  }
}

function closedWithoutFrame(error) {
  return (
    ["EPIPE", "ECONNRESET"].includes(error.code) ||
    error.message === "XLSX_WIRE_REJECTED"
  );
}

export async function assertDecoded(path) {
  for (const [workbook, profile] of [
    [portable, "portable"],
    [normalized, "excel-text-v1"],
  ]) {
    const job = randomBytes(16);
    const result = await exchange(
      path,
      encodeRequest(job, "Portfolio", workbook, profile),
    );
    assert.deepEqual(decodeResult(result, job), expected);
    assert.throws(
      () => decodeResult(result, randomBytes(16)),
      /XLSX_WIRE_REJECTED/u,
    );
  }
}

export async function assertSocketWorkflow(path, deadlineMs = jobMs) {
  await assertDecoded(path);
  const job = randomBytes(16);
  const input = encodeRequest(job, "Portfolio", portable, "portable");
  const wrongSheet = encodeRequest(job, "portfolio", portable, "portable");
  const wrongArchive = encodeRequest(
    job,
    "Portfolio",
    Buffer.of(0),
    "portable",
  );
  for (const rejected of [wrongSheet, wrongArchive]) {
    assert.equal(decodeResult(await exchange(path, rejected), job), null);
  }
  const tooLong = Buffer.alloc(4);
  tooLong.writeUInt32BE(requestLimit);
  for (const refused of [
    tooLong,
    input.subarray(0, -1),
    Buffer.concat([input, Buffer.of(0)]),
  ]) {
    await assert.rejects(exchange(path, refused), closedWithoutFrame);
  }
  const idle = await connected(path);
  idle.write(input.subarray(0, 1));
  try {
    await assert.rejects(exchange(path, input), closedWithoutFrame);
    assert.deepEqual(
      decodeResult(await exchange(path, input.subarray(1), idle), job),
      expected,
    );
  } finally {
    idle.destroy();
  }
  const abandoned = await connected(path);
  abandoned.write(input.subarray(0, 1));
  abandoned.destroy();
  await once(abandoned, "close");
  // Local close can precede the remote close notification. Probe the single
  // synthetic slot for bounded recovery before running the next case.
  const recoveryDeadline = performance.now() + 2_000;
  let recovered;
  do {
    try {
      recovered = await exchange(path, input);
    } catch (error) {
      if (!closedWithoutFrame(error)) throw error;
      await delay(25);
    }
  } while (!recovered && performance.now() < recoveryDeadline);
  assert(recovered && performance.now() < recoveryDeadline);
  assert.deepEqual(decodeResult(recovered, job), expected);
  await assertDecoded(path);
  const expired = await connected(path);
  const partialStarted = performance.now();
  expired.write(input.subarray(0, 1));
  try {
    await assert.rejects(
      readOneFrame(expired, responseLimit),
      closedWithoutFrame,
    );
  } finally {
    expired.destroy();
  }
  assert(performance.now() - partialStarted >= deadlineMs - 250);
  const fullGrid = Array.from({ length: 1_001 }, () => Array(64).fill(""));
  const cell = "A".repeat(4_096);
  for (let index = 0; index < 256; index++) {
    fullGrid[1 + Math.floor(index / 64)][index % 64] = cell;
  }
  const maximum = encodeRequest(
    job,
    "Portfolio",
    book(fixtureParts(fullGrid, true)),
    "portable",
  );
  const response = await exchange(path, maximum);
  assert.equal(response.length, responseLimit);
  assert.deepEqual(decodeResult(response, job), {
    headers: fullGrid[0],
    rows: fullGrid.slice(1),
  });

  const stalledReader = await connected(path);
  stalledReader.pause();
  stalledReader.end(maximum);
  try {
    await delay(deadlineMs + 400);
    await assert.rejects(
      readOneFrame(stalledReader, responseLimit),
      closedWithoutFrame,
    );
  } finally {
    stalledReader.destroy();
  }
  await assertDecoded(path);
}

export async function assertFaultWorkflow(path, descendant) {
  const job = randomBytes(16);
  const input = encodeRequest(job, "Portfolio", portable, "portable");
  await assert.rejects(exchange(path, input), closedWithoutFrame);
  if (!descendant) {
    const nextJob = randomBytes(16);
    const wrongSheet = encodeRequest(
      nextJob,
      "portfolio",
      portable,
      "portable",
    );
    assert.equal(decodeResult(await exchange(path, wrongSheet), nextJob), null);
  }
}

async function packaged() {
  const mode = process.argv[2];
  if (mode === "unrelated") {
    assertBoundary(1003, 1003, "ro");
    await assert.rejects(connected(socketPath), { code: "EACCES" });
    console.log("UNRELATED_DENIED");
    return;
  }
  assertBoundary(callerUid, sharedGid, "ro");
  assertSocketOwner(socketPath);
  assert.equal(lstatSync(linkDirectory).mode & 0o777, 0o750);
  assert.throws(
    () => writeFileSync(linkDirectory + "/write-probe", ""),
    (error) => ["EROFS", "EACCES"].includes(error.code),
  );
  if (mode === "decode") await assertSocketWorkflow(socketPath);
  else if (mode === "fresh") await assertDecoded(socketPath);
  else if (mode === "abnormal" || mode === "descendant") {
    await assertFaultWorkflow(socketPath, mode === "descendant");
  } else throw new Error("XLSX_FIXTURE_MODE");
  console.log("CALLER_PASSED");
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await packaged();
  } catch {
    console.error("XLSX_FIXTURE_CALLER_FAILED");
    process.exitCode = 1;
  }
}
