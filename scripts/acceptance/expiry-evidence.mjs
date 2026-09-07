import assert from "node:assert/strict";

export const expiryCheckName =
  "SEC-AUTH-001: naturally expired OIDC token receives fixed API denials and clears loaded browser data without refresh";

// The existing primary fixture issues 120-second tokens. Reject stale tokens or
// fixture drift before waiting; no test clock or token claim is modified.
export function expiryWaitMs(claims, now = Date.now()) {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(claims?.iat) ||
    !Number.isSafeInteger(claims?.exp) ||
    claims.exp - claims.iat !== 120 ||
    now < claims.iat * 1000 - 1000 ||
    claims.exp * 1000 - now < 30000 ||
    claims.exp * 1000 - now > 121000
  )
    throw new Error("Fixture expiry window invalid");
  return claims.exp * 1000 + 1000 - now;
}

export function validateExpiryReceipt(receipt, runId) {
  try {
    assert.match(runId, /^pdaa-acceptance-\d+-[a-f0-9]{8}$/);
    assert.deepEqual(
      Object.keys(receipt).sort(),
      [
        "runId",
        "testId",
        "status",
        "phases",
        "authorizedBeforeExpiry",
        "sameToken",
        "naturalExpiry",
        "databaseUnchanged",
        "browserSessionCleared",
        "deniedReads",
        "deniedWrites",
        "tokenExchanges",
        "channels",
      ].sort(),
    );
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.testId, "SEC-AUTH-001");
    assert.equal(receipt.status, "passed");
    assert.deepEqual(receipt.phases, ["authenticated", "expired", "cleared"]);
    for (const name of [
      "authorizedBeforeExpiry",
      "sameToken",
      "naturalExpiry",
      "databaseUnchanged",
      "browserSessionCleared",
    ])
      assert.equal(receipt[name], true);
    assert.equal(receipt.deniedReads, 3);
    assert.equal(receipt.deniedWrites, 2);
    assert.equal(receipt.tokenExchanges, 1);
    const required = [
      "browser-response-headers",
      "browser-response-bodies",
      "browser-dom",
      "browser-storage",
      "identity-token-metadata",
      "expiry-api-headers",
      "expiry-api-bodies",
    ];
    const allowed = [
      ...required,
      "browser-bodyless-responses",
      "browser-console",
      "browser-errors",
    ];
    for (const name of required)
      assert(
        receipt.channels[name]?.captures > 0 &&
          receipt.channels[name]?.bytes > 0,
      );
    for (const [name, counts] of Object.entries(receipt.channels)) {
      assert(allowed.includes(name));
      assert.deepEqual(Object.keys(counts).sort(), ["bytes", "captures"]);
      assert(Number.isInteger(counts.captures) && counts.captures > 0);
      assert(Number.isInteger(counts.bytes) && counts.bytes >= 0);
    }
    return receipt;
  } catch {
    throw new Error("Identity expiry receipt invalid");
  }
}
