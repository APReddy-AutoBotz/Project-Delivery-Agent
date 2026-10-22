// EXEC-020: fresh synthetic DB, real API and built web preview, no worker or network delivery.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer as portProbe } from "node:net";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabase } from "../packages/data/dist/index.js";
import { seedEscalationHistory } from "./acceptance/escalation-history.mjs";

const source = new URL(process.env.PDAA_DATABASE_URL ?? "");
assert(process.env.NODE_ENV !== "production" && process.env.DATA_MODE === "synthetic");
assert(["127.0.0.1", "localhost"].includes(source.hostname));
const hosted = process.argv.includes("--hosted-foundation");
if (hosted) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_WORKFLOW, "Foundation validation");
  assert.equal(process.env.GITHUB_JOB, "verify");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^[0-9]+$/);
  assert.equal(source.pathname, "/pdaa"); // Disposable hosted locator only; never migrated or seeded.
} else assert.match(source.pathname, /^\/pdaa_test_[0-9]+$/);

// Refuse occupied ports, without stopping or replacing any existing listener.
const probes = [];
try {
  for (const port of [3002, 5174]) {
    const probe = portProbe();
    await new Promise((done, fail) => {
      probe.once("error", fail); probe.listen({ host: "127.0.0.1", port, exclusive: true }, done);
    });
    probes.push(probe);
  }
} finally { await Promise.all(probes.map((probe) => new Promise((done) => probe.close(done)))); }

mkdirSync("tmp", { recursive: true });
mkdirSync("artifacts", { recursive: true });
const directory = resolve("tmp/escalation-browser-" + randomUUID());
mkdirSync(directory, { mode: 0o700 });
const databaseName = "pdaa_test_" + Date.now();
source.pathname = "/postgres";
const creator = createDatabase(source.toString());
try { await creator.$executeRawUnsafe('CREATE DATABASE "' + databaseName + '"'); }
finally { await creator.$disconnect(); }
source.pathname = "/" + databaseName;
const env = { ...process.env, NODE_ENV: "development", AUTH_MODE: "development", DATA_MODE: "synthetic",
  PDAA_DATABASE_URL: source.toString(), API_HOST: "127.0.0.1", API_PORT: "3002",
  APP_ORIGIN: "http://localhost:5174", INTERNAL_API_URL: "http://127.0.0.1:3002",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"), SESSION_SECRET: randomBytes(48).toString("base64url"),
  SHADOW_MODE: "false" };
const children = [], streams = [];
let web;
function start(args, name, cwd = process.cwd()) {
  const log = createWriteStream(resolve(directory, name + ".log"), { flags: "wx", mode: 0o600 });
  streams.push(log);
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  return child;
}
async function complete(child) {
  const [code, signal] = await once(child, "exit");
  assert.equal(signal, null); assert.equal(code, 0, "Isolated browser prerequisite failed; retained private log");
}
async function ready(url, child) {
  // Cold compiled API module import alone measured 69.7s on the Windows host.
  // This bounds prerequisite startup; Playwright assertion deadlines are unchanged.
  const deadline = Date.now() + 120000;
  let last = "no response";
  while (Date.now() < deadline) {
    assert(child.exitCode === null && child.signalCode === null, "Owned API exited before readiness");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      last = "HTTP " + response.status;
    } catch (error) { last = error.name; }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("Isolated browser API readiness deadline: " + last);
}
try {
  await complete(start(["../../node_modules/prisma/build/index.js", "migrate", "deploy"], "migrate", resolve("packages/data")));
  await complete(start(["packages/data/dist/seed.js"], "seed"));
  const fixture = await seedEscalationHistory(source.toString(), { isolatedCustomer: true });
  const privateFile = (name, value) => {
    const path = resolve(directory, name);
    writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    return path;
  };
  env.PROJECT_UPDATE_CAPTURE_FILE = privateFile("capture.json", fixture.configuration);
  env.PROJECT_UPDATE_ZONES_FILE = privateFile("zones.json", fixture.zones);
  env.PROJECT_UPDATE_TASK_KEYS_FILE = privateFile("task-keys.json",
    { currentKeyId: "escalation-browser", keys: { "escalation-browser": randomBytes(32).toString("base64url") } });
  env.PROJECT_UPDATE_SERVICE_SUBJECT = fixture.service;
  env.CUSTOMER_ID = fixture.customerId;
  env.PDAA_ESCALATION_FIXTURE_PATH = privateFile("fixture.json", fixture);
  env.PDAA_ESCALATION_BROWSER_DATABASE_URL = source.toString();
  env.PDAA_ESCALATION_BROWSER_ORIGIN = "http://localhost:5174";
  const api = start(["apps/api/dist/main.js"], "api");
  await ready("http://127.0.0.1:3002/api/auth/config", api);
  const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
  const { preview, loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href);
  const loaded = await loadConfigFromFile({ command: "serve", mode: "production", isPreview: true }, resolve("apps/web/vite.config.ts"));
  assert(loaded);
  // Exercise pnpm build's actual web output; dev transforms are not part of the journey.
  web = await preview({ ...loaded.config, configFile: false, root: resolve("apps/web"),
    preview: { host: "127.0.0.1", port: 5174, strictPort: true,
      proxy: { "/api": "http://127.0.0.1:3002" } } });
  assert((await fetch("http://127.0.0.1:5174/")).ok);
  process.stdout.write("Real PM history browser proof uses fresh " + databaseName + "; no default database, worker or external delivery.\n");
  const test = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "scripts/escalation-playwright.config.mjs"],
    { env, stdio: "inherit" });
  children.push(test);
  await complete(test);
} finally {
  if (web) await web.close();
  // These are only the process handles created by this invocation.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  for (const stream of streams) stream.end();
}
