import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hash, validateScan } from "./evidence.mjs";

export function validateBrowserInventory(sbom, locked) {
  const file = sbom.files.find(
    (f) => f.location.path === "/srv/third-party-components.json",
  );
  assert(file?.contents, "Static browser component inventory missing");
  const bytes = Buffer.from(file.contents, "base64");
  const inventory = JSON.parse(bytes);
  assert.equal(inventory.schemaVersion, 1);
  assert(
    inventory.components?.length > 0 && inventory.assets?.length > 0,
    "Empty browser evidence",
  );
  const files = new Map(sbom.files.map((f) => [f.location.path, f]));
  const declaredAssets = new Set();
  for (const asset of inventory.assets) {
    assert(
      !asset.file.startsWith("/") &&
        !asset.file.includes("..") &&
        !asset.file.includes("\\"),
      "Invalid browser asset path",
    );
    assert(!declaredAssets.has(asset.file), "Duplicate browser asset");
    declaredAssets.add(asset.file);
    const observed = files.get("/srv/" + asset.file);
    assert(
      observed?.digests?.some(
        (d) => d.algorithm === "sha256" && d.value === asset.sha256,
      ),
      "Browser inventory differs from shipped asset",
    );
  }
  for (const path of files.keys()) {
    if (path.startsWith("/srv/") && /\.(js|css)$/.test(path))
      assert(
        declaredAssets.has(path.slice(5)),
        "Shipped browser code missing from inventory",
      );
  }
  const names = new Set();
  for (const component of inventory.components) {
    const key = component.name + "@" + component.version;
    assert(!names.has(key), "Duplicate browser component");
    names.add(key);
    assert(
      locked.has(key),
      "Browser dependency missing from exact lock inventory",
    );
    assert(
      component.modules?.length > 0 && component.notices?.length > 0,
      "Browser module/notice coverage missing",
    );
    for (const notice of component.notices)
      assert.equal(
        hash(Buffer.from(notice.contents, "base64")),
        notice.sha256,
        "Browser notice hash differs",
      );
  }
  assert(
    files.get("/srv/THIRD_PARTY_NOTICES.txt")?.contents,
    "Shipped browser notices absent",
  );
  return { inventory, bytes };
}

export function validateBrowserSpdx(spdx, packages) {
  assert.equal(spdx.spdxVersion, "SPDX-2.3", "Browser SPDX conversion missing");
  assert(
    spdx.packages?.length >= packages.length,
    "Browser SPDX coverage incomplete",
  );
  const spdxPackages = new Set(
    spdx.packages.map((p) => `${p.name}@${p.versionInfo}`),
  );
  assert(
    packages.every((p) => spdxPackages.has(`${p.name}@${p.version}`)),
    "Browser SPDX differs from bundled components",
  );
}

export async function browserEvidence({
  sbom,
  output,
  locked,
  tools,
  run,
  root,
  pins,
}) {
  const { inventory, bytes } = validateBrowserInventory(sbom, locked);
  const checksum = hash(bytes);
  const packages = inventory.components.map((p) => ({
    id: hash(p.name + "@" + p.version).slice(0, 16),
    name: p.name,
    version: p.version,
    type: "npm",
    foundBy: "pdaa-vite-module-inventory",
    language: "javascript",
    licenses: [
      {
        value: p.license,
        spdxExpression: p.license,
        type: "declared",
        urls: [],
        locations: [],
      },
    ],
    locations: [{ path: "/srv/third-party-components.json" }],
    purl: `pkg:npm/${p.name.split("/").map(encodeURIComponent).join("/")}@${p.version}`,
  }));
  // A separate first-party SBOM preserves the distinction from Syft's image scan.
  const browserSbom = {
    artifacts: packages,
    artifactRelationships: [],
    files: [],
    source: {
      id: checksum,
      name: "pdaa-browser-components",
      type: "file",
      metadata: {
        path: "/srv/third-party-components.json",
        digests: [{ algorithm: "sha256", value: checksum }],
        mimeType: "application/json",
      },
    },
    descriptor: { name: "pdaa-vite-module-inventory", version: "1" },
    schema: sbom.schema,
  };
  const file = join(output, "browser.syft.json");
  writeFileSync(file, JSON.stringify(browserSbom, null, 2));
  const inputSha256 = hash(readFileSync(file));
  run(tools.syft, [
    "convert",
    file,
    "--config",
    join(root, "scripts/distribution/syft.yaml"),
    "-o",
    "spdx-json@2.3=" + join(output, "browser.spdx.json"),
  ]);
  const spdx = JSON.parse(
    readFileSync(join(output, "browser.spdx.json"), "utf8"),
  );
  validateBrowserSpdx(spdx, packages);
  run(tools.grype, [
    "sbom:" + file,
    "--config",
    join(root, "scripts/distribution/grype.yaml"),
    "-o",
    "json",
    "--file",
    join(output, "browser.grype.json"),
  ]);
  const scan = JSON.parse(
    readFileSync(join(output, "browser.grype.json"), "utf8"),
  );
  assert.equal(scan.source?.type, "file");
  assert.equal(scan.source.target, browserSbom.source.metadata.path);
  assert.equal(
    hash(readFileSync(file)),
    inputSha256,
    "Browser SBOM changed during scanning",
  );
  // Grype preserves file paths but not their digests. Record the verified
  // invocation's exact input/output hashes, without claiming a release signature.
  writeFileSync(
    join(output, "browser.scan-receipt.json"),
    JSON.stringify(
      {
        scanner: "grype",
        version: pins.grype.version,
        inputSha256,
        outputSha256: hash(readFileSync(join(output, "browser.grype.json"))),
        inventorySha256: checksum,
        scannedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const { findings, db } = validateScan(
    scan,
    new Set(packages.map((p) => p.id)),
    pins,
  );
  return {
    inventorySha256: checksum,
    components: inventory.components.map((p) => ({
      name: p.name,
      version: p.version,
      integrity: locked.get(p.name + "@" + p.version),
    })),
    findings,
    database: { built: db.built, from: db.from },
  };
}
