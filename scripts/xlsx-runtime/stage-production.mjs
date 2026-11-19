import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  copySources,
  parserFiles,
  root,
  stageParserDependencies,
} from "./staging.mjs";

const productionFiles = [
  ...parserFiles,
  ...["endpoint", "initialize", "readiness", "service", "worker"].map(
    (name) => "scripts/xlsx-runtime/" + name + ".mjs",
  ),
];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inventory(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const file = join(directory, entry.name);
      const label = prefix + entry.name;
      if (entry.isDirectory()) return inventory(file, label + "/");
      assert(entry.isFile(), "Unexpected XLSX runtime entry");
      return [{ path: label, sha256: sha256(file) }];
    });
}

export function stageProduction(destination) {
  mkdirSync(destination, { recursive: true });
  assert(lstatSync(destination).isDirectory());
  assert.deepEqual(
    readdirSync(destination),
    [],
    "XLSX build context must be empty",
  );
  const runtime = join(destination, "runtime");
  stageParserDependencies(runtime);
  copySources(runtime, productionFiles);
  const dockerfile = join(destination, "Dockerfile");
  copyFileSync(join(root, "deploy/xlsx-runtime/Dockerfile"), dockerfile);
  const manifest = {
    format: 1,
    lockSha256: sha256(join(root, "pnpm-lock.yaml")),
    dockerfileSha256: sha256(dockerfile),
    files: inventory(runtime),
  };
  writeFileSync(
    join(runtime, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return manifest;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  assert.equal(
    process.argv.length,
    3,
    "Supply exactly one XLSX build context path",
  );
  stageProduction(resolve(process.argv[2]));
}
