// NFR-SEC-010 / AC-MNT-004: prepare verified originals separately from image scanning.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBoundedNodeFile } from "./distribution/node-supplemental.mjs";
import {
  createNodeSourceBundle,
  fetchNodeSourceBundle,
  validateNodeSourceBundle,
  nodeSourcePolicyLimit,
  nodeSourceBundleLimit,
} from "./distribution/node-resource-sources.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts/node-source-bundle.json");
const temporary = output + ".tmp";
try {
  // A failed preparation must not leave an older bundle available to collection.
  rmSync(output, { force: true });
  rmSync(temporary, { force: true });
  const args = process.argv.slice(2);
  assert(
    args.length === 0 || (args.length === 2 && args[0] === "--source-dir"),
    "Usage: prepare-node-resource-sources.mjs [--source-dir directory]",
  );
  const readPolicy = (name, maximum) =>
    readBoundedNodeFile(join(root, "scripts/distribution", name), maximum);
  const inputs = {
    sourcePolicyBytes: readPolicy(
      "node-resource-sources.json",
      nodeSourcePolicyLimit,
    ),
    resourcePolicyBytes: readPolicy(
      "node-resources.json",
      nodeSourceBundleLimit,
    ),
    nodePolicyBytes: readPolicy("node-components.json", nodeSourceBundleLimit),
  };
  const directory = args.length ? resolve(args[1]) : undefined;
  const bundleBytes = directory
    ? createNodeSourceBundle({
        ...inputs,
        readSource: (source) =>
          readBoundedNodeFile(
            join(directory, source.path),
            128 * 1024,
            source.size,
          ),
      })
    : await fetchNodeSourceBundle(inputs);
  const policy = validateNodeSourceBundle({ ...inputs, bundleBytes });
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(temporary, bundleBytes, { flag: "wx" });
  renameSync(temporary, output);
  console.log(
    `Verified source bundle: ${policy.sources.length} originals; no source execution or release approval.`,
  );
} catch (error) {
  rmSync(temporary, { force: true });
  console.error(error.message);
  process.exitCode = 1;
}
