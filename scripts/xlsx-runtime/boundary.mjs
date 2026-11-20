import assert from "node:assert/strict";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

export function assertBoundary(uid, gid, mountPath, mountAccess) {
  assert.equal(process.getuid(), uid);
  assert.equal(process.getgid(), gid);
  assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
  assert(networkInterfaces().lo.every(({ internal }) => internal));
  assert.throws(() => lstatSync("/run/secrets"), { code: "ENOENT" });
  assert.throws(() => writeFileSync("/tmp/pdaa-decoder-write-check", ""), {
    code: "EROFS",
  });
  const status = readFileSync("/proc/self/status", "utf8");
  assert.match(status, /^CapEff:\s+0+$/mu);
  assert.match(status, /^NoNewPrivs:\s+1$/mu);
  const mount = readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[4] === mountPath);
  assert(mount?.[5].split(",").includes(mountAccess));
  for (const [file, expected] of [
    ["memory.max", "268435456"],
    ["memory.swap.max", "0"],
    ["pids.max", "32"],
  ]) {
    assert.equal(
      readFileSync("/sys/fs/cgroup/" + file, "utf8").trim(),
      expected,
    );
  }
  const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8")
    .trim()
    .split(/\s+/u)
    .map(Number);
  assert(Number.isSafeInteger(quota) && quota > 0 && quota * 2 === period);
}
