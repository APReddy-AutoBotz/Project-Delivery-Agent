import { createApp } from "../../apps/api/dist/app.js";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectRepository, DatabaseProjectUpdateRepository,
} from "../../packages/data/dist/index.js";
import { assertSyntheticDatabaseUrl, loadConfig } from "../../packages/platform/dist/index.js";

const url = assertSyntheticDatabaseUrl(process.env.PDAA_DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
    !/^\/pdaa_test_[0-9]+$/.test(url.pathname) || !process.send)
  throw new Error("The reference dashboard requires an isolated synthetic database and parent process");
const config = loadConfig(process.env);
const db = createDatabase(url.toString());
const updates = new DatabaseProjectUpdateRepository(db, null, null, undefined, false, undefined, undefined,
  config.projectReportSchedule);
const { app } = await createApp(config, new DatabaseProjectRepository(db), undefined,
  new DatabaseCanonicalProjectRepository(db), undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, updates);
let stop;
const shutdown = () => stop ??= (async () => {
  await app.close();
  await db.$disconnect();
  process.exit(0);
})();
process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);
await app.listen(0, "127.0.0.1");
process.send({ origin: await app.getUrl(), pid: process.pid });
