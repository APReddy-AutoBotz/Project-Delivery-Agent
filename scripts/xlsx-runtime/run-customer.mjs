import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  book,
  customerBrowserBook,
  excelTextParts,
  fixtureParts,
} from "../../tests/fixtures/xlsx-test-worksheet.ts";
import { stageProduction } from "./stage-production.mjs";
import { root } from "./staging.mjs";

const run =
  "pdaa-acceptance-" + Date.now() + "-" + randomBytes(4).toString("hex");
const scratch = join(root, "tmp");
mkdirSync(scratch, { recursive: true });
const local = mkdtempSync(join(scratch, "pdaa-xlsx-customer-"));
const endpoint =
  process.platform === "win32"
    ? "npipe:////./pipe/dockerDesktopLinuxEngine"
    : "unix:///var/run/docker.sock";
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(DOCKER_|COMPOSE_|PDAA_)/u.test(key),
  ),
);
const targetNames = ["api-xlsx", "operations", "web", "xlsx-proof", "acceptance", "xlsx-decoder"];
const names = Object.fromEntries(
  targetNames.map((name) => [name, "pdaa-" + name + ":" + run]),
);
const images = {};
const built = [];
const active = new Map();
const results = [];
const emptyEnv = join(local, "compose.env");
writeFileSync(emptyEnv, "");
const evidence = join(root, "artifacts", "xlsx-customer-bridge.json");
const hostPath = (path) => path.replaceAll("\\", "/");

function docker(step, args, env = {}, timeout = 120_000) {
  assert.match(step, /^[a-z0-9-]+$/u);
  console.log(step);
  const child = spawnSync("docker", ["--host", endpoint, ...args], {
    env: { ...inherited, ...env },
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  writeFileSync(
    join(local, step + ".log"),
    (child.stdout ?? "") + (child.stderr ?? ""),
    { mode: 0o600 },
  );
  if (child.status !== 0 || child.error) {
    const proofStep = child.stderr?.match(
      /^XLSX_CUSTOMER_(?:PROOF|BROWSER)_FAILED (environment|provisioned-customer|source-genesis|retention-fixture|receipt-verification|browser-receipt-verification|identity-readiness|browser-toolchain|sign-in|workbook-import|receipt-reload|scope-denial|restore-target|restore-quarantine|golden-project|golden-workbook|golden-admit|golden-reconciliation|golden-withdraw-jira|golden-jira-denial|golden-regrant-jira|golden-purge-workbook|golden-redelivery|golden-verify)\r?$/mu,
    )?.[1];
    const detail = proofStep ? step + " (" + proofStep + ")" : step;
    throw new Error("XLSX customer rehearsal failed at " + detail, {
      cause: child.error,
    });
  }
  return child.stdout.trim();
}

function operationResult(output, operation, customerId) {
  const lines = output.split("\n").filter((line) => line.startsWith('{"operation":"' + operation + '",'));
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.operation, operation);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.result.customerId, customerId);
  return receipt.result;
}

function checkSocketBoundary(api, decoder, project) {
  assert.equal(api.Image, images["api-xlsx"]);
  assert.equal(api.Config.User, "1000:1000");
  assert.equal(api.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(api.HostConfig.GroupAdd, ["2000"]);
  const mount = api.Mounts.find(
    (entry) => entry.Destination === "/run/pdaa-xlsx",
  );
  assert.equal(mount?.Name, project + "_xlsx-link");
  assert.equal(mount.RW, false);
  assert.equal(decoder.Image, images["xlsx-decoder"]);
  assert.equal(decoder.Config.User, "1001:2000");
  assert.deepEqual(
    decoder.Config.Env.map((pair) => pair.split("=", 1)[0]).sort(),
    ["NODE_ENV", "PATH"],
  );
  assert.equal(decoder.HostConfig.NetworkMode, "none");
  assert.equal(decoder.HostConfig.CgroupnsMode, "private");
  assert.equal(decoder.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(decoder.HostConfig.CapAdd ?? [], []);
  assert.deepEqual(decoder.HostConfig.CapDrop, ["ALL"]);
  assert(decoder.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(decoder.HostConfig.Memory, 268_435_456);
  assert.equal(decoder.HostConfig.MemorySwap, 268_435_456);
  assert.equal(decoder.HostConfig.NanoCpus, 500_000_000);
  assert.equal(decoder.HostConfig.PidsLimit, 32);
  assert.deepEqual(
    decoder.Mounts.map(({ Name, Destination, RW }) => [Name, Destination, RW]),
    [[mount.Name, mount.Destination, true]],
  );
}

function exercise(profile) {
  const project = run + "-" + profile;
  const database = profile === "bundled" ? "database" : "external-database";
  const folder = join(local, profile);
  const secrets = join(folder, "secrets");
  const proof = join(folder, "proof");
  const browserProof = join(proof, "browser");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  mkdirSync(browserProof, { recursive: true, mode: 0o755 });
  const env = {
    CUSTOMER_ID: "10000000-0000-4000-8000-000000000002",
    CUSTOMER_NAME: "Controlled customer installation",
    APP_ORIGIN: "https://web:8443",
    PDAA_DB_HOST: database,
    PDAA_DB_PORT: "5432",
    PDAA_DB_NAME: "pdaa",
    PDAA_ADMIN_USER: "postgres",
    PDAA_OPS_TARGET: database + ":5432/pdaa",
    PDAA_SECRET_DIR: hostPath(secrets),
    PDAA_BACKUP_DIR: hostPath(join(secrets, "backups")),
    PDAA_HTTPS_BIND: "127.0.0.1",
    PDAA_HTTPS_PORT: "0",
    OIDC_ISSUER: "https://identity-ingress:8443/identity/realms/pdaa",
    OIDC_JWKS_URI:
      "https://identity-ingress:8443/identity/realms/pdaa/protocol/openid-connect/certs",
    OIDC_CLIENT_ID: "pdaa-web",
    OIDC_AUDIENCE: "pdaa-api",
    OIDC_SCOPE: "openid pdaa.read",
    OIDC_GROUP_ROLE_MAP: '{"project-managers":["project_manager"],"pmo-admins":["pmo_admin"],"leadership":["leadership"],"operators":["system_admin"]}',
    PDAA_API_IMAGE: "unused-api:base",
    PDAA_WORKER_IMAGE: "unused-worker:base",
    PDAA_WEB_IMAGE: images.web,
    PDAA_OPERATIONS_IMAGE: images.operations,
    PDAA_ACCEPTANCE_IMAGE: images["xlsx-proof"],
    PDAA_XLSX_API_IMAGE: images["api-xlsx"],
    PDAA_XLSX_DECODER_IMAGE: images["xlsx-decoder"],
    PDAA_XLSX_BROWSER_IMPORT: "enabled",
    PDAA_XLSX_BROWSER_EVIDENCE_IMAGE: images.acceptance,
    PDAA_XLSX_BROWSER_FIXTURE_DIR: hostPath(browserProof),
    PDAA_ACCEPTANCE_RUN_ID: run,
    PDAA_CUSTOMER_PROFILE: profile,
    PDAA_ARTIFACT_DIR: "/workspace/artifacts/" + run + "/" + profile,
  };
  const base = [
    "compose",
    "--env-file",
    emptyEnv,
    "-p",
    project,
    "-f",
    "deploy/customer/compose.yaml",
    ...(profile === "bundled"
      ? ["-f", "deploy/customer/bundled-database.yaml"]
      : []),
  ];
  const fixture = [
    "-f",
    "deploy/acceptance/customer-fixtures.yaml",
    "--profile",
    "test",
    "--profile",
    "operations",
    ...(profile === "external" ? ["--profile", "external"] : []),
  ];
  const call = (step, args, timeout) => docker(profile + "-" + step, args, env, timeout);
  const composeArgs = (...args) => [
    ...base,
    "-f",
    "deploy/customer/xlsx-decoder.yaml",
    ...fixture,
    "-f",
    "deploy/acceptance/xlsx-browser-fixture.yaml",
    ...args,
  ];
  const compose = (step, ...args) => call(step, composeArgs(...args));
  const defaultModel = JSON.parse(
    call("default-config", [...base, ...fixture, "config", "--format", "json"]),
  );
  assert.equal(defaultModel.services["xlsx-decoder"], undefined);
  assert.equal(
    defaultModel.services.api.environment.PDAA_XLSX_DECODER_MODE,
    undefined,
  );
  assert.equal(defaultModel.services.api.environment.PDAA_XLSX_BROWSER_IMPORT, undefined);
  const model = JSON.parse(
    compose("opt-in-config", "config", "--format", "json"),
  );
  const attached = Object.entries(model.services).filter(([, service]) =>
    service.volumes?.some((volume) => volume.source === "xlsx-link"),
  );
  assert.deepEqual(attached.map(([name]) => name).sort(), [
    "api",
    "xlsx-decoder",
    "xlsx-initialize",
  ]);
  for (const service of ["worker", "backup", "operations", "web", database])
    assert.deepEqual(model.services[service], defaultModel.services[service]);
  assert.equal(
    model.services.api.depends_on["xlsx-decoder"].condition,
    "service_healthy",
  );
  assert.equal(model.services.api.environment.PDAA_XLSX_BROWSER_IMPORT, "enabled");
  assert.deepEqual(model.services["xlsx-browser"].secrets.map(({ source }) => source).sort(),
    ["xlsx-browser-ca.crt", "xlsx-browser-login"]);

  let composed = false;
  const fixtureMount = "type=bind,src=" + hostPath(secrets) + ",dst=/fixture";
  active.set(project, () => {
    if (composed) {
      compose("stop", "down", "--volumes", "--remove-orphans");
      composed = false;
    }
    // The fixture generator changes ownership inside this run-owned mount.
    // Return it to the host runner only after all project containers stop.
    if (process.getuid && process.getgid) {
      call("restore-fixture-ownership", [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--mount",
        fixtureMount,
        images["xlsx-proof"],
        "chown",
        "-Rh",
        process.getuid() + ":" + process.getgid(),
        "/fixture",
      ]);
    }
  });
  call("generate-synthetic-secrets", [
    "run",
    "--rm",
    "--network",
    "none",
    "-e",
    "PDAA_ACCEPTANCE=isolated",
    "--mount",
    fixtureMount,
    images["xlsx-proof"],
    "node",
    "scripts/acceptance/prepare-customer.mjs",
  ]);
  composed = true;
  compose(
    "start-database",
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "90",
    database,
  );
  compose("provision", "run", "--rm", "--no-deps", "operations", "provision");
  const ownerProof = (step, action, ...args) =>
    JSON.parse(
      compose(
        step,
        "run",
        "--rm",
        "--no-deps",
        "verify",
        "node",
        "scripts/acceptance/xlsx-customer-proof.mjs",
        action,
        ...args,
      ),
    );
  const seed = ownerProof("prepare-previews", "prepare");
  assert.deepEqual(seed.bindings.map(({ profile }) => profile).sort(), [
    "excel-text-v1",
    "portable-v1",
  ]);
  const workbookHashes = new Map();
  for (const { profile, projectId } of seed.bindings) {
    assert.match(projectId, /^[0-9a-f-]{36}$/u);
    const values = [
      ["Key", "Project", "Status", "Forecast"],
      ["0001", projectId, "On track", "2027-03-02"],
      ["0002", projectId, "At risk", "2027-04-15"],
    ];
    const parts = profile === "portable-v1" ? fixtureParts : excelTextParts;
    writeFileSync(join(proof, profile + ".xlsx"), book(parts(values)));
    const workbook = customerBrowserBook(profile, projectId);
    writeFileSync(join(browserProof, profile + ".xlsx"), workbook);
    workbookHashes.set(profile, createHash("sha256").update(workbook).digest("hex"));
  }
  assert.match(seed.golden.projectId, /^[0-9a-f-]{36}$/u);
  assert.equal(seed.golden.sheet, "Portfolio");
  const goldenWorkbook = book(fixtureParts([
    ["Key", "Project", "Status", "Forecast", "Snapshot"],
    ["release-golden", seed.golden.projectId, "Complete", "2027-03-02", new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()],
  ]));
  const goldenSha256 = createHash("sha256").update(goldenWorkbook).digest("hex");
  writeFileSync(join(browserProof, "golden.xlsx"), goldenWorkbook);
  writeFileSync(join(browserProof, "golden.json"), JSON.stringify({ sourceId: seed.golden.sourceId, sheet: seed.golden.sheet }));
  writeFileSync(join(proof, "bindings.json"), JSON.stringify(seed.bindings));
  writeFileSync(join(browserProof, "bindings.json"), JSON.stringify(
    seed.bindings.map(({ sourceId, profile }) => ({ sourceId, profile })),
  ));
  copyFileSync(
    join(root, "scripts/xlsx-runtime/api-client-proof.mjs"),
    join(proof, "api-client-proof.mjs"),
  );
  compose(
    "start-api-and-decoder",
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "90",
    "api",
  );

  const container = (name) => {
    const id = compose("id-" + name, "ps", "-q", name);
    assert.match(id, /^[0-9a-f]{64}$/u);
    const info = JSON.parse(call("inspect-" + name, ["inspect", id]))[0];
    assert.equal(info.Config.Labels["com.docker.compose.project"], project);
    return info;
  };
  const db = container(database);
  assert.deepEqual(db.HostConfig.PortBindings ?? {}, {});
  const api = container("api");
  checkSocketBoundary(api, container("xlsx-decoder"), project);
  assert(!api.Config.Env.some((entry) => entry.startsWith("PDAA_REPLY_INTERPRETATION_FILE=")));
  const client = JSON.parse(
    compose(
      "packaged-api-preview",
      "run",
      "--rm",
      "--no-deps",
      "-e",
      "PDAA_XLSX_PROOF_ID=" + run,
      "-v",
      hostPath(proof) + ":/proof:ro",
      "--entrypoint",
      "node",
      "api",
      "/proof/api-client-proof.mjs",
    ),
  );
  assert.equal(client.actualApiRole, true);
  assert.equal(client.tls, true);
  assert.equal(client.exactReplayWithoutAdmission, true);
  assert.equal(client.wrongPeerDenied, true);
  const verified = ownerProof(
    "verify-previews",
    "verify",
    JSON.stringify({
      canonicalSha256: seed.canonicalSha256,
      results: client.results,
    }),
  );
  assert.deepEqual(verified, {
    proposalsOnly: true,
    canonicalStateUnchanged: true,
    verifiedContexts: 2,
  });
  // The API and decoder are running. The initializer rejects their live socket.
  compose("start-web-and-identity", "up", "-d", "--no-deps", "--wait", "--wait-timeout", "90",
    "web", "identity", "identity-ingress");
  assert.equal(container("web").Image, images.web);
  const browser = JSON.parse(call(
    "packaged-browser",
    composeArgs("run", "--rm", "--no-deps", "xlsx-browser"),
    240_000,
  ));
  const browserExpectation = {
    canonicalSha256: seed.canonicalSha256,
    bridge: client.results,
    results: browser.results.map((result) => ({
      ...result, workbookSha256: workbookHashes.get(result.profile),
    })),
  };
  const browserVerified = ownerProof("verify-browser-receipts", "verify-browser", JSON.stringify(browserExpectation));
  assert.deepEqual(browserVerified, { canonicalStateUnchanged: true, verifiedReviewedImports: 2 });
  assert.equal(browser.golden.sourceId, seed.golden.sourceId);
  assert.match(browser.golden.reviewedReceiptId, /^[0-9a-f-]{36}$/u);
  const admitted = ownerProof("golden-admit-sources", "golden-admit", JSON.stringify({
    ...seed.golden, reviewedReceiptId: browser.golden.reviewedReceiptId,
    workbookSha256: goldenSha256, canonicalSha256: seed.canonicalSha256,
  }));
  assert.equal(admitted.projectId, seed.golden.projectId);
  assert.deepEqual(admitted.positions.map(({ type }) => type).sort(), ["jira.issue", "jira.issue", "jira.issue", "xlsx.row"]);
  const goldenBrowser = (phase, fixture) => JSON.parse(call(
    phase, composeArgs("run", "--rm", "--no-deps", "xlsx-browser",
      "node", "scripts/acceptance/xlsx-customer-browser.mjs", phase, JSON.stringify(fixture)), 240_000,
  ));
  const journey = goldenBrowser("golden-reconciliation", admitted);
  assert.equal(journey.projectAndFactRevocations, true);
  assert.equal(journey.noAi.pptxRendered, true);
  assert.match(journey.noAi.staleUpdateAssessedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(journey.noAi.healthAssessmentId, /^[a-f0-9-]{36}$/u);
  const golden = { ...admitted, ...journey };
  assert.deepEqual(ownerProof("golden-withdraw-jira", "golden-withdraw-jira", JSON.stringify(golden)), { active: false });
  assert.deepEqual(goldenBrowser("golden-jira-denial", golden), { jiraScopeRevocation: true });
  assert.deepEqual(ownerProof("golden-regrant-jira", "golden-regrant-jira", JSON.stringify(golden)), { active: true });
  assert.deepEqual(ownerProof("golden-purge-workbook", "golden-purge-workbook", JSON.stringify(golden)), { redactedProposals: 1 });
  assert.deepEqual(goldenBrowser("golden-redelivery", golden), { originalEvidenceRedelivered: true });
  const { canonicalSha256, ...goldenProof } = ownerProof("golden-verify", "golden-verify", JSON.stringify(golden));
  assert.match(canonicalSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(canonicalSha256, seed.canonicalSha256);
  assert.deepEqual(goldenProof, { verifiedSourceWitnesses: 4, durablePmRequests: 1, verifiedChecks: 2, legacyProofs: 1, redactedProposals: 1 });
  const backup = operationResult(compose("backup-browser-receipts", "run", "--rm", "--no-deps", "backup"),
    "backup", env.CUSTOMER_ID);
  assert.equal(backup.encrypted, true);
  assert.match(backup.file, /^backup-[a-zA-Z0-9-]+\.pdaa$/u);
  assert.deepEqual(ownerProof("create-restore-target", "create-restore-target"), { restoreTargetCreated: true });
  const restore = operationResult(compose(
    "restore-browser-receipts", "run", "--rm", "--no-deps",
    "-e", "PDAA_DB_NAME=pdaa_xlsx_restore",
    "-e", "PDAA_OPS_TARGET=" + database + ":5432/pdaa_xlsx_restore",
    "operations", "restore", backup.file,
  ), "restore", env.CUSTOMER_ID);
  assert.equal(restore.quarantine, true);
  assert.equal(restore.applicationStarted, false);
  const recovery = ownerProof("verify-restored-browser", "verify-restored-browser",
    JSON.stringify({ ...browserExpectation, golden: { ...golden, canonicalSha256 } }));
  assert.deepEqual(recovery, {
    canonicalStateUnchanged: true, verifiedReviewedImports: 2, quarantined: true, finiteReceiptReadGrants: true,
    golden: goldenProof,
    restoredDelivery: { scopedPmRedelivery: true, deniedNonRecipient: true, exactReplay: true, priorLegacyProofUnchanged: true },
  });
  active.get(project)();
  active.delete(project);
  return {
    profile,
    databaseImage: db.Image,
    apiImage: images["api-xlsx"],
    decoderImage: images["xlsx-decoder"],
    profiles: client.results.map(({ profile }) => profile),
    ...verified,
    actualApiRole: true,
    tls: true,
    exactReplayWithoutAdmission: true,
    wrongPeerDenied: true,
    readOnlySocket: true,
    browser: {
      webImage: images.web,
      verifierImage: images.acceptance,
      toolchain: browser.toolchain,
      bothParserProfiles: true,
      trustedTlsAndOidc: true,
      exactHttpReplay: true,
      protectedReloadAndDenial: true,
      ...browserVerified,
    },
    golden003: {
      ...goldenProof, projectAndFactRevocations: true, jiraScopeRevocation: true, originalEvidenceRedelivered: true,
    },
    noAi: { providerConfigured: false, ...journey.noAi },
    recovery: { encrypted: true, ...recovery },
  };
}

const errors = [];
let lockSha256;
try {
  mkdirSync(join(root, "artifacts"), { recursive: true });
  rmSync(evidence, { force: true });
  assert.equal(
    docker("linux-docker", [
      "info",
      "--format",
      "{{.OSType}} {{.CgroupVersion}}",
    ]),
    "linux 2",
  );
  const context = join(local, "decoder-context");
  ({ lockSha256 } = stageProduction(context));
  for (const name of targetNames) {
    const args =
      name === "xlsx-decoder"
        ? ["--network", "none", context]
        : ["--target", name, "-f", "deploy/Dockerfile", "."];
    built.push(name);
    docker(
      "build-" + name,
      ["build", "--load", "-t", names[name], ...args],
      {},
      900_000,
    );
    images[name] = docker("image-" + name, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      names[name],
    ]);
    assert.match(images[name], /^sha256:[0-9a-f]{64}$/u);
  }
  for (const profile of ["bundled", "external"])
    results.push(exercise(profile));
  assert.equal(results.length, 2);
} catch (error) {
  errors.push(error);
} finally {
  for (const cleanup of active.values()) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const name of built.reverse()) {
    try {
      const tag = docker("find-" + name, [
        "image",
        "ls",
        "-q",
        "--filter",
        "reference=" + names[name],
      ]);
      if (tag) docker("remove-" + name, ["image", "rm", names[name]]);
    } catch (error) {
      errors.push(error);
    }
  }
}
if (errors.length)
  throw new AggregateError(errors, "Private XLSX rehearsal logs at " + local);
rmSync(local, { recursive: true, force: true });
writeFileSync(
  evidence,
  JSON.stringify({ profiles: results, lockSha256 }, null, 2) + "\n",
  { flag: "wx" },
);
console.log("Packaged XLSX customer bridge rehearsal passed");
