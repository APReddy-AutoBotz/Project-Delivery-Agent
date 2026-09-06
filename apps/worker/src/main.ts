import { run, Logger } from "graphile-worker";
import { createDatabase } from "@pdaa/data";
import { loadConfig, operationalLog } from "@pdaa/platform";
try {
  const config = loadConfig(process.env);
  const db = createDatabase(config.PDAA_DATABASE_URL);
  const runner = await run({
    connectionString: config.PDAA_DATABASE_URL,
    concurrency: 1,
    noHandleSignals: true,
    logger: new Logger(() => () => operationalLog("worker.event")),
    crontab: "* * * * * foundation_heartbeat",
    taskList: {
      foundation_heartbeat: async () => {
        await db.serviceHeartbeat.upsert({
          where: { id: "worker" },
          create: { id: "worker", occurredAt: new Date() },
          update: { occurredAt: new Date() },
        });
      },
    },
  });
  operationalLog("worker.started");
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, async () => {
      await runner.stop();
      await db.$disconnect();
      process.exit(0);
    });
  await runner.promise;
} catch {
  operationalLog("worker.start_failed");
  process.exit(1);
}
