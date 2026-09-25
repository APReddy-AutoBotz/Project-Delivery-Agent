import { createAgileClient, createCloudClient } from "jira.js";
import { createClient } from "jira.js/core";
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
  type ConnectorReadRequest,
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

const boardMapSchema = z
  .array(
    z
      .object({
        boardId: z.number().int().positive().max(2_147_483_647),
        projectId: z.string().uuid(),
      })
      .strict(),
  )
  .max(100)
  .refine((items) => new Set(items.map((item) => item.boardId)).size === items.length);

const entitySelectionSchema = z
  .object({
    issueLinks: z.boolean().optional().default(false),
    changelog: z.boolean().optional().default(false),
    sprints: z.boolean().optional().default(false),
  })
  .strict();

export type JiraProjectMapping = z.infer<typeof projectMapSchema>[number];
export type JiraFieldMapping = z.infer<typeof fieldMapSchema>[number];
export type JiraBoardMapping = z.infer<typeof boardMapSchema>[number];
export type JiraReadEntitySelection = z.infer<typeof entitySelectionSchema>;
export type JiraReadAdapterConfig = {
  origin: string;
  customerId: string;
  sourceId: string;
  projects: JiraProjectMapping[];
  fields: JiraFieldMapping[];
  entities?: Partial<JiraReadEntitySelection>;
  boards?: JiraBoardMapping[];
  pageSize?: number;
  now?: () => Date;
};

const jiraReadAdapterOptionsSchema = z
  .object({
    projects: projectMapSchema,
    fields: fieldMapSchema,
    entities: entitySelectionSchema.optional(),
    boards: boardMapSchema.optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const entities = value.entities ?? entitySelectionSchema.parse({});
    const boards = value.boards ?? [];
    if (entities.sprints && boards.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["boards"],
        message: "Sprint reads require explicit board-to-project mappings",
      });
    }
    if (!entities.sprints && boards.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["boards"],
        message: "Board mappings are only valid when sprint reads are enabled",
      });
    }
    const projectIds = new Set(value.projects.map((project) => project.projectId));
    for (const [index, board] of boards.entries()) {
      if (!projectIds.has(board.projectId)) {
        context.addIssue({
          code: "custom",
          path: ["boards", index, "projectId"],
          message: "Board mapping must reference a configured project",
        });
      }
    }
  });

export function parseJiraReadAdapterOptions(input: unknown) {
  const parsed = jiraReadAdapterOptionsSchema.safeParse(input);
  if (!parsed.success) throw new Error("INVALID_CONFIG");
  return parsed.data;
}

type JiraIssue = {
  id: string;
  key: string;
  self?: string;
  fields: Record<string, unknown>;
};
type JiraHistory = {
  id?: unknown;
  created?: unknown;
  items?: unknown;
};
type JiraIssueLink = {
  id?: unknown;
  type?: unknown;
  inwardIssue?: unknown;
  outwardIssue?: unknown;
};
type JiraBoard = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
};
type JiraSprint = {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  originBoardId?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  completeDate?: unknown;
};
type JiraOffsetPage<T> = {
  startAt?: number;
  maxResults?: number;
  total?: number;
  isLast?: boolean;
  values?: T[];
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
  getChangeLogs?(input: {
    issueIdOrKey: string;
    startAt: number;
    maxResults: number;
  }): Promise<{
    histories?: JiraHistory[];
    startAt?: number;
    total?: number;
  }>;
  getChangeLogsByIds?(input: {
    issueIdOrKey: string;
    changelogIds: number[];
  }): Promise<{ histories?: JiraHistory[] }>;
  getIssueLink?(input: { linkId: string }): Promise<JiraIssueLink>;
  getBoard?(input: { boardId: number }): Promise<JiraBoard>;
  getSprints?(input: {
    boardId: number;
    startAt: number;
    maxResults: number;
  }): Promise<JiraOffsetPage<JiraSprint>>;
  getSprint?(input: { sprintId: number }): Promise<JiraSprint>;
}

const safeDate = (value: unknown): string | null => {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
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
type JiraEntityCursor =
  | { phase: "issues"; token: string | null }
  | {
      phase: "links";
      token: string | null;
      issueKey: string | null;
      offset: number;
    }
  | {
      phase: "changelog";
      token: string | null;
      issueKey: string | null;
      historyOffset: number;
      itemOffset: number;
    }
  | { phase: "sprints"; boardIndex: number; startAt: number };

const safeOffset = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1_000_000;

const parseJiraEntityCursor = (input: string | null): JiraEntityCursor => {
  if (input === null) return { phase: "issues", token: null };
  if (!input.startsWith('["j1",')) {
    const token = boundedString(input, 2048);
    if (!token) throw new Error("INVALID_RESPONSE");
    return { phase: "issues", token };
  }
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new Error("INVALID_RESPONSE");
  }
  if (!Array.isArray(value) || value[0] !== "j1") throw new Error("INVALID_RESPONSE");
  const token = (item: unknown): string | null => {
    if (item === null) return null;
    const parsed = boundedString(item, 2048);
    if (!parsed) throw new Error("INVALID_RESPONSE");
    return parsed;
  };
  if (value[1] === "i" && value.length === 3)
    return { phase: "issues", token: token(value[2]) };
  if (
    value[1] === "l" &&
    value.length === 5 &&
    ((value[3] === null && value[4] === 0) ||
      (typeof value[3] === "string" &&
        /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(value[3]))) &&
    safeOffset(value[4])
  )
    return {
      phase: "links",
      token: token(value[2]),
      issueKey: value[3] as string | null,
      offset: value[4],
    };
  if (
    value[1] === "h" &&
    value.length === 6 &&
    ((value[3] === null && value[4] === 0 && value[5] === 0) ||
      (typeof value[3] === "string" &&
        /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(value[3]))) &&
    safeOffset(value[4]) &&
    safeOffset(value[5])
  )
    return {
      phase: "changelog",
      token: token(value[2]),
      issueKey: value[3] as string | null,
      historyOffset: value[4],
      itemOffset: value[5],
    };
  if (
    value[1] === "s" &&
    value.length === 4 &&
    safeOffset(value[2]) &&
    safeOffset(value[3])
  )
    return { phase: "sprints", boardIndex: value[2], startAt: value[3] };
  throw new Error("INVALID_RESPONSE");
};

const encodeJiraEntityCursor = (cursor: JiraEntityCursor): string => {
  const tuple =
    cursor.phase === "issues"
      ? ["j1", "i", cursor.token]
      : cursor.phase === "links"
        ? ["j1", "l", cursor.token, cursor.issueKey, cursor.offset]
        : cursor.phase === "changelog"
          ? [
              "j1",
              "h",
              cursor.token,
              cursor.issueKey,
              cursor.historyOffset,
              cursor.itemOffset,
            ]
          : ["j1", "s", cursor.boardIndex, cursor.startAt];
  const encoded = JSON.stringify(tuple);
  if (encoded.length > 2048) throw new Error("INVALID_RESPONSE");
  return encoded;
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
  const options = parseJiraReadAdapterOptions({
    projects: configInput.projects,
    fields: configInput.fields,
    ...(configInput.entities ? { entities: configInput.entities } : {}),
    ...(configInput.boards ? { boards: configInput.boards } : {}),
    ...(configInput.pageSize !== undefined ? { pageSize: configInput.pageSize } : {}),
  });
  const projects = options.projects;
  const fieldMappings = options.fields;
  const entities = options.entities ?? entitySelectionSchema.parse({});
  const boards = options.boards ?? [];
  const pageSize = options.pageSize ?? 50;
  if (
    (entities.issueLinks && typeof client.getIssue !== "function") ||
    (entities.changelog && typeof client.getChangeLogs !== "function") ||
    (entities.sprints &&
      (typeof client.getBoard !== "function" || typeof client.getSprints !== "function"))
  )
    throw new Error("INVALID_CONFIG");
  const now = configInput.now ?? (() => new Date());
  const mapObservation = (
    mapping: JiraFieldMapping,
    raw: unknown,
  ): { factType: string; value: ProjectFactValue } | null => {
    let scalar: unknown = raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const object = raw as Record<string, unknown>;
      scalar =
        mapping.jiraField === "assignee"
          ? (object.accountId ?? object.displayName)
          : (object.name ?? object.key ?? object.value ?? object.accountId);
    }
    let value = toValue(scalar);
    if (
      mapping.valueType === "number" &&
      typeof value === "string" &&
      /^-?\d+(?:\.\d+)?$/.test(value)
    ) {
      const numeric = Number(value);
      value = Number.isFinite(numeric) ? numeric : null;
    }
    if (mapping.valueType === "boolean" && value === "true") value = true;
    if (mapping.valueType === "boolean" && value === "false") value = false;
    if (value === null || value === undefined) return null;
    let typed: ProjectFactValue | null = null;
    if (mapping.valueType === "text" && typeof value === "string")
      typed = { type: "text", value };
    if (
      mapping.valueType === "date" &&
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value)
    )
      typed = { type: "date", value };
    if (
      mapping.valueType === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      typed = { type: "number", value };
    if (mapping.valueType === "boolean" && typeof value === "boolean")
      typed = { type: "boolean", value };
    return typed ? { factType: mapping.factType, value: typed } : null;
  };
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
  const entityIssueFields = entities.issueLinks
    ? [...new Set([...fields, "issuelinks"])]
    : fields;
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
    const observations = fieldMappings.flatMap((mapping) => {
      const mapped = mapObservation(mapping, issue.fields[mapping.jiraField]);
      return mapped ? [mapped] : [];
    });
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

  const entityPageSize = Math.min(pageSize, 25);
  const entityEnabled =
    entities.issueLinks || entities.changelog || entities.sprints;
  const activeBoards = (scope: ConnectorReadScope) =>
    boards.filter((board) => scope.projectIds.includes(board.projectId));
  const issueProject = (scope: ConnectorReadScope, issueKey: string) =>
    projects.find(
      (project) =>
        issueKey.startsWith(`${project.projectKey}-`) &&
        scope.projectIds.includes(project.projectId),
    ) ?? null;
  const toExternalId = (value: unknown, max = 128): string | null => {
    if (typeof value === "string") return boundedString(value, max);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      return String(value);
    return null;
  };
  const numericExternalId = (value: unknown): string | null => {
    const id = toExternalId(value);
    return id && /^[1-9][0-9]{0,9}$/.test(id) && Number(id) <= 2_147_483_647
      ? id
      : null;
  };
  const objectValue = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const makeRecord = (
    scope: ConnectorReadScope,
    input: {
      projectId: string;
      recordType: string;
      recordId: string;
      revision: string;
      sourceContentHash: string;
      effectiveAt: string;
      deepLink?: string | null;
      observations?: ConnectorRecord["observations"];
    },
  ): ConnectorRecord => {
    const ref: ConnectorRecordRef = {
      customerId: configInput.customerId,
      sourceId: configInput.sourceId,
      projectId: input.projectId,
      recordType: input.recordType,
      recordId: input.recordId,
    };
    return validateConnectorRecord(scope, ref, {
      ref,
      revision: input.revision,
      sourceContentHash: input.sourceContentHash,
      observedAt: now().toISOString(),
      effectiveAt: input.effectiveAt,
      deepLink: input.deepLink ?? null,
      observations: input.observations ?? [],
    });
  };
  const linkRecord = (
    scope: ConnectorReadScope,
    linkInput: unknown,
    sourceIssueKey: string,
  ): ConnectorRecord | null => {
    const link = objectValue(linkInput);
    const type = objectValue(link?.type);
    const hasInwardEndpoint =
      link?.inwardIssue !== undefined && link.inwardIssue !== null;
    const hasOutwardEndpoint =
      link?.outwardIssue !== undefined && link.outwardIssue !== null;
    const inward = objectValue(link?.inwardIssue);
    const outward = objectValue(link?.outwardIssue);
    const linkedInwardKey = boundedString(inward?.key, 128);
    const linkedOutwardKey = boundedString(outward?.key, 128);
    const inwardKey = hasInwardEndpoint ? linkedInwardKey : sourceIssueKey;
    const outwardKey = hasOutwardEndpoint ? linkedOutwardKey : sourceIssueKey;
    const linkId = numericExternalId(link?.id);
    const typeName = boundedString(type?.name, 128);
    const typeId = toExternalId(type?.id);
    if (
      !link ||
      !type ||
      !inwardKey ||
      !outwardKey ||
      inwardKey === outwardKey ||
      (hasInwardEndpoint && !linkedInwardKey) ||
      (hasOutwardEndpoint && !linkedOutwardKey) ||
      (hasInwardEndpoint && !inward) ||
      (hasOutwardEndpoint && !outward) ||
      !linkId ||
      !typeName ||
      (linkedInwardKey && linkedOutwardKey &&
        sourceIssueKey !== linkedInwardKey &&
        sourceIssueKey !== linkedOutwardKey)
    )
      throw new Error("INVALID_RESPONSE");
    if (
      !/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(inwardKey) ||
      !/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(outwardKey) ||
      (sourceIssueKey !== inwardKey && sourceIssueKey !== outwardKey)
    )
      throw new Error("INVALID_RESPONSE");
    const outwardProject = issueProject(scope, outwardKey);
    const inwardProject = issueProject(scope, inwardKey);
    if (!outwardProject || !inwardProject) return null;
    // Jira returns the same relation when either endpoint is scanned. Emit once
    // under the deterministic endpoint's mapped project so the record reference
    // and direct lookup use the same project owner.
    const canonicalKey = [outwardKey, inwardKey].sort()[0]!;
    if (canonicalKey !== sourceIssueKey) return null;
    const canonicalProject = issueProject(scope, canonicalKey);
    if (!canonicalProject) return null;
    const canonical = JSON.stringify({
      id: linkId,
      typeId,
      typeName,
      inwardKey,
      outwardKey,
      inwardProject: inwardProject.projectKey,
      outwardProject: outwardProject.projectKey,
    });
    const sourceContentHash = sha256(canonical);
    const recordId = linkId;
    return makeRecord(scope, {
      projectId: canonicalProject.projectId,
      recordType: "jira.issue_link",
      recordId,
      revision: `snapshot:${sourceContentHash}`,
      sourceContentHash,
      // Issue links do not expose a reliable relation update timestamp.
      effectiveAt: now().toISOString(),
      deepLink: `${configInput.origin}/browse/${encodeURIComponent(outwardKey)}`,
      observations: [
        { factType: "jira.issue_link.type", value: { type: "text", value: typeName } },
        {
          factType: "jira.issue_link.inward",
          value: { type: "text", value: inwardKey },
        },
        {
          factType: "jira.issue_link.outward",
          value: { type: "text", value: outwardKey },
        },
        ...(typeId
          ? [
              {
                factType: "jira.issue_link.type_id",
                value: { type: "text" as const, value: typeId },
              },
            ]
          : []),
      ],
    });
  };
  const changelogItemRecord = (
    scope: ConnectorReadScope,
    issueKey: string,
    issueId: string,
    history: JiraHistory,
    itemInput: unknown,
    itemOrdinal: number,
  ): ConnectorRecord | null => {
    const item = objectValue(itemInput);
    if (!item) throw new Error("INVALID_RESPONSE");
    const historyId = numericExternalId(history.id);
    const created = safeDate(history.created);
    const fieldId =
      boundedString(item.fieldId, 96) ?? boundedString(item.field, 96);
    if (!historyId || !created || !fieldId)
      throw new Error("INVALID_RESPONSE");
    const mapping = fieldMappings.find(
      (candidate) =>
        candidate.jiraField === fieldId ||
        candidate.jiraField === item.field ||
        candidate.jiraField === item.fieldId,
    );
    if (!mapping) return null;
    // Assignee and typed scalar values use the source value; text mappings use
    // Jira's display value when present, without retaining the history author.
    const value =
      mapping.jiraField === "assignee" || mapping.valueType !== "text"
        ? item.to
        : (Object.prototype.hasOwnProperty.call(item, "toString")
            ? item.toString
            : item.to);
    const observation = mapObservation(mapping, value);
    if (!observation) return null;
    const project = issueProject(scope, issueKey);
    if (!project) throw new Error("INVALID_RESPONSE");
    const boundedItem = {
      fieldId,
      field: boundedString(item.field, 96),
      from: toValue(item.from),
      to: toValue(item.to),
      fromString: toValue(item.fromString),
      toString: toValue(item.toString),
    };
    const sourceContentHash = sha256(
      JSON.stringify({ historyId, created, item: boundedItem }),
    );
    return makeRecord(scope, {
      projectId: project.projectId,
      recordType: "jira.changelog",
      recordId: `${issueId}:${historyId}:${itemOrdinal}`,
      revision: `${created}:${historyId}:${itemOrdinal}`,
      sourceContentHash,
      effectiveAt: created,
      deepLink: `${configInput.origin}/browse/${encodeURIComponent(issueKey)}`,
      observations: [observation],
    });
  };
  const boardRecord = (
    scope: ConnectorReadScope,
    mapping: JiraBoardMapping,
    boardInput: JiraBoard,
  ): ConnectorRecord => {
    const id = numericExternalId(boardInput.id);
    const name = boundedString(boardInput.name, 256);
    const type = boundedString(boardInput.type, 64);
    if (!id || id !== String(mapping.boardId) || !name || !type)
      throw new Error("INVALID_RESPONSE");
    const project = projects.find(
      (candidate) => candidate.projectId === mapping.projectId,
    );
    if (!project || !scope.projectIds.includes(project.projectId))
      throw new Error("INVALID_RESPONSE");
    const sourceContentHash = sha256(JSON.stringify({ id, name, type }));
    const observedAt = now().toISOString();
    return makeRecord(scope, {
      projectId: project.projectId,
      recordType: "jira.board",
      recordId: id,
      revision: `snapshot:${sourceContentHash}`,
      sourceContentHash,
      // Board responses have no source update timestamp. This is a snapshot
      // observation time, not a claimed Jira modification time.
      effectiveAt: observedAt,
      deepLink: `${configInput.origin}/secure/RapidView.jspa?rapidView=${encodeURIComponent(id)}`,
      observations: [
        { factType: "jira.board.name", value: { type: "text", value: name } },
        { factType: "jira.board.type", value: { type: "text", value: type } },
      ],
    });
  };
  const sprintRecord = (
    scope: ConnectorReadScope,
    mapping: JiraBoardMapping,
    sprintInput: JiraSprint,
    requireOriginBoardId = false,
  ): ConnectorRecord => {
    const id = numericExternalId(sprintInput.id);
    const name = boundedString(sprintInput.name, 256);
    const state = boundedString(sprintInput.state, 32);
    const originBoardId = numericExternalId(sprintInput.originBoardId);
    if (
      !id ||
      !name ||
      !["future", "active", "closed"].includes(state ?? "") ||
      (originBoardId !== null && originBoardId !== String(mapping.boardId)) ||
      (requireOriginBoardId && originBoardId !== String(mapping.boardId))
    )
      throw new Error("INVALID_RESPONSE");
    const project = projects.find(
      (candidate) => candidate.projectId === mapping.projectId,
    );
    if (!project || !scope.projectIds.includes(project.projectId))
      throw new Error("INVALID_RESPONSE");
    const startDate = safeDate(sprintInput.startDate);
    const endDate = safeDate(sprintInput.endDate);
    const completeDate = safeDate(sprintInput.completeDate);
    if (
      (sprintInput.startDate !== undefined &&
        sprintInput.startDate !== null &&
        !startDate) ||
      (sprintInput.endDate !== undefined &&
        sprintInput.endDate !== null &&
        !endDate) ||
      (sprintInput.completeDate !== undefined &&
        sprintInput.completeDate !== null &&
        !completeDate)
    )
      throw new Error("INVALID_RESPONSE");
    const canonical = JSON.stringify({
      id,
      name,
      state,
      originBoardId: originBoardId ?? String(mapping.boardId),
      startDate,
      endDate,
      completeDate,
    });
    const sourceContentHash = sha256(canonical);
    const observedAt = now().toISOString();
    return makeRecord(scope, {
      projectId: project.projectId,
      recordType: "jira.sprint",
      recordId: `${mapping.boardId}:${id}`,
      revision: `snapshot:${sourceContentHash}`,
      sourceContentHash,
      // Sprint list values do not expose a reliable change timestamp. Preserve a
      // content-derived revision and use the actual snapshot observation time.
      effectiveAt: observedAt,
      deepLink: `${configInput.origin}/secure/RapidView.jspa?rapidView=${mapping.boardId}`,
      observations: [
        { factType: "jira.sprint.name", value: { type: "text", value: name } },
        { factType: "jira.sprint.state", value: { type: "text", value: state! } },
        ...(startDate
          ? [{ factType: "jira.sprint.start_at", value: { type: "text" as const, value: startDate } }]
          : []),
        ...(endDate
          ? [{ factType: "jira.sprint.end_at", value: { type: "text" as const, value: endDate } }]
          : []),
        ...(completeDate
          ? [{ factType: "jira.sprint.completed_at", value: { type: "text" as const, value: completeDate } }]
          : []),
      ],
    });
  };
  const nextEntityPhase = (
    phase: "links" | "changelog",
  ): JiraEntityCursor | null => {
    if (phase === "links" && entities.changelog)
      return {
        phase: "changelog",
        token: null,
        issueKey: null,
        historyOffset: 0,
        itemOffset: 0,
      };
    if (entities.sprints)
      return { phase: "sprints", boardIndex: 0, startAt: 0 };
    return null;
  };
  const firstEntityPhase = (): JiraEntityCursor | null => {
    if (entities.issueLinks)
      return { phase: "links", token: null, issueKey: null, offset: 0 };
    if (entities.changelog)
      return {
        phase: "changelog",
        token: null,
        issueKey: null,
        historyOffset: 0,
        itemOffset: 0,
      };
    if (entities.sprints)
      return { phase: "sprints", boardIndex: 0, startAt: 0 };
    return null;
  };
  const pageFor = (
    request: ConnectorReadRequest,
    records: ConnectorRecord[],
    next: JiraEntityCursor | null,
  ): ConnectorChangePage =>
    validateConnectorPage(request, {
      binding,
      inputCursor: request.cursor,
      nextCursor: next ? encodeJiraEntityCursor(next) : null,
      terminal: next === null,
      records,
    });
  const entityIssuePage = async (
    scope: ConnectorReadScope,
    token: string | null,
  ) => {
    const response = await client.searchIssues({
      jql: `project in (${scopeProjects(
        scope,
        projects,
      )
        .map((project) => `"${project.projectKey}"`)
        .join(",")}) ORDER BY updated ASC, key ASC`,
      fields: entityIssueFields,
      maxResults: 1,
      ...(token ? { nextPageToken: token } : {}),
    });
    const page = response as {
      issues?: JiraIssue[];
      isLast?: boolean;
      nextPageToken?: string | null;
    };
    if (!Array.isArray(page.issues) || page.issues.length > 1)
      throw new Error("INVALID_RESPONSE");
    if (
      page.issues.some((issue) => !issue || !issue.fields) ||
      (page.isLast === false && !page.nextPageToken) ||
      (page.isLast === true && page.nextPageToken)
    )
      throw new Error("INVALID_RESPONSE");
    const nextToken = page.nextPageToken
      ? boundedString(page.nextPageToken, 2048)
      : null;
    if (page.nextPageToken && !nextToken) throw new Error("INVALID_RESPONSE");
    return {
      issue: page.issues[0] ?? null,
      nextToken,
      terminal: page.isLast === true || !nextToken,
    };
  };
  const pullExpandedPage = async (
    request: ConnectorReadRequest,
  ): Promise<ConnectorChangePage> => {
    const selectedBoards = activeBoards(request.scope);
    if (entities.sprints && selectedBoards.length === 0)
      throw Object.assign(new Error("PERMISSION_DENIED"), { status: 403 });
    const scanIssue = async (token: string | null) =>
      entityIssuePage(request.scope, token);
    const pullState = async (
      state: JiraEntityCursor,
    ): Promise<ConnectorChangePage> => {
      if (
        (state.phase === "links" && !entities.issueLinks) ||
        (state.phase === "changelog" && !entities.changelog) ||
        (state.phase === "sprints" && !entities.sprints)
      )
        throw new Error("INVALID_RESPONSE");
      if (state.phase === "issues") {
        const response = await client.searchIssues({
          jql: `project in (${scopeProjects(
            request.scope,
            projects,
          )
            .map((project) => `"${project.projectKey}"`)
            .join(",")}) ORDER BY updated ASC, key ASC`,
          fields,
          maxResults: pageSize,
          ...(state.token ? { nextPageToken: state.token } : {}),
        });
        const page = response as {
          issues?: JiraIssue[];
          isLast?: boolean;
          nextPageToken?: string | null;
        };
        if (
          !Array.isArray(page.issues) ||
          page.issues.length > pageSize ||
          page.issues.some((issue) => !issue || !issue.fields) ||
          (page.isLast === false && !page.nextPageToken) ||
          (page.isLast === true && page.nextPageToken)
        )
          throw new Error("INVALID_RESPONSE");
        const records = page.issues.map((issue) => record(request.scope, issue));
        const token = page.nextPageToken
          ? boundedString(page.nextPageToken, 2048)
          : null;
        if (page.nextPageToken && (!token || token === state.token))
          throw new Error("INVALID_RESPONSE");
        const terminal = page.isLast === true || !token;
        const next = terminal
          ? firstEntityPhase()
          : { phase: "issues" as const, token };
        if (records.length === 0 && !terminal)
          throw new Error("INVALID_RESPONSE");
        if (records.length === 0 && next) return pullState(next);
        return pageFor(request, records, next);
      }
      if (state.phase === "links") {
        const issuePage = state.issueKey
          ? { issue: null, nextToken: state.token, terminal: false }
          : await scanIssue(state.token);
        if (!state.issueKey && issuePage.nextToken === state.token && issuePage.nextToken)
          throw new Error("INVALID_RESPONSE");
        const issueKey =
          state.issueKey ??
          (issuePage.issue ? boundedString(issuePage.issue.key, 128) : null);
        if (!issueKey) {
          if (!issuePage.terminal || issuePage.nextToken)
            throw new Error("INVALID_RESPONSE");
          const next = nextEntityPhase("links");
          return next ? pullState(next) : pageFor(request, [], null);
        }
        const sourceIssue = state.issueKey
          ? await client.getIssue({
              issueIdOrKey: issueKey,
              fields: [...new Set([...fields, "issuelinks"])],
            })
          : (issuePage.issue as JiraIssue);
        const parent = record(request.scope, sourceIssue);
        if (parent.ref.recordId !== issueKey)
          throw new Error("INVALID_RESPONSE");
        const rawLinks = sourceIssue.fields.issuelinks;
        if (!Array.isArray(rawLinks) || rawLinks.length > 1000)
          throw new Error("INVALID_RESPONSE");
        if (state.issueKey && state.offset > rawLinks.length)
          throw new Error("INVALID_RESPONSE");
        const pageLinks = rawLinks.slice(
          state.issueKey ? state.offset : 0,
          (state.issueKey ? state.offset : 0) + entityPageSize,
        );
        const records = pageLinks.flatMap((link) => {
          const projected = linkRecord(request.scope, link, issueKey);
          return projected ? [projected] : [];
        });
        const offset = (state.issueKey ? state.offset : 0) + pageLinks.length;
        const moreLinks = offset < rawLinks.length;
        const searchToken = state.issueKey
          ? state.token
          : issuePage.nextToken;
        let next: JiraEntityCursor | null;
        if (moreLinks)
          next = {
            phase: "links",
            token: searchToken,
            issueKey,
            offset,
          };
        else if (searchToken)
          next = {
            phase: "links",
            token: searchToken,
            issueKey: null,
            offset: 0,
          };
        else next = nextEntityPhase("links");
        if (records.length === 0) records.push(parent);
        return pageFor(request, records, next);
      }
      if (state.phase === "changelog") {
        const issuePage = state.issueKey
          ? { issue: null, nextToken: state.token, terminal: false }
          : await scanIssue(state.token);
        if (!state.issueKey && issuePage.nextToken === state.token && issuePage.nextToken)
          throw new Error("INVALID_RESPONSE");
        const issueKey =
          state.issueKey ??
          (issuePage.issue ? boundedString(issuePage.issue.key, 128) : null);
        if (!issueKey) {
          if (!issuePage.terminal || issuePage.nextToken)
            throw new Error("INVALID_RESPONSE");
          const next = entities.sprints
            ? { phase: "sprints" as const, boardIndex: 0, startAt: 0 }
            : null;
          return next ? pullState(next) : pageFor(request, [], null);
        }
        const parent = state.issueKey
          ? await client.getIssue({ issueIdOrKey: issueKey, fields })
          : (issuePage.issue as JiraIssue);
        const parentRecord = record(request.scope, parent);
        const issueId = numericExternalId(parent.id);
        if (parentRecord.ref.recordId !== issueKey || !issueId)
          throw new Error("INVALID_RESPONSE");
        const raw = await client.getChangeLogs!({
          issueIdOrKey: issueKey,
          startAt: state.issueKey ? state.historyOffset : 0,
          maxResults: 1,
        });
        const response = raw as {
          histories?: JiraHistory[];
          startAt?: number;
          total?: number;
        };
        const historyOffset = state.issueKey ? state.historyOffset : 0;
        const itemOffset = state.issueKey ? state.itemOffset : 0;
        if (
          !Array.isArray(response.histories) ||
          response.histories.length > 1 ||
          (response.startAt !== undefined &&
            response.startAt !== historyOffset) ||
          (response.total !== undefined &&
            (!Number.isSafeInteger(response.total) ||
              response.total < historyOffset + response.histories.length))
        )
          throw new Error("INVALID_RESPONSE");
        const history = response.histories[0];
        const records: ConnectorRecord[] = [];
        let next: JiraEntityCursor | null;
        if (!history) {
          if (
            itemOffset !== 0 ||
            (response.total !== undefined &&
              response.total > historyOffset)
          )
            throw new Error("INVALID_RESPONSE");
          next = state.token
            ? {
                phase: "changelog",
                token: state.token,
                issueKey: null,
                historyOffset: 0,
                itemOffset: 0,
              }
            : entities.sprints
              ? { phase: "sprints", boardIndex: 0, startAt: 0 }
              : null;
        } else {
          if (
            !Array.isArray(history.items) ||
            history.items.length > 1000 ||
            itemOffset > history.items.length
          )
            throw new Error("INVALID_RESPONSE");
          const historyId = numericExternalId(history.id);
          if (!historyId || !safeDate(history.created))
            throw new Error("INVALID_RESPONSE");
          const chunk = history.items.slice(
            itemOffset,
            itemOffset + entityPageSize,
          );
          for (let index = 0; index < chunk.length; index += 1) {
            const projected = changelogItemRecord(
              request.scope,
              issueKey,
              issueId,
              history,
              chunk[index],
              itemOffset + index,
            );
            if (projected) records.push(projected);
          }
          const nextItemOffset = itemOffset + chunk.length;
          if (nextItemOffset < history.items.length) {
            next = {
              phase: "changelog",
              token: state.issueKey ? state.token : issuePage.nextToken,
              issueKey,
              historyOffset,
              itemOffset: nextItemOffset,
            };
          } else {
            const nextHistoryOffset = historyOffset + 1;
            const hasMoreHistory =
              response.total === undefined ||
              nextHistoryOffset < response.total;
            if (hasMoreHistory) {
              next = {
                phase: "changelog",
                token: state.issueKey ? state.token : issuePage.nextToken,
                issueKey,
                historyOffset: nextHistoryOffset,
                itemOffset: 0,
              };
            } else {
              const nextToken = state.issueKey
                ? state.token
                : issuePage.nextToken;
              next = nextToken
                ? {
                    phase: "changelog",
                    token: nextToken,
                    issueKey: null,
                    historyOffset: 0,
                    itemOffset: 0,
                  }
                : entities.sprints
                  ? { phase: "sprints", boardIndex: 0, startAt: 0 }
                  : null;
            }
          }
        }
        if (records.length === 0) records.push(parentRecord);
        return pageFor(request, records, next);
      }
      if (state.phase === "sprints") {
        const mapping = selectedBoards[state.boardIndex];
        if (!mapping) throw new Error("INVALID_RESPONSE");
        const board = await client.getBoard!({ boardId: mapping.boardId });
        const projectedBoard = boardRecord(request.scope, mapping, board);
        const response = await client.getSprints!({
          boardId: mapping.boardId,
          startAt: state.startAt,
          maxResults: entityPageSize,
        });
        const values = response.values;
        const total = response.total;
        if (
          !Array.isArray(values) ||
          values.length > entityPageSize ||
          !Number.isSafeInteger(total) ||
          total! < state.startAt ||
          (response.startAt !== undefined &&
            response.startAt !== state.startAt) ||
          total! < state.startAt + values.length ||
          (response.isLast === false &&
            (values.length === 0 || state.startAt + values.length >= total!)) ||
          (response.isLast === true &&
            state.startAt + values.length < total!)
        )
          throw new Error("INVALID_RESPONSE");
        const records = values.map((sprint) =>
          sprintRecord(request.scope, mapping, sprint),
        );
        if (state.startAt === 0 || records.length === 0)
          records.unshift(projectedBoard);
        const nextStart = state.startAt + values.length;
        const terminal =
          response.isLast === true || nextStart >= total!;
        const next = terminal
          ? state.boardIndex + 1 < selectedBoards.length
            ? {
                phase: "sprints" as const,
                boardIndex: state.boardIndex + 1,
                startAt: 0,
              }
            : null
          : { phase: "sprints" as const, boardIndex: state.boardIndex, startAt: nextStart };
        return pageFor(request, records, next);
      }
      throw new Error("INVALID_RESPONSE");
    };
    return pullState(parseJiraEntityCursor(request.cursor));
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
        async () => {
          const found = await client.getProject({
            projectIdOrKey: selected[0]!.projectKey,
          });
          if (found.key !== selected[0]!.projectKey)
            throw new Error("INVALID_RESPONSE");
          if (entities.sprints) {
            const board = activeBoards(scope)[0];
            if (!board) throw Object.assign(new Error("PERMISSION_DENIED"), { status: 403 });
            const visibleBoard = await client.getBoard!({ boardId: board.boardId });
            if (Number(visibleBoard.id) !== board.boardId)
              throw new Error("INVALID_RESPONSE");
          }
          return { checkedAt: now().toISOString() };
        },
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
      if (entityEnabled)
        return capture(
          () => pullExpandedPage(request),
          (raw) => validateConnectorPage(request, raw),
        );
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
        !scope.projectIds.includes(ref.projectId)
      )
        return {
          ok: false,
          failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
        };
      if (ref.recordType === "jira.issue") {
        const project = projects.find((item) => item.projectId === ref.projectId);
        if (
          !project ||
          !/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(ref.recordId) ||
          !ref.recordId.startsWith(`${project.projectKey}-`)
        )
          return {
            ok: false,
            failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
          };
        return capture(
          () => client.getIssue({ issueIdOrKey: ref.recordId, fields }),
          (raw) => record(scope, raw as JiraIssue, ref),
        );
      }
      if (ref.recordType === "jira.changelog") {
        const parsed = /^([1-9][0-9]*):([1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(ref.recordId);
        if (!parsed || typeof client.getChangeLogsByIds !== "function")
          return {
            ok: false,
            failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
          };
        const [, issueId, historyId, ordinalText] = parsed;
        const ordinal = Number(ordinalText);
        if (
          numericExternalId(issueId) !== issueId ||
          numericExternalId(historyId) !== historyId ||
          !safeOffset(ordinal)
        )
          return {
            ok: false,
            failure: { code: "INVALID_RESPONSE", retryAfterMs: null },
          };
        return capture(
          async () => {
            const issue = await client.getIssue({ issueIdOrKey: issueId!, fields });
            const parentRecord = record(scope, issue);
            if (
              numericExternalId(issue.id) !== issueId ||
              parentRecord.ref.projectId !== ref.projectId
            )
              throw Object.assign(new Error("PERMISSION_DENIED"), { status: 403 });
            const issueKey = issue.key;
            const page = await client.getChangeLogsByIds!({
              issueIdOrKey: issueId!,
              changelogIds: [Number(historyId)],
            });
            const history = page.histories?.find(
              (candidate) => numericExternalId(candidate.id) === historyId,
            );
            if (!history || !Array.isArray(history.items) || ordinal >= history.items.length)
              throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
            const result = changelogItemRecord(
              scope,
              issueKey,
              issueId!,
              history,
              history.items[ordinal],
              ordinal,
            );
            if (!result)
              throw Object.assign(new Error("PERMISSION_DENIED"), { status: 403 });
            return result;
          },
          (raw) => validateConnectorRecord(scope, ref, raw),
        );
      }
      if (ref.recordType === "jira.issue_link") {
        if (
          !/^[1-9][0-9]*$/.test(ref.recordId) ||
          typeof client.getIssueLink !== "function" ||
          Number(ref.recordId) > 2_147_483_647
        )
          return {
            ok: false,
            failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
          };
        return capture(
          async () => {
            const link = await client.getIssueLink!({ linkId: ref.recordId });
            const raw = objectValue(link);
            const inward = objectValue(raw?.inwardIssue);
            const outward = objectValue(raw?.outwardIssue);
            const inwardKey = boundedString(inward?.key, 128);
            const outwardKey = boundedString(outward?.key, 128);
            if (!inwardKey || !outwardKey)
              throw new Error("INVALID_RESPONSE");
            const canonicalKey = [outwardKey, inwardKey].sort()[0]!;
            const project = issueProject(scope, canonicalKey);
            if (!project || project.projectId !== ref.projectId)
              throw Object.assign(new Error("PERMISSION_DENIED"), { status: 403 });
            const sourceIssue = await client.getIssue({
              issueIdOrKey: canonicalKey,
              fields,
            });
            record(scope, sourceIssue);
            const result = linkRecord(scope, link, canonicalKey);
            if (!result)
              throw Object.assign(new Error("PERMISSION_DENIED"), { status: 403 });
            return result;
          },
          (raw) => validateConnectorRecord(scope, ref, raw),
        );
      }
      if (ref.recordType === "jira.board") {
        const boardId = Number(ref.recordId);
        const mapping = boards.find(
          (candidate) =>
            candidate.boardId === boardId && candidate.projectId === ref.projectId,
        );
        if (
          !Number.isSafeInteger(boardId) ||
          String(boardId) !== ref.recordId ||
          !mapping ||
          typeof client.getBoard !== "function"
        )
          return {
            ok: false,
            failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
          };
        return capture(
          async () =>
            boardRecord(
              scope,
              mapping,
              await client.getBoard!({ boardId }),
            ),
          (raw) => validateConnectorRecord(scope, ref, raw),
        );
      }
      if (ref.recordType === "jira.sprint") {
        const parsed = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(ref.recordId);
        const boardId = parsed ? Number(parsed[1]) : NaN;
        const sprintId = parsed ? Number(parsed[2]) : NaN;
        const mapping = boards.find(
          (candidate) =>
            candidate.boardId === boardId && candidate.projectId === ref.projectId,
        );
        if (
          !Number.isSafeInteger(boardId) ||
          boardId > 2_147_483_647 ||
          !Number.isSafeInteger(sprintId) ||
          sprintId > 2_147_483_647 ||
          !mapping ||
          typeof client.getSprint !== "function"
        )
          return {
            ok: false,
            failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
          };
        return capture(
          async () =>
            sprintRecord(
              scope,
              mapping,
              await client.getSprint!({ sprintId }),
              true,
            ),
          (raw) => validateConnectorRecord(scope, ref, raw),
        );
      }
      return {
        ok: false,
        failure: { code: "PERMISSION_DENIED", retryAfterMs: null },
      };
    },
    getDeepLink(input, refInput) {
      const scope = scoped(input);
      const ref = parseIngestion(connectorRecordRefSchema, refInput);
      if (
        !matchesBinding(scope) ||
        ref.customerId !== configInput.customerId ||
        ref.sourceId !== configInput.sourceId ||
        !scope.projectIds.includes(ref.projectId)
      )
        return null;
      if (ref.recordType === "jira.issue") {
        const project = projects.find((item) => item.projectId === ref.projectId);
        if (
          !project ||
          !/^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(ref.recordId) ||
          !ref.recordId.startsWith(`${project.projectKey}-`)
        )
          return null;
        return `${configInput.origin}/browse/${encodeURIComponent(ref.recordId)}`;
      }
      if (ref.recordType === "jira.changelog") {
        // Changelog keys use immutable Jira issue IDs. The concrete issue key
        // and same-origin browse URL travel with the normalized record.
        return null;
      }
      if (ref.recordType === "jira.board" || ref.recordType === "jira.sprint") {
        const boardId =
          ref.recordType === "jira.board"
            ? Number(ref.recordId)
            : Number(/^([1-9][0-9]*):[1-9][0-9]*$/.exec(ref.recordId)?.[1]);
        const mapping = boards.find(
          (candidate) =>
            candidate.boardId === boardId && candidate.projectId === ref.projectId,
        );
        if (!mapping) return null;
        return `${configInput.origin}/secure/RapidView.jspa?rapidView=${boardId}`;
      }
      return null;
    },
  };
}

export function createJiraOAuthCloudClient(options: {
  cloudId: string;
  accessToken: string;
}): JiraReadClient {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(options.cloudId) ||
    !options.accessToken ||
    options.accessToken.length > 8192
  )
    throw new Error("INVALID_CONFIG");
  const host = `https://api.atlassian.com/ex/jira/${encodeURIComponent(options.cloudId)}`;
  const baseClient = createClient({
    host,
    auth: { type: "oauth2", accessToken: options.accessToken },
    retry: { maxAttempts: 1 },
  });
  const jira = createCloudClient(baseClient);
  const agile = createAgileClient(baseClient);
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
    getChangeLogs: async (input) =>
      (await jira.issues.getChangeLogs(input)) as unknown as {
        histories?: JiraHistory[];
        startAt?: number;
        total?: number;
      },
    getChangeLogsByIds: async (input) =>
      (await jira.issues.getChangeLogsByIds(input)) as unknown as {
        histories?: JiraHistory[];
      },
    getIssueLink: async (input) =>
      (await jira.issueLinks.getIssueLink(input)) as unknown as JiraIssueLink,
    getBoard: async (input) =>
      (await agile.board.getBoard(input)) as unknown as JiraBoard,
    getSprints: async (input) =>
      (await agile.board.getAllSprints(input)) as unknown as JiraOffsetPage<JiraSprint>,
    getSprint: async (input) =>
      (await agile.sprint.getSprint(input)) as unknown as JiraSprint,
  };
}

export {
  getJiraAccessibleResources,
  refreshJiraOAuthToken,
  JiraOAuthError,
} from "./oauth.js";
