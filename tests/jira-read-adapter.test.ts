import { describe, expect, it } from "vitest";
import {
  connectorReadRetryAdvice,
  type ConnectorChangePage,
} from "@pdaa/domain";
import {
  createJiraReadOnlyConnector,
  parseJiraReadAdapterOptions,
  type JiraReadAdapterConfig,
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

function configured(
  overrides: Partial<JiraReadClient> = {},
  configOverrides: Partial<JiraReadAdapterConfig> = {},
) {
  const fixture = fake(overrides);
  return {
    ...fixture,
    adapter: createJiraReadOnlyConnector(fixture.client, {
      ...config,
      ...configOverrides,
    }),
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

  it("rejects duplicate Jira issue identities through the shared page contract", async () => {
    let attempts = 0;
    const { adapter } = fake({
      async searchIssues() {
        attempts++;
        return { issues: [issue("SAFE-9"), issue("SAFE-9")], isLast: true };
      },
    });
    const result = await adapter.pullChanges({ scope, cursor: null });
    expect(result).toEqual({
      ok: false,
      failure: { code: "INVALID_RESPONSE", retryAfterMs: null },
    });
    expect(attempts).toBe(1);
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

  it("keeps unknown search outcomes finite, redacted and non-retryable", async () => {
    let attempts = 0;
    const { adapter } = fake({
      async searchIssues() {
        attempts++;
        throw new Error("socket closed; synthetic-secret-token");
      },
    });
    const result = await adapter.pullChanges({ scope, cursor: null });
    expect(result).toEqual({
      ok: false,
      failure: { code: "UNKNOWN_OUTCOME", retryAfterMs: null },
    });
    if (result.ok) throw new Error("Expected an unknown connector failure");
    expect(connectorReadRetryAdvice(result.failure, 1)).toEqual({ retry: false });
    expect(attempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-token");
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

  it("requires explicit project-bound board mappings and rejects unsupported entity options", () => {
    const baseOptions = { projects: config.projects, fields: config.fields };
    expect(() =>
      parseJiraReadAdapterOptions({
        ...baseOptions,
        entities: { sprints: true },
      }),
    ).toThrow();
    expect(() =>
      parseJiraReadAdapterOptions({
        ...baseOptions,
        entities: { sprints: true },
        boards: [
          {
            boardId: 42,
            projectId: "10000000-0000-4000-8000-000000000005",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseJiraReadAdapterOptions({
        ...baseOptions,
        entities: { sprints: false },
        boards: [{ boardId: 42, projectId }],
      }),
    ).toThrow();
    expect(() =>
      parseJiraReadAdapterOptions({
        ...baseOptions,
        entities: { comments: true },
      }),
    ).toThrow();
  });

  it("pages issue links, de-duplicates each relation and keeps both endpoints inside the active scope", async () => {
    const links = Array.from({ length: 26 }, (_, index) => ({
      id: String(index + 1),
      type: { id: "10000", name: "relates to" },
      outwardIssue: { key: "SAFE-" + String(index + 2) },
    }));
    const inverse = {
      id: "1",
      type: { id: "10000", name: "relates to" },
      inwardIssue: { key: "SAFE-1" },
    };
    const withLinks = (key: string, selected: unknown[]) => ({
      ...issue(key),
      id: key === "SAFE-2" ? "502" : "501",
      fields: { ...issue(key).fields, issuelinks: selected },
    });
    const searchCalls: Array<{
      maxResults: number;
      token?: string;
      fields: string[];
    }> = [];
    const fixture = configured(
      {
        async searchIssues(input) {
          searchCalls.push({
            maxResults: input.maxResults,
            token: input.nextPageToken,
            fields: input.fields,
          });
          if (input.maxResults > 1)
            return { issues: [issue("SAFE-1"), issue("SAFE-2")], isLast: true };
          if (input.nextPageToken === "issue-2")
            return {
              issues: [withLinks("SAFE-2", [inverse])],
              isLast: true,
            };
          return {
            issues: [withLinks("SAFE-1", links)],
            nextPageToken: "issue-2",
            isLast: false,
          };
        },
        async getIssue({ issueIdOrKey }) {
          return withLinks(
            issueIdOrKey,
            issueIdOrKey === "SAFE-1" ? links : [inverse],
          );
        },
        async getIssueLink() {
          return {
            id: "1",
            type: { id: "10000", name: "relates to" },
            inwardIssue: { key: "SAFE-1" },
            outwardIssue: { key: "SAFE-2" },
          };
        },
      },
      { entities: { issueLinks: true }, pageSize: 50 },
    );
    const pages: ConnectorChangePage[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index += 1) {
      const result = await fixture.adapter.pullChanges({ scope, cursor });
      if (!result.ok) throw new Error(result.failure.code);
      pages.push(result.value);
      if (result.value.terminal) break;
      cursor = result.value.nextCursor;
    }
    const linkRecords = pages.flatMap((page) =>
      page.records.filter((record) => record.ref.recordType === "jira.issue_link"),
    );
    expect(linkRecords).toHaveLength(26);
    expect(new Set(linkRecords.map((record) => record.ref.recordId)).size).toBe(26);
    expect(linkRecords.some((record) => record.ref.recordId === "26")).toBe(true);
    expect(
      searchCalls
        .filter((call) => call.maxResults === 1)
        .every((call) => call.fields.includes("issuelinks")),
    ).toBe(true);

    const fetched = await fixture.adapter.getRecord(scope, {
      customerId,
      sourceId,
      projectId,
      recordType: "jira.issue_link",
      recordId: "1",
    });
    expect(fetched).toMatchObject({
      ok: true,
      value: { ref: { projectId, recordType: "jira.issue_link", recordId: "1" } },
    });
    if (fetched.ok)
      expect(fetched.value.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ factType: "jira.issue_link.type" }),
          expect.objectContaining({ factType: "jira.issue_link.inward" }),
          expect.objectContaining({ factType: "jira.issue_link.outward" }),
        ]),
      );
  });

  it("looks up cross-project links under the deterministic endpoint project", async () => {
    const link = {
      id: "42",
      type: { id: "10000", name: "blocks" },
      inwardIssue: { key: "SAFE-1" },
      outwardIssue: { key: "OTHER-2" },
    };
    const canonicalIssue = issue("OTHER-2", "OTHER");
    const linkedIssue = {
      ...canonicalIssue,
      fields: { ...canonicalIssue.fields, issuelinks: [link] },
    };
    const scopeBoth = { ...scope, projectIds: [projectId, otherProjectId] };
    const fixture = configured(
      {
        async searchIssues() {
          return { issues: [linkedIssue], isLast: true };
        },
        async getIssue({ issueIdOrKey }) {
          return issue(issueIdOrKey, "OTHER");
        },
        async getIssueLink() {
          return link;
        },
      },
      { entities: { issueLinks: true } },
    );
    const pages: ConnectorChangePage[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index += 1) {
      const result = await fixture.adapter.pullChanges({ scope: scopeBoth, cursor });
      if (!result.ok) throw new Error(result.failure.code);
      pages.push(result.value);
      if (result.value.terminal) break;
      cursor = result.value.nextCursor;
    }

    const linkRecords = pages.flatMap((page) =>
      page.records.filter((record) => record.ref.recordType === "jira.issue_link"),
    );
    expect(linkRecords).toHaveLength(1);
    expect(linkRecords[0]?.ref.projectId).toBe(otherProjectId);

    const fetched = await fixture.adapter.getRecord(scopeBoth, linkRecords[0]!.ref);
    expect(fetched).toMatchObject({
      ok: true,
      value: {
        ref: {
          projectId: otherProjectId,
          recordType: "jira.issue_link",
          recordId: "42",
        },
      },
    });
  });

  it("withholds links to unmapped and currently out-of-scope projects", async () => {
    const exposed = [
      {
        id: "11",
        type: { name: "blocks" },
        outwardIssue: { key: "OTHER-3" },
      },
      {
        id: "12",
        type: { name: "relates to" },
        outwardIssue: { key: "UNMAPPED-4" },
      },
    ];
    const linkedIssue = {
      ...issue("SAFE-1"),
      fields: { ...issue("SAFE-1").fields, issuelinks: exposed },
    };
    const fixture = configured(
      {
        async searchIssues(input) {
          return { issues: [linkedIssue], isLast: true };
        },
      },
      { entities: { issueLinks: true } },
    );
    const first = await fixture.adapter.pullChanges({ scope, cursor: null });
    if (!first.ok) throw new Error(first.failure.code);
    const second = await fixture.adapter.pullChanges({
      scope,
      cursor: first.value.nextCursor,
    });
    if (!second.ok) throw new Error(second.failure.code);
    expect(
      [...first.value.records, ...second.value.records].some(
        (record) => record.ref.recordType === "jira.issue_link",
      ),
    ).toBe(false);
    expect(JSON.stringify([first.value, second.value])).not.toContain("OTHER-3");
    expect(JSON.stringify([first.value, second.value])).not.toContain("UNMAPPED-4");
  });

  it("normalizes only mapped changelog items, paginates them and accepts SDK Date values", async () => {
    const history = {
      id: "91",
      created: new Date("2026-09-20T12:30:00.000Z"),
      author: {
        displayName: "Private Jira author",
        emailAddress: "private@example.test",
      },
      items: Array.from({ length: 27 }, (_, index) =>
        index === 24
          ? {
              fieldId: "customfield_10001",
              field: "Custom size",
              from: "3.5",
              to: "4.5",
              toString: "4.5",
            }
          : index === 25
            ? {
                fieldId: "description",
                field: "Description",
                fromString: "old private text",
                toString: "UNMAPPED CHANGELOG SECRET",
              }
            : {
                fieldId: "summary",
                field: "Summary",
                fromString: "Previous " + String(index),
                toString: "Mapped summary " + String(index),
                from: "previous",
                to: "current",
              },
      ),
    };
    const starts: number[] = [];
    const changelogClient: Partial<JiraReadClient> = {
      async getChangeLogs(input) {
        starts.push(input.startAt);
        return { histories: [history], startAt: input.startAt, total: 1 };
      },
      async getIssue() {
        return issue("SAFE-1");
      },
      async getChangeLogsByIds() {
        return { histories: [history] };
      },
    };
    const fixture = configured(changelogClient, {
      entities: { changelog: true },
    });
    const pages: ConnectorChangePage[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 5; index += 1) {
      const result = await fixture.adapter.pullChanges({ scope, cursor });
      if (!result.ok) throw new Error(result.failure.code);
      pages.push(result.value);
      if (result.value.terminal) break;
      cursor = result.value.nextCursor;
    }
    const changeRecords = pages.flatMap((page) =>
      page.records.filter((record) => record.ref.recordType === "jira.changelog"),
    );
    expect(changeRecords).toHaveLength(26);
    expect(starts).toEqual([0, 0]);
    expect(changeRecords[0]).toMatchObject({
      ref: {
        projectId,
        recordType: "jira.changelog",
        recordId: "501:91:0",
      },
      effectiveAt: "2026-09-20T12:30:00.000Z",
      observations: [
        {
          factType: "jira.summary",
          value: { type: "text", value: "Mapped summary 0" },
        },
      ],
    });
    expect(changeRecords.find((record) => record.ref.recordId === "501:91:24")).toMatchObject({
      observations: [
        { factType: "jira.size", value: { type: "number", value: 4.5 } },
      ],
    });
    const serialized = JSON.stringify(changeRecords);
    expect(serialized).not.toContain("Private Jira author");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("UNMAPPED CHANGELOG SECRET");

    const fetched = await fixture.adapter.getRecord(scope, {
      customerId,
      sourceId,
      projectId,
      recordType: "jira.changelog",
      recordId: "501:91:0",
    });
    expect(fetched).toMatchObject({ ok: true, value: changeRecords[0] });

    const alternate = configured(changelogClient, {
      entities: { changelog: true },
      fields: config.fields.map((field) =>
        field.jiraField === "summary"
          ? { ...field, factType: "jira.title" }
          : field,
      ),
    });
    const alternatePages: ConnectorChangePage[] = [];
    let alternateCursor: string | null = null;
    for (let index = 0; index < 5; index += 1) {
      const result = await alternate.adapter.pullChanges({
        scope,
        cursor: alternateCursor,
      });
      if (!result.ok) throw new Error(result.failure.code);
      alternatePages.push(result.value);
      if (result.value.terminal) break;
      alternateCursor = result.value.nextCursor;
    }
    const alternateRecords = alternatePages.flatMap((page) =>
      page.records.filter((record) => record.ref.recordType === "jira.changelog"),
    );
    expect(
      alternateRecords.map((record) => [
        record.ref.recordId,
        record.revision,
        record.sourceContentHash,
      ]),
    ).toEqual(
      changeRecords.map((record) => [
        record.ref.recordId,
        record.revision,
        record.sourceContentHash,
      ]),
    );
    expect(alternateRecords[0]?.observations[0]?.factType).toBe("jira.title");
  });

  it("reads only explicitly mapped boards and their sprints with stable IDs and timestamp values", async () => {
    const sprint = {
      id: 7,
      name: "Delivery sprint",
      state: "active",
      originBoardId: 42,
      startDate: new Date("2026-09-01T09:00:00.000Z"),
      endDate: new Date("2026-09-15T17:00:00.000Z"),
      completeDate: new Date("2026-09-15T16:00:00.000Z"),
    };
    const fixture = configured(
      {
        async getBoard({ boardId }) {
          return { id: boardId, name: "Delivery Board", type: "scrum" };
        },
        async getSprints(input) {
          return {
            startAt: input.startAt,
            maxResults: input.maxResults,
            total: 1,
            isLast: true,
            values: [sprint],
          };
        },
        async getSprint() {
          return sprint;
        },
      },
      {
        entities: { sprints: true },
        boards: [{ boardId: 42, projectId }],
      },
    );
    const connected = await fixture.adapter.testConnection(scope);
    expect(connected).toMatchObject({ ok: true });
    const initial = await fixture.adapter.pullChanges({ scope, cursor: null });
    if (!initial.ok) throw new Error(initial.failure.code);
    const page = await fixture.adapter.pullChanges({
      scope,
      cursor: initial.value.nextCursor,
    });
    if (!page.ok) throw new Error(page.failure.code);
    expect(page.value.terminal).toBe(true);
    expect(page.value.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: { customerId, sourceId, projectId, recordType: "jira.board", recordId: "42" },
          observations: expect.arrayContaining([
            { factType: "jira.board.name", value: { type: "text", value: "Delivery Board" } },
          ]),
        }),
        expect.objectContaining({
          ref: { customerId, sourceId, projectId, recordType: "jira.sprint", recordId: "42:7" },
          effectiveAt: "2026-09-24T00:00:00.000Z",
          observations: expect.arrayContaining([
            { factType: "jira.sprint.start_at", value: { type: "text", value: "2026-09-01T09:00:00.000Z" } },
            { factType: "jira.sprint.end_at", value: { type: "text", value: "2026-09-15T17:00:00.000Z" } },
            { factType: "jira.sprint.completed_at", value: { type: "text", value: "2026-09-15T16:00:00.000Z" } },
          ]),
        }),
      ]),
    );
    const fetched = await fixture.adapter.getRecord(scope, {
      customerId,
      sourceId,
      projectId,
      recordType: "jira.sprint",
      recordId: "42:7",
    });
    expect(fetched).toMatchObject({
      ok: true,
      value: { ref: { recordType: "jira.sprint", recordId: "42:7" } },
    });
    expect(
      fixture.adapter.getDeepLink(scope, {
        customerId,
        sourceId,
        projectId,
        recordType: "jira.sprint",
        recordId: "42:7",
      }),
    ).toBe("https://acme.atlassian.net/secure/RapidView.jspa?rapidView=42");
  });

  it("rejects noncanonical or inconsistent continuation state and malformed remote pages", async () => {
    const fixture = configured(
      {
        async searchIssues() {
          return { issues: [], isLast: false, nextPageToken: "same-token" };
        },
      },
      { entities: { issueLinks: true } },
    );
    const result = await fixture.adapter.pullChanges({
      scope,
      cursor: '["j1","l","same-token",null,0]',
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "INVALID_RESPONSE" },
    });
  });

  it("rejects a relation endpoint whose present Jira object has no issue key", async () => {
    const malformed = {
      ...issue("SAFE-1"),
      fields: {
        ...issue("SAFE-1").fields,
        issuelinks: [
          {
            id: "4",
            type: { id: "10000", name: "relates to" },
            outwardIssue: {},
          },
        ],
      },
    };
    const fixture = configured(
      {
        async searchIssues(input) {
          return { issues: [malformed], isLast: true };
        },
      },
      { entities: { issueLinks: true } },
    );
    const first = await fixture.adapter.pullChanges({ scope, cursor: null });
    if (!first.ok) throw new Error(first.failure.code);
    const second = await fixture.adapter.pullChanges({
      scope,
      cursor: first.value.nextCursor,
    });
    expect(second).toMatchObject({
      ok: false,
      failure: { code: "INVALID_RESPONSE" },
    });
  });

});
