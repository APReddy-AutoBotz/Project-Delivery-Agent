import assert from "node:assert/strict";
import { lstatSync, readdirSync } from "node:fs";

export const linkDirectory = "/run/pdaa-xlsx";
export const socketPath = linkDirectory + "/decoder.sock";
export const leasePath = linkDirectory + "/active";
export const decoderUid = 1001;
export const sharedGid = 2000;
export const retirementCode = 73;

export function assertLinkDirectory() {
  const directory = lstatSync(linkDirectory);
  assert(directory.isDirectory() && directory.uid === decoderUid);
  assert.equal(directory.gid, sharedGid);
  assert.equal(directory.mode & 0o777, 0o750);
}

export function assertEmptyLink() {
  assert.deepEqual(readdirSync(linkDirectory), []);
}

export function assertLiveEndpoint() {
  const lease = lstatSync(leasePath);
  const socket = lstatSync(socketPath);
  assert(lease.isFile() && socket.isSocket());
  assert.equal(lease.uid, decoderUid);
  assert.equal(socket.uid, decoderUid);
  assert.equal(lease.gid, sharedGid);
  assert.equal(socket.gid, sharedGid);
  assert.equal(lease.mode & 0o777, 0o600);
  assert.equal(socket.mode & 0o777, 0o660);
}
