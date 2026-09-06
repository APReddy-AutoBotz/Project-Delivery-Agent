import { createDatabase, DatabaseProjectRepository } from "@pdaa/data";
import { loadConfig, operationalLog } from "@pdaa/platform";
import { createApp } from "./app.js";
try {
  const config = loadConfig(process.env);
  const db = createDatabase(config.PDAA_DATABASE_URL);
  const { app } = await createApp(config, new DatabaseProjectRepository(db));
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, config.API_HOST);
  operationalLog("api.started");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, async () => {
      await app.close();
      await db.$disconnect();
      process.exit(0);
    });
} catch {
  operationalLog("api.start_failed");
  process.exit(1);
}
