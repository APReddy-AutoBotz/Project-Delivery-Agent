import { writeFileSync, readFileSync } from "node:fs";
import {
  assertContractSnapshot,
  compileContract,
} from "./validate-openapi.mjs";
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
  const path = "docs/03-architecture/OPENAPI_FOUNDATION.json";
  compileContract(spec);
  if (process.argv.includes("--check")) {
    assertContractSnapshot(spec, JSON.parse(readFileSync(path, "utf8")));
    console.log("Generated OpenAPI matches the committed contract.");
  } else {
    writeFileSync(path, JSON.stringify(spec, null, 2) + "\n");
    console.log("Exported the foundation API contract.");
  }
} finally {
  await app.close();
  await db.$disconnect();
}
