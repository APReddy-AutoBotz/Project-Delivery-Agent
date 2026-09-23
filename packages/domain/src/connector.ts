import { z } from "zod";
import {
  projectFactIdSchema,
  projectFactInstantSchema,
  projectFactValueSchema,
} from "./project-facts.js";

// FR-CON-011/012, FR-MOD-007, FR-EVD-011, TR-TEST-003: internal read contracts.
// A supplied scope is trusted application input, NOT an authorization decision.
// No SDK, credentials, writes, persistence or SYSTEM_VERIFIED assertion here.
export const ingestionText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0 && !/[\0\p{Surrogate}]/u.test(s));
export const ingestionArray = <T extends z.ZodType>(schema: T, max: number) =>
  z
    .custom<unknown[]>((v) => Array.isArray(v) && v.length <= max)
    .pipe(z.array(schema));
const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;
export const ingestionFactType = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_.-]*$/);
export const ingestionProposalSchema = z
  .object({
    factType: ingestionFactType,
    value: projectFactValueSchema,
  })
  .strict();
const origin = ingestionText(2048).refine((s) => {
  try {
    const url = new URL(s);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === s
    );
  } catch {
    return false;
  }
});
export const connectorBindingSchema = z
  .object({
    customerId: projectFactIdSchema,
    sourceId: projectFactIdSchema,
    sourceType: ingestionText(96),
    origin,
  })
  .strict();
export const connectorReadScopeSchema = z
  .object({
    binding: connectorBindingSchema,
    projectIds: ingestionArray(projectFactIdSchema, 100).refine(unique),
  })
  .strict();
export const connectorRecordRefSchema = z
  .object({
    customerId: projectFactIdSchema,
    sourceId: projectFactIdSchema,
    projectId: projectFactIdSchema,
    recordType: ingestionText(96),
    recordId: ingestionText(256),
  })
  .strict();
const cursor = ingestionText(2048).nullable();
export const connectorReadRequestSchema = z
  .object({
    scope: connectorReadScopeSchema,
    cursor,
  })
  .strict();
export const connectorRecordSchema = z
  .object({
    ref: connectorRecordRefSchema,
    revision: ingestionText(128),
    // SHA-256 of the connector's stable, bounded source fields before field
    // mapping. It is an idempotency input, not source authenticity evidence.
    sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: projectFactInstantSchema,
    effectiveAt: projectFactInstantSchema,
    deepLink: ingestionText(2048).nullable(),
    observations: ingestionArray(ingestionProposalSchema, 32).refine((items) =>
      unique(items.map((v) => v.factType)),
    ),
  })
  .strict();
export const connectorChangePageSchema = z
  .object({
    binding: connectorBindingSchema,
    inputCursor: cursor,
    nextCursor: cursor,
    terminal: z.boolean(),
    records: ingestionArray(connectorRecordSchema, 100),
  })
  .strict();
export const connectorFailureSchema = z
  .object({
    code: z.enum([
      "INVALID_CREDENTIALS",
      "EXPIRED_CREDENTIALS",
      "PERMISSION_DENIED",
      "RATE_LIMITED",
      "TEMPORARILY_UNAVAILABLE",
      "INVALID_RESPONSE",
      "NOT_FOUND",
      "UNKNOWN_OUTCOME",
    ]),
    retryAfterMs: z.number().int().min(0).max(86_400_000).nullable(),
  })
  .strict()
  .refine(
    (f) =>
      f.retryAfterMs === null ||
      f.code === "RATE_LIMITED" ||
      f.code === "TEMPORARILY_UNAVAILABLE",
  );
export type ConnectorFailure = z.infer<typeof connectorFailureSchema>;
export type ConnectorReadScope = z.infer<typeof connectorReadScopeSchema>;
export type ConnectorRecordRef = z.infer<typeof connectorRecordRefSchema>;
export type ConnectorRecord = z.infer<typeof connectorRecordSchema>;
export type ConnectorReadRequest = z.infer<typeof connectorReadRequestSchema>;
export type ConnectorChangePage = z.infer<typeof connectorChangePageSchema>;
export type ConnectorResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ConnectorFailure };
export interface ReadOnlyConnector {
  testConnection(
    scope: ConnectorReadScope,
  ): Promise<ConnectorResult<{ checkedAt: string }>>;
  discoverScopes(scope: ConnectorReadScope): Promise<
    ConnectorResult<{
      projectIds: string[];
      checkedAt: string;
    }>
  >;
  pullChanges(
    request: ConnectorReadRequest,
  ): Promise<ConnectorResult<ConnectorChangePage>>;
  getRecord(
    scope: ConnectorReadScope,
    ref: ConnectorRecordRef,
  ): Promise<ConnectorResult<ConnectorRecord>>;
  getDeepLink(
    scope: ConnectorReadScope,
    ref: ConnectorRecordRef,
  ): string | null;
}

export class IngestionInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IngestionInputError";
  }
}
export function parseIngestion<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new IngestionInputError("INVALID_INPUT");
  return result.data;
}
const bindingKey = (v: z.infer<typeof connectorBindingSchema>) =>
  JSON.stringify([v.customerId, v.sourceId, v.sourceType, v.origin]);
export const connectorRecordIdentity = (ref: ConnectorRecordRef) =>
  JSON.stringify([
    ref.customerId,
    ref.sourceId,
    ref.projectId,
    ref.recordType,
    ref.recordId,
  ]);

export function validateConnectorDeepLink(
  scopeInput: unknown,
  link: unknown,
): string | null {
  const scope = parseIngestion(connectorReadScopeSchema, scopeInput);
  if (link === null) return null;
  const text = parseIngestion(ingestionText(2048), link);
  try {
    const url = new URL(text);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === scope.binding.origin &&
      text === url.href
    )
      return text;
  } catch {
    /* Return only finite safe errors, never raw untrusted input. */
  }
  throw new IngestionInputError("INVALID_LINK");
}
function checkRecord(scope: ConnectorReadScope, record: ConnectorRecord) {
  const ref = record.ref;
  if (
    ref.customerId !== scope.binding.customerId ||
    ref.sourceId !== scope.binding.sourceId ||
    !scope.projectIds.includes(ref.projectId)
  )
    throw new IngestionInputError("SCOPE_MISMATCH");
  validateConnectorDeepLink(scope, record.deepLink);
}
export function validateConnectorRecord(
  scopeInput: unknown,
  refInput: unknown,
  recordInput: unknown,
) {
  const scope = parseIngestion(connectorReadScopeSchema, scopeInput);
  const ref = parseIngestion(connectorRecordRefSchema, refInput);
  const record = parseIngestion(connectorRecordSchema, recordInput);
  checkRecord(scope, record);
  if (connectorRecordIdentity(ref) !== connectorRecordIdentity(record.ref))
    throw new IngestionInputError("RECORD_MISMATCH");
  return record;
}
export function validateConnectorPage(
  requestInput: unknown,
  pageInput: unknown,
): ConnectorChangePage {
  const request = parseIngestion(connectorReadRequestSchema, requestInput);
  const page = parseIngestion(connectorChangePageSchema, pageInput);
  if (bindingKey(request.scope.binding) !== bindingKey(page.binding))
    throw new IngestionInputError("SCOPE_MISMATCH");
  if (
    page.inputCursor !== request.cursor ||
    (page.terminal
      ? page.nextCursor !== null
      : page.nextCursor === null ||
        page.nextCursor === request.cursor ||
        page.records.length === 0)
  )
    throw new IngestionInputError("INVALID_CURSOR");
  const seen = new Set<string>();
  for (const record of page.records) {
    checkRecord(request.scope, record);
    const key = connectorRecordIdentity(record.ref);
    if (seen.has(key)) throw new IngestionInputError("DUPLICATE_RECORD");
    seen.add(key);
  }
  return page;
}
export function validateConnectorDiscovery(
  scopeInput: unknown,
  response: unknown,
) {
  const scope = parseIngestion(connectorReadScopeSchema, scopeInput);
  const result = parseIngestion(
    z
      .object({
        projectIds: ingestionArray(projectFactIdSchema, 100).refine(unique),
        checkedAt: projectFactInstantSchema,
      })
      .strict(),
    response,
  );
  if (result.projectIds.some((id) => !scope.projectIds.includes(id)))
    throw new IngestionInputError("SCOPE_MISMATCH");
  return result;
}
export function validateConnectorConnection(response: unknown) {
  return parseIngestion(
    z.object({ checkedAt: projectFactInstantSchema }).strict(),
    response,
  );
}
export function connectorReadRetryAdvice(
  input: unknown,
  completedAttempts: number,
): { retry: false } | { retry: true; delayMs: number } {
  const failure = parseIngestion(connectorFailureSchema, input);
  if (
    !Number.isInteger(completedAttempts) ||
    completedAttempts < 1 ||
    completedAttempts > 5
  )
    throw new IngestionInputError("INVALID_ATTEMPT");
  if (
    completedAttempts === 5 ||
    !["RATE_LIMITED", "TEMPORARILY_UNAVAILABLE"].includes(failure.code)
  )
    return { retry: false };
  return {
    retry: true,
    delayMs: Math.max(
      failure.retryAfterMs ?? 0,
      1000 * 2 ** (completedAttempts - 1),
    ),
  };
}
