import {
  createDatabase,
  DatabaseProjectRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectFactRepository,
  DatabaseAuthorityRepository,
  DatabaseMilestoneReconciliationRepository,
  DatabaseScalarReconciliationRepository,
  DatabaseConnectorRuntimeRepository,
  DatabaseIngestionRepository,
} from "@pdaa/data";
import {
  loadConfig,
  operationalLog,
  installFatalHandlers,
  CredentialKeyRingVault,
  CredentialVault,
} from "@pdaa/platform";
import { createApp } from "./app.js";
import { JiraRuntimeService } from "./jira-runtime.js";
import { installConnectorRoutes } from "./connector-routes.js";
installFatalHandlers("api");
try {
  const config = loadConfig(process.env);
  const db = createDatabase(config.database);
  const ingestion = new DatabaseIngestionRepository(db, new CredentialVault(config.ENCRYPTION_KEY));
  const connectorRuntime = new DatabaseConnectorRuntimeRepository(db, new CredentialKeyRingVault(config.credentialKeys));
  const { app } = await createApp(
    config,
    new DatabaseProjectRepository(db),
    undefined,
    new DatabaseCanonicalProjectRepository(db),
    new DatabaseProjectFactRepository(db),
    new DatabaseAuthorityRepository(db),
    new DatabaseMilestoneReconciliationRepository(db),
    new DatabaseScalarReconciliationRepository(db),
  );
  installConnectorRoutes(app, config, connectorRuntime, new JiraRuntimeService(config, connectorRuntime, ingestion));
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
