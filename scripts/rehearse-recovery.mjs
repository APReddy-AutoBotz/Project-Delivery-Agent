import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  createDatabase,
  DatabaseProjectRepository,
} from "../packages/data/dist/index.js";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { canonicalTables } from "./acceptance/canonical-projects.mjs";
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
  const tables = [
    "Customer",
    "Portfolio",
    "Project",
    "AccessGrant",
    "AuditEvent",
    "ConnectorCredential",
    "ServiceHeartbeat",
    "_prisma_migrations",
    "ProjectFact",
    "FactSource",
    "FactSourceAccess",
    "FactSourceReader",
    "FactEvidence",
    "ProjectFactVersion",
    "FactAppendReceipt",
    "AuthorityPolicy",
    "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt",
    "FactAuthorityConflict",
    "FactAssessment",
    "FactAssessmentVersion",
    "FactAssessmentConflict",
    "Programme",
    "CanonicalProject",
    "ProjectResponsibility",
    "Sprint",
    "Milestone",
    "WorkItem",
    "RequiredWorkItem",
    "RaidItem",
    "CanonicalSourceMapping",
    "CanonicalCreationReceipt",
  ];
  for (const table of tables) {
    const sql = `SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`;
    assert.deepEqual(
      await restored.$queryRawUnsafe(sql),
      await original.$queryRawUnsafe(sql),
      "Restored " + table + " rows must match",
    );
  }
  assert((await restored.projectFactVersion.count()) > 0);
  assert((await restored.factAssessment.count()) > 0);
  for (const table of canonicalTables)
    assert(
      (
        await restored.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "${table}"`,
        )
      )[0].n > 0,
      "Canonical recovery fixture must populate " + table,
    );
  assert.equal(
    (
      await restored.$queryRaw`SELECT
    (SELECT count(*)::int FROM "AuthorityPolicy" WHERE NOT public.valid_authority_history(id)) +
    (SELECT count(*)::int FROM "FactAuthorityConflict" WHERE NOT public.valid_authority_conflict(id)) +
    (SELECT count(*)::int FROM (SELECT "factId" FROM "FactAuthorityConflict" GROUP BY "factId" HAVING count(*)<>max(revision)) drift) +
    (SELECT count(*)::int FROM "FactAssessment" WHERE NOT sealed OR NOT public.valid_fact_assessment(id)) +
    (SELECT count(*)::int FROM "Programme" WHERE NOT public.valid_canonical_programme(id)) +
    (SELECT count(*)::int FROM "CanonicalProject" WHERE NOT sealed OR NOT public.valid_canonical_project(id)) AS invalid`
    )[0].invalid,
    0,
  );
  for (const table of [
    "FactSource",
    "FactEvidence",
    "ProjectFactVersion",
    "FactAppendReceipt",
    "AuthorityPolicyRevision",
    "AuthorityPolicyReceipt",
    "FactAuthorityConflict",
    "FactAssessment",
    ...canonicalTables,
  ]) {
    for (const sql of [
      `UPDATE "${table}" SET id=id`,
      `DELETE FROM "${table}"`,
      `TRUNCATE "${table}" CASCADE`,
    ]) {
      // The transaction always rolls back, including if a protection regresses.
      await assert.rejects(
        () =>
          restored.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(sql);
            throw new Error("History mutation unexpectedly succeeded");
          }),
        (error) => error.message !== "History mutation unexpectedly succeeded",
      );
    }
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
    `Recovery passed: all 31 business tables and the migration ledger match exactly; audit, fact, policy, assessment and canonical history remain immutable. Restored database: ${target}. No application was started against it.`,
  );
} finally {
  await original.$disconnect();
  await restored.$disconnect();
}
