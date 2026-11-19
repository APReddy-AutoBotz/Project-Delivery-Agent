import assert from "node:assert/strict";
import {
  chmodSync,
  chownSync,
  lstatSync,
  readdirSync,
  writeSync,
} from "node:fs";
import {
  assertBoundary,
  decoderUid,
  linkDirectory,
  retirementCode,
  sharedGid,
} from "./boundary.mjs";
import { serve, socketPath } from "./server.mjs";

function report(message) {
  writeSync(1, message + "\n");
}

function retire() {
  report("RETIRED");
  process.exit(retirementCode);
}

try {
  if (process.argv[2] === "initialize") {
    assert.equal(process.getuid(), 0);
    assert.deepEqual(readdirSync(linkDirectory), []);
    chmodSync(linkDirectory, 0o750);
    chownSync(linkDirectory, decoderUid, sharedGid);
  } else {
    assertBoundary(decoderUid, sharedGid, "rw");
    assert.equal(process.pid, 1);
    const dir = lstatSync(linkDirectory);
    assert(dir.isDirectory() && !dir.isSymbolicLink());
    assert.equal(dir.uid, decoderUid);
    assert.equal(dir.gid, sharedGid);
    assert.equal(dir.mode & 0o777, 0o750);
    if (readdirSync(linkDirectory).length !== 0) {
      report("ENDPOINT_OCCUPIED");
      retire();
    }
    const mode = process.env.PDAA_XLSX_FIXTURE_MODE ?? "decode";
    serve(socketPath, mode, report, retire);
    process.once("SIGTERM", () => process.exit(0));
  }
} catch {
  retire();
}
