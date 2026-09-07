import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  remappingExchange,
  validateRemappingReceipt,
  remainingRemappingTime,
  remappingTimeoutMs,
} from "../scripts/acceptance/remapping-exchange.mjs";
import { waitForIdentityProvider } from "../scripts/acceptance/identity-readiness.mjs";

it("INT-ADM-001: sign-in waits for real discovery and rejects invalid or unavailable metadata", async () => {
  const issuer = "https://identity.example.test/realm";
  const request = vi.spyOn(globalThis, "fetch");
  try {
    request
      .mockResolvedValueOnce(new Response("starting", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ issuer })));
    await waitForIdentityProvider(issuer, { timeoutMs: 1000, intervalMs: 1 });
    expect(request).toHaveBeenCalledTimes(2);
    for (const body of [
      "invalid",
      JSON.stringify({ issuer: "https://other.example.test" }),
    ]) {
      request.mockResolvedValue(new Response(body));
      await expect(waitForIdentityProvider(issuer)).rejects.toThrow(
        /^Fixture identity discovery invalid$/,
      );
    }
    request.mockImplementation(
      async () => new Response("starting", { status: 503 }),
    );
    await expect(
      waitForIdentityProvider(issuer, { timeoutMs: 1, intervalMs: 1 }),
    ).rejects.toThrow(/^Fixture identity discovery unavailable$/);
  } finally {
    request.mockRestore();
  }
});

const identity = () => ({
  runId: "pdaa-acceptance-1234567890-abcdef12",
  profile: "bundled",
  session: randomUUID(),
});
it("INT-ADM-001: every phase shares one finite deadline without renewing the budget", () => {
  const now = 1000000;
  const deadline = now + remappingTimeoutMs;
  expect(remainingRemappingTime(deadline, now)).toBe(remappingTimeoutMs);
  expect(remainingRemappingTime(deadline, now + 120000)).toBe(
    remappingTimeoutMs - 120000,
  );
  for (const invalid of [now, now - 1, deadline + 1, NaN, Infinity, "future"])
    expect(() => remainingRemappingTime(invalid, now)).toThrow(
      /^Identity configuration deadline invalid or expired$/,
    );
  expect(() => remainingRemappingTime(deadline, deadline)).toThrow("expired");
});
it("INT-ADM-001: missing, stale, failed and malformed coordination cannot satisfy a phase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-identity-"));
  try {
    const current = identity();
    const exchange = remappingExchange(directory, current);
    await expect(exchange.wait("receipt", "mapped", 1)).rejects.toThrow(
      "timed out",
    );
    for (const fault of [
      "run",
      "profile",
      "session",
      "phase",
      "extra",
      "malformed",
    ]) {
      const marker = {
        ...current,
        phase: "mapped",
        ...(fault === "run" ? { runId: "previous-run" } : {}),
        ...(fault === "profile" ? { profile: "external" } : {}),
        ...(fault === "session" ? { session: randomUUID() } : {}),
        ...(fault === "phase" ? { phase: "restored" } : {}),
        ...(fault === "extra" ? { token: "must-not-be-accepted" } : {}),
      };
      writeFileSync(
        join(directory, "identity-receipt-mapped.json"),
        fault === "malformed" ? "invalid" : JSON.stringify(marker),
      );
      await expect(exchange.wait("receipt", "mapped", 1)).rejects.toThrow(
        /^Identity configuration marker invalid$/,
      );
    }
    exchange.publish("receipt", "mapped");
    await exchange.wait("receipt", "mapped", 1);
    exchange.publish("control", "removed");
    await exchange.wait("control", "removed", 1);
    await expect(exchange.wait("receipt", "removed", 1)).rejects.toThrow(
      "timed out",
    );
    exchange.publish("receipt", "failed");
    await expect(exchange.wait("receipt", "mapped", 1)).rejects.toThrow(
      /^Identity configuration verifier failed$/,
    );
  } finally {
    if (dirname(realpathSync(directory)) !== realpathSync(tmpdir()))
      throw new Error("Unexpected test directory");
    rmSync(directory, { recursive: true });
  }
});

it("INT-ADM-001: canonical receipts require current identity, completed denials and count-only disclosure", () => {
  const current = identity();
  const valid = {
    ...current,
    testId: "INT-ADM-001",
    status: "passed",
    phases: ["mapped", "removed", "restored"],
    sameUnexpiredToken: true,
    databaseUnchanged: true,
    metadataMatched: true,
    deniedWrites: 2,
    channels: Object.fromEntries(
      [
        "browser-response-headers",
        "browser-response-bodies",
        "browser-dom",
        "browser-storage",
        "identity-token-metadata",
        "identity-api-headers",
        "identity-api-bodies",
      ].map((name) => [name, { captures: 1, bytes: 1 }]),
    ),
  };
  expect(validateRemappingReceipt(valid, current)).toEqual(valid);
  for (const patch of [
    { session: randomUUID() },
    { profile: "external" },
    { runId: "stale" },
    { status: "failed" },
    { testId: "different" },
    { phases: ["mapped", "restored"] },
    { sameUnexpiredToken: false },
    { databaseUnchanged: false },
    { metadataMatched: false },
    { deniedWrites: 1 },
    { token: "private" },
    { channels: {} },
    {
      channels: {
        ...valid.channels,
        "identity-api-bodies": { captures: 1, bytes: 0 },
      },
    },
    {
      channels: {
        ...valid.channels,
        "identity-api-bodies": { captures: 1, bytes: 1, body: "private" },
      },
    },
    { channels: { ...valid.channels, private: { captures: 1, bytes: 1 } } },
  ])
    expect(() =>
      validateRemappingReceipt({ ...valid, ...patch }, current),
    ).toThrow(/^Identity configuration receipt invalid$/);
});
