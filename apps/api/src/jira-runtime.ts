import {
  createJiraOAuthCloudClient,
  createJiraReadOnlyConnector,
  getJiraAccessibleResources,
  JiraOAuthError,
  parseJiraReadAdapterOptions,
  refreshJiraOAuthToken,
} from "@pdaa/connectors-jira";
import type {
  ConnectorChangePage,
  ConnectorFailure,
  IngestionConfiguration,
} from "@pdaa/domain";
import type { Config } from "@pdaa/platform";

type JiraOAuthCredential = {
  cloudId: string;
  selectedUrl: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes: string[];
};
type JiraCredentialRotation = {
  customerId: string;
  sourceId: string;
  operationId: string;
  revision: number;
  configRevision: number;
  mappingRevision: number;
  credentials: JiraOAuthCredential;
};
type JiraOAuthAccess =
  | {
      kind: "access";
      credentials: JiraOAuthCredential;
      configRevision: number;
      mappingRevision: number;
    }
  | { kind: "rotate"; rotation: JiraCredentialRotation }
  | {
      kind: "unavailable";
      reason:
        | "ROTATION_IN_PROGRESS"
        | "REAUTH_REQUIRED"
        | "NOT_CONFIGURED"
        | "STALE_CONFIGURATION";
    };
type RuntimeFailureCode =
  | ConnectorFailure["code"]
  | "INTEGRITY_CONFLICT"
  | "CURSOR_CONFLICT";
type ConnectorRuntimePort = {
  enqueueDueJobs(
    customerId: string,
    intervalMinutes?: number,
    limit?: number,
  ): Promise<string[]>;
  claimNextJob(
    customerId: string,
  ): Promise<{ jobId: string; customerId: string; sourceId: string; claimGeneration: number } | null>;
  accessOrBeginRotation(
    customerId: string,
    sourceId: string,
  ): Promise<JiraOAuthAccess>;
  completeOAuthRotation(
    rotation: JiraCredentialRotation,
    credentials: JiraOAuthCredential,
  ): Promise<{ committed: boolean }>;
  failOAuthRotation(rotation: JiraCredentialRotation): Promise<unknown>;
  deferOAuthRotation(
    rotation: JiraCredentialRotation,
    input: { jobId: string; claimGeneration: number; retryAfterMs?: number | null },
  ): Promise<boolean>;
  failRunningJob(input: {
    customerId: string;
    jobId: string;
    claimGeneration: number;
    code: RuntimeFailureCode;
    retryAfterMs?: number | null;
  }): Promise<unknown>;
};
type JiraSyncSnapshot = {
  jobId: string;
  sourceId: string;
  configRevision: number;
  mappingRevision: number;
  configuration: IngestionConfiguration;
  cursor: string | null;
  cursorRevision: number;
  generation: number;
  resetRequired: boolean;
};
type JiraIngestionPort = {
  readConnectorSyncSnapshot(
    customerId: string,
    jobId: string,
    claimGeneration: number,
  ): Promise<JiraSyncSnapshot>;
  resetConnectorCursorForJob(customerId: string, jobId: string, claimGeneration: number): Promise<unknown>;
  persistConnectorPageForJob(input: {
    customerId: string;
    jobId: string;
    expectedClaimGeneration: number;
    expectedConfigRevision: number;
    expectedMappingRevision: number;
    expectedCursorRevision: number;
    expectedGeneration: number;
    page: ConnectorChangePage;
  }): Promise<unknown>;
};

function hasCode(error: unknown, code: string) {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

class JiraRuntimeError extends Error {
  constructor(readonly code: "STALE_CONFIGURATION" | "MISSING_SCOPE") {
    super(code);
    this.name = "JiraRuntimeError";
  }
}

export class JiraRuntimeService {
  constructor(
    private readonly config: Config,
    private readonly runtime: ConnectorRuntimePort,
    private readonly ingestion: JiraIngestionPort,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async runOne() {
    await this.runtime.enqueueDueJobs(this.config.CUSTOMER_ID, 15, 20);
    const job = await this.runtime.claimNextJob(this.config.CUSTOMER_ID);
    if (!job) return { status: "idle" as const };
    const failRunningJob = (failure: { code: RuntimeFailureCode; retryAfterMs?: number | null }) =>
      this.runtime.failRunningJob({
        customerId: job.customerId,
        jobId: job.jobId,
        claimGeneration: job.claimGeneration,
        ...failure,
      });
    try {
      const snapshot = await this.ingestion.readConnectorSyncSnapshot(job.customerId, job.jobId, job.claimGeneration);
      if (snapshot.resetRequired) {
        await this.ingestion.resetConnectorCursorForJob(job.customerId, job.jobId, job.claimGeneration);
        return { status: "cursor_reset" as const };
      }
      const access = await this.runtime.accessOrBeginRotation(job.customerId, job.sourceId);
      if (access.kind === "unavailable") {
        const code = access.reason === "ROTATION_IN_PROGRESS"
          ? "TEMPORARILY_UNAVAILABLE"
          : access.reason === "STALE_CONFIGURATION"
            ? "INTEGRITY_CONFLICT"
            : "EXPIRED_CREDENTIALS";
        await failRunningJob({ code, retryAfterMs: code === "TEMPORARILY_UNAVAILABLE" ? 15_000 : null });
        return { status: "deferred" as const };
      }

      let credentials = access.kind === "access" ? access.credentials : access.rotation.credentials;
      if (access.kind === "rotate") {
        try {
          const refreshed = await refreshJiraOAuthToken({
            clientId: this.requireClientId(),
            clientSecret: this.requireClientSecret(),
            refreshToken: access.rotation.credentials.refreshToken,
            fetchImpl: this.fetchImpl,
          });
          const updated = {
            ...access.rotation.credentials,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            ...(refreshed.scopes ? { scopes: refreshed.scopes } : {}),
          };
          // Atlassian rotates the refresh token with this response. Persist it
          // before another request so a temporary resource lookup failure does
          // not strand the connection with the old token.
          const committed = await this.runtime.completeOAuthRotation(access.rotation, updated);
          if (!committed.committed) {
            await this.runtime.failOAuthRotation(access.rotation);
            await failRunningJob({ code: "EXPIRED_CREDENTIALS" });
            return { status: "reauthorization_required" as const };
          }
          this.assertSelectedCloud(await getJiraAccessibleResources({ accessToken: refreshed.accessToken, fetchImpl: this.fetchImpl }), updated.cloudId, updated.selectedUrl);
          credentials = updated;
        } catch (error) {
          const code = this.oauthFailure(error);
          const retryAfterMs = error instanceof JiraOAuthError ? error.retryAfterMs : null;
          if (code === "RATE_LIMITED") {
            const deferred = await this.runtime.deferOAuthRotation(access.rotation, {
              jobId: job.jobId,
              claimGeneration: job.claimGeneration,
              retryAfterMs,
            });
            if (deferred) return { status: "deferred" as const };
          } else await this.runtime.failOAuthRotation(access.rotation);
          await failRunningJob({
            code,
            retryAfterMs,
          });
          return { status: code === "EXPIRED_CREDENTIALS" || code === "INVALID_CREDENTIALS" ? "reauthorization_required" as const : "deferred" as const };
        }
      }

      try {
        this.assertSelectedCloud(
          await getJiraAccessibleResources({ accessToken: credentials.accessToken, fetchImpl: this.fetchImpl }),
          credentials.cloudId,
          snapshot.configuration.binding.origin,
        );
      } catch (error) {
        const code = this.oauthFailure(error);
        if (code === "INVALID_CREDENTIALS" || code === "EXPIRED_CREDENTIALS")
          await failRunningJob({ code: "EXPIRED_CREDENTIALS" });
        else
          await failRunningJob({
            code,
            retryAfterMs: error instanceof JiraOAuthError ? error.retryAfterMs : null,
          });
        return { status: "deferred" as const };
      }

      if (snapshot.configuration.mapping.kind !== "CONNECTOR" || snapshot.configuration.mapping.adapterConfiguration === undefined)
        throw new JiraRuntimeError("STALE_CONFIGURATION");
      const rawOptions: unknown = JSON.parse(snapshot.configuration.mapping.adapterConfiguration);
      const options = parseJiraReadAdapterOptions(rawOptions);
      const configuredProjectIds = snapshot.configuration.projects
        .map((project) => project.projectId)
        .sort();
      const adapterProjectIds = options.projects
        .map((project) => project.projectId)
        .sort();
      if (
        configuredProjectIds.length !== adapterProjectIds.length ||
        configuredProjectIds.some(
          (projectId, index) => projectId !== adapterProjectIds[index],
        )
      )
        throw new JiraRuntimeError("STALE_CONFIGURATION");
      const requiredScopes = options.entities?.sprints
        ? [
            "read:jira-work",
            "read:board-scope:jira-software",
            "read:project:jira",
            "read:sprint:jira-software",
          ]
        : ["read:jira-work"];
      if (requiredScopes.some((scope) => !credentials.scopes.includes(scope)))
        throw new JiraRuntimeError("MISSING_SCOPE");
      if (options.entities?.sprints)
        this.assertSelectedCloud(
          await getJiraAccessibleResources({
            accessToken: credentials.accessToken,
            fetchImpl: this.fetchImpl,
          }),
          credentials.cloudId,
          snapshot.configuration.binding.origin,
          requiredScopes,
        );
      const client = createJiraOAuthCloudClient({ cloudId: credentials.cloudId, accessToken: credentials.accessToken });
      const connector = createJiraReadOnlyConnector(client, {
        ...options,
        customerId: job.customerId,
        sourceId: job.sourceId,
        origin: snapshot.configuration.binding.origin,
      });
      const result = await connector.pullChanges({
        scope: {
          binding: snapshot.configuration.binding,
          projectIds: snapshot.configuration.projects.map((project) => project.projectId),
        },
        cursor: snapshot.cursor,
      });
      if (!result.ok) {
        await failRunningJob({
          code: result.failure.code,
          retryAfterMs: result.failure.retryAfterMs,
        });
        return { status: "deferred" as const };
      }
      await this.ingestion.persistConnectorPageForJob({
        customerId: job.customerId,
        jobId: job.jobId,
        expectedClaimGeneration: job.claimGeneration,
        expectedConfigRevision: snapshot.configRevision,
        expectedMappingRevision: snapshot.mappingRevision,
        expectedCursorRevision: snapshot.cursorRevision,
        expectedGeneration: snapshot.generation,
        page: result.value,
      });
      return { status: "page_committed" as const };
    } catch (error) {
      if (hasCode(error, "STALE_CONFIGURATION"))
        await failRunningJob({ code: "INTEGRITY_CONFLICT" });
      else if (hasCode(error, "MISSING_SCOPE"))
        await failRunningJob({ code: "PERMISSION_DENIED" });
      else if (hasCode(error, "CURSOR_CONFLICT"))
        await failRunningJob({ code: "CURSOR_CONFLICT" });
      else if (hasCode(error, "CONFLICT"))
        await failRunningJob({ code: "TEMPORARILY_UNAVAILABLE", retryAfterMs: 15_000 });
      else if (error instanceof JiraOAuthError)
        await failRunningJob({
          code: error.code,
          retryAfterMs: error.retryAfterMs,
        });
      else
        await failRunningJob({ code: "INVALID_RESPONSE" });
      return { status: "deferred" as const };
    }
  }

  private requireClientId() {
    if (!this.config.JIRA_OAUTH_CLIENT_ID) throw new JiraOAuthError("INVALID_CREDENTIALS");
    return this.config.JIRA_OAUTH_CLIENT_ID;
  }

  private requireClientSecret() {
    if (!this.config.JIRA_OAUTH_CLIENT_SECRET) throw new JiraOAuthError("INVALID_CREDENTIALS");
    return this.config.JIRA_OAUTH_CLIENT_SECRET;
  }

  private oauthFailure(error: unknown): ConnectorFailure["code"] | "EXPIRED_CREDENTIALS" {
    if (error instanceof JiraOAuthError) return error.code;
    return "TEMPORARILY_UNAVAILABLE";
  }

  private assertSelectedCloud(
    resources: readonly { cloudId: string; url: string; scopes: string[] }[],
    cloudId: string,
    selectedUrl: string,
    requiredScopes: readonly string[] = ["read:jira-work"],
  ) {
    const resource = resources.find((candidate) => candidate.cloudId === cloudId);
    if (
      !resource ||
      resource.url !== selectedUrl ||
      requiredScopes.some((scope) => !resource.scopes.includes(scope))
    )
      throw new JiraOAuthError("PERMISSION_DENIED");
  }
}
