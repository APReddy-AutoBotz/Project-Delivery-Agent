import { expect, test } from "@playwright/test";
import { verifyBrowserToolchain } from "../../scripts/acceptance/browser-toolchain.mjs";

test("CI-MNT-004: hosted browser matches the pinned verification toolchain", async ({ browser }) => {
  const evidence = verifyBrowserToolchain(browser);
  expect(evidence.playwrightVersion).toBe("1.65.0");
  console.log("Browser toolchain: " + JSON.stringify(evidence));
});
