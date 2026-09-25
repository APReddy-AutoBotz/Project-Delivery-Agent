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
});
