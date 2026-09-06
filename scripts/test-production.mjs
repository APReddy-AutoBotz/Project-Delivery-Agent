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
const targets = ["acceptance", "api", "worker", "web", "operations"];
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
function denied(args, name) {
  let failed = false;
  try {
    docker(args, name);
  } catch {
    failed = true;
  }
  assert(
    failed &&
      readFileSync(join(output, name + ".log"), "utf8").includes(
        '"event":"operations.failed"',
      ),
    "Expected safe operations denial: " + name,
  );
}
const operation = (command, patch = {}, extra = []) =>
  compose(
    "run",
    "--rm",
    ...Object.entries(patch).flatMap(([key, value]) => [
      "-e",
      key + "=" + value,
    ]),
    "operations",
    command,
    ...extra,
  );
const fixtureStep = (mode) =>
  docker(
    compose(
      "run",
      "--rm",
      "verify",
      "node",
      "scripts/acceptance/operations.mjs",
      mode,
    ),
    "operations-" + mode,
    "inherit",
  );
let paused = false;
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
  console.log("Testing release operations and recovery");
  docker(operation("provision"), "repeat-provision");
  docker(
    operation("migrate", {
      PDAA_DB_USER: "pdaa_migrate",
      PDAA_DB_PASSWORD_FILE: "/run/secrets/migration-password",
    }),
    "release-migrate",
  );
  denied(
    operation("provision", {
      PDAA_API_PASSWORD_FILE: "/run/secrets/backup-password",
    }),
    "mismatched-role-secret",
  );
  denied(
    operation("provision", { CUSTOMER_NAME: "Wrong customer" }),
    "mismatched-customer",
  );
  denied(
    operation("migrate", { PDAA_DB_CA_FILE: "/run/secrets/wrong-ca.crt" }),
    "operations-wrong-ca",
  );
  fixtureStep("prepare");
  const backupResult = docker(
    operation("backup", {
      PDAA_DB_USER: "pdaa_backup",
      PDAA_DB_PASSWORD_FILE: "/run/secrets/backup-password",
    }),
    "encrypted-backup",
    "capture",
  );
  const backupName = JSON.parse(
    backupResult.split("\n").find((line) => line.startsWith('{"operation"')),
  ).result.file;
  assert(/^backup-[a-zA-Z0-9-]+\.pdaa$/.test(backupName));
  const restoreTarget = (name) => ({
    PDAA_DB_NAME: name,
    PDAA_OPS_TARGET: "database:5432/" + name,
  });
  fixtureStep("corrupt");
  denied(
    operation("restore", restoreTarget("restore_wrong"), [
      "backup-corrupt.pdaa",
    ]),
    "corrupt-archive",
  );
  denied(
    operation(
      "restore",
      {
        ...restoreTarget("restore_wrong"),
        PDAA_BACKUP_KEY_FILE: "/run/secrets/wrong-backup-key",
      },
      [backupName],
    ),
    "wrong-backup-key",
  );
  denied(
    operation("restore", restoreTarget("restore_nonempty"), [backupName]),
    "nonempty-restore",
  );
  denied(operation("restore", {}, [backupName]), "source-restore-denied");
  denied(
    operation("restore", restoreTarget("restore_wrong"), ["../" + backupName]),
    "restore-path-denied",
  );
  denied(
    operation("restore", restoreTarget("restore_large"), [backupName]),
    "large-object-restore-denied",
  );
  const heldId = docker(
    compose(
      "run",
      "-d",
      "--rm",
      "verify",
      "node",
      "scripts/acceptance/operations.mjs",
      "hold",
    ),
    "restore-held-client",
    "capture",
  );
  try {
    fixtureStep("held-ready");
    denied(
      operation("restore", restoreTarget("restore_connected"), [backupName]),
      "connected-target-denied",
    );
  } finally {
    docker(["stop", heldId], "restore-held-stop");
  }
  docker(
    operation("restore", restoreTarget("restore_target"), [backupName]),
    "quarantined-restore",
  );
  denied(
    operation("provision", restoreTarget("restore_target")),
    "quarantine-reprovision-denied",
  );
  denied(
    operation("migrate", restoreTarget("restore_target")),
    "quarantine-migrate-denied",
  );
  fixtureStep("verify");
  checks.passed.push(
    "Release operations: packaged provision/repeat, customer/secret/TLS denial and bidirectional migration interoperability, concurrency, drift and atomic rollback",
  );
  checks.passed.push(
    "Encrypted whole-database backup and fresh quarantined restore: integrity, credential decryption, audit and ownership; corrupt/key/path/nonempty/source denials",
  );
  fixtureStep("heartbeat");
  docker(compose("pause", "database"), "database-pause");
  paused = true;
  fixtureStep("outage");
  docker(compose("unpause", "database"), "database-unpause");
  paused = false;
  fixtureStep("recovered");
  docker(compose("restart", "database"), "database-restart");
  fixtureStep("recovered");
  const workerId = docker(
    compose("ps", "-q", "worker"),
    "worker-id",
    "capture",
  );
  const beforeRestart = Number(
    docker(
      ["inspect", "--format", "{{.RestartCount}}", workerId],
      "restart-count-before",
      "capture",
    ),
  );
  try {
    docker(
      compose(
        "exec",
        "-T",
        "worker",
        "node",
        "-e",
        "process.kill(1,'SIGKILL')",
      ),
      "worker-failure",
    );
  } catch {
    /* PID 1 failure can terminate docker exec too. Assert actual restart below. */
  }
  fixtureStep("recovered");
  const afterRestart = Number(
    docker(
      ["inspect", "--format", "{{.RestartCount}}", workerId],
      "restart-count-after",
      "capture",
    ),
  );
  assert(
    afterRestart > beforeRestart,
    "Worker restart policy must recover an unexpected process exit",
  );
  checks.passed.push(
    "Database blackhole readiness deadline, persistent database restart and independently supervised worker recovery with advancing heartbeat",
  );
} catch (error) {
  failure = error;
} finally {
  try {
    if (paused) {
      docker(compose("unpause", "database"), "cleanup-unpause");
      paused = false;
    }
    if (started && failure)
      docker(
        compose(
          "logs",
          "--no-color",
          "provision",
          "provision-external",
          "database",
          "external-database",
          "initialize",
          "api",
          "worker",
        ),
        "failure-diagnostics",
      );
  } catch {
    /* Preserve the original failed step. */
  }
  try {
    if (started)
      docker(
        compose("down", "--remove-orphans", "--volumes"),
        "production-stop",
      );
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
