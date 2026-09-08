// NFR-SEC-010 / AC-MNT-004: reconcile source notices without approving licenses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { hash } from "./evidence.mjs";

export const goNoticeRoot = "/usr/share/caddy/modules";
export const goNoticeIndex = goNoticeRoot + "/index.json";
const sha = /^[a-f0-9]{64}$/;
const sum = /^h1:[A-Za-z0-9+/]{43}=$/;
const version = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+incompatible)?$/;
const pathOrder = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const keys = (value, expected) =>
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    "Go notice schema differs",
  );
const safePath = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !posix.isAbsolute(p) &&
  posix.normalize(p) === p &&
  !p.includes("\\") &&
  [...p].every((character) => character.charCodeAt(0) >= 32) &&
  p.split("/").every((part) => part && part !== "." && part !== "..");

export function isGoNoticePath(path) {
  if (
    /\.(?:go|js|ts|tsx|jsx|py|c|h|cc|cpp|rs|java|sh|bat|exe|dll|so|png|jpg|svg|gif|pdf|json)$/i.test(
      path,
    )
  )
    return false;
  return (
    posix
      .dirname(path)
      .split("/")
      .some((p) => /^licen[sc]es$/i.test(p)) ||
    /^(?:licen[sc]es?|notices?|copyrights?|copying|authors|patents|third[-_ ]party(?:[-_ ]notices?)?)(?:$|[._ -])/i.test(
      posix.basename(path),
    )
  );
}

export function validateGoNoticeInventory(bytes) {
  const inventory = JSON.parse(bytes.toString("utf8"));
  keys(inventory, ["schemaVersion", "reviewRequired", "binary", "modules"]);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(
    inventory.reviewRequired,
    true,
    "Go attribution review cannot be waived",
  );
  const binary = inventory.binary;
  keys(binary, ["path", "sha256", "goVersion", "mainModule", "buildSettings"]);
  assert.equal(binary.path, "/usr/bin/caddy");
  assert.equal(binary.mainModule, "github.com/caddyserver/caddy/v2");
  assert(sha.test(binary.sha256) && /^go\d+\.\d+\.\d+$/.test(binary.goVersion));
  for (const [key, value] of Object.entries({
    GOOS: "linux",
    GOARCH: "amd64",
    CGO_ENABLED: "0",
    "-trimpath": "true",
    "-tags": "nobadger,nomysql,nopgx",
  }))
    assert.equal(
      binary.buildSettings[key],
      value,
      "Pinned Go build settings differ",
    );
  assert(
    Array.isArray(inventory.modules) &&
      inventory.modules.length > 0 &&
      inventory.modules.length <= 1000,
  );
  assert.deepEqual(inventory.modules, [...inventory.modules].sort(pathOrder));
  const moduleNames = new Set();
  let noticeCount = 0,
    noticeBytes = 0;
  for (const m of inventory.modules) {
    keys(m, ["path", "version", "sum", "notices"]);
    assert(
      safePath(m.path) &&
        /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(m.path) &&
        !moduleNames.has(m.path),
      "Invalid/duplicate pinned Go module",
    );
    moduleNames.add(m.path);
    assert(
      version.test(m.version) &&
        sum.test(m.sum) &&
        Buffer.from(m.sum.slice(3), "base64").toString("base64") ===
          m.sum.slice(3),
      "Missing exact module version/h1",
    );
    assert(Array.isArray(m.notices));
    assert.deepEqual(m.notices, [...m.notices].sort(pathOrder));
    const paths = new Set();
    for (const n of m.notices) {
      keys(n, ["path", "size", "sha256"]);
      assert(
        safePath(n.path) && isGoNoticePath(n.path) && !paths.has(n.path),
        "Invalid/duplicate pinned notice path",
      );
      paths.add(n.path);
      assert(
        Number.isInteger(n.size) &&
          n.size > 0 &&
          n.size <= 128 * 1024 &&
          sha.test(n.sha256),
        "Invalid pinned notice bytes",
      );
      noticeCount++;
      noticeBytes += n.size;
    }
  }
  assert(moduleNames.has(binary.mainModule), "Pinned main module missing");
  assert(
    noticeCount <= 512 && noticeBytes <= 4 * 1024 * 1024,
    "Go notice capture limit exceeded",
  );
  return inventory;
}

export function validateGoModuleNotices(sbom, inventoryBytes) {
  const inventory = validateGoNoticeInventory(inventoryBytes);
  const files = sbom.files ?? [];
  const scope = sbom.descriptor?.configuration?.search?.scope;
  assert(
    ["squashed", "all-layers"].includes(scope),
    "Go notice image scope missing",
  );
  const layer = /^sha256:[a-f0-9]{64}$/;
  function singleFile(path, expectedHash, expectedSize, content = false) {
    const matches = files.filter((f) => f.location?.path === path);
    assert.equal(
      matches.length,
      1,
      "Missing or additional Go binary/notice copy: " + path,
    );
    const file = matches[0];
    assert(
      file.id && layer.test(file.location.layerID),
      "Go notice file/layer identity absent",
    );
    assert.equal(
      file.metadata?.type,
      "RegularFile",
      "Go notice must be an original regular file",
    );
    const hashes = file.digests?.filter((d) => d.algorithm === "sha256");
    assert.equal(hashes?.length, 1, "Go file digest missing");
    assert(sha.test(hashes[0].value));
    if (expectedHash !== undefined)
      assert.equal(
        hashes[0].value,
        expectedHash,
        "Pinned Go file digest differs",
      );
    if (expectedSize !== undefined)
      assert.equal(
        file.metadata.size,
        expectedSize,
        "Original notice size differs",
      );
    if (content) {
      assert.equal(
        typeof file.contents,
        "string",
        "Original Go notice content missing",
      );
      const bytes = Buffer.from(file.contents, "base64");
      assert.equal(
        bytes.toString("base64"),
        file.contents,
        "Noncanonical captured notice encoding",
      );
      assert.equal(
        hash(bytes),
        hashes[0].value,
        "Captured Go notice bytes differ",
      );
      assert.equal(
        bytes.length,
        file.metadata.size,
        "Captured Go notice size differs",
      );
      assert(
        Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes) &&
          !bytes.includes(0),
        "Unsupported captured notice text",
      );
    }
    return file;
  }
  const binary = singleFile(inventory.binary.path, inventory.binary.sha256);
  const indexFile = singleFile(goNoticeIndex, undefined, undefined, true);
  assert.equal(
    indexFile.location.layerID,
    binary.location.layerID,
    "Go index belongs to another binary layer",
  );
  const index = JSON.parse(
    Buffer.from(indexFile.contents, "base64").toString("utf8"),
  );
  keys(index, [
    "schemaVersion",
    "reviewRequired",
    "coverage",
    "sourceMethod",
    "inventorySha256",
    "binary",
    "modules",
  ]);
  assert.equal(index.schemaVersion, 1);
  assert.equal(
    index.reviewRequired,
    true,
    "Go attribution review cannot be waived",
  );
  assert.equal(index.coverage, "module-source-notice-superset");
  assert.equal(index.sourceMethod, "offline-cache-zip-h1");
  assert.equal(
    index.inventorySha256,
    hash(inventoryBytes),
    "Go manifest inventory identity differs",
  );
  assert.deepEqual(
    index.binary,
    inventory.binary,
    "Go manifest binary identity differs",
  );
  assert(Array.isArray(index.modules));
  assert.equal(
    index.modules.length,
    inventory.modules.length,
    "Go manifest module coverage differs",
  );
  const observed = sbom.artifacts.filter((p) => p.type === "go-module");
  assert.equal(
    observed.length,
    inventory.modules.length + 1,
    "Observed Go module coverage differs",
  );
  const observedNames = new Set(),
    observedIds = new Set();
  for (const p of observed) {
    assert(
      p.id && !observedIds.has(p.id) && !observedNames.has(p.name),
      "Duplicate observed Go module",
    );
    observedIds.add(p.id);
    observedNames.add(p.name);
    assert.equal(p.locations?.length, 1, "Additional Go binary location");
    assert.equal(
      p.locations[0].path,
      binary.location.path,
      "Go module belongs to another binary",
    );
    assert.equal(
      p.locations[0].layerID,
      binary.location.layerID,
      "Go module belongs to another binary layer",
    );
    assert.equal(
      p.metadata?.goCompiledVersion,
      inventory.binary.goVersion,
      "Observed Go compiler differs",
    );
  }
  const standard = observed.find((p) => p.name === "stdlib");
  assert.equal(
    standard?.version,
    inventory.binary.goVersion,
    "Standard library coverage differs",
  );
  const capturedPaths = new Set([goNoticeIndex]);
  const modules = inventory.modules.map((m, i) => {
    const record = index.modules[i];
    keys(record, [
      "path",
      "version",
      "sum",
      "zipSha256",
      "noticeStatus",
      "notices",
    ]);
    for (const key of ["path", "version", "sum"])
      assert.equal(record[key], m[key], "Go manifest module identity differs");
    assert(
      sha.test(record.zipSha256),
      "Source archive transport digest missing",
    );
    assert.equal(
      record.noticeStatus,
      m.notices.length ? "collected" : "missing",
    );
    assert(Array.isArray(record.notices));
    assert.equal(
      record.notices.length,
      m.notices.length,
      "Go notice coverage differs",
    );
    const p = observed.find((p) => p.name === m.path);
    assert(
      p && p.version === m.version && p.metadata?.h1Digest === m.sum,
      "Observed module version/h1 differs",
    );
    assert.equal(
      p.metadata.mainModule,
      inventory.binary.mainModule,
      "Go module main binary differs",
    );
    if (m.path === inventory.binary.mainModule) {
      const settings = p.metadata.goBuildSettings;
      assert(
        Array.isArray(settings) &&
          new Set(settings.map((s) => s.key)).size === settings.length,
        "Duplicate/missing observed build settings",
      );
      assert.deepEqual(
        Object.fromEntries(settings.map((s) => [s.key, s.value])),
        inventory.binary.buildSettings,
        "Observed Go build settings differ",
      );
    }
    const notices = m.notices.map((n, j) => {
      const shippedPath = `${goNoticeRoot}/${hash(m.path + "@" + m.version)}/${n.path}`;
      assert.deepEqual(
        record.notices[j],
        { ...n, shippedPath },
        "Go original notice inventory differs",
      );
      const file = singleFile(shippedPath, n.sha256, n.size, true);
      assert.equal(
        file.location.layerID,
        binary.location.layerID,
        "Go notice belongs to another binary layer",
      );
      capturedPaths.add(shippedPath);
      return {
        path: n.path,
        shippedPath,
        sha256: n.sha256,
        fileId: file.id,
        layerID: file.location.layerID,
      };
    });
    return {
      path: m.path,
      version: m.version,
      sum: m.sum,
      packageId: p.id,
      noticeStatus: record.noticeStatus,
      notices,
    };
  });
  for (const file of files) {
    const path = file.location.path;
    assert(
      !path.startsWith("/go/") && !path.startsWith("/notice-collector/"),
      "Go build source/cache leaked into the runtime",
    );
    if (
      path.startsWith(goNoticeRoot + "/") &&
      file.metadata?.type !== "Directory"
    )
      assert(capturedPaths.has(path), "Unexpected file in Go notice directory");
  }
  return {
    schemaVersion: 1,
    scope,
    inventorySha256: hash(inventoryBytes),
    index: {
      path: goNoticeIndex,
      fileId: indexFile.id,
      layerID: indexFile.location.layerID,
      sha256: hash(Buffer.from(indexFile.contents, "base64")),
    },
    binary: {
      path: binary.location.path,
      fileId: binary.id,
      layerID: binary.location.layerID,
      sha256: inventory.binary.sha256,
    },
    moduleCount: modules.length,
    modulesWithNotices: modules.filter((m) => m.notices.length).length,
    noticeFiles: modules.reduce((n, m) => n + m.notices.length, 0),
    modules,
    coverage: index.coverage,
    reviewRequired: true,
  };
}

export function verifyGoNoticeReports(directory, report) {
  const bytes = readFileSync(join(directory, "caddy-modules.json"));
  for (const [suffix, recorded] of [
    ["", report.images.web],
    [".layers", report.images.web.allLayers],
  ]) {
    const sbom = JSON.parse(
      readFileSync(join(directory, `web${suffix}.syft.json`), "utf8"),
    );
    assert.deepEqual(
      validateGoModuleNotices(sbom, bytes),
      recorded.goNotices,
      "Recorded Go notice reconciliation differs",
    );
  }
}
