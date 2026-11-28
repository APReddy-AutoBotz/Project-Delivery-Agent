import { randomUUID } from "node:crypto";
import { JiraRuntimeService } from "../../apps/api/dist/jira-runtime.js";
import { DatabaseConnectorRuntimeRepository, DatabaseIngestionRepository, createDatabase } from "../../packages/data/dist/index.js";
import type { Actor } from "../../packages/domain/src/index.js";
import { CredentialVault, type Config } from "../../packages/platform/dist/index.js";

export async function seedReferenceJira(db: ReturnType<typeof createDatabase>, config: Config,
  runtime: DatabaseConnectorRuntimeRepository, administrator: Actor, portfolioId: string, projectIds: string[]) {
  const sourceAdministrator: Actor = { customerId: config.CUSTOMER_ID, subject: "reference-source-administrator", roles: ["system_admin"] };
  await db.accessGrant.create({ data: { customerId: config.CUSTOMER_ID, subject: sourceAdministrator.subject,
    scopeType: "portfolio", scopeId: portfolioId, role: "system_admin" } });
  const ingestion = new DatabaseIngestionRepository(db, new CredentialVault(config.ENCRYPTION_KEY));
  await ingestion.setRetention(sourceAdministrator, { retentionHours: 24 }, randomUUID());
  const sourceProjects = new Map<string, { projectId: string; projectKey: string }[]>();
  const resources = [];
  const projectsPerSource = 100;
  for (let first = 0; first < projectIds.length; first += projectsPerSource) {
    const number = 1 + first / projectsPerSource;
    const origin = `https://reference-${number}.atlassian.net`, cloudId = `reference-cloud-${number}`;
    const sourceId = randomUUID();
    const projects = projectIds.slice(first, first + projectsPerSource).map((projectId, index) => ({
      projectId, projectKey: `REF${String(first + index + 1).padStart(3, "0")}`,
    }));
    await ingestion.configure(administrator, {
      binding: { customerId: config.CUSTOMER_ID, origin, sourceId, sourceType: "jira" },
      projects: projects.map(({ projectId }) => ({ projectId, readers: [administrator.subject] })),
      mapping: { kind: "CONNECTOR", factTypes: ["jira.status"],
        adapterConfiguration: JSON.stringify({ projects, pageSize: projectsPerSource,
          fields: [{ jiraField: "status", factType: "jira.status", valueType: "text" }] }) },
    }, randomUUID());
    await runtime.setOAuthCredential({
      customerId: config.CUSTOMER_ID, sourceId, actorSubject: administrator.subject,
      credential: { cloudId, selectedUrl: origin, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        accessToken: "synthetic-reference-access", refreshToken: "synthetic-reference-refresh",
        scopes: ["read:jira-work", "offline_access"] },
    });
    sourceProjects.set(cloudId, projects);
    resources.push({ id: cloudId, url: origin, scopes: ["read:jira-work"] });
  }
  const observedAt = new Date().toISOString();
  let synchronize = false;
  let resume!: () => void;
  const readyToSynchronize = new Promise<void>((resolve) => { resume = resolve; });
  const service = new JiraRuntimeService(config, runtime, ingestion, async () => Response.json(resources), ({ cloudId }) => {
    const projects = sourceProjects.get(cloudId);
    if (!projects) throw new Error("Synthetic Jira resource unavailable");
    return {
      getProject: async ({ projectIdOrKey }) => ({ key: projectIdOrKey }),
      getIssue: async () => { throw new Error("Unexpected single-issue read in the reference synchronization"); },
      searchIssues: async () => {
        synchronize = true;
        await readyToSynchronize;
        return { issues: projects.map(({ projectKey }, index) => ({
          id: String(1 + index), key: `${projectKey}-1`,
          fields: { project: { id: String(1 + index), key: projectKey }, updated: observedAt, status: { name: "In progress" } },
        })), isLast: true };
      },
    };
  });
  return { service, waitForRead: () => synchronize, resume, sourceCount: sourceProjects.size };
}
