import { describe, expect, it, vi } from "vitest";
import type { Config } from "@pdaa/platform";
import type { ConnectorChangePage } from "../packages/domain/src/index.js";
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

  it("preserves the configured Jira entity set, source IDs and revisions at scheduled persistence", async () => {
    const customerId = "2b2ae50e-1b58-4c69-a763-54ce3e4934ca";
    const sourceId = "13f95d34-1588-4d31-8f2e-40a213d37c91";
    const projectId = "a5345f68-117c-43b5-91b6-ff77eefdbfee";
    const binding = {
      customerId,
      sourceId,
      sourceType: "jira",
      origin: "https://tenant.atlassian.net",
    };
    const updated = "2026-09-25T10:20:30.000Z";
    const historyCreated = "2026-09-25T11:20:30.000Z";
    const issue = {
      id: "501",
      key: "SAFE-1",
      fields: {
        updated,
        project: { key: "SAFE" },
        summary: "Synthetic delivery issue",
        customfield_10001: 3,
        issuelinks: [
          {
            id: "91",
            type: { id: "7", name: "blocks" },
            inwardIssue: { key: "SAFE-1" },
            outwardIssue: { key: "SAFE-2" },
          },
        ],
      },
    };
    const history = {
      id: "67",
      created: historyCreated,
      items: [
        {
          fieldId: "summary",
          field: "Summary",
          from: "Old summary",
          to: "Updated summary",
          fromString: "Old summary",
          toString: "Updated summary",
        },
      ],
    };
    const sprint = {
      id: 7,
      name: "Sprint 7",
      state: "active",
      originBoardId: 42,
      startDate: "2026-09-01T09:00:00.000Z",
      endDate: "2026-09-15T17:00:00.000Z",
      completeDate: "2026-09-15T16:00:00.000Z",
    };
    const adapterConfiguration = JSON.stringify({
      projects: [{ projectId, projectKey: "SAFE" }],
      fields: [
        { jiraField: "summary", factType: "jira.summary", valueType: "text" },
        { jiraField: "customfield_10001", factType: "jira.size", valueType: "number" },
      ],
      entities: { issueLinks: true, changelog: true, sprints: true },
      boards: [{ boardId: 42, projectId }],
    });
    const credentials = {
      cloudId: "cloud-1",
      selectedUrl: binding.origin,
      accessToken: "current-access",
      refreshToken: "still-valid-refresh",
      expiresAt: "2099-09-24T10:00:00.000Z",
      scopes: [
        "read:jira-work",
        "read:board-scope:jira-software",
        "read:project:jira",
        "read:sprint:jira-software",
        "offline_access",
      ],
    };
    let cursor: string | null = null;
    let cursorRevision = 1;
    let claimCount = 0;
    const pages: ConnectorChangePage[] = [];
    const runtime = {
      enqueueDueJobs: vi.fn().mockResolvedValue([]),
      claimNextJob: vi.fn(async () => {
        claimCount += 1;
        return {
          jobId: `scheduled-job-${claimCount}`,
          customerId,
          sourceId,
          claimGeneration: 1,
        };
      }),
      accessOrBeginRotation: vi.fn().mockResolvedValue({
        kind: "access",
        credentials,
        configRevision: 4,
        mappingRevision: 2,
      }),
      completeOAuthRotation: vi.fn(),
      failOAuthRotation: vi.fn(),
      deferOAuthRotation: vi.fn().mockResolvedValue(true),
      failRunningJob: vi.fn().mockResolvedValue({ state: "READY" }),
    };
    const ingestion = {
      readConnectorSyncSnapshot: vi.fn(
        async (_customerId: string, jobId: string, _claimGeneration: number) => ({
          jobId,
          sourceId,
          configRevision: 4,
          mappingRevision: 2,
          configuration: {
            binding,
            projects: [{ projectId }],
            mapping: {
              kind: "CONNECTOR",
              factTypes: ["jira.summary", "jira.size"],
              adapterConfiguration,
            },
          },
          cursor,
          cursorRevision,
          generation: 1,
          resetRequired: false,
        }),
      ),
      resetConnectorCursorForJob: vi.fn(),
      persistConnectorPageForJob: vi.fn(
        async (input: { expectedCursorRevision: number; page: ConnectorChangePage }) => {
          expect(input.expectedCursorRevision).toBe(cursorRevision);
          expect(input.page.inputCursor).toBe(cursor);
          pages.push(input.page);
          cursor = input.page.nextCursor;
          cursorRevision += 1;
        },
      ),
    };
    const jiraClient = {
      getProject: vi.fn(async ({ projectIdOrKey }: { projectIdOrKey: string }) => ({
        key: projectIdOrKey,
      })),
      searchIssues: vi.fn(
        async ({ maxResults }: { maxResults: number; nextPageToken?: string }) => ({
          issues: [issue],
          isLast: true,
          nextPageToken: null,
        }),
      ),
      getIssue: vi.fn(async () => issue),
      getChangeLogs: vi.fn(async ({ startAt }: { startAt: number }) => ({
        histories: startAt === 0 ? [history] : [],
        startAt,
        total: 1,
      })),
      getChangeLogsByIds: vi.fn(async () => ({ histories: [history] })),
      getBoard: vi.fn(async ({ boardId }: { boardId: number }) => ({
        id: boardId,
        name: "Delivery Board",
        type: "scrum",
      })),
      getSprints: vi.fn(async ({ boardId, startAt }: { boardId: number; startAt: number }) => ({
        values: [sprint],
        total: 1,
        startAt,
        isLast: true,
      })),
      getSprint: vi.fn(async () => sprint),
    };
    const resourceScopes = credentials.scopes.filter((scopeName) => scopeName !== "offline_access");
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            id: credentials.cloudId,
            url: binding.origin,
            scopes: resourceScopes,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const service = new JiraRuntimeService(
      {
        CUSTOMER_ID: customerId,
        JIRA_OAUTH_CLIENT_ID: "client",
        JIRA_OAUTH_CLIENT_SECRET: "client-secret",
      } as Config,
      runtime as never,
      ingestion as never,
      fetchImpl,
      () => jiraClient as never,
    );

    for (let page = 0; page < 8; page += 1) {
      await expect(service.runOne()).resolves.toEqual({ status: "page_committed" });
      if (pages[pages.length - 1]?.terminal) break;
    }

    expect(pages[pages.length - 1]?.terminal).toBe(true);
    expect(runtime.failRunningJob).not.toHaveBeenCalled();
    expect(jiraClient.getProject).toHaveBeenCalled();
    expect(jiraClient.getBoard).toHaveBeenCalledWith({ boardId: 42 });
    expect(jiraClient.getSprints).toHaveBeenCalled();
    const records = pages.flatMap((page) => page.records);
    expect(new Set(records.map((record) => record.ref.recordType))).toEqual(
      new Set(["jira.issue", "jira.issue_link", "jira.changelog", "jira.board", "jira.sprint"]),
    );
    for (const page of pages) {
      expect(page.binding).toEqual(binding);
      for (const record of page.records) {
        expect(record.ref).toMatchObject({ customerId, sourceId, projectId });
        expect(record.revision.length).toBeGreaterThan(0);
        expect(record.sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(record.observedAt).toBeTruthy();
        expect(record.effectiveAt).toBeTruthy();
      }
    }

    const issueRecord = records.find((record) => record.ref.recordType === "jira.issue");
    expect(issueRecord).toMatchObject({
      ref: { customerId, sourceId, projectId, recordType: "jira.issue", recordId: "SAFE-1" },
      revision: updated,
    });
    expect(issueRecord?.observations).toContainEqual({
      factType: "jira.summary",
      value: { type: "text", value: "Synthetic delivery issue" },
    });
    expect(issueRecord?.observations).toContainEqual({
      factType: "jira.size",
      value: { type: "number", value: 3 },
    });

    const linkRecord = records.find((record) => record.ref.recordType === "jira.issue_link");
    expect(linkRecord).toMatchObject({
      ref: { customerId, sourceId, projectId, recordType: "jira.issue_link", recordId: "91" },
    });
    expect(linkRecord?.revision).toBe(`snapshot:${linkRecord?.sourceContentHash}`);

    const changelogRecord = records.find((record) => record.ref.recordType === "jira.changelog");
    expect(changelogRecord).toMatchObject({
      ref: {
        customerId,
        sourceId,
        projectId,
        recordType: "jira.changelog",
        recordId: "501:67:0",
      },
      revision: `${historyCreated}:67:0`,
    });

    const boardRecord = records.find((record) => record.ref.recordType === "jira.board");
    expect(boardRecord).toMatchObject({
      ref: { customerId, sourceId, projectId, recordType: "jira.board", recordId: "42" },
    });
    expect(boardRecord?.revision).toBe(`snapshot:${boardRecord?.sourceContentHash}`);

    const sprintRecord = records.find((record) => record.ref.recordType === "jira.sprint");
    expect(sprintRecord).toMatchObject({
      ref: { customerId, sourceId, projectId, recordType: "jira.sprint", recordId: "42:7" },
    });
    expect(sprintRecord?.revision).toBe(`snapshot:${sprintRecord?.sourceContentHash}`);
  });
});
