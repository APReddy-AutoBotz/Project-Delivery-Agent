import { describe, expect, it, vi } from "vitest";
import { DatabaseConnectorRuntimeRepository } from "../packages/data/src/connector-runtime.js";
import {
  signConnectorTaskRequest,
  verifyConnectorTaskRequest,
} from "../packages/platform/src/connector-task-auth.js";
import {
  getJiraAccessibleResources,
  JiraOAuthError,
  refreshJiraOAuthToken,
} from "../packages/connectors-jira/src/oauth.js";

const keyRing = {
  currentKeyId: "task-2026-09",
  keys: { "task-2026-09": Buffer.alloc(32, 41).toString("base64url") },
};

describe("connector task authentication", () => {
  it("authenticates the exact path, timestamp, nonce and raw body", () => {
    const body = Buffer.from("{}", "utf8");
    const headers = signConnectorTaskRequest({
      method: "POST",
      path: "/internal/connectors/run",
      body,
      keyRing,
      now: Date.UTC(2026, 8, 24, 12, 0, 0),
      nonce: "d722c3d1-329f-47e5-a960-64bb7dd0bfe3",
    });
    const requestHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, value]),
    );
    const common = {
      headers: requestHeaders,
      keyRing,
      now: Date.UTC(2026, 8, 24, 12, 0, 30),
    };
    expect(
      verifyConnectorTaskRequest({
        ...common,
        method: "POST",
        path: "/internal/connectors/run",
        body,
      }),
    ).toBe(true);
    expect(
      verifyConnectorTaskRequest({
        ...common,
        method: "POST",
        path: "/internal/connectors/other",
        body,
      }),
    ).toBe(false);
    expect(
      verifyConnectorTaskRequest({
        ...common,
        method: "POST",
        path: "/internal/connectors/run",
        body: Buffer.from("{ }", "utf8"),
      }),
    ).toBe(false);
    expect(
      verifyConnectorTaskRequest({
        ...common,
        method: "POST",
        path: "/internal/connectors/run",
        body,
        now: Date.UTC(2026, 8, 24, 12, 2, 0),
      }),
    ).toBe(false);
  });
});

describe("Jira OAuth boundaries", () => {
  it("requires a rotated refresh token and the declared read/offline scopes", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "read:jira-work offline_access",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await expect(
      refreshJiraOAuthToken({
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "old-refresh",
        now: Date.UTC(2026, 8, 24),
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: "2026-09-24T01:00:00.000Z",
      scopes: ["read:jira-work", "offline_access"],
    });

    await expect(
      refreshJiraOAuthToken({
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "old-refresh",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ access_token: "new-access", expires_in: 3600 }),
            { status: 200 },
          ),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      refreshJiraOAuthToken({
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "old-refresh",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
              scope: "read:jira-work",
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("accepts only an exact HTTPS cloud resource URL", async () => {
    const resource = {
      id: "cloud-1",
      url: "https://tenant.atlassian.net",
      scopes: ["read:jira-work"],
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify([resource]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await expect(
      getJiraAccessibleResources({ accessToken: "access", fetchImpl }),
    ).resolves.toEqual([
      {
        cloudId: "cloud-1",
        url: "https://tenant.atlassian.net",
        scopes: ["read:jira-work"],
      },
    ]);

    await expect(
      getJiraAccessibleResources({
        accessToken: "access",
        fetchImpl: async () =>
          new Response(
            JSON.stringify([{ ...resource, url: "https://tenant.atlassian.net/path" }]),
            { status: 200 },
          ),
      }),
    ).rejects.toBeInstanceOf(JiraOAuthError);
  });
});

describe("Jira webhook authentication boundary", () => {
  it("rejects a bad raw-body signature before JSON parsing or transactional row locks", async () => {
    const sourceId = "13f95d34-1588-4d31-8f2e-40a213d37c91";
    const customerId = "2b2ae50e-1b58-4c69-a763-54ce3e4934ca";
    const rawBody = Buffer.from('{"webhookEvent":"jira:issue_updated"}', "utf8");
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{
        id: sourceId,
        customerId,
        sourceType: "jira",
        currentConfigRevision: 1,
        credentialId: "41f867a5-ec4b-45e2-a96d-d2e522113a29",
        envelope: "encrypted-envelope",
        keyId: "key-1",
        revision: 1,
        state: "ACTIVE",
      }]),
      $transaction: vi.fn(),
    };
    const vault = {
      decrypt: vi.fn().mockReturnValue(JSON.stringify({ secret: Buffer.alloc(32, 61).toString("hex") })),
    };
    const repository = new DatabaseConnectorRuntimeRepository(db as never, vault as never);
    const parse = vi.spyOn(JSON, "parse");
    try {
      await expect(repository.acceptWebhook({
        sourceId,
        eventId: "event-123",
        signature: `sha256=${"0".repeat(64)}`,
        rawBody,
        now: new Date("2026-09-24T00:00:00.000Z"),
      })).rejects.toMatchObject({ code: "INVALID_WEBHOOK" });
      expect(parse).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
