import { resolve } from "node:path";
import { operationalLog, installFatalHandlers } from "@pdaa/platform";
import { loadOperationsConfig } from "./config.js";
import { readMigrations } from "./migrations.js";
import { provision, migrateRelease } from "./provision.js";
import { backup } from "./backup.js";
import { restore } from "./restore.js";
import { backupKey } from "./archive.js";
installFatalHandlers("operations");

try {
  const config = loadOperationsConfig(process.env);
  const migrations = readMigrations(
    resolve(import.meta.dirname, "../migrations"),
  );
  const command = process.argv[2];
  let result: unknown;
  if (command === "provision") result = await provision(config, migrations);
  else if (command === "migrate")
    result = await migrateRelease(config, migrations);
  else if (command === "backup")
    result = await backup(
      config,
      migrations,
      "/backups",
      backupKey(process.env.PDAA_BACKUP_KEY_FILE ?? ""),
    );
  else if (command === "restore")
    result = await restore(
      config,
      migrations,
      "/backups",
      process.argv[3] ?? "",
      backupKey(process.env.PDAA_BACKUP_KEY_FILE ?? ""),
    );
  else throw new Error("Unknown operation");
  console.log(JSON.stringify({ operation: command, status: "passed", result }));
} catch {
  operationalLog("operations.failed");
  process.exitCode = 1;
}
