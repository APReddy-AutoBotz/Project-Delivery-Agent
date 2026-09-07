import { it, expect } from "vitest";
import {
  expiryWaitMs,
  validateExpiryReceipt,
} from "../scripts/acceptance/expiry-evidence.mjs";

it("SEC-AUTH-001: natural-expiry waiting rejects stale, invalid and unexpected fixture lifetimes", () => {
  const now = 1000500;
  const claims = { iat: 1000, exp: 1120 };
  expect(expiryWaitMs(claims, now)).toBe(120500);
  expect(expiryWaitMs(claims, now + 60000)).toBe(60500);
  for (const fault of [
    {},
    { iat: 1000 },
    { ...claims, exp: "1120" },
    { ...claims, iat: NaN },
    { ...claims, exp: Infinity },
    { ...claims, iat: 1000.5 },
    { ...claims, exp: 1600 },
    { iat: 800, exp: 920 },
    { iat: 1002, exp: 1122 },
  ])
    expect(() => expiryWaitMs(fault, now)).toThrow(
      /^Fixture expiry window invalid$/,
    );
  expect(() => expiryWaitMs(claims, now + 100000)).toThrow("invalid");
  expect(() => expiryWaitMs(claims, NaN)).toThrow("invalid");
});

it("SEC-AUTH-001: expiry evidence requires current run, original token, every denial, cleanup and count-only channels", () => {
  const runId = "pdaa-acceptance-1234567890-abcdef12";
  const valid = {
    runId,
    testId: "SEC-AUTH-001",
    status: "passed",
    phases: ["authenticated", "expired", "cleared"],
    authorizedBeforeExpiry: true,
    sameToken: true,
    naturalExpiry: true,
    databaseUnchanged: true,
    browserSessionCleared: true,
    deniedReads: 3,
    deniedWrites: 2,
    tokenExchanges: 1,
    channels: Object.fromEntries(
      [
        "browser-response-headers",
        "browser-response-bodies",
        "browser-dom",
        "browser-storage",
        "identity-token-metadata",
        "expiry-api-headers",
        "expiry-api-bodies",
      ].map((name) => [name, { captures: 1, bytes: 1 }]),
    ),
  };
  expect(validateExpiryReceipt(valid, runId)).toEqual(valid);
  for (const patch of [
    { runId: "pdaa-acceptance-1-abcdef12" },
    { status: "failed" },
    { testId: "other" },
    { phases: ["authenticated", "cleared"] },
    { phases: ["expired", "authenticated", "cleared"] },
    { authorizedBeforeExpiry: false },
    { sameToken: false },
    { naturalExpiry: false },
    { databaseUnchanged: false },
    { browserSessionCleared: false },
    { deniedReads: 2 },
    { deniedWrites: 1 },
    { tokenExchanges: 2 },
    { token: "private" },
    { channels: {} },
    {
      channels: {
        ...valid.channels,
        "expiry-api-bodies": { captures: 1, bytes: 0 },
      },
    },
    {
      channels: {
        ...valid.channels,
        "expiry-api-bodies": { captures: 1, bytes: 1, payload: "private" },
      },
    },
    { channels: { ...valid.channels, unexpected: { captures: 1, bytes: 1 } } },
    {
      channels: {
        ...valid.channels,
        "expiry-api-bodies": { captures: 0.5, bytes: 1 },
      },
    },
  ])
    expect(() => validateExpiryReceipt({ ...valid, ...patch }, runId)).toThrow(
      /^Identity expiry receipt invalid$/,
    );
});
