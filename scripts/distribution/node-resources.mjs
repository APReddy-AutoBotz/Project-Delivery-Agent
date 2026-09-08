// NFR-SEC-010 / AC-MNT-004: observed binary resources, not source/license verdicts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hash, customerTargets } from "./evidence.mjs";
import {
  nodeTargets,
  nodeProbeArgs,
  validateNodePolicy,
  validateNodeImage,
} from "./node-components.mjs";

const maximumOutput = 256 * 1024;
const descriptorKeys = ["enumerable", "configurable", "writable"];
const sha256 = /^[a-f0-9]{64}$/;
const candidates = [
  ["Punycode.js", "lib/punycode.js", ["punycode"]],
  ["caja", "lib/internal/freeze_intrinsics.js", ["internal/freeze_intrinsics"]],
  ["rimraf", "lib/internal/fs/rimraf.js", ["internal/fs/rimraf"]],
  [
    "node-fs-extra",
    "lib/internal/fs/cp",
    ["internal/fs/cp/cp", "internal/fs/cp/cp-sync"],
  ],
  [
    "on-exit-leak-free",
    "lib/internal/process/finalization",
    ["internal/process/finalization"],
  ],
  [
    "sonic-boom",
    "lib/internal/streams/fast-utf8-stream.js",
    ["internal/streams/fast-utf8-stream"],
  ],
];

// The same function is serialized into the fixed probe and exercised with hostile
// descriptors in tests. It never reads a property value through an accessor.
export function describeNodeResources(native, digest) {
  const check = (ok) => {
    if (!ok) throw new Error("Invalid bounded Node resource table");
  };
  check(
    native !== null && typeof native === "object" && !Array.isArray(native),
  );
  const names = Reflect.ownKeys(native);
  check(names.length > 0 && names.length <= 1024);
  check(names.every((name) => typeof name === "string"));
  let total = 0;
  return names.sort().map((id) => {
    check(/^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,255}$/.test(id));
    check(id.split("/").every((part) => part && part !== "." && part !== ".."));
    const property = Object.getOwnPropertyDescriptor(native, id);
    check(
      property &&
        Object.hasOwn(property, "value") &&
        !Object.hasOwn(property, "get") &&
        !Object.hasOwn(property, "set"),
    );
    const descriptor = {
      enumerable: property.enumerable,
      configurable: property.configurable,
      writable: property.writable,
    };
    check(
      Object.values(descriptor).every((value) => typeof value === "boolean"),
    );
    const value = property.value;
    if (typeof value === "undefined") {
      check(id === "configs");
      return { id, kind: "undefined", descriptor };
    }
    check(typeof value === "string");
    const size = Buffer.byteLength(value, "utf8");
    check(size > 0 && size <= 8 * 1024 * 1024);
    total += size;
    check(total <= 16 * 1024 * 1024);
    const bytes = Buffer.from(value, "utf8");
    check(bytes.toString("utf8") === value);
    return { id, kind: "utf8", descriptor, size, sha256: digest(value) };
  });
}

export const nodeResourceCode = [
  'const crypto=require("node:crypto");',
  `const describe=${describeNodeResources.toString().replaceAll("\r\n", "\n")};`,
  'const entries=describe(process.binding("natives"),(value)=>crypto.createHash("sha256").update(value,"utf8").digest("hex"));',
  "const output=JSON.stringify({schemaVersion:1,version:process.version,arch:process.arch,platform:process.platform,execPath:process.execPath,entries});",
  'if(Buffer.byteLength(output)>262144)throw new Error("Node resource output limit");',
  "process.stdout.write(output);",
].join("\n");

function keys(value, expected, message) {
  assert(value && typeof value === "object" && !Array.isArray(value), message);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), message);
}

// Remove only JSON syntax whitespace. Comparing tokens with JSON.stringify also
// rejects duplicate keys and ambiguous numeric/escape spellings before trust checks.
export function parseNodeResourceJson(bytes, maximum = maximumOutput) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum,
    "Node resource JSON byte limit",
  );
  const text = bytes.toString("utf8");
  assert(
    Buffer.from(text).equals(bytes) && !text.includes("\0"),
    "Invalid Node resource UTF-8",
  );
  const value = JSON.parse(text);
  let compact = "",
    quoted = false,
    escaped = false;
  for (const character of text) {
    if (quoted) {
      compact += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      compact += character;
    } else if (!/[ \t\r\n]/.test(character)) compact += character;
  }
  assert.equal(
    compact,
    JSON.stringify(value),
    "Noncanonical or duplicate Node resource JSON tokens",
  );
  return value;
}

function validateSnapshot(snapshot, node) {
  keys(
    snapshot,
    ["schemaVersion", "version", "arch", "platform", "execPath", "entries"],
    "Resource snapshot schema differs",
  );
  assert.equal(snapshot.schemaVersion, 1);
  for (const key of ["version", "arch", "platform", "execPath"])
    assert.equal(
      snapshot[key],
      node.metadata[key],
      "Resource runtime identity differs",
    );
  assert(
    Array.isArray(snapshot.entries) &&
      snapshot.entries.length > 0 &&
      snapshot.entries.length <= 1024,
    "Resource entry count differs",
  );
  const ids = snapshot.entries.map((entry) => entry.id);
  assert(
    ids.every(
      (id) =>
        typeof id === "string" &&
        /^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,255}$/.test(id) &&
        id.split("/").every((part) => part && part !== "." && part !== ".."),
    ),
    "Invalid resource identifier",
  );
  assert.deepEqual(
    ids,
    [...new Set(ids)].sort(),
    "Resource identifiers missing, duplicated or unordered",
  );
  let total = 0;
  for (const entry of snapshot.entries) {
    keys(
      entry,
      entry.kind === "utf8"
        ? ["id", "kind", "descriptor", "size", "sha256"]
        : ["id", "kind", "descriptor"],
      "Resource entry schema differs",
    );
    keys(entry.descriptor, descriptorKeys, "Resource descriptor differs");
    assert(
      Object.values(entry.descriptor).every((v) => typeof v === "boolean"),
      "Resource descriptor must contain booleans",
    );
    if (entry.kind === "utf8") {
      assert(
        Number.isSafeInteger(entry.size) &&
          entry.size > 0 &&
          entry.size <= 8 * 1024 * 1024 &&
          sha256.test(entry.sha256),
        "Invalid resource digest/size",
      );
      total += entry.size;
      assert(total <= 16 * 1024 * 1024, "Resource aggregate byte limit");
    } else
      assert(
        entry.kind === "undefined" && entry.id === "configs",
        "Unexpected non-string resource observation",
      );
  }
  assert.equal(
    snapshot.entries.filter((e) => e.kind === "undefined").length,
    1,
    "Undefined configs observation must remain explicit",
  );
  return snapshot;
}

export function validateNodeResourcePolicy(policyBytes, nodePolicyBytes) {
  const policy = parseNodeResourceJson(policyBytes);
  const node = validateNodePolicy(nodePolicyBytes);
  keys(
    policy,
    [
      "schemaVersion",
      "reviewRequired",
      "binary",
      "rootNoticeSha256",
      "sourceCommit",
      "snapshot",
    ],
    "Resource policy schema differs",
  );
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.reviewRequired, true, "Resource review cannot be waived");
  assert.deepEqual(policy.binary, node.binary, "Resource binary pin differs");
  assert.equal(
    policy.rootNoticeSha256,
    node.notice.sha256,
    "Resource root notice differs",
  );
  assert.equal(
    policy.sourceCommit,
    node.source.commit,
    "Resource source commit differs",
  );
  validateSnapshot(policy.snapshot, node);
  const used = new Set(node.components.map((c) => c.noticeSection));
  for (const [name, path, ids] of candidates) {
    const section = node.notice.sections.find((s) => s.name === name);
    assert(
      section && section.sourcePath === path && !used.has(name),
      "Residual notice candidate differs",
    );
    assert(
      ids.every((id) =>
        policy.snapshot.entries.some((e) => e.id === id && e.kind === "utf8"),
      ),
      "Reviewed candidate resource missing",
    );
  }
  const ncrypto = node.components.find((c) => c.key === "ncrypto");
  assert(
    ncrypto?.noticeSection === null && ncrypto.sourcePath === "deps/ncrypto",
    "ncrypto unresolved attribution differs",
  );
  return { policy, node };
}

export function nodeResourceArgs(target, imageId, runId) {
  const args = nodeProbeArgs(target, imageId, runId);
  args[args.indexOf("--name") + 1] = `${runId}-resources-${target}`;
  args[args.length - 1] = nodeResourceCode;
  return args;
}

function validateRaw(bytes, policy, node) {
  const snapshot = parseNodeResourceJson(bytes);
  assert.equal(
    bytes.toString("utf8"),
    JSON.stringify(snapshot),
    "Resource output must retain exact direct JSON",
  );
  validateSnapshot(snapshot, node);
  assert.deepEqual(
    snapshot,
    policy.snapshot,
    "Observed resources differ from reviewed binary inventory",
  );
  return snapshot;
}

function resourceReceipt(
  target,
  imageId,
  runId,
  binary,
  policyBytes,
  nodePolicyBytes,
  bytes,
) {
  return {
    schemaVersion: 1,
    target,
    runId,
    imageId,
    binarySha256: binary.sha256,
    policySha256: hash(policyBytes),
    nodePolicySha256: hash(nodePolicyBytes),
    command: {
      executable: "docker",
      args: nodeResourceArgs(target, imageId, runId),
    },
    stdout: {
      file: `${target}.node-resources.json`,
      size: bytes.length,
      sha256: hash(bytes),
    },
    exitCode: 0,
    stderrBytes: 0,
    reviewRequired: true,
  };
}

export function captureNodeResources({
  target,
  inspection,
  sbom,
  policyBytes,
  nodePolicyBytes,
  runId,
  env,
  execute = spawnSync,
}) {
  const { policy, node } = validateNodeResourcePolicy(
    policyBytes,
    nodePolicyBytes,
  );
  const { binary } = validateNodeImage({
    target,
    inspection,
    sbom,
    policyBytes: nodePolicyBytes,
  });
  const args = nodeResourceArgs(target, inspection.Id, runId);
  const result = execute("docker", args, {
    env,
    timeout: 30000,
    maxBuffer: maximumOutput,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stderr?.length) {
    execute("docker", ["rm", "-f", `${runId}-resources-${target}`], {
      env,
      timeout: 10000,
      maxBuffer: 4096,
      windowsHide: true,
    });
    throw new Error("Bounded Node resource probe failed");
  }
  validateRaw(result.stdout, policy, node);
  return {
    resourceBytes: result.stdout,
    receipt: resourceReceipt(
      target,
      inspection.Id,
      runId,
      binary,
      policyBytes,
      nodePolicyBytes,
      result.stdout,
    ),
  };
}

export function validateNodeResourceEvidence({
  target,
  inspection,
  sbom,
  policyBytes,
  nodePolicyBytes,
  resourceBytes,
  receipt,
  runId,
}) {
  const { policy, node } = validateNodeResourcePolicy(
    policyBytes,
    nodePolicyBytes,
  );
  const { scope, binary, notice } = validateNodeImage({
    target,
    inspection,
    sbom,
    policyBytes: nodePolicyBytes,
  });
  const snapshot = validateRaw(resourceBytes, policy, node);
  assert.deepEqual(
    receipt,
    resourceReceipt(
      target,
      inspection.Id,
      runId,
      binary,
      policyBytes,
      nodePolicyBytes,
      resourceBytes,
    ),
    "Node resource receipt differs",
  );
  const used = new Set(node.components.map((c) => c.noticeSection));
  const residualSections = node.notice.sections
    .filter((s) => !used.has(s.name))
    .map((section) => {
      const ids = candidates.find(([name]) => name === section.name)?.[2] ?? [];
      return {
        ...section,
        membership: "unresolved-source-only",
        correspondence: ids.length
          ? "notice-path-name-candidate"
          : "no-resource-mapping-established",
        resourceCandidates: ids.map((id) =>
          snapshot.entries.find((entry) => entry.id === id),
        ),
        reviewRequired: true,
      };
    });
  return {
    schemaVersion: 1,
    target,
    imageId: inspection.Id,
    scope,
    binary,
    notice,
    policySha256: hash(policyBytes),
    nodePolicySha256: hash(nodePolicyBytes),
    resourceSha256: hash(resourceBytes),
    sourceCommit: policy.sourceCommit,
    observedEntries: snapshot.entries.length,
    stringResources: snapshot.entries.filter((e) => e.kind === "utf8").length,
    utf8Bytes: snapshot.entries.reduce((n, e) => n + (e.size ?? 0), 0),
    nonStringEntries: snapshot.entries.filter((e) => e.kind !== "utf8"),
    residualSections,
    ncrypto: {
      version: node.metadata.versions.ncrypto,
      sourcePath: "deps/ncrypto",
      rootNotice: "unrepresented",
      componentNotice: "unresolved",
      reviewRequired: true,
    },
    coverage: "observed-native-resource-table",
    reviewRequired: true,
  };
}

export function verifyNodeResourceReports(
  directory,
  report,
  {
    trustedPolicyBytes = readFileSync(
      new URL("./node-resources.json", import.meta.url),
    ),
    trustedNodePolicyBytes = readFileSync(
      new URL("./node-components.json", import.meta.url),
    ),
  } = {},
) {
  const policyBytes = readFileSync(join(directory, "node-resources.json"));
  const nodePolicyBytes = readFileSync(join(directory, "node-components.json"));
  validateNodeResourcePolicy(trustedPolicyBytes, trustedNodePolicyBytes);
  assert.deepEqual(
    parseNodeResourceJson(policyBytes),
    parseNodeResourceJson(trustedPolicyBytes),
    "Archived resource policy differs from trusted checkout",
  );
  assert.deepEqual(
    parseNodeResourceJson(nodePolicyBytes),
    parseNodeResourceJson(trustedNodePolicyBytes),
    "Archived Node policy differs from trusted checkout",
  );
  const read = (name) =>
    JSON.parse(readFileSync(join(directory, name), "utf8"));
  for (const target of customerTargets)
    for (const [suffix, scope, recorded] of [
      ["", "squashed", report.images[target]],
      [".layers", "all-layers", report.images[target].allLayers],
    ]) {
      const inspection = read(`${target}.image.json`),
        sbom = read(`${target}${suffix}.syft.json`);
      assert.equal(recorded.imageId, inspection.Id);
      assert.equal(recorded.scope, scope);
      assert.equal(sbom.descriptor?.configuration?.search?.scope, scope);
      if (nodeTargets.includes(target)) {
        const result = validateNodeResourceEvidence({
          target,
          inspection,
          sbom,
          policyBytes,
          nodePolicyBytes,
          resourceBytes: readFileSync(
            join(directory, `${target}.node-resources.json`),
          ),
          receipt: parseNodeResourceJson(
            readFileSync(join(directory, `${target}.resource-receipt.json`)),
          ),
          runId: report.runId,
        });
        assert.deepEqual(
          recorded.nodeResources,
          result,
          "Retained Node resource review differs",
        );
      } else
        assert.equal(
          recorded.nodeResources,
          undefined,
          "Unexpected Node resource target",
        );
      assert.deepEqual(
        read(`${target}${suffix}.review.json`),
        recorded,
        "Retained resource companion review differs",
      );
    }
}
