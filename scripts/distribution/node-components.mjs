// NFR-SEC-010 / AC-MNT-004: binary-bound Node metadata and original source coverage.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { hash, customerTargets, validateRuntimeTooling } from "./evidence.mjs";

export const nodeTargets = ["api", "worker", "operations"];
const sha256 = /^[a-f0-9]{64}$/;
const imageDigest = /^sha256:[a-f0-9]{64}$/;
const runPattern = /^pdaa-distribution-\d+-[a-f0-9]{8}$/;
const maxMetadataBytes = 128 * 1024;
const probeTimeout = 30000;
const hasControl = (text) =>
  [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
export const nodeMetadataCode =
  "process.stdout.write(JSON.stringify({version:process.version,versions:process.versions,arch:process.arch,platform:process.platform,execPath:process.execPath,release:process.release,features:process.features,config:process.config}))";

function keys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}
function utf8(bytes, maximum, label) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum,
    label,
  );
  const text = bytes.toString("utf8");
  assert(
    Buffer.from(text, "utf8").equals(bytes) && !text.includes("\0"),
    label,
  );
  return text;
}
function safePath(path, absolute = false) {
  assert(
    typeof path === "string" && path.length > 0 && path.length < 2048,
    "Invalid Node source path",
  );
  assert(
    !path.includes("\\") &&
      !hasControl(path) &&
      posix.isAbsolute(path) === absolute,
    "Unsafe Node source path",
  );
  assert.equal(posix.normalize(path), path, "Noncanonical Node source path");
  const parts = path.split("/");
  assert(
    !parts.some(
      (part, i) =>
        part === "." ||
        part === ".." ||
        (part === "" &&
          !(absolute && i === 0) &&
          !(!absolute && i === parts.length - 1)),
    ),
    "Unsafe Node path component",
  );
}
function pin(value, label) {
  assert(
    Number.isSafeInteger(value.size) &&
      value.size > 0 &&
      value.size <= 256 * 1024 * 1024,
    label,
  );
  assert(sha256.test(value.sha256), label);
}
const kindFor = (key, value) =>
  key === "node"
    ? "runtime"
    : ["modules", "napi"].includes(key)
      ? "abi"
      : ["cldr", "tz", "unicode"].includes(key)
        ? "data"
        : value === ""
          ? "disabled"
          : "library";

export function validateNodePolicy(bytes) {
  const policy = JSON.parse(
    utf8(bytes, 256 * 1024, "Invalid Node policy bytes"),
  );
  keys(
    policy,
    [
      "schemaVersion",
      "reviewRequired",
      "source",
      "binary",
      "notice",
      "metadata",
      "components",
    ],
    "Invalid Node policy",
  );
  assert.equal(policy.schemaVersion, 1, "Unsupported Node policy schema");
  assert.equal(
    policy.reviewRequired,
    true,
    "Node attribution review remains required",
  );
  keys(
    policy.source,
    ["repository", "commit", "files"],
    "Invalid Node source provenance",
  );
  assert.equal(policy.source.repository, "https://github.com/nodejs/node");
  assert(
    /^[a-f0-9]{40}$/.test(policy.source.commit),
    "Invalid Node source commit",
  );
  assert(
    Array.isArray(policy.source.files) &&
      policy.source.files.length > 0 &&
      policy.source.files.length <= 64,
    "Invalid Node source files",
  );
  const sourcePaths = new Set();
  for (const file of policy.source.files) {
    keys(file, ["path", "size", "sha256", "url"], "Invalid Node source file");
    safePath(file.path);
    pin(file, "Invalid Node source file pin");
    assert(!sourcePaths.has(file.path), "Duplicate Node source file");
    sourcePaths.add(file.path);
    assert.equal(
      file.url,
      `https://raw.githubusercontent.com/nodejs/node/${policy.source.commit}/${file.path}`,
      "Node source URL differs",
    );
  }
  for (const path of [
    "LICENSE",
    "src/node_metadata.cc",
    "src/node_metadata.h",
    "src/node_process_object.cc",
  ])
    assert(sourcePaths.has(path), "Required Node source provenance missing");
  keys(policy.binary, ["path", "size", "sha256"], "Invalid Node binary pin");
  assert.equal(policy.binary.path, "/usr/local/bin/node");
  pin(policy.binary, "Invalid Node binary pin");
  keys(
    policy.notice,
    ["size", "sha256", "paths", "preamble", "sections"],
    "Invalid Node notice policy",
  );
  pin(policy.notice, "Invalid Node notice pin");
  assert(
    policy.notice.size <= 2 * 1024 * 1024,
    "Node notice exceeds size limit",
  );
  keys(policy.notice.paths, nodeTargets, "Node notice targets differ");
  for (const path of Object.values(policy.notice.paths)) safePath(path, true);
  const original = policy.source.files.find((file) => file.path === "LICENSE");
  assert.equal(
    original.sha256,
    policy.notice.sha256,
    "Node notice/source hash differs",
  );
  assert.equal(
    original.size,
    policy.notice.size,
    "Node notice/source size differs",
  );
  keys(
    policy.metadata,
    [
      "version",
      "versions",
      "arch",
      "platform",
      "execPath",
      "release",
      "features",
      "config",
    ],
    "Invalid Node metadata policy",
  );
  assert.equal(policy.metadata.platform, "linux");
  assert.equal(policy.metadata.arch, "x64");
  assert.equal(policy.metadata.execPath, policy.binary.path);
  assert(
    /^\d+\.\d+\.\d+$/.test(policy.metadata.versions?.node),
    "Invalid pinned Node version",
  );
  assert.equal(policy.metadata.version, "v" + policy.metadata.versions.node);
  assert.equal(policy.metadata.release?.name, "node");
  assert.equal(
    policy.metadata.release.sourceUrl,
    `https://nodejs.org/download/release/${policy.metadata.version}/node-${policy.metadata.version}.tar.gz`,
  );
  assert.equal(
    policy.metadata.release.headersUrl,
    `https://nodejs.org/download/release/${policy.metadata.version}/node-${policy.metadata.version}-headers.tar.gz`,
  );
  assert(
    policy.metadata.features && policy.metadata.config?.variables,
    "Node feature/config policy missing",
  );
  assert.equal(
    policy.metadata.features.quic,
    false,
    "Current Node QUIC must remain disabled",
  );
  assert.equal(policy.metadata.config.variables.node_use_quic, false);
  assert.equal(policy.metadata.versions.nghttp3, "");
  assert.equal(policy.metadata.versions.ngtcp2, "");
  assert(
    Array.isArray(policy.notice.sections) &&
      policy.notice.sections.length > 0 &&
      policy.notice.sections.length <= 128,
    "Invalid Node notice sections",
  );
  const sectionNames = new Set();
  const span = (value) => {
    assert(
      Number.isSafeInteger(value.start) &&
        Number.isSafeInteger(value.end) &&
        value.start >= 0 &&
        value.end > value.start &&
        value.end <= policy.notice.size,
      "Invalid original Node byte span",
    );
    assert(sha256.test(value.sha256), "Invalid Node section hash");
  };
  keys(
    policy.notice.preamble,
    ["start", "end", "sha256"],
    "Invalid Node preamble",
  );
  span(policy.notice.preamble);
  assert.equal(policy.notice.preamble.start, 0);
  let end = policy.notice.preamble.end;
  for (const section of policy.notice.sections) {
    keys(
      section,
      ["name", "sourcePath", "start", "end", "sha256"],
      "Invalid Node source section",
    );
    assert(
      typeof section.name === "string" &&
        section.name.length > 0 &&
        section.name.length < 128 &&
        !hasControl(section.name),
      "Invalid Node section name",
    );
    assert(!sectionNames.has(section.name), "Duplicate Node source section");
    sectionNames.add(section.name);
    safePath(section.sourcePath);
    span(section);
    assert.equal(section.start, end, "Node source coverage gap or overlap");
    end = section.end;
  }
  assert.equal(
    end,
    policy.notice.size,
    "Node original notice coverage incomplete",
  );
  assert(
    Array.isArray(policy.components) &&
      policy.components.length > 0 &&
      policy.components.length <= 64,
    "Invalid Node component policy",
  );
  const componentKeys = new Set();
  for (const component of policy.components) {
    keys(
      component,
      ["key", "kind", "sourcePath", "noticeSection"],
      "Invalid Node component mapping",
    );
    assert(
      /^[a-z][a-z0-9]*$/.test(component.key) &&
        !componentKeys.has(component.key),
      "Duplicate or invalid Node component key",
    );
    componentKeys.add(component.key);
    assert(
      Object.hasOwn(policy.metadata.versions, component.key),
      "Node component lacks metadata",
    );
    const value = policy.metadata.versions[component.key];
    assert(
      typeof value === "string" && value.length < 128,
      "Invalid Node component version",
    );
    assert.equal(
      component.kind,
      kindFor(component.key, value),
      "Node component classification differs",
    );
    if (component.kind === "disabled")
      assert(
        ["nghttp3", "ngtcp2"].includes(component.key),
        "Unknown disabled Node component",
      );
    safePath(component.sourcePath);
    assert(
      component.noticeSection === null ||
        sectionNames.has(component.noticeSection),
      "Unknown Node notice section mapping",
    );
    if (component.noticeSection !== null) {
      const section = policy.notice.sections.find(
        (s) => s.name === component.noticeSection,
      );
      assert.equal(
        component.sourcePath,
        section.sourcePath,
        "Node component/source section mapping differs",
      );
    }
    if (
      component.kind === "disabled" ||
      (component.kind === "library" &&
        !["nbytes", "ncrypto", "sqlite"].includes(component.key))
    )
      assert.notEqual(
        component.noticeSection,
        null,
        "Reviewed Node component notice mapping missing",
      );
    if (["runtime", "abi", "data"].includes(component.kind))
      assert.equal(
        component.noticeSection,
        null,
        "Node runtime/ABI/data must not borrow a component notice",
      );
    if (["nbytes", "ncrypto", "sqlite"].includes(component.key))
      assert.equal(
        component.noticeSection,
        null,
        "Unrepresented Node source attribution must remain explicit",
      );
  }
  assert.deepEqual(
    [...componentKeys].sort(),
    Object.keys(policy.metadata.versions).sort(),
    "Node metadata coverage incomplete",
  );
  for (const key of [
    "node",
    "modules",
    "napi",
    "cldr",
    "tz",
    "unicode",
    "nbytes",
    "ncrypto",
    "sqlite",
    "nghttp3",
    "ngtcp2",
  ])
    assert(componentKeys.has(key), "Required Node metadata key missing");
  return policy;
}

function fileIdentity(file, layers) {
  assert(
    file && typeof file.id === "string" && file.id.length > 0,
    "Node file identity missing",
  );
  safePath(file.location?.path, true);
  assert(
    layers.has(file.location.layerID),
    "Node file supplying layer differs",
  );
  assert.equal(
    file.metadata?.type,
    "RegularFile",
    "Node evidence requires a regular file",
  );
  const digests = file.digests?.filter((d) => d.algorithm === "sha256");
  assert.equal(digests?.length, 1, "Node file needs one SHA256");
  const identity = {
    fileId: file.id,
    path: file.location.path,
    layerID: file.location.layerID,
    size: file.metadata.size,
    sha256: digests[0].value,
  };
  pin(identity, "Invalid Node file metadata");
  return identity;
}

export function validateNodeImage({ target, inspection, sbom, policyBytes }) {
  assert(nodeTargets.includes(target), "Unknown Node image target");
  const policy = validateNodePolicy(policyBytes);
  assert(imageDigest.test(inspection.Id), "Invalid Node image identity");
  assert.equal(inspection.Os, "linux");
  assert.equal(inspection.Architecture, "amd64");
  const scope = sbom.descriptor?.configuration?.search?.scope;
  assert(
    ["squashed", "all-layers"].includes(scope),
    "Invalid Node evidence scope",
  );
  assert.equal(sbom.source?.type, "image");
  const source = sbom.source.metadata;
  assert.equal(source.userInput, inspection.Id, "Node scanner image differs");
  const configBytes = Buffer.from(source.config ?? "", "base64");
  assert.equal(
    "sha256:" + hash(configBytes),
    source.imageID,
    "Node scanner config hash differs",
  );
  const config = JSON.parse(
    utf8(configBytes, 1024 * 1024, "Invalid Node image config"),
  );
  assert.equal(config.os, inspection.Os);
  assert.equal(config.architecture, inspection.Architecture);
  assert.deepEqual(
    config.rootfs?.diff_ids,
    inspection.RootFS?.Layers,
    "Node image layers differ",
  );
  const layers = new Set(inspection.RootFS.Layers);
  assert(
    layers.size > 0 &&
      layers.size === inspection.RootFS.Layers.length &&
      [...layers].every((l) => imageDigest.test(l)),
    "Invalid Node image layers",
  );
  assert(
    Array.isArray(sbom.files) && Array.isArray(sbom.artifacts),
    "Node native evidence missing",
  );
  const nodes = sbom.artifacts.filter(
    (p) => p.type === "binary" && p.name === "node",
  );
  assert.equal(nodes.length, 1, "Expected sole classified Node binary");
  const node = nodes[0];
  assert(
    typeof node.id === "string" &&
      node.id.length > 0 &&
      sbom.artifacts.filter((p) => p.id === node.id).length === 1,
    "Invalid Node package ID",
  );
  assert.equal(
    node.version,
    policy.metadata.versions.node,
    "Node binary version differs",
  );
  assert.equal(node.locations?.length, 1, "Expected sole Node binary location");
  assert.equal(
    node.locations[0].path,
    policy.binary.path,
    "Node executable path differs",
  );
  const binaries = sbom.files.filter(
    (f) =>
      f.location?.path === policy.binary.path ||
      (f.metadata?.type === "RegularFile" &&
        (["node", "nodejs"].includes(posix.basename(f.location?.path ?? "")) ||
          f.digests?.some(
            (d) => d.algorithm === "sha256" && d.value === policy.binary.sha256,
          ))),
  );
  assert.equal(
    binaries.length,
    1,
    "Missing or additional Node executable copy",
  );
  const binary = fileIdentity(binaries[0], layers);
  assert.equal(binary.path, policy.binary.path);
  assert.equal(binary.sha256, policy.binary.sha256, "Node binary hash differs");
  assert.equal(binary.size, policy.binary.size, "Node binary size differs");
  assert.equal(
    node.locations[0].layerID,
    binary.layerID,
    "Node package/file layer differs",
  );
  assert.equal(
    sbom.files.filter((f) => f.id === binary.fileId).length,
    1,
    "Ambiguous Node binary file ID",
  );
  const originals = sbom.files.filter(
    (f) => f.location?.path === policy.notice.paths[target],
  );
  assert.equal(
    originals.length,
    1,
    "Missing or duplicate original Node notice",
  );
  const notice = fileIdentity(originals[0], layers);
  assert.equal(
    sbom.files.filter((f) => f.id === notice.fileId).length,
    1,
    "Ambiguous Node notice file ID",
  );
  assert.equal(
    notice.sha256,
    policy.notice.sha256,
    "Node notice digest differs",
  );
  assert.equal(notice.size, policy.notice.size, "Node notice size differs");
  const content = originals[0].contents;
  assert(
    typeof content === "string" &&
      content.length > 0 &&
      content.length <= 3 * 1024 * 1024,
    "Original Node notice content missing",
  );
  const bytes = Buffer.from(content, "base64");
  assert.equal(
    bytes.toString("base64"),
    content,
    "Invalid original Node notice encoding",
  );
  const noticeText = utf8(
    bytes,
    2 * 1024 * 1024,
    "Invalid original Node notice text",
  );
  assert.equal(bytes.length, notice.size);
  assert.equal(hash(bytes), notice.sha256, "Original Node notice bytes differ");
  for (const section of [policy.notice.preamble, ...policy.notice.sections])
    assert.equal(
      hash(bytes.subarray(section.start, section.end)),
      section.sha256,
      "Original Node source section differs",
    );
  const headings = [
    ...noticeText.matchAll(
      /^- (.+), located at (.+), is licensed as follows:$/gm,
    ),
  ];
  assert.equal(
    headings.length,
    policy.notice.sections.length,
    "Original Node section inventory differs",
  );
  for (const [index, heading] of headings.entries()) {
    const section = policy.notice.sections[index];
    assert.equal(
      section.name,
      heading[1],
      "Node section name differs from original",
    );
    assert.equal(
      section.sourcePath,
      heading[2],
      "Node section source path differs from original",
    );
    assert.equal(
      section.start,
      Buffer.byteLength(noticeText.slice(0, heading.index)),
      "Node section boundary differs from original",
    );
  }
  return { policy, scope, binary: { packageId: node.id, ...binary }, notice };
}

export function nodeProbeArgs(target, imageId, runId) {
  assert(
    nodeTargets.includes(target) &&
      imageDigest.test(imageId) &&
      runPattern.test(runId),
    "Invalid Node probe identity",
  );
  return [
    "run",
    "--rm",
    "--name",
    `${runId}-node-${target}`,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "32",
    "--memory",
    "128m",
    "--cpus",
    "1",
    "--user",
    "65534:65534",
    "--workdir",
    "/",
    "--env",
    "NODE_OPTIONS=",
    "--env",
    "NODE_PATH=",
    "--entrypoint",
    "/usr/local/bin/node",
    imageId,
    "--input-type=commonjs",
    "-e",
    nodeMetadataCode,
  ];
}
function validateMetadata(bytes, policy) {
  const text = utf8(bytes, maxMetadataBytes, "Invalid Node metadata output");
  const metadata = JSON.parse(text);
  assert.equal(
    JSON.stringify(metadata),
    text,
    "Node metadata must retain exact direct probe JSON",
  );
  assert.deepEqual(
    metadata,
    policy.metadata,
    "Node binary metadata differs from reviewed policy",
  );
  return metadata;
}
export function captureNodeMetadata({
  target,
  inspection,
  sbom,
  policyBytes,
  runId,
  env,
  execute = spawnSync,
}) {
  const { policy, binary } = validateNodeImage({
    target,
    inspection,
    sbom,
    policyBytes,
  });
  const args = nodeProbeArgs(target, inspection.Id, runId);
  const result = execute("docker", args, {
    env,
    timeout: probeTimeout,
    maxBuffer: maxMetadataBytes,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stderr?.length) {
    // The uniquely named ephemeral probe belongs only to this run/target.
    execute("docker", ["rm", "-f", `${runId}-node-${target}`], {
      env,
      timeout: 10000,
      maxBuffer: 4096,
      windowsHide: true,
    });
    throw new Error("Bounded Node metadata probe failed");
  }
  validateMetadata(result.stdout, policy);
  const receipt = {
    schemaVersion: 1,
    target,
    runId,
    imageId: inspection.Id,
    binarySha256: binary.sha256,
    policySha256: hash(policyBytes),
    command: { executable: "docker", args },
    stdout: {
      file: `${target}.node-metadata.json`,
      size: result.stdout.length,
      sha256: hash(result.stdout),
    },
    exitCode: 0,
    stderrBytes: 0,
    reviewRequired: true,
  };
  return { metadataBytes: result.stdout, receipt };
}

export function validateNodeComponentEvidence({
  target,
  inspection,
  sbom,
  policyBytes,
  metadataBytes,
  receipt,
  runId,
}) {
  const { policy, scope, binary, notice } = validateNodeImage({
    target,
    inspection,
    sbom,
    policyBytes,
  });
  validateMetadata(metadataBytes, policy);
  const expectedReceipt = {
    schemaVersion: 1,
    target,
    runId,
    imageId: inspection.Id,
    binarySha256: binary.sha256,
    policySha256: hash(policyBytes),
    command: {
      executable: "docker",
      args: nodeProbeArgs(target, inspection.Id, runId),
    },
    stdout: {
      file: `${target}.node-metadata.json`,
      size: metadataBytes.length,
      sha256: hash(metadataBytes),
    },
    exitCode: 0,
    stderrBytes: 0,
    reviewRequired: true,
  };
  assert.deepEqual(receipt, expectedReceipt, "Node probe receipt differs");
  const components = policy.components.map((component) => ({
    key: hash(
      JSON.stringify([
        target,
        inspection.Id,
        scope,
        binary.fileId,
        binary.layerID,
        component.key,
      ]),
    ),
    identity: `node-${component.kind}:${component.key}@${policy.metadata.versions[component.key]}`,
    metadataKey: component.key,
    kind: component.kind,
    version: policy.metadata.versions[component.key],
    sourcePath: component.sourcePath,
    noticeSection: component.noticeSection,
    attribution:
      component.kind === "disabled"
        ? "original-source-section-feature-disabled"
        : component.noticeSection
          ? "original-source-section"
          : component.kind === "library"
            ? "unrepresented-in-root-notice"
            : component.kind === "runtime"
              ? "original-node-preamble"
              : component.kind === "data"
                ? "unresolved-data-attribution"
                : "runtime-abi-metadata",
    reviewRequired: true,
  }));
  const usedSections = new Set(policy.components.map((c) => c.noticeSection));
  return {
    schemaVersion: 1,
    target,
    imageId: inspection.Id,
    scope,
    policySha256: hash(policyBytes),
    sourceCommit: policy.source.commit,
    binary,
    notice,
    preamble: policy.notice.preamble,
    metadataSha256: hash(metadataBytes),
    components,
    sourceSections: policy.notice.sections.map((section) => ({
      ...section,
      membership: usedSections.has(section.name)
        ? "metadata-key-recorded"
        : "unresolved-source-only",
      reviewRequired: true,
    })),
    unrepresentedComponents: components
      .filter((c) => c.attribution === "unrepresented-in-root-notice")
      .map((c) => c.metadataKey),
    reviewRequired: true,
  };
}

export function verifyNodeComponentReports(directory, report) {
  assert(runPattern.test(report.runId), "Invalid Node report run ID");
  const read = (name) =>
    JSON.parse(readFileSync(join(directory, name), "utf8"));
  const policyBytes = readFileSync(join(directory, "node-components.json"));
  const policy = validateNodePolicy(policyBytes);
  const runtimePolicy = read("runtime-policy.json");
  assert.equal(
    runtimePolicy.nodeVersion,
    policy.metadata.versions.node,
    "Node runtime policy version differs",
  );
  assert.equal(
    runtimePolicy.nodeNoticeSha256,
    policy.notice.sha256,
    "Node runtime notice policy differs",
  );
  assert.deepEqual(
    runtimePolicy.nodeNoticePaths,
    policy.notice.paths,
    "Node runtime notice paths differ",
  );
  for (const target of customerTargets) {
    const inspection = read(`${target}.image.json`);
    assert.equal(
      inspection.Id,
      report.images[target].imageId,
      "Recorded Node/runtime image differs",
    );
    for (const [suffix, scope, recorded] of [
      ["", "squashed", report.images[target]],
      [".layers", "all-layers", report.images[target].allLayers],
    ]) {
      const sbom = read(`${target}${suffix}.syft.json`);
      assert.equal(
        sbom.descriptor?.configuration?.search?.scope,
        scope,
        "Retained Node/runtime scope differs",
      );
      assert.equal(recorded.scope, scope);
      assert.equal(recorded.imageId, inspection.Id);
      validateRuntimeTooling(target, sbom, runtimePolicy);
      if (nodeTargets.includes(target)) {
        const result = validateNodeComponentEvidence({
          target,
          inspection,
          sbom,
          policyBytes,
          metadataBytes: readFileSync(
            join(directory, `${target}.node-metadata.json`),
          ),
          receipt: read(`${target}.node-receipt.json`),
          runId: report.runId,
        });
        assert.deepEqual(
          recorded.nodeComponents,
          result,
          "Recorded Node component evidence differs",
        );
      } else
        assert.equal(
          recorded.nodeComponents,
          undefined,
          "Unexpected Node component target",
        );
      assert.deepEqual(
        read(`${target}${suffix}.review.json`),
        recorded,
        "Retained Node/runtime review differs",
      );
    }
  }
}
