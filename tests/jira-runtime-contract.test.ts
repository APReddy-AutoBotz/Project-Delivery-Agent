import { describe, expect, it, vi } from "vitest";
import type { Config } from "@pdaa/platform";
import { JiraRuntimeService } from "../apps/api/src/jira-runtime.js";

const customerId = "2b2ae50e-1b58-4c69-a763-54ce3e4934ca";
const sourceId = "13f95d34-1588-4d31-8f2e-40a213d37c91";
const projectId = "a5345f68-117c-43b5-91b6-ff77eefdbfee";
const binding = {
  customerId,
  sourceId,
  sourceType: "jira",
  origin: "https://tenant.atlassian.net",
};
const job = {
  jobId: "runtime-contract-job",
  customerId,
  sourceId,
  claimGeneration: 3,
};
const issue = (id: string, key: string) => ({
  id,
  key,
  fields: {
    updated: "2026-09-25T10:20:30.000Z",
    project: { key: "SAFE" },
    summary: "Synthetic delivery issue",
  },
});

function harness(searchIssues: () => Promise<unknown>) {
  const credentials = {
    cloudId: "cloud-1",
    selectedUrl: binding.origin,
    accessToken: "synthetic-access-token",
    refreshToken: "synthetic-refresh-token",
    expiresAt: "2099-09-24T10:00:00.000Z",
    scopes: ["read:jira-work", "offline_access"],
  };
  const runtime = {
    enqueueDueJobs: vi.fn().mockResolvedValue([]),
    claimNextJob: vi.fn().mockResolvedValue(job),
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
    readConnectorSyncSnapshot: vi.fn().mockResolvedValue({
      jobId: job.jobId,
      sourceId,
      configRevision: 4,
      mappingRevision: 2,
      configuration: {
        binding,
        projects: [{ projectId }],
        mapping: {
          kind: "CONNECTOR",
          factTypes: ["jira.summary"],
          adapterConfiguration: JSON.stringify({
            projects: [{ projectId, projectKey: "SAFE" }],
            fields: [
              { jiraField: "summary", factType: "jira.summary", valueType: "text" },
            ],
          }),
        },
      },
      cursor: "cursor-before-read",
      cursorRevision: 8,
      generation: 2,
      resetRequired: false,
    }),
    resetConnectorCursorForJob: vi.fn(),
    persistConnectorPageForJob: vi.fn(),
  };
  const jiraClient = {
    getProject: vi.fn(async ({ projectIdOrKey }: { projectIdOrKey: string }) => ({
      key: projectIdOrKey,
    })),
    searchIssues: vi.fn(searchIssues),
    getIssue: vi.fn(async () => issue("501", "SAFE-1")),
    getChangeLogs: vi.fn(async () => ({ histories: [], startAt: 0, total: 0 })),
    getChangeLogsByIds: vi.fn(async () => ({ histories: [] })),
  };
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        {
          id: credentials.cloudId,
          url: binding.origin,
          scopes: ["read:jira-work"],
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
  return { service, runtime, ingestion, jiraClient };
}

const scenarios = [
  {
    name: "duplicate source identities",
    searchIssues: async () => ({
      issues: [issue("501", "SAFE-9"), issue("502", "SAFE-9")],
      isLast: true,
    }),
    code: "INVALID_RESPONSE",
    retryAfterMs: null,
    privateDetail: null,
  },
  {
    name: "Jira throttling",
    searchIssues: async () => {
      throw Object.assign(new Error("synthetic private 429 response"), {
        status: 429,
        retryAfterMs: 4321,
      });
    },
    code: "RATE_LIMITED",
    retryAfterMs: 4321,
    privateDetail: "synthetic private 429 response",
  },
  {
    name: "unknown transport outcomes",
    searchIssues: async () => {
      throw new Error("socket closed with synthetic-secret-marker");
    },
    code: "UNKNOWN_OUTCOME",
    retryAfterMs: null,
    privateDetail: "synthetic-secret-marker",
  },
] as const;

describe("Jira runtime shared connector contract (AC-MNT-003, TR-TEST-003)", () => {
  it.each(scenarios)(
    "fails closed for $name without advancing the persisted cursor",
    async ({ searchIssues, code, retryAfterMs, privateDetail }) => {
      const fixture = harness(searchIssues);
      const result = await fixture.service.runOne();

      expect(result).toEqual({ status: "deferred" });
      expect(fixture.jiraClient.getProject).toHaveBeenCalledWith({
        projectIdOrKey: "SAFE",
      });
      expect(fixture.jiraClient.searchIssues).toHaveBeenCalledTimes(1);
      expect(fixture.ingestion.persistConnectorPageForJob).not.toHaveBeenCalled();
      expect(fixture.ingestion.resetConnectorCursorForJob).not.toHaveBeenCalled();
      expect(fixture.runtime.failRunningJob).toHaveBeenCalledTimes(1);
      expect(fixture.runtime.failRunningJob).toHaveBeenCalledWith({
        customerId,
        jobId: job.jobId,
        claimGeneration: job.claimGeneration,
        code,
        retryAfterMs,
      });
      if (privateDetail)
        expect(JSON.stringify(fixture.runtime.failRunningJob.mock.calls)).not.toContain(
          privateDetail,
        );
    },
  );
});
