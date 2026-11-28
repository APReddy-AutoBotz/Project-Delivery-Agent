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
  DatabaseHealthAssessmentRepository,
  DatabaseProjectUpdateRepository,
  DatabasePmActionQueueRepository,
  DatabaseBlockerAgeAdviceRepository,
  DatabaseMilestoneConflictObservationRepository,
  DatabaseScalarConflictObservationRepository,
  DatabaseMilestoneStateDisagreementRepository,
} from "@pdaa/data";
import {
  loadConfig,
  operationalLog,
  installFatalHandlers,
  CredentialKeyRingVault,
  CredentialVault,
  loadCapturedReplyInterpreter,
} from "@pdaa/platform";
import { createApp } from "./app.js";
import { JiraRuntimeService } from "./jira-runtime.js";
import { installConnectorRoutes } from "./connector-routes.js";
import { installScheduledReportRoutes } from "./scheduled-report-routes.js";
import { createConfiguredXlsxDecoder } from "./xlsx-runtime.js";
import { installForgeJiraStagingRoute, loadForgeJiraStagingBinding } from "./forge-jira-staging.js";
installFatalHandlers("api");
try {
  const config = loadConfig(process.env);
  const forgeJiraStaging = loadForgeJiraStagingBinding(process.env.PDAA_FORGE_JIRA_STAGING_FILE);
  const db = createDatabase(config.database);
  const xlsxDecoder = createConfiguredXlsxDecoder(process.env.PDAA_XLSX_DECODER_MODE, config);
  const xlsxImportMode = process.env.PDAA_XLSX_BROWSER_IMPORT ?? "disabled";
  if (xlsxImportMode !== "disabled" && (xlsxImportMode !== "enabled" || !xlsxDecoder))
    throw new Error("XLSX_IMPORT_CONFIGURATION");
  const ingestion = new DatabaseIngestionRepository(
    db,
    new CredentialVault(config.ENCRYPTION_KEY),
    xlsxDecoder,
  );
  const healthAssessment = new DatabaseHealthAssessmentRepository(db);
  const projectUpdates = new DatabaseProjectUpdateRepository(
    db,
    config.projectUpdateServiceSubject,
    config.projectUpdateZones,
    () => ({ globalShadowMode: config.SHADOW_MODE, configuration: config.projectUpdateCapture }),
    config.AUTH_MODE === "development" && config.DATA_MODE === "synthetic" &&
      config.NODE_ENV !== "production" && config.DEPLOYMENT_MODE === "local",
    loadCapturedReplyInterpreter(process.env.PDAA_REPLY_INTERPRETATION_FILE, config),
    ingestion,
    config.projectReportSchedule,
  );
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
    (target) => {
      installForgeJiraStagingRoute(target, forgeJiraStaging);
      installConnectorRoutes(target, config, connectorRuntime, new JiraRuntimeService(config, connectorRuntime, ingestion), projectUpdates);
      installScheduledReportRoutes(target, config, connectorRuntime, projectUpdates);
    },
    ingestion,
    healthAssessment,
    projectUpdates,
    new DatabasePmActionQueueRepository(db, projectUpdates),
    new DatabaseBlockerAgeAdviceRepository(db),
    new DatabaseMilestoneConflictObservationRepository(db),
    new DatabaseScalarConflictObservationRepository(db),
    new DatabaseMilestoneStateDisagreementRepository(db),
    new DatabaseMilestoneConflictObservationRepository(db),
    xlsxImportMode === "enabled" ? ingestion : null,
  );
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
