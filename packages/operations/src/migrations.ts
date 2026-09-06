import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import type { DatabaseTransport } from "@pdaa/platform";
import { connect, assertPostgres17, lock } from "./config.js";
import { validateMigrationSql } from "./sql.js";

export type Migration = { name: string; checksum: string; sql: string };
type Entry = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: number;
};
export function readMigrations(directory: string): Migration[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      if (!/^\d{12}(?:\d{2})?_[a-z0-9_]+$/.test(entry.name))
        throw new Error("Invalid migration name");
      const path = join(directory, entry.name, "migration.sql");
      if (!lstatSync(path).isFile())
        throw new Error("Migration must be a regular file");
      const sql = readFileSync(path, "utf8");
      validateMigrationSql(sql);
      return {
        name: entry.name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!migrations.length) throw new Error("No release migrations");
  return migrations;
}
export function validateHistory(rows: Entry[], migrations: Migration[]) {
  if (rows.length > migrations.length)
    throw new Error("Unknown migration history");
  rows.forEach((row, index) => {
    const expected = migrations[index];
    if (
      !row.finished_at ||
      row.rolled_back_at ||
      row.applied_steps_count !== 1 ||
      row.migration_name !== expected?.name ||
      row.checksum !== expected.checksum
    )
      throw new Error("Incomplete or divergent migration history");
  });
}
export async function history(client: Client): Promise<Entry[]> {
  return (
    await client.query(
      'SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name,started_at',
    )
  ).rows;
}
export async function migrateDatabase(
  database: DatabaseTransport,
  migrations: Migration[],
) {
  for (const migration of migrations) {
    validateMigrationSql(migration.sql);
    if (
      migration.checksum !==
      createHash("sha256").update(migration.sql).digest("hex")
    )
      throw new Error("Migration checksum mismatch");
  }
  const client = await connect(database);
  try {
    await client.query("SET standard_conforming_strings=on");
    await assertPostgres17(client);
    await lock(client);
    const present = (
      await client.query(
        "SELECT to_regclass('public._prisma_migrations') AS name",
      )
    ).rows[0].name;
    if (!present) {
      if (
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
          )
        ).rows[0].n !== 0
      )
        throw new Error("Refuse to adopt an untracked database");
      // Pinned Prisma 7.10 ledger contract; bidirectional compatibility is tested.
      await client.query(`CREATE TABLE "_prisma_migrations" (
        id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
        finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text,
        rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
        applied_steps_count integer NOT NULL DEFAULT 0)`);
    }
    const applied = await history(client);
    validateHistory(applied, migrations);
    for (const migration of migrations.slice(applied.length)) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO "_prisma_migrations" (id,checksum,migration_name,finished_at,applied_steps_count) VALUES ($1,$2,$3,now(),1)',
          [randomUUID(), migration.checksum, migration.name],
        );
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        throw new Error(
          "Migration rolled back; no successful version recorded",
        );
      }
    }
    return (await history(client)).map((row) => ({
      name: row.migration_name,
      checksum: row.checksum,
    }));
  } finally {
    await client.end();
  }
}
