// EXEC-019 / NFR-REL-001, NFR-SEC-001: role bootstrap on a new disposable synthetic cluster.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyIngestionRoleBootstrap } from "./acceptance/ingestion-role-bootstrap.mjs";

assert.equal(process.env.DATA_MODE, "synthetic");
assert.notEqual(process.env.NODE_ENV, "production");
const root = resolve(import.meta.dirname, "..");
const endpoint = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
const image = "postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const name = "pdaa-role-bootstrap-" + Date.now() + "-" + randomBytes(4).toString("hex");
const purpose = "ingestion-role-bootstrap";
assert.match(name, /^pdaa-role-bootstrap-\d+-[0-9a-f]{8}$/);
mkdirSync(resolve(root, "tmp"), { recursive: true, mode: 0o700 });
const directory = resolve(root, "tmp", name);
mkdirSync(directory, { mode: 0o700 });
const envFile = resolve(directory, "postgres-private.env");
const password = randomBytes(32).toString("hex");
writeFileSync(envFile, "POSTGRES_USER=pdaa\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=" + password + "\n",
  { flag: "wx", mode: 0o600 });
function docker(args) {
  const result = spawnSync("docker", ["--host", endpoint, ...args],
    { cwd: root, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error("Isolated role bootstrap Docker operation failed: " + args[0]);
  return result.stdout.trim();
}
let id;
function ownedContainer() {
  assert.match(id, /^[0-9a-f]{64}$/);
  const [state] = JSON.parse(docker(["inspect", id]));
  assert.equal(state.Id, id);
  assert.equal(state.Name, "/" + name);
  assert.equal(state.Config.Image, image);
  assert.equal(state.Config.Labels["pdaa.purpose"], purpose);
  assert.equal(state.HostConfig.AutoRemove, true);
  assert.equal(state.HostConfig.NetworkMode, "bridge");
  assert.equal(state.HostConfig.Tmpfs["/var/lib/postgresql/data"], "rw,noexec,nosuid");
  const bindings = state.NetworkSettings.Ports["5432/tcp"];
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, "127.0.0.1");
  assert.match(bindings[0].HostPort, /^\d+$/);
  return bindings[0];
}
let proof;
try {
  id = docker(["run", "--rm", "-d", "--name", name, "--label", "pdaa.purpose=" + purpose,
    "--network", "bridge", "--env-file", envFile, "-p", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid", image]);
  const binding = ownedContainer();
  let ready = false;
  for (let tick = 0; tick < 60; tick++) {
    const result = spawnSync("docker", ["--host", endpoint, "exec", id, "pg_isready", "-U", "pdaa", "-d", "postgres"],
      { cwd: root, encoding: "utf8", timeout: 5_000 });
    if (result.status === 0) { ready = true; break; }
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.equal(ready, true, "Fresh isolated PostgreSQL readiness deadline");
  const url = new URL("postgresql://127.0.0.1/postgres");
  url.username = "pdaa"; url.password = password; url.port = binding.HostPort;
  proof = await verifyIngestionRoleBootstrap(url.toString());
} finally {
  if (id) { ownedContainer(); docker(["stop", "--time", "10", id]); }
}
const checks = { ...proof };
delete checks.retainedDatabases;
mkdirSync(resolve(root, "artifacts"), { recursive: true });
writeFileSync(resolve(root, "artifacts", "ingestion-role-bootstrap.json"), JSON.stringify({
  status: "passed", checkedAt: new Date().toISOString(), image,
  ...checks, isolatedClusterDisposed: true,
}, null, 2) + "\n");
console.log("Role-absent and partial-role clean/repeat migrations passed: 25 migrations, exact 85 tables, finite ACLs; owned cluster disposed.");
