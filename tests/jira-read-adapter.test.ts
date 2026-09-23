import { describe, expect, it } from "vitest";
import {
  createJiraReadOnlyConnector,
  type JiraReadClient,
} from "../packages/connectors-jira/src/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const sourceId = "10000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-000000000003";
const otherProjectId = "10000000-0000-4000-8000-000000000004";
const scope = {
  binding: {
    customerId,
    sourceId,
    sourceType: "jira",
    origin: "https://acme.atlassian.net",
  },
  projectIds: [projectId],
};
const config = {
  origin: scope.binding.origin,
  customerId,
  sourceId,
  projects: [
    { projectId, projectKey: "SAFE" },
    { projectId: otherProjectId, projectKey: "OTHER" },
  ],
  fields: [
    {
      jiraField: "summary",
      factType: "jira.summary",
      valueType: "text" as const,
    },
    {
      jiraField: "status",
      factType: "jira.status",
      valueType: "text" as const,
    },
    {
      jiraField: "duedate",
      factType: "jira.due_date",
      valueType: "date" as const,
    },
    {
      jiraField: "customfield_10001",
      factType: "jira.size",
      valueType: "number" as const,
    },
  ],
  now: () => new Date("2026-09-24T00:00:00.000Z"),
};
const issue = (key = "SAFE-1", project = "SAFE") => ({
  id: "501",
  key,
  fields: {
    updated: "2026-09-23T10:20:30.000Z",
    project: { key: project },
    summary: "Synthetic delivery issue",
    status: { name: "In Progress" },
    duedate: "2026-10-01",
    customfield_10001: 3,
    description: "unselected field must not escape",
  },
});
function fake(overrides: Partial<JiraReadClient> = {}) {
  const calls: {
    projects: string[];
    searches: { jql: string; fields: string[]; token?: string }[];
    issueKeys: string[];
  } = { projects: [], searches: [], issueKeys: [] };
  const client: JiraReadClient = {
    async getProject({ projectIdOrKey }) {
      calls.projects.push(projectIdOrKey);
      return { key: projectIdOrKey };
    },
    async searchIssues(input) {
      calls.searches.push({
        jql: input.jql,
        fields: input.fields,
        token: input.nextPageToken,
      });
      return { issues: [issue()], isLast: true };
    },
    async getIssue({ issueIdOrKey }) {
      calls.issueKeys.push(issueIdOrKey);
      return issue(issueIdOrKey);
    },
    ...overrides,
  };
  return {
    adapter: createJiraReadOnlyConnector(client, config),
    calls,
    client,
  };
}

describe("Jira read adapter synthetic contract (AC-CON-001/002/003, TR-JIRA-002)", () => {
  it("performs a read-only connection check against a configured project", async () => {
    const { adapter, calls } = fake();
    expect(await adapter.testConnection(scope)).toEqual({
      ok: true,
      value: { checkedAt: "2026-09-24T00:00:00.000Z" },
    });
    expect(calls.projects).toEqual(["SAFE"]);
  });

  it("rejects a field mapping whose declared type cannot match the Jira field", () => {
    expect(() =>
      createJiraReadOnlyConnector(
        {
          async getProject({ projectIdOrKey }) {
            return { key: projectIdOrKey };
          },
          async searchIssues() {
            return { issues: [], isLast: true };
          },
          async getIssue() {
            return issue();
          },
        },
        {
          ...config,
          fields: [
            {
              jiraField: "duedate",
              factType: "jira.due_date",
              valueType: "text",
            },
          ],
        },
      ),
    ).toThrow();
  });

  it("checks only configured visible projects and never widens trusted scope", async () => {
    const { adapter, calls } = fake({
      async getProject({ projectIdOrKey }) {
        calls.projects.push(projectIdOrKey);
        if (projectIdOrKey === "OTHER")
          throw Object.assign(new Error("forbidden"), { status: 403 });
        return { key: projectIdOrKey };
      },
    });
    const result = await adapter.discoverScopes({
      ...scope,
      projectIds: [projectId, otherProjectId],
    });
    expect(result).toEqual({
      ok: true,
      value: { projectIds: [projectId], checkedAt: "2026-09-24T00:00:00.000Z" },
    });
    expect(calls.projects).toEqual(["SAFE", "OTHER"]);
  });

  it("uses an allowlisted project JQL, exact paging cursor and selected fields only", async () => {
    const { adapter, calls } = fake({
      async searchIssues(input) {
        calls.searches.push({
          jql: input.jql,
          fields: input.fields,
          token: input.nextPageToken,
        });
        return { issues: [issue()], nextPageToken: "next-1", isLast: false };
      },
    });
    const result = await adapter.pullChanges({ scope, cursor: "opaque-0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextCursor).toBe("next-1");
    expect(result.value.records).toHaveLength(1);
    expect(result.value.records[0]).toMatchObject({
      ref: { projectId, recordType: "jira.issue", recordId: "SAFE-1" },
      effectiveAt: "2026-09-23T10:20:30.000Z",
      observedAt: "2026-09-24T00:00:00.000Z",
      observations: [
        {
          factType: "jira.summary",
          value: { type: "text", value: "Synthetic delivery issue" },
        },
        {
          factType: "jira.status",
          value: { type: "text", value: "In Progress" },
        },
        {
          factType: "jira.due_date",
          value: { type: "date", value: "2026-10-01" },
        },
        { factType: "jira.size", value: { type: "number", value: 3 } },
      ],
    });
    expect(calls.searches[0]).toEqual({
      jql: 'project in ("SAFE") ORDER BY updated ASC, key ASC',
      fields: [
        "project",
        "updated",
        "summary",
        "status",
        "duedate",
        "customfield_10001",
      ],
      token: "opaque-0",
    });
    expect(JSON.stringify(result.value)).not.toContain("unselected field");
  });

  it("keeps source revision and content hash independent of mapping order and fact-type names", async () => {
    const { adapter, client } = fake();
    const original = await adapter.pullChanges({ scope, cursor: null });
    const remapped = await createJiraReadOnlyConnector(client, {
      ...config,
      fields: [
        {
          jiraField: "customfield_10001",
          factType: "jira.size",
          valueType: "number",
        },
        { jiraField: "duedate", factType: "jira.due_date", valueType: "date" },
        { jiraField: "status", factType: "jira.status", valueType: "text" },
        { jiraField: "summary", factType: "jira.title", valueType: "text" },
      ],
    }).pullChanges({ scope, cursor: null });
    expect(original.ok && remapped.ok).toBe(true);
    if (!original.ok || !remapped.ok) return;
    expect(remapped.value.records[0]?.revision).toBe(
      original.value.records[0]?.revision,
    );
    expect(remapped.value.records[0]?.sourceContentHash).toBe(
      original.value.records[0]?.sourceContentHash,
    );
  });

  it("uses the source revision as identity so same-revision content changes remain detectable", async () => {
    const { adapter } = fake();
    const changed = createJiraReadOnlyConnector(
      {
        async getProject({ projectIdOrKey }) {
          return { key: projectIdOrKey };
        },
        async searchIssues() {
          return {
            issues: [
              {
                ...issue(),
                fields: {
                  ...issue().fields,
                  summary: "Changed without an updated revision",
                },
              },
            ],
            isLast: true,
          };
        },
        async getIssue() {
          return issue();
        },
      },
      config,
    );
    const original = await adapter.pullChanges({ scope, cursor: null });
    const changedPage = await changed.pullChanges({ scope, cursor: null });
    expect(original.ok && changedPage.ok).toBe(true);
    if (!original.ok || !changedPage.ok) return;
    expect(changedPage.value.records[0]?.revision).toBe(
      original.value.records[0]?.revision,
    );
    expect(changedPage.value.records[0]?.sourceContentHash).not.toBe(
      original.value.records[0]?.sourceContentHash,
    );
  });

  it("rejects search results outside the current trusted project allowlist", async () => {
    const { adapter } = fake({
      async searchIssues() {
        return { issues: [issue("OTHER-2", "OTHER")], isLast: true };
      },
    });
    expect(await adapter.pullChanges({ scope, cursor: null })).toEqual({
      ok: false,
      failure: { code: "INVALID_RESPONSE", retryAfterMs: null },
    });
  });

  it("rechecks issue project identity on direct lookup and withholds moved or cross-scope issues", async () => {
    const { adapter, calls } = fake({
      async getIssue({ issueIdOrKey }) {
        calls.issueKeys.push(issueIdOrKey);
        return issue(issueIdOrKey, "OTHER");
      },
    });
    const result = await adapter.getRecord(scope, {
      customerId,
      sourceId,
      projectId,
      recordType: "jira.issue",
      recordId: "SAFE-1",
    });
    expect(result.ok).toBe(false);
    const issueReadCount = calls.issueKeys.length;
    expect(
      await adapter.getRecord(scope, {
        customerId,
        sourceId,
        projectId,
        recordType: "jira.issue",
        recordId: "OTHER-2",
      }),
    ).toMatchObject({ ok: false, failure: { code: "PERMISSION_DENIED" } });
    expect(calls.issueKeys).toHaveLength(issueReadCount);
    expect(
      await adapter.getRecord(
        { ...scope, projectIds: [otherProjectId] },
        {
          customerId,
          sourceId,
          projectId,
          recordType: "jira.issue",
          recordId: "SAFE-1",
        },
      ),
    ).toMatchObject({ ok: false, failure: { code: "PERMISSION_DENIED" } });
    expect(
      await adapter.getDeepLink(scope, {
        customerId,
        sourceId,
        projectId: otherProjectId,
        recordType: "jira.issue",
        recordId: "OTHER-1",
      }),
    ).toBeNull();
    expect(
      await adapter.getDeepLink(scope, {
        customerId,
        sourceId,
        projectId,
        recordType: "jira.issue",
        recordId: "OTHER-2",
      }),
    ).toBeNull();
  });

  it("maps credential, permission, not-found and rate-limit failures to finite redacted classes", async () => {
    for (const [error, expected] of [
      [
        Object.assign(new Error("secret-token"), { status: 401 }),
        "INVALID_CREDENTIALS",
      ],
      [
        Object.assign(new Error("sensitive body"), { status: 403 }),
        "PERMISSION_DENIED",
      ],
      [
        Object.assign(new Error("sensitive body"), { status: 404 }),
        "NOT_FOUND",
      ],
      [
        Object.assign(new Error("sensitive body"), {
          status: 429,
          retryAfterMs: 9000,
        }),
        "RATE_LIMITED",
      ],
    ] as const) {
      const { adapter } = fake({
        async searchIssues() {
          throw error;
        },
      });
      const result = await adapter.pullChanges({ scope, cursor: null });
      expect(result).toMatchObject({ ok: false, failure: { code: expected } });
      expect(JSON.stringify(result)).not.toContain("sensitive");
      expect(JSON.stringify(result)).not.toContain("secret-token");
    }
  });

  it("has no external write method or live credential in the fixture API", () => {
    const { adapter } = fake();
    expect(Object.keys(adapter).sort()).toEqual([
      "discoverScopes",
      "getDeepLink",
      "getRecord",
      "pullChanges",
      "testConnection",
    ]);
  });
});
