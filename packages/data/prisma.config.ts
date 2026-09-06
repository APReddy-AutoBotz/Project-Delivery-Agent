import { defineConfig } from "prisma/config";
import { loadDatabaseConfig, migrationDatabaseUrl } from "@pdaa/platform";
try {
  if (process.env.NODE_ENV !== "production") process.loadEnvFile("../../.env");
} catch {
  /* CI provides environment directly. */
}
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url:
      process.argv.includes("generate") &&
      !process.env.PDAA_DATABASE_URL &&
      !process.env.PDAA_DB_HOST
        ? "postgresql://localhost/pdaa_unconfigured"
        : migrationDatabaseUrl(loadDatabaseConfig(process.env)),
  },
});
