import { spawnSync } from "node:child_process";
import {
  createDatabase,
  DatabaseProjectRepository,
} from "../packages/data/dist/index.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  assertSyntheticDatabaseUrl,
  CredentialVault,
} from "../packages/platform/dist/index.js";
const url = assertSyntheticDatabaseUrl(
  process.env.PDAA_DATABASE_URL ?? "",
  "pdaa",
);
if (
  process.env.NODE_ENV === "production" ||
  process.env.DATA_MODE !== "synthetic" ||
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.pathname !== "/pdaa"
)
  throw new Error("Recovery rehearsal requires the local synthetic workspace");
const target = "pdaa_restore_" + Date.now();
const sourceName = JSON.parse(
  readFileSync("artifacts/database-validation.json", "utf8"),
).databaseName;
if (typeof sourceName !== "string" || !/^pdaa_test_[0-9]+$/.test(sourceName))
  throw new Error("No successful isolated rehearsal database recorded");
const dump = "/tmp/" + target + ".dump";
const dockerEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|COMPOSE_)/.test(
        key,
      ),
  ),
);
const endpoint =
  process.platform === "win32"
    ? "npipe:////./pipe/dockerDesktopLinuxEngine"
    : "unix:///var/run/docker.sock";
function docker(args, capture = false) {
  const result = spawnSync(
    "docker",
    [
      "--host",
      endpoint,
      "compose",
      "-f",
      fileURLToPath(new URL("../compose.yaml", import.meta.url)),
      "-p",
      "pdaa-foundation",
      "exec",
      "-T",
      "database",
      ...args,
    ],
    {
      env: dockerEnvironment,
      stdio: capture ? "pipe" : "inherit",
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error("Recovery step failed");
  return result.stdout?.trim();
}
const check = createDatabase(url.toString());
try {
  const rows =
    await check.$queryRaw`SELECT system_identifier::text AS id FROM pg_control_system()`;
  const dockerCluster = docker(
    [
      "psql",
      "-U",
      "pdaa",
      "-d",
      "pdaa",
      "-Atc",
      "SELECT system_identifier::text FROM pg_control_system()",
    ],
    true,
  );
  if (rows[0]?.id !== dockerCluster)
    throw new Error(
      "Recovery container does not match the validated local database",
    );
} finally {
  await check.$disconnect();
}
docker(["pg_dump", "-U", "pdaa", "-d", sourceName, "-Fc", "-f", dump]);
docker(["createdb", "-U", "pdaa", target]);
docker(["pg_restore", "-U", "pdaa", "-d", target, "--exit-on-error", dump]);
url.pathname = "/" + sourceName;
const original = createDatabase(url.toString());
url.pathname = "/" + target;
const restored = createDatabase(url.toString());
try {
  const expected = await original.auditEvent.count();
  const actual = await restored.auditEvent.count();
  if (
    expected < 2 ||
    actual !== expected ||
    (await restored.project.count()) !== (await original.project.count())
  )
    throw new Error("Restored data does not match");
  const row = await restored.auditEvent.findFirstOrThrow();
  for (const table of [
    "project",
    "accessGrant",
    "auditEvent",
    "connectorCredential",
  ]) {
    if (
      JSON.stringify(
        await original[table].findMany({ orderBy: { id: "asc" } }),
      ) !==
      JSON.stringify(await restored[table].findMany({ orderBy: { id: "asc" } }))
    )
      throw new Error("Restored rows do not match");
  }
  const credential = await restored.connectorCredential.findFirstOrThrow();
  if (
    new CredentialVault(process.env.ENCRYPTION_KEY).decrypt(
      credential.envelope,
      process.env.CUSTOMER_ID + ":synthetic",
    ) !== "fixture-token"
  )
    throw new Error("Restored credential cannot be decrypted");
  const visible = await new DatabaseProjectRepository(restored).listProjects({
    subject: "pm-atlas",
    roles: ["project_manager"],
    customerId: process.env.CUSTOMER_ID,
  });
  if (visible.length !== 1 || visible[0].code !== "ATL")
    throw new Error("Restored permissions differ");
  for (const operation of [
    () =>
      restored.auditEvent.update({
        where: { id: row.id },
        data: { event: "changed" },
      }),
    () => restored.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent"'),
  ]) {
    let blocked = false;
    try {
      await operation();
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error("Restored audit mutation was permitted");
  }
  let denied = false;
  try {
    await restored.auditEvent.delete({ where: { id: row.id } });
  } catch {
    denied = true;
  }
  if (!denied) throw new Error("Restored audit protection missing");
  console.log(
    `Recovery passed: ${actual} audit events and project counts match; audit immutability remains active. Restored database: ${target}. No application was started against it.`,
  );
} finally {
  await original.$disconnect();
  await restored.$disconnect();
}
