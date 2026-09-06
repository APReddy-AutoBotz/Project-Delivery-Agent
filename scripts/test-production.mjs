// Synthetic acceptance only. Every run owns its project, images, fixture and evidence.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  renameSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const project =
  "pdaa-acceptance-" + Date.now() + "-" + randomUUID().slice(0, 8);
const fixture = resolve(root, "tmp", project);
const artifacts = resolve(root, "artifacts");
const output = join(artifacts, project);
mkdirSync(fixture, { recursive: true, mode: 0o700 });
mkdirSync(output, { recursive: true });
const canonical = join(artifacts, "production-acceptance.json");
if (existsSync(canonical)) unlinkSync(canonical);
function git(args) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error("Acceptance source revision unavailable");
  return result.stdout.trim();
}
const record = {
  runId: project,
  sourceRevision: git(["rev-parse", "HEAD"]),
  workingTreeDirty: Boolean(git(["status", "--porcelain"])),
  startedAt: new Date().toISOString(),
  status: "running",
  images: {},
};
const save = () =>
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
save();
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(DOCKER_|COMPOSE_|PDAA_ACCEPTANCE_|PDAA_ARTIFACT_|PDAA_.*_IMAGE$)/.test(
        key,
      ),
  ),
);
env.PDAA_ACCEPTANCE_DIR = fixture;
env.PDAA_ACCEPTANCE_RUN_ID = project;
env.PDAA_ARTIFACT_DIR = "/workspace/artifacts/" + project;
const targets = ["acceptance", "api", "worker", "web"];
for (const target of targets)
  env[`PDAA_${target.toUpperCase()}_IMAGE`] = `pdaa-${target}:${project}`;
const endpoint =
  process.platform === "win32"
    ? "npipe:////./pipe/dockerDesktopLinuxEngine"
    : "unix:///var/run/docker.sock";
function docker(args, name, mode = "log") {
  const file =
    mode === "log"
      ? openSync(join(output, name + ".log"), "w", 0o600)
      : undefined;
  let result;
  try {
    result = spawnSync("docker", ["--host", endpoint, ...args], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio:
        mode === "inherit"
          ? "inherit"
          : mode === "capture"
            ? "pipe"
            : ["ignore", file, file],
    });
  } finally {
    if (file !== undefined) closeSync(file);
  }
  if (result.status !== 0)
    throw new Error(
      `Production acceptance step failed: ${name}. Inspect ${project}'s local diagnostic; do not publish raw logs.`,
    );
  return result.stdout?.trim();
}
const compose = (...args) => [
  "compose",
  "-f",
  "deploy/acceptance/compose.yaml",
  "-p",
  project,
  ...args,
];
let started = false;
let failure;
let checks;
try {
  docker(compose("config", "--quiet"), "compose-validate");
  for (const target of targets) {
    console.log("Building isolated " + target + " image");
    const key = `PDAA_${target.toUpperCase()}_IMAGE`;
    docker(
      [
        "build",
        "-f",
        "deploy/Dockerfile",
        "--target",
        target,
        "-t",
        env[key],
        ".",
      ],
      "build-" + target,
    );
    const id = docker(
      ["image", "inspect", env[key], "--format", "{{.Id}}"],
      "image-" + target,
      "capture",
    );
    assert(
      /^sha256:[a-f0-9]{64}$/.test(id),
      "Immutable image identity required",
    );
    env[key] = id;
    record.images[target] = id;
    save();
  }
  docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-e",
      "PDAA_ACCEPTANCE=isolated",
      "--mount",
      `type=bind,src=${fixture},dst=/fixture`,
      record.images.acceptance,
      "node",
      "scripts/acceptance/prepare.mjs",
    ],
    "fixture-prepare",
  );
  console.log(
    "Starting isolated TLS databases, identity provider and application containers",
  );
  started = true;
  docker(
    compose("up", "-d", "--wait", "--wait-timeout", "120", "gateway", "worker"),
    "production-start",
  );
  docker(compose("run", "--rm", "verify"), "production-tests", "inherit");
  checks = JSON.parse(readFileSync(join(output, "checks.json"), "utf8"));
  assert.equal(
    checks.runId,
    project,
    "Acceptance report belongs to another run",
  );
  assert(checks.passed?.length > 0, "Acceptance checks missing");
} catch (error) {
  failure = error;
} finally {
  try {
    if (started && failure)
      docker(
        compose("logs", "--no-color", "initialize", "api", "worker"),
        "failure-diagnostics",
      );
  } catch {
    /* Preserve the original failed step. */
  }
  try {
    if (started) docker(compose("down", "--remove-orphans"), "production-stop");
  } catch (error) {
    failure ??= error;
  }
  record.status = failure ? "failed" : "passed";
  record.completedAt = new Date().toISOString();
  save();
}
if (failure) throw failure;
const staged = join(artifacts, project + ".json.tmp");
writeFileSync(
  staged,
  JSON.stringify(
    { ...record, passed: checks.passed, distributionAccepted: false },
    null,
    2,
  ) + "\n",
);
renameSync(staged, canonical);
console.log(
  "Production acceptance passed; immutable image IDs and source revision recorded after successful teardown.",
);
