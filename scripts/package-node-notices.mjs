// AC-MNT-004: build-only bounded source fetch and offline original-byte packaging.
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  fetchNodeSupplementSources,
  materializeNodeSupplements,
  validateNodeSupplementPolicy,
  readBoundedNodeFile,
} from "./distribution/node-supplemental.mjs";
import { validateNodePolicy } from "./distribution/node-components.mjs";
const [mode, sourceRoot, outputRoot, ...extra] = process.argv.slice(2);
assert(
  extra.length === 0 &&
    sourceRoot &&
    (mode === "fetch" ? !outputRoot : mode === "package" && outputRoot),
  "Expected fetch SOURCE_DIR or package SOURCE_DIR OUTPUT_DIR",
);
const policyBytes = readBoundedNodeFile(
  new URL("./distribution/node-supplemental.json", import.meta.url),
  256 * 1024,
);
const nodePolicyBytes = readBoundedNodeFile(
  new URL("./distribution/node-components.json", import.meta.url),
  256 * 1024,
);
const policy = validateNodeSupplementPolicy(policyBytes, nodePolicyBytes);
const node = validateNodePolicy(nodePolicyBytes);
function writeNew(root, files) {
  mkdirSync(root);
  for (const [path, bytes] of files) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, bytes, { flag: "wx", mode: 0o644 });
  }
}
if (mode === "fetch")
  writeNew(
    sourceRoot,
    await fetchNodeSupplementSources(policyBytes, nodePolicyBytes),
  );
else {
  assert(
    lstatSync(sourceRoot).isDirectory() &&
      !lstatSync(sourceRoot).isSymbolicLink(),
    "Original source directory must be regular",
  );
  const sources = new Map(
    policy.source.files.map((f) => {
      const path = join(sourceRoot, f.path);
      return [f.path, readBoundedNodeFile(path, 16 * 1024 * 1024, f.size)];
    }),
  );
  const output = materializeNodeSupplements({
    policyBytes,
    nodePolicyBytes,
    sources,
    binaryBytes: readBoundedNodeFile(
      "/usr/local/bin/node",
      256 * 1024 * 1024,
      policy.binary.size,
    ),
    originalNoticeBytes: readBoundedNodeFile(
      "/usr/local/LICENSE",
      2 * 1024 * 1024,
      node.notice.size,
    ),
  });
  writeNew(outputRoot, output);
  console.log(
    `Packaged ${output.size - 1} original Node supplemental notices and their index; review remains required.`,
  );
}
