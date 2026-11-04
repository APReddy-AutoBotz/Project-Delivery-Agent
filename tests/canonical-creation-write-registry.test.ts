import { expect, it } from "vitest";
import { canonicalCommandFingerprint, CanonicalCreationWriteRegistry } from "../apps/web/src/canonical-creation-write-registry.js";

it("allows only a matching subject, key and payload digest after an uncertain create", async () => {
  const registry = new CanonicalCreationWriteRegistry(), owner = "synthetic-owner";
  const payload = JSON.stringify({ code: "A", idempotencyKey: "key-1" });
  const digest = await canonicalCommandFingerprint("actor-a", payload);
  const original = { key: "key-1", fingerprint: digest };
  const first = registry.begin(owner, original)!;
  expect(registry.begin(owner, original)).toBeNull();
  expect(registry.uncertain(owner, first)).toBe(true);
  expect(registry.state(owner, original)).toBe("retryable");
  const otherActor = { ...original, fingerprint: await canonicalCommandFingerprint("actor-b", payload) };
  const otherBody = { ...original, fingerprint: await canonicalCommandFingerprint("actor-a", JSON.stringify({ code: "B", idempotencyKey: "key-1" })) };
  expect(registry.begin(owner, otherActor)).toBeNull();
  expect(registry.begin(owner, otherBody)).toBeNull();
  expect(registry.begin(owner, { ...original, key: "key-2" })).toBeNull();
  const retry = registry.begin(owner, original)!;
  expect(retry).not.toBe(first); expect(registry.confirm(owner, first)).toBe(false);
  expect(registry.confirm(owner, retry)).toBe(true); expect(registry.state(owner, null)).toBe("available");
});

it("bounds retained command metadata and rejects invalid digests", async () => {
  const registry = new CanonicalCreationWriteRegistry();
  expect(registry.begin("owner", { key: "key", fingerprint: "not-a-digest" })).toBeNull();
  expect(registry.begin("owner", { key: "x".repeat(129), fingerprint: "a".repeat(64) })).toBeNull();
  await expect(canonicalCommandFingerprint("actor", "x".repeat(8 * 1024 * 1024))).rejects.toThrow("too large");
  for (let index = 0; index < 64; index++) expect(registry.begin(`owner-${index}`, { key: "key", fingerprint: "a".repeat(64) })).not.toBeNull();
  expect(registry.state("another-owner", null)).toBe("capacity");
});
