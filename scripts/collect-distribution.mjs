// NFR-SEC-010 / AC-MNT-004. Collection never publishes or approves a release.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { load } from "js-yaml";
import { installTools, toolPins } from "./distribution/install.mjs";
import {
  customerTargets,
  hash,
  validateImageReports,
  requireCompleteTargets,
  reconcileApplicationPackages,
  validateRuntimeTooling,
} from "./distribution/evidence.mjs";
import { browserEvidence } from "./distribution/browser.mjs";

const root = resolve(import.meta.dirname, "..");
const canonical = join(root, "artifacts/distribution-evidence.json");
if (existsSync(canonical)) unlinkSync(canonical);
const runId =
  "pdaa-distribution-" + Date.now() + "-" + randomUUID().slice(0, 8);
const output = join(root, "artifacts", runId);
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(SYFT_|GRYPE_|DOCKER_|COMPOSE_)/i.test(key),
  ),
);
env.DOCKER_HOST =
  process.platform === "win32"
    ? "npipe:////./pipe/dockerDesktopLinuxEngine"
    : "unix:///var/run/docker.sock";
env.GRYPE_DB_CACHE_DIR = join(root, "tmp/distribution-tools/grype-db");
env.SYFT_CACHE_DIR = join(root, "tmp/distribution-tools/syft-cache");
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600000,
  });
  assert.equal(
    result.status,
    0,
    `Distribution tool failed: ${command.split(/[\\/]/).at(-1)} ${args[0]}: ${result.stderr?.slice(-2000)}`,
  );
  return result.stdout.trim();
}
const git = (...args) =>
  run("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args]);
const acceptanceBytes = readFileSync(
  join(root, "artifacts/production-acceptance.json"),
);
const acceptance = JSON.parse(acceptanceBytes);
assert.equal(
  acceptance.status,
  "passed",
  "Production acceptance is not successful",
);
assert.equal(
  acceptance.workingTreeDirty,
  false,
  "Production acceptance source was dirty",
);
assert.equal(git("status", "--porcelain"), "", "Distribution source is dirty");
assert.equal(
  acceptance.sourceRevision,
  git("rev-parse", "HEAD"),
  "Stale acceptance source",
);
assert.equal(
  acceptance.sourceTree,
  git("rev-parse", "HEAD^{tree}"),
  "Stale acceptance tree",
);
assert.equal(
  acceptance.customerProfiles?.length,
  2,
  "Customer acceptance incomplete",
);
assert.deepEqual(acceptance.customerProfiles.map((p) => p.profile).sort(), [
  "bundled",
  "external",
]);
for (const profile of acceptance.customerProfiles) {
  assert.equal(profile.status, "passed");
  assert.equal(
    profile.databaseImage,
    acceptance.databaseImage,
    "Customer DB acceptance identity differs",
  );
  for (const target of customerTargets.filter((t) => t !== "database"))
    assert.equal(profile.images[target], acceptance.images[target]);
}
const tools = await installTools(root);
const lockBytes = readFileSync(join(root, "pnpm-lock.yaml"));
const lock = load(lockBytes.toString("utf8"));
assert.equal(
  String(lock.lockfileVersion),
  "9.0",
  "Unrecognized lockfile format",
);
const lockPackages = Object.entries(lock.packages).map(
  ([coordinate, value]) => {
    assert(
      /^sha(256|512)-[A-Za-z0-9+/=]+$/.test(value.resolution?.integrity ?? ""),
      "Exact registry integrity missing: " + coordinate,
    );
    return { coordinate, integrity: value.resolution.integrity };
  },
);
const locked = new Map(lockPackages.map((p) => [p.coordinate, p.integrity]));
const runtimePolicyBytes = readFileSync(
  join(root, "scripts/distribution/runtime-policy.json"),
);
const runtimePolicy = JSON.parse(runtimePolicyBytes);
writeFileSync(join(output, "runtime-policy.json"), runtimePolicyBytes);
writeFileSync(join(output, "pnpm-lock.yaml"), lockBytes);
writeFileSync(
  join(output, "lock-inventory.json"),
  JSON.stringify(lockPackages, null, 2),
);
writeFileSync(join(output, "production-acceptance.json"), acceptanceBytes);
const record = {
  schemaVersion: 2,
  runId,
  sourceRevision: acceptance.sourceRevision,
  sourceTree: acceptance.sourceTree,
  acceptanceRunId: acceptance.runId,
  startedAt: new Date().toISOString(),
  status: "running",
  images: {},
  tools: toolPins,
  blockers: [],
  distributionAccepted: false,
  layerScopes: ["squashed", "all-layers"],
  coverageLimits: [
    "Runtime and all-layer scanner inventories require review; unrecognized binary contents are not certified",
    "Binary-bundled components and notices require reconciliation, including Node, pgvector and Caddy",
    "Scanner findings require human triage; none are waived",
  ],
};
const write = (name, value) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
function collectImageReports(target, scope, inspection) {
  const stem = target + (scope === "all-layers" ? ".layers" : "");
  const sbomFile = join(output, stem + ".syft.json");
  run(tools.syft, [
    "scan",
    "docker:" + inspection.Id,
    "--config",
    join(root, "scripts/distribution/syft.yaml"),
    "--scope",
    scope,
    "-o",
    "syft-json=" + sbomFile,
    "-o",
    "spdx-json@2.3=" + join(output, stem + ".spdx.json"),
  ]);
  run(tools.grype, [
    "sbom:" + sbomFile,
    "--config",
    join(root, "scripts/distribution/grype.yaml"),
    "--scope",
    scope,
    "-o",
    "json",
    "--file",
    join(output, stem + ".grype.json"),
  ]);
  const sbom = JSON.parse(readFileSync(sbomFile, "utf8"));
  const image = validateImageReports({
    inspection,
    sbom,
    scope,
    spdx: JSON.parse(readFileSync(join(output, stem + ".spdx.json"))),
    scan: JSON.parse(readFileSync(join(output, stem + ".grype.json"))),
    pins: toolPins,
  });
  validateRuntimeTooling(target, sbom, runtimePolicy);
  return { sbom, image };
}
try {
  for (const target of customerTargets) {
    console.log(
      `Collecting ${target} image SBOM, original notices and vulnerability report`,
    );
    const id =
      target === "database"
        ? acceptance.databaseImage
        : acceptance.images[target];
    assert(/^sha256:[a-f0-9]{64}$/.test(id), "Image identity missing");
    const inspection = JSON.parse(run("docker", ["image", "inspect", id]))[0];
    assert.equal(inspection.Id, id, "Accepted image identity changed");
    write(target + ".image.json", {
      Id: inspection.Id,
      Os: inspection.Os,
      Architecture: inspection.Architecture,
      RootFS: inspection.RootFS,
    });
    const { sbom, image } = collectImageReports(target, "squashed", inspection);
    const appPackages = sbom.artifacts.filter(
      (p) =>
        p.type === "npm" && p.locations.some((l) => l.path.startsWith("/app/")),
    );
    if (["api", "worker", "operations"].includes(target)) {
      assert(appPackages.length > 0, "Application package inventory missing");
      const packaged = sbom.files.find(
        (f) => f.location.path === "/app/runtime-inventory.json",
      );
      assert(packaged?.contents, "Build-observed runtime inventory missing");
      const expected = JSON.parse(Buffer.from(packaged.contents, "base64"));
      image.applicationLockInventory = reconcileApplicationPackages(
        appPackages,
        expected,
        locked,
      );
      assert(
        sbom.artifacts.some((p) => p.name === "node" && p.type === "binary"),
        "Copied Node binary missing from SBOM",
      );
    }
    image.missingPackageNotices = appPackages
      .filter(
        (p) =>
          !p.name.startsWith("@pdaa/") &&
          !p.locations.some((l) => {
            const prefix = l.path.slice(0, l.path.lastIndexOf("/") + 1);
            return image.notices.some(
              (n) =>
                n.path.startsWith(prefix) &&
                /licen[sc]e|notice|copyright/i.test(
                  n.path.slice(prefix.length),
                ),
            );
          }),
      )
      .map((p) => ({ id: p.id, name: p.name, version: p.version }));
    image.binaryInventory = sbom.artifacts
      .filter((p) => ["binary", "go-module"].includes(p.type))
      .map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        type: p.type,
      }));
    if (target === "web")
      image.browser = await browserEvidence({
        sbom,
        output,
        locked,
        tools,
        run,
        root,
        pins: toolPins,
      });
    write(target + ".notices.json", image.notices);
    delete image.notices;
    console.log(`Collecting ${target} distributed lower-layer evidence`);
    const { image: allLayers } = collectImageReports(
      target,
      "all-layers",
      inspection,
    );
    write(target + ".layers.notices.json", allLayers.notices);
    delete allLayers.notices;
    write(target + ".layers.review.json", allLayers);
    image.allLayers = allLayers;
    write(target + ".review.json", image);
    record.images[target] = image;
  }
  requireCompleteTargets(record.images);
  record.blockers = [
    {
      code: "inventory-review",
      detail:
        "Exact OS, runtime, browser and binary component inventory requires review against the adoption register",
    },
    {
      code: "license-notice-review",
      detail:
        "Observed original notices and license classifications require complete legal/product review; missing or incompatible licenses are not approved",
    },
    {
      code: "vulnerability-dispositions",
      detail:
        "Every reported finding remains unreviewed, including unfixed findings",
    },
    {
      code: "distributed-layer-review",
      detail:
        "Runtime and all-layer inventories, notices and findings require review; scanner coverage is not complete attribution approval",
    },
    {
      code: "trusted-release-signing",
      detail: "No trusted release signature has been created or verified",
    },
  ];
  record.status = "complete";
  record.completedAt = new Date().toISOString();
  const { readdirSync } = await import("node:fs");
  record.files = Object.fromEntries(
    readdirSync(output)
      .sort()
      .map((name) => [name, hash(readFileSync(join(output, name)))]),
  );
  write("summary.json", record);
  const staged = canonical + ".tmp";
  writeFileSync(staged, JSON.stringify(record, null, 2) + "\n");
  renameSync(staged, canonical);
  console.log(
    `Distribution evidence complete: ${runId}. Release remains blocked by ${record.blockers.length} review gates.`,
  );
} catch (error) {
  record.status = "failed";
  record.completedAt = new Date().toISOString();
  write("failed.json", record);
  throw error;
}
