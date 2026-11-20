import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertBoundary } from "./boundary.mjs";
import {
  assertEmptyLink,
  assertLinkDirectory,
  assertLiveEndpoint,
  decoderUid,
  leasePath,
  linkDirectory,
  retirementCode,
  sharedGid,
  socketPath,
} from "./endpoint.mjs";
import { serveDecoder } from "./server.mjs";
import { superviseWorker } from "./supervise.mjs";

const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const retire = () => process.exit(retirementCode);
process.once("uncaughtException", retire);
process.once("unhandledRejection", retire);

try {
  assert.equal(process.argv.length, 2);
  assert.equal(process.pid, 1);
  assert(
    Object.keys(process.env).every((key) =>
      ["PATH", "NODE_ENV", "HOME", "HOSTNAME"].includes(key),
    ),
  );
  assertBoundary(decoderUid, sharedGid, linkDirectory, "rw");
  assertLinkDirectory();
  assertEmptyLink();
  // One instance owns admission until a clean idle shutdown. A failed or
  // interrupted instance leaves the directory occupied for trusted recovery.
  process.umask(0o077);
  closeSync(openSync(leasePath, "wx", 0o600));
  const { drain } = serveDecoder({
    path: socketPath,
    runWorker: (request, job, signal) =>
      superviseWorker(request, job, signal, () =>
        spawn(process.execPath, [worker], {
          detached: true,
          env: {},
          stdio: ["pipe", "pipe", "ignore"],
        }),
      ),
    report: (event) => {
      if (event === "READY") assertLiveEndpoint();
    },
    retire,
  });
  process.once("SIGTERM", () => {
    drain((error) => {
      if (error) retire();
      assert.throws(() => lstatSync(socketPath), { code: "ENOENT" });
      unlinkSync(leasePath);
      process.exit(0);
    });
  });
} catch {
  retire();
}
