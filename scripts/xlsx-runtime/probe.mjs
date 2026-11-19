// Synthetic cross-container proof. This file is never staged into the decoder.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBoundary } from "/app/scripts/xlsx-runtime/boundary.mjs";
import {
  decodeResult,
  readOneFrame,
  responseLimit,
} from "/app/scripts/xlsx-runtime/wire.mjs";

const proof = dirname(fileURLToPath(import.meta.url));
const socket = "/run/pdaa-xlsx/decoder.sock";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = readFileSync("/app/manifest.json");
assert.equal(digest(manifest), process.argv[2]);
for (const { path, sha256 } of JSON.parse(manifest).files) {
  assert.equal(digest(readFileSync(join("/app", path))), sha256);
}
if (process.argv[3] === "denied") {
  assertBoundary(1003, 1003, "/run/pdaa-xlsx", "ro");
  assert(!process.getgroups().includes(2000));
  await assert.rejects(
    new Promise((resolve, reject) => {
      const client = createConnection(socket, resolve);
      client.once("error", reject);
    }),
    { code: "EACCES" },
  );
} else {
  assertBoundary(1000, 1000, "/run/pdaa-xlsx", "ro");
  assert(process.getgroups().includes(2000));
  const endpoint = lstatSync(socket);
  assert(endpoint.isSocket());
  assert.deepEqual(
    [endpoint.uid, endpoint.gid, endpoint.mode & 0o777],
    [1001, 2000, 0o660],
  );
  const expected = JSON.parse(
    readFileSync(join(proof, "expected.json"), "utf8"),
  );
  for (const [index, { id, gridIndex }] of expected.jobs.entries()) {
    const client = createConnection({ path: socket, allowHalfOpen: true });
    const timer = setTimeout(
      () => client.destroy(new Error("Decoder proof timed out")),
      9_000,
    );
    try {
      const result = readOneFrame(client, responseLimit);
      client.end(readFileSync(join(proof, index + ".bin")));
      assert.deepEqual(
        decodeResult(await result, Buffer.from(id, "hex")),
        expected.grids[gridIndex],
      );
    } finally {
      clearTimeout(timer);
      client.destroy();
    }
  }
}
process.stdout.write("XLSX_RUNTIME_PROBE_PASSED\n");
