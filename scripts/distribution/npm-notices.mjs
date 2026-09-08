// NFR-SEC-010 / AC-MNT-004: original bytes and physical attribution, never approval.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { load } from "js-yaml";
import {
  collectImageNotices,
  hash,
  reconcileApplicationPackages,
} from "./evidence.mjs";

export const npmTargets = ["api", "worker", "operations"];
const sha256 = /^[a-f0-9]{64}$/;
const layerDigest = /^sha256:[a-f0-9]{64}$/;
const maxFileSize = 5 * 1024 * 1024;
const namedNotice = /^(licen[sc]e|notice|copyright)/i;
const coordinate = (p) => `${p.name}@${p.version}`;
const fileKey = (path, layer) => JSON.stringify([path, layer]);
const exactKeys = (value, keys, label) => {
  assert(value && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
};
function safePath(value, absolute = false) {
  assert(
    typeof value === "string" && value.length > 0 && value.length <= 2048,
    "Invalid npm evidence path",
  );
  assert(
    !value.includes("\\") &&
      [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
    "Unsafe npm evidence path",
  );
  assert.equal(
    posix.isAbsolute(value),
    absolute,
    "Invalid npm evidence path root",
  );
  assert.equal(posix.normalize(value), value, "Noncanonical npm evidence path");
  assert(
    !value
      .split("/")
      .some(
        (p, i) =>
          p === "." || p === ".." || (p === "" && !(absolute && i === 0)),
      ),
    "Unsafe npm evidence path component",
  );
}
function validatePin(pin) {
  exactKeys(pin, ["path", "size", "sha256"], "Invalid npm source file pin");
  safePath(pin.path);
  assert(
    !pin.path.split("/").includes("node_modules"),
    "Source pin crosses a package boundary",
  );
  assert(
    Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= 128 * 1024,
    "Invalid npm source file size",
  );
  assert(sha256.test(pin.sha256), "Invalid npm source file hash");
}
export function validateNpmNoticeInventory(bytes) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024,
    "Invalid npm notice inventory bytes",
  );
  const inventory = JSON.parse(bytes.toString("utf8"));
  exactKeys(
    inventory,
    ["schemaVersion", "reviewRequired", "packages"],
    "Invalid npm notice inventory",
  );
  assert.equal(
    inventory.schemaVersion,
    1,
    "Unsupported npm notice inventory schema",
  );
  assert.equal(
    inventory.reviewRequired,
    true,
    "Npm license review remains required",
  );
  assert(
    Array.isArray(inventory.packages) &&
      inventory.packages.length > 0 &&
      inventory.packages.length <= 32,
    "Invalid npm notice package count",
  );
  const names = new Set();
  for (const p of inventory.packages) {
    exactKeys(
      p,
      [
        "name",
        "version",
        "integrity",
        "targets",
        "source",
        "manifest",
        "notices",
        "embeddedManifests",
      ],
      "Invalid npm notice package",
    );
    assert(
      /^(@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(p.name) &&
        !names.has(p.name),
      "Invalid or duplicate npm source package",
    );
    names.add(p.name);
    assert(
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(p.version),
      "Invalid pinned npm version",
    );
    assert(
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity),
      "Invalid pinned npm integrity",
    );
    assert(
      Array.isArray(p.targets) &&
        p.targets.length > 0 &&
        new Set(p.targets).size === p.targets.length &&
        p.targets.every((t) => npmTargets.includes(t)),
      "Invalid npm notice targets",
    );
    exactKeys(p.source, ["archive", "sha256"], "Invalid npm publisher source");
    const source = new URL(p.source.archive);
    assert(
      source.origin === "https://registry.npmjs.org" &&
        source.pathname.endsWith(".tgz") &&
        !source.search &&
        !source.hash &&
        !source.username &&
        !source.password &&
        sha256.test(p.source.sha256),
      "Invalid pinned npm publisher archive",
    );
    validatePin(p.manifest);
    assert.equal(
      p.manifest.path,
      "package.json",
      "Npm root manifest must be package.json",
    );
    assert(
      Array.isArray(p.notices) &&
        p.notices.length > 0 &&
        p.notices.length <= 16,
      "Missing pinned npm notices",
    );
    const paths = new Set([p.manifest.path]);
    for (const pin of p.notices) {
      validatePin(pin);
      assert(
        namedNotice.test(posix.basename(pin.path)) || pin.path === "README.md",
        "Unsupported pinned npm notice file",
      );
      assert(!paths.has(pin.path), "Duplicate npm source file pin");
      paths.add(pin.path);
    }
    assert(
      Array.isArray(p.embeddedManifests) && p.embeddedManifests.length <= 32,
      "Invalid embedded npm manifest list",
    );
    const embeddedNames = new Set();
    for (const entry of p.embeddedManifests) {
      exactKeys(
        entry,
        ["name", "manifest"],
        "Invalid embedded npm manifest pin",
      );
      validatePin(entry.manifest);
      assert(
        entry.manifest.path.endsWith("/package.json"),
        "Invalid embedded manifest path",
      );
      assert.equal(
        entry.name,
        p.name + "/" + posix.dirname(entry.manifest.path),
        "Embedded npm name differs from source path",
      );
      assert(
        !paths.has(entry.manifest.path) && !embeddedNames.has(entry.name),
        "Duplicate embedded npm manifest",
      );
      paths.add(entry.manifest.path);
      embeddedNames.add(entry.name);
    }
  }
  return inventory;
}

function readContent(file) {
  assert(
    typeof file.contents === "string" &&
      file.contents.length <= Math.ceil(maxFileSize / 3) * 4,
    "Original npm file content missing or too large",
  );
  const bytes = Buffer.from(file.contents, "base64");
  assert.equal(
    bytes.toString("base64"),
    file.contents,
    "Invalid npm file base64",
  );
  assert(
    bytes.length > 0 &&
      !bytes.includes(0) &&
      Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes),
    "Unsupported npm notice text",
  );
  assert.equal(
    bytes.length,
    file.metadata.size,
    "Npm file content size differs",
  );
  assert.equal(
    hash(bytes),
    file.digests.find((d) => d.algorithm === "sha256").value,
    "Npm file content hash differs",
  );
  return bytes;
}
function reference(file) {
  return {
    fileId: file.id,
    path: file.location.path,
    layerID: file.location.layerID,
    sha256: file.digests.find((d) => d.algorithm === "sha256").value,
  };
}
function within(directory, path) {
  const local = posix.relative(directory, path);
  return (
    local !== "" &&
    !local.startsWith("..") &&
    !posix.isAbsolute(local) &&
    !local.split("/").includes("node_modules")
  );
}

export function validateNpmModuleNotices({
  target,
  sbom,
  inspection,
  inventoryBytes,
  locked,
}) {
  assert(npmTargets.includes(target), "Unsupported npm image target");
  const inventory = validateNpmNoticeInventory(inventoryBytes);
  const scope = sbom.descriptor?.configuration?.search?.scope;
  assert(["squashed", "all-layers"].includes(scope), "Invalid npm image scope");
  assert.equal(
    sbom.source?.type,
    "image",
    "Npm evidence must describe an image",
  );
  assert(
    layerDigest.test(inspection.Id),
    "Invalid immutable npm image identity",
  );
  assert.equal(inspection.Os, "linux");
  assert.equal(inspection.Architecture, "amd64");
  const source = sbom.source.metadata;
  assert.equal(source.userInput, inspection.Id, "Npm scanner image differs");
  const configBytes = Buffer.from(source.config, "base64");
  assert.equal(
    "sha256:" + hash(configBytes),
    source.imageID,
    "Npm image configuration hash differs",
  );
  const config = JSON.parse(configBytes);
  assert.equal(config.os, inspection.Os);
  assert.equal(config.architecture, inspection.Architecture);
  assert.deepEqual(
    config.rootfs?.diff_ids,
    inspection.RootFS?.Layers,
    "Npm image layers differ",
  );
  const layers = new Set(inspection.RootFS.Layers);
  assert(
    layers.size > 0 && [...layers].every((l) => layerDigest.test(l)),
    "Invalid npm supplying layers",
  );
  const files = new Map();
  for (const file of sbom.files ?? []) {
    if (!file.location?.path?.startsWith("/app/")) continue;
    safePath(file.location.path, true);
    assert(
      file.id && layers.has(file.location.layerID),
      "Npm file identity or layer missing",
    );
    const key = fileKey(file.location.path, file.location.layerID);
    assert(!files.has(key), "Duplicate npm file occurrence");
    files.set(key, file);
  }
  function getFile(path, layerID, pin, capture = false) {
    const file = files.get(fileKey(path, layerID));
    assert(file, "Npm source file missing from its supplying layer: " + path);
    assert.equal(
      file.metadata?.type,
      "RegularFile",
      "Npm source file is not regular",
    );
    assert(
      Number.isSafeInteger(file.metadata.size) &&
        file.metadata.size > 0 &&
        file.metadata.size <= maxFileSize,
      "Invalid npm source file metadata size",
    );
    const digests = file.digests?.filter((d) => d.algorithm === "sha256");
    assert(
      digests?.length === 1 && sha256.test(digests[0].value),
      "Npm source file digest missing or ambiguous",
    );
    if (pin) {
      assert.equal(
        file.metadata.size,
        pin.size,
        "Npm original source size differs",
      );
      assert.equal(
        digests[0].value,
        pin.sha256,
        "Npm original source hash differs",
      );
    }
    if (capture) readContent(file);
    return file;
  }
  const runtimeFiles = [...files.values()].filter(
    (f) => f.location.path === "/app/runtime-inventory.json",
  );
  assert.equal(
    runtimeFiles.length,
    1,
    "Runtime npm inventory missing or ambiguous",
  );
  const runtime = runtimeFiles[0];
  getFile(runtime.location.path, runtime.location.layerID, null, true);
  const expected = JSON.parse(readContent(runtime));
  assert(
    Array.isArray(expected.packages) &&
      new Set(expected.packages.map(coordinate)).size ===
        expected.packages.length,
    "Invalid or duplicate runtime npm inventory",
  );
  const packages = sbom.artifacts.filter(
    (p) =>
      p.type === "npm" && p.locations?.some((l) => l.path.startsWith("/app/")),
  );
  assert(
    packages.length > 0 &&
      new Set(packages.map((p) => p.id)).size === packages.length,
    "Npm scanner package identity missing or duplicate",
  );
  const applicationLockInventory = reconcileApplicationPackages(
    packages,
    expected,
    locked,
  );
  const locations = [];
  const locationKeys = new Set();
  for (const p of packages) {
    assert(p.id && p.locations.length > 0, "Npm manifest occurrence missing");
    for (const location of p.locations) {
      safePath(location.path, true);
      assert(
        location.path.startsWith("/app/") &&
          location.path.endsWith("/package.json") &&
          layers.has(location.layerID),
        "Invalid npm manifest location",
      );
      const key = fileKey(location.path, location.layerID);
      assert(!locationKeys.has(key), "Ambiguous npm manifest ownership");
      locationKeys.add(key);
      locations.push({
        p,
        location,
        manifest: getFile(location.path, location.layerID),
        directory: posix.dirname(location.path),
        key,
      });
    }
  }
  const ownerOf = (file) => {
    const candidates = locations
      .filter(
        (l) =>
          l.location.layerID === file.location.layerID &&
          within(l.directory, file.location.path),
      )
      .sort((a, b) => b.directory.length - a.directory.length);
    return candidates[0];
  };
  const baseNotices = collectImageNotices(sbom);
  const notices = [...baseNotices];
  const pinned = new Map();
  // The selected source baseline is mandatory, even if scanner/summary records disappear together.
  for (const policy of inventory.packages) {
    const observed = locations.filter((l) => l.p.name === policy.name);
    if (!policy.targets.includes(target)) {
      assert.equal(
        observed.length,
        0,
        "Npm source package appeared in an unreviewed target",
      );
      continue;
    }
    assert(observed.length > 0, "Required pinned npm package missing");
    assert.equal(
      locked.get(coordinate(policy)),
      policy.integrity,
      "Pinned npm source lock integrity differs",
    );
    for (const owner of observed) {
      assert.equal(
        owner.p.version,
        policy.version,
        "Pinned npm package version differs",
      );
      getFile(owner.location.path, owner.location.layerID, policy.manifest);
      const originals = policy.notices.map((pin) => {
        const file = getFile(
          posix.join(owner.directory, pin.path),
          owner.location.layerID,
          pin,
          true,
        );
        assert.equal(
          ownerOf(file)?.key,
          owner.key,
          "Pinned npm notice belongs to another manifest",
        );
        if (
          !notices.some(
            (n) =>
              n.fileId === file.id &&
              n.path === file.location.path &&
              n.layerID === file.location.layerID,
          )
        )
          notices.push({ ...reference(file), contents: file.contents });
        return file;
      });
      for (const entry of policy.embeddedManifests) {
        const path = posix.join(owner.directory, entry.manifest.path);
        const children = locations.filter(
          (l) =>
            l.location.path === path &&
            l.location.layerID === owner.location.layerID,
        );
        assert.equal(
          children.length,
          1,
          "Pinned npm entrypoint missing or ambiguous",
        );
        assert.equal(
          children[0].p.name,
          entry.name,
          "Pinned npm entrypoint name differs",
        );
        assert.equal(
          children[0].p.version,
          "UNKNOWN",
          "Pinned npm entrypoint version differs",
        );
        getFile(path, owner.location.layerID, entry.manifest);
      }
      pinned.set(owner.key, { policy, originals });
    }
  }
  const owned = new Map(locations.map((l) => [l.key, []]));
  const directlyCaptured = new Set(
    baseNotices.map((n) => fileKey(n.path, n.layerID)),
  );
  for (const notice of notices) {
    if (!notice.path.startsWith("/app/")) continue;
    const file = getFile(notice.path, notice.layerID, null, true);
    assert.deepEqual(
      { ...reference(file), contents: file.contents },
      notice,
      "Captured npm notice differs from native file",
    );
    const owner = ownerOf(file);
    if (owner) owned.get(owner.key).push(file);
  }
  const occurrences = locations
    .filter((l) => !l.p.name.startsWith("@pdaa/"))
    .map((entry) => {
      const reconciled = applicationLockInventory.find(
        (p) => p.id === entry.p.id,
      );
      let owner = entry;
      if (reconciled.embeddedManifestOf) {
        const parents = locations.filter(
          (l) =>
            coordinate(l.p) === reconciled.embeddedManifestOf &&
            l.location.layerID === entry.location.layerID &&
            l.key !== entry.key &&
            within(l.directory, entry.location.path),
        );
        assert.equal(
          parents.length,
          1,
          "Npm entrypoint has no unique physical locked parent",
        );
        owner = parents[0];
      }
      const sourcePin = pinned.get(owner.key);
      if (sourcePin && owner !== entry) {
        const relative = posix.relative(owner.directory, entry.location.path);
        assert(
          sourcePin.policy.embeddedManifests.some(
            (p) => p.name === entry.p.name && p.manifest.path === relative,
          ),
          "Unreviewed npm parent notice inheritance",
        );
      }
      const ownFiles = owned.get(entry.key);
      const originalFiles = [...ownFiles];
      if (sourcePin)
        for (const file of sourcePin.originals)
          if (!originalFiles.includes(file)) originalFiles.push(file);
      const integrity = locked.get(coordinate(owner.p));
      assert(integrity, "Npm notice owner is not locked");
      return {
        key: hash(
          JSON.stringify([
            target,
            inspection.Id,
            scope,
            entry.p.id,
            entry.location.path,
            entry.location.layerID,
          ]),
        ),
        packageId: entry.p.id,
        reportedName: entry.p.name,
        reportedVersion: entry.p.version,
        manifest: reference(entry.manifest),
        owner: {
          packageId: owner.p.id,
          name: owner.p.name,
          version: owner.p.version,
          integrity,
          manifest: reference(owner.manifest),
        },
        directNoticeStatus: ownFiles.some((f) =>
          directlyCaptured.has(fileKey(f.location.path, f.location.layerID)),
        )
          ? "captured"
          : "not-captured",
        attribution: sourcePin
          ? owner === entry
            ? "pinned-package-notices"
            : "pinned-parent-notices"
          : "direct-notices",
        noticeStatus: originalFiles.length ? "collected" : "uncollected",
        notices: originalFiles.map(reference),
        reviewRequired: true,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const missingIds = new Set(
    occurrences
      .filter((p) => p.noticeStatus === "uncollected")
      .map((p) => p.packageId),
  );
  return {
    notices,
    applicationLockInventory,
    missingPackageNotices: packages
      .filter((p) => missingIds.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, version: p.version })),
    npmNotices: {
      schemaVersion: 1,
      target,
      imageId: inspection.Id,
      scope,
      inventorySha256: hash(inventoryBytes),
      coverage: "original-files-and-reviewed-parent-attribution",
      occurrences,
      directNoticeGaps: occurrences
        .filter((p) => p.directNoticeStatus === "not-captured")
        .map((p) => p.key),
      reviewRequired: true,
    },
  };
}

export function verifyNpmNoticeReports(directory, report) {
  const read = (name) =>
    JSON.parse(readFileSync(join(directory, name), "utf8"));
  const inventoryBytes = readFileSync(join(directory, "npm-notices.json"));
  const lock = load(readFileSync(join(directory, "pnpm-lock.yaml"), "utf8"));
  assert.equal(
    String(lock.lockfileVersion),
    "9.0",
    "Unsupported npm evidence lockfile",
  );
  const entries = Object.entries(lock.packages).map(([coordinate, value]) => ({
    coordinate,
    integrity: value.resolution?.integrity,
  }));
  assert(
    entries.length > 0 &&
      entries.every((e) => /^sha(256|512)-[A-Za-z0-9+/=]+$/.test(e.integrity)),
    "Invalid npm lock evidence integrity",
  );
  assert.deepEqual(
    read("lock-inventory.json"),
    entries,
    "Archived npm lock inventory differs from lockfile bytes",
  );
  const locked = new Map(entries.map((p) => [p.coordinate, p.integrity]));
  for (const target of npmTargets) {
    const inspection = read(target + ".image.json");
    assert.equal(
      inspection.Id,
      report.images[target].imageId,
      "Recorded npm image differs",
    );
    for (const [suffix, scope, recorded] of [
      ["", "squashed", report.images[target]],
      [".layers", "all-layers", report.images[target].allLayers],
    ]) {
      const sbom = read(`${target}${suffix}.syft.json`);
      assert.equal(
        sbom.descriptor?.configuration?.search?.scope,
        scope,
        "Retained npm evidence scope differs",
      );
      assert.equal(
        recorded.scope,
        scope,
        "Recorded npm evidence scope differs",
      );
      assert.equal(
        recorded.imageId,
        inspection.Id,
        "Recorded npm scope image differs",
      );
      const result = validateNpmModuleNotices({
        target,
        sbom,
        inspection,
        inventoryBytes,
        locked,
      });
      for (const key of [
        "npmNotices",
        "applicationLockInventory",
        "missingPackageNotices",
      ])
        assert.deepEqual(
          recorded[key],
          result[key],
          "Recorded npm reconciliation differs: " + key,
        );
      assert.deepEqual(
        read(`${target}${suffix}.notices.json`),
        result.notices,
        "Retained original npm notices differ",
      );
      assert.deepEqual(
        read(`${target}${suffix}.review.json`),
        recorded,
        "Retained npm review differs",
      );
    }
  }
}
