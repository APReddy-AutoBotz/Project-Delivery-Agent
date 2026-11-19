import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  book,
  excelTextParts,
  fixtureParts,
  matrix,
} from "../../tests/fixtures/xlsx-test-worksheet.ts";
import { encodeRequest } from "./wire.mjs";
import { stageProduction } from "./stage-production.mjs";
import { root } from "./staging.mjs";

const suffix = randomBytes(10).toString("hex");
const project = "pdaa-xlsx-runtime-" + suffix;
const image = "pdaa-xlsx-runtime-proof:" + suffix;
const workspace = mkdtempSync(join(tmpdir(), "pdaa-xlsx-runtime-"));
const dockerEnv = { ...process.env, PDAA_XLSX_DECODER_IMAGE: image };
const containers = [];
const evidence = join(root, "artifacts", "xlsx-runtime-package.json");
let built = false;
let composed = false;
let result;

function docker(args, timeout = 30_000) {
  const child = spawnSync("docker", args, {
    cwd: root,
    env: dockerEnv,
    timeout,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (child.status !== 0 || child.error) {
    throw new Error(
      "XLSX_RUNTIME_DOCKER_FAILED " +
        args.slice(0, 2).join(" ") +
        " " +
        child.status +
        "\n" +
        child.stderr?.slice(-3000),
      { cause: child.error },
    );
  }
  return child.stdout.trim();
}

const context = join(workspace, "image");
const envFile = join(workspace, "empty.env");
writeFileSync(envFile, "");
const compose = (...args) =>
  docker(
    [
      "compose",
      "--env-file",
      envFile,
      "-p",
      project,
      "-f",
      "deploy/xlsx-runtime/compose.yaml",
      ...args,
    ],
    60_000,
  );
const inspect = (id) => JSON.parse(docker(["inspect", id]))[0];

function verifyBoundary(container, access, name, user) {
  const host = container.HostConfig;
  assert.equal(container.Config.User, user);
  assert.equal(host.NetworkMode, "none");
  assert.equal(host.CgroupnsMode, "private");
  assert.equal(host.PidMode, "");
  assert.equal(host.ReadonlyRootfs, true);
  assert.equal(host.Privileged, false);
  assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.deepEqual(host.CapAdd ?? [], name === "initializer" ? ["CHOWN"] : []);
  assert(!host.Tmpfs || Object.keys(host.Tmpfs).length === 0);
  assert.deepEqual(
    container.Config.Env.map((pair) => pair.split("=", 1)[0]).sort(),
    ["NODE_ENV", "PATH"],
  );
  assert(host.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(host.Memory, 268_435_456);
  assert.equal(host.MemorySwap, host.Memory);
  assert.equal(host.NanoCpus, 500_000_000);
  assert.equal(host.PidsLimit, 32);
  assert.deepEqual(
    container.Mounts.map(({ Type, Destination, RW }) => [
      Type,
      Destination,
      RW,
    ]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [
      ...(name === "probe" ? [["bind", "/proof", false]] : []),
      ["volume", "/run/pdaa-xlsx", access],
    ],
  );
  assert.equal(
    container.Mounts.find((mount) => mount.Type === "volume").Name,
    project + "_xlsx-link",
  );
}

const capacity = { rows: 1_000, columns: 64, textBytes: 1_048_576 };

function capacityGrid() {
  const headers = Array.from(
    { length: capacity.columns },
    (_, i) => "Column " + (i + 1),
  );
  const rows = Array.from({ length: capacity.rows }, (_, i) => [
    String(i + 1),
    ...Array(capacity.columns - 1).fill("x"),
  ]);
  const bytes = [headers, ...rows]
    .flat()
    .reduce((total, value) => total + Buffer.byteLength(value), 0);
  let remaining = capacity.textBytes - bytes;
  for (const row of rows) {
    if (remaining === 0) break;
    const addition = Math.min(4_095, remaining);
    row[1] = "x".repeat(1 + addition);
    remaining -= addition;
  }
  assert.equal(remaining, 0);
  return { headers, rows };
}

try {
  rmSync(evidence, { force: true });
  stageProduction(context);
  const manifest = createHash("sha256")
    .update(readFileSync(join(context, "runtime/manifest.json")))
    .digest("hex");
  const proof = join(workspace, "proof");
  mkdirSync(proof, { mode: 0o755 });
  copyFileSync(
    join(root, "scripts/xlsx-runtime/probe.mjs"),
    join(proof, "probe.mjs"),
  );
  const profiles = ["portable", "excel-text-v1"];
  const grids = [{ headers: matrix[0], rows: matrix.slice(1) }, capacityGrid()];
  const jobs = [];
  for (const profile of profiles) {
    for (const [gridIndex, { headers, rows }] of grids.entries()) {
      const values = [headers, ...rows];
      const parts =
        profile === "portable"
          ? fixtureParts(values, true)
          : excelTextParts(values);
      const job = randomBytes(16);
      writeFileSync(
        join(proof, jobs.length + ".bin"),
        encodeRequest(job, "Portfolio", book(parts), profile),
      );
      jobs.push({ id: job.toString("hex"), gridIndex });
    }
  }
  writeFileSync(join(proof, "expected.json"), JSON.stringify({ jobs, grids }));

  docker(["build", "--network", "none", "-t", image, context], 240_000);
  built = true;
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  assert.match(imageId, /^sha256:[0-9a-f]{64}$/u);
  composed = true;
  compose("up", "--detach", "--wait", "--wait-timeout", "30");
  const id = compose("ps", "-aq", "xlsx-decoder");
  assert.match(id, /^[0-9a-f]{64}$/u);
  const decoder = inspect(id);
  verifyBoundary(decoder, true, "decoder", "1001:2000");
  assert.equal(decoder.Image, imageId);
  assert.equal(decoder.State.Health.Status, "healthy");
  const initializerId = compose("ps", "-aq", "xlsx-initialize");
  assert.match(initializerId, /^[0-9a-f]{64}$/u);
  const initializer = inspect(initializerId);
  verifyBoundary(initializer, true, "initializer", "0:2000");
  assert.equal(initializer.Image, imageId);
  assert.equal(initializer.State.Status, "exited");
  assert.equal(initializer.State.ExitCode, 0);

  for (const [user, extra, intent] of [
    ["1000:1000", ["--group-add", "2000"], "decode"],
    ["1003:1003", [], "denied"],
  ]) {
    const caller = docker([
      "create",
      "--network",
      "none",
      "--cgroupns",
      "private",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "256m",
      "--memory-swap",
      "256m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "32",
      "--user",
      user,
      ...extra,
      "--mount",
      "type=volume,src=" +
        project +
        "_xlsx-link,dst=/run/pdaa-xlsx,readonly,volume-nocopy",
      "--mount",
      "type=bind,src=" + proof + ",dst=/proof,readonly",
      "--entrypoint",
      "node",
      imageId,
      "/proof/probe.mjs",
      manifest,
      intent,
    ]);
    assert.match(caller, /^[0-9a-f]{64}$/u);
    containers.push(caller);
    const state = inspect(caller);
    verifyBoundary(state, false, "probe", user);
    assert.deepEqual(
      state.HostConfig.GroupAdd ?? [],
      intent === "decode" ? ["2000"] : [],
    );
    assert.equal(docker(["start", "-a", caller]), "XLSX_RUNTIME_PROBE_PASSED");
  }

  compose("stop", "xlsx-decoder");
  assert.equal(inspect(id).State.ExitCode, 0);
  compose("start", "--wait", "--wait-timeout", "30", "xlsx-decoder");
  assert.equal(inspect(id).State.Health.Status, "healthy");
  docker(["kill", "--signal", "KILL", id]);
  docker(["start", id]);
  assert.equal(docker(["wait", id]), "73");
  result = {
    image: imageId,
    manifestSha256: manifest,
    actualContainerLimits: true,
    leastPrivilegeInitializer: true,
    profiles,
    capacity,
    readOnlyCaller: true,
    unrelatedUidDenied: true,
    cleanRestart: true,
    abnormalRestartDenied: true,
  };
} finally {
  const cleanupFailures = [];
  const cleanup = (remove) => {
    try {
      remove();
    } catch (failure) {
      cleanupFailures.push(failure);
    }
  };
  for (const id of containers) cleanup(() => docker(["rm", "-f", id]));
  if (composed) cleanup(() => compose("down", "--volumes", "--remove-orphans"));
  if (built) cleanup(() => docker(["image", "rm", image]));
  cleanup(() => rmSync(workspace, { recursive: true, force: true }));
  if (cleanupFailures.length)
    throw new AggregateError(
      cleanupFailures,
      "XLSX runtime teardown did not finish",
    );
}
mkdirSync(join(root, "artifacts"), { recursive: true });
writeFileSync(evidence, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log("XLSX decoder runtime package proof passed");
