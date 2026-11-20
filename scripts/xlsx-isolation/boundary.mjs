import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { assertBoundary as assertRuntimeBoundary } from "../xlsx-runtime/boundary.mjs";

export const linkDirectory = "/fixture-link";
export const decoderUid = 1001;
export const callerUid = 1002;
export const sharedGid = 2000;
export const retirementCode = 73;

export function assertBoundary(uid, gid, mountAccess) {
  assertRuntimeBoundary(uid, gid, linkDirectory, mountAccess);
}

export function assertSocketOwner(path) {
  const stat = lstatSync(path);
  assert(stat.isSocket() && stat.uid === decoderUid && stat.gid === sharedGid);
  assert.equal(stat.mode & 0o777, 0o660);
}
