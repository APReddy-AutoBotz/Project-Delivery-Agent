import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadDatabaseConfig } from "../../packages/platform/dist/index.js";
export const { Pool } = createRequire(
  new URL("../../packages/data/package.json", import.meta.url),
)("pg");
export const secret = (name) => readFileSync(`/run/secrets/${name}`, "utf8");
export function guard() {
  if (
    process.env.PDAA_ACCEPTANCE !== "isolated" ||
    process.env.DATA_MODE !== "synthetic" ||
    process.env.DEPLOYMENT_MODE !== "customer" ||
    process.env.NODE_ENV !== "production" ||
    process.env.PDAA_DB_HOST !== "database" ||
    process.env.PDAA_DB_NAME !== "pdaa" ||
    secret("ready") !== "isolated synthetic acceptance\n"
  )
    throw new Error("Isolated acceptance fixture required");
}
export function config(
  host = "database",
  user = "pdaa_migrate",
  file = "migration-password",
) {
  if (!["database", "external-database", "database-alias"].includes(host))
    throw new Error("Unknown fixture target");
  return loadDatabaseConfig({
    ...process.env,
    PDAA_DB_HOST: host,
    PDAA_DB_USER: user,
    PDAA_DB_PASSWORD_FILE: `/run/secrets/${file}`,
  });
}
export function migrate(host, patch = {}) {
  const result = spawnSync(
    process.execPath,
    ["../../node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: "/workspace/packages/data",
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, PDAA_DB_HOST: host, ...patch },
    },
  );
  // Raw engine errors can contain infrastructure or credentials. Never return them.
  return result.status === 0;
}
