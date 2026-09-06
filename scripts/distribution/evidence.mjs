// AC-MNT-004: validate evidence, retain unresolved release blockers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = /^sha256:[a-f0-9]{64}$/;
export const customerTargets = [
  "api",
  "worker",
  "web",
  "operations",
  "database",
];
const permitted = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "PostgreSQL",
]);
const severityNames = new Set([
  "Unknown",
  "Negligible",
  "Low",
  "Medium",
  "High",
  "Critical",
]);

export function validateImageReports({
  inspection,
  sbom,
  spdx,
  scan,
  pins,
  scope = "squashed",
  now = Date.now(),
}) {
  assert(digest.test(inspection.Id), "Missing immutable Docker image identity");
  assert.equal(inspection.Os, "linux");
  assert.equal(inspection.Architecture, "amd64");
  assert.equal(sbom.descriptor?.name, "syft");
  assert(
    ["squashed", "all-layers"].includes(scope),
    "Unsupported evidence scope",
  );
  assert.equal(
    sbom.descriptor.configuration?.search?.scope,
    scope,
    "Syft scope differs",
  );
  assert.equal(
    scan.descriptor?.configuration?.search?.scope,
    scope,
    "Grype scope differs",
  );
  assert.equal(
    sbom.descriptor.version,
    pins.syft.version,
    "Unapproved Syft version",
  );
  assert.equal(sbom.source?.type, "image", "SBOM must describe an image");
  const source = sbom.source.metadata;
  assert.equal(
    source.userInput,
    inspection.Id,
    "SBOM was not scanned by the accepted immutable image ID",
  );
  const configBytes = Buffer.from(source.config, "base64");
  assert.equal(
    `sha256:${hash(configBytes)}`,
    source.imageID,
    "SBOM image configuration hash mismatch",
  );
  const config = JSON.parse(configBytes);
  assert.equal(config.os, inspection.Os);
  assert.equal(config.architecture, inspection.Architecture);
  assert(inspection.RootFS?.Layers?.length > 0, "Docker image layers missing");
  // Docker's containerd store exposes an OCI index ID; Syft exposes the selected
  // image configuration ID. Compare the complete ordered uncompressed layer set.
  assert.deepEqual(
    config.rootfs?.diff_ids,
    inspection.RootFS.Layers,
    "SBOM filesystem does not match accepted image",
  );
  assert(
    Array.isArray(sbom.artifacts) && sbom.artifacts.length > 0,
    "Empty SBOM",
  );
  const packageIds = new Set();
  for (const p of sbom.artifacts) {
    assert(
      p.id && p.name && p.version && p.type && Array.isArray(p.licenses),
      "Incomplete SBOM package",
    );
    assert(!packageIds.has(p.id), "Duplicate SBOM package ID");
    packageIds.add(p.id);
  }
  assert(
    sbom.artifacts.some((p) => ["deb", "apk"].includes(p.type)),
    "OS package inventory missing",
  );
  assert.equal(spdx.spdxVersion, "SPDX-2.3", "Missing SPDX 2.3 SBOM");
  assert(
    spdx.packages?.length >= sbom.artifacts.length,
    "SPDX package coverage is incomplete",
  );
  const spdxPackages = new Set(
    spdx.packages.map((p) => `${p.name}@${p.versionInfo}`),
  );
  assert(
    sbom.artifacts.every((p) => spdxPackages.has(`${p.name}@${p.version}`)),
    "SPDX differs from native SBOM",
  );
  assert.equal(scan.descriptor?.name, "grype");
  assert.equal(
    scan.descriptor.version,
    pins.grype.version,
    "Unapproved Grype version",
  );
  assert.equal(scan.source?.type, "image");
  assert.equal(
    scan.source.target?.imageID,
    source.imageID,
    "Scan source differs from SBOM",
  );
  assert.equal(
    scan.source.target?.manifestDigest,
    source.manifestDigest,
    "Scan manifest differs from SBOM",
  );
  const { findings, db } = validateScan(scan, packageIds, pins, now);
  if (scope === "all-layers") {
    const layers = new Set(inspection.RootFS.Layers);
    for (const file of sbom.files ?? [])
      assert(
        file.id && layers.has(file.location?.layerID),
        "File layer attribution missing or invalid",
      );
    for (const p of sbom.artifacts) {
      assert(p.locations?.length > 0, "Package layer attribution missing");
      for (const location of p.locations)
        assert(
          layers.has(location.layerID),
          "Package belongs to an unknown layer",
        );
    }
    for (const finding of findings) {
      const p = sbom.artifacts.find((p) => p.id === finding.packageId);
      finding.locations = p.locations;
    }
  }
  const licenseReview = sbom.artifacts
    .filter(
      (p) =>
        !p.licenses.length ||
        p.licenses.some((l) => !permitted.has(l.spdxExpression ?? l.value)),
    )
    .map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      type: p.type,
      licenses: p.licenses.map((l) => l.spdxExpression ?? l.value),
      disposition: "review-required",
    }));
  const notices = (sbom.files ?? [])
    .filter(
      (f) =>
        typeof f.contents === "string" &&
        (f.location.path.startsWith("/usr/share/common-licenses/") ||
          /^(licen[sc]e|notice|copyright)/i.test(
            posix.basename(f.location.path),
          ) ||
          f.location.path === "/srv/THIRD_PARTY_NOTICES.txt"),
    )
    .map((f) => ({
      fileId: f.id,
      layerID: f.location.layerID,
      path: f.location.path,
      sha256: hash(Buffer.from(f.contents, "base64")),
      contents: f.contents,
    }));
  assert(notices.length > 0, "License/notice file capture missing");
  return {
    imageId: inspection.Id,
    imageConfigId: source.imageID,
    scope,
    packages: sbom.artifacts.length,
    findings,
    licenseReview,
    notices,
    database: { built: db.built, from: db.from, valid: db.valid },
    severityCounts: Object.fromEntries(
      [...severityNames].map((s) => [
        s,
        findings.filter((f) => f.severity === s).length,
      ]),
    ),
  };
}

export function validateScan(scan, packageIds, pins, now = Date.now()) {
  assert.equal(scan.descriptor?.name, "grype");
  assert.equal(
    scan.descriptor.version,
    pins.grype.version,
    "Unapproved Grype version",
  );
  const db = scan.descriptor.db?.status;
  const age = now - Date.parse(db?.built);
  assert(
    db?.valid === true &&
      Number.isFinite(age) &&
      age >= -300000 &&
      age <= 120 * 3600000,
    "Vulnerability database is invalid, future-dated or stale",
  );
  assert(
    /^https:\/\/grype\.anchore\.io\/databases\//.test(db.from) &&
      /checksum=sha256%3A[a-f0-9]{64}/i.test(db.from),
    "Database publisher/checksum identity missing",
  );
  const settings = scan.descriptor.configuration;
  assert(
    settings &&
      settings["only-fixed"] === false &&
      settings["only-notfixed"] === false &&
      !settings["ignore-wontfix"],
    "Filtered vulnerability report",
  );
  for (const name of ["exclude", "vex-documents", "vex-add"])
    assert.equal(settings[name]?.length, 0, `Unexpected ${name}`);
  assert(
    settings.db?.["validate-age"] === true &&
      settings.db?.["validate-by-hash-on-start"] === true &&
      settings.db?.["require-update-check"] === true,
    "Database verification disabled",
  );
  assert.equal(
    settings["match-upstream-kernel-headers"],
    true,
    "Implicit kernel-header ignore rules must be disabled",
  );
  assert.equal(
    settings.ignore?.length,
    0,
    "Vulnerability suppression rules present",
  );
  assert.equal(
    (scan.ignoredMatches ?? []).length,
    0,
    "Suppressed vulnerability matches present",
  );
  assert(Array.isArray(scan.matches), "Vulnerability scan missing");
  const findings = scan.matches.map((m) => {
    assert(
      packageIds.has(m.artifact?.id),
      "Vulnerability refers to a package outside the SBOM",
    );
    assert(
      m.vulnerability?.id && severityNames.has(m.vulnerability.severity),
      "Invalid vulnerability result",
    );
    return {
      id: m.vulnerability.id,
      namespace: m.vulnerability.namespace,
      packageId: m.artifact.id,
      name: m.artifact.name,
      version: m.artifact.version,
      severity: m.vulnerability.severity,
      fix: m.vulnerability.fix,
      source: m.vulnerability.dataSource,
      disposition: "unreviewed",
    };
  });
  return { findings, db };
}

export function requireCompleteTargets(images) {
  assert.deepEqual(
    Object.keys(images).sort(),
    [...customerTargets].sort(),
    "Customer image evidence is incomplete or contains unexpected targets",
  );
  assert(
    new Set(Object.values(images).map((i) => i.imageId)).size ===
      customerTargets.length,
    "Customer targets must not reuse another target's evidence",
  );
}

export function validateRuntimeTooling(target, sbom, policy) {
  assert(customerTargets.includes(target), "Unknown customer target");
  const nodeTargets = ["api", "worker", "operations"];
  if (!nodeTargets.includes(target)) return;
  assert(
    /^\d+\.\d+\.\d+$/.test(policy.nodeVersion ?? ""),
    "Pinned Node version missing",
  );
  assert(
    /^[a-f0-9]{64}$/.test(policy.nodeNoticeSha256 ?? ""),
    "Pinned Node notice digest missing",
  );
  assert.deepEqual(
    Object.keys(policy.nodeNoticePaths ?? {}).sort(),
    [...nodeTargets].sort(),
    "Required runtime policy targets missing",
  );
  for (const path of Object.values(policy.nodeNoticePaths))
    assert(
      typeof path === "string" &&
        path.startsWith("/") &&
        !path.includes("..") &&
        !path.includes("\\"),
      "Required runtime notice path missing",
    );
  const noticePath = policy.nodeNoticePaths[target];
  const nodes = sbom.artifacts.filter(
    (p) => p.type === "binary" && p.name === "node",
  );
  assert(
    nodes.length > 0 && nodes.every((p) => p.version === policy.nodeVersion),
    "Expected Node binary/version absent",
  );
  const notices = sbom.files.filter((f) => f.location.path === noticePath);
  assert(notices.length > 0, "Original bundled Node notice missing");
  for (const notice of notices)
    assert.equal(
      hash(Buffer.from(notice.contents ?? "", "base64")),
      policy.nodeNoticeSha256,
      "Original bundled Node notice differs",
    );
  const tools = new Set([
    "npm",
    "npx",
    "yarn",
    "yarnpkg",
    "pnpm",
    "pnpx",
    "corepack",
  ]);
  for (const p of sbom.artifacts)
    assert(
      !(p.type === "npm" && tools.has(p.name)),
      "Build package manager remains in customer image: " + p.name,
    );
  for (const f of sbom.files) {
    const path = f.location.path;
    assert(
      !/^\/usr\/local\/lib\/node_modules(?:\/|$)/.test(path) &&
        !/^\/opt\/yarn(?:-|\/|$)/.test(path) &&
        !(/^\/usr\/local\/bin\//.test(path) && tools.has(posix.basename(path))),
      "Package manager payload or command remains in customer image: " + path,
    );
  }
}

export function reconcileApplicationPackages(packages, expected, locked) {
  assert(
    expected.packages?.length > 0,
    "Empty build-observed runtime inventory",
  );
  const known = new Set(expected.packages.map((p) => `${p.name}@${p.version}`));
  const registered = packages.filter((p) =>
    known.has(`${p.name}@${p.version}`),
  );
  assert.deepEqual(
    [...new Set(registered.map((p) => `${p.name}@${p.version}`))].sort(),
    [...known].sort(),
    "Scanner omitted a build-observed package",
  );
  return packages.map((p) => {
    const coordinate = `${p.name}@${p.version}`;
    if (known.has(coordinate)) {
      if (p.name.startsWith("@pdaa/"))
        return {
          id: p.id,
          name: p.name,
          version: p.version,
          source: "workspace",
        };
      const integrity = locked.get(coordinate);
      assert(
        integrity,
        "Shipped package missing from exact lockfile: " + coordinate,
      );
      return {
        id: p.id,
        name: p.name,
        version: p.version,
        integrity,
        locations: p.locations,
      };
    }
    // Named, versionless entry-point manifests (e.g. rxjs/ajax) are part of a
    // physically enclosing locked package. Never hide them or cross node_modules.
    assert.equal(
      p.version,
      "UNKNOWN",
      "Unregistered application package: " + coordinate,
    );
    const parents = registered.filter(
      (parent) =>
        !parent.name.startsWith("@pdaa/") &&
        p.locations.every((child) =>
          parent.locations.some((location) => {
            if (
              !location.path.endsWith("/package.json") ||
              !child.path.endsWith("/package.json")
            )
              return false;
            const local = posix.relative(
              posix.dirname(location.path),
              child.path,
            );
            return (
              !local.startsWith("..") &&
              local !== "package.json" &&
              !local.split("/").includes("node_modules")
            );
          }),
        ),
    );
    assert.equal(
      parents.length,
      1,
      "Versionless manifest has no unique locked parent: " + coordinate,
    );
    const parent = parents[0];
    assert(
      locked.has(`${parent.name}@${parent.version}`),
      "Embedded manifest parent is not locked",
    );
    return {
      id: p.id,
      name: p.name,
      reportedVersion: p.version,
      embeddedManifestOf: `${parent.name}@${parent.version}`,
      locations: p.locations,
      reviewRequired: true,
    };
  });
}

export function assertReleaseReady(report) {
  assert.equal(report.status, "complete", "Distribution evidence incomplete");
  requireCompleteTargets(report.images);
  // Review and trusted signing are intentionally not implemented by collection.
  // No caller-provided boolean or empty blocker list may turn evidence into approval.
  assert.fail(
    "Distribution is blocked pending exact inventory/notices review, vulnerability dispositions and trusted release signing",
  );
}

export function verifyEvidenceFiles(directory, report) {
  assert.equal(report.schemaVersion, 2, "Dual-scope evidence schema required");
  assert.equal(report.status, "complete", "Distribution evidence incomplete");
  requireCompleteTargets(report.images);
  assert(
    report.files && Object.keys(report.files).length > 0,
    "Evidence file manifest missing",
  );
  const required = [
    "runtime-policy.json",
    "pnpm-lock.yaml",
    "lock-inventory.json",
    "production-acceptance.json",
    "browser.syft.json",
    "browser.spdx.json",
    "browser.grype.json",
    "browser.scan-receipt.json",
  ];
  for (const target of customerTargets)
    for (const suffix of [
      ".image.json",
      ".syft.json",
      ".spdx.json",
      ".grype.json",
      ".notices.json",
      ".review.json",
      ".layers.syft.json",
      ".layers.spdx.json",
      ".layers.grype.json",
      ".layers.notices.json",
      ".layers.review.json",
    ])
      required.push(target + suffix);
  for (const entry of Object.values(report.images)) {
    assert.equal(entry.scope, "squashed", "Runtime evidence scope absent");
    assert.equal(
      entry.allLayers?.scope,
      "all-layers",
      "Distributed layer evidence absent",
    );
    assert.equal(
      entry.allLayers.imageId,
      entry.imageId,
      "Distributed layer image differs",
    );
  }
  for (const name of required)
    assert(
      Object.hasOwn(report.files, name),
      "Required evidence missing: " + name,
    );
  assert.deepEqual(
    readdirSync(directory)
      .filter((n) => n !== "summary.json")
      .sort(),
    Object.keys(report.files).sort(),
    "Evidence directory contains missing or unexpected files",
  );
  for (const [name, checksum] of Object.entries(report.files)) {
    assert(
      /^[a-z0-9][a-z0-9.-]*$/.test(name) && !name.includes(".."),
      "Unsafe evidence path",
    );
    assert(/^[a-f0-9]{64}$/.test(checksum), "Invalid evidence checksum");
    assert.equal(
      hash(readFileSync(join(directory, name))),
      checksum,
      "Evidence file changed: " + name,
    );
  }
}
