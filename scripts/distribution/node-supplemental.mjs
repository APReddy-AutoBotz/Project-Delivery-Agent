// NFR-SEC-010 / AC-MNT-004: original source extracts are evidence, not license approval.
import assert from "node:assert/strict";
import {
  readFileSync,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
} from "node:fs";
import { join, posix } from "node:path";
import { hash, customerTargets } from "./evidence.mjs";
import {
  nodeTargets,
  validateNodePolicy,
  validateNodeImage,
} from "./node-components.mjs";

export const nodeSupplementRoot = "/usr/local/share/doc/node/supplements";
export const nodeSupplementIndex = nodeSupplementRoot + "/index.json";
export function readBoundedNodeFile(path, maximum, expectedSize) {
  assert(
    Number.isSafeInteger(maximum) &&
      maximum > 0 &&
      maximum <= 256 * 1024 * 1024,
    "Invalid Node file read bound",
  );
  assert(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    "Node source must be a regular file",
  );
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    assert(
      stat.isFile() && stat.size > 0 && stat.size <= maximum,
      "Node file exceeds read bound or type differs",
    );
    if (expectedSize !== undefined)
      assert.equal(
        stat.size,
        expectedSize,
        "Node file size differs before read",
      );
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length; ) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert(count > 0, "Node file shortened during read");
      offset += count;
    }
    assert.equal(
      readSync(fd, Buffer.alloc(1), 0, 1, bytes.length),
      0,
      "Node file grew during read",
    );
    assert.equal(
      fstatSync(fd).size,
      stat.size,
      "Node file changed size during read",
    );
    return bytes;
  } finally {
    closeSync(fd);
  }
}
const sourceCounts = new Map([
  ["deps/nbytes/LICENSE", 1],
  ["deps/sqlite/sqlite3.c", 145],
  ["deps/sqlite/sqlite3.h", 3],
  ["deps/sqlite/sqlite3ext.h", 1],
]);
const sha = /^[a-f0-9]{64}$/;
const exactKeys = (value, keys) => {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Invalid Node supplement object",
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    "Node supplement schema differs",
  );
};
function text(bytes, maximum) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum,
    "Node supplement byte limit",
  );
  const value = bytes.toString("utf8");
  assert(
    Buffer.from(value).equals(bytes) && !value.includes("\0"),
    "Invalid Node supplement UTF-8",
  );
  return value;
}
function pin(value, maximum) {
  assert(
    Number.isSafeInteger(value.size) &&
      value.size > 0 &&
      value.size <= maximum &&
      sha.test(value.sha256),
    "Invalid Node supplement pin",
  );
}
const noticePath = (component, notice) =>
  component.key === "nbytes"
    ? "nbytes/LICENSE"
    : `sqlite/${posix.basename(notice.sourcePath)}/NOTICE-${notice.start}-${notice.end}.txt`;

export function validateNodeSupplementPolicy(bytes, nodePolicyBytes) {
  const policy = JSON.parse(text(bytes, 256 * 1024));
  const node = validateNodePolicy(nodePolicyBytes);
  exactKeys(policy, [
    "schemaVersion",
    "reviewRequired",
    "source",
    "binary",
    "rootNoticeSha256",
    "components",
  ]);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(
    policy.reviewRequired,
    true,
    "Node supplement review cannot be waived",
  );
  assert.deepEqual(
    policy.binary,
    node.binary,
    "Supplement Node executable differs",
  );
  assert.equal(
    policy.rootNoticeSha256,
    node.notice.sha256,
    "Supplement root notice differs",
  );
  exactKeys(policy.source, ["repository", "commit", "files"]);
  assert.equal(policy.source.repository, node.source.repository);
  assert.equal(
    policy.source.commit,
    node.source.commit,
    "Supplement Node source commit differs",
  );
  assert(Array.isArray(policy.source.files));
  assert.deepEqual(
    policy.source.files.map((f) => f.path),
    [...sourceCounts.keys()],
    "Supplement original source inventory differs",
  );
  const sources = new Map();
  for (const file of policy.source.files) {
    exactKeys(file, ["path", "size", "sha256", "url"]);
    pin(file, 16 * 1024 * 1024);
    assert.equal(
      file.url,
      `https://raw.githubusercontent.com/nodejs/node/${policy.source.commit}/${file.path}`,
      "Supplement source URL differs",
    );
    sources.set(file.path, file);
  }
  assert(Array.isArray(policy.components));
  assert.deepEqual(
    policy.components.map((c) => c.key),
    ["nbytes", "sqlite", "ncrypto"],
    "Supplement component coverage differs",
  );
  for (const component of policy.components) {
    exactKeys(component, ["key", "version", "sourcePath", "method", "notices"]);
    const original = node.components.find((c) => c.key === component.key);
    assert.equal(
      component.version,
      node.metadata.versions[component.key],
      "Supplement component version differs",
    );
    assert.equal(
      component.sourcePath,
      original.sourcePath,
      "Supplement component source differs",
    );
    assert.equal(
      component.sourcePath,
      `deps/${component.key}`,
      "Reviewed supplemental source root differs",
    );
    assert.equal(
      original.noticeSection,
      null,
      "Original root-notice gap must remain explicit",
    );
    const method =
      component.key === "nbytes"
        ? "complete-original-file"
        : component.key === "sqlite"
          ? "original-source-comments"
          : "unresolved";
    assert.equal(
      component.method,
      method,
      "Supplement attribution method differs",
    );
    assert(Array.isArray(component.notices));
    const paths = new Set(),
      counts = new Map(),
      ends = new Map();
    assert.deepEqual(
      component.notices,
      [...component.notices].sort(
        (a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.start - b.start,
      ),
      "Supplement source order differs",
    );
    for (const notice of component.notices) {
      exactKeys(notice, [
        "path",
        "sourcePath",
        "start",
        "end",
        "size",
        "sha256",
      ]);
      const parent = sources.get(notice.sourcePath);
      assert(
        parent && notice.sourcePath.startsWith(component.sourcePath + "/"),
        "Supplement notice borrows another component source",
      );
      assert.equal(
        notice.path,
        noticePath(component, notice),
        "Supplement notice namespace differs",
      );
      assert(!paths.has(notice.path), "Duplicate supplemental notice");
      paths.add(notice.path);
      pin(notice, 64 * 1024);
      assert(
        Number.isSafeInteger(notice.start) &&
          Number.isSafeInteger(notice.end) &&
          notice.start >= (ends.get(notice.sourcePath) ?? 0) &&
          notice.end <= parent.size &&
          notice.end - notice.start === notice.size,
        "Supplement source range differs",
      );
      ends.set(notice.sourcePath, notice.end);
      counts.set(notice.sourcePath, (counts.get(notice.sourcePath) ?? 0) + 1);
      if (component.key === "nbytes") {
        assert.equal(notice.start, 0);
        assert.equal(notice.end, parent.size);
        assert.equal(
          notice.sha256,
          parent.sha256,
          "Complete original nbytes notice differs",
        );
      }
    }
    const expected =
      component.key === "nbytes"
        ? [...sourceCounts].slice(0, 1)
        : component.key === "sqlite"
          ? [...sourceCounts].slice(1)
          : [];
    assert.deepEqual(
      [...counts],
      expected,
      "Supplement original occurrence coverage differs",
    );
  }
  return policy;
}

// The exact pinned SQLite parents are C source. Recognize real block comments,
// skipping quoted tokens, line comments and logical backslash-newline splices.
// This is a bounded discovery rule, not a license classifier or source census.
export function sqliteAttributionSpans(bytes) {
  const source = text(bytes, 16 * 1024 * 1024),
    spans = [];
  const logical = (offset) => {
    while (source[offset] === "\\") {
      if (source[offset + 1] === "\n") offset += 2;
      else if (source[offset + 1] === "\r" && source[offset + 2] === "\n")
        offset += 3;
      else break;
    }
    return { value: source[offset], start: offset, next: offset + 1 };
  };
  let state = "normal",
    quote,
    start;
  for (let offset = 0; offset < source.length; ) {
    const a = logical(offset),
      b = logical(a.next);
    offset = a.next;
    if (state === "block") {
      if (a.value === "*" && b.value === "/") {
        const end = b.next,
          original = source.slice(start, end);
        if (/The author disclaims copyright|public domain/.test(original)) {
          const byteStart = Buffer.byteLength(source.slice(0, start)),
            byteEnd = Buffer.byteLength(source.slice(0, end));
          spans.push({
            start: byteStart,
            end: byteEnd,
            size: byteEnd - byteStart,
            sha256: hash(bytes.subarray(byteStart, byteEnd)),
          });
        }
        state = "normal";
        offset = end;
      }
    } else if (state === "line") {
      if (a.value === "\n" || a.value === "\r") state = "normal";
    } else if (state === "quoted") {
      if (a.value === "\\") offset = b.next;
      else if (a.value === quote) state = "normal";
    } else if (a.value === "/" && b.value === "*") {
      state = "block";
      start = a.start;
      offset = b.next;
    } else if (a.value === "/" && b.value === "/") {
      state = "line";
      offset = b.next;
    } else if (a.value === '"' || a.value === "'") {
      state = "quoted";
      quote = a.value;
    }
  }
  assert(
    state !== "block" && state !== "quoted",
    "Unterminated original source comment or quote",
  );
  return spans;
}

export function nodeSupplementIndexBytes(policyBytes, nodePolicyBytes) {
  const policy = validateNodeSupplementPolicy(policyBytes, nodePolicyBytes);
  return Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        reviewRequired: true,
        coverage: "original-source-attribution-superset",
        sourceMethod: "verified-parent-files-and-byte-spans",
        policySha256: hash(policyBytes),
        nodePolicySha256: hash(nodePolicyBytes),
        source: policy.source,
        binary: policy.binary,
        rootNoticeSha256: policy.rootNoticeSha256,
        components: policy.components,
      },
      null,
      2,
    ) + "\n",
  );
}

export function materializeNodeSupplements({
  policyBytes,
  nodePolicyBytes,
  sources,
  binaryBytes,
  originalNoticeBytes,
}) {
  const policy = validateNodeSupplementPolicy(policyBytes, nodePolicyBytes);
  assert.equal(binaryBytes.length, policy.binary.size);
  assert.equal(
    hash(binaryBytes),
    policy.binary.sha256,
    "Packaging Node binary differs",
  );
  assert.equal(
    hash(originalNoticeBytes),
    policy.rootNoticeSha256,
    "Packaging Node root notice differs",
  );
  assert.deepEqual(
    [...sources.keys()].sort(),
    policy.source.files.map((f) => f.path).sort(),
    "Original parent source set differs",
  );
  for (const parent of policy.source.files) {
    const bytes = sources.get(parent.path);
    text(bytes, 16 * 1024 * 1024);
    assert.equal(bytes.length, parent.size, "Original source size differs");
    assert.equal(hash(bytes), parent.sha256, "Original source SHA256 differs");
    if (parent.path.startsWith("deps/sqlite/")) {
      const expected = policy.components
        .flatMap((c) => c.notices)
        .filter((n) => n.sourcePath === parent.path)
        .map(({ start, end, size, sha256 }) => ({ start, end, size, sha256 }));
      assert.deepEqual(
        sqliteAttributionSpans(bytes),
        expected,
        "SQLite original comment coverage differs",
      );
    }
  }
  const output = new Map();
  for (const component of policy.components)
    for (const notice of component.notices) {
      const bytes = sources
        .get(notice.sourcePath)
        .subarray(notice.start, notice.end);
      text(bytes, 64 * 1024);
      assert.equal(
        hash(bytes),
        notice.sha256,
        "Original source extract differs",
      );
      output.set(notice.path, bytes);
    }
  output.set(
    "index.json",
    nodeSupplementIndexBytes(policyBytes, nodePolicyBytes),
  );
  return output;
}

export async function fetchNodeSupplementSources(
  policyBytes,
  nodePolicyBytes,
  fetchSource = fetch,
) {
  const policy = validateNodeSupplementPolicy(policyBytes, nodePolicyBytes),
    sources = new Map();
  for (const parent of policy.source.files) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetchSource(parent.url, {
        redirect: "error",
        signal: controller.signal,
      });
      assert.equal(response.status, 200, "Original source fetch failed");
      assert(response.body, "Original source body missing");
      const reader = response.body.getReader(),
        chunks = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        assert(length <= parent.size, "Original source download exceeds pin");
        chunks.push(Buffer.from(value));
      }
      const bytes = Buffer.concat(chunks);
      text(bytes, 16 * 1024 * 1024);
      assert.equal(bytes.length, parent.size, "Downloaded source size differs");
      assert.equal(
        hash(bytes),
        parent.sha256,
        "Downloaded source SHA256 differs",
      );
      sources.set(parent.path, bytes);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return sources;
}

export function validateNodeSupplementEvidence({
  target,
  inspection,
  sbom,
  policyBytes,
  nodePolicyBytes,
}) {
  const policy = validateNodeSupplementPolicy(policyBytes, nodePolicyBytes);
  const { scope, binary } = validateNodeImage({
    target,
    inspection,
    sbom,
    policyBytes: nodePolicyBytes,
  });
  const layers = new Set(inspection.RootFS.Layers),
    expectedIndex = nodeSupplementIndexBytes(policyBytes, nodePolicyBytes);
  const sourceDigests = new Set(
    policy.source.files
      .filter((f) => f.path.startsWith("deps/sqlite/"))
      .map((f) => f.sha256),
  );
  for (const file of sbom.files) {
    const path = file.location?.path ?? "";
    assert(
      !["/collector", "/node-sources", "/out-node-notices"].some(
        (root) => path === root || path.startsWith(root + "/"),
      ),
      "Build-only Node source/helper path observed",
    );
    assert(
      !file.digests?.some(
        (d) => d.algorithm === "sha256" && sourceDigests.has(d.value),
      ),
      "Full original SQLite source must remain build-only",
    );
  }
  const expected = new Map([
    [
      nodeSupplementIndex,
      { size: expectedIndex.length, sha256: hash(expectedIndex) },
    ],
  ]);
  for (const c of policy.components)
    for (const n of c.notices)
      expected.set(nodeSupplementRoot + "/" + n.path, n);
  const dirs = new Set([nodeSupplementRoot]);
  for (const path of expected.keys())
    for (
      let dir = posix.dirname(path);
      dir.startsWith(nodeSupplementRoot);
      dir = posix.dirname(dir)
    )
      dirs.add(dir);
  const namespace = sbom.files.filter(
    (f) =>
      f.location?.path === nodeSupplementRoot ||
      f.location?.path?.startsWith(nodeSupplementRoot + "/"),
  );
  for (const file of namespace)
    if (file.metadata?.type === "Directory") {
      assert(
        dirs.has(file.location.path) && layers.has(file.location.layerID),
        "Unexpected supplement directory or layer",
      );
    }
  assert.deepEqual(
    namespace
      .filter((f) => f.metadata?.type !== "Directory")
      .map((f) => f.location.path)
      .sort(),
    [...expected.keys()].sort(),
    "Missing, additional or linked supplemental file",
  );
  const identities = new Map();
  for (const [path, pinned] of expected) {
    const file = namespace.find((f) => f.location.path === path);
    assert(
      file &&
        file.metadata?.type === "RegularFile" &&
        typeof file.id === "string" &&
        file.id.length > 0 &&
        layers.has(file.location.layerID),
      "Supplement file identity/type/layer differs",
    );
    assert.equal(
      sbom.files.filter((f) => f.id === file.id).length,
      1,
      "Ambiguous supplemental file ID",
    );
    const digests = file.digests?.filter((d) => d.algorithm === "sha256");
    assert.equal(digests?.length, 1, "Supplement SHA256 missing");
    assert.equal(
      digests[0].value,
      pinned.sha256,
      "Supplement original digest differs",
    );
    assert.equal(
      file.metadata.size,
      pinned.size,
      "Supplement original size differs",
    );
    assert(
      typeof file.contents === "string" && file.contents.length <= 512 * 1024,
      "Supplement original content missing or oversized",
    );
    const bytes = Buffer.from(file.contents, "base64");
    assert.equal(
      bytes.toString("base64"),
      file.contents,
      "Supplement content encoding differs",
    );
    text(bytes, 256 * 1024);
    assert.equal(bytes.length, pinned.size);
    assert.equal(
      hash(bytes),
      pinned.sha256,
      "Captured supplemental bytes differ",
    );
    if (path === nodeSupplementIndex)
      assert(bytes.equals(expectedIndex), "Supplement index bytes differ");
    identities.set(path, {
      fileId: file.id,
      path,
      layerID: file.location.layerID,
      size: pinned.size,
      sha256: pinned.sha256,
    });
  }
  return {
    schemaVersion: 1,
    target,
    imageId: inspection.Id,
    scope,
    binary,
    policySha256: hash(policyBytes),
    nodePolicySha256: hash(nodePolicyBytes),
    sourceCommit: policy.source.commit,
    index: identities.get(nodeSupplementIndex),
    coverage: "original-source-attribution-superset",
    components: policy.components.map((c) => ({
      ...c,
      notices: c.notices.map((n) => ({
        ...n,
        file: identities.get(nodeSupplementRoot + "/" + n.path),
      })),
      reviewRequired: true,
    })),
    rootNoticeGaps: ["nbytes", "ncrypto", "sqlite"],
    supplementalCoverage: ["nbytes", "sqlite"],
    unresolvedSupplementalComponents: ["ncrypto"],
    reviewRequired: true,
  };
}

export function verifyNodeSupplementReports(directory, report) {
  const read = (name) =>
    JSON.parse(readFileSync(join(directory, name), "utf8"));
  const policyBytes = readFileSync(join(directory, "node-supplemental.json")),
    nodePolicyBytes = readFileSync(join(directory, "node-components.json"));
  validateNodeSupplementPolicy(policyBytes, nodePolicyBytes);
  for (const target of customerTargets)
    for (const [suffix, scope, recorded] of [
      ["", "squashed", report.images[target]],
      [".layers", "all-layers", report.images[target].allLayers],
    ]) {
      const sbom = read(`${target}${suffix}.syft.json`),
        inspection = read(`${target}.image.json`);
      assert.equal(recorded.scope, scope);
      assert.equal(sbom.descriptor?.configuration?.search?.scope, scope);
      assert.equal(recorded.imageId, inspection.Id);
      if (nodeTargets.includes(target))
        assert.deepEqual(
          recorded.nodeSupplements,
          validateNodeSupplementEvidence({
            target,
            inspection,
            sbom,
            policyBytes,
            nodePolicyBytes,
          }),
          "Retained Node supplemental evidence differs",
        );
      else {
        assert.equal(
          recorded.nodeSupplements,
          undefined,
          "Unexpected supplement target",
        );
        assert(
          !sbom.files.some(
            (f) =>
              f.location?.path === nodeSupplementRoot ||
              f.location?.path?.startsWith(nodeSupplementRoot + "/"),
          ),
          "Unexpected supplemental payload",
        );
      }
      assert.deepEqual(
        read(`${target}${suffix}.review.json`),
        recorded,
        "Retained supplemental review differs",
      );
    }
}
