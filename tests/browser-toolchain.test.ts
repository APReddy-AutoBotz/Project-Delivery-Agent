import { expect, it } from "vitest";
import { validateBrowserToolchain, verifyBrowserToolchain } from "../scripts/acceptance/browser-toolchain.mjs";

const fixture = () => ({ pin: "1.65.0", packages: ["@playwright/test", "playwright", "playwright-core"].map((name) => ({ name, version: "1.65.0" })),
  browsers: ["chromium", "chromium-headless-shell"].map((name) => ({ name, browserVersion: "158.0.8127.18", revision: "1254" })) });
it("resolves the actual installed package chain and sanitizes a throwing browser accessor", () => {
  expect(verifyBrowserToolchain({ browserType: () => ({ name: () => "chromium" }), version: () => "158.0.8127.18" }))
    .toEqual({ playwrightVersion: "1.65.0", chromiumVersion: "158.0.8127.18", manifestRevision: "1254" });
  let accessed = false;
  expect(() => verifyBrowserToolchain({ browserType: () => ({ name: () => "chromium" }), version: () => {
    accessed = true; throw new Error("private-canary");
  } })).toThrow(/^Browser toolchain verification failed$/);
  expect(accessed).toBe(true);
});
it("records only validated package, launched version and manifest revision", () => {
  const metadata = fixture(); Object.assign(metadata, { private: "private-canary" });
  const evidence = validateBrowserToolchain(metadata, "chromium", "158.0.8127.18");
  expect(evidence).toEqual({ playwrightVersion: "1.65.0", chromiumVersion: "158.0.8127.18", manifestRevision: "1254" });
  expect(Object.isFrozen(evidence)).toBe(true); expect(JSON.stringify(evidence)).not.toContain("private-canary");
});
it.each([0, 1, 2])("rejects a mismatched installed package %s", (index) => {
  const metadata = fixture(); metadata.packages[index]!.version = "1.63.0";
  expect(() => validateBrowserToolchain(metadata, "chromium", "158.0.8127.18")).toThrow(/^Browser toolchain verification failed$/);
});
it.each(["pin", "duplicate-package", "missing-browser", "duplicate-browser", "version", "revision", "pair", "launch", "type"])("fails closed for %s metadata", (fault) => {
  const metadata = fixture();
  if (fault === "pin") metadata.pin = "latest";
  if (fault === "duplicate-package") metadata.packages[2]!.name = "playwright";
  if (fault === "missing-browser") metadata.browsers.pop();
  if (fault === "duplicate-browser") metadata.browsers.push({ ...metadata.browsers[0]! });
  if (fault === "version") metadata.browsers[0]!.browserVersion = "private-canary";
  if (fault === "revision") metadata.browsers[0]!.revision = "private-canary";
  if (fault === "pair") metadata.browsers[1]!.revision = "1253";
  expect(() => validateBrowserToolchain(metadata, fault === "type" ? "firefox" : "chromium", fault === "launch" ? "153.0.8010.12" : "158.0.8127.18"))
    .toThrow(/^Browser toolchain verification failed$/);
});
