import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { retirementCode } from "./boundary.mjs";
import { root, stage } from "./stage.mjs";

function command(
  file,
  args,
  { expected = 0, env = process.env, timeout = 30_000 } = {},
) {
  const result = spawnSync(file, args, {
    cwd: root,
    env,
    timeout,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== expected || result.error) {
    const operation =
      args[0] === "compose" ? args[7] : args.slice(0, 2).join(" ");
    const marker = [result.stdout, result.stderr]
      .join("\n")
      .split(/\r?\n/u)
      .find((line) => /^(?:XLSX_FIXTURE_CALLER_FAILED|RETIRED)$/u.test(line));
    throw new Error(
      ["XLSX_FIXTURE_COMMAND_FAILED", file, operation, result.status, marker]
        .filter((value) => value !== undefined && value !== null)
        .join(" "),
      {
        cause: result.error,
      },
    );
  }
  return result.stdout.trim();
}

const docker = (args, options) => command("docker", args, options);
const composeFile = join(root, "deploy/xlsx-isolation/compose.yaml");
const projectLabel = (project) => "label=com.docker.compose.project=" + project;
const uid = randomBytes(12).toString("hex");
const image = "pdaa-xlsx-proof:" + uid;
const projects = new Map();
const passes = [];

function assertProjectAbsent(project) {
  assert.equal(docker(["ps", "-aq", "--filter", projectLabel(project)]), "");
  assert.equal(
    docker(["volume", "ls", "-q", "--filter", projectLabel(project)]),
    "",
  );
  assert.equal(
    docker(["network", "ls", "-q", "--filter", projectLabel(project)]),
    "",
  );
}

function inspect(container) {
  return JSON.parse(docker(["inspect", container]))[0];
}

function assertDeployment(container, fixtureImage, project) {
  const {
    HostConfig: config,
    Config: spec,
    Mounts: mounts,
    Image: imageId,
  } = inspect(container);
  assert.equal(imageId, fixtureImage);
  assert.equal(spec.User, "1001:2000");
  assert.equal(spec.Labels["com.docker.compose.project"], project);
  assert.equal(config.NetworkMode, "none");
  assert.equal(config.CgroupnsMode, "private");
  assert.equal(config.PidMode, "");
  assert.equal(config.ReadonlyRootfs, true);
  assert.equal(config.Privileged, false);
  assert.deepEqual(config.CapDrop, ["ALL"]);
  assert((config.CapAdd ?? []).length === 0);
  assert(config.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(config.Memory, 268_435_456);
  assert.equal(config.MemorySwap, config.Memory);
  assert.equal(config.PidsLimit, 32);
  assert.equal(config.NanoCpus, 500_000_000);
  assert.equal(config.RestartPolicy.Name, "no");
  assert.deepEqual(
    mounts.map(({ Type, Name, Destination, RW }) => [
      Type,
      Name,
      Destination,
      RW,
    ]),
    [["volume", project + "_link", "/fixture-link", true]],
  );
}

async function waitReady(container) {
  const expires = performance.now() + 10_000;
  do {
    const live = inspect(container);
    assert(live.State.Running, "XLSX fixture service stopped during startup");
    if (
      docker(["logs", "--tail", "8", container]).split("\n").includes("READY")
    )
      return;
    await delay(100);
  } while (performance.now() < expires);
  throw new Error("XLSX_FIXTURE_READINESS");
}

function stack(project, mode, envFile) {
  const env = {
    ...process.env,
    PDAA_XLSX_FIXTURE_IMAGE: image,
    PDAA_XLSX_FIXTURE_MODE: mode,
  };
  const mainArgs = [
    "compose",
    "--file",
    composeFile,
    "--env-file",
    envFile,
    "--project-name",
    project,
  ];
  return (args, options) => docker([...mainArgs, ...args], { ...options, env });
}

function assertComposeConfig(compose, mode) {
  const { services, volumes } = JSON.parse(
    compose(["config", "--format", "json"]),
  );
  const identities = {
    initialize: "0:0",
    decoder: "1001:2000",
    caller: "1002:2000",
    unrelated: "1003:1003",
  };
  assert.deepEqual(
    Object.keys(services).sort(),
    Object.keys(identities).sort(),
  );
  assert.deepEqual(Object.keys(volumes), ["link"]);
  for (const [name, user] of Object.entries(identities)) {
    const service = services[name];
    assert.equal(service.user, user);
    assert.equal(service.image, image);
    assert.equal(service.network_mode, "none");
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(
      service.cap_add ?? [],
      name === "initialize" ? ["CHOWN"] : [],
    );
    assert.deepEqual(
      service.environment ?? {},
      name === "decoder" ? { PDAA_XLSX_FIXTURE_MODE: mode } : {},
    );
    assert.equal(service.secrets, undefined);
    assert.equal(service.ports, undefined);
    assert.equal(service.volumes.length, 1);
    const [mount] = service.volumes;
    assert.equal(mount.type, "volume");
    assert.equal(mount.source, "link");
    assert.equal(mount.target, "/fixture-link");
    assert.equal(mount.volume.nocopy, true);
    assert.equal(
      mount.read_only ?? false,
      ["caller", "unrelated"].includes(name),
    );
  }
}

async function exercise(mode, scenario, envFile, fixtureImage) {
  const project = `pdaa-xlsx-${uid}-${scenario}`;
  assertProjectAbsent(project);
  const compose = stack(project, mode, envFile);
  assertComposeConfig(compose, mode);
  projects.set(project, compose);
  compose(["run", "--no-deps", "--rm", "initialize"]);
  compose(["up", "--no-deps", "--detach", "decoder"]);
  const shortId = compose(["ps", "-aq", "decoder"]);
  assert.match(shortId, /^[0-9a-f]{12,64}$/u);
  const container = inspect(shortId).Id;
  assert.match(container, /^[0-9a-f]{64}$/u);
  await waitReady(container);
  assertDeployment(container, fixtureImage, project);
  assert.equal(
    compose(["run", "--no-deps", "--rm", "caller", scenario]),
    "CALLER_PASSED",
  );
  if (scenario === "decode") {
    assert(
      docker(["logs", "--tail", "8", container])
        .split("\n")
        .includes("OUTPUT_DEADLINE"),
    );
    assert.equal(
      compose(["run", "--no-deps", "--rm", "unrelated", "unrelated"]),
      "UNRELATED_DENIED",
    );
  }
  if (scenario === "descendant") {
    assert.equal(docker(["wait", container]), String(retirementCode));
    const { State, RestartCount } = inspect(container);
    assert.equal(State.Running, false);
    assert.equal(State.Pid, 0);
    assert.equal(State.OOMKilled, false);
    assert.equal(RestartCount, 0);
    assert.equal(
      docker(["logs", "--tail", "8", container]),
      "READY\nDESCENDANT_READY\nRETIRED",
    );
    assert.equal(
      compose(["run", "--no-deps", "--rm", "decoder"], {
        expected: retirementCode,
      }),
      "ENDPOINT_OCCUPIED\nRETIRED",
    );
  }
  if (scenario === "abnormal") assert(inspect(container).State.Running);
  passes.push(scenario);
  compose(["down", "--volumes", "--remove-orphans"]);
  assertProjectAbsent(project);
  projects.delete(project);
}

assert.equal(process.platform, "linux", "This fixture requires Linux");
assert.equal(
  docker(["info", "--format", "{{.OSType}} {{.CgroupVersion}}"]),
  "linux 2",
);
const revision = command("git", ["rev-parse", "HEAD"]);
assert.match(revision, /^[0-9a-f]{40}$/u);
assert.equal(command("git", ["status", "--porcelain"]), "");
const scratch = mkdtempSync(join(tmpdir(), "pdaa-xlsx-isolation-"));
let imageId;
try {
  const context = join(scratch, "context");
  const envFile = join(scratch, "compose.env");
  writeFileSync(envFile, "", { flag: "wx" });
  stage(context);
  docker(
    [
      "build",
      "--file",
      join(context, "deploy/xlsx-isolation/Dockerfile"),
      "--tag",
      image,
      context,
    ],
    { timeout: 240_000 },
  );
  imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  assert.match(imageId, /^sha256:[0-9a-f]{64}$/u);
  for (const [mode, scenario] of [
    ["decode", "decode"],
    ["abnormal", "abnormal"],
    ["descendant", "descendant"],
    ["decode", "fresh"],
  ])
    await exercise(mode, scenario, envFile, imageId);
} finally {
  try {
    for (const [project, compose] of projects) {
      compose(["down", "--volumes", "--remove-orphans"]);
      assertProjectAbsent(project);
    }
  } finally {
    try {
      if (imageId) docker(["image", "rm", image]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

const evidence = {
  test: "FR-CON-006/007",
  revision,
  imageId,
  platform: "linux-cgroup-v2",
  fixtureOnly: true,
  scenariosPassed: passes,
  ownedProjectsRemoved: true,
};
const artifacts = join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
writeFileSync(
  join(artifacts, "xlsx-packaged-isolation.json"),
  JSON.stringify(evidence, null, 2) + "\n",
  { flag: "wx" },
);
console.log("Synthetic XLSX packaged isolation passed");
