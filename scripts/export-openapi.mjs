import { writeFileSync } from "node:fs";
import { createApp } from "../apps/api/dist/app.js";
import {
  createDatabase,
  DatabaseProjectRepository,
} from "../packages/data/dist/index.js";
import { loadConfig } from "../packages/platform/dist/index.js";
const config = loadConfig(process.env);
const db = createDatabase(config.database);
const { app, spec } = await createApp(
  config,
  new DatabaseProjectRepository(db),
);
try {
  writeFileSync(
    "docs/03-architecture/OPENAPI_FOUNDATION.json",
    JSON.stringify(spec, null, 2) + "\n",
  );
  console.log("Exported the foundation API contract.");
} finally {
  await app.close();
  await db.$disconnect();
}
