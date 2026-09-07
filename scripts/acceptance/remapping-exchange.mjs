// INT-ADM-001: only nonsecret, run-bound control and completion markers cross
// the host/verifier boundary. The issued bearer token stays in verifier memory.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const remappingTimeoutMs = 360000;
export function remainingRemappingTime(deadlineAt, now = Date.now()) {
  const remaining = deadlineAt - now;
  if (
    !Number.isSafeInteger(deadlineAt) ||
    remaining <= 0 ||
    remaining > remappingTimeoutMs
  )
    throw new Error("Identity configuration deadline invalid or expired");
  return remaining;
}

export function remappingExchange(directory, identity) {
  assert.match(identity.runId, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
  assert.equal(identity.profile, "bundled");
  assert.match(identity.session, /^[a-f0-9-]{36}$/);
  const expected = {
    runId: identity.runId,
    profile: identity.profile,
    session: identity.session,
  };
  const file = (kind, phase) => {
    assert(["control", "receipt"].includes(kind));
    assert(["mapped", "removed", "restored", "failed"].includes(phase));
    return join(directory, `identity-${kind}-${phase}.json`);
  };
  const read = (kind, phase) => {
    const path = file(kind, phase);
    if (!existsSync(path)) return false;
    try {
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
        ...expected,
        phase,
      });
    } catch {
      throw new Error("Identity configuration marker invalid");
    }
    return true;
  };
  return {
    publish(kind, phase) {
      const path = file(kind, phase);
      writeFileSync(path + ".tmp", JSON.stringify({ ...expected, phase }));
      renameSync(path + ".tmp", path);
    },
    async wait(kind, phase, timeoutMs = 90000) {
      const deadline = Date.now() + timeoutMs;
      do {
        if (read("receipt", "failed"))
          throw new Error("Identity configuration verifier failed");
        if (read(kind, phase)) return;
        await delay(100);
      } while (Date.now() < deadline);
      throw new Error("Identity configuration marker timed out");
    },
  };
}

export function validateRemappingReceipt(receipt, identity) {
  try {
    assert.deepEqual(
      Object.keys(receipt).sort(),
      [
        "runId",
        "profile",
        "session",
        "testId",
        "status",
        "phases",
        "sameUnexpiredToken",
        "databaseUnchanged",
        "metadataMatched",
        "deniedWrites",
        "channels",
      ].sort(),
    );
    for (const [key, value] of Object.entries(identity))
      assert.equal(receipt[key], value);
    assert.equal(receipt.testId, "INT-ADM-001");
    assert.equal(receipt.status, "passed");
    assert.deepEqual(receipt.phases, ["mapped", "removed", "restored"]);
    for (const key of [
      "sameUnexpiredToken",
      "databaseUnchanged",
      "metadataMatched",
    ])
      assert.equal(receipt[key], true);
    assert.equal(receipt.deniedWrites, 2);
    const allowed = [
      "browser-response-headers",
      "browser-response-bodies",
      "browser-bodyless-responses",
      "browser-console",
      "browser-errors",
      "browser-dom",
      "browser-storage",
      "identity-token-metadata",
      "identity-api-headers",
      "identity-api-bodies",
    ];
    for (const key of [
      "browser-response-headers",
      "browser-response-bodies",
      "browser-dom",
      "browser-storage",
      "identity-token-metadata",
      "identity-api-headers",
      "identity-api-bodies",
    ])
      assert(
        receipt.channels[key]?.captures > 0 && receipt.channels[key]?.bytes > 0,
      );
    for (const [channel, counts] of Object.entries(receipt.channels)) {
      assert(allowed.includes(channel));
      assert.deepEqual(Object.keys(counts).sort(), ["bytes", "captures"]);
      assert(Number.isInteger(counts.captures) && counts.captures > 0);
      assert(Number.isInteger(counts.bytes) && counts.bytes >= 0);
    }
    return receipt;
  } catch {
    throw new Error("Identity configuration receipt invalid");
  }
}
