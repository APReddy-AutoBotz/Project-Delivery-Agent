import { createCloudClient } from "jira.js";
import {
  connectorReadScopeSchema,
  connectorReadRequestSchema,
  connectorRecordRefSchema,
  parseIngestion,
  validateConnectorDiscovery,
  validateConnectorPage,
  validateConnectorRecord,
  validateConnectorConnection,
  type ConnectorChangePage,
  type ConnectorFailure,
  type ConnectorReadScope,
  type ConnectorRecord,
  type ConnectorRecordRef,
  type ConnectorResult,
  type ProjectFactValue,
  type ReadOnlyConnector,
} from "@pdaa/domain";
import { createHash } from "node:crypto";
import { z } from "zod";

const projectMapSchema = z
  .array(
    z
      .object({
        projectId: z.string().uuid(),
        projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,49}$/),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine(
    (items) =>
      new Set(items.map((item) => item.projectId)).size === items.length,
  )
  .refine(
    (items) =>
      new Set(items.map((item) => item.projectKey)).size === items.length,
  );

const fieldMapSchema = z
  .array(
    z
      .object({
        jiraField: z
          .string()
          .regex(
            /^(summary|status|assignee|duedate|issuetype|parent|customfield_[0-9]+)$/,
          ),
        factType: z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/),
        valueType: z.enum(["text", "date", "number", "boolean"]),
      })
      .strict(),
  )
  .min(1)
  .max(32)
  .refine(
    (items) =>
      new Set(items.map((item) => item.jiraField)).size === items.length,
  )
  .refine(
    (items) =>
      new Set(items.map((item) => item.factType)).size === items.length,
  )
  .superRefine((items, context) => {
    for (const [index, item] of items.entries()) {
      const requiredType =
        item.jiraField === "duedate"
          ? "date"
          : item.jiraField.startsWith("customfield_")
            ? null
            : "text";
      if (requiredType && item.valueType !== requiredType) {
        context.addIssue({
          code: "custom",
          path: [index, "valueType"],
          message: "Invalid field type",
        });
      }
    }
  });

export type JiraProjectMapping = z.infer<typeof projectMapSchema>[number];
export type JiraFieldMapping = z.infer<typeof fieldMapSchema>[number];
export type JiraReadAdapterConfig = {
  origin: string;
  customerId: string;
  sourceId: string;
  projects: JiraProjectMapping[];
  fields: JiraFieldMapping[];
  pageSize?: number;
  now?: () => Date;
};

type JiraIssue = {
  id: string;
  key: string;
  self?: string;
  fields: Record<string, unknown>;
};
export interface JiraReadClient {
  getProject(input: { projectIdOrKey: string }): Promise<{ key: string }>;
  searchIssues(input: {
    jql: string;
    fields: string[];
    maxResults: number;
    nextPageToken?: string;
  }): Promise<{
    issues?: JiraIssue[];
    isLast?: boolean;
    nextPageToken?: string | null;
  }>;
  getIssue(input: {
    issueIdOrKey: string;
    fields: string[];
  }): Promise<JiraIssue>;
}

const safeDate = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const boundedString = (value: unknown, max = 2048): string | null =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !/[\0\p{Surrogate}]/u.test(value)
    ? value
    : null;
const toValue = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedString(value, 2048);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => toValue(item, depth + 1));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(source).slice(0, 20)) {
      if (key.length <= 96) result[key] = toValue(source[key], depth + 1);
    }
    return result;
  }
  return null;
};
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const scopeProjects = (
  scope: ConnectorReadScope,
  projects: JiraProjectMapping[],
) => {
  const allowed = new Set(scope.projectIds);
  return projects.filter((project) => allowed.has(project.projectId));
};
const mapFailure = (error: unknown): ConnectorFailure => {
  const e =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  if (e.message === "INVALID_RESPONSE" || e.name === "IngestionInputError")
    return { code: "INVALID_RESPONSE", retryAfterMs: null };
  const status =
    typeof e.status === "number" && Number.isInteger(e.status)
      ? e.status
      : undefined;
  const statusText = typeof e.name === "string" ? e.name : "";
  const retry =
    Number.isInteger(e.retryAfterMs) && (e.retryAfterMs as number) >= 0
      ? Math.min(e.retryAfterMs as number, 86_400_000)
      : null;
  const code: ConnectorFailure["code"] =
    status === 401 || statusText === "AuthError" || statusText === "ScopeError"
      ? "INVALID_CREDENTIALS"
      : status === 403 || statusText === "ForbiddenError"
        ? "PERMISSION_DENIED"
        : status === 404 || statusText === "NotFoundError"
          ? "NOT_FOUND"
          : status === 429 || statusText === "RateLimitError"
            ? "RATE_LIMITED"
            : (status !== undefined && status >= 500) ||
                statusText === "NetworkError" ||
                statusText === "ServerError"
              ? "TEMPORARILY_UNAVAILABLE"
              : status !== undefined
                ? "INVALID_RESPONSE"
                : "UNKNOWN_OUTCOME";
  return {
    code,
    retryAfterMs:
      code === "RATE_LIMITED" || code === "TEMPORARILY_UNAVAILABLE"
        ? retry
        : null,
  };
};
const capture = async <TInput, TOutput>(
  action: () => Promise<TInput>,
  validate: (value: unknown) => TOutput,
): Promise<ConnectorResult<TOutput>> => {
  try {
    return { ok: true, value: validate(await action()) };
  } catch (error) {
    return { ok: false, failure: mapFailure(error) };
  }
};

export function createJiraReadOnlyConnector(
  client: JiraReadClient,
  configInput: JiraReadAdapterConfig,
): ReadOnlyConnector {
  const origin = new URL(configInput.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== configInput.origin ||
    origin.username ||
    origin.password
  )
    throw new Error("INVALID_CONFIG");
  const projects = projectMapSchema.parse(configInput.projects);
  const fieldMappings = fieldMapSchema.parse(configInput.fields);
  const pageSize = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(configInput.pageSize ?? 50);
  const now = configInput.now ?? (() => new Date());
  const binding = {
    customerId: configInput.customerId,
    sourceId: configInput.sourceId,
    sourceType: "jira",
    origin: configInput.origin,
  };
  const fields = [
    ...new Set([
      "project",
      "updated",
      ...fieldMappings.map((field) => field.jiraField),
    ]),
  ];
  const record = (
    scope: ConnectorReadScope,
    issue: JiraIssue,
    expected?: ConnectorRecordRef,
  ): ConnectorRecord => {
    const key = boundedString(issue.key, 128);
    const jiraId = boundedString(issue.id, 128);
    const updated = safeDate(issue.fields.updated);
    const mapped = projects.find(
      (p) =>
        p.projectKey ===
          (issue.fields.project as { key?: unknown } | undefined)?.key &&
        scope.projectIds.includes(p.projectId),
    );
    if (
      !key ||
      !/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(key) ||
      !jiraId ||
      !updated ||
      !mapped
    )
      throw new Error("INVALID_RESPONSE");
    const ref: ConnectorRecordRef = {
      customerId: configInput.customerId,
      sourceId: configInput.sourceId,
      projectId: mapped.projectId,
      recordType: "jira.issue",
      recordId: key,
    };
    const observations = fieldMappings.flatMap(
      ({ jiraField, factType, valueType }) => {
        const raw = issue.fields[jiraField];
        let scalar: unknown = raw;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          const object = raw as Record<string, unknown>;
          scalar =
            jiraField === "assignee"
              ? (object.accountId ?? object.displayName)
              : (object.name ?? object.key ?? object.value ?? object.accountId);
        }
        const value = toValue(scalar);
        if (value === null || value === undefined) return [];
        let typed: ProjectFactValue | null = null;
        if (valueType === "text" && typeof value === "string")
          typed = { type: "text", value };
        if (
          valueType === "date" &&
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(value)
        )
          typed = { type: "date", value };
        if (
          valueType === "number" &&
          typeof value === "number" &&
          Number.isFinite(value)
        )
          typed = { type: "number", value };
        if (valueType === "boolean" && typeof value === "boolean")
          typed = { type: "boolean", value };
        if (!typed) return [];
        return [{ factType, value: typed }];
      },
    );
    const sourceFields: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const jiraField of [
      ...new Set(fieldMappings.map((field) => field.jiraField)),
    ].sort()) {
      sourceFields[jiraField] = toValue(issue.fields[jiraField]);
    }
    const canonical = JSON.stringify({
      id: jiraId,
      key,
      project: mapped.projectKey,
      updated,
      fields: sourceFields,
    });
    const sourceContentHash = sha256(canonical);
    const result: ConnectorRecord = {
      ref,
      revision: updated,
      sourceContentHash,
      observedAt: now().toISOString(),
      effectiveAt: updated,
      deepLink: `${configInput.origin}/browse/${encodeURIComponent(key)}`,
      observations,
    };
    return validateConnectorRecord(scope, expected ?? ref, result);
  };
  const scoped = (input: unknown) =>
    parseIngestion(connectorReadScopeSchema, input);
  const matchesBinding = (scope: ConnectorReadScope) =>
    scope.binding.customerId === binding.customerId &&
    scope.binding.sourceId === binding.sourceId &&
    scope.binding.sourceType === binding.sourceType &&
    scope.binding.origin === binding.origin;
  return {
    async testConnection(input) {
      const scope = scoped(input);
      if (!matchesBinding(scope))
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      const selected = scopeProjects(scope, projects);
      if (!selected.length)
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      return capture(
        () =>
          client
            .getProject({ projectIdOrKey: selected[0]!.projectKey })
            .then((found) => {
              if (found.key !== selected[0]!.projectKey)
                throw new Error("INVALID_RESPONSE");
              return { checkedAt: now().toISOString() };
            }),
        validateConnectorConnection,
      );
    },
    async discoverScopes(input) {
      const scope = scoped(input);
      if (!matchesBinding(scope))
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      const selected = scopeProjects(scope, projects);
      const visible: string[] = [];
      for (const project of selected) {
        try {
          const result = await client.getProject({
            projectIdOrKey: project.projectKey,
          });
          if (result.key === project.projectKey)
            visible.push(project.projectId);
        } catch (error) {
          const failure = mapFailure(error);
          if (
            failure.code !== "NOT_FOUND" &&
            failure.code !== "PERMISSION_DENIED"
          )
            return { ok: false, failure };
        }
      }
      return {
        ok: true,
        value: validateConnectorDiscovery(scope, {
          projectIds: visible,
          checkedAt: now().toISOString(),
        }),
      };
    },
    async pullChanges(input) {
      const request = parseIngestion(connectorReadRequestSchema, input);
      if (!matchesBinding(request.scope))
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      const selected = scopeProjects(request.scope, projects);
      if (!selected.length)
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      const jql = `project in (${selected.map((p) => `"${p.projectKey}"`).join(",")}) ORDER BY updated ASC, key ASC`;
      return capture(
        () =>
          client.searchIssues({
            jql,
            fields,
            maxResults: pageSize,
            ...(request.cursor ? { nextPageToken: request.cursor } : {}),
          }),
        (raw) => {
          const page = raw as {
            issues?: JiraIssue[];
            isLast?: boolean;
            nextPageToken?: string | null;
          };
          if (!Array.isArray(page.issues)) throw new Error("INVALID_RESPONSE");
          if (
            page.issues.length > pageSize ||
            page.issues.some((i) => !i || !i.fields)
          )
            throw new Error("INVALID_RESPONSE");
          if (page.isLast === false && !page.nextPageToken)
            throw new Error("INVALID_RESPONSE");
          if (page.isLast === true && page.nextPageToken)
            throw new Error("INVALID_RESPONSE");
          const terminal = page.isLast === true || !page.nextPageToken;
          const nextCursor = terminal
            ? null
            : boundedString(page.nextPageToken, 2048);
          if (!terminal && !nextCursor) throw new Error("INVALID_RESPONSE");
          const result: ConnectorChangePage = {
            binding,
            inputCursor: request.cursor,
            nextCursor,
            terminal,
            records: page.issues.map((issue) => record(request.scope, issue)),
          };
          return validateConnectorPage(request, result);
        },
      );
    },
    async getRecord(input, refInput) {
      const scope = scoped(input);
      if (!matchesBinding(scope))
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      const ref = parseIngestion(connectorRecordRefSchema, refInput);
      if (
        ref.customerId !== configInput.customerId ||
        ref.sourceId !== configInput.sourceId ||
        ref.recordType !== "jira.issue" ||
        !scope.projectIds.includes(ref.projectId)
      ) {
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      }
      if (!/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(ref.recordId)) {
        return {
          ok: false,
          failure: { code: "INVALID_RESPONSE", retryAfterMs: null },
        };
      }
      const project = projects.find((item) => item.projectId === ref.projectId);
      if (!project || !ref.recordId.startsWith(`${project.projectKey}-`))
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      return capture(
        () => client.getIssue({ issueIdOrKey: ref.recordId, fields }),
        (raw) => record(scope, raw as JiraIssue, ref),
      );
    },
    getDeepLink(input, refInput) {
      const scope = scoped(input);
      const ref = parseIngestion(connectorRecordRefSchema, refInput);
      if (!matchesBinding(scope)) return null;
      const project = projects.find((p) => p.projectId === ref.projectId);
      if (
        ref.customerId !== configInput.customerId ||
        ref.sourceId !== configInput.sourceId ||
        ref.recordType !== "jira.issue" ||
        !scope.projectIds.includes(ref.projectId) ||
        !project ||
        !/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(ref.recordId) ||
        !ref.recordId.startsWith(`${project.projectKey}-`)
      )
        return null;
      return `${configInput.origin}/browse/${encodeURIComponent(ref.recordId)}`;
    },
  };
}

export function createJiraCloudClient(options: {
  siteUrl: string;
  email: string;
  apiToken: string;
}): JiraReadClient {
  const host = new URL(options.siteUrl);
  if (
    host.protocol !== "https:" ||
    host.origin !== options.siteUrl ||
    !options.email ||
    !options.apiToken
  )
    throw new Error("INVALID_CONFIG");
  const jira = createCloudClient({
    host: options.siteUrl,
    auth: { type: "basic", email: options.email, apiToken: options.apiToken },
    retry: { maxAttempts: 1 },
  });
  return {
    getProject: async (input) => {
      const result = await jira.projects.getProject(input);
      return { key: result.key ?? "" };
    },
    searchIssues: async (input) => {
      const result =
        await jira.issueSearch.searchAndReconsileIssuesUsingJqlPost(input);
      return {
        issues: result.issues as unknown as JiraIssue[] | undefined,
        isLast: result.isLast,
        nextPageToken: result.nextPageToken,
      };
    },
    getIssue: async (input) =>
      (await jira.issues.getIssue(input)) as unknown as JiraIssue,
  };
}
