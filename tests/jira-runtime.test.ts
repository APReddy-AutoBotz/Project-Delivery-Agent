import { describe, expect, it, vi } from "vitest";
import type { Config } from "@pdaa/platform";
import { JiraRuntimeService } from "../apps/api/src/jira-runtime.js";

describe("Jira runtime OAuth retry handling", () => {
  it("releases a refresh lease and retries a definite token endpoint rate limit", async () => {
    const customerId = "2b2ae50e-1b58-4c69-a763-54ce3e4934ca";
    const sourceId = "13f95d34-1588-4d31-8f2e-40a213d37c91";
    const job = {
      jobId: "ea6da050-c554-42c8-92b7-e1a24e15bcc0",
      customerId,
      sourceId,
      claimGeneration: 1,
    };
    const rotation = {
      customerId,
      sourceId,
      operationId: "44426280-4e39-4ce0-86db-836bc4310485",
      revision: 2,
      configRevision: 1,
      mappingRevision: 1,
      credentials: {
        cloudId: "cloud-1",
        selectedUrl: "https://tenant.atlassian.net",
        accessToken: "current-access",
        refreshToken: "still-valid-refresh",
        expiresAt: "2026-09-24T10:00:00.000Z",
        scopes: ["read:jira-work", "offline_access"],
      },
    };
    const runtime = {
      enqueueDueJobs: vi.fn().mockResolvedValue([]),
      claimNextJob: vi.fn().mockResolvedValue(job),
      accessOrBeginRotation: vi.fn().mockResolvedValue({ kind: "rotate", rotation }),
      completeOAuthRotation: vi.fn(),
      failOAuthRotation: vi.fn(),
      deferOAuthRotation: vi.fn().mockResolvedValue(true),
      failRunningJob: vi.fn().mockResolvedValue({ state: "READY" }),
    };
    const ingestion = {
      readConnectorSyncSnapshot: vi.fn().mockResolvedValue({
        jobId: job.jobId,
        sourceId,
        configRevision: 1,
        mappingRevision: 1,
        configuration: {} as never,
        cursor: null,
        cursorRevision: 1,
        generation: 1,
        resetRequired: false,
      }),
    };
    const config = {
      CUSTOMER_ID: customerId,
      JIRA_OAUTH_CLIENT_ID: "client",
      JIRA_OAUTH_CLIENT_SECRET: "client-secret",
    } as Config;
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 429, headers: { "retry-after": "3" } });

    const service = new JiraRuntimeService(
      config,
      runtime as never,
      ingestion as never,
      fetchImpl,
    );
    await expect(service.runOne()).resolves.toEqual({ status: "deferred" });

    expect(runtime.deferOAuthRotation).toHaveBeenCalledWith(rotation, {
      jobId: job.jobId,
      claimGeneration: 1,
      retryAfterMs: 3000,
    });
    expect(runtime.failOAuthRotation).not.toHaveBeenCalled();
    expect(runtime.failRunningJob).not.toHaveBeenCalled();
  });

  it("denies configured sprint reads without every stored-token and selected-site scope", async () => {
    const customerId = "2b2ae50e-1b58-4c69-a763-54ce3e4934ca";
    const sourceId = "13f95d34-1588-4d31-8f2e-40a213d37c91";
    const projectId = "a5345f68-117c-43b5-91b6-ff77eefdbfee";
    const required = [
      "read:jira-work",
      "read:board-scope:jira-software",
      "read:project:jira",
      "read:sprint:jira-software",
    ];
    const allScopes = [...required, "offline_access"];
    const binding = {
      customerId,
      sourceId,
      sourceType: "jira",
      origin: "https://tenant.atlassian.net",
    };
    const adapterConfiguration = JSON.stringify({
      projects: [{ projectId, projectKey: "SAFE" }],
      fields: [{ jiraField: "summary", factType: "jira.summary", valueType: "text" }],
      entities: { sprints: true },
      boards: [{ boardId: 42, projectId }],
    });

    const run = async (
      credentialScopes: string[],
      resourceScopes: string[],
      failSecondResourceCheck = false,
    ) => {
      let fetchCount = 0;
      const fetchImpl: typeof fetch = async () => {
        fetchCount += 1;
        if (failSecondResourceCheck && fetchCount === 2)
          return new Response(null, {
            status: 429,
            headers: { "retry-after": "3" },
          });
        return new Response(
          JSON.stringify([
            {
              id: "cloud-1",
              url: binding.origin,
              scopes: resourceScopes,
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const job = {
        jobId: "ea6da050-c554-42c8-92b7-e1a24e15bcc0",
        customerId,
        sourceId,
        claimGeneration: 1,
      };
      const credentials = {
        cloudId: "cloud-1",
        selectedUrl: binding.origin,
        accessToken: "current-access",
        refreshToken: "still-valid-refresh",
        expiresAt: "2099-09-24T10:00:00.000Z",
        scopes: credentialScopes,
      };
      const runtime = {
        enqueueDueJobs: vi.fn().mockResolvedValue([]),
        claimNextJob: vi.fn().mockResolvedValue(job),
        accessOrBeginRotation: vi.fn().mockResolvedValue({
          kind: "access",
          credentials,
          configRevision: 1,
          mappingRevision: 1,
        }),
        completeOAuthRotation: vi.fn(),
        failOAuthRotation: vi.fn(),
        deferOAuthRotation: vi.fn().mockResolvedValue(true),
        failRunningJob: vi.fn().mockResolvedValue({ state: "READY" }),
      };
      const ingestion = {
        readConnectorSyncSnapshot: vi.fn().mockResolvedValue({
          jobId: job.jobId,
          sourceId,
          configRevision: 1,
          mappingRevision: 1,
          configuration: {
            binding,
            projects: [{ projectId }],
            mapping: { kind: "CONNECTOR", adapterConfiguration },
          },
          cursor: null,
          cursorRevision: 1,
          generation: 1,
          resetRequired: false,
        }),
        persistConnectorPageForJob: vi.fn(),
      };
      const service = new JiraRuntimeService(
        {
          CUSTOMER_ID: customerId,
          JIRA_OAUTH_CLIENT_ID: "client",
          JIRA_OAUTH_CLIENT_SECRET: "client-secret",
        } as Config,
        runtime as never,
        ingestion as never,
        fetchImpl,
      );
      const status = await service.runOne();
      return { status, runtime, ingestion, fetchCount };
    };

    for (const missing of required) {
      const credentials = await run(
        allScopes.filter((scopeName) => scopeName !== missing),
        allScopes,
      );
      expect(credentials.status).toEqual({ status: "deferred" });
      expect(credentials.runtime.failRunningJob).toHaveBeenCalledWith(
        expect.objectContaining({ code: "PERMISSION_DENIED" }),
      );
      expect(credentials.ingestion.persistConnectorPageForJob).not.toHaveBeenCalled();

      const resource = await run(
        allScopes,
        allScopes.filter((scopeName) => scopeName !== missing),
      );
      expect(resource.status).toEqual({ status: "deferred" });
      expect(resource.runtime.failRunningJob).toHaveBeenCalledWith(
        expect.objectContaining({ code: "PERMISSION_DENIED" }),
      );
      expect(resource.ingestion.persistConnectorPageForJob).not.toHaveBeenCalled();
    }

    const throttled = await run(allScopes, allScopes, true);
    expect(throttled.status).toEqual({ status: "deferred" });
    expect(throttled.fetchCount).toBe(2);
    expect(throttled.runtime.failRunningJob).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "RATE_LIMITED",
        retryAfterMs: 3000,
      }),
    );
  });

  it(
    "fails scheduled synchronization closed when a configured Jira project is no longer visible",
    async () => {
      const customerId = "2b2ae50e-1b58-4c69-a763-54ce3e4934ca";
      const sourceId = "13f95d34-1588-4d31-8f2e-40a213d37c91";
      const visibleProjectId = "a5345f68-117c-43b5-91b6-ff77eefdbfee";
      const hiddenProjectId = "82b29824-61ad-4c10-8853-d3ea917870e9";
      const binding = {
        customerId,
        sourceId,
        sourceType: "jira",
        origin: "https://tenant.atlassian.net",
      };
      const job = {
        jobId: "ea6da050-c554-42c8-92b7-e1a24e15bcc0",
        customerId,
        sourceId,
        claimGeneration: 1,
      };
      const credentials = {
        cloudId: "cloud-1",
        selectedUrl: binding.origin,
        accessToken: "current-access",
        refreshToken: "still-valid-refresh",
        expiresAt: "2099-09-24T10:00:00.000Z",
        scopes: ["read:jira-work", "offline_access"],
      };
      const adapterConfiguration = JSON.stringify({
        projects: [
          { projectId: visibleProjectId, projectKey: "SAFE" },
          { projectId: hiddenProjectId, projectKey: "HIDDEN" },
        ],
        fields: [{ jiraField: "summary", factType: "jira.summary", valueType: "text" }],
      });
      const runtime = {
        enqueueDueJobs: vi.fn().mockResolvedValue([]),
        claimNextJob: vi.fn().mockResolvedValue(job),
        accessOrBeginRotation: vi.fn().mockResolvedValue({
          kind: "access",
          credentials,
          configRevision: 1,
          mappingRevision: 1,
        }),
        completeOAuthRotation: vi.fn(),
        failOAuthRotation: vi.fn(),
        deferOAuthRotation: vi.fn().mockResolvedValue(true),
        failRunningJob: vi.fn().mockResolvedValue({ state: "READY" }),
      };
      const ingestion = {
        readConnectorSyncSnapshot: vi.fn().mockResolvedValue({
          jobId: job.jobId,
          sourceId,
          configRevision: 1,
          mappingRevision: 1,
          configuration: {
            binding,
            projects: [{ projectId: visibleProjectId }, { projectId: hiddenProjectId }],
            mapping: { kind: "CONNECTOR", adapterConfiguration },
          },
          cursor: "unchanged-cursor",
          cursorRevision: 7,
          generation: 1,
          resetRequired: false,
        }),
        persistConnectorPageForJob: vi.fn(),
      };
      const jiraClient = {
        getProject: vi.fn(async ({ projectIdOrKey }: { projectIdOrKey: string }) => {
          if (projectIdOrKey === "HIDDEN")
            throw Object.assign(new Error("provider project details stay private"), { status: 403 });
          return { key: projectIdOrKey };
        }),
        searchIssues: vi.fn().mockResolvedValue({ issues: [], isLast: true }),
      };
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify([
            {
              id: "cloud-1",
              url: binding.origin,
              scopes: ["read:jira-work"],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const service = new JiraRuntimeService(
        { CUSTOMER_ID: customerId } as Config,
        runtime as never,
        ingestion as never,
        fetchImpl,
        () => jiraClient as never,
      );
  
      await expect(service.runOne()).resolves.toEqual({ status: "deferred" });
      expect(jiraClient.getProject.mock.calls.map(([input]) => input.projectIdOrKey)).toEqual([
        "SAFE",
        "HIDDEN",
      ]);
      expect(jiraClient.searchIssues).not.toHaveBeenCalled();
      expect(ingestion.persistConnectorPageForJob).not.toHaveBeenCalled();
      expect(runtime.failRunningJob).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId,
          jobId: job.jobId,
          claimGeneration: job.claimGeneration,
          code: "PERMISSION_DENIED",
        }),
      );
      expect(JSON.stringify(runtime.failRunningJob.mock.calls)).not.toContain(
        "provider project details stay private",
      );
    },
  );

});
