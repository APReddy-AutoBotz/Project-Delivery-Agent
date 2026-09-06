import { defineConfig } from "prisma/config";
import { assertSyntheticDatabaseUrl } from "../platform/src/database-target.ts";
try {
  process.loadEnvFile("../../.env");
} catch {
  /* CI provides environment directly. */
}
if (process.env.DATA_MODE === "synthetic" && process.env.PDAA_DATABASE_URL)
  assertSyntheticDatabaseUrl(process.env.PDAA_DATABASE_URL);
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url:
      process.env.PDAA_DATABASE_URL ??
      "postgresql://localhost/pdaa_unconfigured",
  },
});
