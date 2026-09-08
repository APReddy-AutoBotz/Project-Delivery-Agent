// NFR-SEC-010 / AC-MNT-004: selected source bytes are not execution or license approval.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hash, customerTargets } from "./evidence.mjs";
import { nodeTargets } from "./node-components.mjs";
import { readBoundedNodeFile } from "./node-supplemental.mjs";
import {
  parseNodeResourceJson,
  validateNodeResourcePolicy,
  validateNodeResourceEvidence,
  verifyNodeResourceReports,
} from "./node-resources.mjs";

const requiredPairs = [
  ["Punycode.js", "punycode"],
  ["caja", "internal/freeze_intrinsics"],
  ["rimraf", "internal/fs/rimraf"],
  ["node-fs-extra", "internal/fs/cp/cp"],
  ["node-fs-extra", "internal/fs/cp/cp-sync"],
  ["on-exit-leak-free", "internal/process/finalization"],
  ["sonic-boom", "internal/streams/fast-utf8-stream"],
];
export const nodeSourcePolicyLimit = 64 * 1024;
export const nodeSourceBundleLimit = 256 * 1024;
const sourceLimit = 128 * 1024;
const sourceUrl = (commit, path) =>
  `https://raw.githubusercontent.com/nodejs/node/${commit}/${path}`;
const encode = (value) => Buffer.from(JSON.stringify(value) + "\n");
function keys(value, expected) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Source object required",
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    "Source schema differs",
  );
}

export function validateNodeSourcePolicy(
  sourcePolicyBytes,
  resourcePolicyBytes,
  nodePolicyBytes,
) {
  const policy = parseNodeResourceJson(
    sourcePolicyBytes,
    nodeSourcePolicyLimit,
  );
  const { policy: resource, node } = validateNodeResourcePolicy(
    resourcePolicyBytes,
    nodePolicyBytes,
  );
  keys(policy, [
    "schemaVersion",
    "reviewRequired",
    "sourceCommit",
    "binary",
    "rootNoticeSha256",
    "sources",
  ]);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.reviewRequired, true, "Source review cannot be waived");
  assert.equal(
    policy.sourceCommit,
    node.source.commit,
    "Source commit differs",
  );
  assert.deepEqual(policy.binary, node.binary, "Source binary pin differs");
  assert.equal(
    policy.rootNoticeSha256,
    node.notice.sha256,
    "Source root notice differs",
  );
  assert(Array.isArray(policy.sources), "Source rows required");
  assert.deepEqual(
    policy.sources.map((source) => [
      source.section,
      source.resourceId,
      source.path,
    ]),
    requiredPairs.map(([section, id]) => [section, id, `lib/${id}.js`]),
    "All seven source/resource pairs must remain ordered and complete",
  );
  let total = 0;
  for (const source of policy.sources) {
    keys(source, [
      "section",
      "resourceId",
      "path",
      "size",
      "sha256",
      "gitBlobSha1",
    ]);
    assert(
      Number.isSafeInteger(source.size) &&
        source.size > 0 &&
        source.size <= sourceLimit,
      "Source size bound",
    );
    assert(
      /^[a-f0-9]{64}$/.test(source.sha256) &&
        /^[a-f0-9]{40}$/.test(source.gitBlobSha1),
      "Invalid original source digest",
    );
    total += source.size;
    assert(total <= 1024 * 1024, "Source aggregate byte bound");
    const entry = resource.snapshot.entries.find(
      (item) => item.id === source.resourceId,
    );
    assert(entry?.kind === "utf8", "Source resource must be observed UTF-8");
    assert.equal(
      source.size,
      entry.size,
      "Selected source/resource sizes differ",
    );
    assert.equal(
      source.sha256,
      entry.sha256,
      "Selected source/resource hashes differ",
    );
    const section = node.notice.sections.find(
      (item) => item.name === source.section,
    );
    assert(
      section &&
        !node.components.some((item) => item.noticeSection === section.name),
      "Source section must retain residual identity",
    );
    assert(
      source.path === section.sourcePath ||
        source.path === section.sourcePath + ".js" ||
        source.path.startsWith(section.sourcePath + "/"),
      "Source path does not correspond to original notice path",
    );
  }
  return policy;
}

function verifySourceBytes(bytes, source) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length === source.size,
    "Original source size differs",
  );
  assert(
    Buffer.from(bytes.toString("utf8")).equals(bytes),
    "Original source UTF-8 differs",
  );
  assert.equal(hash(bytes), source.sha256, "Original source SHA256 differs");
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assert.equal(blob, source.gitBlobSha1, "Original source Git blob differs");
}

export function createNodeSourceBundle({
  sourcePolicyBytes,
  resourcePolicyBytes,
  nodePolicyBytes,
  readSource,
}) {
  const policy = validateNodeSourcePolicy(
    sourcePolicyBytes,
    resourcePolicyBytes,
    nodePolicyBytes,
  );
  const files = policy.sources.map((source) => {
    const bytes = readSource(source);
    verifySourceBytes(bytes, source);
    return {
      path: source.path,
      encoding: "base64",
      content: bytes.toString("base64"),
    };
  });
  const bytes = encode({
    schemaVersion: 1,
    sourcePolicySha256: hash(sourcePolicyBytes),
    resourcePolicySha256: hash(resourcePolicyBytes),
    nodePolicySha256: hash(nodePolicyBytes),
    files,
  });
  assert(
    bytes.length <= nodeSourceBundleLimit,
    "Source bundle exceeds byte limit",
  );
  return bytes;
}

export function validateNodeSourceBundle({
  sourcePolicyBytes,
  resourcePolicyBytes,
  nodePolicyBytes,
  bundleBytes,
}) {
  const policy = validateNodeSourcePolicy(
    sourcePolicyBytes,
    resourcePolicyBytes,
    nodePolicyBytes,
  );
  const bundle = parseNodeResourceJson(bundleBytes, nodeSourceBundleLimit);
  keys(bundle, [
    "schemaVersion",
    "sourcePolicySha256",
    "resourcePolicySha256",
    "nodePolicySha256",
    "files",
  ]);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(
    bundle.sourcePolicySha256,
    hash(sourcePolicyBytes),
    "Source bundle policy differs",
  );
  assert.equal(
    bundle.resourcePolicySha256,
    hash(resourcePolicyBytes),
    "Source bundle resource policy differs",
  );
  assert.equal(
    bundle.nodePolicySha256,
    hash(nodePolicyBytes),
    "Source bundle Node policy differs",
  );
  assert(
    bundleBytes.equals(encode(bundle)),
    "Source bundle must retain canonical original encoding",
  );
  assert(
    Array.isArray(bundle.files) &&
      bundle.files.length === policy.sources.length,
    "Source bundle file count differs",
  );
  for (const [index, file] of bundle.files.entries()) {
    const source = policy.sources[index];
    keys(file, ["path", "encoding", "content"]);
    assert.equal(file.path, source.path, "Source bundle path/order differs");
    assert.equal(file.encoding, "base64");
    assert(
      typeof file.content === "string" &&
        file.content.length === 4 * Math.ceil(source.size / 3),
      "Encoded source size differs before decode",
    );
    const bytes = Buffer.from(file.content, "base64");
    assert.equal(
      bytes.toString("base64"),
      file.content,
      "Noncanonical source base64",
    );
    verifySourceBytes(bytes, source);
  }
  return policy;
}

// One deadline covers each response's headers and complete body. Cancellation
// also runs on early size/hash failures; no source response is evaluated.
export async function fetchNodeSourceBundle({
  sourcePolicyBytes,
  resourcePolicyBytes,
  nodePolicyBytes,
  fetchSource = fetch,
}) {
  const policy = validateNodeSourcePolicy(
    sourcePolicyBytes,
    resourcePolicyBytes,
    nodePolicyBytes,
  );
  const originals = new Map();
  const preparationDeadline = Date.now() + 120000;
  for (const source of policy.sources) {
    assert(
      Date.now() < preparationDeadline,
      "Node source preparation deadline exceeded",
    );
    const url = sourceUrl(policy.sourceCommit, source.path);
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error("Node original source response deadline exceeded"));
        },
        Math.min(30000, preparationDeadline - Date.now()),
      );
    });
    try {
      const download = (async () => {
        const response = await fetchSource(url, {
          redirect: "error",
          signal: controller.signal,
          headers: { "Accept-Encoding": "identity" },
        });
        assert.equal(response.status, 200, "Node original source fetch failed");
        assert.equal(
          response.url,
          url,
          "Node original source response URL differs",
        );
        assert(response.body, "Node original source body missing");
        const declared = response.headers.get("content-length");
        assert(
          declared === null ||
            (/^\d+$/.test(declared) && Number(declared) <= source.size),
          "Declared source response exceeds bound",
        );
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          assert(value instanceof Uint8Array, "Invalid source response chunk");
          length += value.length;
          assert(length <= source.size, "Node source response exceeds pin");
          chunks.push(Buffer.from(value));
        }
        const bytes = Buffer.concat(chunks, length);
        verifySourceBytes(bytes, source);
        return bytes;
      })();
      originals.set(source.path, await Promise.race([download, deadline]));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return createNodeSourceBundle({
    sourcePolicyBytes,
    resourcePolicyBytes,
    nodePolicyBytes,
    readSource: (source) => originals.get(source.path),
  });
}

export function validateNodeSourceEvidence({
  sourcePolicyBytes,
  resourcePolicyBytes,
  nodePolicyBytes,
  bundleBytes,
  ...inputs
}) {
  const policy = validateNodeSourceBundle({
    sourcePolicyBytes,
    resourcePolicyBytes,
    nodePolicyBytes,
    bundleBytes,
  });
  const resources = validateNodeResourceEvidence({
    ...inputs,
    policyBytes: resourcePolicyBytes,
    nodePolicyBytes,
  });
  return {
    schemaVersion: 1,
    target: resources.target,
    imageId: resources.imageId,
    scope: resources.scope,
    binary: resources.binary,
    notice: resources.notice,
    sourcePolicySha256: hash(sourcePolicyBytes),
    resourcePolicySha256: hash(resourcePolicyBytes),
    nodePolicySha256: hash(nodePolicyBytes),
    bundleSha256: hash(bundleBytes),
    resourceSha256: resources.resourceSha256,
    sourceCommit: policy.sourceCommit,
    coverage: "selected-source-resource-correspondence",
    selectedSources: policy.sources.length,
    sourceBytes: policy.sources.reduce(
      (total, source) => total + source.size,
      0,
    ),
    residualSections: resources.residualSections.map((section) => ({
      ...section,
      sourceCorrespondences: policy.sources
        .filter((source) => source.section === section.name)
        .map((source) => ({
          path: source.path,
          resourceId: source.resourceId,
          size: source.size,
          sha256: source.sha256,
          gitBlobSha1: source.gitBlobSha1,
          url: sourceUrl(policy.sourceCommit, source.path),
          correspondence: "exact-source-resource-size-sha256",
        })),
    })),
    ncrypto: resources.ncrypto,
    reviewRequired: true,
  };
}

export function verifyNodeSourceReports(
  directory,
  report,
  {
    trustedSourcePolicyBytes = readBoundedNodeFile(
      new URL("./node-resource-sources.json", import.meta.url),
      nodeSourcePolicyLimit,
    ),
    trustedResourcePolicyBytes = readBoundedNodeFile(
      new URL("./node-resources.json", import.meta.url),
      nodeSourceBundleLimit,
    ),
    trustedNodePolicyBytes = readBoundedNodeFile(
      new URL("./node-components.json", import.meta.url),
      nodeSourceBundleLimit,
    ),
  } = {},
) {
  const sourcePolicyBytes = readBoundedNodeFile(
    join(directory, "node-resource-sources.json"),
    nodeSourcePolicyLimit,
  );
  const resourcePolicyBytes = readBoundedNodeFile(
    join(directory, "node-resources.json"),
    nodeSourceBundleLimit,
  );
  const nodePolicyBytes = readBoundedNodeFile(
    join(directory, "node-components.json"),
    nodeSourceBundleLimit,
  );
  const bundleBytes = readBoundedNodeFile(
    join(directory, "node-source-bundle.json"),
    nodeSourceBundleLimit,
  );
  validateNodeSourcePolicy(
    trustedSourcePolicyBytes,
    trustedResourcePolicyBytes,
    trustedNodePolicyBytes,
  );
  for (const [archived, trusted] of [
    [sourcePolicyBytes, trustedSourcePolicyBytes],
    [resourcePolicyBytes, trustedResourcePolicyBytes],
    [nodePolicyBytes, trustedNodePolicyBytes],
  ])
    assert.deepEqual(
      parseNodeResourceJson(archived),
      parseNodeResourceJson(trusted),
      "Archived source policy input differs from trusted checkout",
    );
  validateNodeSourceBundle({
    sourcePolicyBytes,
    resourcePolicyBytes,
    nodePolicyBytes,
    bundleBytes,
  });
  verifyNodeResourceReports(directory, report, {
    trustedPolicyBytes: trustedResourcePolicyBytes,
    trustedNodePolicyBytes,
  });
  const read = (name) =>
    JSON.parse(readFileSync(join(directory, name), "utf8"));
  for (const target of customerTargets)
    for (const [suffix, scope, recorded] of [
      ["", "squashed", report.images[target]],
      [".layers", "all-layers", report.images[target].allLayers],
    ]) {
      const inspection = read(`${target}.image.json`);
      assert.equal(recorded.imageId, inspection.Id);
      assert.equal(recorded.scope, scope);
      if (nodeTargets.includes(target)) {
        const result = validateNodeSourceEvidence({
          target,
          inspection,
          sbom: read(`${target}${suffix}.syft.json`),
          sourcePolicyBytes,
          resourcePolicyBytes,
          nodePolicyBytes,
          bundleBytes,
          resourceBytes: readBoundedNodeFile(
            join(directory, `${target}.node-resources.json`),
            nodeSourceBundleLimit,
          ),
          receipt: parseNodeResourceJson(
            readBoundedNodeFile(
              join(directory, `${target}.resource-receipt.json`),
              nodeSourceBundleLimit,
            ),
          ),
          runId: report.runId,
        });
        assert.deepEqual(
          recorded.nodeResourceSources,
          result,
          "Retained Node source correspondence differs",
        );
      } else
        assert.equal(
          recorded.nodeResourceSources,
          undefined,
          "Unexpected Node source target",
        );
      assert.deepEqual(
        read(`${target}${suffix}.review.json`),
        recorded,
        "Retained source companion review differs",
      );
    }
}
