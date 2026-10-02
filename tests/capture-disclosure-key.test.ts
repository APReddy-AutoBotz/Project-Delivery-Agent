// EXEC-015 / SEC-SECRET-001: late-created keys stay in the private verifier.
import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDisclosureCheck, readCaptureTaskSecrets } from "../scripts/acceptance/disclosure.mjs";
import { captureDisclosureVerifierCommand } from "../scripts/acceptance/update-capture-operator-host.mjs";
function removeOwnedFixture(directory: string) {
  const target = realpathSync(directory);
  if (dirname(target) !== realpathSync(tmpdir())) throw new Error("Unexpected disclosure fixture");
  rmSync(target, { recursive: true });
}
function fixture(run: (file: string, key: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-capture-disclosure-"));
  const file = join(directory, "keys"), key = randomBytes(32).toString("base64url");
  writeFileSync(file, JSON.stringify({ currentKeyId: "capture-fixture", keys: { "capture-fixture": key } }));
  try { run(file, key); } finally { removeOwnedFixture(directory); }
}
it("registers the generated key and checks already captured logs for raw and encoded disclosure", () => fixture((file, key) => {
  expect(readCaptureTaskSecrets(file)).toEqual([key]);
  for (const text of [key, encodeURIComponent(key), JSON.stringify(key)]) {
    const check = createDisclosureCheck([randomBytes(32).toString("base64url")]);
    check.add("execution-logs", "diagnostic " + text);
    check.addSecrets(readCaptureTaskSecrets(file));
    expect(() => check.verify(["execution-logs"])).toThrow(/^Secret disclosure detected$/);
  }
}));
it("accepts public diagnostics after registering the private key", () => fixture((file) => {
  const check = createDisclosureCheck(readCaptureTaskSecrets(file));check.add("execution-logs", "fixed public diagnostic");
  expect(check.verify(["execution-logs"])["execution-logs"].bytes).toBeGreaterThan(0);
}));
it("rejects malformed, oversized or unexpected key files with fixed diagnostics", () => fixture((file, key) => {
  for (const text of ["{", "x".repeat(16385), JSON.stringify({ currentKeyId: "wrong", keys: { "capture-fixture": key } }),
    JSON.stringify({ currentKeyId: "capture-fixture", keys: { "capture-fixture": key, other: key } }),
    JSON.stringify({ currentKeyId: "capture-fixture", keys: { "capture-fixture": "a".repeat(43) } })]) {
    writeFileSync(file, text);expect(() => readCaptureTaskSecrets(file)).toThrow(/^Capture disclosure key unavailable$/);
  }
}));
it("mounts only the key file into the verifier without sending its value in arguments", () => fixture((_file, key) => {
  const compose = (...args: string[]) => ["compose", "-f", "owned.yaml", ...args];
  const args = captureDisclosureVerifierCommand(compose, "owned-fixture", "disclosure-host-1");
  expect(args).toContain(join("owned-fixture-capture-overlay", "capture-history-task-keys") + ":/run/capture-task-keys:ro");
  expect(args).toContain("PDAA_CAPTURE_TASK_KEYS_FILE=/run/capture-task-keys");
  expect(args.at(-1)).toBe("disclosure-host-1");expect(args.join(" ")).not.toContain(key);
}));
