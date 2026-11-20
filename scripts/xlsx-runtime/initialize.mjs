import assert from "node:assert/strict";
import { chmodSync, chownSync, lstatSync } from "node:fs";
import {
  assertEmptyLink,
  assertLinkDirectory,
  decoderUid,
  linkDirectory,
  retirementCode,
  sharedGid,
} from "./endpoint.mjs";

try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.getgid(), sharedGid);
  assertEmptyLink();
  const directory = lstatSync(linkDirectory);
  assert(directory.isDirectory());
  if (directory.uid === 0) {
    assert.equal(directory.gid, 0);
    chmodSync(linkDirectory, 0o750);
    chownSync(linkDirectory, decoderUid, sharedGid);
  }
  assertLinkDirectory();
} catch {
  process.exitCode = retirementCode;
}
