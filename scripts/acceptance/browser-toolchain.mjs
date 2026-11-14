// CI-MNT-004 / SEC-SECRET-001: verify the launched verifier and emit only
// validated package/browser versions. Manifest revision is installed metadata,
// not an independently measured binary identity or a disclosure receipt.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const unavailable = () => new Error("Browser toolchain verification failed");
export function validateBrowserToolchain(installed, browserType, browserVersion) {
  const version = installed?.pin;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || version.length > 32 ||
      !Array.isArray(installed?.packages) || installed.packages.length !== 3 || browserType !== "chromium") throw unavailable();
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    const entries = installed.packages.filter((item) => item?.name === name);
    if (entries.length !== 1 || entries[0].version !== version) throw unavailable();
  }
  if (!Array.isArray(installed?.browsers)) throw unavailable();
  const selected = ["chromium", "chromium-headless-shell"].map((name) => {
    const entries = installed.browsers.filter((item) => item?.name === name);
    if (entries.length !== 1) throw unavailable();
    const entry = entries[0];
    if (typeof entry.browserVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(entry.browserVersion) || entry.browserVersion.length > 48 ||
        typeof entry.revision !== "string" || !/^\d{1,10}$/.test(entry.revision)) throw unavailable();
    return entry;
  });
  if (selected[0].browserVersion !== selected[1].browserVersion || selected[0].revision !== selected[1].revision ||
      browserVersion !== selected[0].browserVersion) throw unavailable();
  return Object.freeze({ playwrightVersion: version, chromiumVersion: browserVersion, manifestRevision: selected[0].revision });
}

export function verifyBrowserToolchain(browser) {
  try {
    const json = (path) => JSON.parse(readFileSync(path, "utf8"));
    const root = json(new URL("../../package.json", import.meta.url));
    const resolve = createRequire(import.meta.url);
    const testPath = resolve.resolve("@playwright/test/package.json");
    const playwrightPath = createRequire(testPath).resolve("playwright/package.json");
    const corePath = createRequire(playwrightPath).resolve("playwright-core/package.json");
    return validateBrowserToolchain({ pin: root.devDependencies?.["@playwright/test"],
      packages: [testPath, playwrightPath, corePath].map(json),
      browsers: json(join(dirname(corePath), "browsers.json")).browsers,
    }, browser.browserType().name(), browser.version());
  } catch {
    // Installation and protocol errors may contain paths or other raw data.
    throw unavailable();
  }
}
